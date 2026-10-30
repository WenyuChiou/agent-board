import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { exchange } from '../scripts/exchange.mjs'
import { dispatchCodex } from '../scripts/codex-owner.mjs'
import { bindingOf, progressBlock, commandOf, codexRequest, EXCHANGE_AGENTS } from '../scripts/exchange-contract.ts'
import { futureTimeKey, isStale, observedTime, parseProgress, STALE_MS } from '../hooks/parse.ts'
import { EN } from '../hooks/strings-en.ts'
import { ZH_TW } from '../hooks/i18n.ts'
import { ZH_CN } from '../hooks/strings-zh-cn.ts'

test('plain Node loads future-clock parser helpers without a bundler', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  const stamp = now + 24 * 60 * 60 * 1000
  const auto = parseProgress(`## Synthetic\n<!-- auto session=f3820001 agent=codex state=working updated=${new Date(stamp).toISOString()} -->\n### Clock\n- [~] Synthetic work\n<!-- /auto session=f3820001 -->`)[0]?.tasks[0]?.auto
  assert.ok(auto)
  const seen = { [futureTimeKey(auto)]: now }
  const clock = observedTime(auto, now + STALE_MS + 1, seen)
  assert.equal(clock.isFuture, true)
  assert.equal(isStale(auto, now + STALE_MS + 1, clock.updated), true)
  assert.equal(auto.updated, stamp)
})

const fixture = async (t, agent = 'dot') => {
  const root = await mkdtemp(join(tmpdir(), 'agent-board-exchange-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'session')
  const { binding } = await exchange('init', directory, { agent, session: 'synthetic-session' })
  const command = { version: 1, id: 'message-1', binding: binding.id, agent, session: binding.session, text: 'Synthetic reply: 下一步', turn: agent === 'codex' ? 'turn-1' : '' }
  const target = { id: command.id, binding: binding.id, session: binding.session, agent }
  return { root, directory, binding, command, target }
}
const fakeOwner = () => {
  const calls = []
  const transport = {
    methods: ['thread/loaded/list', 'turn/steer'],
    request: async (method, params) => {
      calls.push({ method, params })
      return method === 'thread/loaded/list' ? { data: ['synthetic-session'], nextCursor: null } : { turnId: 'turn-1' }
    },
  }
  return { calls, transport }
}

test('dot reports only explicit minimal fields and emits a backward-compatible progress block', async t => {
  const { directory, binding } = await fixture(t)
  const report = { project: 'Synthetic lab', title: 'Explicit report', context: 'Synthetic data only', state: 'waiting', steps: [{ status: 'done', text: 'Finished check' }, { status: 'waiting', text: 'Continue?' }] }
  await exchange('report', directory, report)
  const text = await readFile(join(directory, 'fragment.md'), 'utf8')
  assert.match(text, /agent=dot state=waiting/)
  assert.match(text, /- \[x\] Finished check\n- \[\?\] Continue\?/)
  assert.ok(!text.includes('resume='))
  assert.ok(text.includes('session=' + binding.id.slice(0, 8)))
  const parsed = parseProgress(text)
  assert.equal(parsed[0].name, 'Synthetic lab')
  assert.equal(parsed[0].tasks[0].auto.agent, 'dot')
  assert.equal(parsed[0].tasks[0].steps[1].status, 'waiting')
  assert.throws(() => progressBlock({ ...report, transcript_path: '/private' }, binding, 0, EN), /UNKNOWN_FIELD/)
  assert.throws(() => progressBlock({ ...report, title: 'bad\n## injection' }, binding, 0, EN), /INVALID_TEXT/)
})

test('report context uses the existing English, Traditional Chinese and Simplified Chinese tables', async t => {
  const { directory } = await fixture(t)
  for (const [language, strings] of [['en', EN], ['zh-TW', ZH_TW], ['zh-CN', ZH_CN]]) {
    await exchange('report', directory, { language, project: 'Synthetic', title: 'Localized report', context: 'Explicit background', state: 'waiting', steps: [{ status: 'todo', text: 'Next check' }] })
    const text = await readFile(join(directory, 'fragment.md'), 'utf8')
    assert.ok(text.includes(strings.contextNote('Explicit background')))
    assert.equal(parseProgress(text)[0].tasks[0].notes[0], strings.contextNote('Explicit background').replace(/^>\s*/, ''))
  }
  await assert.rejects(exchange('report', directory, { language: ['en'] }), /UNSUPPORTED_LANGUAGE/)
})

test('Codex uses the same cooperative report contract without claiming native attachment', async t => {
  const { directory } = await fixture(t, 'codex')
  await exchange('report', directory, { project: 'Synthetic', title: 'Codex report', state: 'working', steps: [{ status: 'doing', text: 'Check fixture' }] })
  const status = await exchange('status', directory)
  assert.equal(status.native, 'unsupported')
  assert.equal(status.mode, 'cooperative-file')
  assert.match(await readFile(join(directory, 'fragment.md'), 'utf8'), /agent=codex state=working/)
})

test('explicit bindings reject wrong recipients and paths disguised as ids', async t => {
  const { directory, binding, command } = await fixture(t)
  await assert.rejects(exchange('enqueue', directory, { ...command, session: 'another-session' }), /TARGET_MISMATCH/)
  await assert.rejects(exchange('enqueue', directory, { ...command, binding: 'old-binding' }), /TARGET_MISMATCH/)
  assert.throws(() => commandOf({ ...command, id: '../escape' }, binding), /INVALID_ID/)
  assert.throws(() => bindingOf({ ...binding, version: 2 }), /UNSUPPORTED_BINDING/)
  assert.throws(() => bindingOf({ ...binding, agent: 'unknown' }), /UNSUPPORTED_BINDING/)
})

test('Windows drive-letter aliases do not count as symbolic links', { skip: process.platform !== 'win32' }, async t => {
  const { directory } = await fixture(t)
  const alternate = directory[0] === directory[0].toUpperCase()
    ? directory[0].toLowerCase() + directory.slice(1)
    : directory[0].toUpperCase() + directory.slice(1)
  assert.notEqual(alternate, directory)
  assert.equal((await exchange('status', alternate)).native, 'unsupported')
})

test('linked roots and linked ancestors are rejected before initializing or reporting', async t => {
  const { root, directory } = await fixture(t)
  const alias = join(root, 'alias')
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(exchange('status', alias), /SYMLINK_UNSUPPORTED/)
  await exchange('init', join(directory, 'child'), { agent: 'dot', session: 'synthetic-child' })
  await assert.rejects(exchange('report', join(alias, 'child'), { project: 'Synthetic', title: 'Must not write', state: 'working', steps: [] }), /SYMLINK_UNSUPPORTED/)
  await assert.rejects(exchange('init', join(alias, 'another-child'), { agent: 'dot', session: 'synthetic-child' }), /SYMLINK_UNSUPPORTED/)
  await assert.rejects(readFile(join(directory, 'child', 'fragment.md')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(directory, 'another-child', 'binding.json')), { code: 'ENOENT' })
})

test('enqueue is idempotent but refuses reuse of an id for different text', async t => {
  const { directory, command } = await fixture(t)
  assert.equal((await exchange('enqueue', directory, command)).status, 'queued')
  assert.equal((await exchange('enqueue', directory, command)).status, 'queued')
  await assert.rejects(exchange('enqueue', directory, { ...command, text: 'Different message' }), /ID_CONFLICT/)
})

test('one consumer claims a message and a restart never replays uncertain delivery', async t => {
  const { directory, command, target } = await fixture(t)
  await exchange('enqueue', directory, command)
  const outcomes = await Promise.all([exchange('take', directory, target), exchange('take', directory, target)])
  assert.equal(outcomes.filter(one => one.status === 'claimed').length, 1)
  assert.equal((await exchange('status', directory)).commands[0].status, 'uncertain')
  assert.equal((await exchange('take', directory, target)).status, 'already-claimed')
})

test('terminal receipts require a claim and conflicting acknowledgements cannot overwrite it', async t => {
  const { directory, binding, command, target } = await fixture(t)
  await exchange('enqueue', directory, command)
  const ack = { version: 1, id: command.id, binding: binding.id, status: 'delivered' }
  await assert.rejects(exchange('ack', directory, ack), /CLAIM_REQUIRED/)
  await exchange('take', directory, target)
  const outcomes = await Promise.allSettled([exchange('ack', directory, ack), exchange('ack', directory, { ...ack, status: 'rejected' })])
  assert.equal(outcomes.filter(one => one.status === 'fulfilled').length, 1)
  const terminal = (await exchange('status', directory)).commands[0].status
  assert.ok(['delivered', 'rejected'].includes(terminal))
  assert.equal((await exchange('take', directory, target)).status, 'already-claimed')
})

test('non-string receipt and progress enums are rejected before writing state', async t => {
  const { directory, binding, command, target } = await fixture(t)
  await exchange('enqueue', directory, command)
  await exchange('take', directory, target)
  const report = { project: 'Synthetic', title: 'Strict enums', state: 'waiting', steps: [{ status: 'todo', text: 'Next check' }] }
  await exchange('report', directory, report)
  const before = await readFile(join(directory, 'fragment.md'), 'utf8')
  const invalid = [[['delivered'], ['waiting'], ['todo']], ...[{}, true, 1, null].map(value => [value, value, value])]
  for (const [receipt, state, step] of invalid) {
    await assert.rejects(exchange('ack', directory, { version: 1, id: command.id, binding: binding.id, status: receipt }), /INVALID_RECEIPT/)
    assert.equal((await exchange('status', directory)).commands[0].status, 'uncertain')
    await assert.rejects(exchange('report', directory, { ...report, state }), /INVALID_STATE/)
    await assert.rejects(exchange('report', directory, { ...report, steps: [{ status: step, text: 'Invalid step' }] }), /INVALID_STEP/)
    assert.equal(await readFile(join(directory, 'fragment.md'), 'utf8'), before)
  }
  await exchange('ack', directory, { version: 1, id: command.id, binding: binding.id, status: 'delivered' })
  assert.equal((await exchange('status', directory)).commands[0].status, 'delivered')
})

test('report and command failures preserve user data and surface malformed state', async t => {
  const { root, directory, command } = await fixture(t)
  await assert.rejects(exchange('init', directory, { agent: 'dot', session: 'new-session' }), /EEXIST/)
  await writeFile(join(directory, 'binding.json'), '{bad json')
  await assert.rejects(exchange('enqueue', directory, command), SyntaxError)
  const outside = join(root, 'outside.txt')
  await writeFile(outside, 'preserve')
  assert.equal(await readFile(outside, 'utf8'), 'preserve')
})

test('corrupted command identity and a crash lock cannot cause redelivery', async t => {
  const { directory, binding, command, target } = await fixture(t)
  await exchange('enqueue', directory, command)
  await writeFile(join(directory, 'commands', command.id + '.json'), JSON.stringify({ ...command, id: 'different-id' }))
  await assert.rejects(exchange('take', directory, target), /COMMAND_ID_MISMATCH/)
  await writeFile(join(directory, 'commands', command.id + '.json'), JSON.stringify(command))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(directory, 'receipts', command.id + '.json.lock'))
  assert.equal((await exchange('status', directory)).commands[0].status, 'uncertain')
  assert.equal((await exchange('take', directory, target)).status, 'already-claimed')
  await assert.rejects(exchange('ack', directory, { version: 1, id: command.id, binding: binding.id, status: 'delivered' }), /CLAIM_INCOMPLETE/)
})

test('a verified owner can steer only its loaded thread and the expected active turn', async t => {
  const { directory, command, target } = await fixture(t, 'codex')
  await exchange('enqueue', directory, command)
  const { calls, transport } = fakeOwner()
  const result = await dispatchCodex(directory, target, transport, async one => one === transport)
  assert.equal(result.status, 'delivered')
  assert.deepEqual(calls.at(-1), { method: 'turn/steer', params: { threadId: command.session, expectedTurnId: 'turn-1', input: [{ type: 'text', text: command.text, text_elements: [] }] } })
  await dispatchCodex(directory, target, transport, async () => true)
  assert.equal(calls.filter(one => one.method === 'turn/steer').length, 1)
})

test('unverified owners, unloaded threads and missing methods fail before the command is claimed', async t => {
  for (const reason of ['unverified', 'methods', 'unloaded']) {
    const { directory, command, target } = await fixture(t, 'codex')
    const { transport, calls } = fakeOwner()
    if (reason === 'methods') transport.methods = []
    if (reason === 'unloaded') transport.request = async () => ({ data: [], nextCursor: null })
    await exchange('enqueue', directory, command)
    const result = await dispatchCodex(directory, target, transport, async () => reason !== 'unverified')
    assert.equal(result.status, 'not-sent')
    assert.equal((await exchange('status', directory)).commands[0].status, 'queued')
    assert.equal(calls.filter(one => one.method === 'turn/steer').length, 0)
    assert.throws(() => codexRequest(command, { agent: 'codex', thread: 'wrong', loaded: true, verified: true, canSteer: true }), /TARGET_MISMATCH/)
  }
})

test('a thread that loads after the first attempt can still receive the command', async t => {
  const { directory, command, target } = await fixture(t, 'codex')
  await exchange('enqueue', directory, command)
  const { transport, calls } = fakeOwner()
  const request = transport.request
  let isLoaded = false
  transport.request = async (method, params) =>
    method === 'thread/loaded/list' && !isLoaded ? { data: [], nextCursor: null } : request(method, params)
  const first = await dispatchCodex(directory, target, transport, async () => true)
  assert.equal(first.status, 'not-sent')
  assert.equal(first.error, 'THREAD_NOT_LOADED')
  isLoaded = true
  assert.equal((await dispatchCodex(directory, target, transport, async () => true)).status, 'delivered')
  assert.equal((await exchange('status', directory)).commands[0].status, 'delivered')
  assert.equal(calls.filter(one => one.method === 'turn/steer').length, 1)
})

test('a failure after the claim but before the steer request is a terminal rejection', async t => {
  for (const reason of ['idle', 'owner-lost']) {
    const { directory, command, target } = await fixture(t, 'codex')
    const { transport, calls } = fakeOwner()
    await exchange('enqueue', directory, { ...command, turn: reason === 'idle' ? '' : command.turn })
    let checks = 0
    const result = await dispatchCodex(directory, target, transport, async () => reason === 'idle' || ++checks === 1)
    assert.equal(result.status, 'rejected')
    assert.equal(result.error, reason === 'idle' ? 'ACTIVE_TURN_REQUIRED' : 'OWNER_UNAVAILABLE')
    assert.equal((await exchange('status', directory)).commands[0].status, 'rejected')
    assert.equal((await dispatchCodex(directory, target, transport, async () => true)).status, 'already-claimed')
    assert.equal(calls.filter(one => one.method === 'turn/steer').length, 0)
  }
})

test('lost acknowledgements stay uncertain and are never sent a second time', async t => {
  const { directory, command, target } = await fixture(t, 'codex')
  await exchange('enqueue', directory, command)
  const { transport, calls } = fakeOwner()
  const request = transport.request
  transport.request = async (method, params) => {
    const result = await request(method, params)
    if (method === 'turn/steer') throw new Error('connection lost after send')
    return result
  }
  assert.equal((await dispatchCodex(directory, target, transport, async () => true)).status, 'uncertain')
  await dispatchCodex(directory, target, transport, async () => true)
  assert.equal(calls.filter(one => one.method === 'turn/steer').length, 1)
})

test('report refuses to overwrite a fragment.md that holds anything but its own block', async t => {
  const { directory } = await fixture(t)
  const report = { project: 'Synthetic', title: 'Own block', state: 'working', steps: [{ status: 'doing', text: 'Check' }] }
  await exchange('report', directory, report)
  await exchange('report', directory, { ...report, state: 'done', steps: [{ status: 'done', text: 'Check' }] })
  const own = await readFile(join(directory, 'fragment.md'), 'utf8')
  const board = [
    '## Real project\n\n### Hand-kept task\n- [ ] Keep me\n',
    own + '\n## Another\n\n### Hand-kept\n- [ ] Keep me\n',
    '<!-- auto session=abcdef12 agent=claude state=working updated=2026-01-31T09:30:00Z -->\n### Other\n- [~] Theirs\n<!-- /auto session=abcdef12 -->\n',
  ]
  for (const text of board) {
    await writeFile(join(directory, 'fragment.md'), text)
    await assert.rejects(exchange('report', directory, report), /NOT_EXCHANGE_FILE/)
    assert.equal(await readFile(join(directory, 'fragment.md'), 'utf8'), text)
  }
})

test('a lock left without its file gives LOCK_HELD naming the folder, and status lists it', async t => {
  const { directory, command } = await fixture(t)
  const { mkdir } = await import('node:fs/promises')
  const lock = join(directory, 'commands', command.id + '.json.lock')
  await mkdir(lock)
  await assert.rejects(exchange('enqueue', directory, command), error => error.code === 'LOCK_HELD' && error.message.includes(lock))
  assert.deepEqual((await exchange('status', directory)).locks, [lock])
})

test('text may hold angle brackets but not comment markers or control characters', async t => {
  const { binding } = await fixture(t)
  const report = { project: 'Synthetic', title: 'a < b and c > d', state: 'working', steps: [{ status: 'doing', text: '<tag> stays' }] }
  const block = progressBlock(report, binding, 0, EN)
  assert.match(block, /### a < b and c > d/)
  assert.equal(parseProgress(block)[0].tasks[0].title, 'a < b and c > d')
  for (const title of ['x <!-- y', 'x --> y', 'tab\there', 'bell\u0007', 'del\u007f']) {
    assert.throws(() => progressBlock({ ...report, title }, binding, 0, EN), /INVALID_TEXT/)
  }
})

test('Windows reserved device names are refused as ids', async t => {
  const { binding, command } = await fixture(t)
  for (const id of ['CON', 'prn', 'Aux', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9']) {
    assert.throws(() => commandOf({ ...command, id }, binding), /INVALID_ID/)
    assert.throws(() => bindingOf({ ...binding, session: id }), /INVALID_ID/)
  }
  assert.equal(commandOf({ ...command, id: 'console' }, binding).id, 'console')
  assert.equal(commandOf({ ...command, id: 'COM10' }, binding).id, 'COM10')
})

test('a decision written before a crash wins over a stale uncertain receipt and repairs it', async t => {
  const { directory, binding, command, target } = await fixture(t)
  await exchange('enqueue', directory, command)
  await exchange('take', directory, target)
  const receipt = join(directory, 'receipts', command.id + '.json')
  await writeFile(receipt + '.decision', JSON.stringify({ version: 1, id: command.id, binding: binding.id, status: 'rejected' }))
  assert.equal((await exchange('status', directory)).commands[0].status, 'rejected')
  assert.equal(JSON.parse(await readFile(receipt, 'utf8')).status, 'rejected')
  await assert.rejects(exchange('ack', directory, { version: 1, id: command.id, binding: binding.id, status: 'delivered' }), /RECEIPT_CONFLICT/)
})

test('every module the scripts load at run time is imported with an explicit .ts or .mjs extension', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const seen = new Set()
  const visit = async file => {
    if (seen.has(file)) return
    seen.add(file)
    const text = await readFile(file, 'utf8')
    // `import type` is erased before Node runs the file, so only value imports count.
    for (const [, specifier] of text.matchAll(/^(?:import|export)\s+(?!type\b)[^'"]*?from\s+'([^']+)'/gm)) {
      if (!specifier.startsWith('.')) { assert.match(specifier, /^node:/, file); continue }
      assert.match(specifier, /\.(ts|mjs)$/, `${file} imports ${specifier}`)
      await visit(join(dirname(file), specifier))
    }
  }
  for (const entry of ['exchange.mjs', 'codex-owner.mjs']) await visit(join(here, '../scripts', entry))
  assert.ok([...seen].some(one => one.endsWith('exchange-contract.ts')))
})

test('the CLI performs a synthetic dot round trip without any external runtime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-board-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'dot')
  const cli = join(dirname(fileURLToPath(import.meta.url)), '../scripts/exchange.mjs')
  const run = (action, input) => {
    const proc = spawnSync(process.execPath, [cli, action, directory], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 })
    assert.equal(proc.status, 0, proc.stderr)
    return JSON.parse(proc.stdout)
  }
  const { binding } = run('init', { agent: 'dot', session: 'synthetic-dot' })
  const command = { version: 1, id: 'reply-1', binding: binding.id, agent: 'dot', session: binding.session, text: 'Only this explicit message', turn: '' }
  run('report', { project: 'Synthetic', title: 'Dot CLI check', state: 'waiting', steps: [{ status: 'waiting', text: 'Proceed?' }] })
  run('enqueue', command)
  assert.equal(run('take', { id: command.id, binding: binding.id, session: binding.session, agent: 'dot' }).command.text, command.text)
  run('ack', { version: 1, id: command.id, binding: binding.id, status: 'delivered' })
  assert.equal(run('status', {}).commands[0].status, 'delivered')
})

// The exchange's report is the same fragment every outside agent produces, so it reaches
// the board only through the one merge script; this runs that script for real.
test('a report reaches a real board through the remote reporter merge script, beside the blocks already there', async t => {
  const python = process.platform === 'win32' ? 'python' : 'python3'
  if (spawnSync(python, ['--version']).error) return t.skip('no Python here')
  const { root, directory, binding } = await fixture(t)
  await exchange('report', directory, { project: 'Synthetic lab', title: 'Merged report', state: 'waiting', steps: [{ status: 'waiting', text: 'Continue?' }] })
  const board = join(root, 'progress.md')
  const mine = '<!-- auto session=aa11bb22 agent=claude state=working updated=2026-10-17T06:00:00Z -->\n### Fix login\n- [ ] fix\n<!-- /auto session=aa11bb22 -->'
  await writeFile(board, `# Progress\n\n## webapp\n\n${mine}\n\n## Synthetic lab\n\nHand-kept notes.\n`)
  const merge = join(dirname(fileURLToPath(import.meta.url)), '../scripts/remote-reporter/merge.py')
  const run = spawnSync(python, ['-B', merge, board, join(directory, 'fragment.md')], { encoding: 'utf8', timeout: 20000 })
  assert.equal(run.status, 0, run.stderr)
  const text = await readFile(board, 'utf8')
  assert.ok(text.includes(mine) && text.includes('Hand-kept notes.'))
  const lab = parseProgress(text).find(project => project.name === 'Synthetic lab')
  assert.equal(lab?.tasks.find(task => task.auto?.agent === 'dot')?.title, 'Merged report')
  assert.ok(text.includes(`session=${binding.id.slice(0, 8)}`))
})

test('all supported local agents can initialize exchange bindings, exchange commands, and merge fragments into a shared board', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-board-multi-agent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fragments = []
  for (const agent of EXCHANGE_AGENTS) {
    const dir = join(root, agent)
    const { binding } = await exchange('init', dir, { agent, session: `session-${agent}` })
    assert.equal(binding.agent, agent)
    const cmd = { version: 1, id: `cmd-${agent}`, binding: binding.id, agent, session: binding.session, text: `Handoff to ${agent}`, turn: '' }
    assert.equal((await exchange('enqueue', dir, cmd)).status, 'queued')
    assert.equal((await exchange('take', dir, { id: cmd.id, binding: binding.id, session: binding.session, agent })).status, 'claimed')
    assert.equal((await exchange('ack', dir, { version: 1, id: cmd.id, binding: binding.id, status: 'delivered' })).status, 'delivered')
    await exchange('report', dir, { project: 'Multi-Agent Hub', title: `Task for ${agent}`, state: 'working', steps: [{ status: 'doing', text: `Executing ${agent} step` }] })
    fragments.push(join(dir, 'fragment.md'))
  }
  const python = process.platform === 'win32' ? 'python' : 'python3'
  if (spawnSync(python, ['--version']).error) return
  const board = join(root, 'progress.md')
  await writeFile(board, '# Progress\n')
  const merge = join(dirname(fileURLToPath(import.meta.url)), '../scripts/remote-reporter/merge.py')
  const run = spawnSync(python, ['-B', merge, board, ...fragments], { encoding: 'utf8', timeout: 20000 })
  assert.equal(run.status, 0, run.stderr)
  const parsed = parseProgress(await readFile(board, 'utf8')).find(project => project.name === 'Multi-Agent Hub')
  assert.equal(parsed?.tasks.length, EXCHANGE_AGENTS.length)
  assert.deepEqual(parsed?.tasks.map(task => task.auto?.agent).sort(), [...EXCHANGE_AGENTS].sort())
})

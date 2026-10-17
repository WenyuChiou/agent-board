import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { exchange } from '../scripts/exchange.mjs'
import { dispatchCodex } from '../scripts/codex-owner.mjs'
import { bindingOf, progressBlock, commandOf, codexRequest } from '../hooks/exchange.ts'
import { parseProgress } from '../hooks/parse.ts'
import { EN } from '../hooks/strings-en.ts'
import { ZH_TW } from '../hooks/i18n.ts'
import { ZH_CN } from '../hooks/strings-zh-cn.ts'

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
  const text = await readFile(join(directory, 'progress.md'), 'utf8')
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
    const text = await readFile(join(directory, 'progress.md'), 'utf8')
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
  assert.match(await readFile(join(directory, 'progress.md'), 'utf8'), /agent=codex state=working/)
})

test('explicit bindings reject wrong recipients and paths disguised as ids', async t => {
  const { directory, binding, command } = await fixture(t)
  await assert.rejects(exchange('enqueue', directory, { ...command, session: 'another-session' }), /TARGET_MISMATCH/)
  await assert.rejects(exchange('enqueue', directory, { ...command, binding: 'old-binding' }), /TARGET_MISMATCH/)
  assert.throws(() => commandOf({ ...command, id: '../escape' }, binding), /INVALID_ID/)
  assert.throws(() => bindingOf({ ...binding, version: 2 }), /UNSUPPORTED_BINDING/)
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
  await assert.rejects(readFile(join(directory, 'child', 'progress.md')), { code: 'ENOENT' })
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
  const before = await readFile(join(directory, 'progress.md'), 'utf8')
  const invalid = [[['delivered'], ['waiting'], ['todo']], ...[{}, true, 1, null].map(value => [value, value, value])]
  for (const [receipt, state, step] of invalid) {
    await assert.rejects(exchange('ack', directory, { version: 1, id: command.id, binding: binding.id, status: receipt }), /INVALID_RECEIPT/)
    assert.equal((await exchange('status', directory)).commands[0].status, 'uncertain')
    await assert.rejects(exchange('report', directory, { ...report, state }), /INVALID_STATE/)
    await assert.rejects(exchange('report', directory, { ...report, steps: [{ status: step, text: 'Invalid step' }] }), /INVALID_STEP/)
    assert.equal(await readFile(join(directory, 'progress.md'), 'utf8'), before)
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

test('unverified owners, unloaded threads, missing methods and idle commands fail closed', async t => {
  for (const reason of ['unverified', 'methods', 'unloaded', 'idle']) {
    const { directory, command, target } = await fixture(t, 'codex')
    const { transport, calls } = fakeOwner()
    if (reason === 'methods') transport.methods = []
    if (reason === 'unloaded') transport.request = async () => ({ data: [], nextCursor: null })
    await exchange('enqueue', directory, { ...command, turn: reason === 'idle' ? '' : command.turn })
    const result = await dispatchCodex(directory, target, transport, async () => reason !== 'unverified')
    assert.equal(result.status, 'uncertain')
    assert.equal(calls.filter(one => one.method === 'turn/steer').length, 0)
    assert.throws(() => codexRequest(command, { agent: 'codex', thread: 'wrong', loaded: true, verified: true, canSteer: true }), /TARGET_MISMATCH/)
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

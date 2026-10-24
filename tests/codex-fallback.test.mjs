import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { codexFallbackCommand, managedFallback } from '../hooks/codex-fallback.ts'
import { boardRun, geminiBoardCommand } from '../hooks/board-commands.ts'
import { codexApproval } from '../scripts/codex-approval.ts'

const source = readFileSync(new URL('../hooks/board-script.ts', import.meta.url), 'utf8')
const bundle = JSON.parse(source.slice(source.indexOf('export const BOARD_SCRIPT = ') + 'export const BOARD_SCRIPT = '.length))
const approvedConnect = f => {
  f.run('connect')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted' }))
  const result = f.run('connect')
  assert.equal(result.state.setup.codexTrusted, true)
  assert.doesNotMatch(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
  assert.deepEqual(result.state.codexApproval.binary, binaryOf(f.executable))
  return result
}
const assertApproved = (f, result) => {
  assert.equal(result.state.setup.codexTrusted, true, JSON.stringify({ problems: result.result.problems, methods: readFileSync(f.log, 'utf8') }))
  assert.ok(!result.result.problems.some(one => one.key === 'codex:approval'))
  assert.doesNotMatch(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
  const config = join(f.root, 'config.toml')
  // The executable is remembered when Codex itself said yes; the 0.23 upgrade path may have none.
  const { binary, ...approval } = result.state.codexApproval
  assert.deepEqual(approval, { source: f.config, sourceHash: sha(readFileSync(f.config)), configHash: existsSync(config) ? sha(readFileSync(config)) : null })
  if (binary !== undefined) assert.deepEqual(binary, binaryOf(f.executable))
}
const binaryOf = file => {
  const path = realpathSync.native(file)
  const { size, mtimeMs } = statSync(path)
  return { path, size, mtime: mtimeMs }
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fixture = async action => {
  const home = mkdtempSync(join(tmpdir(), 'codex-fallback-'))
  const root = join(home, '.codex'), config = join(root, 'hooks.json'), instructions = join(root, 'AGENTS.md'), override = join(root, 'AGENTS.override.md')
  const script = join(home, 'worker.mjs'), executable = join(home, 'control.mjs'), options = join(home, 'scenario.json'), log = join(home, 'methods.jsonl'), replies = join(home, 'replies.jsonl'), control = join(home, '.agent-board', 'legacy-connect.json')
  mkdirSync(root)
  writeFileSync(config, '{"personal":"keep","hooks":{"Stop":[{"hooks":[{"type":"command","command":"personal-before"}]}]}}\n')
  writeFileSync(instructions, '# Personal rules\r\nKeep these bytes.\r\n')
  writeFileSync(options, JSON.stringify({ trust: 'untrusted' }))
  writeFileSync(script, bundle)
  // These cases exercise fallback ownership, not cold Node startup within the
  // product's bounded observation. Real subprocess RPC stays in codex-host.
  writeFileSync(executable, `
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough, Writable } from 'node:stream'
const spawn = childProcess.spawn
let attempts = 0
childProcess.spawn = (file, args, ...rest) => {
  if (file !== process.execPath || args?.length !== 3 || args[0] !== ${JSON.stringify(executable)} || args[1] !== 'app-server' || args[2] !== '--stdio') return spawn(file, args, ...rest)
  const child = new EventEmitter()
  const attempt = ++attempts
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const timers = new Set()
  let buffer = '', isClosed = false
  const answer = (req, value) => {
    if (isClosed) return
    appendFileSync(${JSON.stringify(replies)}, req.method + '\\n')
    child.stdout.write(JSON.stringify({ id: req.id, ...value }) + '\\n')
  }
  const receive = req => {
    appendFileSync(${JSON.stringify(log)}, req.method + '\\n')
    if (req.id === undefined) return
    const options = JSON.parse(readFileSync(${JSON.stringify(options)}, 'utf8'))
    const respond = () => {
      if (options.rejected) return answer(req, { error: { message: 'unsupported' } })
      if (req.method === 'initialize') return answer(req, { result: {} })
      if (req.method !== 'hooks/list') throw Error('FORBIDDEN_METHOD')
      const data = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'))
      let n = 0
      const hooks = options.unlisted ? [] : Object.entries(data.hooks ?? {}).flatMap(([event, groups]) => groups.flatMap(group => (group.hooks ?? []).map(hook => ({ key: 'key-' + (++n), currentHash: options.currentHash ?? 'sha256:' + '1'.repeat(64), sourcePath: ${JSON.stringify(config)}, eventName: event[0].toLowerCase() + event.slice(1), command: hook.command, ...(options.noEnabled ? {} : { enabled: !options.disabled }), trustStatus: options.trust }))))
      answer(req, { result: { data: [{ hooks, errors: [] }] } })
    }
    const delayMs = options.delays?.[req.method] ?? (req.method === 'hooks/list' ? options.attemptDelays?.[attempt - 1] ?? options.delayMs : 0)
    if (delayMs) timers.add(setTimeout(respond, delayMs))
    else respond()
  }
  child.stdin = new Writable({ write(chunk, encoding, done) {
    try {
      buffer += String(chunk)
      let end
      while ((end = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        receive(JSON.parse(line))
      }
      done()
    } catch (error) { done(error) }
  } })
  child.kill = () => {
    isClosed = true
    for (const timer of timers) clearTimeout(timer)
    child.stdin.destroy()
    child.stdout.end()
    child.stderr.end()
    child.emit('exit', null, 'SIGTERM')
    return true
  }
  return child
}
syncBuiltinESMExports()`)
  const request = (mode, extra = {}) => ({ mode, home, progress: join(home, 'data', 'progress.md'), lang: 'en', node: process.version, codexExecutable: executable, ...extra })
  const run = (mode, extra = {}, env) => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(executable).href, script, '--legacy-connect-request', JSON.stringify(request(mode, extra))], { encoding: 'utf8', windowsHide: true, timeout: 10000, ...(env ? { env: { ...process.env, ...env } } : {}) })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    return JSON.parse(result.stdout)
  }
  try { await action({ home, root, config, instructions, override, options, log, replies, control, executable, request, run }) }
  finally { rmSync(home, { recursive: true, maxRetries: 5, retryDelay: 100 }) }
}

test('managed fallback edits preserve outside bytes and refuse ambiguous owned markers', () => {
  const own = '<!-- agent-board:start -->old bytes<!-- agent-board:end -->'
  assert.equal(managedFallback('before\r\n' + own + '\r\nafter', 'new'), 'before\r\n' + own + '\r\nafter')
  assert.equal(managedFallback('before\r\n' + own + '\r\nafter', null), 'before\r\n\r\nafter')
  for (const text of [own + own, '<!-- agent-board:start -->', '<!--agent-board:start-->', '<!-- agent-board:start --><!-- claude-progress-pane:end -->']) assert.equal(managedFallback(text, null), null)
  const command = codexFallbackCommand('/synthetic/$bad;`path`/board.mjs', '/synthetic/$(no)/progress.md')
  assert.doesNotMatch(command, /\$bad|\$\(no\)|`path`/)
  assert.match(command, /--codex-report/)
})

test('codex fallback: re-applying with a new board path rewrites the managed block and keeps every byte outside it', () => fixture(async f => {
  f.run('connect')
  const old = codexFallbackCommand(join(f.home, 'removed scratch', 'agent-board.mjs'), join(f.home, 'removed scratch', 'progress.md'))
  const current = codexFallbackCommand(join(f.home, 'data', 'agent-board.mjs'), join(f.home, 'data', 'progress.md'))
  const before = '\ufeff# Personal rules\r\nKeep bytes.\n\r\n'
  const after = '\r\nOutside notes.\nNo final newline'
  for (const name of ['agent-board', 'claude-progress-pane']) {
    const text = before + `<!-- ${name}:start -->\r\nMy edited introduction.\n\r\n${old}\r\n\nMy edited closing.\r\n<!-- ${name}:end -->` + after
    writeFileSync(f.override, text)
    const instructions = readFileSync(f.instructions)
    assert.equal(managedFallback(text, current), text.replace(old, current))
    f.run('connect')
    assert.deepEqual(readFileSync(f.override), Buffer.from(text.replace(old, current)))
    assert.deepEqual(readFileSync(f.instructions), instructions, 'the overridden file stays unchanged')
    assert.equal(managedFallback(text, ''), text, 'the empty sentinel retains existing instructions')
    assert.equal(managedFallback(text, null), before + after)
  }
}))

test('codex fallback: re-applying with a new progress path rewrites the managed block', () => fixture(async f => {
  f.run('connect')
  const board = join(f.home, 'data', 'agent-board.mjs')
  const oldProgress = join(f.home, 'data', 'progress.md')
  const progress = join(f.home, 'data', 'renamed progress.md')
  const old = codexFallbackCommand(board, oldProgress)
  const current = codexFallbackCommand(board, progress)
  const before = readFileSync(f.instructions, 'utf8')
  assert.ok(before.includes(old))
  const expected = before.replace(old, current)
  assert.equal(managedFallback(before, current), expected)
  f.run('connect', { progress })
  assert.equal(readFileSync(f.instructions, 'utf8'), expected)
  const time = new Date('2020-01-01T00:00:00Z')
  utimesSync(f.instructions, time, time)
  f.run('connect', { progress })
  assert.equal(statSync(f.instructions).mtimeMs, time.getTime())
}))

test('codex fallback: re-applying with the same board path writes nothing', () => fixture(async f => {
  f.run('connect')
  const text = readFileSync(f.instructions)
  const time = new Date('2020-01-01T00:00:00Z')
  utimesSync(f.instructions, time, time)
  const before = statSync(f.instructions).mtimeMs
  f.run('connect')
  assert.deepEqual(readFileSync(f.instructions), text)
  assert.equal(statSync(f.instructions).mtimeMs, before)
}))

test('connect status: a host config that names a missing board script is reported by host name', () => fixture(async f => {
  f.run('connect')
  const missing = join(f.home, 'removed scratch $literal', 'agent-board.mjs')
  const progress = join(f.home, 'removed scratch $literal', 'progress.md')
  const plain = join(f.home, 'removed plain', 'agent-board.mjs')
  const files = new Map([
    [f.override, '<!-- agent-board:start -->\n' + codexFallbackCommand(missing, progress) + '\n<!-- agent-board:end -->\n'],
    [join(f.home, '.gemini', 'commands', 'board.toml'), geminiBoardCommand('Synthetic board', 'Run the board', boardRun(missing))],
    [join(f.home, '.cursor', 'hooks.json'), JSON.stringify({ hooks: { stop: [{ command: `"${process.execPath}" "${plain}" --codex-event` }] } })],
    [join(f.home, '.hermes', 'skills', 'agent-board', 'SKILL.md'), `Run \`node "${plain}" --chat\`.\n`],
  ])
  for (const [file, text] of files) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }
  const ledger = readFileSync(f.control)
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const status = f.run('status', { lang })
    const problems = status.state.setup.problems.filter(one => one.key.startsWith('missingBoard:'))
    assert.deepEqual(problems.map(one => one.key).sort(), ['missingBoard:codex', 'missingBoard:cursor', 'missingBoard:gemini', 'missingBoard:hermes'])
    for (const [agent, label] of [['codex', 'Codex'], ['cursor', 'Cursor'], ['gemini', 'Gemini CLI'], ['hermes', 'Hermes Agent']]) {
      const warning = problems.find(one => one.key === 'missingBoard:' + agent).text
      assert.ok(warning.includes(label), warning)
      assert.ok(!warning.includes(f.home), warning)
      assert.doesNotMatch(warning, /agent-board\.mjs|[a-f0-9]{64}/)
    }
    for (const [file, text] of files) assert.equal(readFileSync(file, 'utf8'), text)
    assert.deepEqual(readFileSync(f.control), ledger, 'status does not persist its observations')
  }
  for (const file of [missing, plain]) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '// Synthetic script\n')
  }
  assert.ok(!f.run('status').state.setup.problems.some(one => one.key.startsWith('missingBoard:')))
}))

test('connect status: only command lines a reconnect refreshes raise the missing board warning', () => fixture(async f => {
  f.run('connect')
  const gone = join(f.home, 'removed scratch', 'agent-board.mjs')
  const stale = codexFallbackCommand(gone, join(f.home, 'removed scratch', 'progress.md'))
  const block = command => '<!-- agent-board:start -->\n' + command + '\n<!-- agent-board:end -->\n'
  const warned = () => f.run('status').state.setup.problems.filter(one => one.key.startsWith('missingBoard:')).map(one => one.key).sort()
  // Codex reads a non-empty override instead, and a reconnect never refreshes the file it shadows.
  writeFileSync(f.override, 'Personal override rules.\n')
  writeFileSync(f.instructions, block(stale))
  assert.deepEqual(warned(), [])
  // A reconnect leaves an edited command line and a copy outside the block alone.
  writeFileSync(f.override, stale + '\n' + block(stale + ' --session x'))
  assert.deepEqual(warned(), [])
  writeFileSync(f.override, block(stale))
  assert.deepEqual(warned(), ['missingBoard:codex'])
  writeFileSync(f.override, 'Personal override rules.\n')
  // Agent Board never writes a relative, ~ or variable path, and where one points depends on where the session started.
  const skill = join(f.home, '.hermes', 'skills', 'agent-board', 'SKILL.md')
  mkdirSync(join(skill, '..'), { recursive: true })
  writeFileSync(skill, 'Run `node "scripts/agent-board.mjs" --chat`, `node "~/board/agent-board.mjs"`, `node "%USERPROFILE%\\board\\agent-board.mjs"` or `node "/tmp/$USER/agent-board.mjs"`.\n')
  assert.deepEqual(warned(), [])
  writeFileSync(skill, `Run \`node "${gone}" --chat\`.\n`)
  assert.deepEqual(warned(), ['missingBoard:hermes'])
}))

for (const lang of ['en', 'zh-TW', 'zh-CN']) test(`new or untrusted Codex hooks keep fallback and exact approval retires it in ${lang}`, () => fixture(async f => {
  const personal = readFileSync(f.instructions, 'utf8')
  const first = f.run('connect', { lang })
  assert.ok(first.result.problems.some(one => one.key === 'codex:approval'))
  assert.ok(readFileSync(f.instructions, 'utf8').startsWith(personal))
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
  assert.match(readFileSync(f.instructions, 'utf8'), /--codex-report/)
  const config = readFileSync(f.config, 'utf8')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted' }))
  const approved = f.run('connect', { lang })
  assert.equal(approved.state.setup.codexTrusted, true)
  assert.doesNotMatch(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
  assert.equal(readFileSync(f.config, 'utf8'), config)
  assert.ok(readFileSync(f.instructions, 'utf8').startsWith(personal))
  const changed = JSON.parse(config)
  changed.hooks.Stop.at(-1).hooks[0].command += ' changed'
  writeFileSync(f.config, JSON.stringify(changed))
  const renewed = f.run('connect', { lang })
  assert.equal(renewed.state.setup.codexTrusted, false)
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
  assert.deepEqual([...new Set(readFileSync(f.log, 'utf8').trim().split('\n'))].sort(), ['hooks/list', 'initialize', 'initialized'])
}))

test('the Codex trust check keeps the fallback and says why when the host answers too slowly', () => fixture(async f => {
  f.run('connect')
  const before = readFileSync(f.instructions, 'utf8'), config = readFileSync(f.config, 'utf8')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted', delayMs: 6000 }))
  writeFileSync(f.log, '')
  writeFileSync(f.replies, '')
  const result = f.run('connect')
  assert.equal(result.state.setup.codexTrusted, false)
  assert.equal(readFileSync(f.instructions, 'utf8'), before)
  assert.match(before, /agent-board:start/)
  assert.equal(readFileSync(f.config, 'utf8'), config)
  assert.ok(result.result.problems.some(one => one.key === 'codex:approval'))
  assert.match(result.result.text, /Current Codex hook approval is unconfirmed/)
  assert.match(result.result.text, /reporting instructions are retained/)
  assert.deepEqual(readFileSync(f.log, 'utf8').trim().split('\n'), ['initialize', 'initialized', 'hooks/list', 'initialize', 'initialized', 'hooks/list'])
  assert.deepEqual(readFileSync(f.replies, 'utf8').trim().split('\n'), ['initialize', 'initialize'])
}))

test('lost or unsupported Codex trust restores effective override fallback while status writes no instructions', () => fixture(async f => {
  f.run('connect')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted' }))
  f.run('connect')
  writeFileSync(f.override, '# Override personal rules\r\n')
  writeFileSync(f.options, JSON.stringify({ trust: 'untrusted' }))
  const before = readFileSync(f.instructions, 'utf8'), override = readFileSync(f.override, 'utf8')
  const status = f.run('status')
  assert.equal(status.state.setup.codexTrusted, false)
  assert.equal(readFileSync(f.instructions, 'utf8'), before)
  assert.equal(readFileSync(f.override, 'utf8'), override)
  f.run('auto')
  assert.ok(readFileSync(f.override, 'utf8').startsWith(override))
  assert.match(readFileSync(f.override, 'utf8'), /agent-board:start/)
  assert.equal(readFileSync(f.instructions, 'utf8'), before)
  writeFileSync(f.options, JSON.stringify({ rejected: true }))
  f.run('connect')
  assert.match(readFileSync(f.override, 'utf8'), /agent-board:start/)
  f.run('connect', { codexExecutable: join(f.home, 'missing-control.exe') })
  assert.match(readFileSync(f.override, 'utf8'), /agent-board:start/)
  f.run('remove')
  assert.doesNotMatch(readFileSync(f.override, 'utf8'), /agent-board:start/)
  assert.ok(readFileSync(f.override, 'utf8').startsWith(override))
}))

test('a trusted observation invalidated before the lock cannot retire fallback or overwrite foreign groups', () => fixture(async f => {
  f.run('connect')
  const before = readFileSync(f.instructions, 'utf8')
  writeFileSync(f.log, '')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted' }))
  const preload = join(f.home, 'drift.mjs')
  writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const read=fs.readFileSync,open=fs.openSync;let changed=false;fs.openSync=(file,...args)=>{if(file===${JSON.stringify(join(f.home, '.agent-board', 'install.lock'))}&&!read(${JSON.stringify(f.log)},'utf8').includes('hooks/list'))throw Error('PROBE_NOT_BEFORE_LOCK');return open(file,...args)};fs.readFileSync=(file,...args)=>{if(!changed&&file===${JSON.stringify(f.control)}){changed=true;fs.appendFileSync(${JSON.stringify(f.config)},' ')}return read(file,...args)};syncBuiltinESMExports()`)
  f.run('connect', {}, { NODE_OPTIONS: '--import=' + pathToFileURL(preload).href })
  assert.equal(readFileSync(f.instructions, 'utf8'), before)
  assert.ok(JSON.parse(readFileSync(f.config, 'utf8')).hooks.Stop[0].hooks.some(one => one.command === 'personal-before'))
}))

test('disabled definitions and ambiguous instruction markers stay conservative and foreign boards never become fallback commands', () => fixture(async f => {
  f.run('connect')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted', disabled: true }))
  f.run('connect')
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
  const ambiguous = '<!-- agent-board:start -->one<!-- agent-board:end -->\n<!-- agent-board:start -->two<!-- agent-board:end -->'
  writeFileSync(f.instructions, ambiguous)
  f.run('connect')
  assert.equal(readFileSync(f.instructions, 'utf8'), ambiguous)
  const board = join(f.home, 'data', 'agent-board.mjs')
  writeFileSync(board, 'foreign executable')
  writeFileSync(f.instructions, '# Personal only\n')
  f.run('connect')
  assert.equal(readFileSync(f.instructions, 'utf8'), '# Personal only\n')
}))

test('an empty override remains empty and does not shadow personal AGENTS rules with a generated fallback', () => fixture(async f => {
  const before = readFileSync(f.instructions, 'utf8')
  writeFileSync(f.override, ' \r\n')
  f.run('connect')
  assert.equal(readFileSync(f.override, 'utf8'), ' \r\n')
  assert.ok(readFileSync(f.instructions, 'utf8').startsWith(before))
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
}))

for (const artifact of ['board', 'reporter']) test(`approved definitions cannot retire existing fallback after the owned ${artifact} is replaced`, () => fixture(async f => {
  f.run('connect')
  const before = readFileSync(f.instructions, 'utf8')
  const file = join(f.home, 'data', artifact === 'board' ? 'agent-board.mjs' : process.platform === 'win32' ? 'progress-report.ps1' : 'progress-report.sh')
  writeFileSync(file, 'foreign executable bytes')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted' }))
  const result = f.run('connect')
  assert.equal(readFileSync(f.instructions, 'utf8'), before)
  assert.equal(readFileSync(file, 'utf8'), 'foreign executable bytes')
  assert.ok(result.result.problems.some(one => one.key === 'preserved:' + file))
}))

test('a hook source change while reading instructions cannot retire an existing fallback', () => fixture(async f => {
  f.run('connect')
  const before = readFileSync(f.instructions, 'utf8')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted' }))
  const preload = join(f.home, 'instruction-drift.mjs')
  // The first read of AGENTS.md comes before the approval decision; the second is
  // the one just before the fallback is retired, after the decision is made.
  writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const read=fs.readFileSync;let reads=0;fs.readFileSync=(file,...args)=>{if(file===${JSON.stringify(f.instructions)}&&reads++===1)fs.appendFileSync(${JSON.stringify(f.config)},' ');return read(file,...args)};syncBuiltinESMExports()`)
  const result = f.run('connect', {}, { NODE_OPTIONS: '--import=' + pathToFileURL(preload).href })
  assert.equal(readFileSync(f.instructions, 'utf8'), before)
  assert.equal(result.state.setup.codexTrusted, false)
}))

test('a Codex config.toml change while reading instructions cannot retire an existing fallback', () => fixture(async f => {
  const config = join(f.root, 'config.toml')
  writeFileSync(config, '# synthetic Codex settings\n')
  f.run('connect')
  const before = readFileSync(f.instructions, 'utf8')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted' }))
  const preload = join(f.home, 'config-drift.mjs')
  // As above, but /hooks rewrites config.toml after Codex answered and before the fallback is retired.
  writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const read=fs.readFileSync;let reads=0;fs.readFileSync=(file,...args)=>{if(file===${JSON.stringify(f.instructions)}&&reads++===1)fs.appendFileSync(${JSON.stringify(config)},'# hooks untrusted\\n');return read(file,...args)};syncBuiltinESMExports()`)
  const result = f.run('connect', {}, { NODE_OPTIONS: '--import=' + pathToFileURL(preload).href })
  assert.match(readFileSync(config, 'utf8'), /hooks untrusted/)
  assert.equal(readFileSync(f.instructions, 'utf8'), before)
  assert.equal(result.state.setup.codexTrusted, false)
}))

test('an approved Codex whose check cannot run keeps no fallback while hooks.json is unchanged', () => fixture(async f => {
  approvedConnect(f)
  for (const mode of ['connect', 'auto']) {
    assertApproved(f, f.run(mode, { codexExecutable: undefined }, { PATH: '' }))
    assertApproved(f, f.run(mode, { codexExecutable: join(f.home, 'missing-control.exe') }))
    writeFileSync(f.options, JSON.stringify({ rejected: true }))
    writeFileSync(f.log, '')
    assertApproved(f, f.run(mode))
    assert.deepEqual(readFileSync(f.log, 'utf8').trim().split('\n'), ['initialize'])
  }
}))

test('an approved Codex whose check answers too slowly keeps no fallback', () => fixture(async f => {
  approvedConnect(f)
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted', delayMs: 6000 }))
  writeFileSync(f.log, '')
  const start = Date.now()
  assertApproved(f, f.run('connect'))
  assert.ok(Date.now() - start < 8000)
  assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').filter(one => one === 'initialize').length, 2)
}))

for (const answer of ['disabled', 'unlisted']) test(`an approved Codex whose hooks Codex reports as ${answer} gets the fallback back`, () => fixture(async f => {
  approvedConnect(f)
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted', [answer]: true }))
  const result = f.run('auto')
  assert.equal(result.state.setup.codexTrusted, false)
  assert.ok(result.result.problems.some(one => one.key === 'codex:approval'))
  assert.equal(JSON.parse(readFileSync(f.control, 'utf8')).codexApproval, undefined)
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
  // Once Codex has said no, a later check that cannot run does not bring the old approval back.
  const unavailable = f.run('connect', { codexExecutable: join(f.home, 'missing-control.exe') })
  assert.equal(unavailable.state.setup.codexTrusted, false)
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
}))

test('a Codex that is really untrusted gets the fallback', () => fixture(async f => {
  // The first connect writes our hooks; only the second finds them listed, untrusted.
  f.run('connect')
  writeFileSync(f.replies, '')
  const result = f.run('connect')
  assert.ok(readFileSync(f.replies, 'utf8').split('\n').includes('hooks/list'))
  assert.equal(result.state.setup.codexTrusted, false)
  assert.ok(result.result.problems.some(one => one.key === 'codex:approval'))
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
  assert.equal(result.state.codexApproval, undefined)
}))

test('an approval revoked later brings the fallback back when the check says untrusted', () => fixture(async f => {
  approvedConnect(f)
  writeFileSync(f.options, JSON.stringify({ trust: 'untrusted' }))
  writeFileSync(f.log, '')
  const result = f.run('connect')
  assert.equal(result.state.setup.codexTrusted, false)
  assert.ok(result.result.problems.some(one => one.key === 'codex:approval'))
  assert.equal(JSON.parse(readFileSync(f.control, 'utf8')).codexApproval, undefined)
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
  assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').filter(one => one === 'initialize').length, 1)
  const unavailable = f.run('connect', { codexExecutable: join(f.home, 'missing-control.exe') })
  assert.equal(unavailable.state.setup.codexTrusted, false)
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
}))

test('a home that already has the fallback while Codex is approved has it retired by a successful check', () => fixture(async f => {
  approvedConnect(f)
  const personal = readFileSync(f.instructions, 'utf8')
  writeFileSync(f.instructions, personal + '\n<!-- agent-board:start -->\nRetained fallback\n<!-- agent-board:end -->\n')
  assertApproved(f, f.run('connect'))
  assert.ok(readFileSync(f.instructions, 'utf8').startsWith(personal))
}))

test('a changed hooks.json makes a remembered approval count for nothing', () => fixture(async f => {
  const previous = approvedConnect(f).state.codexApproval
  const config = JSON.parse(readFileSync(f.config, 'utf8'))
  config.hooks.Stop.push({ hooks: [{ type: 'command', command: 'synthetic personal hook' }] })
  writeFileSync(f.config, JSON.stringify(config))
  const result = f.run('connect', { codexExecutable: join(f.home, 'missing-control.exe') })
  assert.equal(result.state.setup.codexTrusted, false)
  assert.deepEqual(result.state.codexApproval, previous)
  assert.ok(result.result.problems.some(one => one.key === 'codex:approval'))
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
}))

test('a home approved under 0.23 keeps no fallback when its first check after the upgrade cannot run', () => fixture(async f => {
  approvedConnect(f)
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  delete state.codexApproval
  writeFileSync(f.control, JSON.stringify(state))
  const unavailable = { codexExecutable: join(f.home, 'missing-control.exe') }
  const before = readFileSync(f.control, 'utf8')
  assert.equal(f.run('status', unavailable).state.setup.codexTrusted, true)
  assert.equal(readFileSync(f.control, 'utf8'), before)
  const result = f.run('connect', unavailable)
  assertApproved(f, result)
  assert.deepEqual(JSON.parse(readFileSync(f.control, 'utf8')).codexApproval, result.state.codexApproval)
  f.run('remove')
  assert.equal(JSON.parse(readFileSync(f.control, 'utf8')).codexApproval, undefined)
}))

test('a Codex check that times out once is tried again and the second answer counts', () => fixture(async f => {
  f.run('connect')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted', attemptDelays: [2500, 0] }))
  writeFileSync(f.log, '')
  assertApproved(f, f.run('connect'))
  assert.deepEqual(readFileSync(f.log, 'utf8').trim().split('\n'), ['initialize', 'initialized', 'hooks/list', 'initialize', 'initialized', 'hooks/list'])
}))

test('a Codex answer that takes 1.5 s counts on the first attempt', () => fixture(async f => {
  f.run('connect')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted', delays: { 'hooks/list': 1500 } }))
  writeFileSync(f.log, '')
  assertApproved(f, f.run('connect'))
  assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').filter(one => one === 'initialize').length, 1)
}))

test('a cold Codex start that takes 2.5 s to answer counts on the first attempt', () => fixture(async f => {
  f.run('connect')
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted', delays: { initialize: 2500 } }))
  writeFileSync(f.log, '')
  assertApproved(f, f.run('connect'))
  assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').filter(one => one === 'initialize').length, 1)
}))

test('an approved Codex whose hooks Codex lists in a hash format this code does not know keeps no fallback', () => fixture(async f => {
  approvedConnect(f)
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted', currentHash: 'future-hash' }))
  writeFileSync(f.replies, '')
  assertApproved(f, f.run('connect'))
  assert.ok(readFileSync(f.replies, 'utf8').split('\n').includes('hooks/list'))
}))

test('an approved Codex whose hooks Codex calls untrusted in a hash format this code does not know gets the fallback back', () => fixture(async f => {
  approvedConnect(f)
  // A new hash format untrusts the hooks without touching config.toml.
  writeFileSync(f.options, JSON.stringify({ trust: 'untrusted', currentHash: 'future-hash' }))
  const result = f.run('connect')
  assert.equal(result.state.setup.codexTrusted, false)
  assert.equal(JSON.parse(readFileSync(f.control, 'utf8')).codexApproval, undefined)
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
}))

test('a hooks list without an enabled flag keeps a remembered approval only while config.toml is unchanged', () => fixture(async f => {
  const config = join(f.root, 'config.toml')
  writeFileSync(config, '# synthetic Codex settings\n')
  approvedConnect(f)
  // An answer this code cannot read counts as no answer, so config.toml decides.
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted', noEnabled: true }))
  writeFileSync(f.replies, '')
  assertApproved(f, f.run('connect'))
  assert.ok(readFileSync(f.replies, 'utf8').split('\n').includes('hooks/list'))
  writeFileSync(config, '# synthetic Codex settings, hooks turned off\n')
  const result = f.run('connect')
  assert.equal(result.state.setup.codexTrusted, false)
  assert.ok(result.result.problems.some(one => one.key === 'codex:approval'))
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
}))

test('a change to Codex config.toml voids a remembered approval when Codex cannot be asked', () => fixture(async f => {
  const config = join(f.root, 'config.toml')
  writeFileSync(config, '# synthetic Codex settings\n')
  approvedConnect(f)
  const unavailable = { codexExecutable: join(f.home, 'missing-control.exe') }
  assertApproved(f, f.run('connect', unavailable))
  // Untrusting or turning the hooks off in /hooks rewrites config.toml, not hooks.json.
  writeFileSync(config, '# synthetic Codex settings, hooks untrusted\n')
  const result = f.run('connect', unavailable)
  assert.equal(result.state.setup.codexTrusted, false)
  assert.ok(result.result.problems.some(one => one.key === 'codex:approval'))
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
}))

test('a home approved under 0.23 whose hooks.json is gone does not count as approved', () => fixture(async f => {
  approvedConnect(f)
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  delete state.codexApproval
  writeFileSync(f.control, JSON.stringify(state))
  rmSync(f.config)
  const result = f.run('status', { codexExecutable: join(f.home, 'missing-control.exe') })
  assert.equal(result.state.setup.codexTrusted, false)
}))

test('a shared Codex check deadline bounds delayed requests across both attempts', () => fixture(async f => {
  approvedConnect(f)
  // A connect with an instant answer measures this machine's start-up time.
  let start = Date.now()
  assertApproved(f, f.run('connect'))
  const startup = Date.now() - start
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted', delays: { initialize: 1500, 'hooks/list': 6000 } }))
  writeFileSync(f.log, '')
  start = Date.now()
  assertApproved(f, f.run('connect'))
  // The check stops at its 5 s budget; without the shared deadline the second attempt runs about 7 s in all.
  assert.ok(Date.now() - start - startup < 6000, String(Date.now() - start - startup))
  assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').filter(one => one === 'initialize').length, 2)
}))

test('an upgrade cannot seed approval if this connect rewrites hooks.json', () => fixture(async f => {
  approvedConnect(f)
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  delete state.codexApproval
  writeFileSync(f.control, JSON.stringify(state))
  const config = JSON.parse(readFileSync(f.config, 'utf8'))
  config.hooks.Stop.at(-1).hooks[0].command += ' changed'
  writeFileSync(f.config, JSON.stringify(config))
  const result = f.run('connect', { codexExecutable: join(f.home, 'missing-control.exe') })
  assert.equal(result.state.setup.codexTrusted, false)
  assert.equal(result.state.codexApproval, undefined)
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
}))

test('an approved Codex replaced by an upgrade that then cannot be asked gets the fallback back', () => fixture(async f => {
  approvedConnect(f)
  // A new Codex can stop trusting our hooks without changing hooks.json or config.toml.
  appendFileSync(f.executable, '\n// a newer Codex\n')
  writeFileSync(f.options, JSON.stringify({ rejected: true }))
  const result = f.run('connect')
  assert.equal(result.state.setup.codexTrusted, false)
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
  // With no Codex found, the remembered approval stands as before.
  const missing = f.run('connect', { codexExecutable: join(f.home, 'missing-control.exe') })
  assert.equal(missing.state.setup.codexTrusted, true)
  assert.doesNotMatch(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
  // The new Codex's own yes is remembered with it.
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted' }))
  assertApproved(f, f.run('connect'))
  assert.deepEqual(JSON.parse(readFileSync(f.control, 'utf8')).codexApproval.binary, binaryOf(f.executable))
}))

test('a home approved under 0.23 is not taken as approved when config.toml changed after its last connect', () => fixture(async f => {
  approvedConnect(f)
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  delete state.codexApproval
  writeFileSync(f.control, JSON.stringify(state))
  // Untrusting our hooks in /hooks writes config.toml, which the 0.23 connect never saw.
  const config = join(f.root, 'config.toml')
  writeFileSync(config, '[hooks.state]\n')
  const saved = statSync(f.control).mtimeMs / 1000
  const unavailable = { codexExecutable: join(f.home, 'missing-control.exe') }
  utimesSync(config, saved - 60, saved - 60)
  assert.equal(f.run('status', unavailable).state.setup.codexTrusted, true)
  utimesSync(config, saved + 60, saved + 60)
  assert.equal(f.run('status', unavailable).state.setup.codexTrusted, false)
  const result = f.run('connect', unavailable)
  assert.equal(result.state.setup.codexTrusted, false)
  assert.equal(result.state.codexApproval, undefined)
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
}))

// A home whose 0.23 connect confirmed the approval, with Codex not answering now.
const approvedUnder023 = f => {
  approvedConnect(f)
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  delete state.codexApproval
  writeFileSync(f.control, JSON.stringify(state))
  writeFileSync(f.options, JSON.stringify({ rejected: true }))
  return statSync(f.control).mtimeMs / 1000
}

test('a home approved under 0.23 is not taken as approved when its Codex executable changed after its last connect and Codex cannot be asked', () => fixture(async f => {
  const saved = approvedUnder023(f)
  // A Codex upgrade replaces the executable, which the 0.23 connect never saw.
  utimesSync(f.executable, saved + 60, saved + 60)
  assert.equal(f.run('status').state.setup.codexTrusted, false)
  const result = f.run('connect')
  assert.equal(result.state.setup.codexTrusted, false)
  assert.equal(result.state.codexApproval, undefined)
  assert.match(readFileSync(f.instructions, 'utf8'), /agent-board:start/)
}))

test('a home approved under 0.23 whose Codex executable is older than its last connect is taken as approved and remembers that executable', () => fixture(async f => {
  const saved = approvedUnder023(f)
  utimesSync(f.executable, saved - 60, saved - 60)
  assert.equal(f.run('status').state.setup.codexTrusted, true)
  const result = f.run('connect')
  assertApproved(f, result)
  assert.deepEqual(result.state.codexApproval.binary, binaryOf(f.executable))
}))

test('a config.toml with a byte-order mark, CRLF and characters outside ASCII hashes the same on both sides of the connect', () => fixture(async f => {
  writeFileSync(join(f.root, 'config.toml'), '\uFEFF# \u500b\u4eba\u8a2d\u5b9a \u2713 \u{1F600}\r\nmodel = "synthetic"\r\n')
  assertApproved(f, approvedConnect(f))
}))

test('the shared Codex approval decision requires the exact current source and hash', () => {
  const source = join(tmpdir(), 'synthetic-codex', 'hooks.json')
  const sourceHash = 'a'.repeat(64), otherHash = 'b'.repeat(64), configHash = 'c'.repeat(64), otherConfig = 'd'.repeat(64)
  const approval = { source, sourceHash, configHash }
  const observation = { source, sourceHash, trusted: true, hooks: [], configHash }
  for (const stale of [{ ...observation, source: source + '.other' }, { ...observation, sourceHash: otherHash }, { ...observation, configHash: otherConfig }]) {
    assert.deepEqual(codexApproval(stale, source, sourceHash, configHash, approval, true, sourceHash, null), { trusted: false, approval })
  }
  assert.deepEqual(codexApproval(observation, source, sourceHash, configHash, undefined, false, otherHash, null), { trusted: true, approval })
  assert.deepEqual(codexApproval(observation, source, sourceHash, undefined, approval, true, sourceHash, null), { trusted: false, approval })
  // A no clears the approval whatever config.toml holds.
  assert.deepEqual(codexApproval({ ...observation, trusted: false, configHash: otherConfig }, source, sourceHash, configHash, approval, true, sourceHash, null), { trusted: false, approval: undefined })
  assert.deepEqual(codexApproval(undefined, source, sourceHash, configHash, approval, false, otherHash, null), { trusted: true, approval })
  const elsewhere = { ...approval, source: source + '.other' }
  assert.deepEqual(codexApproval(undefined, source, sourceHash, configHash, elsewhere, true, sourceHash, null), { trusted: false, approval: elsewhere })
  for (const current of [otherConfig, null, undefined]) assert.deepEqual(codexApproval(undefined, source, sourceHash, current, approval, true, sourceHash, null), { trusted: false, approval })
  assert.deepEqual(codexApproval(undefined, source, sourceHash, configHash, { source, sourceHash }, true, sourceHash, null), { trusted: false, approval: { source, sourceHash } })
  assert.deepEqual(codexApproval(undefined, source, otherHash, configHash, approval, true, sourceHash, null), { trusted: false, approval })
  assert.deepEqual(codexApproval(undefined, source, null, configHash, approval, true, null, null), { trusted: false, approval })
  assert.deepEqual(codexApproval(undefined, source, sourceHash, null, undefined, true, sourceHash, null), { trusted: true, approval: { source, sourceHash, configHash: null } })
  assert.deepEqual(codexApproval(undefined, source, sourceHash, undefined, undefined, true, sourceHash, null), { trusted: false, approval: undefined })
  assert.deepEqual(codexApproval(undefined, source, sourceHash, configHash, undefined, true, otherHash, null), { trusted: false, approval: undefined })
  // The executable that said yes is remembered. When Codex cannot be asked, a different one
  // found here does not confirm the approval, and none found keeps it.
  const binary = { path: join(tmpdir(), 'synthetic-codex', 'codex.exe'), size: 10, mtime: 1 }
  const remembered = { ...approval, binary }
  assert.deepEqual(codexApproval(observation, source, sourceHash, configHash, undefined, false, otherHash, binary), { trusted: true, approval: remembered })
  for (const current of [binary, null]) assert.deepEqual(codexApproval(undefined, source, sourceHash, configHash, remembered, false, otherHash, current), { trusted: true, approval: remembered })
  for (const current of [{ ...binary, path: binary.path + '.new' }, { ...binary, size: 11 }, { ...binary, mtime: 2 }, undefined]) assert.deepEqual(codexApproval(undefined, source, sourceHash, configHash, remembered, false, otherHash, current), { trusted: false, approval: remembered })
  assert.deepEqual(codexApproval(undefined, source, sourceHash, configHash, approval, false, otherHash, binary), { trusted: false, approval })
  assert.deepEqual(codexApproval(undefined, source, sourceHash, configHash, undefined, true, sourceHash, binary), { trusted: true, approval: remembered })
})

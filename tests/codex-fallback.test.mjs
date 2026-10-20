import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { codexFallbackCommand, managedFallback } from '../hooks/codex-fallback.ts'

const source = readFileSync(new URL('../hooks/board-script.ts', import.meta.url), 'utf8')
const bundle = JSON.parse(source.slice(source.indexOf('export const BOARD_SCRIPT = ') + 'export const BOARD_SCRIPT = '.length))
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
  // product's one-second observation. Real subprocess RPC stays in codex-host.
  writeFileSync(executable, `
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough, Writable } from 'node:stream'
const spawn = childProcess.spawn
childProcess.spawn = (file, args, ...rest) => {
  if (file !== process.execPath || args?.length !== 3 || args[0] !== ${JSON.stringify(executable)} || args[1] !== 'app-server' || args[2] !== '--stdio') return spawn(file, args, ...rest)
  const child = new EventEmitter()
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
    if (req.method === 'initialize') return answer(req, { result: {} })
    if (req.method !== 'hooks/list') throw Error('FORBIDDEN_METHOD')
    const options = JSON.parse(readFileSync(${JSON.stringify(options)}, 'utf8'))
    const respond = () => {
      if (options.rejected) return answer(req, { error: { message: 'unsupported' } })
      const data = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'))
      let n = 0
      const hooks = Object.entries(data.hooks ?? {}).flatMap(([event, groups]) => groups.flatMap(group => (group.hooks ?? []).map(hook => ({ key: 'key-' + (++n), currentHash: 'sha256:' + '1'.repeat(64), sourcePath: ${JSON.stringify(config)}, eventName: event[0].toLowerCase() + event.slice(1), command: hook.command, enabled: !options.disabled, trustStatus: options.trust }))))
      answer(req, { result: { data: [{ hooks, errors: [] }] } })
    }
    if (options.delayMs) timers.add(setTimeout(respond, options.delayMs))
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
  try { await action({ home, root, config, instructions, override, options, log, replies, control, request, run }) }
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
  writeFileSync(f.options, JSON.stringify({ trust: 'trusted', delayMs: 1500 }))
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
  assert.deepEqual(readFileSync(f.log, 'utf8').trim().split('\n'), ['initialize', 'initialized', 'hooks/list'])
  assert.deepEqual(readFileSync(f.replies, 'utf8').trim().split('\n'), ['initialize'])
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
  writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const read=fs.readFileSync;let changed=false;fs.readFileSync=(file,...args)=>{if(!changed&&file===${JSON.stringify(f.instructions)}){changed=true;fs.appendFileSync(${JSON.stringify(f.config)},' ')}return read(file,...args)};syncBuiltinESMExports()`)
  const result = f.run('connect', {}, { NODE_OPTIONS: '--import=' + pathToFileURL(preload).href })
  assert.equal(readFileSync(f.instructions, 'utf8'), before)
  assert.equal(result.state.setup.codexTrusted, false)
}))

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const source = readFileSync(new URL('../hooks/board-script.ts', import.meta.url), 'utf8')
const bundle = JSON.parse(source.slice(source.indexOf('export const BOARD_SCRIPT = ') + 'export const BOARD_SCRIPT = '.length))
const fixture = async fn => {
  const home = mkdtempSync(join(tmpdir(), 'legacy-connect-'))
  const script = join(home, 'worker.mjs')
  const progress = join(home, 'data-a', 'progress.md')
  const config = join(home, '.codex', 'hooks.json')
  const control = join(home, '.agent-board', 'legacy-connect.json')
  const lock = join(home, '.agent-board', 'install.lock')
  mkdirSync(join(home, '.codex'))
  const foreign = { private: 'NEVER_STAGE_SECRET', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foreign-command' }] }] } }
  writeFileSync(config, JSON.stringify(foreign))
  writeFileSync(script, bundle)
  const request = (mode, extra = {}) => ({ mode, home, progress, lang: 'en', node: process.version, codexExecutable: join(home, 'missing-control.exe'), ...extra })
  const command = (value, options = {}) => spawnSync(process.execPath, [script, '--legacy-connect-request', JSON.stringify(value)], { encoding: 'utf8', windowsHide: true, timeout: 10000, ...options })
  const run = value => {
    const result = command(value)
    assert.equal(result.status, 0, result.stderr + result.stdout)
    return JSON.parse(result.stdout)
  }
  try { return await fn({ home, script, progress, config, control, lock, foreign, request, command, run }) }
  finally { rmSync(home, { recursive: true, force: true }) }
}

const taggedBoards = new Map()
const taggedBoard = (version, commit) => {
  if (taggedBoards.has(version)) return taggedBoards.get(version)
  const cwd = new URL('..', import.meta.url)
  const tag = `agent-board--v${version}`
  assert.equal(execFileSync('git', ['rev-parse', `${tag}^{}`], { cwd, encoding: 'utf8' }).trim(), commit)
  const source = execFileSync('git', ['show', `${tag}:hooks/board-script.ts`], { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const marker = 'export const BOARD_SCRIPT = '
  const code = JSON.parse(source.slice(source.indexOf(marker) + marker.length))
  taggedBoards.set(version, code)
  return code
}
const adoption = (f, code, hasPriorOwnership = false) => {
  const board = join(f.home, 'data-a', 'agent-board.mjs')
  // This is boardScriptFor's exact header; the installer under test is the
  // compiled worker, rather than a direct source-module ownership check.
  const header = `globalThis.AGENT_BOARD = ${JSON.stringify({ path: f.progress, lang: 'en' })}\n`
  const before = header + code
  mkdirSync(join(f.home, 'data-a'))
  writeFileSync(board, before)
  assert.equal(existsSync(join(f.home, '.agent-board')), false, 'no native ledger, authority or manifest')
  const guard = join(f.home, 'no-native-hosts.mjs')
  const attempted = join(f.home, 'forbidden-child-attempts')
  writeFileSync(guard, `import cp from 'node:child_process'\nimport fs from 'node:fs'\nimport { syncBuiltinESMExports } from 'node:module'\nconst blocked = () => { fs.writeFileSync(${JSON.stringify(attempted)}, 'blocked'); throw Error('NATIVE_HOST_INVOCATION_FORBIDDEN') }\nfor (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = blocked\nsyncBuiltinESMExports()\n`)
  const env = {}
  for (const key of ['SystemRoot', 'WINDIR', 'OS', 'PROCESSOR_ARCHITECTURE']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const [key, dir] of Object.entries({ HOME: f.home, USERPROFILE: f.home, APPDATA: join(f.home, 'appdata'), LOCALAPPDATA: join(f.home, 'local-appdata'), XDG_CONFIG_HOME: join(f.home, 'config'), XDG_DATA_HOME: join(f.home, 'data'), XDG_CACHE_HOME: join(f.home, 'cache'), XDG_STATE_HOME: join(f.home, 'state'), CLAUDE_CONFIG_DIR: join(f.home, '.claude'), TEMP: join(f.home, 'temp'), TMP: join(f.home, 'temp'), PATH: join(f.home, 'empty-bin') })) {
    mkdirSync(dir, { recursive: true })
    env[key] = dir
  }
  env.CLAUDE_PROGRESS_FILE = f.progress
  const dirs = { codex: join(f.home, '.codex'), grok: join(f.home, '.grok'), hermes: join(f.home, '.hermes'), openclaw: join(f.home, '.openclaw'), opencode: join(f.home, '.config', 'opencode') }
  const seed = hasPriorOwnership ? { owned: { [board]: createHash('sha256').update(before).digest('hex') } } : undefined
  // This fixture's empty PATH proves there is no discoverable host. Do not
  // inherit the general fixture's explicit missing binary: even a blocked
  // attempt to spawn that path correctly fails the no-child-process guard.
  const { codexExecutable: _missingHost, ...request } = f.request('connect', { dirs, ...(seed ? { seed } : {}) })
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, f.script, '--legacy-connect-request', JSON.stringify(request)], { cwd: f.home, env, encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(existsSync(attempted), false, 'no native host discovery or invocation')
  assert.equal(JSON.parse(readFileSync(f.config)).private, f.foreign.private)
  assert.ok(readFileSync(f.config, 'utf8').includes('foreign-command'))
  return { board, before, after: readFileSync(board, 'utf8'), expected: header + bundle, output: JSON.parse(result.stdout) }
}

for (const [version, commit] of [['0.23.3', '5610ce6a051ba772ee074ac50bdcbc22c6195f6f'], ['0.23.2', 'b0bb351462158b80ae29161c37054f4549901ac0']]) test(`bundled tagged board adoption: exact ${version} without prior ownership updates and becomes owned`, () => fixture(async f => {
  const result = adoption(f, taggedBoard(version, commit))
  assert.equal(result.output.result.problems.some(problem => problem.key === `preserved:${result.board}`), false, 'a byte-exact published board is recognized without prior ownership')
  assert.notEqual(result.before, result.expected)
  assert.equal(result.after, result.expected)
  assert.equal(result.output.state.owned[result.board], createHash('sha256').update(result.after).digest('hex'))
}))

test('bundled tagged board adoption: a modified published board stays preserved and unowned', () => fixture(async f => {
  const modified = taggedBoard('0.23.3', '5610ce6a051ba772ee074ac50bdcbc22c6195f6f') + '\n// Synthetic personal modification\n'
  const result = adoption(f, modified)
  assert.equal(result.after, result.before)
  assert.equal(result.output.state.owned[result.board], undefined)
  assert.ok(result.output.result.problems.some(problem => problem.key === `preserved:${result.board}`))
}))

test('bundled tagged board adoption: exact seeded prior ownership still updates the published board', () => fixture(async f => {
  const result = adoption(f, taggedBoard('0.23.3', '5610ce6a051ba772ee074ac50bdcbc22c6195f6f'), true)
  assert.equal(result.after, result.expected)
  assert.equal(result.output.state.owned[result.board], createHash('sha256').update(result.after).digest('hex'))
  assert.ok(!result.output.result.problems.some(problem => problem.key === `preserved:${result.board}`))
}))

const waitFor = async file => {
  const until = Date.now() + 8000
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error(`FIXTURE_TIMEOUT:${file}`)
    await delay(10)
  }
}
const preload = (f, phase, extra = {}) => {
  const file = join(f.home, `intercept-${phase}.mjs`)
  const reached = join(f.home, `${phase}.reached`), release = join(f.home, `${phase}.release`)
  writeFileSync(file, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const options = ${JSON.stringify({ control: f.control, config: f.config, reached, release, phase, ...extra })}
const rename = fs.renameSync
let held = false
fs.renameSync = (from, to) => {
  const value = to === options.control ? JSON.parse(fs.readFileSync(from, 'utf8')) : null
  if (!held && options.phase === 'drift' && value?.pending?.step?.file === options.config) {
    held = true
    fs.writeFileSync(options.config, JSON.stringify({ private: 'NEVER_STAGE_SECRET', external: 'new foreign work' }))
  }
  const result = rename(from, to)
  const pause = options.phase === 'disable' ? to === options.control && value?.disabled && value?.pending?.step : options.phase === 'intent' ? to === options.control && value?.pending && !value.pending.step : options.phase === 'generated' ? to === options.board : options.phase === 'applied' && to === options.config
  if (!held && pause) {
    held = true
    fs.writeFileSync(options.reached, '')
    const until = Date.now() + 10000
    while (!fs.existsSync(options.release)) {
      if (Date.now() > until) throw new Error('FIXTURE_RELEASE_TIMEOUT')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  return result
}
syncBuiltinESMExports()
`)
  return { file: pathToFileURL(file).href, reached, release }
}
const child = (f, value, intercept) => {
  const process = spawn(globalThis.process.execPath, [...(intercept ? ['--import', intercept.file] : []), f.script, '--legacy-connect-request', JSON.stringify(value)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  process.stderr.on('data', data => { output += data })
  process.stdout.on('data', data => { output += data })
  return { process, exited: once(process, 'exit'), output: () => output }
}

for (const lang of ['en', 'zh-TW', 'zh-CN']) test(`native legacy connect and remove preserve foreign configuration and own every generated file in ${lang}`, () => fixture(async f => {
  const connected = f.run(f.request('connect', { lang }))
  assert.equal(connected.state.disabled, false)
  assert.ok(connected.result.done.includes('Codex'))
  assert.equal(JSON.parse(readFileSync(f.config)).private, f.foreign.private)
  assert.ok(JSON.stringify(JSON.parse(readFileSync(f.config))).includes('foreign-command'))
  assert.ok(Object.keys(connected.state.owned).some(file => file.endsWith('agent-board.mjs')))
  assert.ok(!readFileSync(f.control, 'utf8').includes(f.foreign.private))
  assert.ok(!readFileSync(f.control, 'utf8').includes('foreign-command'))
  const removed = f.run(f.request('remove', { lang }))
  assert.equal(removed.state.disabled, true)
  assert.deepEqual(JSON.parse(readFileSync(f.config)), f.foreign)
  assert.ok(!existsSync(join(f.home, 'data-a', 'agent-board.mjs')))
  assert.ok(existsSync(join(f.home, 'data-a', `progress-report.${process.platform === 'win32' ? 'ps1' : 'sh'}`)))
}))

test('a delayed automatic request cannot undo remove and explicit connect re-enables under native authority', () => fixture(async f => {
  const preparedBeforeRemove = f.request('auto', { seed: { disabled: false } })
  f.run(f.request('connect'))
  f.run(f.request('remove'))
  const before = readFileSync(f.config, 'utf8')
  const late = f.run(preparedBeforeRemove)
  assert.equal(late.result, null)
  assert.equal(late.state.disabled, true)
  assert.equal(readFileSync(f.config, 'utf8'), before)
  assert.equal(f.run(f.request('connect')).state.disabled, false)
}))

test('the first disabled automatic seed becomes durable and a missing migrated authority fails closed', () => fixture(async f => {
  const initial = f.run(f.request('auto', { seed: { disabled: true } }))
  assert.equal(initial.result, null)
  assert.equal(JSON.parse(readFileSync(f.control)).disabled, true)
  assert.equal(f.run(f.request('auto', { seed: { disabled: false } })).state.disabled, true)
  const original = readFileSync(f.config, 'utf8')
  unlinkSync(f.control)
  const missing = f.command(f.request('auto', { seed: { disabled: false } }))
  assert.notEqual(missing.status, 0)
  assert.ok((missing.stderr + missing.stdout).includes('MISSING_CONNECT_STATE'))
  assert.equal(readFileSync(f.config, 'utf8'), original)
  assert.equal(existsSync(f.control), false)
}))

test('language and notification metadata use native revisions without changing disable authority', () => fixture(async f => {
  const first = f.run(f.request('auto', { seed: { disabled: true, boardLang: 'en' } }))
  const chosen = f.run(f.request('language', { boardLang: 'zh-TW' }))
  assert.equal(chosen.state.boardLang, 'zh-TW')
  assert.equal(chosen.state.disabled, true)
  f.run(f.request('ack', { acknowledgement: { revision: first.state.revision, keys: ['old'] } }))
  const status = f.run(f.request('status'))
  assert.equal(status.state.revision, chosen.state.revision)
  assert.equal(status.state.boardLang, 'zh-TW')
  assert.deepEqual(status.state.notified, [])
}))

test('native connect preserves edited generated files and rejects drift without staging host bodies', () => fixture(async f => {
  f.run(f.request('connect'))
  const board = join(f.home, 'data-a', 'agent-board.mjs')
  const edited = readFileSync(board, 'utf8') + '\n// Personal edit\n'
  writeFileSync(board, edited)
  const result = f.run(f.request('connect'))
  assert.ok(result.result.problems.some(problem => problem.key === `preserved:${board}`))
  assert.equal(readFileSync(board, 'utf8'), edited)
  const hookBytes = readFileSync(f.config, 'utf8')
  assert.ok(hookBytes.includes('foreign-command'))
  assert.ok(!readFileSync(f.control, 'utf8').includes('NEVER_STAGE_SECRET'))
}))

test('missing and unsupported Node observations fail closed before creating transaction state', () => fixture(async f => {
  const original = readFileSync(f.config, 'utf8')
  for (const node of [null, 'v16.0.0']) {
    const result = f.command(f.request('remove', { node }))
    assert.notEqual(result.status, 0)
    assert.ok((result.stderr + result.stdout).includes('NODE_REQUIRED'))
    assert.equal(readFileSync(f.config, 'utf8'), original)
    assert.equal(existsSync(f.control), false)
  }
}))

test('a paused live worker fences legacy remove and the independent installer across data roots', () => fixture(async f => {
  const intercept = preload(f, 'intent')
  const held = child(f, f.request('connect'), intercept)
  try {
    await waitFor(intercept.reached)
    utimesSync(f.lock, new Date(0), new Date(0))
    const remove = f.command(f.request('remove', { progress: join(f.home, 'data-b', 'progress.md') }))
    assert.notEqual(remove.status, 0)
    assert.ok((remove.stderr + remove.stdout).includes('LOCK_BUSY'))
    const native = spawnSync(process.execPath, [f.script, '--codex-setup', '--home', f.home, '--data-dir', join(f.home, 'native-other-data'), '--progress-file', join(f.home, 'native-other-data', 'progress.md'), '--codex-dir', join(f.home, '.codex'), '--apply'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    assert.notEqual(native.status, 0)
    assert.ok((native.stderr + native.stdout).includes('LOCK_BUSY'))
    writeFileSync(intercept.release, '')
    assert.equal((await held.exited)[0], 0, held.output())
    assert.equal(f.run(f.request('remove')).state.disabled, true)
  } finally {
    if (held.process.exitCode === null) { held.process.kill(); await held.exited }
  }
}))

test('a killed writer resumes fingerprint journal recovery before removal without retaining credential bodies', () => fixture(async f => {
  const intercept = preload(f, 'applied')
  const held = child(f, f.request('connect'), intercept)
  try {
    await waitFor(intercept.reached)
    const pending = readFileSync(f.control, 'utf8')
    assert.ok(JSON.parse(pending).pending.step)
    assert.ok(!pending.includes('NEVER_STAGE_SECRET'))
    held.process.kill('SIGKILL')
    await held.exited
    utimesSync(f.lock, new Date(0), new Date(0))
    const removed = f.run(f.request('remove'))
    assert.equal(removed.state.pending, undefined)
    assert.equal(removed.state.disabled, true)
    assert.deepEqual(JSON.parse(readFileSync(f.config)), f.foreign)
  } finally {
    if (held.process.exitCode === null && held.process.signalCode === null) { held.process.kill(); await held.exited }
  }
}))

test('configuration drift after the journal is prepared is retained as an explicit recovery conflict', () => fixture(async f => {
  const intercept = preload(f, 'drift')
  const result = f.command(f.request('connect'), { execArgv: [], env: { ...process.env, NODE_OPTIONS: `--import=${intercept.file}` } })
  assert.notEqual(result.status, 0)
  assert.ok((result.stderr + result.stdout).includes('RECOVERY_CONFLICT'))
  assert.equal(JSON.parse(readFileSync(f.config)).external, 'new foreign work')
  assert.ok(JSON.parse(readFileSync(f.control)).pending.step)
  assert.ok(!readFileSync(f.control, 'utf8').includes('NEVER_STAGE_SECRET'))
}))

test('a killed remove keeps its disable intent and a delayed auto finishes recovery without reinstalling', () => fixture(async f => {
  f.run(f.request('connect'))
  const delayed = f.request('auto', { seed: { disabled: false } })
  const intercept = preload(f, 'intent')
  const held = child(f, f.request('remove'), intercept)
  try {
    await waitFor(intercept.reached)
    assert.equal(JSON.parse(readFileSync(f.control)).disabled, true)
    held.process.kill('SIGKILL')
    await held.exited
    utimesSync(f.lock, new Date(0), new Date(0))
    const late = f.run(delayed)
    assert.equal(late.state.disabled, true)
    assert.equal(late.state.pending, undefined)
    assert.equal(late.result, null)
    assert.deepEqual(JSON.parse(readFileSync(f.config)), f.foreign)
  } finally {
    if (held.process.exitCode === null && held.process.signalCode === null) { held.process.kill(); await held.exited }
  }
}))

for (const phase of ['disable', 'intent']) test(`remove intent survives interruption ${phase === 'disable' ? 'before' : 'after'} recovering an older partial connect and retains its ownership`, () => fixture(async f => {
  const board = join(f.home, 'data-a', 'agent-board.mjs')
  const applied = preload(f, 'generated', { board })
  const original = child(f, f.request('connect'), applied)
  let removing
  try {
    await waitFor(applied.reached)
    original.process.kill('SIGKILL')
    await original.exited
    utimesSync(f.lock, new Date(0), new Date(0))
    const owned = JSON.parse(readFileSync(f.control)).owned
    assert.ok(Object.keys(owned).length > 0)
    const recovery = preload(f, phase)
    removing = child(f, f.request('remove', { progress: join(f.home, 'data-b', 'progress.md') }), recovery)
    await waitFor(recovery.reached)
    const interrupted = JSON.parse(readFileSync(f.control))
    assert.equal(interrupted.disabled, true)
    for (const [file, digest] of Object.entries(owned)) assert.equal(interrupted.owned[file], digest)
    if (phase === 'intent') assert.equal(interrupted.owned[board], createHash('sha256').update(readFileSync(board)).digest('hex'))
    removing.process.kill('SIGKILL')
    await removing.exited
    utimesSync(f.lock, new Date(0), new Date(0))
    const delayed = f.run(f.request('auto', { seed: { disabled: false } }))
    assert.equal(delayed.state.disabled, true)
    assert.equal(delayed.state.pending, undefined)
    assert.equal(delayed.result, null)
    assert.deepEqual(JSON.parse(readFileSync(f.config)), f.foreign)
    assert.equal(existsSync(join(f.home, 'data-a', 'agent-board.mjs')), false)
    const enabled = f.run(f.request('connect'))
    assert.equal(enabled.state.disabled, false)
    assert.ok(readFileSync(f.config, 'utf8').includes('progress-report.'))
  } finally {
    for (const held of [original, removing]) if (held && held.process.exitCode === null && held.process.signalCode === null) { held.process.kill('SIGKILL'); await held.exited }
  }
}))

for (const fault of ['drift', 'bundle']) test(`a remove before pending recovery retains disable intent on ${fault} without replaying connect`, () => fixture(async f => {
  const applied = preload(f, 'applied')
  const held = child(f, f.request('connect'), applied)
  try {
    await waitFor(applied.reached)
    held.process.kill('SIGKILL')
    await held.exited
    utimesSync(f.lock, new Date(0), new Date(0))
    const state = JSON.parse(readFileSync(f.control))
    if (fault === 'drift') writeFileSync(f.config, JSON.stringify({ ...f.foreign, external: 'new foreign work' }))
    else { state.pending.bundle = '0'.repeat(64); writeFileSync(f.control, JSON.stringify(state)) }
    const before = readFileSync(f.config, 'utf8')
    const removed = f.command(f.request('remove'))
    assert.notEqual(removed.status, 0)
    assert.ok((removed.stderr + removed.stdout).includes(fault === 'drift' ? 'RECOVERY_CONFLICT' : 'RECOVERY_BUNDLE_CHANGED'))
    const stopped = JSON.parse(readFileSync(f.control))
    assert.equal(stopped.disabled, true)
    assert.deepEqual(stopped.owned, state.owned)
    assert.ok(stopped.pending)
    assert.equal(readFileSync(f.config, 'utf8'), before)
    assert.notEqual(f.command(f.request('auto')).status, 0)
    assert.equal(JSON.parse(readFileSync(f.control)).disabled, true)
    assert.equal(readFileSync(f.config, 'utf8'), before)
  } finally {
    if (held.process.exitCode === null && held.process.signalCode === null) { held.process.kill('SIGKILL'); await held.exited }
  }
}))

test('initial native status migrates only recognized display metadata and ignores later SDK seeds', () => fixture(async f => {
  const setup = { agents: [{ agent: 'codex', label: 'Codex', hook: 'configured', board: 'ready', unknown: 'ignored' }], problems: [{ key: 'node:missing', message: 'setupNodeMissing', args: [18], unknown: 'ignored' }, { key: 'unknown', message: 'notAStringKey', args: [] }, { key: 'old', text: 'old unstructured prose' }], node: null, unknown: 'ignored' }
  const before = readFileSync(f.config, 'utf8')
  const initial = f.run(f.request('status', { seed: { setup } }))
  assert.deepEqual(JSON.parse(readFileSync(f.control)).setup, { agents: [{ agent: 'codex', label: 'Codex', hook: 'configured', board: 'ready' }], problems: [{ key: 'node:missing', message: 'setupNodeMissing', args: [18] }], node: null })
  assert.equal(initial.state.setup.codexTrusted, false)
  assert.ok(initial.state.setup.problems.some(one => one.key === 'codex:approval'))
  assert.equal(readFileSync(f.config, 'utf8'), before)
  assert.deepEqual(f.run(f.request('status', { seed: { setup: { agents: [], problems: [], node: process.version } } })).state.setup, initial.state.setup)
}))

test('native language preference at an explicit connect wins and delayed automatic seeds cannot revert it', () => fixture(async f => {
  f.run(f.request('connect', { seed: { boardLang: 'en' } }))
  const changed = f.run(f.request('connect', { boardLang: 'zh-TW' }))
  assert.equal(changed.state.boardLang, 'zh-TW')
  const delayed = f.run(f.request('auto', { seed: { boardLang: 'en' } }))
  assert.equal(delayed.state.boardLang, 'zh-TW')
  assert.ok(readFileSync(join(f.home, 'data-a', 'agent-board.mjs'), 'utf8').startsWith('globalThis.AGENT_BOARD = '))
  assert.ok(readFileSync(join(f.home, 'data-a', 'agent-board.mjs'), 'utf8').split('\n')[0].includes('zh-TW'))
}))

test('concurrent native connect and remove serialize their ownership and disable state', () => fixture(async f => {
  const first = child(f, f.request('connect'))
  const second = child(f, f.request('remove'))
  const results = await Promise.all([first.exited, second.exited])
  assert.equal(results[0][0], 0, first.output())
  assert.equal(results[1][0], 0, second.output())
  const state = JSON.parse(readFileSync(f.control))
  assert.equal(state.revision, 2)
  assert.equal(state.pending, undefined)
  const config = readFileSync(f.config, 'utf8')
  assert.equal(config.includes('progress-report.'), !state.disabled)
  assert.equal(JSON.parse(config).private, f.foreign.private)
}))

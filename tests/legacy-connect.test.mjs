import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { RELEASE_0_20_5 } from './fixtures/released.ts'

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

test('a malformed remembered Codex approval makes the connect state invalid', () => fixture(async f => {
  f.run(f.request('connect'))
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  for (const approval of [null, [], true, {}, { source: 'relative/hooks.json', sourceHash: 'a'.repeat(64) }, { source: f.config, sourceHash: 'A'.repeat(64) }, { source: f.config, sourceHash: 'a'.repeat(63) }, { source: f.config, sourceHash: 1 }, { source: f.config, sourceHash: 'a'.repeat(64), configHash: 'A'.repeat(64) }, { source: f.config, sourceHash: 'a'.repeat(64), configHash: 'a'.repeat(63) }, { source: f.config, sourceHash: 'a'.repeat(64), configHash: 1 }, ...[null, [], { path: 'relative/codex.exe', size: 1, mtime: 1 }, { path: f.config, size: -1, mtime: 1 }, { path: f.config, size: 1.5, mtime: 1 }, { path: f.config, size: 1, mtime: '1' }].map(binary => ({ source: f.config, sourceHash: 'a'.repeat(64), configHash: null, binary }))]) {
    writeFileSync(f.control, JSON.stringify({ ...state, codexApproval: approval }))
    const result = f.command(f.request('status'))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /INVALID_CONNECT_STATE/)
    assert.deepEqual(JSON.parse(readFileSync(f.control, 'utf8')).codexApproval, approval)
  }
}))

const dataRootHosts = f => {
  for (const dir of ['.gemini/antigravity', '.cursor', '.hermes', '.grok', '.config/opencode', '.config/muse', '.openclaw']) mkdirSync(join(f.home, dir), { recursive: true })
  const progress = join(f.home, '.claude', 'progress.md')
  f.run(f.request('connect', { progress, openclawVersion: '2026.10.1' }))
  return progress
}
// A board path with characters such as `~` (a Windows short name, as on CI runners) is written
// into skills and commands as code points; read those back before looking for a folder name.
const decoded = text => text.replace(/String\.fromCodePoint\(([\d,]+)\)/g, (_, codes) => String.fromCodePoint(...codes.split(',').map(Number)))
const snapshot = directory => Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name)
  return entry.isDirectory() ? Object.entries(snapshot(path)) : [[path, readFileSync(path, 'utf8')]]
}))

test("only a manual connect changes the machine's selected progress file", () => fixture(async f => {
  const progress = join(f.home, 'synced', 'progress.md')
  assert.equal(f.run(f.request('connect', { progress })).state.connectedProgress, progress)
  assert.equal(f.run(f.request('auto', { progress })).state.connectedProgress, progress)
  assert.equal(f.run(f.request('language', { boardLang: 'zh-TW' })).state.connectedProgress, progress)
  assert.equal(f.run(f.request('status')).state.connectedProgress, progress)
  const changed = f.run(f.request('connect'))
  assert.equal(changed.state.connectedProgress, f.progress)
  assert.equal(JSON.parse(readFileSync(f.control, 'utf8')).connectedProgress, f.progress)
}))

test('an automatic connect from a second data folder leaves hosts that report to another data folder alone and says so', () => fixture(async f => {
  dataRootHosts(f)
  const before = snapshot(f.home)
  const output = f.run(f.request('auto', { progress: join(f.home, 'other-root', 'progress.md') }))
  assert.deepEqual(snapshot(f.home), before)
  assert.ok(output.result.problems.some(problem => problem.message === 'connectOtherData'))
  assert.match(output.result.text, /connected to another Agent Board data folder/)
  assert.ok(!output.result.text.includes(f.home))
  assert.equal(output.result.done.length, 0)
}))

test('an automatic connect takes back hosts whose reporter was removed', () => fixture(async f => {
  const previous = dataRootHosts(f)
  const folder = join(f.home, '.claude')
  const oldBoard = readFileSync(join(folder, 'agent-board.mjs'), 'utf8')
  unlinkSync(join(folder, process.platform === 'win32' ? 'progress-report.ps1' : 'progress-report.sh'))
  const progress = join(f.home, 'other-root', 'progress.md')
  const output = f.run(f.request('auto', { progress, openclawVersion: '2026.10.1' }))
  assert.match(output.result.text, /Repaired connections whose reporting script was removed/)
  assert.ok(output.result.lines.findIndex(line => line.includes('Repaired connections')) < output.result.lines.length - 1)
  assert.equal(output.result.problems.some(problem => problem.message === 'connectOtherData' || problem.message === 'connectPreserved'), false)
  assert.ok(readFileSync(f.config, 'utf8').includes('other-root'))
  assert.ok(!readFileSync(f.config, 'utf8').includes('.claude'))
  assert.equal(readFileSync(join(folder, 'agent-board.mjs'), 'utf8'), oldBoard)
  assert.equal(output.state.owned[join(folder, 'agent-board.mjs')], undefined)
  assert.ok(Object.keys(output.state.owned).some(file => file.includes('other-root')))
  assert.notEqual(previous, progress)
}))

test('an automatic repair names every agent it moved back, with or without Codex', async () => {
  for (const hasCodex of [false, true]) await fixture(async f => {
    if (!hasCodex) rmSync(join(f.home, '.codex'), { recursive: true })
    for (const dir of ['.gemini', '.cursor']) mkdirSync(join(f.home, dir))
    const progress = join(f.home, 'test-root', 'progress.md')
    f.run(f.request('connect', { progress }))
    unlinkSync(join(f.home, 'test-root', process.platform === 'win32' ? 'progress-report.ps1' : 'progress-report.sh'))
    const output = f.run(f.request('auto', { progress: join(f.home, '.claude', 'progress.md') }))
    assert.deepEqual(new Set(output.result.done), new Set(['Gemini CLI', 'Cursor', ...(hasCodex ? ['Codex'] : [])]))
    assert.match(output.result.text, /Repaired connections/)
  })
})

test("a Hermes config saved with wrapped lines still counts as another data folder's", () => fixture(async f => {
  rmSync(join(f.home, '.codex'), { recursive: true })
  mkdirSync(join(f.home, '.hermes'))
  const progress = join(f.home, 'data home', 'progress.md')
  f.run(f.request('connect', { progress }))
  const config = join(f.home, '.hermes', 'config.yaml')
  const original = readFileSync(config, 'utf8')
  assert.ok(original.includes('data home'))
  writeFileSync(config, original.replaceAll('data home', 'data\n        home'))
  const before = snapshot(f.home)
  const output = f.run(f.request('auto'))
  assert.deepEqual(snapshot(f.home), before)
  assert.ok(output.result.problems.some(problem => problem.message === 'connectOtherData' && problem.args[0] === 'Hermes Agent'))
  assert.equal(output.result.done.length, 0)
}))

const plainHermes = root => `model: anthropic/claude-sonnet
hooks:
  post_llm_call:
  - command: sh '${root.replaceAll('\\', '/')}/progress-report.sh' hermes turn
`

test("a Hermes config re-saved in plain style still counts as another data folder's", () => fixture(async f => {
  rmSync(join(f.home, '.codex'), { recursive: true })
  mkdirSync(join(f.home, '.hermes'))
  const root = join(f.home, 'data home')
  f.run(f.request('connect', { progress: join(root, 'progress.md') }))
  rmSync(join(f.home, '.hermes', 'skills'), { recursive: true })
  writeFileSync(join(f.home, '.hermes', 'config.yaml'), plainHermes(root).replaceAll('data home', 'data\n        home'))
  const before = snapshot(f.home)
  const output = f.run(f.request('auto'))
  assert.deepEqual(snapshot(f.home), before)
  assert.deepEqual(output.result.problems.map(problem => problem.args), [['Hermes Agent']])
  assert.deepEqual(output.result.done, [])
}))

test("a Hermes config saved with escaped non-ASCII characters still counts as another data folder's", async () => {
  for (const newline of ['\n', '\r\n']) for (const hasPosixPath of [false, true]) await fixture(async f => {
    rmSync(join(f.home, '.codex'), { recursive: true })
    mkdirSync(join(f.home, '.hermes'))
    const root = join(f.home, 'José')
    f.run(f.request('connect', { progress: join(root, 'progress.md') }))
    rmSync(join(f.home, '.hermes', 'skills'), { recursive: true })
    const command = hasPosixPath
      ? `sh '${root.replaceAll('\\', '/')}/progress-report.sh' hermes turn`
      : `powershell -File "${join(root, 'progress-report.ps1')}" hermes turn`
    const scalar = JSON.stringify(command).replaceAll('é', '\\xE9').replace(' hermes', ` \\${newline}      hermes`)
    writeFileSync(join(f.home, '.hermes', 'config.yaml'), `hooks:${newline}  post_llm_call:${newline}  - command: ${scalar}${newline}`)
    const before = snapshot(f.home)
    const output = f.run(f.request('auto'))
    assert.deepEqual(snapshot(f.home), before)
    assert.deepEqual(output.result.problems.map(problem => problem.args), [['Hermes Agent']])
    assert.deepEqual(output.result.done, [])
  })
})

test("a Hermes config with an escaped non-breaking space still counts as another data folder's", () => fixture(async f => {
  rmSync(join(f.home, '.codex'), { recursive: true })
  mkdirSync(join(f.home, '.hermes'))
  const root = join(f.home, 'data\u00a0home')
  f.run(f.request('connect', { progress: join(root, 'progress.md') }))
  rmSync(join(f.home, '.hermes', 'skills'), { recursive: true })
  const scalar = JSON.stringify(`sh '${root.replaceAll('\\', '/')}/progress-report.sh' hermes turn`).replaceAll('\u00a0', '\\_')
  writeFileSync(join(f.home, '.hermes', 'config.yaml'), `hooks:\n  post_llm_call:\n  - command: ${scalar}\n`)
  const before = snapshot(f.home)
  const output = f.run(f.request('auto'))
  assert.deepEqual(snapshot(f.home), before)
  assert.deepEqual(output.result.problems.map(problem => problem.args), [['Hermes Agent']])
  assert.deepEqual(output.result.done, [])
}))

test('connect drops a conflicting unfinished removal from another live folder with the same bundle', () => fixture(async f => {
  const progress = dataRootHosts(f)
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  state.disabled = true
  state.pending = {
    request: f.request('remove', { progress }), bundle: createHash('sha256').update(bundle).digest('hex'),
    step: { file: f.config, before: '0'.repeat(64), after: '1'.repeat(64), generated: false },
  }
  writeFileSync(f.control, JSON.stringify(state))
  const other = snapshot(join(progress, '..'))
  const output = f.run(f.request('connect', { openclawVersion: '2026.10.1' }))
  assert.equal(output.state.pending, undefined)
  assert.equal(output.state.disabled, false)
  assert.deepEqual(snapshot(join(progress, '..')), other)
  assert.ok(readFileSync(f.config, 'utf8').includes('data-a'))
  assert.equal(f.run(f.request('connect')).state.pending, undefined)
}))

test("a busy file during recovery keeps another data folder's unfinished connection", () => fixture(async f => {
  const progress = dataRootHosts(f)
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  const file = join(f.home, '.claude', 'agent-board.mjs')
  state.disabled = true
  state.pending = {
    request: f.request('remove', { progress }), bundle: createHash('sha256').update(bundle).digest('hex'),
    step: { file, before: createHash('sha256').update(readFileSync(file)).digest('hex'), after: null, generated: true },
  }
  writeFileSync(f.control, JSON.stringify(state))
  const before = readFileSync(f.control, 'utf8')
  const other = snapshot(join(progress, '..'))
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const probe = join(f.home, `busy-${code}.cjs`)
    writeFileSync(probe, `const fs = require('node:fs'); const read = fs.readFileSync; fs.readFileSync = (path, ...args) => { if (path === ${JSON.stringify(file)}) throw Object.assign(new Error('${code}'), { code: '${code}' }); return read(path, ...args) }; require('node:module').syncBuiltinESMExports()`)
    const result = f.command(f.request('connect'), { env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(probe)}` } })
    assert.notEqual(result.status, 0, code)
    assert.ok((result.stderr + result.stdout).includes(`RECOVERY_UNREADABLE_${code}`), result.stderr)
    assert.equal(readFileSync(f.control, 'utf8'), before, code)
    assert.deepEqual(snapshot(join(progress, '..')), other)
  }
  assert.equal(f.run(f.request('connect')).state.pending, undefined)
}))

test("connection removal also drops another data folder's unfinished connection that cannot be replayed", () => fixture(async f => {
  const progress = dataRootHosts(f)
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  state.disabled = true
  state.pending = {
    request: f.request('remove', { progress }), bundle: createHash('sha256').update(bundle).digest('hex'),
    step: { file: f.config, before: '0'.repeat(64), after: '1'.repeat(64), generated: false },
  }
  writeFileSync(f.control, JSON.stringify(state))
  const other = snapshot(join(progress, '..'))
  const output = f.run(f.request('remove'))
  assert.equal(output.state.pending, undefined)
  assert.equal(output.state.disabled, true)
  assert.deepEqual(snapshot(join(progress, '..')), other)
  assert.deepEqual(JSON.parse(readFileSync(f.config, 'utf8')), f.foreign)
}))

test('acknowledgement preserves the checked Codex status without launching another probe', () => fixture(async f => {
  const initial = f.run(f.request('connect'))
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  state.setup.codexTrusted = true
  state.setup.problems = state.setup.problems.filter(problem => problem.key !== 'codex:approval')
  writeFileSync(f.control, JSON.stringify(state))
  const probe = join(f.home, 'probe.cjs')
  const marker = join(f.home, 'probe-ran')
  writeFileSync(probe, `const cp = require('node:child_process'); const original = cp.spawn; cp.spawn = (file, args, ...rest) => { if (file === process.execPath && args.includes('app-server')) require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n'); return original(file, args, ...rest) }; require('node:module').syncBuiltinESMExports()`)
  const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(probe)}` }
  const output = f.command(f.request('ack', { codexExecutable: process.execPath, acknowledgement: { revision: initial.state.revision, keys: [] } }), { env })
  assert.equal(output.status, 0, output.stderr)
  assert.equal(JSON.parse(output.stdout).state.setup.codexTrusted, true)
  assert.equal(JSON.parse(output.stdout).state.setup.problems.some(problem => problem.key === 'codex:approval'), false)
  assert.equal(existsSync(marker), false)
  assert.equal(f.command(f.request('status', { codexExecutable: process.execPath }), { env }).status, 0)
  assert.equal(readFileSync(marker, 'utf8'), 'called\ncalled\n')
}))

test('a YAML command with combined apostrophe quoting or non-JSON escapes keeps its board', async () => {
  for (const style of ['single', 'double']) await fixture(async f => {
    rmSync(join(f.home, '.codex'), { recursive: true })
    mkdirSync(join(f.home, '.hermes'))
    const root = join(f.home, "O'Brien")
    f.run(f.request('connect', { progress: join(root, 'progress.md') }))
    rmSync(join(f.home, '.hermes', 'skills'), { recursive: true })
    const command = `sh '${root.replaceAll('\\', '/').replaceAll("'", "'\\''")}/progress-report.sh' hermes turn`
    const scalar = style === 'single'
      ? `'${command.replaceAll("'", "''")}'`
      : `"env NOTE=\\x41 OTHER=\\U00000042 ${command}"`
    writeFileSync(join(f.home, '.hermes', 'config.yaml'), `hooks:\n  post_llm_call:\n  - command: ${scalar}\n`)
    const before = snapshot(f.home)
    const output = f.run(f.request('auto'))
    assert.deepEqual(snapshot(f.home), before)
    assert.deepEqual(output.result.problems.map(problem => problem.args), [['Hermes Agent']])
    assert.deepEqual(output.result.done, [])
  })
})

test('an ordinary update of our own Hermes hook does not claim a repair', () => fixture(async f => {
  rmSync(join(f.home, '.codex'), { recursive: true })
  mkdirSync(join(f.home, '.hermes'))
  f.run(f.request('connect'))
  writeFileSync(join(f.home, '.hermes', 'config.yaml'), plainHermes(join(f.home, 'data-a')))
  const output = f.run(f.request('auto'))
  assert.ok(output.result.done.includes('Hermes Agent'))
  assert.ok(!output.result.text.includes('Repaired connections'))
  assert.deepEqual(output.result.problems, [])
}))

test('a long setting line in a Hermes config does not block automatic connect', () => fixture(async f => {
  rmSync(join(f.home, '.codex'), { recursive: true })
  mkdirSync(join(f.home, '.hermes'))
  const root = join(f.home, 'deleted-board')
  f.run(f.request('connect', { progress: join(root, 'progress.md') }))
  const config = join(f.home, '.hermes', 'config.yaml')
  writeFileSync(config, `cwd: ${join(f.home, 'work').replaceAll('\\', '/')}\nsettings: ${'x'.repeat(300)}\n${plainHermes(root)}`)
  rmSync(root, { recursive: true })
  const output = f.run(f.request('auto'))
  assert.deepEqual(output.result.problems, [])
  assert.ok(output.result.done.includes('Hermes Agent'))
  assert.ok(readFileSync(config, 'utf8').includes('data-a'))
  assert.match(output.result.text, /Repaired connections/)
}))

test('once the other data folder is gone its warning leaves the connect status', () => fixture(async f => {
  const progress = dataRootHosts(f)
  const blocked = f.run(f.request('auto'))
  const keys = blocked.state.setup.problems.map(problem => problem.key)
  f.run(f.request('ack', { acknowledgement: { revision: blocked.state.revision, keys } }))
  const stored = JSON.parse(readFileSync(f.control, 'utf8'))
  assert.ok(stored.setup.problems.some(problem => problem.key.startsWith('otherData:')))
  stored.setup.problems.push({ key: 'checkUnreadable:Hermes Agent', message: 'connectCheckUnreadable', args: ['Hermes Agent'] })
  stored.setup.problems.push({ key: 'board:failed', message: 'connectBoardFailed', args: [] })
  writeFileSync(f.control, JSON.stringify(stored))
  rmSync(join(progress, '..'), { recursive: true })
  const before = snapshot(f.home)
  const status = f.run(f.request('status'))
  assert.deepEqual(snapshot(f.home), before)
  // Every host was connected from the folder that is now gone, so each board command names a
  // missing script (#251): status says so per host instead of repeating the stored "ready".
  assert.deepEqual(status.state.setup.agents, stored.setup.agents.map(agent => ({ ...agent, board: 'failed' })))
  assert.ok(status.state.setup.problems.some(problem => problem.key === 'missingBoard:codex'))
  assert.ok(status.state.setup.problems.some(problem => problem.key === 'board:failed'))
  assert.ok(status.state.setup.problems.some(problem => problem.key === 'codex:approval'))
  assert.equal(status.state.setup.problems.some(problem => /^(?:otherData|checkUnreadable):/.test(problem.key)), false)
}))

test("a blocked automatic connect still shows each agent's stored status", () => fixture(async f => {
  dataRootHosts(f)
  const stored = JSON.parse(readFileSync(f.control, 'utf8'))
  stored.setup.problems.push({ key: 'board:failed', message: 'connectBoardFailed', args: [] })
  writeFileSync(f.control, JSON.stringify(stored))
  const before = snapshot(f.home)
  const auto = f.run(f.request('auto'))
  const status = f.run(f.request('status'))
  assert.deepEqual(snapshot(f.home), before)
  for (const output of [auto, status]) {
    assert.deepEqual(output.state.setup.agents, stored.setup.agents)
    assert.ok(output.state.setup.problems.some(problem => problem.key === 'board:failed'))
    assert.ok(output.state.setup.problems.some(problem => problem.key === 'codex:approval'))
    assert.ok(output.state.setup.problems.some(problem => problem.message === 'connectOtherData'))
  }
  const keys = auto.state.setup.problems.map(problem => problem.key)
  f.run(f.request('ack', { acknowledgement: { revision: auto.state.revision, keys } }))
  const saved = JSON.parse(readFileSync(f.control, 'utf8'))
  assert.deepEqual(saved.setup.agents, stored.setup.agents)
  assert.ok(saved.setup.problems.some(problem => problem.key === 'board:failed'))
  assert.deepEqual(new Set(saved.notified), new Set(keys))
}))

test("choosing a language leaves another folder's unfinished connection alone", async () => {
  for (const disabled of [false, true]) await fixture(async f => {
    const progress = dataRootHosts(f)
    const stored = JSON.parse(readFileSync(f.control, 'utf8'))
    stored.disabled = disabled
    stored.pending = {
      request: f.request('connect', { progress }), bundle: createHash('sha256').update(bundle).digest('hex'),
      step: { file: f.config, before: '0'.repeat(64), after: '1'.repeat(64), generated: false },
    }
    writeFileSync(f.control, JSON.stringify(stored))
    const before = snapshot(f.home)
    const output = f.run(f.request('language', { boardLang: 'zh-TW' }))
    assert.deepEqual(output.state.pending, stored.pending)
    assert.deepEqual(output.state.owned, stored.owned)
    assert.equal(output.state.disabled, disabled)
    assert.equal(output.state.boardLang, 'zh-TW')
    assert.equal(output.state.revision, stored.revision + 1)
    delete before[f.control]
    const after = snapshot(f.home)
    delete after[f.control]
    assert.deepEqual(after, before)
  })
})

test('automatic connect ignores unreadable config paths for agents without an installed folder', () => fixture(async f => {
  writeFileSync(join(f.home, 'not-a-folder'), 'ordinary file')
  const output = f.run(f.request('auto', { dirs: { hermes: join(f.home, 'not-a-folder', 'hermes') } }))
  assert.ok(output.result.done.includes('Codex'))
  assert.ok(!output.result.problems.some(problem => problem.message === 'connectCheckUnreadable'))
}))

test('a shared board skill names only the installed agents that read it', () => fixture(async f => {
  mkdirSync(join(f.home, '.hermes'))
  f.run(f.request('connect'))
  const root = join(f.home, 'other-live')
  mkdirSync(root)
  writeFileSync(join(root, 'progress-report.sh'), 'synthetic reporter')
  writeFileSync(join(f.home, '.agents', 'skills', 'agent-board', 'SKILL.md'), `node "${join(root, 'agent-board.mjs')}"`)
  const before = snapshot(f.home)
  const output = f.run(f.request('auto'))
  assert.deepEqual(snapshot(f.home), before)
  const names = output.result.problems.filter(problem => problem.message === 'connectOtherData').map(problem => problem.args[0])
  assert.deepEqual(names, ['Codex'])
}))

test('an older released skill from a deleted data folder can be repaired without an ownership record', () => fixture(async f => {
  const root = join(f.home, 'old-root')
  f.run(f.request('connect', { progress: join(root, 'progress.md') }))
  const skill = join(f.home, '.agents', 'skills', 'agent-board', 'SKILL.md')
  const previous = RELEASE_0_20_5.skill[0].replaceAll('\0board\0', join(root, 'agent-board.mjs'))
  writeFileSync(skill, previous)
  unlinkSync(f.control)
  unlinkSync(join(f.home, '.agent-board', 'legacy-connect-authority'))
  unlinkSync(join(root, process.platform === 'win32' ? 'progress-report.ps1' : 'progress-report.sh'))
  const output = f.run(f.request('auto'))
  assert.ok(!output.result.problems.some(problem => problem.message === 'connectPreserved'))
  assert.notEqual(readFileSync(skill, 'utf8'), previous)
  assert.equal(output.state.owned[skill], createHash('sha256').update(readFileSync(skill)).digest('hex'))
  assert.match(output.result.text, /Repaired connections/)
}))

test('connect notices are not repeated at the next session start once acknowledged', () => fixture(async f => {
  dataRootHosts(f)
  const first = f.run(f.request('auto'))
  const keys = first.result.problems.map(problem => problem.key)
  assert.ok(keys.length > 0)
  f.run(f.request('ack', { acknowledgement: { revision: first.state.revision, keys } }))
  assert.deepEqual(JSON.parse(readFileSync(f.control, 'utf8')).notified, keys)
  const before = snapshot(f.home)
  const next = f.run(f.request('auto'))
  assert.deepEqual(next.result.problems.filter(problem => !next.state.notified.includes(problem.key)), [])
  assert.deepEqual(snapshot(f.home), before)
  assert.equal(next.result.lines.filter(line => line.startsWith('Gemini CLI ')).length, 1)
  assert.equal(next.result.lines.some(line => /^(?:skills|gemini|hermes) /.test(line)), false)
}))

test('automatic connect checks both Codex instruction files before changing any connection', async () => {
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) await fixture(async f => {
    const progress = join(f.home, 'other-root', 'progress.md')
    f.run(f.request('connect', { progress }))
    unlinkSync(f.config)
    rmSync(join(f.home, '.agents'), { recursive: true })
    const fallback = readFileSync(join(f.home, '.codex', 'AGENTS.md'), 'utf8')
    writeFileSync(join(f.home, '.codex', name), fallback)
    if (name !== 'AGENTS.md') unlinkSync(join(f.home, '.codex', 'AGENTS.md'))
    const before = snapshot(f.home)
    const output = f.run(f.request('auto'))
    assert.deepEqual(snapshot(f.home), before)
    assert.ok(output.result.problems.some(problem => problem.message === 'connectOtherData' && problem.args[0] === 'Codex'))
  })
})

test('automatic connect leaves every connection alone when an existing config cannot be read', () => fixture(async f => {
  mkdirSync(join(f.home, '.gemini'))
  mkdirSync(join(f.home, '.gemini', 'settings.json'))
  const before = snapshot(f.home)
  const output = f.run(f.request('auto'))
  assert.deepEqual(snapshot(f.home), before)
  assert.ok(output.result.problems.some(problem => problem.message === 'connectCheckUnreadable' && problem.args[0] === 'Gemini CLI'))
  assert.ok(!output.result.text.includes(f.home))
}))

test('a journal from a deleted data folder does not prevent automatic repair or replay a conflicting step', async () => {
  for (const isDisabled of [false, true]) await fixture(async f => {
    const progress = dataRootHosts(f)
    const state = JSON.parse(readFileSync(f.control, 'utf8'))
    state.disabled = isDisabled
    state.pending = {
      request: f.request('connect', { progress }), bundle: createHash('sha256').update(bundle).digest('hex'),
      step: { file: f.config, before: '0'.repeat(64), after: '1'.repeat(64), generated: false },
    }
    writeFileSync(f.control, JSON.stringify(state))
    rmSync(join(f.home, '.claude'), { recursive: true })
    const output = f.run(f.request('auto', { openclawVersion: '2026.10.1' }))
    assert.equal(output.state.pending, undefined)
    if (isDisabled) assert.equal(output.result, null)
    else assert.ok(output.result.done.includes('Gemini CLI'))
    assert.equal(existsSync(join(f.home, '.claude')), false)
  })
})

test('a pending connection in another live folder has one plain notice', () => fixture(async f => {
  const progress = join(f.home, 'other-live', 'progress.md')
  mkdirSync(join(f.home, 'other-live'))
  f.run(f.request('language', { boardLang: 'en' }))
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  state.pending = { request: f.request('connect', { progress }), bundle: createHash('sha256').update(bundle).digest('hex') }
  writeFileSync(f.control, JSON.stringify(state))
  const before = snapshot(f.home)
  const output = f.run(f.request('auto'))
  assert.deepEqual(snapshot(f.home), before)
  assert.deepEqual(output.result.problems.map(problem => problem.message), ['connectOtherRecovery'])
  assert.match(output.result.text, /unfinished connection from another/)
  f.run(f.request('ack', { acknowledgement: { revision: output.state.revision, keys: ['otherData:recovery'] } }))
  assert.deepEqual(f.run(f.request('auto')).state.notified, ['otherData:recovery'])
}))

test('an independent board command left in a config does not announce a repair', () => fixture(async f => {
  const board = join(f.home, '.agent-board', 'agent-board.mjs')
  writeFileSync(f.config, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${board}"` }] }] } }))
  const output = f.run(f.request('auto'))
  assert.ok(output.result.done.includes('Codex'))
  assert.ok(!output.result.text.includes('Repaired connections'))
  assert.ok(readFileSync(f.config, 'utf8').includes('agent-board.mjs'))
}))

test('a generated connection from another language can move without an ownership record', () => fixture(async f => {
  mkdirSync(join(f.home, '.grok'))
  writeFileSync(join(f.home, '.grok', 'config.toml'), '')
  const progress = join(f.home, 'other-root', 'progress.md')
  f.run(f.request('connect', { progress, lang: 'zh-TW', boardLang: 'zh-TW' }))
  unlinkSync(f.control)
  unlinkSync(join(f.home, '.agent-board', 'legacy-connect-authority'))
  const output = f.run(f.request('connect', { lang: 'en', boardLang: 'en' }))
  assert.equal(output.result.problems.some(problem => problem.message === 'connectPreserved'), false)
  assert.ok(readFileSync(join(f.home, '.grok', 'hooks', 'agent-board.json'), 'utf8').includes('data-a'))
}))

test('connecting by hand from a second data folder moves the hosts and says so', () => fixture(async f => {
  dataRootHosts(f)
  const output = f.run(f.request('connect', { progress: join(f.home, 'other-root', 'progress.md'), openclawVersion: '2026.10.1' }))
  assert.match(output.result.text, /These agents now report to this board/)
  assert.equal(output.result.problems.some(problem => problem.message === 'connectOtherData' || problem.message === 'connectPreserved'), false)
  for (const path of [f.config, join(f.home, '.gemini/settings.json'), join(f.home, '.cursor/hooks.json'), join(f.home, '.hermes/config.yaml'), join(f.home, '.agents/skills/agent-board/SKILL.md'), join(f.home, '.gemini/commands/board.toml')]) {
    assert.ok(decoded(readFileSync(path, 'utf8')).includes('other-root'), path)
  }
}))

test('an automatic connect preserves a foreign encoded board command without a hook or ownership record', () => fixture(async f => {
  f.run(f.request('connect', { progress: join(f.home, 'data $資料', 'progress.md') }))
  unlinkSync(f.config)
  unlinkSync(f.control)
  unlinkSync(join(f.home, '.agent-board', 'legacy-connect-authority'))
  const before = snapshot(f.home)
  const output = f.run(f.request('auto'))
  assert.deepEqual(snapshot(f.home), before)
  assert.ok(output.result.problems.some(problem => problem.message === 'connectOtherData'))
  assert.equal(existsSync(f.control), false)
}))

test('connecting by hand supersedes another data folder journal without rewriting that folder', () => fixture(async f => {
  const progress = dataRootHosts(f)
  unlinkSync(join(f.home, '.claude', process.platform === 'win32' ? 'progress-report.ps1' : 'progress-report.sh'))
  const previous = snapshot(join(f.home, '.claude'))
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  state.pending = { request: f.request('connect', { progress }), bundle: createHash('sha256').update(bundle).digest('hex') }
  writeFileSync(f.control, JSON.stringify(state))
  const skipped = f.run(f.request('auto'))
  assert.ok(skipped.state.pending)
  assert.deepEqual(snapshot(join(f.home, '.claude')), previous)
  const output = f.run(f.request('connect'))
  assert.equal(output.state.pending, undefined)
  assert.deepEqual(snapshot(join(f.home, '.claude')), previous)
  assert.ok(readFileSync(f.config, 'utf8').includes('data-a'))
}))

test("connect from a crashed removal with another plugin version drops the other folder's unfinished connection", () => fixture(async f => {
  const progress = dataRootHosts(f)
  const previous = snapshot(join(f.home, '.claude'))
  const state = JSON.parse(readFileSync(f.control, 'utf8'))
  state.disabled = true
  state.pending = {
    request: f.request('remove', { progress }), bundle: '0'.repeat(64),
    step: { file: join(f.home, '.claude', 'agent-board.mjs'), before: '0'.repeat(64), after: null, generated: true },
  }
  writeFileSync(f.control, JSON.stringify(state))
  const output = f.run(f.request('connect', { openclawVersion: '2026.10.1' }))
  assert.equal(output.state.pending, undefined)
  assert.equal(output.state.disabled, false)
  assert.deepEqual(snapshot(join(f.home, '.claude')), previous)
  assert.ok(readFileSync(f.config, 'utf8').includes('data-a'))
}))
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
  assert.ok(!existsSync(join(f.home, 'data-a', 'agent-board.mjs')), JSON.stringify(removed.result.problems))
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

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks } from 'node:module'
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { availableParallelism, constants, setPriority, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { formatWriter } from './e2e/lib/faults.mjs'
import { reporterPs1, reporterSh } from '../hooks/hook-reporters.ts'
import { hookBootstrap, hookGuardSource, hookWorker } from '../hooks/hook-safety.ts'
import { classifierDiagnostic, observeClassifier } from './fixtures/classifier-diagnostic.mjs'
import { assertNativeProbeReturned, nativeProbeDiagnostic } from './fixtures/native-probe-diagnostic.mjs'
import { withDeniedCreation } from './fixtures/windows-create-denied.mjs'
import { generatedHookCommand } from './fixtures/generated-hook-command.mjs'
import { assertClassifierExited, observeClassifierExit } from './fixtures/classifier-exit-proof.mjs'

test('native cleanup diagnostics keep watchdog failures bounded and private', () => {
  const error = Object.assign(new Error('PRIVATE_ERROR'), { code: 'ETIMEDOUT', path: '/PRIVATE_EXECUTABLE', spawnargs: ['PRIVATE_ARGUMENT'] })
  const result = { error, status: null, signal: 'SIGTERM', stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR' }
  const marker = { isStarted: true, isVerified: true, keepFixture: true, code: 'NATIVE_HOOK_UNREAPED', home: '/PRIVATE_HOME', pid: 123456789 }
  assert.throws(() => assertNativeProbeReturned(result, marker, 45001.4, 45000), failure => {
    assert.equal(failure.code, 'ERR_ASSERTION')
    assert.match(failure.message, /"errorCode":"ETIMEDOUT"/)
    assert.match(failure.message, /"isVerified":true/)
    assert.match(failure.message, /"elapsedMs":45001,"budgetMs":45000/)
    assert.equal(failure.actual, false)
    assert.equal(failure.expected, true)
    assert.ok(!/PRIVATE_|123456789/.test(inspect(failure)))
    assert.ok(failure.message.length < 512)
    return true
  })
  for (const error of [null, false, '']) assert.throws(() => assertNativeProbeReturned({ error }, null, 1, 45000), { code: 'ERR_ASSERTION' })
})

test('native cleanup diagnostics preserve a normal returned probe result', () => {
  const result = { status: 1, signal: null, stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR' }
  const marker = { isStarted: true, isVerified: true, keepFixture: true, code: 'NATIVE_HOOK_UNREAPED' }
  const before = structuredClone({ result, marker })
  const diagnostic = assertNativeProbeReturned(result, marker, 2500, 45000)
  assert.deepEqual({ result, marker }, before)
  assert.match(diagnostic, /"status":1,"signal":null,"errorPresent":false,"errorCode":null/)
  assert.match(diagnostic, /"markerPresent":true,"isStarted":true,"isVerified":true/)
  assert.ok(!diagnostic.includes('PRIVATE_'))
})

test('native cleanup diagnostics allowlist unknown fields and missing markers', () => {
  const privateValue = 'PRIVATE_'.repeat(1000)
  const diagnostic = nativeProbeDiagnostic({ status: privateValue, signal: privateValue, error: { code: privateValue } }, { isStarted: privateValue, isVerified: privateValue, code: privateValue }, Infinity, -1)
  assert.ok(diagnostic.length < 512)
  assert.ok(!diagnostic.includes('PRIVATE_'))
  assert.match(diagnostic, /"elapsedMs":null,"budgetMs":0,"status":null,"signal":"OTHER"/)
  assert.match(diagnostic, /"isStarted":null,"isVerified":null,"keepFixture":null,"code":"OTHER"/)
  assert.match(nativeProbeDiagnostic({}, null, 0, 45000), /"markerPresent":false/)
})

const setup = resolve('scripts/setup-codex.mjs')
const session = 'test-codex-session-123'
// A runner may set XDG/host overrides. No synthetic home may inherit those and
// write into another test or the account's actual native configuration.
const isolatedEnv = home => ({
  ...process.env, HOME: home, USERPROFILE: home,
  LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
  CLAUDE_PROGRESS_FILE: '', CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CODEX_HOME: join(home, '.codex'), GROK_HOME: join(home, '.grok'), HERMES_HOME: join(home, '.hermes'),
  XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
  OPENCLAW_STATE_DIR: join(home, '.openclaw'), DSH_HOME: join(home, '.dsh'),
})
// A synchronous timeout kills cmd alone on Windows, leaving PowerShell/Node writing into
// the fixture during cleanup. Wait for closed stdio and terminate only this owned tree.
const stopNativeTree = child => {
  if (process.platform === 'win32') {
    const killed = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    return { status: killed.status, code: killed.error?.code, stderr: killed.stderr }
  }
  try { process.kill(-child.pid, 'SIGKILL'); return { status: 0 } } catch (error) {
    return { status: error.code === 'ESRCH' ? 0 : 1, code: error.code }
  }
}

const nativeProcess = (executable, args, env, input, after = setTimeout, stop = stopNativeTree, { isInputOpen = false, ...options } = {}) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, {
    env, ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  })
  let stdout = '', stderr = '', error, termination
  let isClosed = false, isTimedOut = false
  let grace, notifyClosed
  const whenClosed = new Promise(done => { notifyClosed = done })
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.on('error', failure => { error ??= failure })
  child.stdin.on('error', failure => { error ??= failure })
  const timer = after(() => {
    if (isClosed || isTimedOut || child.pid === undefined) return
    isTimedOut = true
    error = Object.assign(new Error('native hook exceeded its deadline'), { code: 'ETIMEDOUT' })
    try { termination = stop(child) } catch (failure) { termination = { status: null, code: failure.code, message: failure.message } }
    grace = setTimeout(() => {
      if (isClosed) return
      // An OS refusal cannot prove the descendants exited. Keep their fixture and
      // report the owned PID rather than hanging or deleting files they may use.
      const failure = Object.assign(new Error(`Native hook tree ${child.pid} did not close; fixture retained; ${JSON.stringify(termination)}`), { code: 'NATIVE_HOOK_UNREAPED', keepFixture: true, pid: child.pid, termination, whenClosed })
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      reject(failure)
    }, 2000)
  }, 30000)
  child.once('close', (status, signal) => {
    isClosed = true
    clearTimeout(timer)
    clearTimeout(grace)
    child.stdin.destroy()
    notifyClosed({ status, signal })
    resolve({ status, signal, error, termination, stdout, stderr })
  })
  if (isInputOpen) child.stdin.write(input)
  else child.stdin.end(input)
})

const nativeHook = (command, env, input, after = setTimeout, stop = stopNativeTree) => {
  const isWin = process.platform === 'win32'
  return nativeProcess(isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', [isWin ? '/c' : '-c', command], env, JSON.stringify(input), after, stop)
}

const fireCommand = (f, command, input, limit = 10000, after = callback => setTimeout(callback, limit)) => {
  const isWindows = process.platform === 'win32'
  return nativeProcess(isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', isWindows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command], f.env, input,
    after, stopNativeTree, { windowsVerbatimArguments: isWindows })
}
const fireHook = (f, input, limit, after) => fireCommand(f, JSON.parse(readFileSync(f.hooks, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command, input, limit, after)

const hookLog = f => existsSync(join(f.root, 'hook-errors.log')) ? readFileSync(join(f.root, 'hook-errors.log'), 'utf8') : ''

const hookFailure = result => JSON.stringify({ status: result.status, signal: result.signal, error: result.error && { code: result.error.code, message: result.error.message }, termination: result.termination, stdout: result.stdout, stderr: result.stderr })

// Windows soon hands a freed pid to another process, so a pid this test has seen
// exit is never stopped by number afterwards. Tests in this file run one at a time.
const exitedPids = new Set()
beforeEach(() => exitedPids.clear())
// These synthetic reporters are grandchildren, so wait for their recorded PID
// as well as the command's pipes before allowing fixture removal after a failure.
const isReporterAlive = pid => {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') {
      exitedPids.add(pid)
      return false
    }
    if (error.code === 'EPERM') return true
    throw error
  }
}
const stopReporter = async pid => {
  if (!Number.isInteger(pid) || pid <= 0 || exitedPids.has(pid) || !isReporterAlive(pid)) return
  let termination
  if (process.platform === 'win32') termination = stopNativeTree({ pid })
  else {
    try { process.kill(pid, 'SIGKILL'); termination = { status: 0 } }
    catch (error) { termination = { status: error.code === 'ESRCH' ? 0 : 1, code: error.code } }
  }
  const until = Date.now() + 5000
  while (isReporterAlive(pid) && Date.now() < until) await new Promise(done => setTimeout(done, 25))
  if (isReporterAlive(pid)) throw Object.assign(new Error(`Synthetic reporter ${pid} did not exit; fixture retained; ${JSON.stringify(termination)}`), { keepFixture: true, pid, termination })
}

const removeFixtureDirectory = (directory, prefix) => {
  const target = resolve(directory), temporary = resolve(tmpdir())
  assert.equal(dirname(target), temporary)
  assert.ok(target.startsWith(join(temporary, prefix)), 'remove only this owned synthetic fixture')
  rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
}

// A folder Windows held open is skipped for the rest of the run, so one stuck
// folder costs one retry and one line, not one per fixture.
const keptFixtureDirectories = new Set()
const sweepFixtureDirectories = () => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000
  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!entry.name.startsWith('codex local-') || !entry.isDirectory() || keptFixtureDirectories.has(entry.name)) continue
    const directory = join(tmpdir(), entry.name)
    try {
      const stat = lstatSync(directory)
      if (stat.isDirectory() && stat.mtimeMs < cutoff) removeFixtureDirectory(directory, 'codex local-')
    } catch (error) {
      // Another fixture may finish between the directory listing and the sweep, and
      // a folder Windows still holds open is left for a later run, not a failed test.
      if (error.code === 'ENOENT') continue
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error
      keptFixtureDirectories.add(entry.name)
      process.stderr.write(`codex-local fixture: left an old temporary folder (${error.code})\n`)
    }
  }
}

const fixture = async fn => {
  sweepFixtureDirectories()
  const home = mkdtempSync(join(tmpdir(), 'codex local-'))
  const root = join(home, '.agent-board')
  const script = join(root, 'agent-board.mjs')
  const progress = join(root, 'progress.md')
  const hooks = join(home, '.codex', 'hooks.json')
  const skill = join(home, '.agents', 'skills', 'agent-board', 'SKILL.md')
  const env = { ...isolatedEnv(home), CODEX_THREAD_ID: session, NO_COLOR: '1' }
  const run = (file, args, input, extraEnv = {}) => spawnSync(process.execPath, [file, ...args], { env: { ...env, ...extraEnv }, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const isolated = ['--home', home, '--codex-dir', join(home, '.codex'), '--grok-dir', join(home, '.grok'), '--hermes-dir', join(home, '.hermes')]
  const install = (...args) => run(setup, [...isolated, ...args])
  const command = (args, input, extraEnv = {}) => run(script, [...isolated, ...args], input, extraEnv)
  const save = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
  const report = (state = 'working', steps = ['- [~] Real task']) => command(['--codex-report'], { title: 'Task', state, steps })
  const event = (name, turn = 'turn-1', extra = {}, extraEnv = {}) => command(['--codex-event'], { session_id: session, hook_event_name: name, turn_id: turn, ...extra }, extraEnv)
  let isSafeToRemove = true
  try { return await fn({ home, root, script, progress, hooks, skill, env, install, command, save, report, event }) }
  catch (error) {
    if (error.keepFixture) {
      isSafeToRemove = false
      error.message += ` (${home})`
      process.stderr.write(`${error.message}\n`)
      if (process.platform === 'win32' && error.code === 'NATIVE_HOOK_UNREAPED') {
        // Destroyed Windows pipes can still keep node:test alive. Report the retained
        // fixture, then fail this test process even when those handles never close.
        process.exitCode = 1
        setTimeout(() => process.exit(1), 250).unref()
      }
    }
    throw error
  }
  // Native hook assertions have finished, but Windows scanners can briefly hold
  // the fixture's files. Retry only removal of this exact mkdtemp directory;
  // persistent cleanup failures still fail the test.
  finally { if (isSafeToRemove) rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
}

test('the codex-local fixture removes its own prefix\'s folders older than six hours and keeps newer ones', async () => {
  const older = mkdtempSync(join(tmpdir(), 'codex local-'))
  const newer = mkdtempSync(join(tmpdir(), 'codex local-'))
  const foreign = mkdtempSync(join(tmpdir(), 'foreign-local-'))
  const file = join(tmpdir(), `codex local-file-${process.pid}`)
  try {
    writeFileSync(join(older, 'stale.txt'), 'interrupted fixture')
    writeFileSync(join(newer, 'active.txt'), 'another run')
    writeFileSync(file, 'not a directory')
    const now = Date.now(), sixHours = 6 * 60 * 60 * 1000
    const old = new Date(now - sixHours - 60000), recent = new Date(now - sixHours + 60000)
    for (const path of [older, foreign, file]) utimesSync(path, old, old)
    utimesSync(newer, recent, recent)
    await fixture(f => {
      assert.ok(existsSync(f.home))
      assert.equal(existsSync(older), false)
      assert.equal(readFileSync(join(newer, 'active.txt'), 'utf8'), 'another run')
      assert.ok(existsSync(foreign))
      assert.equal(readFileSync(file, 'utf8'), 'not a directory')
    })
  } finally {
    for (const directory of [older, newer]) removeFixtureDirectory(directory, 'codex local-')
    removeFixtureDirectory(foreign, 'foreign-local-')
    if (existsSync(file)) unlinkSync(file)
  }
})

test('local setup leaves an openclaw.json holding an id past 2^53 untouched and reports the conflict', () => fixture(f => {
  const file = join(f.home, '.openclaw', 'openclaw.json')
  const original = '{"channels":{"telegram":{"id":1234567890123456789}}}\n'
  f.save(file, original)
  const result = f.install('--agent', 'openclaw', '--apply')
  assert.notEqual(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(file), Buffer.from(original))
  assert.ok(JSON.parse(result.stdout).conflicts.includes(file), result.stdout)
  assert.equal(existsSync(f.root), false)
  assert.equal(existsSync(f.skill), false)
}))

test('local setup leaves a hooks.json holding an id past 2^53 untouched and reports the conflict', () => fixture(f => {
  const original = '{"id":1234567890123456789,"hooks":{}}\n'
  f.save(f.hooks, original)
  const result = f.install('--apply')
  assert.notEqual(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(f.hooks), Buffer.from(original))
  assert.ok(JSON.parse(result.stdout).conflicts.includes(f.hooks), result.stdout)
  assert.equal(existsSync(f.root), false)
  assert.equal(existsSync(f.skill), false)
}))

test('local removal leaves native configs holding ids past 2^53 untouched and reports conflicts', () => fixture(f => {
  for (const [agent, relative] of [
    ['codex', ['.codex', 'hooks.json']],
    ['cursor', ['.cursor', 'hooks.json']],
    ['gemini', ['.gemini', 'settings.json']],
    ['grok', ['.grok', 'hooks', 'agent-board-local.json']],
    ['muse', ['.config', 'muse', 'settings.json']],
    ['antigravity', ['.gemini', 'config', 'hooks.json']],
    ['openclaw', ['.openclaw', 'openclaw.json']],
  ]) {
    const file = join(f.home, ...relative)
    const original = '{"id":1234567890123456789}\n'
    f.save(file, original)
    const setup = f.install('--agent', agent, '--apply')
    assert.notEqual(setup.status, 0, agent)
    assert.ok(JSON.parse(setup.stdout).conflicts.includes(file), setup.stdout)
    assert.deepEqual(readFileSync(file), Buffer.from(original), agent)

    f.save(file, '{}')
    const installed = f.install('--agent', agent, '--apply')
    assert.equal(installed.status, 0, installed.stderr)
    const unsafe = readFileSync(file, 'utf8').replace('{', '{"id":1234567890123456789,')
    f.save(file, unsafe)
    const manifest = join(f.root, `install-${agent}.json`)
    const before = [file, manifest, f.script, f.skill, f.progress].map(path => [path, readFileSync(path)])
    const removed = f.command(['--codex-remove', '--agent', agent, '--apply'])
    assert.notEqual(removed.status, 0, agent)
    assert.ok(JSON.parse(removed.stdout).conflicts.includes(file), removed.stdout)
    // The unreadable config is one conflict; its owned groups are not also reported as edited.
    assert.deepEqual(JSON.parse(removed.stdout).conflicts.filter(one => one.startsWith(file)), [file], agent)
    for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes, path)
  }
}))

test('local setup reports a config that is not valid JSON as one conflict and leaves it untouched', () => fixture(f => {
  const file = join(f.home, '.openclaw', 'openclaw.json')
  const original = '{"hooks":'
  f.save(file, original)
  const preview = f.install('--agent', 'openclaw')
  assert.equal(preview.status, 0, preview.stderr)
  assert.deepEqual(JSON.parse(preview.stdout).conflicts.filter(one => one.startsWith(file)), [file], preview.stdout)
  const result = f.install('--agent', 'openclaw', '--apply')
  assert.notEqual(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(file), Buffer.from(original))
  assert.equal(existsSync(f.root), false)
}))

test('setup accepts a UTF-8 BOM in existing Codex hooks without losing foreign data', () => fixture(f => {
  const foreign = { hooks: [{ type: 'command', command: 'echo other' }] }
  const original = Buffer.from(`\uFEFF${JSON.stringify({ other: { keep: true }, hooks: { Stop: [foreign] } }, null, 2).replaceAll('\n', '\r\n')}\r\n`)
  const progress = Buffer.from('selected progress stays exact\r\n')
  const credentials = join(f.home, '.codex', 'auth.json')
  const credentialBytes = Buffer.from('{"synthetic":"credential stays exact"}\r\n')
  f.save(f.hooks, original)
  f.save(f.progress, progress)
  f.save(credentials, credentialBytes)

  const preview = f.install()
  assert.equal(preview.status, 0, preview.stderr)
  assert.deepEqual(readFileSync(f.hooks), original)
  assert.deepEqual(readFileSync(f.progress), progress)
  assert.deepEqual(readFileSync(credentials), credentialBytes)

  const applied = f.install('--apply')
  assert.equal(applied.status, 0, applied.stderr)
  const configured = JSON.parse(readFileSync(f.hooks))
  assert.deepEqual(configured.other, { keep: true })
  assert.deepEqual(configured.hooks.Stop[0], foreign)
  assert.deepEqual(readFileSync(f.progress), progress)
  assert.deepEqual(readFileSync(credentials), credentialBytes)

  const installed = readFileSync(f.hooks)
  const reinstalled = f.install('--apply')
  assert.equal(reinstalled.status, 0, reinstalled.stderr)
  assert.deepEqual(readFileSync(f.hooks), installed)
  assert.deepEqual(readFileSync(f.progress), progress)
  assert.deepEqual(readFileSync(credentials), credentialBytes)

  const removed = f.command(['--codex-remove', '--apply'])
  assert.equal(removed.status, 0, removed.stderr)
  assert.deepEqual(JSON.parse(readFileSync(f.hooks)), { other: { keep: true }, hooks: { Stop: [foreign] } })
  assert.deepEqual(readFileSync(f.progress), progress)
  assert.deepEqual(readFileSync(credentials), credentialBytes)
}))

test('setup preserves malformed BOM-prefixed Codex hooks when it refuses installation', () => fixture(f => {
  const original = Buffer.from('\uFEFF{"hooks":\r\n')
  f.save(f.hooks, original)
  const preview = f.install()
  assert.equal(preview.status, 0, preview.stderr)
  assert.deepEqual(JSON.parse(preview.stdout).conflicts.filter(one => one.startsWith(f.hooks)), [f.hooks], preview.stdout)
  assert.deepEqual(readFileSync(f.hooks), original)

  const applied = f.install('--apply')
  assert.notEqual(applied.status, 0, applied.stderr)
  assert.deepEqual(JSON.parse(applied.stdout).conflicts.filter(one => one.startsWith(f.hooks)), [f.hooks], applied.stdout)
  assert.deepEqual(readFileSync(f.hooks), original)
  assert.equal(existsSync(f.root), false)
}))

const setupAgent = (f, ...args) => spawnSync(process.execPath, [resolve('scripts/setup-agent.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), ...args], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000 })

test('setup on a computer with only Claude Code prints guidance and exits 0 without a stack trace', () => fixture(f => {
  mkdirSync(join(f.home, '.claude'))
  const english = { ...f, env: { ...f.env, LANG: '' } }
  const guidance = setupAgent(english)
  assert.equal(guidance.status, 0, guidance.stderr)
  assert.equal(guidance.stderr, '')
  assert.equal(guidance.stdout.trim().split('\n').length, 1)
  for (const text of ['Claude Code', 'claude plugin marketplace add WenyuChiou/agent-board', 'claude plugin install agent-board@agent-board']) assert.ok(guidance.stdout.includes(text))
  assert.doesNotMatch(guidance.stdout, /    at |INVALID_TARGETS/)
  for (const args of [['--json'], ['--apply'], ['--apply', '--json']]) {
    const result = setupAgent(english, ...args)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    if (args.includes('--json')) assert.deepEqual(JSON.parse(result.stdout), { targets: [], plans: [], applied: false })
    else assert.equal(result.stdout, guidance.stdout)
  }
  const traditional = setupAgent(english, '--lang', 'zh-TW')
  assert.equal(traditional.status, 0, traditional.stderr)
  assert.equal(traditional.stderr, '')
  assert.ok(traditional.stdout.includes('這台電腦只找到 Claude Code'))
  assert.deepEqual(readdirSync(f.home), ['.claude'])
}))

test('setup on a computer with Claude Code and Codex previews Codex only', async () => {
  await fixture(f => {
    mkdirSync(join(f.home, '.claude'))
    mkdirSync(join(f.home, '.codex'))
    const result = setupAgent(f)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout).targets, ['codex'])
    assert.equal(existsSync(f.root), false)
  })
  await fixture(f => {
    const result = setupAgent(f, '--lang', 'en')
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.trim().split('\n').length, 1)
    assert.match(result.stderr, /found no agent/)
  })
})

const setupErrorCases = async check => {
  for (const [args, code, cause] of [
    [[], 'INVALID_TARGETS'],
    [['--agent', 'bogus'], 'INVALID_TARGETS'],
    [['--agent'], 'MISSING_ARGUMENT'],
    [['--agent', 'codex', '--data-dir'], 'SETUP_FAILED', 'MISSING_ARGUMENT'],
  ]) await fixture(f => check(f, (...extra) => setupAgent(f, '--lang', 'en', ...extra, ...args), { code, cause, isEmpty: !cause }))
  await fixture(f => {
    f.save(f.hooks, '{"hooks":')
    check(f, (...extra) => setupAgent(f, '--lang', 'en', '--agent', 'codex', ...extra), { conflict: f.hooks })
  })
  await fixture(f => {
    const installed = setupAgent(f, '--agent', 'codex', '--apply', '--progress-file', join(f.home, 'a', 'progress.md'))
    assert.equal(installed.status, 0, installed.stderr)
    check(f, (...extra) => setupAgent(f, '--lang', 'en', '--agent', 'cursor', '--apply', '--progress-file', join(f.home, 'b', 'progress.md'), ...extra), { code: 'SETUP_FAILED', cause: 'SHARED_BOARD_PATH_CONFLICT', agent: 'cursor' })
  })
  await fixture(f => {
    assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
    check(f, (...extra) => f.command(['--codex-trust', '--lang', 'en', ...extra]), { code: 'OWNED_CODEX_INSTALL_REQUIRED' })
    assert.equal(f.install('--apply').status, 0)
    check(f, (...extra) => f.command(['--codex-trust', '--lang', 'en', ...extra]), { code: 'CODEX_BINARY_REQUIRED' })
  })
  for (const record of ['{', '[]', '{"files":[]}', '{"groups":"x"}']) await fixture(f => {
    assert.equal(f.install('--apply').status, 0)
    f.save(join(f.root, 'install-codex.json'), record)
    check(f, (...extra) => f.install('--agent', 'codex', '--lang', 'en', ...extra), { code: 'INVALID_INSTALL_RECORD', message: 'agent-board: setup cannot read install-codex.json, its own record of an earlier setup, so it left everything as it was. Move that file out of the folder where setup keeps its data, then run setup again.' })
  })
  await fixture(f => {
    assert.equal(f.install('--apply').status, 0)
    f.save(join(f.root, 'install-cursor.json'), '{')
    check(f, (...extra) => f.install('--agent', 'codex', '--lang', 'en', ...extra), { code: 'INVALID_INSTALL_RECORD', message: 'agent-board: setup cannot read install-cursor.json, its own record of an earlier setup, so it left everything as it was. Move that file out of the folder where setup keeps its data, then run setup again.' })
  })
  await fixture(f => {
    mkdirSync(join(f.root, 'install-codex.json'), { recursive: true })
    check(f, (...extra) => f.install('--agent', 'codex', '--lang', 'en', ...extra), { code: 'EISDIR', message: 'agent-board: setup stopped while working on Codex. Run it again with --json to see the reason.' })
  })
  await fixture(f => {
    check(f, (...extra) => setupAgent(f, '--lang', 'en', '--agent', 'codex', '--data-dir', join(f.home, 'a%b'), ...extra), { code: 'SETUP_FAILED', cause: 'UNSAFE_COMMAND_PATH', agent: 'codex', message: 'agent-board: setup cannot write its hook commands because a path it needs contains a quote, backtick, $ or % character. Put the setup data folder somewhere else with --data-dir, then run setup again.' })
  })
}

test('every setup error is one sentence with one next step', async () => {
  await setupErrorCases((f, run, expected) => {
    const result = run()
    assert.equal(result.status, 1, result.stderr)
    if (expected.isEmpty) assert.equal(result.stdout, '')
    if (expected.conflict) {
      const plan = JSON.parse(result.stdout)
      assert.equal(plan.applied, false)
      assert.ok(plan.plans[0].conflicts.includes(expected.conflict))
      assert.match(result.stderr, /without changing anything.*Codex/)
    }
    const text = result.stderr.trimEnd()
    if (expected.message) assert.equal(text, expected.message)
    assert.equal(text.split('\n').length, 1, text)
    assert.ok(text.startsWith('agent-board: '), text)
    assert.match(text, /\b(run|name|add|fix|wait)\b/i)
    assert.doesNotMatch(text, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\n\s+at |Error:/)
    assert.doesNotMatch(text, /\.mjs|\.ts/)
    for (const path of [f.home, tmpdir(), process.cwd()]) assert.ok(!text.includes(path), text)
  })
  await fixture(f => {
    assert.equal(f.install('--apply').status, 0)
    for (const [lang, hint] of [['en', 'a setup option is missing its value'], ['zh-TW', 'setup 有個選項後面沒有接值'], ['zh-CN', 'setup 有个选项后面没有接值']]) {
      const result = setupAgent(f, '--lang', lang, '--agent')
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr.trimEnd().split('\n').length, 1)
      assert.ok(result.stderr.includes(hint), result.stderr)
      const board = f.command(['--codex-setup', '--agent', 'codex', '--data-dir', '--lang', lang])
      assert.equal(board.status, 1, board.stderr)
      assert.equal(result.stderr, board.stderr)
    }
  })
})

test('setup --json keeps its error codes', async () => {
  await setupErrorCases((f, run, expected) => {
    const plain = run()
    const result = run('--json')
    assert.equal(result.status, 1, result.stderr)
    if (expected.conflict) {
      assert.equal(result.stderr, '')
      const preview = JSON.parse(result.stdout)
      assert.equal(preview.applied, false)
      assert.ok(preview.plans[0].conflicts.includes(expected.conflict))
      return
    }
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.trimEnd().split('\n').length, 1)
    const { error } = JSON.parse(result.stderr)
    assert.equal(error.code, expected.code)
    assert.equal(error.message, plain.stderr.trimEnd())
    if (expected.message) assert.equal(error.message, expected.message)
    if (expected.cause) {
      assert.equal(error.agent, expected.agent ?? 'codex')
      assert.equal(error.cause, expected.cause)
    }
  })
})

const jsonHosts = [
  ['cursor', '.cursor/hooks.json', 'Cursor'],
  ['gemini', '.gemini/settings.json', 'Gemini CLI'],
  ['grok', '.grok/hooks/agent-board-local.json', 'Grok Build'],
  ['muse', '.config/muse/settings.json', 'Muse Code'],
  ['antigravity', '.gemini/config/hooks.json', 'Antigravity'],
  ['openclaw', '.openclaw/openclaw.json', 'OpenClaw'],
]

test('setup accepts a UTF-8 BOM in the existing hook config of each JSON host without losing foreign data', async () => {
  for (const [host, relative] of jsonHosts) await fixture(f => {
    const config = join(f.home, relative)
    const foreign = { command: 'echo foreign' }
    const originalConfig = { other: { keep: true }, ...(['cursor', 'gemini', 'grok', 'muse'].includes(host) ? { hooks: { ForeignEvent: [foreign] } } : host === 'openclaw' ? { plugins: { entries: { other: { enabled: true } } } } : {}) }
    const original = Buffer.from(`\uFEFF${JSON.stringify(originalConfig, null, 2).replaceAll('\n', '\r\n')}\r\n`)
    f.save(config, original)
    const preview = f.install('--agent', host)
    assert.equal(preview.status, 0, preview.stderr)
    assert.deepEqual(JSON.parse(preview.stdout).conflicts, [])
    assert.deepEqual(readFileSync(config), original)
    const applied = f.install('--agent', host, '--apply')
    assert.equal(applied.status, 0, applied.stderr)
    const configured = JSON.parse(readFileSync(config))
    const checkForeign = value => {
      assert.deepEqual(value.other, originalConfig.other)
      if (originalConfig.hooks) assert.deepEqual(value.hooks.ForeignEvent, [foreign])
      if (originalConfig.plugins) assert.deepEqual(value.plugins.entries.other, { enabled: true })
    }
    checkForeign(configured)
    if (host === 'antigravity') assert.ok(configured['agent-board-local'].SessionStart.length)
    else if (host === 'openclaw') assert.ok(configured.plugins.entries['agent-board-local'])
    else assert.ok(Object.keys(configured.hooks).some(event => event !== 'ForeignEvent'))
    const installed = readFileSync(config)
    const reinstalled = f.install('--agent', host, '--apply')
    assert.equal(reinstalled.status, 0, reinstalled.stderr)
    assert.deepEqual(JSON.parse(reinstalled.stdout).changes, [])
    assert.deepEqual(readFileSync(config), installed)
    const saved = Buffer.from(`\uFEFF${JSON.stringify(JSON.parse(installed), null, 2).replaceAll('\n', '\r\n')}\r\n`)
    f.save(config, saved)
    const resaved = f.install('--agent', host, '--apply')
    assert.equal(resaved.status, 0, resaved.stderr)
    assert.deepEqual(JSON.parse(resaved.stdout).changes, [])
    assert.deepEqual(readFileSync(config), saved)
    const removed = f.command(['--codex-remove', '--agent', host, '--apply'])
    assert.equal(removed.status, 0, removed.stderr)
    const remaining = JSON.parse(readFileSync(config))
    checkForeign(remaining)
    if (host === 'antigravity') assert.equal(remaining['agent-board-local'], undefined)
    else if (host === 'openclaw') assert.equal(remaining.plugins.entries['agent-board-local'], undefined)
    else assert.deepEqual(remaining.hooks, originalConfig.hooks)
  })
})

test('setup still refuses a malformed host config that starts with a BOM', async () => {
  for (const [host, relative, name] of jsonHosts) await fixture(f => {
    const config = join(f.home, relative)
    const original = Buffer.from('\uFEFF{"hooks":\r\n')
    f.save(config, original)
    const preview = f.install('--agent', host)
    assert.equal(preview.status, 0, preview.stderr)
    assert.ok(JSON.parse(preview.stdout).conflicts.includes(config))
    assert.deepEqual(readFileSync(config), original)
    const applied = f.install('--agent', host, '--apply')
    assert.notEqual(applied.status, 0)
    assert.deepEqual(readFileSync(config), original)
    assert.equal(existsSync(f.root), false)
    const common = setupAgent(f, '--lang', 'en', '--agent', host)
    assert.equal(common.status, 1)
    assert.equal(common.stderr.trimEnd().split('\n').length, 1)
    assert.ok(common.stderr.includes(name), common.stderr)
    assert.equal(JSON.parse(common.stdout).applied, false)
    assert.deepEqual(readFileSync(config), original)
    assert.equal(existsSync(f.root), false)
  })
})

test('setup names the host with an unreadable config and still previews the others', async () => {
  await fixture(f => {
    const cursor = join(f.home, '.cursor', 'hooks.json')
    f.save(cursor, '\uFEFF{"hooks":\r\n')
    f.save(f.hooks, '{}')
    const result = setupAgent(f, '--lang', 'en', '--agent', 'codex,cursor')
    assert.equal(result.status, 1)
    const preview = JSON.parse(result.stdout)
    assert.deepEqual(preview.targets, ['codex', 'cursor'])
    assert.equal(preview.applied, false)
    assert.equal(preview.plans.length, 2)
    assert.ok(preview.plans[1].conflicts.includes(cursor))
    assert.deepEqual(preview.plans[0].conflicts, [])
    assert.ok(preview.plans[0].changes.some(change => ['create', 'update'].includes(change.action)))
    assert.equal(result.stderr.trimEnd().split('\n').length, 1)
    assert.match(result.stderr, /Cursor/)
    assert.doesNotMatch(result.stderr, /Codex/)
    assert.equal(existsSync(f.root), false)
  })
  for (const [agent, relative, original, name] of [
    ['cursor', '.cursor/hooks.json', '{"hooks":[]}', 'Cursor'],
    ['cursor', '.cursor/hooks.json', '{"hooks":{"stop":"x"}}', 'Cursor'],
    ['openclaw', '.openclaw/openclaw.json', '{"plugins":{"load":{"paths":"x"}}}', 'OpenClaw'],
  ]) await fixture(f => {
    const config = join(f.home, relative)
    f.save(config, original)
    const result = setupAgent(f, '--lang', 'en', '--agent', `codex,${agent}`)
    assert.equal(result.status, 1)
    const preview = JSON.parse(result.stdout)
    assert.deepEqual(preview.targets, ['codex', agent])
    assert.equal(preview.applied, false)
    assert.equal(preview.plans.length, 2)
    assert.deepEqual(preview.plans[1].conflicts, [config])
    assert.deepEqual(preview.plans[0].conflicts, [])
    assert.ok(preview.plans[0].changes.some(change => ['create', 'update'].includes(change.action)))
    assert.equal(result.stderr.trimEnd().split('\n').length, 1)
    assert.ok(result.stderr.includes(name), result.stderr)
    assert.doesNotMatch(result.stderr, /Codex/)
    assert.equal(existsSync(f.root), false)
    assert.equal(readFileSync(config, 'utf8'), original)
  })
})

test('local setup preserves native config formatting when its content does not change', () => fixture(f => {
  for (const [agent, file] of [['codex', f.hooks], ['openclaw', join(f.home, '.openclaw', 'openclaw.json')]]) {
    const installed = f.install('--agent', agent, '--apply')
    assert.equal(installed.status, 0, installed.stderr)
    const original = ` \n${JSON.stringify(JSON.parse(readFileSync(file)), null, '\t')}\n\n`
    f.save(file, original)
    const result = f.install('--agent', agent, '--apply')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).changes.some(change => change.file === file), false, result.stdout)
    assert.deepEqual(readFileSync(file), Buffer.from(original))
  }
}))

test('local setup preserves Cursor and Muse key order and bytes when version keys follow hooks', () => fixture(f => {
  for (const [agent, relative, key] of [
    ['cursor', ['.cursor', 'hooks.json'], 'version'],
    ['muse', ['.config', 'muse', 'settings.json'], 'schema_version'],
  ]) {
    const file = join(f.home, ...relative)
    const installed = f.install('--agent', agent, '--apply')
    assert.equal(installed.status, 0, installed.stderr)
    const { [key]: version, ...config } = JSON.parse(readFileSync(file))
    assert.equal(version, 1, agent)
    for (const value of [version, 7]) {
      const original = ` \r\n${JSON.stringify({ ...config, custom: 'keep', [key]: value }, null, '\t').replaceAll('\n', '\r\n')}\r\n\r\n`
      f.save(file, original)
      for (const args of [[], ['--apply'], ['--apply']]) {
        const result = f.install('--agent', agent, ...args)
        assert.equal(result.status, 0, result.stderr)
        assert.equal(JSON.parse(result.stdout).changes.some(change => change.file === file), false, result.stdout)
        assert.deepEqual(readFileSync(file), Buffer.from(original), agent)
      }
    }
  }
}))

test('local setup adds missing Cursor and Muse version defaults once', () => fixture(f => {
  for (const [agent, relative, key] of [
    ['cursor', ['.cursor', 'hooks.json'], 'version'],
    ['muse', ['.config', 'muse', 'settings.json'], 'schema_version'],
  ]) {
    const file = join(f.home, ...relative)
    f.save(file, '{"hooks":{},"custom":"keep"}\n')
    const installed = f.install('--agent', agent, '--apply')
    assert.equal(installed.status, 0, installed.stderr)
    const original = readFileSync(file)
    const config = JSON.parse(original)
    assert.equal(config[key], 1, agent)
    assert.equal(config.custom, 'keep', agent)
    const again = f.install('--agent', agent, '--apply')
    assert.equal(again.status, 0, again.stderr)
    assert.equal(JSON.parse(again.stdout).changes.some(change => change.file === file), false, again.stdout)
    assert.deepEqual(readFileSync(file), original, agent)
  }
}))

test('a new prompt leaves the open question waiting for Codex and the local agents while replay preserves newer questions', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-prompt-1').status, 0)
  assert.equal(f.report('waiting', ['- [?] Choose database', '- [ ] Continue']).status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-prompt-2', { prompt: 'PRIVATE_NEW_INPUT' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /state=working/)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Choose database/)
  assert.equal(f.report('waiting', ['- [?] New question', '- [ ] Continue']).status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-prompt-2').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] New question/)
  assert.equal(f.install('--agent', 'grok', '--apply').status, 0)
  const owner = 'grok-prompt-owner'
  assert.equal(f.command(['--codex-report', '--agent', 'grok', '--session', owner], { title: 'Grok task', state: 'waiting', steps: ['- [?] Grok decision', '- [ ] Continue'] }).status, 0)
  assert.equal(f.command(['--agent-status', '--agent', 'grok', '--state', 'working'], { session_id: owner }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Grok decision/)
  assert.equal(f.command(['--agent-status', '--agent', 'grok', '--state', 'working'], { session_id: owner, hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_NEW_INPUT' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Grok decision/)
  const record = join(f.root, 'sessions', createHash('sha256').update(`grok:${owner}`).digest('hex') + '.json')
  assert.ok(!readFileSync(record, 'utf8').includes('PRIVATE_NEW_INPUT'))
}))

test('native board prompt commands preserve the waiting question and store no incoming words', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit', 'initial-turn').status, 0)
  assert.equal(f.report('waiting', ['- [?] Choose database', '- [ ] Continue']).status, 0)
  for (const prompt of ['$agent-board', '/board', '/agent-board', ' \n/board\n ']) {
    assert.equal(f.event('UserPromptSubmit', 'board-turn', { prompt }).status, 0)
    assert.match(readFileSync(f.progress, 'utf8'), /state=waiting/)
    assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Choose database/)
  }
  assert.equal(f.event('Stop', 'board-turn').status, 0)
  assert.equal(f.event('UserPromptSubmit', 'real-turn', { prompt: 'PRIVATE_REAL_ANSWER' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Choose database/)
  assert.ok(!readFileSync(f.progress, 'utf8').includes('PRIVATE_REAL_ANSWER'))
  for (const agent of ['cursor', 'grok', 'muse', 'gemini']) {
    assert.equal(f.install('--agent', agent, '--apply').status, 0)
    const owner = `board-${agent}-session-123`
    assert.equal(f.command(['--codex-report', '--agent', agent, '--session', owner], { title: 'Native task', state: 'waiting', steps: ['- [?] Native decision', '- [ ] Continue'] }).status, 0)
    const prompt = agent === 'gemini' ? 'Show me the Agent Board below exactly as it is, in a code block, with the link to the board you can click from its last line. Then tell me in one sentence what needs me first. Do not change any file.\n\nProgress  ● 1 waiting  ▸ 0 in progress  ⚑ 0 due soon  ✓ 0 done today' : '$agent-board'
    const payload = agent === 'cursor' ? { conversation_id: owner, generation_id: 'board-turn', hook_event_name: 'beforeSubmitPrompt', prompt: '/board' } : { session_id: owner, hook_event_name: agent === 'gemini' ? 'BeforeAgent' : 'UserPromptSubmit', prompt }
    const args = agent === 'cursor' ? ['--codex-event', '--agent', agent] : ['--agent-status', '--agent', agent, '--state', 'working']
    assert.equal(f.command(args, payload).status, 0, agent)
    assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Native decision/, agent)
    const blocks = readFileSync(f.progress, 'utf8').split('<!-- auto ').filter(block => block.includes(`resume=${owner}`))
    assert.equal(blocks.length, 1)
    assert.match(blocks[0], /state=waiting/, agent)
  }
}))

test('Codex-only setup previews every persistent change without writing', () => fixture(f => {
  const plan = f.install()
  assert.equal(plan.status, 0, plan.stderr)
  assert.deepEqual(JSON.parse(plan.stdout).changes.map(change => change.file).sort(), [f.hooks, f.script, join(f.root, 'agent-board-hook.mjs'), f.skill, f.progress, join(f.root, 'install-codex.json')].sort())
  assert.ok(!existsSync(f.root))
  assert.ok(!existsSync(f.hooks))
}))

test('Codex-only setup initializes the board and skill without Claude and is idempotent', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.ok(existsSync(f.progress) && existsSync(f.skill))
  const instructions = readFileSync(f.skill, 'utf8')
  assert.match(instructions, /ask the user to confirm once/)
  assert.match(instructions, /--codex-trust --codex-bin/)
  assert.ok(instructions.includes(f.hooks))
  assert.match(instructions, /SessionStart, UserPromptSubmit, PermissionRequest, Stop, Interrupt, SessionEnd/)
  const again = f.install()
  assert.deepEqual(JSON.parse(again.stdout).changes, [])
  const doctor = f.command(['--codex-doctor', '--home', f.home])
  assert.equal(JSON.parse(doctor.stdout).ready, true, doctor.stdout)
  assert.equal(JSON.parse(doctor.stdout).hooksTrusted, 'unknown')
}))

test('the generated Codex hook command runs through the platform shell with JSON on stdin', () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  const command = JSON.parse(readFileSync(f.hooks)).hooks.UserPromptSubmit[0].hooks[0].command
  const result = await fireCommand(f, command, JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'native-shell-fixture' }))
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(f.progress, 'utf8'), /state=working/)
  const record = JSON.parse(readFileSync(join(f.root, 'sessions', createHash('sha256').update(`codex:${session}`).digest('hex') + '.json')))
  assert.equal(record.turn, 'native-shell-fixture')
  assert.equal(f.event('Stop', 'native-shell-fixture').status, 0)
  const idle = f.command([])
  assert.equal(idle.status, 0, idle.stderr)
  assert.ok(!idle.stdout.includes('running:') && !idle.stdout.includes('session ended'), idle.stdout)
}))

test('a reporter that hangs is cut at its timeout and the host hook exits 0', () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.report().status, 0)
  const held = readFileSync(f.progress)
  const pidFile = join(f.root, 'synthetic-reporter.pid')
  const head = readFileSync(f.script, 'utf8').split('\n')[0]
  f.save(f.script, `${head}\nimport {writeFileSync} from 'node:fs'\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`)
  let wasReaped = false
  try {
    const out = await fireHook(f, JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'hanging-turn' }))
    assert.ok(existsSync(pidFile), out.stderr)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') wasReaped = true; else throw error }
    assert.equal(out.status, 0, out.stderr)
    assert.equal(wasReaped, true, 'the timed-out reporter must be reaped before the hook returns')
    assert.match(readFileSync(join(f.root, 'hook-errors.log'), 'utf8'), /codex REPORTER_QUEUED/)
    assert.deepEqual(readFileSync(f.progress), held)
  } finally {
    // The outer test deadline is a backstop for a broken implementation, too.
    if (!wasReaped && existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      await stopReporter(pid)
    }
  }
}))

// The busy loops took all but one core of a 16-thread desktop, and overlapping local runs froze it (#241), so this
// test runs only in CI or when AGENT_BOARD_HEAVY_TESTS=1 asks for it.
const isHeavyRun = Boolean(process.env.CI) || process.env.AGENT_BOARD_HEAVY_TESTS === '1'
test('L5 busy machine: Antigravity and Codex hooks apply or queue every event with up to 3 CPUs busy', { skip: isHeavyRun ? false : 'keeps up to 3 CPUs busy; runs in CI, or locally with AGENT_BOARD_HEAVY_TESTS=1' }, t => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  // A direct command sets its argument data after preloads run. Observe the worker import too,
  // so a failure tells a worker that never got the CPU apart from one that missed its deadline.
  const preload = join(f.home, 'worker-start.cjs')
  f.save(preload, `const { basename } = require('node:path')
const markWorker = () => {
  const at = process.argv.indexOf('--hook-started')
  try { require('node:fs').writeFileSync(process.env.L5_START_STAMP, Date.now() + ' ' + (at === -1 ? '' : process.argv[at + 1]), { flag: 'wx' }) } catch {}
}
if (basename(process.argv[1] || '') === 'agent-board-hook.mjs') markWorker()
require('node:module').registerHooks({ load(url, context, next) {
  if (url.endsWith('/agent-board-hook.mjs')) markWorker()
  return next(url, context)
} })
`)
  // One core stays free and the loops run below normal priority: the machine is busy, but neither the hook
  // nor the other test files that `node --test` runs at the same time go without CPU before the host's 3 s stop.
  // At most 3 loops: all but one core of a 4-vCPU CI runner, as before.
  const busyCount = Math.max(1, Math.min(availableParallelism() - 1, 3))
  let priority = 'below normal priority'
  const busy = []
  const records = []
  const antigravity = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json')))['agent-board-local'].SessionStart[0].command
  const codex = JSON.parse(readFileSync(f.hooks)).hooks.UserPromptSubmit[0].hooks[0].command
  const hooks = [
    ['antigravity', antigravity, key => ({ conversationId: `busy-antigravity-session-${key}` })],
    ['codex', codex, key => ({ session_id: `busy-codex-session-${key}`, hook_event_name: 'UserPromptSubmit', turn_id: `busy-turn-${key}` })],
  ]
  const fire = async (agent, command, payload, label, limit) => {
    const stamp = join(f.home, `worker-start-${agent}-${label.replaceAll(' ', '-')}.txt`)
    const env = { ...f.env, L5_START_STAMP: stamp, NODE_OPTIONS: [f.env.NODE_OPTIONS, `--require ${JSON.stringify(preload)}`].filter(Boolean).join(' ') }
    const spawnedAt = Date.now()
    const result = await fireCommand({ env }, command, JSON.stringify(payload), limit)
    const tookMs = Date.now() - spawnedAt
    const [workerAt, shellAt] = existsSync(stamp) ? readFileSync(stamp, 'utf8').split(' ').map(Number) : []
    const load = busy.length ? `${busy.length} busy at ${priority}` : 'no load'
    const timing = `${agent} ${label} (${load}): worker ${workerAt ? `started ${workerAt - spawnedAt} ms after the spawn` : 'never started'}`
      + `${shellAt ? `, PowerShell ${shellAt - spawnedAt} ms` : ''}, hook ended after ${tookMs} ms`
    t.diagnostic(timing)
    const log = hookLog(f)
    assert.equal(result.status, 0, `${timing}\n${hookFailure(result)}\nhook log:\n${log}`)
    const id = payload.session_id ?? payload.conversationId
    const owner = createHash('sha256').update(`${agent}:${id}`).digest('hex')
    const record = join(f.root, 'sessions', `${owner}.json`)
    const saved = pendingFiles(f).some(name => readFileSync(join(f.root, 'pending', name), 'utf8').includes(id))
    assert.ok(existsSync(record) || saved, `${timing}: the event must be applied or queued; hook log:\n${log}`)
    records.push({ file: record, state: agent === 'codex' ? 'working' : 'waiting', turn: payload.turn_id })
  }
  // A machine's first PowerShell and Node start is far slower than later ones (#241 keeps that case open), so
  // one event per hook runs before the load, untimed (the test's 30 s limit only); it must still be applied or queued.
  for (const [agent, command, payloadOf] of hooks) await fire(agent, command, payloadOf('warm-up'), 'warm-up', 30000)
  try {
    for (let index = 0; index < busyCount; index++) {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); while (true) {}'], { env: f.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const closed = new Promise((done, reject) => { child.once('close', done); child.once('error', reject) })
      closed.catch(() => {})
      busy.push({ child, closed })
      try { setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL) } catch (error) { priority = `normal priority (setPriority ${error.info?.code ?? error.code ?? error.message})` }
      await new Promise((done, reject) => { child.stdout.once('data', done); child.once('error', reject) })
    }
    for (const [agent, command, payloadOf] of hooks) {
      for (let index = 0; index < 3; index++) await fire(agent, command, payloadOf(index), `event ${index}`, 5000)
    }
  } finally {
    await Promise.all(busy.map(async ({ child, closed }) => {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
      finally { await closed }
    }))
  }
  const next = f.event('SessionStart', null, { session_id: 'busy-follow-up-session' })
  assert.equal(next.status, 0, next.stderr)
  assert.deepEqual(pendingFiles(f), [])
  for (const expected of records) {
    const record = JSON.parse(readFileSync(expected.file))
    assert.equal(record.state, expected.state)
    if (expected.turn) assert.equal(record.turn, expected.turn)
  }
}))

test('L4 5 MB file: every Codex event is applied or queued and replayed by a follow-up hook', () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  const task = '### Synthetic hand-kept task\n- [ ] Keep this task unchanged\n'
  f.save(f.progress, '## Synthetic history\n' + task.repeat(Math.ceil(5 * 1024 * 1024 / Buffer.byteLength(task))))
  assert.ok(readFileSync(f.progress).length >= 5 * 1024 * 1024)
  const records = []
  for (let index = 0; index < 3; index++) {
    const id = `large-file-session-${index}`, turn = `large-file-turn-${index}`
    const result = await fireHook(f, JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit', turn_id: turn }))
    assert.equal(result.status, 0, hookFailure(result))
    const owner = createHash('sha256').update(`codex:${id}`).digest('hex')
    const record = join(f.root, 'sessions', `${owner}.json`)
    const saved = pendingFiles(f).some(name => readFileSync(join(f.root, 'pending', name), 'utf8').includes(id))
    assert.ok(existsSync(record) || saved, `event ${index} must be applied or queued`)
    records.push({ file: record, turn })
  }
  const next = f.event('SessionStart', null, { session_id: 'large-file-follow-up-session' })
  assert.equal(next.status, 0, next.stderr)
  for (const expected of records) {
    const record = JSON.parse(readFileSync(expected.file))
    assert.equal(record.state, 'working')
    assert.equal(record.turn, expected.turn)
  }
  const block = readFileSync(f.progress, 'utf8').slice(-2000)
  assert.match(block, /<!-- auto [^\n]*agent=codex/)
  assert.match(block, /state=working/)
  assert.deepEqual(pendingFiles(f), [])
}))

test('a queued event from every host is replayed by the next hook', async t => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  let local, portable
  try {
    local = await import('../hooks/local-agents.ts')
    portable = await import('../hooks/portable-agents.ts')
  } finally { resolver.deregister() }
  const { opencodePlugin } = local
  const { openclawLocalPlugin, deepseekLocalPlugin } = portable
  const hosts = [
    { agent: 'codex', event: 'UserPromptSubmit', config: ['.codex', 'hooks.json'], payload: { session_id: 'queued-codex-session', hook_event_name: 'UserPromptSubmit', turn_id: 'queued-turn' }, folder: 'queued-codex-folder' },
    { agent: 'cursor', event: 'beforeSubmitPrompt', config: ['.cursor', 'hooks.json'], payload: { conversation_id: 'queued-cursor-session', hook_event_name: 'beforeSubmitPrompt', generation_id: 'queued-generation' }, folder: 'queued-cursor-folder' },
    { agent: 'gemini', event: 'BeforeAgent', config: ['.gemini', 'settings.json'], payload: { session_id: 'queued-gemini-session' } },
    { agent: 'grok', event: 'UserPromptSubmit', config: ['.grok', 'hooks', 'agent-board-local.json'], payload: {}, env: { GROK_SESSION_ID: 'queued-grok-session' } },
    { agent: 'muse', event: 'UserPromptSubmit', config: ['.config', 'muse', 'settings.json'], payload: { session_id: 'queued-muse-session' } },
    { agent: 'antigravity', event: 'PreInvocation', config: ['.gemini', 'config', 'hooks.json'], payload: { conversationId: 'queued-antigravity-session' } },
    { agent: 'opencode', mode: '--agent-status', payload: { session_id: 'queued-opencode-session', state: 'working' } },
    { agent: 'openclaw', mode: '--codex-event', payload: { session_id: 'queued-openclaw-event-session', hook_event_name: 'UserPromptSubmit', turn_id: 'queued-run', prompt_submitted: false } },
    { agent: 'openclaw', mode: '--agent-status', payload: { session_id: 'queued-openclaw-status-session', state: 'working' } },
    { agent: 'deepseek', mode: '--agent-status', payload: { session_id: 'queued-deepseek-session', state: 'working' } },
  ]
  for (const host of hosts) await t.test(`${host.agent} ${host.mode ?? host.event}`, () => fixture(async f => {
    const installed = f.install('--agent', host.agent, '--apply')
    assert.equal(installed.status, 0, installed.stderr)
    holdAutomaticRecovery(f)
    const worker = join(f.root, 'agent-board-hook.mjs')
    let argv
    let payload = { ...host.payload }, input
    if (host.config) {
      const config = JSON.parse(readFileSync(join(f.home, ...host.config)))
      const hook = host.agent === 'antigravity' ? config['agent-board-local'][host.event][0] : config.hooks[host.event][0]
      const command = hook.command ?? hook.hooks[0].command
      const launch = generatedHookCommand(command)
      const words = launch.args ?? [...launch.text.matchAll(/"([^"]*)"|'((?:[^']|'')*)'|(\S+)/g)].map(match => match[1] ?? match[2]?.replaceAll("''", "'") ?? match[3])
      argv = words.slice(words.indexOf('--hook-version'), words.includes('--hook-started') ? words.indexOf('--hook-started') : undefined)
      assert.equal(argv[0], '--hook-version')
    } else {
      const saved = []
      const instantiate = (source, suffix) => new Function('createRequire', 'spawnSync', 'tool', `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace('export default', 'const plugin =').replace(/^export /gm, '')}\n${suffix}`)(createRequire, (node, args, options) => { saved.push({ node, args: [...args], input: options.input }); return { status: 0, stdout: '' } }, Object.assign(value => value, { schema: { string: () => ({ describe: () => ({}) }), enum: () => ({}), array: () => ({}) } }))
      if (host.agent === 'opencode') {
        const exitListeners = process.listeners('exit')
        try {
          const factory = instantiate(opencodePlugin(process.execPath, worker, f.progress, 'Progress', f.home), 'return AgentBoardLocal')
          const hooks = await factory({ client: { session: { get: async ({ path }) => ({ data: { id: path.id } }) } } })
          await hooks.event({ event: { type: 'session.status', properties: { sessionID: payload.session_id, status: { type: 'busy' } } } })
        } finally { dropExitReports(exitListeners) }
      } else if (host.agent === 'openclaw') {
        const { plugin, report } = instantiate(openclawLocalPlugin(process.execPath, worker, f.progress, f.home), 'return { plugin, report }')
        if (host.mode === '--codex-event') {
          let subscription
          plugin.register({ on: () => {}, agent: { events: { registerAgentEventSubscription: value => { subscription = value } } } })
          await subscription.handle({ stream: 'lifecycle', sessionId: payload.session_id, runId: payload.turn_id, data: { phase: 'start' } })
        } else {
          // OpenClaw has no status callback; exercise that mode through its generated runner.
          report(host.mode, payload, Date.now() + 2000)
        }
      } else {
        const callbacks = new Map()
        const apply = instantiate(deepseekLocalPlugin(process.execPath, worker, f.progress, f.home), 'return apply')
        apply({ on: (name, callback) => callbacks.set(name, callback) })
        await callbacks.get('agent/status')({ agent: { session: { header: { id: payload.session_id } } }, status: 'running' })
      }
      assert.equal(saved.length, 1)
      assert.equal(saved[0].node, process.execPath)
      assert.equal(saved[0].args[0], worker)
      argv = saved[0].args.slice(1)
      input = saved[0].input
      payload = JSON.parse(input)
    }
    if (host.agent === 'codex') payload.cwd = join(f.root, 'work', host.folder)
    if (host.agent === 'cursor') payload.workspace_roots = [join(f.root, 'work', host.folder)]
    const env = { ...f.env, ...host.env }
    const deadline = argv.indexOf('--hook-deadline')
    if (deadline < 0) argv.push('--hook-deadline', String(Date.now() - 1))
    else argv[deadline + 1] = String(Date.now() - 1)
    const queued = spawnSync(process.execPath, [worker, ...argv], { env, input: input ?? JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 5000 })
    assert.equal(queued.status, 0, hookFailure(queued))
    const files = pendingFiles(f)
    assert.equal(files.length, 1)
    assert.match(files[0], /\.raw\.json$/)
    const log = join(f.root, 'hook-errors.log')
    const errors = readFileSync(log, 'utf8')
    assert.match(errors, new RegExp(` ${host.agent} REPORTER_QUEUED\\n$`))
    assert.equal(errors.trimEnd().split('\n').length, 1)
    const next = f.event('SessionStart', null, { session_id: 'queued-host-follow-up-session' })
    assert.equal(next.status, 0, hookFailure(next))
    const id = payload.session_id ?? payload.conversation_id ?? payload.conversationId ?? host.env.GROK_SESSION_ID
    const owner = createHash('sha256').update(`${host.agent}:${id}`).digest('hex')
    const record = JSON.parse(readFileSync(join(f.root, 'sessions', `${owner}.json`)))
    assert.equal(record.state, 'working')
    if (host.folder) assert.equal(record.title, host.folder)
    assert.deepEqual(pendingFiles(f), [])
    assert.equal(readFileSync(log, 'utf8'), errors)
    assert.equal(queued.stderr + next.stderr, '')
  }))
})

test('a reporter that exits 0 after its deadline keeps its stdout without queuing a duplicate', () => fixture(f => {
  const worker = join(f.root, 'agent-board-hook.mjs')
  f.save(f.script, 'globalThis.AGENT_BOARD = {"hookVersion":1,}\n')
  f.save(worker, hookWorker(f.home, f.script, 'const isBoardRequest = () => false'))
  const preload = join(f.home, 'late-success.cjs')
  const stdout = JSON.stringify({ env: { AGENT_BOARD_SESSION_ID: session, AGENT_BOARD_AGENT: 'cursor' } }) + '\n'
  f.save(preload, `const child = require('node:child_process')
child.spawnSync = (_executable, args) => {
  const deadline = Number(args[args.indexOf('--hook-deadline') + 1])
  Date.now = () => deadline + 1
  return { status: 0, signal: null, stdout: ${JSON.stringify(stdout)}, stderr: '' }
}
`)
  const result = spawnSync(process.execPath, [worker, '--hook-version', '1', '--codex-event', '--agent', 'cursor', '--progress-file', f.progress], { env: { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }, input: JSON.stringify({ conversation_id: session, hook_event_name: 'sessionStart' }), encoding: 'utf8', windowsHide: true, timeout: 5000 })
  assert.equal(result.status, 0, hookFailure(result))
  assert.equal(result.stdout, stdout)
  assert.equal(result.stderr, '')
  assert.deepEqual(pendingFiles(f), [])
  assert.equal(existsSync(join(f.root, 'hook-errors.log')), false)
}))

test('a hook whose reporter runs past the deadline saves the raw event and the next hook applies it', () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  holdAutomaticRecovery(f)
  const real = readFileSync(f.script)
  const pidFile = join(f.root, 'raw-reporter.pid')
  f.save(f.script, `${real.toString().split('\n')[0]}\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`)
  let wasReaped = false
  try {
    const started = performance.now()
    const result = await fireHook(f, JSON.stringify({ session_id: session, sessionId: 's'.repeat(4096), state: 's'.repeat(4097), generation_id: { text: 'PRIVATE_OBJECT' }, prompt_submitted: true, hook_event_name: 'UserPromptSubmit', turn_id: 'raw-first', cwd: join(f.root, 'work', 'raw-folder-project'), prompt: 'PRIVATE_PROMPT', last_assistant_message: 'PRIVATE_ASSISTANT', tool_input: { text: 'PRIVATE_TOOL' }, transcript_path: 'PRIVATE_TRANSCRIPT' }))
    wasReaped = !existsSync(pidFile) || !isReporterAlive(Number(readFileSync(pidFile, 'utf8')))
    assert.equal(result.status, 0, hookFailure(result))
    assert.equal(wasReaped, true, 'the timed-out reporter must be reaped before the hook returns')
    assert.ok(performance.now() - started < 3000)
    const files = pendingFiles(f)
    assert.equal(files.length, 1)
    assert.match(files[0], /^\d{15}-[\da-f-]+\.raw\.json$/)
    const saved = readFileSync(join(f.root, 'pending', files[0]), 'utf8')
    assert.ok(!saved.includes('PRIVATE_'), 'raw events retain metadata only')
    const raw = JSON.parse(saved)
    assert.equal(raw.kind, 'raw')
    assert.deepEqual(raw.env, {})
    assert.equal(raw.payload.board_request, false)
    assert.equal(raw.payload.sessionId, 's'.repeat(4096))
    assert.equal(raw.payload.state, undefined)
    assert.equal(raw.payload.generation_id, undefined)
    assert.equal(raw.payload.prompt_submitted, true)
    assert.ok(!raw.argv.includes('--home') && !raw.argv.includes('--hook-deadline'))
    assert.match(readFileSync(join(f.root, 'hook-errors.log'), 'utf8'), /REPORTER_QUEUED/)
    f.save(f.script, real)
    const next = await fireHook(f, JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'raw-second' }))
    assert.equal(next.status, 0, hookFailure(next))
    const record = JSON.parse(readFileSync(join(f.root, 'sessions', `${createHash('sha256').update(`codex:${session}`).digest('hex')}.json`)))
    assert.equal(record.turn, 'raw-second')
    assert.equal(record.title, 'raw-folder-project')
    assert.equal(record.project, 'raw-folder-project')
    for (const text of [readFileSync(f.progress, 'utf8'), JSON.stringify(record)]) assert.ok(!text.includes(join(f.root, 'work')), 'only the folder name reaches the board')
    assert.ok(record.events.indexOf('UserPromptSubmit:raw-first') < record.events.indexOf('UserPromptSubmit:raw-second'))
    assert.ok(record.events.includes('UserPromptSubmit:raw-first'))
    assert.deepEqual(pendingFiles(f), [])
    // A late raw event from this very millisecond range cannot reopen an older turn.
    raw.at = record.appliedAt - 1
    raw.payload.turn_id = 'raw-stale'
    f.save(join(f.root, 'pending', `${String(raw.at).padStart(15, '0')}-stale.raw.json`), JSON.stringify(raw))
    assert.equal(f.event('SessionStart', null, { session_id: 'other-replay-session' }).status, 0)
    assert.equal(JSON.parse(readFileSync(join(f.root, 'sessions', `${createHash('sha256').update(`codex:${session}`).digest('hex')}.json`))).turn, 'raw-second')
    assert.deepEqual(pendingFiles(f), [])
  } finally {
    f.save(f.script, real)
    if (!wasReaped && existsSync(pidFile)) await stopReporter(Number(readFileSync(pidFile, 'utf8')))
  }
}))

test('the hook deadline counts from the process start, not from when the worker runs', () => fixture(f => {
  assert.equal(f.install('--agent', 'gemini', '--apply').status, 0)
  holdAutomaticRecovery(f)
  const worker = join(f.root, 'agent-board-hook.mjs')
  const argv = ['--hook-version', '1', '--hook-event', 'BeforeAgent', '--agent-status', '--agent', 'gemini', '--state', 'working', '--progress-file', f.progress]
  const payload = { session_id: session }
  const at = Date.now() - 3050
  const result = spawnSync(process.execPath, [worker, ...argv, '--hook-started', String(at)], { env: f.env, input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(f.progress, 'utf8').includes('agent=gemini'), false)
  const queued = pendingFiles(f)[0]
  assert.ok(queued, 'an expired reporter deadline must save the event in pending/')
  assert.equal(JSON.parse(readFileSync(join(f.root, 'pending', queued))).at, at)
  for (const [index, invalid] of [String(Date.now() + 60000), '-1', '1.5', 'NaN', '9007199254740992'].entries()) {
    const id = `invalid-start-session-${index}`
    const out = spawnSync(process.execPath, [worker, ...argv, '--hook-started', invalid], { env: f.env, input: JSON.stringify({ session_id: id }), encoding: 'utf8', windowsHide: true, timeout: 5000 })
    assert.equal(out.status, 0, out.stderr)
    assert.match(readFileSync(f.progress, 'utf8'), /agent=gemini/)
    const owner = createHash('sha256').update(`gemini:${id}`).digest('hex')
    assert.equal(JSON.parse(readFileSync(join(f.root, 'sessions', `${owner}.json`))).state, 'working')
    assert.deepEqual(pendingFiles(f), [])
  }
}))

test('an Antigravity worker delayed past ten seconds preserves its event time without overwriting newer work', () => fixture(f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  holdAutomaticRecovery(f)
  const conversationId = 'synthetic-delayed-antigravity-241'
  const old = Date.now() - 11000, newer = Date.now() - 1000
  const report = (state, event, at) => f.command(['--agent-status', '--agent', 'antigravity', '--state', state, '--event', event, '--hook-started', String(at)], { conversationId })
  assert.equal(report('working', 'PreInvocation', newer).status, 0)
  const before = readFileSync(f.progress)
  const result = spawnSync(process.execPath, [join(f.root, 'agent-board-hook.mjs'), '--hook-version', '1', '--hook-event', 'Stop', '--agent-status', '--agent', 'antigravity', '--state', 'waiting', '--event', 'Stop', '--progress-file', f.progress, '--hook-started', String(old)], {
    env: f.env, input: JSON.stringify({ conversationId }), encoding: 'utf8', windowsHide: true, timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  const queued = pendingFiles(f)
  assert.equal(queued.length, 1, 'the late worker must queue its expired event instead of re-dating it')
  assert.equal(JSON.parse(readFileSync(join(f.root, 'pending', queued[0]), 'utf8')).at, old)
  assert.deepEqual(readFileSync(f.progress), before)
  assert.equal(report('working', 'PreInvocation', newer).status, 0)
  assert.deepEqual(pendingFiles(f), [])
  assert.deepEqual(readFileSync(f.progress), before)
  const owner = createHash('sha256').update(`antigravity:${conversationId}`).digest('hex')
  assert.equal(JSON.parse(readFileSync(join(f.root, 'sessions', `${owner}.json`), 'utf8')).appliedAt, newer)
}))

test('an older live lifecycle event cannot replace a newer state or its update time', () => fixture(f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const conversationId = 'synthetic-ordered-antigravity-241'
  const old = Date.now() - 1500, newer = Date.now() - 1000
  const report = (state, event, at) => f.command(['--agent-status', '--agent', 'antigravity', '--state', state, '--event', event, '--hook-started', String(at)], { conversationId })
  assert.equal(report('waiting', 'Stop', newer).status, 0)
  const before = readFileSync(f.progress)
  const owner = createHash('sha256').update(`antigravity:${conversationId}`).digest('hex')
  const record = join(f.root, 'sessions', `${owner}.json`)
  const previous = readFileSync(record)
  assert.equal(report('working', 'PostInvocation', old).status, 0)
  assert.deepEqual(readFileSync(f.progress), before)
  assert.deepEqual(readFileSync(record), previous)
  assert.equal(report('working', 'PreInvocation', newer + 1).status, 0)
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).state, 'working')
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).appliedAt, newer + 1)
}))

test('a hook worker that starts after the host would stop it still reads its input and queues the event', () => fixture(f => {
  // A cold Windows PowerShell start can delay Antigravity's worker past its 3 s host limit (#241).
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  holdAutomaticRecovery(f)
  const worker = join(f.root, 'agent-board-hook.mjs')
  const conversationId = 'late-antigravity-session'
  const argv = ['--hook-version', '1', '--hook-event', 'Stop', '--agent-status', '--agent', 'antigravity', '--state', 'waiting', '--event', 'Stop', '--progress-file', f.progress]
  // Three seconds back is past the input deadline, so the worker must use late-input queueing.
  const at = Date.now() - 3000
  const result = spawnSync(process.execPath, [worker, ...argv, '--hook-started', String(at)], { env: f.env, input: JSON.stringify({ conversationId }), encoding: 'utf8', windowsHide: true, timeout: 20000 })
  assert.equal(result.status, 0, hookFailure(result))
  assert.equal(result.stdout, '{}\n')
  const log = hookLog(f)
  assert.match(log, /REPORTER_QUEUED/)
  assert.doesNotMatch(log, /REPORTER_TIMEOUT/)
  const queued = pendingFiles(f)
  assert.equal(queued.length, 1, log)
  assert.match(queued[0], /\.raw\.json$/)
  assert.equal(JSON.parse(readFileSync(join(f.root, 'pending', queued[0]))).at, at)
  assert.equal(f.event('SessionStart', null, { session_id: 'other-replay-session' }).status, 0)
  const owner = createHash('sha256').update(`antigravity:${conversationId}`).digest('hex')
  assert.equal(JSON.parse(readFileSync(join(f.root, 'sessions', `${owner}.json`))).state, 'waiting')
  assert.deepEqual(pendingFiles(f), [])
}))

test('a hook log write sweeps stale hook-errors.log temp files but keeps fresh ones', () => fixture(f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  f.save(join(f.root, 'agent-board-hook.mjs'), hookWorker(f.home, f.script, 'const isBoardRequest = () => false'))
  const stale = join(f.root, 'hook-errors.log.111.tmp'), fresh = join(f.root, 'hook-errors.log.222.tmp')
  const directory = join(f.root, 'hook-errors.log.333.tmp'), foreign = join(f.root, 'hook-errors.log.other.tmp')
  f.save(stale, 'stale'); f.save(fresh, 'fresh'); f.save(foreign, 'foreign')
  mkdirSync(directory)
  const old = new Date(Date.now() - 300000)
  for (const file of [stale, directory, foreign]) utimesSync(file, old, old)
  // An old link is no log file of its own: it stays, and so does what it points to. Windows may refuse to make one.
  const link = join(f.root, 'hook-errors.log.444.tmp'), target = join(f.root, 'link-target.txt')
  f.save(target, 'target'); utimesSync(target, old, old)
  let hasLink = true
  try { symlinkSync(target, link, 'file'); lutimesSync(link, old, old) } catch { hasLink = false }
  assert.ok(hasLink || process.platform === 'win32', 'symlink setup failed')
  const out = spawnSync(process.execPath, [join(f.root, 'agent-board-hook.mjs'), '--hook-version', '1', '--agent-status', '--agent', 'antigravity', '--hook-started', String(Date.now() - 3000)], {
    env: f.env, input: JSON.stringify({ conversationId: 'synthetic-log-sweep' }), encoding: 'utf8', windowsHide: true, timeout: 20000,
  })
  assert.equal(out.status, 0, hookFailure(out))
  assert.match(hookLog(f), /REPORTER_QUEUED/)
  assert.equal(existsSync(stale), false)
  assert.equal(existsSync(fresh), true)
  assert.equal(existsSync(directory), true)
  assert.equal(existsSync(foreign), true)
  if (hasLink) assert.equal(lstatSync(link).isSymbolicLink(), true)
  assert.equal(readFileSync(target, 'utf8'), 'target')
}))

test('only the hook worker carries the hook-errors.log temp sweep, not the bootstrap or the SDK guard', () => {
  const sweep = 'cutoff = Date.now() - 60000'
  assert.equal(hookWorker('/synthetic-home', '/synthetic/board.mjs', 'const isBoardRequest = () => false').includes(sweep), true)
  // The bootstrap rides on a cmd.exe command line, which holds at most 8,191 characters.
  assert.equal(hookBootstrap('/synthetic-home', 'antigravity').includes(sweep), false)
  assert.equal(hookGuardSource('/synthetic-home', 'opencode').includes(sweep), false)
})

test('a report hook whose reporter runs past its deadline is never queued', () => fixture(async f => {
  assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
  f.save(join(f.root, 'agent-board-hook.mjs'), hookWorker(f.home, f.script, 'const isBoardRequest = () => false'))
  const preload = join(f.home, 'hang-report.cjs'), marker = join(f.home, 'report-child-started')
  f.save(preload, `if (process.argv.includes('--hook-deadline')) { require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000) }\n`)
  const worker = join(f.root, 'agent-board-hook.mjs')
  const args = [worker, '--hook-version', '1', '--codex-report', '--agent', 'codex']
  // Host command hooks fail open even though an explicit report worker returns a failure status.
  const env = { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll('\\', '/'))}` }
  const launcher = `const { spawnSync } = require('node:child_process'); const out = spawnSync(process.execPath, ${JSON.stringify(args)}, { input: require('node:fs').readFileSync(0), encoding: 'utf8', windowsHide: true }); if (out.error) throw out.error; process.stdout.write(String(out.status)); process.stderr.write(out.stderr)`
  let firstError
  try {
    const out = await nativeProcess(process.execPath, ['-e', launcher], env, JSON.stringify({ session_id: 'synthetic-report-deadline', title: 'Synthetic report' }))
    assert.equal(out.error, undefined, hookFailure(out))
    assert.equal(out.status, 0, hookFailure(out))
    assert.equal(existsSync(marker), true, `the reporter child must start and hang: ${hookFailure(out)} ${hookLog(f)}`)
    assert.match(hookLog(f), /REPORTER_TIMEOUT/)
    assert.doesNotMatch(hookLog(f), /REPORTER_QUEUED/)
    assert.deepEqual(existsSync(join(f.root, 'pending')) ? readdirSync(join(f.root, 'pending')) : [], [])
    assert.equal(out.stdout, '1', 'the host wrapper must observe the report failure')
  } catch (error) {
    firstError = error
    throw error
  } finally {
    // The hung reporter child outlives its worker; stop it by its own pid.
    try { if (existsSync(marker)) await stopReporter(Number(readFileSync(marker, 'utf8'))) } catch (error) {
      // A child that survives its kill keeps the fixture for a look, and fails the test.
      if (error?.keepFixture) {
        if (firstError !== undefined) {
          error.cause = firstError
          // fixture() prints only the message, so the first failure is named there too.
          error.message += `; first failure: ${firstError?.message ?? firstError}`
        }
        throw error
      }
      process.stderr.write(`report-deadline child not stopped: ${error}\n`)
    }
  }
}))

test('a hook worker that starts just before its deadline still queues an event whose input arrives after it', () => fixture(async f => {
  assert.equal(f.install('--agent', 'gemini', '--apply').status, 0)
  holdAutomaticRecovery(f)
  const worker = join(f.root, 'agent-board-hook.mjs')
  const stampFile = join(f.root, 'deadline-stamp.txt')
  const preload = join(f.home, 'deadline-soon.cjs')
  const readFile = join(f.root, 'read-stamp.txt')
  // The deadline falls 1.5 s after the worker starts; its input arrives after that. The worker
  // stamps when it starts reading, so a worker that only got there after the deadline fails the test.
  f.save(preload, `if (process.argv[1] === ${JSON.stringify(worker)}) {
  const fs = require('node:fs')
  const deadline = Date.now() + 1500
  process.argv.push('--hook-deadline', String(deadline))
  const setEncoding = process.stdin.setEncoding.bind(process.stdin)
  process.stdin.setEncoding = encoding => { fs.writeFileSync(${JSON.stringify(readFile)}, String(Date.now())); return setEncoding(encoding) }
  fs.writeFileSync(${JSON.stringify(stampFile)}, String(deadline))
}
`)
  const argv = ['--hook-version', '1', '--hook-event', 'BeforeAgent', '--agent-status', '--agent', 'gemini', '--state', 'working', '--progress-file', f.progress]
  const child = spawn(process.execPath, [worker, ...argv], { env: { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
  const closed = new Promise((done, reject) => { child.once('close', done); child.once('error', reject) })
  closed.catch(() => {})
  let status
  try {
    const waitUntil = Date.now() + 10000
    while (!existsSync(stampFile) && Date.now() < waitUntil) await new Promise(done => setTimeout(done, 20))
    const deadline = Number(readFileSync(stampFile, 'utf8'))
    while (Date.now() < deadline + 200) await new Promise(done => setTimeout(done, 20))
    child.stdin.end(JSON.stringify({ session_id: 'late-input-session' }))
    status = await Promise.race([closed, new Promise(done => setTimeout(() => done('still running'), 10000))])
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
  assert.equal(status, 0, hookLog(f))
  assert.ok(Number(readFileSync(readFile, 'utf8')) < Number(readFileSync(stampFile, 'utf8')), 'the worker must start reading before its deadline')
  assert.equal(readFileSync(f.progress, 'utf8').includes('agent=gemini'), false)
  const files = pendingFiles(f)
  assert.equal(files.length, 1, hookLog(f))
  assert.match(readFileSync(join(f.root, 'pending', files[0]), 'utf8'), /late-input-session/)
  assert.match(hookLog(f), /gemini REPORTER_QUEUED/)
  assert.doesNotMatch(hookLog(f), /INPUT_TIMEOUT/)
}))

test('a raw entry with an unknown flag or environment variable is dropped, not applied', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const entry = { version: 1, kind: 'raw', at: Date.now(), argv: ['--codex-event', '--agent', 'codex', '--progress-file', f.progress], env: {}, payload: { session_id: 'invalid-raw-session', hook_event_name: 'UserPromptSubmit', turn_id: 'invalid-turn' } }
  for (const [index, bad] of [
    { ...entry, version: 2 },
    { ...entry, kind: 'other' },
    { ...entry, at: -1 },
    { ...entry, at: '1234' },
    { ...entry, argv: [...entry.argv, 1] },
    { ...entry, argv: [...entry.argv, '--unknown', 'value'] },
    { ...entry, env: { NODE_OPTIONS: '--inspect' } },
    { ...entry, env: { GROK_SESSION_ID: 123 } },
    { ...entry, argv: [...entry.argv, '--home', f.home] },
    { ...entry, argv: [...entry.argv, '--agent', 'codex'] },
    { ...entry, argv: ['--codex-report', ...entry.argv.slice(1)] },
    { ...entry, env: { GROK_SESSION_ID: 'wrong-agent-session' } },
    { ...entry, argv: [...entry.argv, '--state'] },
    { ...entry, argv: [...entry.argv, '--state', 'working'] },
    { ...entry, argv: [...entry.argv, '--event', 'UserPromptSubmit'] },
    { ...entry, argv: ['--agent-status', ...entry.argv.slice(1), '--state', 'working'] },
    { ...entry, argv: ['--agent-status', '--agent', 'cursor', '--state', 'working', '--progress-file', f.progress] },
    { ...entry, argv: ['--codex-event', '--agent', 'unknown', '--progress-file', f.progress] },
    { ...entry, argv: ['--codex-event', '--agent', 'codex'] },
    { ...entry, argv: [...entry.argv, '--hook-event', 'UnknownEvent'] },
    { ...entry, argv: ['--codex-event', '--agent', '--codex', '--progress-file', f.progress] },
    { ...entry, at: Date.now() + 120000 },
    { ...entry, argv: ['--agent-status', '--agent', 'antigravity', '--state', 'working', '--event', 'Stop', '--progress-file', f.progress], payload: { conversationId: 'invalid-antigravity-session' } },
  ].entries()) f.save(join(f.root, 'pending', `${index}.raw.json`), JSON.stringify(bad))
  const control = { ...entry, payload: { ...entry.payload, session_id: 'valid-raw-session' } }
  f.save(join(f.root, 'pending', 'valid.raw.json'), JSON.stringify(control))
  assert.equal(f.event('UserPromptSubmit').status, 0)
  assert.deepEqual(pendingFiles(f), [])
  const validOwner = createHash('sha256').update('codex:valid-raw-session').digest('hex')
  const record = JSON.parse(readFileSync(join(f.root, 'sessions', `${validOwner}.json`)))
  assert.equal(record.state, 'working')
  assert.equal(record.turn, 'invalid-turn')
  const owner = createHash('sha256').update('codex:invalid-raw-session').digest('hex')
  assert.equal(existsSync(join(f.root, 'sessions', `${owner}.json`)), false)
  const antigravity = createHash('sha256').update('antigravity:invalid-antigravity-session').digest('hex')
  assert.equal(existsSync(join(f.root, 'sessions', `${antigravity}.json`)), false)
  assert.ok(!readFileSync(f.progress, 'utf8').includes('agent=antigravity'))
}))

test('raw replay classifies board requests and ordinary prompts like live events', () => fixture(f => {
  assert.equal(f.install('--agent', 'gemini', '--apply').status, 0)
  holdAutomaticRecovery(f)
  const worker = join(f.root, 'agent-board-hook.mjs')
  for (const [index, prompt] of ['/agent-board', 'Continue the task'].entries()) {
    const at = Date.now() - 3050
    const sessions = [`live-prompt-session-${index}`, `raw-prompt-session-${index}`]
    for (const session_id of sessions) {
      const report = f.command(['--codex-report', '--agent', 'gemini', '--session', session_id, '--hook-started', String(at - 1000)], { title: 'Question', state: 'waiting', steps: ['- [?] Choose a path'] })
      assert.equal(report.status, 0, report.stderr)
    }
    const args = ['--agent-status', '--agent', 'gemini', '--state', 'working', '--progress-file', f.progress]
    const payload = { session_id: sessions[1], hook_event_name: 'BeforeAgent', prompt }
    const queued = spawnSync(process.execPath, [worker, ...args, '--hook-version', '1', '--hook-event', 'BeforeAgent', '--hook-started', String(at)], { env: f.env, input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 2000 })
    assert.equal(queued.status, 0, queued.stderr)
    const files = pendingFiles(f)
    assert.equal(files.length, 1)
    const raw = JSON.parse(readFileSync(join(f.root, 'pending', files[0])))
    assert.equal(raw.payload.board_request, index === 0)
    assert.equal(raw.payload.prompt, undefined)
    const live = f.command(args, { ...payload, session_id: sessions[0] })
    assert.equal(live.status, 0, live.stderr)
    const records = sessions.map(id => JSON.parse(readFileSync(join(f.root, 'sessions', `${createHash('sha256').update(`gemini:${id}`).digest('hex')}.json`))))
    assert.deepEqual(records[0].steps, records[1].steps)
    assert.equal(records[0].state, records[1].state)
    assert.equal(records[1].state, index === 0 ? 'waiting' : 'working')
    assert.deepEqual(pendingFiles(f), [])
  }
}))

test('raw replay accepts clock skew and removes only old pending temporary files', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const pending = join(f.root, 'pending'), at = Date.now() + 50000
  const raw = { version: 1, kind: 'raw', at, argv: ['--codex-event', '--agent', 'codex', '--progress-file', f.progress], env: {}, payload: { session_id: 'skewed-raw-session', hook_event_name: 'UserPromptSubmit', turn_id: 'skewed-turn', board_request: false } }
  f.save(join(pending, `${at}.raw.json`), JSON.stringify(raw))
  for (const name of ['old.tmp', 'recent.tmp', 'foreign.txt']) f.save(join(pending, name), name)
  mkdirSync(join(pending, 'directory.tmp'))
  const old = new Date(Date.now() - 120000)
  for (const name of ['old.tmp', 'foreign.txt', 'directory.tmp']) utimesSync(join(pending, name), old, old)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const owner = createHash('sha256').update('codex:skewed-raw-session').digest('hex')
  assert.equal(JSON.parse(readFileSync(join(f.root, 'sessions', `${owner}.json`))).appliedAt, at)
  assert.deepEqual(readdirSync(pending).sort(), ['directory.tmp', 'foreign.txt', 'recent.tmp'])
  // A raw entry whose cwd is not a string still applies, with the agent's own title.
  const numeric = { ...raw, at: Date.now(), payload: { session_id: 'numeric-cwd-session', hook_event_name: 'UserPromptSubmit', turn_id: 'numeric-turn', board_request: false, cwd: 42 } }
  f.save(join(pending, `${numeric.at}.raw.json`), JSON.stringify(numeric))
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const numericRecord = JSON.parse(readFileSync(join(f.root, 'sessions', `${createHash('sha256').update('codex:numeric-cwd-session').digest('hex')}.json`)))
  assert.equal(numericRecord.title, 'Local codex task')
}))

test('unchanged status keeps its board timestamp and retries refused session record renames', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const owner = createHash('sha256').update(`gemini:${session}`).digest('hex')
  const recordFile = join(f.root, 'sessions', `${owner}.json`)
  const calls = join(f.root, 'rename-calls.json'), preload = join(f.root, 'record-fault.cjs')
  f.save(preload, `const fs = require('node:fs')\nconst rename = fs.renameSync\nlet count = 0\nfs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(recordFile)}) { fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(++count)); if (count <= 3) throw Object.assign(Error('busy record'), { code: ['EPERM', 'EACCES', 'EBUSY'][count - 1] }) }; return rename(from, to) }\nrequire('node:module').syncBuiltinESMExports()\n`)
  const env = process.platform === 'win32' ? { NODE_OPTIONS: `${f.env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}` } : {}
  const at = Date.now() - 2000
  const status = time => f.command(['--agent-status', '--agent', 'gemini', '--state', 'waiting', '--hook-started', String(time)], { session_id: session }, env)
  const first = status(at)
  assert.equal(first.status, 0, first.stderr)
  if (process.platform === 'win32') assert.equal(JSON.parse(readFileSync(calls)), 4)
  const original = JSON.parse(readFileSync(recordFile)), block = readFileSync(f.progress)
  const next = status(at + 500)
  assert.equal(next.status, 0, next.stderr)
  if (process.platform === 'win32') assert.equal(JSON.parse(readFileSync(calls)), 4)
  assert.deepEqual(JSON.parse(readFileSync(recordFile)), { ...original, appliedAt: at + 500 })
  assert.deepEqual(readFileSync(f.progress), block)
  // A repeat with the same ordering time must not reach even the first rename attempt.
  f.save(calls, '0')
  const repeated = status(at + 500)
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.equal(readFileSync(calls, 'utf8'), '0')
}))

test('a reporter error is logged and the previous block is kept', () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.report().status, 0)
  // The failed run now asks for recovery; a live claim keeps that helper (it would inherit the fault below) from outliving the fixture.
  holdAutomaticRecovery(f)
  const held = readFileSync(f.progress)
  const log = join(f.root, 'hook-errors.log')
  f.save(log, Array.from({ length: 250 }, (_, index) => `synthetic previous error ${index}\n`).join(''))
  const preload = join(f.root, 'write-fault.cjs')
  f.save(preload, `const fs = require('node:fs')\nconst original = fs.renameSync\nfs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(f.progress)}) throw Object.assign(Error('PRIVATE_PATH PRIVATE_TOKEN PRIVATE_INPUT'), { code: 'EIO' }); return original(from, to) }\nrequire('node:module').syncBuiltinESMExports()\n`)
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`
  const out = await fireHook(f, JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'write-fault-turn', prompt: 'PRIVATE_INPUT' }))
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(readFileSync(f.progress), held)
  const errors = readFileSync(log, 'utf8')
  assert.equal(errors.trimEnd().split('\n').length, 200)
  assert.match(errors, /codex REPORTER_FAILED/)
  assert.ok(!errors.includes('PRIVATE_') && !errors.includes(f.home) && !errors.includes(session), errors)
  const partial = await fireHook(f, '{"session_id":')
  assert.equal(partial.status, 0, partial.stderr)
  assert.match(readFileSync(log, 'utf8'), /INCOMPLETE_INPUT/)
  assert.deepEqual(readFileSync(f.progress), held)
}))

test('every host\'s generated hook carries a timeout at or above its minimum', () => fixture(f => {
  const cases = [
    ['codex', ['.codex', 'hooks.json'], 3, 10],
    ['cursor', ['.cursor', 'hooks.json'], 3, 3],
    ['gemini', ['.gemini', 'settings.json'], 5000, 5000],
    ['grok', ['.grok', 'hooks', 'agent-board-local.json'], 5, 10],
    ['muse', ['.config', 'muse', 'settings.json'], 5, 10],
    ['antigravity', ['.gemini', 'config', 'hooks.json'], 3, 3],
  ]
  for (const [agent, relative, minimum, stop] of cases) {
    const installed = f.install('--agent', agent, '--apply')
    assert.equal(installed.status, 0, installed.stderr)
    const config = JSON.parse(readFileSync(join(f.home, ...relative), 'utf8'))
    const hooks = agent === 'antigravity' ? config['agent-board-local'] : config.hooks
    for (const [event, groups] of Object.entries(hooks)) for (const group of groups) {
      const handler = group.hooks?.[0] ?? group
      assert.ok(handler.timeout >= (event === 'Stop' ? stop : minimum), `${agent}:${event}`)
      assert.ok(!/failClosed/.test(JSON.stringify(handler)))
    }
  }
}))

test('a newer hook logs that its reporter needs an upgrade and exits zero', () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  const marker = join(f.root, 'old-reporter-ran')
  // An older board has no hook-version marker; it must never run this command.
  f.save(f.script, `import {writeFileSync} from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'unexpected')\n`)
  const out = await fireHook(f, '{}')
  assert.equal(out.status, 0, out.stderr)
  assert.equal(existsSync(marker), false)
  assert.match(readFileSync(join(f.root, 'hook-errors.log'), 'utf8'), /REPORTER_UPGRADE_REQUIRED/)
}))

test('an expired hook cannot replace progress after synchronous preparation', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.report().status, 0)
  const before = readFileSync(f.progress)
  const marker = join(f.root, 'delay-was-injected')
  const preload = join(f.root, 'delay-progress.cjs')
  f.save(preload, `const fs = require('node:fs')
const write = fs.writeFileSync
fs.writeFileSync = (file, text, ...rest) => {
  if (String(text).includes('Synthetic deadline sentinel')) {
    write(${JSON.stringify(marker)}, 'injected')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500)
  }
  return write(file, text, ...rest)
}
`)
  const result = spawnSync(process.execPath, [f.script, '--codex-report', '--home', f.home, '--hook-deadline', String(Date.now() + 3000)], {
    env: { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll('\\', '/'))}` },
    input: JSON.stringify({ title: 'Synthetic deadline sentinel', state: 'working', steps: ['- [~] Delayed preparation'] }),
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
  assert.equal(existsSync(marker), true, 'exercise the delay before the guarded rename')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /HOOK_TIMEOUT/)
  assert.deepEqual(readFileSync(f.progress), before)
  assert.ok(!readdirSync(f.root).some(name => name.endsWith('.tmp')))
}))

// The OpenCode plugin ends its open sessions as its process exits (#217). A test that loads it
// into this process drops that listener, so the runner's own exit reports nothing.
const dropExitReports = before => {
  for (const listener of process.listeners('exit')) if (!before.includes(listener)) process.removeListener('exit', listener)
  delete globalThis[Symbol.for('agent-board.opencode-open-sessions')]
}

test('SDK metadata and reporter execution share one deadline without a late write', () => fixture(async f => {
  const { home, env, root } = f
  const marker = join(home, 'late-report'), pidFile = join(home, 'reporter.pid')
  const exitListeners = process.listeners('exit')
  let childPid
  try {
    const installed = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'opencode', '--apply'], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    assert.equal(installed.status, 0, installed.stderr)
    // Inspect the original reporter deadline without a separate recovery replay.
    holdAutomaticRecovery(f)
    const source = readFileSync(join(home, '.config', 'opencode', 'plugins', 'agent-board-local.js'), 'utf8')
    const stub = 'const tool = Object.assign(value => value, { schema: { string: () => ({ describe: () => ({}) }), enum: () => ({}), array: () => ({}) } })'
    const plugin = join(home, 'synthetic-plugin.mjs')
    writeFileSync(plugin, source.replace("import { tool } from '@opencode-ai/plugin'", stub))
    writeFileSync(join(root, 'agent-board.mjs'), `globalThis.AGENT_BOARD = {"hookVersion":1,"synthetic":true}\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'late'), 1600)\n`)
    const { AgentBoardLocal } = await import(pathToFileURL(plugin))
    const adapter = await AgentBoardLocal({ client: { session: { get: async () => {
      // Leave room to start the real child on Windows; 600 + 1600 still
      // exceeds the same 2000 ms shared deadline without changing its policy.
      await new Promise(resolve => setTimeout(resolve, 600))
      return { data: { id: 'synthetic-deadline-session' } }
    } } } })
    await adapter.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-deadline-session' } } })
    assert.equal(existsSync(pidFile), true, 'exercise both metadata and a real reporter child')
    childPid = Number(readFileSync(pidFile, 'utf8'))
    assert.equal(isReporterAlive(childPid), false, 'the worker reaps its reporter before returning')
    await new Promise(resolve => setTimeout(resolve, 1700))
    assert.equal(existsSync(marker), false)
    assert.match(readFileSync(join(root, 'hook-errors.log'), 'utf8'), /REPORTER_TIMEOUT/)
  } finally {
    dropExitReports(exitListeners)
    if (childPid === undefined && existsSync(pidFile)) childPid = Number(readFileSync(pidFile, 'utf8'))
    await stopReporter(childPid)
  }
}))

test('an unavailable hook worker or log still returns without exposing reporter details', () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  rmSync(join(f.root, 'agent-board-hook.mjs'))
  const missing = await fireHook(f, '{}')
  assert.equal(missing.status, 0, missing.stderr)
  const log = join(f.root, 'hook-errors.log')
  assert.match(readFileSync(log, 'utf8'), /HOOK_WORKER_UNAVAILABLE/)
  rmSync(log)
  mkdirSync(log)
  const unwritable = await fireHook(f, '{}')
  assert.equal(unwritable.status, 0, unwritable.stderr)
  assert.equal(unwritable.stderr.trim(), 'AGENT_BOARD_HOOK_LOG_FAILED')
  assert.ok(!unwritable.stderr.includes(f.home))
  // Cursor still needs its empty JSON response when its worker cannot load.
  rmSync(log, { recursive: true })
  assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
  rmSync(join(f.root, 'agent-board-hook.mjs'))
  const cursorConfig = JSON.parse(readFileSync(join(f.home, '.cursor', 'hooks.json'), 'utf8'))
  const command = cursorConfig.hooks.sessionStart[0].command
  const cursor = await fireCommand(f, command, '{}')
  assert.equal(cursor.status, 0, cursor.stderr)
  assert.equal(cursor.stdout.trim(), '{}')
}))

const legacyReporterProbe = (isPowerShell = process.platform === 'win32', shell = '/bin/sh') => fixture(async f => {
  const home = f.home
  const root = join(home, '.claude'), inbox = join(root, 'progress-inbox')
  const isWindows = process.platform === 'win32'
  const script = join(root, isPowerShell ? 'progress-report.ps1' : 'progress-report.sh')
  const executable = isPowerShell ? 'powershell.exe' : shell
  const args = isPowerShell ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'cursor', 'turn'] : [script.replaceAll('\\', '/'), 'cursor', 'turn']
  const env = isolatedEnv(home)
  if (isWindows && !isPowerShell) {
    env.HOME = home.replaceAll('\\', '/')
    // A spread Windows environment commonly has `Path`, not the `PATH` getter
    // offered by process.env. Keep one key and preserve its complete value.
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
    const inheritedPath = pathKey === undefined ? '' : env[pathKey]
    if (pathKey !== undefined) delete env[pathKey]
    env.PATH = `${dirname(executable)}${delimiter}${inheritedPath}`
  }
  mkdirSync(root, { recursive: true })
  writeFileSync(script, isPowerShell ? reporterPs1() : reporterSh(inbox.replaceAll('\\', '/')))
  const payload = '{"session_id":"synthetic-legacy-session","id":1234567890123456789}'
  // Only bounds a hung process on a slow Windows CI runner; the reporter's own deadline is not timed here.
  const first = await nativeProcess(executable, args, env, payload, callback => setTimeout(callback, 30000))
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.stdout.trim(), '{}')
  const delivered = existsSync(inbox) ? readdirSync(inbox).filter(name => name.endsWith('.json')) : []
  const codes = hookLog(f).match(/\b(?:INPUT_TIMEOUT|INCOMPLETE_INPUT|INPUT_TOO_LARGE|REPORTER_TIMEOUT|REPORTER_FAILED)\b/g) ?? []
  assert.equal(delivered.length, 1, `${hookFailure(first)}; hookCodes=${codes.slice(-5).join(',')}`)
  assert.equal(readFileSync(join(inbox, delivered[0]), 'utf8'), payload)
  const log = join(home, '.agent-board', 'hook-errors.log')
  mkdirSync(dirname(log), { recursive: true })
  writeFileSync(log, Array.from({ length: 250 }, (_, index) => `synthetic old error ${index}\n`).join(''))
  const unfinished = await nativeProcess(executable, args, env, '{"PRIVATE_UNFINISHED_INPUT":',
    // Only bounds a hung process on a slow Windows CI runner; the reporter's own deadline is not timed here.
    callback => setTimeout(callback, 30000), stopNativeTree, { isInputOpen: true })
  assert.equal(unfinished.status, 0, hookFailure(unfinished))
  assert.equal(unfinished.stdout.trim(), '{}')
  assert.deepEqual(readdirSync(inbox).filter(name => name.endsWith('.json')), delivered)
  assert.ok(!readdirSync(inbox).some(name => /\.tmp$|\.timeout$/.test(name)))
  const errors = readFileSync(log, 'utf8')
  assert.equal(errors.trimEnd().split('\n').length, 200)
  assert.match(errors, /INPUT_TIMEOUT/)
  assert.ok(!errors.includes('PRIVATE_') && !errors.includes(home), errors)
})

test('legacy reporters bound an unfinished input and keep Cursor responses and errors local', () => legacyReporterProbe())

test('a completed prompt survives watchdog cancellation before its trap is ready', { skip: process.platform === 'win32' }, () => fixture(async f => {
  const inbox = join(f.root, 'progress-inbox'), script = join(f.root, 'progress-report.sh')
  const tools = join(f.home, 'tools'), ready = join(f.home, 'watcher-ready'), stopped = join(f.home, 'watcher-stopped')
  const watcherPid = join(f.home, 'watcher.pid'), sleeperPid = join(f.home, 'sleeper.pid')
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
  f.save(join(tools, 'node'), '#!/bin/sh\nexit 17\n')
  chmodSync(join(tools, 'node'), 0o700)
  // Force cancellation into the proven startup window. Only this synthetic
  // copy ignores TERM; the real deadline and completion protocol stay intact.
  const original = reporterSh(inbox)
  const startup = "(\n  sleeper=''; stopped=''"
  const stop = 'kill "$watcher"; wait "$watcher"; watcher=\'\''
  assert.ok(original.includes(startup) && original.includes(stop))
  const source = original
    .replace(startup, `(\n  trap '' 15\n  : > ${shellQuote(ready)}\n  while [ ! -f ${shellQuote(stopped)} ]; do sleep 0.01; done\n  sleeper=''; stopped=''`)
    .replace('watcher=$!', `watcher=$!\nprintf '%s' "$watcher" > ${shellQuote(watcherPid)}\nwhile [ ! -f ${shellQuote(ready)} ]; do sleep 0.01; done`)
    .replace('  sleeper=$!', `  sleeper=$!\n  printf '%s' "$sleeper" > ${shellQuote(sleeperPid)}`)
    .replace(stop, `kill "$watcher"; : > ${shellQuote(stopped)}; wait "$watcher"; watcher=''`)
  f.save(script, source)
  const payload = JSON.stringify({ session_id: 'synthetic-cancellation', prompt: 'PRIVATE_RAW_PROMPT' })
  try {
    const out = await nativeProcess('/bin/sh', [script, 'cursor', 'prompt', payload],
      { ...f.env, PATH: `${tools}${delimiter}${f.env.PATH}` }, '', callback => setTimeout(callback, 10000))
    assert.equal(out.error, undefined, hookFailure(out))
    assert.equal(out.status, 0, hookFailure(out))
    assert.equal(out.stdout.trim(), '{}')
    assert.equal(existsSync(stopped), true, 'exercise cancellation before watchdog initialization')
    assert.equal(existsSync(watcherPid), true)
    for (const file of [watcherPid, sleeperPid]) if (existsSync(file)) assert.equal(isReporterAlive(Number(readFileSync(file, 'utf8'))), false)
    const receipts = readdirSync(inbox)
    assert.equal(receipts.length, 1, 'only the completed receipt remains, not owned temporary files')
    assert.ok(receipts[0].endsWith('.json'))
    assert.equal(readFileSync(join(inbox, receipts[0]), 'utf8'), payload)
    assert.equal(existsSync(join(f.root, 'hook-errors.log')), false)
  } finally {
    for (const file of [watcherPid, sleeperPid]) if (existsSync(file)) await stopReporter(Number(readFileSync(file, 'utf8')))
  }
}))

test('the PowerShell classifier uses the first Node path when several applications match', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  const later = join(f.home, 'later node'), inbox = join(f.root, 'progress-inbox')
  mkdirSync(later)
  // A later lookup entry is deliberately not executable: it must never run.
  writeFileSync(join(later, 'node.exe'), 'synthetic later application must not run')
  const env = { ...f.env }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = [dirname(process.execPath), later].join(delimiter)
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // Only bounds a hung process on a slow Windows CI runner; the reporter's own deadline is not timed here.
  const lookup = spawnSync(powershell, ['-NoProfile', '-Command', '$c = @(Get-Command node -CommandType Application -ErrorAction Stop); $c.Count'], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(lookup.error, undefined)
  assert.equal(lookup.status, 0, 'the controlled application lookup must succeed')
  assert.equal(lookup.stdout.trim(), '2', 'two real node.exe files on PATH, not a mocked lookup')
  const file = join(f.root, 'progress-report.ps1'), diagnostic = join(f.home, 'classifier-probe.txt')
  const raw = JSON.stringify({ session_id: 'synthetic-multiple-node', cwd: '/synthetic/中文', prompt: '/board' })
  // The reporter walks PATH itself (Get-Command can spend over a second on a missing Node)
  // and must start the first match: the later, non-executable node.exe never runs.
  const source = reporterPs1()
  assert.doesNotMatch(source, /Get-Command node/)
  // Expire the input-stage clock so this case exercises selection in its own scope.
  const selectionSource = source.replace('    $receipt = Read-PromptReceipt $tmp $clock',
    '    Start-Sleep -Milliseconds 2100\n    $receipt = Read-PromptReceipt $tmp $clock')
  f.save(file, observeClassifier(selectionSource, diagnostic, { isSelectionOnly: true }))
  // Only bounds a hung process on a slow Windows CI runner; the reporter's own deadline is not timed here.
  const result = await nativeProcess(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, 'codex', 'prompt'], env, raw, callback => setTimeout(callback, 30000))
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, classifierDiagnostic(diagnostic))
  const saved = existsSync(inbox) ? readdirSync(inbox).filter(name => name.endsWith('.json')).map(name => ({ body: readFileSync(join(inbox, name), 'utf8') })) : []
  assert.equal(saved.length, 1, classifierDiagnostic(diagnostic))
  assert.match(classifierDiagnostic(diagnostic), /phase=complete started=1/)
  assert.deepEqual(JSON.parse(saved[0].body), { session_id: 'synthetic-multiple-node', cwd: '/synthetic/中文', board_request: true })
  assert.ok(!/[^\x20-\x7e]/.test(saved[0].body))
}))

test('the PowerShell reporter never looks for Node in its working folder through an empty or relative PATH entry', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  const work = join(f.home, 'project'), inbox = join(f.root, 'progress-inbox')
  mkdirSync(work)
  // A node.exe in the folder the hook runs in is not an application: starting it would fail.
  writeFileSync(join(work, 'node.exe'), 'synthetic project file must not run')
  const env = { ...f.env }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = ['""', '.', 'relative-folder', dirname(process.execPath)].join(delimiter)
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const file = join(f.root, 'progress-report.ps1'), diagnostic = join(f.home, 'classifier-probe.txt')
  const raw = JSON.stringify({ session_id: 'synthetic-working-folder', cwd: '/synthetic/project', prompt: '/board' })
  f.save(file, observeClassifier(reporterPs1(), diagnostic, { isSelectionOnly: true }))
  // Only bounds a hung process on a slow Windows CI runner; the reporter's own deadline is not timed here.
  const result = await nativeProcess(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, 'codex', 'prompt'], env, raw, callback => setTimeout(callback, 30000), undefined, { cwd: work })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, classifierDiagnostic(diagnostic))
  const saved = existsSync(inbox) ? readdirSync(inbox).filter(name => name.endsWith('.json')).map(name => readFileSync(join(inbox, name), 'utf8')) : []
  assert.equal(saved.length, 1, classifierDiagnostic(diagnostic))
  assert.deepEqual(JSON.parse(saved[0]), { session_id: 'synthetic-working-folder', cwd: '/synthetic/project', board_request: true })
}))

test('legacy prompt classifiers time out and reap their process without promoting raw receipts', () => fixture(async f => {
  const isWindows = process.platform === 'win32'
  const inbox = join(f.root, 'progress-inbox'), script = join(f.root, isWindows ? 'progress-report.ps1' : 'progress-report.sh')
  const pidFile = join(f.home, 'classifier.pid'), preload = join(f.home, 'hang-classifier.cjs')
  const diagnostic = join(f.home, 'classifier-probe.txt')
  f.save(script, isWindows ? observeClassifier(reporterPs1(), diagnostic) : reporterSh(inbox))
  f.save(preload, `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`)
  const env = { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll('\\', '/'))}` }
  const args = isWindows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'cursor', 'prompt'] : [script, 'cursor', 'prompt']
  try {
    const out = await nativeProcess(isWindows ? 'powershell.exe' : '/bin/sh', args, env,
      JSON.stringify({ session_id: 'synthetic-classifier-timeout', prompt: 'PRIVATE_RAW_PROMPT' }),
      // Only bounds a hung process on a slow Windows CI runner; the reporter's own deadline is not timed here.
      callback => setTimeout(callback, 30000))
    assert.equal(out.error, undefined, hookFailure(out))
    assert.equal(out.status, 0, hookFailure(out))
    assert.equal(out.stdout.trim(), '{}')
    assert.equal(existsSync(pidFile), true, `exercise the real classifier process${isWindows ? ': ' + classifierDiagnostic(diagnostic) : ''}`)
    assert.equal(isReporterAlive(Number(readFileSync(pidFile, 'utf8'))), false)
    const files = readdirSync(inbox)
    assert.equal(files.length, 1)
    assert.ok(files[0].endsWith('.json'))
    const body = readFileSync(join(inbox, files[0]), 'utf8')
    assert.deepEqual(JSON.parse(body), { session_id: 'synthetic-classifier-timeout' })
    assert.ok(!body.includes('PRIVATE_'))
    const log = readFileSync(join(f.root, 'hook-errors.log'), 'utf8')
    assert.match(log, /REPORTER_TIMEOUT/)
    assert.ok(!log.includes('PRIVATE_') && !log.includes(f.home))
  } finally {
    if (existsSync(pidFile)) await stopReporter(Number(readFileSync(pidFile, 'utf8')))
  }
}))

for (const isWindows of [false, true]) test(`the ${isWindows ? 'PowerShell' : 'sh'} reporter logs REPORTER_FAILED when its timeout receipt cannot be saved`, { skip: isWindows !== (process.platform === 'win32') }, () => fixture(async f => {
  const inbox = join(f.root, 'progress-inbox'), script = join(f.root, isWindows ? 'progress-report.ps1' : 'progress-report.sh')
  const pidFile = join(f.home, 'classifier.pid'), preload = join(f.home, 'hang-classifier.cjs')
  let source = isWindows ? reporterPs1() : reporterSh(inbox)
  const env = { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll('\\', '/'))}` }
  const stale = join(f.root, 'hook-errors.log.111.tmp'), fresh = join(f.root, 'hook-errors.log.222.tmp')
  if (isWindows) {
    const anchor = '      Move-Item -LiteralPath $fallbackTmp'
    assert.equal(source.split(anchor).length, 2, 'fallback move anchor must be unique')
    source = source.replace(anchor, () => "      throw 'SYNTHETIC_FALLBACK_FAILURE'\n" + anchor)
    f.save(stale, 'stale'); f.save(fresh, 'fresh')
    const old = new Date(Date.now() - 300000)
    utimesSync(stale, old, old)
  } else {
    const mv = spawnSync('/bin/sh', ['-c', 'command -v mv'], { encoding: 'utf8' })
    assert.equal(mv.status, 0, mv.stderr)
    const tools = join(f.home, 'tools'), shim = join(tools, 'mv')
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`
    f.save(shim, `#!/bin/sh\nfor arg do case "$arg" in *.fallback) exit 1 ;; esac; done\nexec ${quote(mv.stdout.trim())} "$@"\n`)
    chmodSync(shim, 0o700)
    env.PATH = `${tools}${delimiter}${env.PATH}`
  }
  f.save(script, source)
  f.save(preload, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`)
  try {
    const args = isWindows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'codex', 'prompt'] : [script, 'codex', 'prompt']
    const out = await nativeProcess(isWindows ? 'powershell.exe' : '/bin/sh', args, env, JSON.stringify({ session_id: 'synthetic-failed-fallback', prompt: 'PRIVATE_RAW_PROMPT' }))
    assert.equal(out.error, undefined, hookFailure(out))
    assert.equal(out.status, 0, hookFailure(out))
    assert.equal(existsSync(pidFile), true, 'exercise the hung classifier')
    assert.equal(isReporterAlive(Number(readFileSync(pidFile, 'utf8'))), false)
    assert.deepEqual(readdirSync(inbox), [])
    const log = hookLog(f)
    assert.match(log, /REPORTER_FAILED[\s\S]*REPORTER_TIMEOUT/)
    assert.doesNotMatch(log, /PRIVATE_/)
    if (isWindows) {
      assert.equal(existsSync(stale), false)
      assert.equal(existsSync(fresh), true)
      rmSync(join(f.root, 'hook-errors.log'))
      rmSync(pidFile)
      const anchor = '      $metadata = New-Object Collections.Specialized.OrderedDictionary'
      const source = reporterPs1()
      assert.equal(source.split(anchor).length, 2, 'metadata build anchor must be unique')
      f.save(script, source.replace(anchor, () => "      throw 'SYNTHETIC_METADATA_FAILURE'\n" + anchor))
      const out = await nativeProcess('powershell.exe', args, env, JSON.stringify({ session_id: 'synthetic-metadata-failure', prompt: 'PRIVATE_RAW_PROMPT' }))
      assert.equal(out.error, undefined, hookFailure(out))
      assert.equal(out.status, 0, hookFailure(out))
      assert.equal(existsSync(pidFile), true, 'exercise the classifier after a metadata failure')
      assert.equal(isReporterAlive(Number(readFileSync(pidFile, 'utf8'))), false)
      assert.deepEqual(readdirSync(inbox), [])
      assert.match(hookLog(f), /REPORTER_FAILED[\s\S]*REPORTER_TIMEOUT/)
    }
  } finally {
    if (existsSync(pidFile)) await stopReporter(Number(readFileSync(pidFile, 'utf8')))
  }
}))

test('a reporter sweeps scratch files older than a minute from the inbox and keeps fresh ones', () => fixture(async f => {
  const isWindows = process.platform === 'win32'
  const inbox = join(f.root, 'progress-inbox'), script = join(f.root, isWindows ? 'progress-report.ps1' : 'progress-report.sh')
  const old = new Date(Date.now() - 300000)
  const names = ['tmp', 'receipt', 'fallback', 'timeout', 'complete'].map(suffix => `codex-prompt-1-1.${suffix}`)
  for (const name of [...names, 'notes.txt']) { const file = join(inbox, name); f.save(file, 'stale'); utimesSync(file, old, old) }
  f.save(join(inbox, 'codex-prompt-1-2.tmp'), 'fresh')
  // On Windows, a scratch file another program holds open cannot be removed: that is logged, and the receipt is still saved.
  // 0x10000000 is libuv's exclusive-open flag, which Node does not name.
  const held = join(inbox, 'codex-prompt-1-3.tmp')
  f.save(held, 'held'); utimesSync(held, old, old)
  f.save(script, isWindows ? reporterPs1() : reporterSh(inbox))
  const args = isWindows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'codex', 'prompt'] : [script, 'codex', 'prompt']
  const lock = isWindows ? openSync(held, 0x10000000) : undefined
  let out
  try {
    out = await nativeProcess(isWindows ? 'powershell.exe' : '/bin/sh', args, f.env, JSON.stringify({ session_id: 'synthetic-scratch-sweep', prompt: 'PRIVATE_RAW_PROMPT' }))
  } finally {
    if (lock !== undefined) closeSync(lock)
  }
  assert.equal(out.error, undefined, hookFailure(out))
  assert.equal(out.status, 0, hookFailure(out))
  const files = readdirSync(inbox)
  for (const name of names) assert.equal(files.includes(name), false, name)
  assert.equal(files.includes('codex-prompt-1-2.tmp'), true)
  assert.equal(files.includes('notes.txt'), true)
  assert.equal(files.filter(name => name.endsWith('.json')).length, 1)
  assert.equal(files.includes('codex-prompt-1-3.tmp'), isWindows)
  if (isWindows) assert.match(hookLog(f), /CLEANUP_FAILED/)
  else assert.doesNotMatch(hookLog(f), /CLEANUP_FAILED/)
}))

test('the sh reporter logs CLEANUP_FAILED when its sweep fails, but not for a file that went mid-scan', { skip: process.platform === 'win32' }, () => fixture(async f => {
  const inbox = join(f.root, 'progress-inbox'), script = join(f.root, 'progress-report.sh'), tools = join(f.home, 'sweep-tools')
  const locale = join(f.home, 'sweep-locale')
  f.save(script, reporterSh(inbox))
  mkdirSync(tools, { recursive: true })
  // A stand-in find on PATH says what a real one would, and fails.
  const sweep = async (complaint, session) => {
    // Only the sweep that removes files records its locale: the counted age look runs after it.
    f.save(join(tools, 'find'), `#!/bin/sh\ncase " $* " in *" -exec "*) printf '%s' "$LC_ALL" > "$HOME/sweep-locale" ;; esac\n${complaint ? `printf '%s\\n' '${complaint}' >&2\n` : ''}exit 1\n`)
    chmodSync(join(tools, 'find'), 0o700)
    const out = await nativeProcess('/bin/sh', [script, 'codex', 'prompt'], { ...f.env, LC_ALL: 'POSIX', PATH: `${tools}${delimiter}${f.env.PATH}` }, JSON.stringify({ session_id: session, prompt: 'PRIVATE_RAW_PROMPT' }))
    assert.equal(out.error, undefined, hookFailure(out))
    assert.equal(out.status, 0, hookFailure(out))
    assert.equal(readFileSync(locale, 'utf8'), 'C', 'find complaints must use the English locale')
    return hookLog(f).match(/CLEANUP_FAILED/g)?.length ?? 0
  }
  // GNU and BSD find say this for an entry another session removed or renamed after the listing.
  assert.equal(await sweep('find: /inbox/codex-turn-1-1.json.taking: No such file or directory', 'synthetic-sweep-gone'), 0)
  assert.equal(await sweep('find: /inbox: Permission denied', 'synthetic-sweep-denied'), 1)
  assert.equal(await sweep('', 'synthetic-sweep-silent'), 2)
  assert.equal(await sweep('find: /inbox/codex-turn-1-1.json.taking: No such file or directory\nfind: /inbox: Permission denied', 'synthetic-sweep-mixed'), 3)
  // Each run still saved its receipt.
  assert.equal(readdirSync(inbox).filter(name => name.endsWith('.json')).length, 4)
}))

test('a timed-out prompt classifier saves a metadata receipt that marks a board request but not a folder named agent-board', () => fixture(async f => {
  const isWindows = process.platform === 'win32'
  const inbox = join(f.root, 'progress-inbox'), script = join(f.root, isWindows ? 'progress-report.ps1' : 'progress-report.sh')
  const pidFile = join(f.home, 'classifier.pid'), preload = join(f.home, 'hang-classifier.cjs')
  const exitProof = join(f.home, 'classifier-exit.json')
  f.save(script, isWindows ? observeClassifierExit(reporterPs1(), exitProof) : reporterSh(inbox))
  f.save(preload, `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`)
  const env = { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll('\\', '/'))}` }
  const args = isWindows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'cursor', 'prompt'] : [script, 'cursor', 'prompt']
  // Only the words outside the folder paths count: a project folder named agent-board is no board request.
  // The sh reporter keeps only plain ASCII values; PowerShell keeps every value.
  // `kept` lists keys in the receipt's order (RECEIPT_KEYS); the POSIX check also compares the bytes.
  const grok = { hookEventName: 'UserPromptSubmit' }
  const cases = [
    { payload: { cwd: '/synthetic/中文', prompt: '/board', transcript_path: '/synthetic/中文/PRIVATE_TRANSCRIPT.jsonl' }, kept: isWindows ? { cwd: '/synthetic/中文' } : {}, isBoard: true },
    { payload: { cwd: '/synthetic/中文', prompt: 'PRIVATE_RAW_PROMPT', transcript_path: '/synthetic/中文/PRIVATE_TRANSCRIPT.jsonl' }, kept: isWindows ? { cwd: '/synthetic/中文' } : {} },
    { payload: { cwd: '/synthetic/agent-board', prompt: 'PRIVATE_RAW_PROMPT', transcript_path: '/synthetic/agent-board/PRIVATE_TRANSCRIPT.jsonl' }, kept: { cwd: '/synthetic/agent-board' } },
    { payload: { cwd: 'C:\\synthetic\\agent-board', prompt: 'PRIVATE_RAW_PROMPT', transcript_path: 'C:\\synthetic\\agent-board\\PRIVATE_TRANSCRIPT.jsonl' }, kept: isWindows ? { cwd: 'C:\\synthetic\\agent-board' } : {} },
    // Grok Build sends camelCase fields, and the inbox knows it by its workspaceRoot field.
    { key: 'sessionId', payload: { ...grok, workspaceRoot: '/synthetic/agent-board', transcriptPath: '/synthetic/agent-board/PRIVATE_TRANSCRIPT.jsonl', prompt: 'PRIVATE_RAW_PROMPT' }, kept: { workspaceRoot: '/synthetic/agent-board', ...grok } },
    { key: 'sessionId', payload: { ...grok, workspaceRoot: '/synthetic/中文', prompt: 'PRIVATE_RAW_PROMPT' }, kept: { workspaceRoot: isWindows ? '/synthetic/中文' : '', ...grok } },
    { payload: { extra: { cwd: 'a"b' }, cwd: '/synthetic/later plain *', prompt: 'PRIVATE_RAW_PROMPT' }, kept: { cwd: '/synthetic/later plain *' } },
    { payload: { hookEventName: 'UserPromptSubmit', hook_event_name: 'UserPromptSubmit', directory: '/synthetic/dir *', project_dir: '/synthetic/project', workspace: '/synthetic/work', workspaceRoot: '/synthetic/root', cwd: '/synthetic/cwd', conversationId: 'synthetic-conversation', conversation_id: 'synthetic-conversation-underscore', 'thread-id': 'synthetic-thread-dash', thread_id: 'synthetic-thread', extra: { sessionID: 'synthetic-upper' }, sessionId: 'synthetic-camel', prompt: 'PRIVATE_RAW_PROMPT' }, kept: { sessionId: 'synthetic-camel', sessionID: 'synthetic-upper', 'thread-id': 'synthetic-thread-dash', thread_id: 'synthetic-thread', conversation_id: 'synthetic-conversation-underscore', conversationId: 'synthetic-conversation', cwd: '/synthetic/cwd', workspaceRoot: '/synthetic/root', workspace: '/synthetic/work', project_dir: '/synthetic/project', directory: '/synthetic/dir *', hook_event_name: 'UserPromptSubmit', hookEventName: 'UserPromptSubmit' } },
    { key: null, payload: { cwd: '/synthetic/project', prompt: 'PRIVATE_RAW_PROMPT' } },
  ]
  for (const [index, { key = 'session_id', payload, kept, isBoard = false }] of cases.entries()) {
    const session = `synthetic-timeout-${index}`
    rmSync(pidFile, { force: true })
    rmSync(exitProof, { force: true })
    rmSync(join(f.root, 'hook-errors.log'), { force: true })
    let isGone = false
    try {
      const out = await nativeProcess(isWindows ? 'powershell.exe' : '/bin/sh', args, env,
        JSON.stringify({ ...(key === null ? {} : { [key]: session }), ...payload }),
        callback => setTimeout(callback, 30000))
      assert.equal(out.error, undefined, hookFailure(out))
      assert.equal(out.status, 0, hookFailure(out))
      assert.equal(out.stdout.trim(), '{}')
      assert.equal(existsSync(pidFile), true, `exercise the real classifier process, case ${index}: ${hookLog(f)}`)
      if (isWindows) assertClassifierExited(exitProof)
      else assert.equal(isReporterAlive(Number(readFileSync(pidFile, 'utf8'))), false)
      isGone = true
      const files = readdirSync(inbox)
      const log = hookLog(f)
      assert.match(log, /REPORTER_TIMEOUT/)
      assert.doesNotMatch(log, /REPORTER_FAILED/)
      if (key === null) { assert.deepEqual(files, []); continue }
      assert.equal(files.length, 1)
      assert.ok(files[0].endsWith('.json'))
      const body = readFileSync(join(inbox, files[0]), 'utf8')
      assert.doesNotMatch(body, /[^\x20-\x7e]|PRIVATE_|\/board|transcript_path|transcriptPath/)
      const expected = { [key]: session, ...kept, ...(isBoard ? { board_request: true } : {}) }
      assert.deepEqual(JSON.parse(body), expected, `case ${index}`)
      assert.deepEqual(Object.keys(JSON.parse(body)), Object.keys(expected), `key order, case ${index}`)
      if (!isWindows) assert.equal(body, JSON.stringify(expected), `raw case ${index}`)
      rmSync(join(inbox, files[0]))
    } finally {
      if (!isGone && existsSync(pidFile)) await stopReporter(Number(readFileSync(pidFile, 'utf8')))
    }
  }
}))

test('a classifier interrupted while publishing its PID marker still proves its owned process exited', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  const script = join(f.root, 'progress-report.ps1'), pidFile = join(f.home, 'classifier.pid')
  const exitProof = join(f.home, 'classifier-exit.json'), preload = join(f.home, 'partial-classifier-pid.cjs')
  f.save(script, observeClassifierExit(reporterPs1(), exitProof))
  f.save(preload, `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(pidFile)}, '')\nsetTimeout(() => fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)), 3000)\nsetInterval(() => {}, 1000)\n`)
  const env = { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll('\\', '/'))}` }
  const out = await nativeProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'cursor', 'prompt'], env,
    JSON.stringify({ session_id: 'synthetic-partial-pid', prompt: 'PRIVATE_RAW_PROMPT' }))
  assertClassifierExited(exitProof)
  assert.equal(out.error, undefined, hookFailure(out))
  assert.equal(out.status, 0, hookFailure(out))
  assert.equal(out.stdout.trim(), '{}')
  assert.equal(readFileSync(pidFile, 'utf8'), '')
  const inbox = join(f.root, 'progress-inbox')
  const files = readdirSync(inbox)
  assert.equal(files.length, 1)
  assert.deepEqual(JSON.parse(readFileSync(join(inbox, files[0]), 'utf8')), { session_id: 'synthetic-partial-pid' })
  assert.match(hookLog(f), /REPORTER_TIMEOUT/)
}))

test('a delayed input and hung prompt classifier share one deadline without promoting a raw receipt', { skip: process.platform === 'win32' }, () => fixture(async f => {
  const inbox = join(f.root, 'progress-inbox'), script = join(f.root, 'progress-report.sh')
  const tools = join(f.home, 'tools'), pidFile = join(f.home, 'classifier.pid'), late = join(f.home, 'late-classifier')
  const cat = spawnSync('/bin/sh', ['-c', 'command -v cat'], { encoding: 'utf8' })
  assert.equal(cat.status, 0, cat.stderr)
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
  f.save(join(tools, 'cat'), `#!/bin/sh\nsleep 1\nexec ${shellQuote(cat.stdout.trim())} "$@"\n`)
  chmodSync(join(tools, 'cat'), 0o700)
  f.save(script, reporterSh(inbox))
  const preload = join(f.home, 'hang-classifier.cjs')
  f.save(preload, `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, 'late'), 1400)\nsetInterval(() => {}, 1000)\n`)
  const env = { ...f.env, PATH: `${tools}${delimiter}${f.env.PATH}`, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }
  try {
    const out = await nativeProcess('/bin/sh', [script, 'cursor', 'prompt'], env,
      JSON.stringify({ session_id: 'synthetic-timeout', prompt: 'PRIVATE_RAW_PROMPT' }),
      callback => setTimeout(callback, 10000))
    assert.equal(out.error, undefined, hookFailure(out))
    assert.equal(out.status, 0, hookFailure(out))
    assert.equal(out.stdout.trim(), '{}')
    assert.equal(existsSync(pidFile), true, 'exercise the classifier after delayed input')
    assert.equal(isReporterAlive(Number(readFileSync(pidFile, 'utf8'))), false)
    assert.equal(existsSync(late), false, 'the classifier must not receive a fresh deadline after input')
    const files = readdirSync(inbox)
    assert.equal(files.length, 1)
    assert.ok(files[0].endsWith('.json'))
    const body = readFileSync(join(inbox, files[0]), 'utf8')
    assert.deepEqual(JSON.parse(body), { session_id: 'synthetic-timeout' })
    assert.ok(!body.includes('PRIVATE_'))
    const log = readFileSync(join(f.root, 'hook-errors.log'), 'utf8')
    assert.match(log, /REPORTER_TIMEOUT/)
    assert.ok(!log.includes('PRIVATE_') && !log.includes(f.home))
  } finally {
    if (existsSync(pidFile)) await stopReporter(Number(readFileSync(pidFile, 'utf8')))
  }
}))

const gitSh = join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'sh.exe')
test('the POSIX reporter bounds a Git Bash reader while host stdin stays open', { skip: process.platform !== 'win32' || !existsSync(gitSh) }, () => legacyReporterProbe(false, gitSh))

test('Codex trust requires an owned installation and an explicit host binary', () => fixture(f => {
  assert.notEqual(f.command(['--codex-trust']).status, 0)
  assert.equal(f.install('--apply').status, 0)
  assert.match(f.command(['--codex-trust', '--json']).stderr, /CODEX_BINARY_REQUIRED/)
}))

test('the installed Codex host grants only six reviewed hashes and preserves unrelated config', { skip: !process.env.AGENT_BOARD_TEST_CODEX }, () => fixture(f => {
  const executable = process.env.AGENT_BOARD_TEST_CODEX
  f.env.CODEX_HOME = join(f.home, '.codex')
  const config = join(f.home, '.codex', 'config.toml')
  const original = '# Keep this comment\n[features]\nhooks = true\n[hooks.state.unrelated]\nenabled = false\n'
  f.save(config, original)
  f.save(f.hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }] } }))
  assert.equal(f.install('--apply').status, 0)
  const args = ['--codex-trust', '--codex-bin', executable]
  const plan = f.command(args)
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(JSON.parse(plan.stdout).changes, 6)
  assert.equal(readFileSync(config, 'utf8'), original)
  const applied = f.command([...args, '--apply'])
  assert.equal(applied.status, 0, applied.stderr)
  assert.equal(JSON.parse(applied.stdout).trusted, 6)
  const saved = readFileSync(config, 'utf8')
  assert.match(saved, /# Keep this comment/)
  assert.match(saved, /\[hooks.state.unrelated\]\nenabled = false/)
  assert.equal((saved.match(/trusted_hash/g) ?? []).length, 6)
  const again = f.command(args)
  assert.equal(again.status, 0, again.stderr)
  assert.equal(JSON.parse(again.stdout).changes, 0)
  assert.equal(JSON.parse(again.stdout).hooks.length, 6)
  const doctor = f.command(['--codex-doctor', '--codex-bin', executable])
  assert.equal(JSON.parse(doctor.stdout).hooksTrusted, true, doctor.stderr)
  assert.equal(JSON.parse(doctor.stdout).connected, 'unverified')
}))

test('Codex-only setup preserves unrelated hooks and refuses edited skill files', () => fixture(f => {
  const unrelated = { hooks: [{ type: 'command', command: 'echo other' }] }
  f.save(f.hooks, JSON.stringify({ other: true, hooks: { Stop: [unrelated] } }))
  assert.equal(f.install('--apply').status, 0)
  let config = JSON.parse(readFileSync(f.hooks))
  assert.equal(config.other, true)
  assert.deepEqual(config.hooks.Stop[0], unrelated)
  writeFileSync(f.skill, 'user edited skill')
  const result = f.install('--apply')
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(f.skill, 'utf8'), 'user edited skill')
}))

test('Codex-only setup respects an explicit progress path and preserves its bytes', () => fixture(f => {
  const path = join(f.home, 'custom', 'board.md')
  f.save(path, 'private manual notes\r\n')
  assert.equal(f.install('--progress-file', path, '--apply').status, 0)
  assert.equal(readFileSync(path, 'utf8'), 'private manual notes\r\n')
  assert.equal(f.command(['--codex-doctor', '--home', f.home]).status, 0)
}))

test('Codex explicit reports bind the current thread and preserve other blocks byte for byte', () => fixture(f => {
  f.install('--apply')
  const foreign = '## Other\r\n<!-- auto session=12345678 agent=dot state=waiting -->\r\n### Keep me\r\n<!-- /auto session=12345678 -->\r\n'
  writeFileSync(f.progress, foreign)
  const first = f.report()
  assert.equal(first.status, 0, first.stderr)
  assert.equal(JSON.parse(first.stdout).session, session)
  assert.ok(readFileSync(f.progress, 'utf8').startsWith(foreign))
  assert.ok(readFileSync(f.progress, 'utf8').includes(` resume=${session} `))
  assert.equal(f.report('waiting', ['- [?] Need a decision']).status, 0)
  assert.equal((readFileSync(f.progress, 'utf8').match(/source=codex-local/g) ?? []).length, 1)
  assert.ok(f.command([]).stdout.includes('Task'))
  assert.equal(f.report('done', ['- [x] Finished']).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /state=done updated=\d{4}-/)
}))

test('Codex cannot mark unfinished work done or inject another Markdown block', () => fixture(f => {
  f.install('--apply')
  assert.notEqual(f.report('done').status, 0)
  assert.equal(readFileSync(f.progress, 'utf8'), '')
  assert.equal(f.command(['--codex-report'], { title: '<!--\n## Fake\n-->', state: 'working', steps: ['- [~] safe'] }).status, 0)
  const text = readFileSync(f.progress, 'utf8')
  assert.equal((text.match(/^<!-- auto /gm) ?? []).length, 1)
  assert.equal((text.match(/^## /gm) ?? []).length, 1)
}))

test('Codex hooks reject unbound sessions and stale turns without changing the board', () => fixture(f => {
  f.install('--apply')
  assert.notEqual(f.event('Stop').status, 0)
  assert.equal(f.event('UserPromptSubmit', 'new-turn').status, 0)
  const before = readFileSync(f.progress, 'utf8')
  assert.notEqual(f.event('Stop', 'old-turn').status, 0)
  assert.equal(readFileSync(f.progress, 'utf8'), before)
  assert.equal(f.event('Stop', 'new-turn').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /state=waiting/)
}))

test('Codex hook replays are no-ops and a Stop never invents task completion', () => fixture(f => {
  f.install('--apply')
  f.event('UserPromptSubmit')
  f.event('Stop')
  const before = readFileSync(f.progress, 'utf8')
  assert.equal(f.event('Stop').status, 0)
  assert.equal(readFileSync(f.progress, 'utf8'), before)
  assert.doesNotMatch(before, /state=done/)
  f.report('done', ['- [x] Finished'])
  f.event('Stop')
  assert.match(readFileSync(f.progress, 'utf8'), /state=done/)
}))

test('native lifecycle events retain a board-confirmed completion in session JSON instead of reopening old steps', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  for (const agent of ['codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity', 'deepseek']) {
    const id = `native-confirm-${agent}-123`
    const report = (state, steps) => f.command(['--codex-report', '--agent', agent, '--session', id], { title: `${agent} task`, state, steps })
    assert.equal(report('ended', ['- [ ] Old task', '- [-] Canceled']).status, 0)
    // An ended block sits on the Stopped shelf, which i opens.
    const confirmed = f.command(['--keys', 'i d'])
    assert.equal(confirmed.status, 0, confirmed.stderr)
    const idle = () => agent === 'codex' || agent === 'cursor'
      ? f.command(['--codex-event', '--agent', agent], { session_id: id, hook_event_name: agent === 'cursor' ? 'stop' : 'Stop', generation_id: 'turn-1', turn_id: 'turn-1' })
      : f.command(['--agent-status', '--agent', agent, '--state', 'waiting'], agent === 'antigravity' ? { conversationId: id } : { session_id: id })
    const idleResult = idle()
    assert.equal(idleResult.status, 0, idleResult.stderr)
    const recordPath = join(f.root, 'sessions', createHash('sha256').update(`${agent}:${id}`).digest('hex') + '.json')
    const record = JSON.parse(readFileSync(recordPath))
    assert.equal(record.state, 'done', agent)
    assert.deepEqual(record.steps, ['- [x] Old task', '- [-] Canceled'], agent)
    const settled = readFileSync(f.progress, 'utf8')
    assert.equal(idle().status, 0)
    assert.equal(readFileSync(f.progress, 'utf8'), settled, agent)
    assert.equal(report('working', ['- [ ] Genuinely new work']).status, 0)
    assert.deepEqual(JSON.parse(readFileSync(recordPath)).steps, ['- [ ] Genuinely new work'], agent)
    assert.equal(report('done', ['- [x] Genuinely new work']).status, 0)
  }
}))

test('Codex lifecycle hooks never retain conversation and approval payloads, and open nothing that is not a Codex history file', () => fixture(f => {
  f.install('--apply')
  const secret = 'DO-NOT-STORE-THIS-PRIVATE-TEXT'
  const transcript = join(f.home, 'nonexistent-transcript')
  assert.equal(f.event('UserPromptSubmit', 'turn-1', { prompt: secret, transcript_path: transcript }).status, 0)
  const result = f.event('PermissionRequest', 'turn-1', { tool_input: { private: secret }, decision: 'allow', last_assistant_message: secret })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(readFileSync(f.progress, 'utf8'), /state=waiting/)
  assert.ok(!readFileSync(f.progress, 'utf8').includes(secret))
  const digest = createHash('sha256').update(`codex:${session}`).digest('hex')
  assert.ok(!readFileSync(join(f.root, 'sessions', `${digest}.json`), 'utf8').includes(secret))
  assert.ok(!existsSync(transcript))
}))

test('Codex reports refuse a colliding or unowned block and do not change it', () => fixture(f => {
  f.install('--apply')
  const id = createHash('sha256').update(`codex:${session}`).digest('hex').slice(0, 8)
  const foreign = `## Other\n<!-- auto session=${id} agent=codex state=working -->\n### Other\n<!-- /auto session=${id} -->\n`
  writeFileSync(f.progress, foreign)
  assert.notEqual(f.report().status, 0)
  assert.equal(readFileSync(f.progress, 'utf8'), foreign)
}))

test('local reports preserve fenced examples and update only the visible owned block', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.report().status, 0)
  const owned = readFileSync(f.progress, 'utf8')
  const examples = `# Format examples\r\n\u0060\u0060\u0060markdown\r\n${owned}\u0060\u0060\u0060\r\n~~~markdown\r\n${owned}~~~\r\n`
  writeFileSync(f.progress, examples)
  const result = f.command(['--codex-report'], { title: 'Visible real task', state: 'working', steps: ['- [~] Visible step'] })
  assert.equal(result.status, 0, result.stderr)
  const first = readFileSync(f.progress, 'utf8')
  assert.ok(first.startsWith(examples))
  assert.match(f.command([]).stdout, /Visible real task/)
  assert.equal(f.report('waiting', ['- [?] Visible decision']).status, 0)
  assert.ok(readFileSync(f.progress, 'utf8').startsWith(examples))
  assert.match(f.command([]).stdout, /Visible decision/)
}))

test('local reports refuse hidden appends without changing progress or session state', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const record = join(f.root, 'sessions', createHash('sha256').update(`codex:${session}`).digest('hex') + '.json')
  for (const ending of ['\u0060\u0060\u0060markdown\nexample\n', '~~~markdown\nexample\n', '<!-- unfinished note\n']) {
    const before = '# Personal notes\r\n' + ending
    writeFileSync(f.progress, before)
    const result = f.report()
    assert.notEqual(result.status, 0, ending)
    assert.match(result.stderr, /BLOCK_NOT_VISIBLE/)
    assert.equal(readFileSync(f.progress, 'utf8'), before)
    assert.ok(!existsSync(record))
  }
  writeFileSync(f.progress, '')
  assert.equal(f.report().status, 0)
  const previous = readFileSync(record, 'utf8')
  writeFileSync(f.progress, '\u0060\u0060\u0060\n')
  assert.notEqual(f.event('Stop').status, 0)
  assert.equal(readFileSync(record, 'utf8'), previous)
  assert.equal(readFileSync(f.progress, 'utf8'), '\u0060\u0060\u0060\n')
}))

test('local reports write in place of their marker line when their end marker is beyond another task block, and leave the other block as it was', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.report().status, 0)
  const owned = readFileSync(f.progress, 'utf8')
  const end = owned.match(/<!-- \/auto session=[a-f0-9]{8} -->/)[0]
  const other = '## Personal\n<!-- auto session=12345678 agent=dot state=waiting -->\n### Keep this task\n- [ ] Keep this step\n<!-- /auto session=12345678 -->\n'
  const before = owned.replace(end, '') + other + end + '\n'
  writeFileSync(f.progress, before)
  const result = f.report('done', ['- [x] Finished'])
  assert.equal(result.status, 0, result.stderr)
  const after = readFileSync(f.progress, 'utf8')
  assert.ok(after.includes(`### Task\n- [x] Finished\n${end}`), after)
  assert.ok(after.endsWith(before.slice(before.indexOf('\n### '))), after)
  assert.ok(after.includes(other), after)
  assert.equal((after.match(/<!-- auto session=/g) ?? []).length, 2, after)
  assert.equal(after.split(end).length - 1, 2, after)
  assert.match(f.command([]).stdout, /Keep this task/)
}))

test('local reports ignore a fenced closing marker while replacing their own complete block', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.report().status, 0)
  const owned = readFileSync(f.progress, 'utf8')
  const end = owned.match(/<!-- \/auto session=[a-f0-9]{8} -->/)[0]
  const before = owned.replace(end, `\u0060\u0060\u0060markdown\n${end}\n\u0060\u0060\u0060\n- [ ] Old step\n${end}`)
  const other = '\n## Personal\n### Preserve manual work\n- [ ] Keep this step\n'
  writeFileSync(f.progress, before + other)
  const result = f.report('waiting', ['- [?] New visible decision'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(readFileSync(f.progress, 'utf8').endsWith(other))
  assert.doesNotMatch(readFileSync(f.progress, 'utf8'), /Old step/)
  const board = f.command([])
  assert.match(board.stdout, /New visible decision/)
  assert.match(board.stdout, /Preserve manual work/)
}))

test('Codex uninstall removes only owned integration files and preserves progress and foreign hooks', () => fixture(f => {
  const other = { hooks: [{ type: 'command', command: 'echo other' }] }
  f.save(f.hooks, JSON.stringify({ hooks: { Stop: [other] } }))
  f.install('--apply')
  f.report()
  const before = readFileSync(f.progress, 'utf8')
  const removed = f.command(['--codex-remove', '--home', f.home, '--apply'])
  assert.equal(removed.status, 0, removed.stderr)
  assert.ok(!existsSync(f.script) && !existsSync(f.skill))
  assert.equal(readFileSync(f.progress, 'utf8'), before)
  assert.deepEqual(JSON.parse(readFileSync(f.hooks)).hooks, { Stop: [other] })
}))

test('Codex setup retains all three interface languages on restart', () => fixture(f => {
  assert.equal(f.install('--lang', 'zh-TW', '--apply').status, 0)
  assert.match(readFileSync(f.skill, 'utf8'), /實際任務進度/)
  const result = f.command(['--codex-doctor', '--home', f.home])
  assert.equal(JSON.parse(result.stdout).ready, true, result.stdout)
}))

test('Cursor initializes independently and binds conversation and generation metadata', () => fixture(async f => {
  assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
  const hooks = JSON.parse(readFileSync(join(f.home, '.cursor', 'hooks.json')))
  assert.equal(hooks.version, 1)
  assert.match(hooks.hooks.sessionStart[0].command, /--agent["']? ["']?cursor/)
  const send = (hook_event_name, generation_id = 'generation-1') => f.command(['--codex-event', '--agent', 'cursor'], { hook_event_name, conversation_id: 'cursor-conversation-123', generation_id, transcript_path: '/never/read', text: 'NEVER_STORE_CURSOR_TEXT' })
  const start = await fireCommand(f, hooks.hooks.sessionStart[0].command, JSON.stringify({ hook_event_name: 'sessionStart', conversation_id: 'cursor-conversation-123', generation_id: 'generation-1' }))
  assert.equal(start.status, 0, start.stderr)
  assert.deepEqual(JSON.parse(start.stdout).env, { AGENT_BOARD_SESSION_ID: 'cursor-conversation-123', AGENT_BOARD_AGENT: 'cursor' })
  assert.equal(send('beforeSubmitPrompt').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /agent=cursor .*state=working/)
  assert.equal(send('stop').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /state=waiting/)
  assert.ok(!readFileSync(f.progress, 'utf8').includes('NEVER_STORE_CURSOR_TEXT'))
  send('beforeSubmitPrompt', 'generation-2')
  assert.notEqual(send('stop', 'generation-1').status, 0)
  assert.deepEqual(JSON.parse(f.install('--agent', 'cursor').stdout).changes, [])
}))

test('removing one agent preserves the shared board and skill used by another agent', () => fixture(async f => {
  f.install('--apply')
  assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
  assert.equal(f.command(['--codex-remove', '--agent', 'cursor', '--apply']).status, 0)
  assert.ok(existsSync(f.script) && existsSync(f.skill) && existsSync(join(f.root, 'agent-board-hook.mjs')))
  assert.equal(f.report().status, 0)
  const remained = await fireHook(f, JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'retained-worker-turn' }))
  assert.equal(remained.status, 0, remained.stderr)
  const record = join(f.root, 'sessions', createHash('sha256').update(`codex:${session}`).digest('hex') + '.json')
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).turn, 'retained-worker-turn')
  assert.equal(f.command(['--codex-remove', '--apply']).status, 0)
  assert.ok(!existsSync(f.script) && !existsSync(f.skill) && !existsSync(join(f.root, 'agent-board-hook.mjs')))
}))

test('a shared installation retains its chosen progress path when another agent joins', () => fixture(f => {
  const chosen = join(f.home, 'existing', 'board.md')
  f.save(chosen, 'Keep this board\n')
  f.install('--progress-file', chosen, '--apply')
  const added = f.install('--agent', 'opencode', '--apply')
  assert.equal(added.status, 0, added.stderr)
  assert.equal(JSON.parse(added.stdout).progress, chosen)
  assert.equal(readFileSync(chosen, 'utf8'), 'Keep this board\n')
  assert.equal(f.install('--apply').status, 0)
  assert.equal(JSON.parse(f.install().stdout).progress, chosen)
}))

test('OpenCode metadata adapter and task tool work without reading messages or Claude', async () => {
  const home = mkdtempSync(join(tmpdir(), 'opencode-adapter-'))
  const exitListeners = process.listeners('exit')
  try {
    const env = isolatedEnv(home)
    const installed = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'opencode', '--apply'], { env, encoding: 'utf8', windowsHide: true })
    assert.equal(installed.status, 0, installed.stderr)
    const plugin = join(home, '.config', 'opencode', 'plugins', 'agent-board-local.js')
    const source = readFileSync(plugin, 'utf8')
    assert.ok(!source.includes('session.messages') && !source.includes('transcript'))
    // A minimal SDK stand-in verifies our adapter only, not OpenCode host discovery.
    const stub = 'const tool = Object.assign(value => value, { schema: { string: () => ({ describe: () => ({}) }), enum: () => ({}), array: () => ({}) } })'
    const testPlugin = join(home, 'adapter-test.mjs')
    writeFileSync(testPlugin, source.replace("import { tool } from '@opencode-ai/plugin'", stub))
    const { AgentBoardLocal } = await import(pathToFileURL(testPlugin))
    const progress = join(home, '.agent-board', 'progress.md')
    const nativeEvent = { event: { type: 'session.status', properties: { sessionID: 'opencode-session-123', status: { type: 'busy' } } } }
    for (const metadata of [{}, {error:true}, {data:{id:'foreign-session'}}, {data:{id:'opencode-session-123',parentID:'parent-session'}}]) {
      const refused = await AgentBoardLocal({client:{session:{get:async()=>metadata}}})
      await refused.event(nativeEvent)
      assert.equal(readFileSync(progress, 'utf8'), '')
    }
    const instance = await AgentBoardLocal({ client: { session: { get: async ({ path }) => ({ data: { id: path.id } }) } } })
    await instance.event(nativeEvent)
    assert.match(readFileSync(progress, 'utf8'), /agent=opencode .*state=working/)
    await instance.tool.agent_board_progress.execute({ title: 'Actual tool context', project: 'OpenCode fixture', state: 'done', steps: ['- [x] Verified adapter'] }, { sessionID: 'opencode-session-123' })
    await instance.event({ event: { type: 'session.idle', properties: { sessionID: 'opencode-session-123' } } })
    assert.match(readFileSync(progress, 'utf8'), /state=done/)
    assert.match(readFileSync(progress, 'utf8'), /Actual tool context/)
    const held = readFileSync(progress)
    let release, deadline
    const slow = await AgentBoardLocal({ client: { session: { get: () => new Promise(resolve => { release = resolve }) } } })
    try {
      await Promise.race([slow.event(nativeEvent), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('SDK hook did not return')), 10000) })])
      assert.deepEqual(readFileSync(progress), held)
      assert.match(readFileSync(join(home, '.agent-board', 'hook-errors.log'), 'utf8'), /opencode REPORTER_TIMEOUT/)
      release({ data: { id: 'opencode-session-123' } })
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(readFileSync(progress), held)
    } finally { clearTimeout(deadline) }
  } finally {
    dropExitReports(exitListeners)
    rmSync(home, { recursive: true, force: true })
  }
})

const opencodeSpawnFixture = async (standIn, check, host = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'opencode-timeout-'))
  const probe = { calls: [], run: standIn }
  globalThis.agentBoardOpenCodeSpawn = probe
  const exitListeners = process.listeners('exit')
  try {
    const installed = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'opencode', '--apply', ...(host.lang ? ['--lang', host.lang] : [])], { env: isolatedEnv(home), encoding: 'utf8', windowsHide: true })
    assert.equal(installed.status, 0, installed.stderr)
    const source = readFileSync(join(home, '.config', 'opencode', 'plugins', 'agent-board-local.js'), 'utf8')
    const stub = 'const tool = Object.assign(value => value, { schema: { string: () => ({ describe: () => ({}) }), enum: () => ({}), array: () => ({}) } })'
    const spawnStub = `import { spawnSync as realSpawnSync } from 'node:child_process'
const spawnSync = (file, args, options) => {
  const probe = globalThis.agentBoardOpenCodeSpawn
  probe.calls.push({ file, args: [...args], options: { ...options } })
  return probe.run(file, args, options, realSpawnSync, probe.calls.length)
}`
    assert.ok(source.includes("import { spawnSync } from 'node:child_process'"))
    const testPlugin = join(home, 'timeout-test.mjs')
    writeFileSync(testPlugin, source.replace("import { tool } from '@opencode-ai/plugin'", stub).replace("import { spawnSync } from 'node:child_process'", spawnStub))
    const { AgentBoardLocal } = await import(pathToFileURL(testPlugin))
    const instance = await AgentBoardLocal({ ...host.context, client: { session: { get: async ({ path }) => ({ data: { id: path.id, ...host.info } }) } } })
    const payload = { title: 'Synthetic timeout task', project: 'OpenCode fixture', state: 'working', steps: ['- [~] Synthetic timeout step'] }
    const context = { sessionID: 'opencode-timeout-session' }
    await check({ AgentBoardLocal, instance, payload, context, probe, progress: join(home, '.agent-board', 'progress.md'), log: join(home, '.agent-board', 'hook-errors.log') })
  } finally {
    dropExitReports(exitListeners)
    delete globalThis.agentBoardOpenCodeSpawn
    rmSync(home, { recursive: true, force: true })
  }
}

const opencodeTimeoutResult = () => ({ error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGKILL' })
const opencodeRealSpawn = (file, args, options, realSpawnSync) => realSpawnSync(file, args, options)
const opencodeBusy = sessionID => ({ event: { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } } })

test("opencode: a session's block is filed under the folder it ran in", async () => {
  const folder = join(tmpdir(), 'synthetic-opencode-folder')
  await opencodeSpawnFixture(opencodeRealSpawn, async f => {
    await f.instance.event(opencodeBusy('opencode-folder-session'))
    // A session whose metadata names no folder takes the plugin's own.
    const fallback = await f.AgentBoardLocal({ directory: join(tmpdir(), 'synthetic-plugin-folder'), client: { session: { get: async ({ path }) => ({ data: { id: path.id } }) } } })
    await fallback['chat.message']({ sessionID: 'opencode-plugin-folder-session' }, { parts: [{ type: 'text', text: 'Synthetic prompt' }] })
    const text = readFileSync(f.progress, 'utf8')
    for (const name of ['synthetic-opencode-folder', 'synthetic-plugin-folder']) {
      assert.match(text, new RegExp(String.raw`^## ${name}\r?\n<!-- auto session=\S+ agent=opencode [^\n]*state=working[^\n]*-->\r?\n### ${name}\r?$`, 'm'))
    }
    assert.ok(!text.includes('## opencode'), text)
    // Only the folder's name is kept, never its path or the prompt.
    assert.ok(!text.includes(tmpdir()) && !text.includes('Synthetic prompt'), text)
  }, { info: { directory: folder } })
})

test("opencode: an explicit report naming a project moves the session's block", async () => {
  await opencodeSpawnFixture(opencodeRealSpawn, async f => {
    const session = 'opencode-move-session'
    await f.instance.event(opencodeBusy(session))
    assert.match(readFileSync(f.progress, 'utf8'), /^## synthetic-move-folder\r?$/m)
    await f.instance.tool.agent_board_progress.execute({ title: 'Synthetic moved task', project: 'Synthetic Report Project', state: 'waiting', steps: ['- [?] Synthetic blue or green?'] }, { sessionID: session })
    const text = readFileSync(f.progress, 'utf8')
    const heading = text.indexOf('## Synthetic Report Project')
    assert.ok(heading > text.indexOf('## synthetic-move-folder'), text)
    assert.equal(text.match(/agent=opencode/g).length, 1, text)
    assert.ok(text.indexOf('agent=opencode') > heading && text.indexOf('### Synthetic moved task') > heading, text)
    assert.match(text, /- \[\?\] Synthetic blue or green\?/)
  }, { info: { directory: join(tmpdir(), 'synthetic-move-folder') } })
})

test('a status hook other than OpenCode keeps its agent heading when its payload names a folder', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  for (const agent of ['gemini', 'grok', 'muse']) {
    const result = f.command(['--agent-status', '--agent', agent, '--state', 'working'], { session_id: `synthetic-${agent}-status-session`, cwd: join(tmpdir(), `synthetic-${agent}-folder`) })
    assert.equal(result.status, 0, result.stderr)
  }
  const text = readFileSync(f.progress, 'utf8')
  for (const agent of ['gemini', 'grok', 'muse']) {
    assert.match(text, new RegExp(String.raw`^## ${agent}\r?$`, 'm'))
    assert.ok(!text.includes(`synthetic-${agent}-folder`), text)
  }
}))

// Runs the installed OpenCode plugin in a child that ends as a one-shot `opencode run` does: its
// session goes idle, no session.deleted comes, and the process exits. Each board call is logged
// with the session and state it reports, and each report made while exiting with its folder;
// `hang` makes the calls made while exiting hang.
// Applies what the worker queued (REPORTER_QUEUED): each board run replays the queue first (#241),
// and a run that itself runs out of time queues its own event, so it runs until the queue is
// empty, five times at most.
const settleQueue = home => {
  const root = join(home, '.agent-board'), pending = join(root, 'pending')
  for (let count = 0; count < 5 && existsSync(pending) && readdirSync(pending).some(name => name.endsWith('.json')); count++) {
    const result = spawnSync(process.execPath, [join(root, 'agent-board.mjs'), '--agent-status', '--agent', 'opencode', '--progress-file', join(root, 'progress.md'), '--home', home], { env: isolatedEnv(home), input: JSON.stringify({ session_id: 'synthetic-settle', state: 'waiting' }), encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.equal(result.status, 0, result.stderr)
  }
  assert.ok(!existsSync(pending) || !readdirSync(pending).some(name => name.endsWith('.json')), 'queued events were not all applied')
}
// Every event reached the board: nothing failed or was given up on, and what was queued was applied.
const assertNothingLost = log => assert.deepEqual((existsSync(log) ? readFileSync(log, 'utf8') : '').split(/\r?\n/).filter(line => line !== '' && !/ opencode REPORTER_QUEUED$/.test(line)), [])
const opencodeOneShot = (home, mode, scenario = 'default') => {
  const source = readFileSync(join(home, '.config', 'opencode', 'plugins', 'agent-board-local.js'), 'utf8')
  const stub = 'const tool = Object.assign(value => value, { schema: { string: () => ({ describe: () => ({}) }), enum: () => ({}), array: () => ({}) } })'
  const calls = join(home, `one-shot-calls-${mode}-${scenario}.jsonl`), marks = join(home, `one-shot-marks-${mode}-${scenario}.json`)
  const exits = join(home, `one-shot-exits-${mode}-${scenario}.jsonl`)
  writeFileSync(calls, '')
  writeFileSync(exits, '')
  const spawnStub = `import { spawnSync as realSpawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const spawnSync = (file, args, options) => {
  const { session_id, state, cwd } = JSON.parse(options.input)
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ session: session_id, state, isExiting: globalThis.isExiting === true }) + '\\n')
  if (globalThis.isExiting) appendFileSync(${JSON.stringify(exits)}, JSON.stringify(cwd ?? null) + '\\n')
  if (globalThis.isExiting && ${JSON.stringify(mode)} === 'fail') return { status: 1, stdout: '', stderr: '' }
  if (globalThis.isExiting && ${JSON.stringify(mode)} === 'hang') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.timeout)
    return { error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGKILL' }
  }
  return realSpawnSync(file, args, options)
}`
  const plugin = join(home, `one-shot-plugin-${mode}-${scenario}.mjs`), main = join(home, `one-shot-${mode}-${scenario}.mjs`)
  const copy = join(home, `one-shot-plugin-${mode}-${scenario}-copy.mjs`)
  writeFileSync(plugin, source.replace("import { tool } from '@opencode-ai/plugin'", stub).replace("import { spawnSync } from 'node:child_process'", spawnStub))
  writeFileSync(copy, readFileSync(plugin))
  // Exit listeners run in order, so the ones around the plugin's own time its exit work.
  writeFileSync(main, `import { writeFileSync } from 'node:fs'
const marks = {}
process.on('exit', () => { marks.start = Date.now(); globalThis.isExiting = true })
const { AgentBoardLocal } = await import(${JSON.stringify(pathToFileURL(plugin).href)})
process.on('exit', () => { marks.end = Date.now(); writeFileSync(${JSON.stringify(marks)}, JSON.stringify(marks)) })
let gets = 0, release = () => {}
const isStalled = ${JSON.stringify(scenario)} === 'stalled'
const holdAt = { 'late-chat': 0, 'second-chat': 2 }[${JSON.stringify(scenario)}] ?? -1
const held = holdAt >= 0 ? new Promise(resolve => { release = resolve }) : null
const data = path => ({ data: { id: path.id, ...(path.id === 'synthetic-subagent' ? { parentID: 'synthetic-one-shot' } : {}) } })
const get = ({ path }) => {
  const call = gets++
  if (isStalled && call > 0) return new Promise(() => {})
  return held && call === holdAt ? held.then(() => data(path)) : Promise.resolve(data(path))
}
const directory = ${JSON.stringify(join(tmpdir(), 'synthetic-one-shot-folder'))}
const hooks = await AgentBoardLocal({ directory, client: { session: { get } } })
if (${JSON.stringify(scenario)} === 'chat') {
  await hooks['chat.message']({ sessionID: 'synthetic-one-shot' }, { parts: [{ type: 'text', text: 'Synthetic prompt' }] })
} else if (${JSON.stringify(scenario)} === 'busy') {
  await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'synthetic-one-shot', status: { type: 'busy' } } } })
} else if (isStalled) {
  await hooks['chat.message']({ sessionID: 'synthetic-one-shot' }, { parts: [{ type: 'text', text: 'Synthetic prompt' }] })
  // The reply ends, and OpenCode exits while this event's lookup has not returned.
  hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-one-shot' } } })
} else if (${JSON.stringify(scenario)} === 'second-chat') {
  // A reply ends, the next prompt starts another, and OpenCode exits before that prompt's lookup returns.
  await hooks['chat.message']({ sessionID: 'synthetic-one-shot' }, { parts: [{ type: 'text', text: 'Synthetic prompt' }] })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-one-shot' } } })
  hooks['chat.message']({ sessionID: 'synthetic-one-shot' }, { parts: [{ type: 'text', text: 'Synthetic prompt' }] })
} else if (${JSON.stringify(scenario)} === 'late-chat') {
  // The reply ends, and its idle event is reported, before the prompt's own lookup returns.
  const chat = hooks['chat.message']({ sessionID: 'synthetic-one-shot' }, { parts: [{ type: 'text', text: 'Synthetic prompt' }] })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-one-shot' } } })
  release()
  await chat
} else if (${JSON.stringify(scenario)} === 'twice') {
  // OpenCode loads the plugin a second time in the same process; both copies see the session.
  const again = await (await import(${JSON.stringify(pathToFileURL(copy).href)})).AgentBoardLocal({ directory, client: { session: { get } } })
  await hooks['chat.message']({ sessionID: 'synthetic-one-shot' }, { parts: [{ type: 'text', text: 'Synthetic prompt' }] })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-one-shot' } } })
  await again.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-one-shot' } } })
} else {
await hooks['chat.message']({ sessionID: 'synthetic-one-shot' }, { parts: [{ type: 'text', text: 'Synthetic prompt' }] })
await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-one-shot' } } })
await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'synthetic-subagent', status: { type: 'busy' } } } })
await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'synthetic-closed', status: { type: 'busy' } } } })
await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'synthetic-closed' } } } })
  if (['two', 'replying'].includes(${JSON.stringify(scenario)})) {
    await hooks['chat.message']({ sessionID: 'synthetic-second' }, { parts: [{ type: 'text', text: 'Synthetic prompt' }] })
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'synthetic-second', status: { type: 'busy' } } } })
    if (${JSON.stringify(scenario)} === 'two') await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-second' } } })
  }
}
`)
  const result = spawnSync(process.execPath, [main], { env: isolatedEnv(home), encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  if (mode === 'real') settleQueue(home)
  const lines = file => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { calls: lines(calls), exitFolders: lines(exits), marks: JSON.parse(readFileSync(marks, 'utf8')) }
}
// A loaded machine can push a report past the worker's 2 s limit (#241). An event the worker queued
// is applied by settleQueue before a real-mode check reads the board. A report given up on
// (REPORTER_TIMEOUT) is lost: a check that fails after one runs once more in a fresh home, and that
// retry is named. `retry` says which log shows such a loss; the hang and fail scenarios log theirs
// by design and never retry.
const LOST = text => /opencode REPORTER_TIMEOUT/.test(text)
const opencodeOneShotHome = async (t, check, { retry = LOST } = {}) => {
  for (let attempt = 1; ; attempt++) {
    const home = mkdtempSync(join(tmpdir(), 'opencode-one-shot-'))
    const log = join(home, '.agent-board', 'hook-errors.log')
    try {
      const installed = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'opencode', '--apply'], { env: isolatedEnv(home), encoding: 'utf8', windowsHide: true, timeout: 15000 })
      assert.equal(installed.status, 0, installed.stderr)
      return await check(home, join(home, '.agent-board', 'progress.md'), log)
    } catch (error) {
      if (!retry || attempt === 2 || !existsSync(log) || !retry(readFileSync(log, 'utf8'))) throw error
      // The retry is named in the test output, so a regression that only sometimes misses the
      // limit still shows.
      t.diagnostic(`one-shot retry ${attempt}: ${String(error?.message).split('\n')[0]}`)
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }
}
const ONE_SHOT_EVENTS = [
  { session: 'synthetic-one-shot', state: 'working', isExiting: false },
  { session: 'synthetic-one-shot', state: 'waiting', isExiting: false },
  { session: 'synthetic-closed', state: 'working', isExiting: false },
  { session: 'synthetic-closed', state: 'ended', isExiting: false },
]
const oneShotState = (text, session) => text.split(/\r?\n/).find(line => line.includes('agent=opencode') && line.includes(`resume=${session} `))?.match(/state=(\w+)/)?.[1]

test('opencode: a one-shot run ends its session when OpenCode exits', t => opencodeOneShotHome(t, async (home, progress, log) => {
  const run = opencodeOneShot(home, 'real')
  // Only the session still open is ended, once; a subagent's is never reported.
  assert.deepEqual(run.calls, [...ONE_SHOT_EVENTS, { session: 'synthetic-one-shot', state: 'ended', isExiting: true }])
  // The end report names the session's folder, as its other reports do.
  assert.deepEqual(run.exitFolders, [join(tmpdir(), 'synthetic-one-shot-folder')])
  const text = readFileSync(progress, 'utf8')
  assert.equal(oneShotState(text, 'synthetic-one-shot'), 'ended', text)
  assert.equal(oneShotState(text, 'synthetic-closed'), 'ended', text)
  assert.match(text, /^## synthetic-one-shot-folder\r?$/m)
  assert.ok(!text.includes('synthetic-subagent') && !text.includes('Synthetic prompt'), text)
  assertNothingLost(log)
}))

test('opencode: ending sessions at exit stops at the hook limit when the board hangs', t => opencodeOneShotHome(t, async (home, progress, log) => {
  const run = opencodeOneShot(home, 'hang')
  assert.deepEqual(run.calls, [...ONE_SHOT_EVENTS, { session: 'synthetic-one-shot', state: 'ended', isExiting: true }])
  // One 2 s deadline plus the worker's 500 ms grace, never the host's whole wait.
  const spent = run.marks.end - run.marks.start
  assert.ok(spent >= 2000 && spent < 3500, `exit took ${spent} ms`)
  assert.equal(oneShotState(readFileSync(progress, 'utf8'), 'synthetic-one-shot'), 'waiting')
  assert.match(readFileSync(log, 'utf8'), /opencode REPORTER_TIMEOUT/)
}, { retry: false }))

test('opencode: two sessions in one process both end within one shared deadline', async t => {
  for (const mode of ['real', 'hang']) await opencodeOneShotHome(t, async (home, progress, log) => {
    const run = opencodeOneShot(home, mode, 'two')
    const exiting = run.calls.filter(call => call.isExiting)
    const text = readFileSync(progress, 'utf8')
    if (mode === 'real') {
      assert.deepEqual(exiting, ['synthetic-one-shot', 'synthetic-second'].map(session => ({ session, state: 'ended', isExiting: true })))
      for (const session of ['synthetic-one-shot', 'synthetic-second']) assert.equal(oneShotState(text, session), 'ended', text)
      assertNothingLost(log)
    } else {
      assert.deepEqual(exiting, [{ session: 'synthetic-one-shot', state: 'ended', isExiting: true }])
      assert.equal(readFileSync(log, 'utf8').match(/opencode REPORTER_TIMEOUT/g)?.length, 2)
      const spent = run.marks.end - run.marks.start
      assert.ok(spent >= 2000 && spent < 3500, `exit took ${spent} ms`)
      for (const session of ['synthetic-one-shot', 'synthetic-second']) assert.equal(oneShotState(text, session), 'waiting', text)
    }
  }, { retry: mode === 'real' && LOST })
})

test('opencode: a reporter that fails while OpenCode exits is logged and does not hold the exit', t => opencodeOneShotHome(t, async (home, progress, log) => {
  const run = opencodeOneShot(home, 'fail', 'two')
  assert.deepEqual(run.calls.filter(call => call.isExiting), ['synthetic-one-shot', 'synthetic-second'].map(session => ({ session, state: 'ended', isExiting: true })))
  assert.equal(readFileSync(log, 'utf8').match(/opencode REPORTER_FAILED/g)?.length, 2)
  const spent = run.marks.end - run.marks.start
  assert.ok(spent < 1000, `exit took ${spent} ms`)
  for (const session of ['synthetic-one-shot', 'synthetic-second']) assert.equal(oneShotState(readFileSync(progress, 'utf8'), session), 'waiting')
}, { retry: false }))

test('opencode: a session still replying when OpenCode exits is not ended', t => opencodeOneShotHome(t, async (home, progress, log) => {
  const run = opencodeOneShot(home, 'real', 'replying')
  assert.deepEqual(run.calls.filter(call => call.isExiting), [{ session: 'synthetic-one-shot', state: 'ended', isExiting: true }])
  const text = readFileSync(progress, 'utf8')
  assert.equal(oneShotState(text, 'synthetic-one-shot'), 'ended', text)
  assert.equal(oneShotState(text, 'synthetic-second'), 'working', text)
  assertNothingLost(log)
}))

test('opencode: a session whose reply ended while its lookup was pending is ended at exit', t => opencodeOneShotHome(t, async (home, progress, log) => {
  const run = opencodeOneShot(home, 'real', 'stalled')
  assert.deepEqual(run.calls, [{ session: 'synthetic-one-shot', state: 'working', isExiting: false }, { session: 'synthetic-one-shot', state: 'ended', isExiting: true }])
  assert.equal(oneShotState(readFileSync(progress, 'utf8'), 'synthetic-one-shot'), 'ended')
  // Only the lookup that never returned is given up on.
  assert.equal(readFileSync(log, 'utf8').match(/opencode REPORTER_TIMEOUT/g)?.length, 1)
}, { retry: text => (text.match(/opencode REPORTER_TIMEOUT/g) ?? []).length > 1 }))

test('opencode: a prompt whose lookup returns after its reply ended is still ended at exit', t => opencodeOneShotHome(t, async (home, progress, log) => {
  const run = opencodeOneShot(home, 'real', 'late-chat')
  assert.deepEqual(run.calls, [{ session: 'synthetic-one-shot', state: 'waiting', isExiting: false }, { session: 'synthetic-one-shot', state: 'working', isExiting: false }, { session: 'synthetic-one-shot', state: 'ended', isExiting: true }])
  assert.equal(oneShotState(readFileSync(progress, 'utf8'), 'synthetic-one-shot'), 'ended')
  assertNothingLost(log)
}))

test('opencode: a session whose next prompt is still being looked up at exit is not ended', t => opencodeOneShotHome(t, async (home, progress, log) => {
  const run = opencodeOneShot(home, 'real', 'second-chat')
  assert.deepEqual(run.calls.filter(call => call.isExiting), [])
  assert.equal(oneShotState(readFileSync(progress, 'utf8'), 'synthetic-one-shot'), 'waiting')
  // Only the prompt whose lookup never returned is given up on.
  const lines = readFileSync(log, 'utf8').split(/\r?\n/).filter(line => line !== '' && !/ opencode REPORTER_QUEUED$/.test(line))
  assert.equal(lines.length, 1, lines.join('\n'))
  assert.match(lines[0], / opencode REPORTER_TIMEOUT$/)
}, { retry: text => (text.match(/opencode REPORTER_TIMEOUT/g) ?? []).length > 1 }))

test('opencode: a plugin loaded twice in one process ends each session once at exit', t => opencodeOneShotHome(t, async (home, progress, log) => {
  const run = opencodeOneShot(home, 'real', 'twice')
  assert.deepEqual(run.calls.filter(call => call.isExiting), [{ session: 'synthetic-one-shot', state: 'ended', isExiting: true }])
  assert.equal(oneShotState(readFileSync(progress, 'utf8'), 'synthetic-one-shot'), 'ended')
  assertNothingLost(log)
}))

test('opencode: a later report for an ended session reopens its row', t => opencodeOneShotHome(t, async (home, progress, log) => {
  for (const scenario of ['chat', 'busy']) {
    opencodeOneShot(home, 'real')
    assert.equal(oneShotState(readFileSync(progress, 'utf8'), 'synthetic-one-shot'), 'ended')
    const run = opencodeOneShot(home, 'real', scenario)
    assert.deepEqual(run.calls, [{ session: 'synthetic-one-shot', state: 'working', isExiting: false }])
    assert.equal(oneShotState(readFileSync(progress, 'utf8'), 'synthetic-one-shot'), 'working')
  }
  assertNothingLost(log)
}))

test('opencode: a refused progress report tells the model why', async () => {
  // A Chinese board brackets the code in full-width parentheses; the same code comes through.
  for (const lang of ['en', 'zh-TW', 'zh-CN']) await opencodeSpawnFixture(opencodeRealSpawn, async f => {
    assert.ok(readFileSync(join(dirname(f.progress), 'agent-board.mjs'), 'utf8').split('\n', 1)[0].includes(`"lang":"${lang}"`), lang)
    // The step format the model reads is in the board's language and names every mark.
    const plugin = readFileSync(join(dirname(dirname(f.progress)), '.config', 'opencode', 'plugins', 'agent-board-local.js'), 'utf8')
    const format = plugin.slice(plugin.indexOf({ en: 'One Markdown task line', 'zh-TW': '一行 Markdown 任務', 'zh-CN': '一行 Markdown 任务' }[lang])).split(')', 1)[0]
    for (const mark of ['x', '~', ' ', '?', '!', '>', '-']) assert.ok(format.includes(`- [${mark}]`), `${lang} ${mark}`)
    await assert.rejects(f.instance.tool.agent_board_progress.execute({ ...f.payload, title: 'Synthetic refused task', steps: ['Synthetic plain step'] }, f.context), { message: 'AGENT_BOARD_REPORT_FAILED: INVALID_STEP' })
    assert.ok(!readFileSync(f.progress, 'utf8').includes('Synthetic refused task'))
    assert.match(readFileSync(f.log, 'utf8'), /opencode REPORTER_FAILED INVALID_STEP\r?\n/)
  }, { lang })
})

test('an OpenCode report retries once when the runtime ends spawnSync early with ETIMEDOUT', async () => {
  await opencodeSpawnFixture((file, args, options, realSpawnSync, count) => count === 1 ? opencodeTimeoutResult() : realSpawnSync(file, args, options), async f => {
    f.payload.state = 'done'
    f.payload.steps = ['- [x] Synthetic timeout step']
    await f.instance.tool.agent_board_progress.execute(f.payload, f.context)
    assert.match(readFileSync(f.progress, 'utf8'), /Synthetic timeout task/)
    assert.equal(f.probe.calls.length, 2)
    const [first, retry] = f.probe.calls
    assert.equal(retry.file, first.file)
    assert.deepEqual(retry.args, first.args)
    assert.ok(first.args.includes('--hook-deadline'))
    assert.deepEqual(retry.options, { ...first.options, timeout: retry.options.timeout })
    assert.ok(retry.options.timeout > 100 && retry.options.timeout <= first.options.timeout)
    const before = existsSync(f.log) ? readFileSync(f.log, 'utf8') : ''
    f.probe.calls.length = 0
    await f.instance.event({ event: { type: 'session.status', properties: { sessionID: 'opencode-timeout-lifecycle', status: { type: 'busy' } } } })
    assert.match(readFileSync(f.progress, 'utf8'), /agent=opencode .*state=working/)
    assert.equal(f.probe.calls.length, 2)
    assert.equal(existsSync(f.log) ? readFileSync(f.log, 'utf8') : '', before)
  })
})

test('an OpenCode report that really times out is not retried', async () => {
  await opencodeSpawnFixture((_file, _args, options) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.timeout)
    return opencodeTimeoutResult()
  }, async f => {
    await assert.rejects(f.instance.tool.agent_board_progress.execute(f.payload, f.context), { message: 'HOOK_TIMEOUT' })
    assert.equal(f.probe.calls.length, 1)
    assert.match(readFileSync(f.log, 'utf8'), /opencode REPORTER_TIMEOUT/)
  })
})

test('an OpenCode report that ends early twice is retried only once', async () => {
  await opencodeSpawnFixture(() => opencodeTimeoutResult(), async f => {
    await assert.rejects(f.instance.tool.agent_board_progress.execute(f.payload, f.context), { message: 'HOOK_TIMEOUT' })
    assert.equal(f.probe.calls.length, 2)
    assert.match(readFileSync(f.log, 'utf8'), /opencode REPORTER_TIMEOUT/)
  })
})

test('a failed OpenCode progress tool logs its code without the payload', async () => {
  await opencodeSpawnFixture(() => ({ status: 1, stderr: 'PRIVATE_STDERR' }), async f => {
    await assert.rejects(f.instance.tool.agent_board_progress.execute(f.payload, f.context), { message: 'AGENT_BOARD_REPORT_FAILED' })
    assert.equal(f.probe.calls.length, 1)
    const log = readFileSync(f.log, 'utf8')
    assert.match(log, /opencode REPORTER_FAILED/)
    for (const privateValue of [f.payload.title, ...f.payload.steps, f.context.sessionID, 'PRIVATE_STDERR', f.progress]) assert.ok(!log.includes(privateValue))
  })
})

test('an unsupported bootstrap target is refused without installing anything', () => fixture(f => {
  assert.notEqual(f.install('--agent', 'imaginary', '--apply').status, 0)
  assert.ok(!existsSync(f.root))
}))

test('setup refuses a config change after planning instead of overwriting another writer', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const loaded = JSON.parse(readFileSync(f.hooks))
  loaded.hooks.UserPromptSubmit.push({hooks:[{type:'command',command:'user-first'}]})
  f.save(f.hooks, JSON.stringify(loaded))
  const preload = join(f.home, 'concurrent-writer.mjs')
  f.save(preload, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const original = fs.readFileSync
let changed = false
fs.readFileSync = (file, ...args) => {
  const result = original(file, ...args)
  if (file === ${JSON.stringify(f.skill)} && !changed) {
    changed = true
    const config = JSON.parse(original(${JSON.stringify(f.hooks)}, 'utf8'))
    config.hooks.UserPromptSubmit.push({hooks:[{type:'command',command:'user-concurrent'}]})
    fs.writeFileSync(${JSON.stringify(f.hooks)}, JSON.stringify(config))
  }
  return result
}
syncBuiltinESMExports()
`)
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, f.script, '--codex-setup', '--home', f.home, '--codex-dir', join(f.home,'.codex'), '--apply', '--json'], {env:f.env, encoding:'utf8', windowsHide:true})
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /INSTALL_CHANGED/)
  assert.match(readFileSync(f.hooks, 'utf8'), /user-concurrent/)
}))

test('OpenCode honors its config override for installation, doctor and removal', () => fixture(f => {
  f.env.XDG_CONFIG_HOME = join(f.home, 'xdg')
  f.env.OPENCODE_CONFIG_DIR = join(f.home, 'native config')
  assert.equal(f.install('--agent', 'opencode', '--apply').status, 0)
  const plugin = join(f.env.OPENCODE_CONFIG_DIR, 'plugins', 'agent-board-local.js')
  assert.ok(existsSync(plugin))
  assert.ok(existsSync(join(f.env.OPENCODE_CONFIG_DIR, 'commands', 'board.md')))
  assert.ok(!existsSync(join(f.home, '.config', 'opencode')))
  assert.equal(JSON.parse(f.command(['--codex-doctor', '--agent', 'opencode']).stdout).installed, true)
  f.env.OPENCODE_CONFIG_DIR = join(f.home, 'changed-root')
  assert.notEqual(f.install('--agent', 'opencode', '--apply').status, 0)
  assert.ok(existsSync(plugin))
  f.env.OPENCODE_CONFIG_DIR = join(f.home, 'native config')
  assert.equal(f.command(['--codex-remove', '--agent', 'opencode', '--apply']).status, 0)
  assert.ok(!existsSync(plugin))
}))

test('auto setup detects overridden host directories without scanning sessions', () => fixture(f => {
  f.env.OPENCODE_CONFIG_DIR = join(f.home, 'opencode-dir')
  f.env.OPENCLAW_STATE_DIR = join(f.home, 'openclaw-dir')
  f.env.DSH_HOME = join(f.home, 'deepseek-dir')
  for (const file of [f.env.OPENCODE_CONFIG_DIR, f.env.OPENCLAW_STATE_DIR, f.env.DSH_HOME]) mkdirSync(file)
  const preview = spawnSync(process.execPath, [resolve('scripts/setup-agent.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes')], {env:f.env, encoding:'utf8', windowsHide:true})
  assert.equal(preview.status, 0, preview.stderr)
  assert.deepEqual(JSON.parse(preview.stdout).targets, ['opencode', 'openclaw', 'deepseek'])
  assert.ok(!existsSync(f.root))
}))

test('OpenClaw metadata setup preserves other plugins and refuses edited or disabled definitions', () => fixture(f => {
  const file = join(f.home, '.openclaw', 'openclaw.json')
  const other = { enabled: true, config: { keep: true } }
  f.save(file, JSON.stringify({ plugins: { allow: ['other'], entries: { other }, load: { paths: ['other.mjs'] } } }))
  assert.equal(f.install('--agent', 'openclaw', '--apply').status, 0)
  const loaded = JSON.parse(readFileSync(file))
  assert.equal(loaded.plugins.entries['agent-board-local'].hooks.allowConversationAccess, false)
  assert.deepEqual(loaded.plugins.entries.other, other)
  assert.deepEqual(loaded.plugins.allow, ['other', 'agent-board-local'])
  assert.deepEqual(JSON.parse(f.install('--agent', 'openclaw').stdout).changes, [])
  loaded.plugins.entries['agent-board-local'].enabled = false
  f.save(file, JSON.stringify(loaded))
  assert.notEqual(f.install('--agent', 'openclaw', '--apply').status, 0)
  assert.equal(JSON.parse(readFileSync(file)).plugins.entries['agent-board-local'].enabled, false)
  loaded.plugins.entries['agent-board-local'].enabled = true
  f.save(file, JSON.stringify(loaded))
  assert.equal(f.command(['--codex-remove', '--agent', 'openclaw', '--apply']).status, 0)
  const removed = JSON.parse(readFileSync(file))
  assert.deepEqual(removed.plugins.entries, { other })
  assert.deepEqual(removed.plugins.allow, ['other'])
  assert.deepEqual(removed.plugins.load.paths, ['other.mjs'])
}))

test('OpenClaw native metadata callbacks fence stale runs and never request conversation access', async () => {
  const home = mkdtempSync(join(tmpdir(), 'openclaw-status-'))
  try {
    const env = isolatedEnv(home)
    const result = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'openclaw', '--apply'], { env, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    const folder = join(home, '.agent-board', 'adapters', 'openclaw')
    assert.equal(JSON.parse(readFileSync(join(folder, 'openclaw.plugin.json'))).id, 'agent-board-local')
    const plugin = (await import(pathToFileURL(join(folder, 'agent-board-local.mjs')))).default
    const hooks = new Map()
    let subscription
    plugin.register({ on: (name, fn) => hooks.set(name, fn), agent: { events: { registerAgentEventSubscription: value => { subscription = value } } } })
    assert.deepEqual([...hooks.keys()], ['session_start', 'session_end'])
    assert.equal(subscription.payload, 'metadata')
    assert.deepEqual(subscription.streams, ['lifecycle'])
    const sessionId = 'openclaw-native-session-123'
    const read = () => readFileSync(join(home, '.agent-board', 'progress.md'), 'utf8')
    hooks.get('session_start')({ sessionId, get messages() { throw Error('PRIVATE_DATA_READ') } })
    const emit = (phase, runId) => subscription.handle({ stream: 'lifecycle', sessionId, runId, data: { phase } })
    emit('start', 'native-run-1')
    assert.match(read(), /agent=openclaw .*state=working/)
    emit('end', 'native-run-1')
    assert.match(read(), /state=waiting/)
    emit('start', 'native-run-2')
    await emit('end', 'native-run-1')
    assert.match(readFileSync(join(home, '.agent-board', 'hook-errors.log'), 'utf8'), /openclaw REPORTER_FAILED/)
    assert.match(read(), /state=working/)
    emit('error', 'native-run-2')
    assert.match(read(), /state=waiting/)
    hooks.get('session_end')({ sessionId, reason: 'restart' })
    assert.match(read(), /state=waiting/)
    hooks.get('session_end')({ sessionId, reason: 'shutdown' })
    assert.match(read(), /state=ended/)
    assert.throws(() => plugin.register({}), /HOST_API_UNSUPPORTED/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('DeepSeek setup appends an owned native patch and preserves other YAML on removal', () => fixture(f => {
  f.env.DSH_HOME = join(f.home, '.dsh')
  const file = join(f.env.DSH_HOME, 'cordis.patch.yml')
  const other = '# Personal configuration\n- id: another-plugin\n  config:\n    enabled: true\n'
  f.save(file, other)
  assert.equal(f.install('--agent', 'deepseek', '--apply').status, 0)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith(other))
  assert.match(text, /- insert:\n    - id: agent-board-local/)
  assert.match(text, /name: "file:/)
  assert.deepEqual(JSON.parse(f.install('--agent', 'deepseek').stdout).changes, [])
  assert.equal(f.command(['--codex-remove', '--agent', 'deepseek', '--apply']).status, 0)
  assert.equal(readFileSync(file, 'utf8'), other)
}))

test('DeepSeek setup refuses complex or edited YAML without changing it', () => fixture(f => {
  f.env.DSH_HOME = join(f.home, '.dsh')
  const file = join(f.env.DSH_HOME, 'cordis.patch.yml')
  for (const text of ['---\n- id: other\n...\n', '{"plugins": []}\n', '# agent-board-local:start\n- insert: []\n']) {
    f.save(file, text)
    assert.notEqual(f.install('--agent', 'deepseek', '--apply').status, 0)
    assert.equal(readFileSync(file, 'utf8'), text)
  }
}))

test('DeepSeek native callbacks report their own identity and preserve task completion', async () => {
  const home = mkdtempSync(join(tmpdir(), 'deepseek-status-'))
  try {
    const env = isolatedEnv(home)
    const installed = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'deepseek', '--apply'], { env, encoding: 'utf8', windowsHide: true })
    assert.equal(installed.status, 0, installed.stderr)
    const { apply } = await import(pathToFileURL(join(home, '.agent-board', 'adapters', 'deepseek.mjs')))
    const hooks = new Map(), warnings = []
    apply({ on: (name, fn) => hooks.set(name, fn), logger: {warn: code => warnings.push(code)} })
    assert.doesNotThrow(() => hooks.get('agent/created')({agent: {session: {header: {id:'bad?'}}, status: 'idle'}}))
    assert.deepEqual(warnings, [])
    assert.match(readFileSync(join(home, '.agent-board', 'hook-errors.log'), 'utf8'), /deepseek REPORTER_FAILED/)
    const agent = { session: { header: { id: 'deepseek-native-session-123' } }, status: 'idle', get messages() { throw Error('PRIVATE_DATA_READ') } }
    const read = () => readFileSync(join(home, '.agent-board', 'progress.md'), 'utf8')
    hooks.get('agent/created')({ agent })
    hooks.get('agent/status')({ agent, status: 'running' })
    assert.match(read(), /agent=deepseek .*state=working/)
    assert.ok(!read().includes('agent=codex'))
    const report = spawnSync(process.execPath, [join(home, '.agent-board', 'agent-board.mjs'), '--codex-report', '--agent', 'deepseek', '--session', agent.session.header.id], { env, encoding: 'utf8', windowsHide: true, input: JSON.stringify({ title: 'Synthetic native task', state: 'done', steps: ['- [x] Complete'] }) })
    assert.equal(report.status, 0, report.stderr)
    hooks.get('agent/status')({ agent, status: 'idle' })
    assert.match(read(), /state=done/)
    hooks.get('agent/status')({ agent, status: 'running' })
    assert.match(read(), /state=working/)
    hooks.get('agent/disposed')({ agent })
    assert.match(read(), /state=ended/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('Grok prompt hooks return a waiting session to working through the native shell shape', () => fixture(f => {
  assert.equal(f.install('--agent', 'grok', '--apply').status, 0)
  const hooks = JSON.parse(readFileSync(join(f.home, '.grok', 'hooks', 'agent-board-local.json'))).hooks
  const states = { SessionStart: 'waiting', UserPromptSubmit: 'working', Stop: 'waiting', SessionEnd: 'ended' }
  for (const [name, state] of Object.entries(states)) {
    const command = hooks[name][0].hooks[0].command
    const isWindows = process.platform === 'win32'
    const result = spawnSync(isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', isWindows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command], {
      env: f.env, input: JSON.stringify({ sessionId: 'grok-native-session-123', hookEventName: name, prompt: 'PRIVATE_PAYLOAD' }),
      encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: isWindows,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(readFileSync(f.progress, 'utf8').includes(`state=${state}`))
  }
  assert.ok(!readFileSync(f.progress, 'utf8').includes('PRIVATE_PAYLOAD'))
}))

test('auto setup does not mistake an Antigravity profile or the shared gemini directory for Gemini CLI', () => fixture(f => {
  mkdirSync(join(f.home, '.gemini', 'antigravity-cli'), { recursive: true })
  const args = [resolve('scripts/setup-agent.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex')]
  const run = () => spawnSync(process.execPath, args, { env: f.env, encoding: 'utf8', windowsHide: true })
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).targets, ['antigravity'])
  assert.equal(existsSync(join(f.home, '.gemini', 'settings.json')), false)
  f.save(join(f.home, '.gemini', 'settings.json'), '{}')
  assert.deepEqual(JSON.parse(run().stdout).targets, ['gemini', 'antigravity'])
}))

test('all targets initialize one shared board and explicitly name unfinished native adapters', () => fixture(f => {
  const installer = resolve('scripts/setup-agent.mjs')
  const result = spawnSync(process.execPath, [installer, '--agent', 'all', '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--apply'], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, `${JSON.stringify({ error: result.error?.code, signal: result.signal })}\n${result.stderr}`)
  const plans = JSON.parse(result.stdout).plans
  assert.equal(plans.length, 10)
  assert.equal(new Set(plans.map(plan => plan.progress)).size, 1)
  assert.equal(plans.find(plan => plan.agent === 'hermes').capabilities.lifecycle, 'adapter-pending')
  for (const agent of ['openclaw', 'deepseek']) assert.equal(plans.find(plan => plan.agent === agent).capabilities.lifecycle, 'adapter-installed-unverified')
  assert.equal(plans.find(plan => plan.agent === 'antigravity').capabilities.lifecycle, 'adapter-installed-unverified')
  assert.ok(existsSync(join(f.home, '.gemini', 'commands', 'board.toml')))
  assert.ok(existsSync(join(f.home, '.hermes', 'skills', 'agent-board', 'SKILL.md')))
  for (const agent of ['gemini', 'grok', 'muse']) {
    const response = f.command(['--agent-status', '--agent', agent, '--state', 'waiting'], { session_id: `shared-${agent}-session-123`, prompt: 'PRIVATE_PAYLOAD' })
    assert.equal(response.status, 0, response.stderr)
  }
  const text = readFileSync(f.progress, 'utf8')
  for (const agent of ['gemini', 'grok', 'muse']) assert.ok(text.includes(`agent=${agent} `))
  assert.ok(!text.includes('PRIVATE_PAYLOAD'))
}))

test('Windows Antigravity commands fit cmd.exe with a 120 character home path', { skip: process.platform !== 'win32' }, t => fixture(f => {
  if (f.home.length >= 119) return t.skip('TEMP is too long to leave room for a 120 character home path')
  const home = join(f.home, 'h'.repeat(119 - f.home.length))
  assert.equal(home.length, 120)
  mkdirSync(home)
  const result = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'antigravity', '--apply'], { env: isolatedEnv(home), encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  const hooks = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json')))['agent-board-local']
  for (const group of Object.values(hooks)) for (const hook of group) assert.ok(hook.command.length < 8191, `${hook.command.length} characters`)
}))

const syntheticWindowsWrapperWorker = (capture, stdout, stderr, status) => `import { writeFileSync } from 'node:fs'
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ worker: process.argv[1], argv: process.argv.slice(2), input }))
  process.stdout.write(${JSON.stringify(stdout)})
  process.stderr.write(${JSON.stringify(stderr)})
  process.exit(${status})
})
`

test('Windows Antigravity verified Node commands bypass PowerShell and preserve synthetic session state through cmd', { skip: process.platform !== 'win32' }, t => fixture(async f => {
  if (f.home.length >= 119) return t.skip('TEMP is too long to leave room for a 120 character home path')
  const home = join(f.home, 'h'.repeat(119 - f.home.length))
  assert.equal(home.length, 120)
  mkdirSync(home)
  const env = isolatedEnv(home)
  const installed = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'antigravity', '--apply'], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(installed.status, 0, installed.stderr)
  const root = join(home, '.agent-board')
  const progress = join(root, 'progress.md')
  const hooks = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board-local']
  if (/^powershell\.exe /i.test(hooks.PreInvocation[0].command)) return t.skip('this Node executable has no verified quote-free absolute path')
  const foreign = '<!-- auto session=abcdef12 agent=opencode state=waiting updated=2026-10-24T00:00:00Z -->\n### Foreign task\n- [?] Blue or green?\n<!-- /auto session=abcdef12 -->\n'
  writeFileSync(progress, readFileSync(progress, 'utf8') + foreign)
  const conversationId = 'synthetic-direct-node-session'
  const payload = JSON.stringify({ conversationId, prompt: 'PRIVATE_PROMPT' })
  const preInvocation = await fireCommand({ env }, hooks.PreInvocation[0].command, payload)
  assert.equal(preInvocation.status, 0, hookFailure(preInvocation))
  const record = join(root, 'sessions', createHash('sha256').update(`antigravity:${conversationId}`).digest('hex') + '.json')
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).state, 'working')
  const stopped = await fireCommand({ env }, hooks.Stop[0].command, payload)
  assert.equal(stopped.status, 0, hookFailure(stopped))
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).state, 'waiting')
  const text = readFileSync(progress, 'utf8')
  assert.ok(text.includes(foreign), 'another agent block must remain unchanged')
  assert.match(text, /agent=antigravity .*state=waiting/)
  for (const group of Object.values(hooks)) for (const hook of group) {
    assert.ok(hook.command.length < 8191, `${hook.command.length} characters`)
    const executable = hook.command.split(' ')[0]
    assert.match(executable, /^[A-Za-z]:[\\/][A-Za-z0-9_.~\\/-]+\.exe$/i)
    const actual = statSync(executable, { bigint: true })
    const expected = statSync(process.execPath, { bigint: true })
    assert.ok(actual.ino > 0n && expected.ino > 0n)
    assert.equal(actual.dev, expected.dev)
    assert.equal(actual.ino, expected.ino)
    assert.ok(!/powershell(?:\.exe)?/i.test(hook.command), hook.command)
  }
}))

test('Windows Antigravity synthetic direct wrapper preserves stdin argv output and exit code through cmd', { skip: process.platform !== 'win32' }, t => fixture(async f => {
  const home = join(f.home, "synthetic wrapper's home")
  mkdirSync(home)
  const env = isolatedEnv(home)
  const installed = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'antigravity', '--apply'], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(installed.status, 0, installed.stderr)
  const root = join(home, '.agent-board')
  const worker = join(root, 'agent-board-hook.mjs')
  const capture = join(root, 'synthetic-wrapper-capture.json')
  const stdout = 'synthetic wrapper stdout: 雪\n'
  const stderr = 'synthetic wrapper stderr: O\'Hara "quoted"\n'
  // This exercises only the generated command contract with a disposable worker,
  // not native Antigravity delivery or a model acknowledgement.
  writeFileSync(worker, syntheticWindowsWrapperWorker(capture, stdout, stderr, 37))
  const command = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board-local'].PreInvocation[0].command
  if (/^powershell\.exe /i.test(command)) return t.skip('this Node executable has no verified quote-free absolute path')
  const payload = { unicode: '雪', apostrophe: "O'Hara", quote: '"quoted"', newline: 'line one\nline two' }
  const input = JSON.stringify(payload)
  const result = await fireCommand({ env }, command, input)
  assert.equal(result.status, 37, hookFailure(result))
  assert.equal(result.stdout, stdout)
  assert.equal(result.stderr, stderr)
  const saved = JSON.parse(readFileSync(capture, 'utf8'))
  assert.equal(saved.worker, worker)
  assert.ok(saved.worker.includes(' ') && saved.worker.includes("'"), saved.worker)
  assert.ok(saved.argv.includes(join(root, 'progress.md')), JSON.stringify(saved.argv))
  assert.equal(saved.input, input)
  assert.deepEqual(JSON.parse(saved.input), payload)
}))

test('Windows Antigravity binds its executable across PATH batch files and another event working directory', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  const home = join(f.home, "b's")
  const runtime = join(f.home, 'bound node')
  const shadow = join(f.home, 'shadow')
  const otherCwd = join(f.home, 'other cwd')
  for (const dir of [home, runtime, shadow, otherCwd]) mkdirSync(dir)
  const boundNode = join(runtime, 'node.exe')
  copyFileSync(process.execPath, boundNode)
  copyFileSync(process.execPath, join(otherCwd, 'node.exe'))
  const marker = join(shadow, 'ran.txt')
  writeFileSync(join(shadow, 'node.cmd'), `@echo off\r\n> "${marker}" echo SYNTHETIC_SHADOW_COMMAND\r\nexit /b 37\r\n`)
  const env = { ...isolatedEnv(home), PATH: [shadow, runtime, process.env.PATH].join(delimiter) }
  const installed = spawnSync(boundNode, [setup, '--home', home, '--agent', 'antigravity', '--apply'], { env, cwd: home, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(installed.status, 0, installed.stderr)
  const root = join(home, '.agent-board')
  const capture = join(root, 'bound-executable.json')
  writeFileSync(join(root, 'agent-board-hook.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(capture)}, JSON.stringify({ executable: process.execPath }))\n`)
  const command = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board-local'].Stop[0].command
  for (const cwd of [home, otherCwd]) {
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { env, cwd, input: '{}', encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 15000 })
    assert.equal(result.status, 0, hookFailure(result))
    assert.equal(existsSync(marker), false, 'a PATH batch file must not replace the bound executable')
    const actual = statSync(JSON.parse(readFileSync(capture, 'utf8')).executable, { bigint: true })
    const expected = statSync(boundNode, { bigint: true })
    assert.ok(actual.ino > 0n && expected.ino > 0n)
    assert.equal(actual.dev, expected.dev)
    assert.equal(actual.ino, expected.ino, 'another event cwd must not replace the bound executable')
  }
}))

test('Windows Antigravity falls back to PowerShell when setup cannot verify a quote-free Node path', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  const home = join(f.home, "f's")
  mkdirSync(home)
  const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const powershell = join(system32, 'WindowsPowerShell', 'v1.0')
  const setupEnv = { ...Object.fromEntries(Object.entries(isolatedEnv(home)).filter(([key]) => key.toLowerCase() !== 'comspec')), PATH: [system32, powershell].join(delimiter), ComSpec: join(f.home, 'unavailable-short-path-probe.exe') }
  const nodeLookup = spawnSync(join(system32, 'where.exe'), ['node'], { env: setupEnv, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.notEqual(nodeLookup.status, 0, nodeLookup.stdout + nodeLookup.stderr)
  // Force a spaced executable and an unavailable short-path query. A runner's
  // original Node may already be quote-free, and 8.3 aliases may or may not exist.
  const runtime = join(f.home, 'n s')
  mkdirSync(runtime)
  const fallbackNode = join(runtime, 'node.exe')
  // Program Files can deny a hard link; a private copy keeps the original runtime untouched.
  copyFileSync(process.execPath, fallbackNode)
  const installed = spawnSync(fallbackNode, [setup, '--home', home, '--agent', 'antigravity', '--apply'], { env: setupEnv, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(installed.status, 0, installed.stderr)
  const root = join(home, '.agent-board')
  const worker = join(root, 'agent-board-hook.mjs')
  const capture = join(root, 'synthetic-fallback-capture.json')
  const stdout = 'synthetic fallback stdout\n'
  const stderr = 'synthetic fallback stderr\n'
  writeFileSync(worker, syntheticWindowsWrapperWorker(capture, stdout, stderr, 37))
  const command = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board-local'].Stop[0].command
  assert.match(command, /^powershell\.exe /i)
  assert.ok(command.length < 8191, `${command.length} characters`)
  const payload = { unicode: '雪', apostrophe: "O'Hara", quote: '"quoted"', newline: 'line one\nline two' }
  const input = JSON.stringify(payload)
  const result = await fireCommand({ env: setupEnv }, command, input)
  assert.equal(result.status, 37, hookFailure(result))
  assert.equal(result.stdout, stdout)
  assert.equal(result.stderr, stderr)
  const saved = JSON.parse(readFileSync(capture, 'utf8'))
  assert.equal(saved.worker, worker)
  assert.equal(saved.input, input)
  assert.deepEqual(JSON.parse(saved.input), payload)
}))

test('generated Codex and Antigravity hook commands reach Node without a PowerShell wrapper, except for an unverified Windows Node path', () => fixture(async f => {
  const { windowsHookNode } = await import('../scripts/windows-hook-node.ts')
  const codex = f.install('--agent', 'codex', '--apply')
  assert.equal(codex.status, 0, codex.stderr)
  let checked = 0
  for (const groups of Object.values(JSON.parse(readFileSync(f.hooks, 'utf8')).hooks)) {
    for (const group of groups) for (const { command } of group.hooks) {
      if (!command.includes('--hook-event')) continue
      assert.doesNotMatch(command, /powershell/i)
      assert.ok(command.startsWith(`"${process.execPath}" "--input-type=commonjs" "-e" "eval(Buffer.from('`))
      checked++
    }
  }
  assert.ok(checked >= 4, `${checked} owned Codex commands checked`)

  const antigravity = f.install('--agent', 'antigravity', '--apply')
  assert.equal(antigravity.status, 0, antigravity.stderr)
  const hooks = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board-local']
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'])
  const expected = windowsHookNode(process.execPath)
  for (const group of Object.values(hooks)) {
    assert.equal(group.length, 1)
    for (const { command } of group) {
      if (process.platform === 'win32' && expected === undefined) assert.match(command, /^powershell\.exe /i)
      else {
        assert.doesNotMatch(command, /powershell/i)
        if (process.platform === 'win32') {
          assert.ok(command.startsWith(`${expected} --input-type=commonjs -e eval(Buffer.from('`))
          assert.ok(!command.includes('"'))
        }
      }
    }
  }
}))

test('Windows setup rewrites the PowerShell wrapper hook from an older install as a direct command once Node can be verified', { skip: process.platform !== 'win32' }, t => fixture(async f => {
  const { windowsHookNode } = await import('../scripts/windows-hook-node.ts')
  const home = join(f.home, "u's")
  mkdirSync(home)
  const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const powershell = join(system32, 'WindowsPowerShell', 'v1.0')
  const setupEnv = { ...Object.fromEntries(Object.entries(isolatedEnv(home)).filter(([key]) => key.toLowerCase() !== 'comspec')), PATH: [system32, powershell].join(delimiter), ComSpec: join(f.home, 'unavailable-short-path-probe.exe') }
  const nodeLookup = spawnSync(join(system32, 'where.exe'), ['node'], { env: setupEnv, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.notEqual(nodeLookup.status, 0, nodeLookup.stdout + nodeLookup.stderr)
  const runtime = join(f.home, 'n s')
  mkdirSync(runtime)
  const fallbackNode = join(runtime, 'node.exe')
  copyFileSync(process.execPath, fallbackNode)
  const installed = spawnSync(fallbackNode, [setup, '--home', home, '--agent', 'antigravity', '--apply'], { env: setupEnv, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(installed.status, 0, installed.stderr)
  const file = join(home, '.gemini', 'config', 'hooks.json')
  const config = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(config['agent-board-local']), ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'])
  for (const group of Object.values(config['agent-board-local'])) {
    assert.equal(group.length, 1)
    for (const { command } of group) assert.match(command, /^powershell\.exe /i)
  }
  const foreign = { Stop: [{ command: 'user-command' }] }
  config.custom = foreign
  writeFileSync(file, JSON.stringify(config))

  const expected = windowsHookNode(process.execPath)
  if (expected === undefined) {
    t.skip('this Node executable has no verified quote-free absolute path')
    return
  }
  const env = isolatedEnv(home)
  const upgraded = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'antigravity', '--apply'], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(upgraded.status, 0, upgraded.stderr)
  assert.deepEqual(JSON.parse(upgraded.stdout).conflicts, [])
  const updated = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(updated).sort(), ['agent-board-local', 'custom'])
  const hooks = updated['agent-board-local']
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'])
  for (const group of Object.values(hooks)) {
    assert.equal(group.length, 1)
    assert.ok(group[0].command.startsWith(`${expected} --input-type=commonjs -e eval(`))
    assert.doesNotMatch(group[0].command, /powershell/i)
  }
  assert.deepEqual(updated.custom, foreign)
  const before = readFileSync(file)
  const repeated = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'antigravity', '--apply'], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.deepEqual(readFileSync(file), before)

  const result = await fireCommand({ env }, hooks.Stop[0].command, JSON.stringify({ conversationId: 'synthetic-upgraded-session' }))
  assert.equal(result.status, 0, hookFailure(result))
  const progress = readFileSync(join(home, '.agent-board', 'progress.md'), 'utf8')
  assert.match(progress, /agent=antigravity/)
  assert.match(progress, /state=waiting/)
}))

test('Windows Antigravity queues an event with its launch process start stamp', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  holdAutomaticRecovery(f)
  const worker = join(f.root, 'agent-board-hook.mjs')
  const command = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json')))['agent-board-local'].PreInvocation[0].command
  const stampFile = join(f.root, 'powershell-stamp.json')
  const preload = join(f.home, 'queue-antigravity.cjs')
  f.save(preload, `require('node:module').registerHooks({ load(url, context, next) {
  if (url === ${JSON.stringify(pathToFileURL(worker).href)}) {
  const at = Number(process.argv[process.argv.indexOf('--hook-started') + 1])
  require('node:fs').writeFileSync(${JSON.stringify(stampFile)}, JSON.stringify({ at, nodeStarted: require('node:perf_hooks').performance.timeOrigin }))
  process.argv.push('--hook-deadline', String(Date.now() - 1))
}
  return next(url, context)
} })
`)
  const result = await fireCommand({ ...f, env: { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } }, command, JSON.stringify({ conversationId: 'stamped-antigravity-session' }))
  assert.equal(result.status, 0, hookFailure(result))
  const stamp = JSON.parse(readFileSync(stampFile))
  assert.ok(Number.isSafeInteger(stamp.at))
  assert.ok(stamp.at <= Math.floor(stamp.nodeStarted), 'the deadline must include process startup, before the worker import')
  if (!/powershell\.exe/i.test(command)) assert.equal(stamp.at, Math.floor(stamp.nodeStarted))
  const files = pendingFiles(f)
  assert.equal(files.length, 1)
  assert.match(files[0], /\.raw\.json$/)
  assert.equal(JSON.parse(readFileSync(join(f.root, 'pending', files[0]))).at, stamp.at)
  assert.match(readFileSync(join(f.root, 'hook-errors.log'), 'utf8'), /antigravity REPORTER_QUEUED/)
}))

test('Antigravity setup merges its named native hooks and removes only the owned definition', () => fixture(f => {
  const file = join(f.home, '.gemini', 'config', 'hooks.json')
  const foreign = { custom: { Stop: [{ command: 'user-command' }] } }
  f.save(file, JSON.stringify(foreign))
  const plan = JSON.parse(f.install('--agent', 'antigravity').stdout)
  assert.ok(plan.changes.some(one => one.file === file))
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), foreign)
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const config = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(config.custom, foreign.custom)
  assert.deepEqual(Object.keys(config['agent-board-local']), ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'])
  assert.equal(config.hooks, undefined)
  const stop = config['agent-board-local'].Stop[0].command
  const launch = generatedHookCommand(stop).text
  assert.match(launch, /--state['"]? ['"]?waiting['"]? ['"]?--event['"]? ['"]?Stop/)
  assert.deepEqual(JSON.parse(f.install('--agent', 'antigravity').stdout).changes, [])
  assert.equal(f.command(['--codex-remove', '--agent', 'antigravity', '--apply']).status, 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), foreign)
}))

// Capture the starter before orphaning: Windows retains its old ppid, while POSIX
// may reparent it. The test runner's pid also comes in as an argument, because a
// hook's shell or PowerShell stays alive while it waits on the tree, so watching
// the starter alone never fires. The hard limit bounds a tree whose watched
// processes stay hung.
const nativeTreeWatchdog = `
const watched = [process.ppid, Number(process.argv[2])].filter(pid => Number.isInteger(pid) && pid > 0)
setInterval(() => {
  for (const pid of watched) {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') process.exit(0)
      else if (error.code !== 'EPERM') throw error
    }
  }
}, 200)
setTimeout(() => process.exit(0), 90000)
`

// The hook command the native timeout tests run; the interrupted-run test also
// builds it inside its stand-in runner, so it uses only globals.
const nativeTreeCommand = argv => process.platform === 'win32'
  ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`& ${argv.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}; exit $LASTEXITCODE`, 'utf16le').toString('base64')}`
  : argv.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')

const nativeTreeFixture = f => {
  const ready = join(f.home, 'descendant-ready.json')
  const pulse = join(f.home, 'descendant-pulse.txt')
  const descendant = join(f.home, 'descendant.mjs')
  f.save(descendant, `import { writeFileSync } from 'node:fs'
${nativeTreeWatchdog}
writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid }))
setInterval(() => writeFileSync(${JSON.stringify(pulse)}, String(Date.now())), 20)
`)
  const parent = join(f.home, 'parent.mjs')
  const parentReady = join(f.home, 'parent-ready.json')
  f.save(parent, `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
${nativeTreeWatchdog}
writeFileSync(${JSON.stringify(parentReady)}, JSON.stringify({ pid: process.pid, ppid: process.ppid }))
spawn(process.execPath, [${JSON.stringify(descendant)}, process.argv[2] ?? ''], { stdio: 'inherit' })
setInterval(() => {}, 1000)
`)
  const command = nativeTreeCommand([process.execPath, parent, String(process.pid)])
  return { command, ready, pulse, parentReady, parent }
}

const waitForNativeTree = async ({ ready, pulse, parentReady }) => {
  const until = Date.now() + 30000
  while ((!existsSync(pulse) || !existsSync(parentReady)) && Date.now() < until) await new Promise(done => setTimeout(done, 25))
  assert.ok(existsSync(ready) && existsSync(pulse) && existsSync(parentReady), 'the synthetic parent and descendant must start before testing timeout cleanup')
}

test('an interrupted codex-local run leaves no synthetic process tree behind', { timeout: 60000 }, () => fixture(async f => {
  const tree = nativeTreeFixture(f)
  const runner = join(f.home, 'intermediate.mjs')
  const shellReady = join(f.home, 'shell-ready.json')
  // The stand-in runner starts the same hook command through a shell, as a hook
  // runner does (cmd and PowerShell on Windows), naming itself as the owner.
  // Detached, because Node's Windows child job would otherwise reap the tree with it.
  f.save(runner, `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
${nativeTreeWatchdog}
const nativeTreeCommand = ${nativeTreeCommand}
const shell = spawn(nativeTreeCommand([process.execPath, ${JSON.stringify(tree.parent)}, String(process.pid)]), { shell: true, stdio: 'ignore', detached: true, windowsHide: true })
writeFileSync(${JSON.stringify(shellReady)}, JSON.stringify({ pid: shell.pid }))
setInterval(() => {}, 1000)
`)
  let intermediate, whenClosed, hasClosed = false
  const stop = async pid => {
    // A process that already exited may have handed its pid to an unrelated one.
    if (!Number.isInteger(pid) || pid <= 0 || exitedPids.has(pid) || !isReporterAlive(pid)) return
    try { process.kill(pid) } catch (error) { if (error.code !== 'ESRCH') throw error }
    const until = Date.now() + 5000
    while (isReporterAlive(pid) && Date.now() < until) await new Promise(done => setTimeout(done, 25))
    if (isReporterAlive(pid)) throw Object.assign(new Error(`Synthetic process ${pid} did not exit`), { keepFixture: true })
  }
  const recorded = (file, key = 'pid') => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))[key] : undefined
  try {
    intermediate = spawn(process.execPath, [runner], { env: f.env, stdio: 'ignore', windowsHide: true })
    whenClosed = new Promise(done => intermediate.once('close', () => {
      hasClosed = true
      done()
    }))
    await new Promise((done, reject) => {
      intermediate.once('spawn', done)
      intermediate.once('error', reject)
    })
    await waitForNativeTree(tree)
    const pids = [recorded(tree.parentReady), recorded(tree.ready)]
    for (const pid of pids) assert.ok(isReporterAlive(pid))
    // The shell and the PowerShell between it and the parent wait on the tree, so
    // they end only once the tree does.
    const chain = [...new Set([...pids, recorded(tree.parentReady, 'ppid'), recorded(shellReady)])].filter(pid => Number.isInteger(pid) && pid !== intermediate.pid)
    // Interrupt only the runner, so tree cleanup cannot mask a missing watchdog.
    intermediate.kill()
    await whenClosed
    const until = Date.now() + 5000
    while (chain.some(isReporterAlive) && Date.now() < until) await new Promise(done => setTimeout(done, 25))
    // Record every pid seen gone, even when another one in the chain failed.
    for (const pid of chain) isReporterAlive(pid)
    for (const pid of chain) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the orphaned synthetic process must exit within five seconds')
    const last = readFileSync(tree.pulse, 'utf8')
    await new Promise(done => setTimeout(done, 250))
    assert.equal(readFileSync(tree.pulse, 'utf8'), last, 'an interrupted tree must stop writing its pulse')
  } finally {
    try {
      // Stop the runner through its handle and only while it runs: once it has closed,
      // its pid may already belong to an unrelated process.
      if (intermediate && !hasClosed) intermediate.kill()
      if (whenClosed) await whenClosed
    } finally {
      // Read each PID after stopping its starter, including a late ready file.
      try {
        await stop(recorded(tree.parentReady))
      } finally {
        try {
          await stop(recorded(tree.ready))
        } finally {
          await stop(recorded(tree.parentReady, 'ppid'))
          await stop(recorded(shellReady))
        }
      }
    }
  }
}))

test('native hook timeouts close their owned descendant tree before fixture cleanup', { timeout: 60000 }, () => fixture(async f => {
  const tree = nativeTreeFixture(f)
  let expire
  const result = nativeHook(tree.command, f.env, {}, callback => { expire = callback })
  let closed, descendantPid
  try {
    await waitForNativeTree(tree)
    descendantPid = JSON.parse(readFileSync(tree.ready, 'utf8')).pid
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0)
  } finally {
    expire()
    closed = await result
  }
  assert.equal(closed.error?.code, 'ETIMEDOUT', hookFailure(closed))
  assert.notEqual(closed.status, 0, hookFailure(closed))
  // taskkill can report a vanished child after it killed that tree. Check the
  // recorded descendant itself as well as closed pipes and stopped writes.
  if (process.platform === 'win32') assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' }, hookFailure(closed))
  else assert.equal(closed.signal, 'SIGKILL', hookFailure(closed))
  const last = readFileSync(tree.pulse, 'utf8')
  await new Promise(done => setTimeout(done, 100))
  assert.equal(readFileSync(tree.pulse, 'utf8'), last, 'a descendant must not keep writing after the helper closes')
}))

const nativeExitProbe = process.env.AGENT_BOARD_NATIVE_EXIT_PROBE
if (nativeExitProbe) test('native unreaped-tree subprocess probe', { timeout: 60000 }, async () => {
  let failure, home, tree, isStarted = false, isVerified = false
  const keep = () => {
    const parent = tree && existsSync(tree.parentReady) ? JSON.parse(readFileSync(tree.parentReady, 'utf8')) : undefined
    const descendant = tree && existsSync(tree.ready) ? JSON.parse(readFileSync(tree.ready, 'utf8')) : undefined
    writeFileSync(nativeExitProbe, JSON.stringify({ probePid: process.pid, pid: failure?.pid, parentPid: parent?.pid, parentParentPid: parent?.ppid, descendantPid: descendant?.pid, home, isStarted, isVerified, code: failure?.code, keepFixture: failure?.keepFixture }))
  }
  keep()
  await assert.rejects(fixture(async f => {
    home = f.home
    keep()
    tree = nativeTreeFixture(f)
    let expire
    const result = nativeHook(tree.command, f.env, {}, callback => { expire = callback }, () => ({ status: 1, code: 'SYNTHETIC_DENIED' }))
    try {
      await waitForNativeTree(tree)
      isStarted = true
    } finally {
      keep()
      expire()
      await result
    }
  }), error => {
    failure = error
    keep()
    return error.code === 'NATIVE_HOOK_UNREAPED' && error.keepFixture === true && error.termination.code === 'SYNTHETIC_DENIED'
  })
  assert.ok(isStarted)
  assert.ok(existsSync(home), 'unconfirmed termination must not remove the fixture')
  isVerified = true
  keep()
  process.exitCode = 1
})

// The watchdog plus up to five ten-second cleanup calls must fit the test bound.
test('failed native tree termination reports a bounded error and retains its fixture', { timeout: 120000 }, async () => {
  const control = mkdtempSync(join(tmpdir(), 'native-exit-'))
  const marker = join(control, 'owned.json')
  let owned
  try {
    const started = Date.now()
    const env = { ...isolatedEnv(control), AGENT_BOARD_NATIVE_EXIT_PROBE: marker }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^native unreaped-tree subprocess probe$', fileURLToPath(import.meta.url)], {
      env, encoding: 'utf8', windowsHide: true, timeout: 45000,
    })
    owned = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null
    // Record the probe's processes that are already gone before their pids can be reused.
    for (const key of ['pid', 'probePid', 'parentPid', 'parentParentPid', 'descendantPid']) if (Number.isInteger(owned?.[key]) && owned[key] > 0) isReporterAlive(owned[key])
    const diagnostic = assertNativeProbeReturned(result, owned, Date.now() - started, 45000)
    assert.equal(result.status, 1, diagnostic)
    assert.ok(Date.now() - started < 45000, 'the isolated test process must actually exit before the watchdog')
    assert.equal(owned?.code, 'NATIVE_HOOK_UNREAPED', diagnostic)
    assert.equal(owned.keepFixture, true)
    assert.equal(owned.isStarted, true)
    assert.equal(owned.isVerified, true, 'a probe assertion failure must not masquerade as the expected exit')
    for (const key of ['pid', 'probePid', 'parentPid', 'parentParentPid', 'descendantPid']) assert.ok(Number.isInteger(owned[key]) && owned[key] > 0, `the probe must record ${key}`)
    assert.ok(existsSync(owned.home), 'the failed process must leave its fixture for owned cleanup')
    assert.ok(result.stderr.includes('did not close') || result.stdout.includes('did not close'), diagnostic)
  } finally {
    owned ??= existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null
    // Observe the probe's exit first: rescuing its descendant earlier would hide
    // the Windows socket leak. Only this probe's recorded processes are stopped.
    const pids = [...new Set([owned?.pid, owned?.parentPid, owned?.parentParentPid, owned?.descendantPid, owned?.probePid].filter(pid => Number.isInteger(pid) && pid > 0))]
    assert.ok(!pids.includes(process.pid), 'cleanup must not target the current test runner')
    const notOurs = new Set(), stopped = []
    const isAlive = pid => {
      try { process.kill(pid, 0); return true } catch (error) {
        if (error.code === 'EPERM') notOurs.add(pid)
        else if (error.code === 'ESRCH') exitedPids.add(pid)
        else throw error
        return false
      }
    }
    const isOwnedAlive = pid => !exitedPids.has(pid) && isAlive(pid)
    // A POSIX group can outlive its leader. Windows needs each recorded child:
    // cmd may already be gone while PowerShell and parent.mjs are still alive.
    if (process.platform !== 'win32' && Number.isInteger(owned?.pid)) stopped.push({ pid: owned.pid, ...stopNativeTree({ pid: owned.pid }) })
    for (const pid of pids) if (isOwnedAlive(pid)) {
      if (process.platform === 'win32') stopped.push({ pid, ...stopNativeTree({ pid }) })
      else {
        try { process.kill(pid, 'SIGKILL'); stopped.push({ pid, status: 0 }) } catch (error) {
          if (error.code === 'EPERM') notOurs.add(pid)
          else if (error.code !== 'ESRCH') throw error
        }
      }
    }
    const until = Date.now() + 5000
    while (pids.some(isOwnedAlive) && Date.now() < until) await new Promise(done => setTimeout(done, 25))
    for (const pid of pids) if (!notOurs.has(pid) && !exitedPids.has(pid)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `Owned cleanup failed; fixture retained: ${JSON.stringify({ pid, stopped, home: owned?.home, control })}`)
    if (owned?.home) removeFixtureDirectory(owned.home, 'codex local-')
    removeFixtureDirectory(control, 'native-exit-')
  }
})

test('native Antigravity hook commands bind conversationId, record metadata only and keep Stop resumable', { timeout: 240000 }, () => fixture(async f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const hooks = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board-local']
  const conversationId = '11111111-2222-4333-8444-555555555555'
  const record = join(f.root, 'sessions', createHash('sha256').update('antigravity:' + conversationId).digest('hex') + '.json')
  // Match the native Windows executor's cmd /c + CreateProcess argument escaping,
  // not Node's shell:true workaround. The installation path deliberately has spaces.
  const fire = event => nativeHook(hooks[event][0].command, f.env, { conversationId, session_id: 'foreign-id-must-not-bind', transcriptPath: 'PRIVATE_TRANSCRIPT_DO_NOT_OPEN', workspacePaths: ['PRIVATE_WORKSPACE'], prompt: 'PRIVATE_PROMPT', toolCall: { args: 'PRIVATE_TOOL' } })
  for (const event of Object.keys(hooks)) {
    const result = await fire(event)
    assert.equal(result.error, undefined, hookFailure(result))
    assert.equal(result.status, 0, hookFailure(result))
    if (event === 'SessionStart') assert.equal(typeof JSON.parse(result.stdout).injectSteps?.[0]?.systemMessage?.systemMessage, 'string')
    else assert.deepEqual(JSON.parse(result.stdout), {})
    const saved = JSON.parse(readFileSync(record, 'utf8'))
    assert.equal(saved.session, conversationId)
    assert.equal(saved.activity.at(-1).event, event)
    assert.equal(saved.state, event === 'SessionStart' || event === 'Stop' ? 'waiting' : 'working')
    assert.ok(!JSON.stringify(saved).includes('PRIVATE_'))
  }
  const saved = JSON.parse(readFileSync(record, 'utf8'))
  assert.deepEqual(saved.activity.map(one => one.event), Object.keys(hooks))
  assert.ok(readFileSync(f.progress, 'utf8').includes('resume=' + conversationId))
  // A hook-only activity record must not leave the idle session looking like a
  // running semantic task. Explicit agent task reports remain untouched.
  const board = f.command([])
  assert.equal(board.status, 0, board.stderr)
  assert.ok(!board.stdout.includes('running:') && !board.stdout.includes('session ended'), board.stdout)
  const resumed = await fire('PreInvocation')
  assert.equal(resumed.error, undefined, hookFailure(resumed))
  assert.equal(resumed.status, 0, hookFailure(resumed))
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).state, 'working')
  assert.notEqual(f.command(['--agent-status', '--agent', 'antigravity', '--state', 'ended', '--event', 'Stop'], { conversationId }).status, 0)
}))

test('an edited Antigravity definition is a conflict rather than an automatic trust or overwrite', () => fixture(f => {
  f.install('--agent', 'antigravity', '--apply')
  const file = join(f.home, '.gemini', 'config', 'hooks.json')
  const edited = JSON.parse(readFileSync(file, 'utf8'))
  edited['agent-board-local'].enabled = false
  writeFileSync(file, JSON.stringify(edited))
  assert.notEqual(f.install('--agent', 'antigravity', '--apply').status, 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), edited)
  assert.notEqual(f.command(['--codex-remove', '--agent', 'antigravity', '--apply']).status, 0)
}))

test('concurrent agents preserve every shared progress block and foreign manual text', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shared-board-'))
  try {
    const env = isolatedEnv(home)
    const installed = spawnSync(process.execPath, [setup, '--home', home, '--codex-dir', join(home, '.codex'), '--apply'], { env, encoding: 'utf8', windowsHide: true })
    assert.equal(installed.status, 0, installed.stderr)
    const progress = join(home, '.agent-board', 'progress.md')
    writeFileSync(progress, 'Manual text must survive\r\n')
    await Promise.all(['codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity'].map(agent => new Promise((done, fail) => {
      const child = spawn(process.execPath, [join(home, '.agent-board', 'agent-board.mjs'), '--codex-report', '--agent', agent, '--session', `concurrent-${agent}-123`], { env, windowsHide: true })
      let error = ''
      child.stderr.on('data', chunk => { error += chunk })
      child.on('error', fail)
      child.on('close', code => code === 0 ? done() : fail(new Error(error)))
      child.stdin.end(JSON.stringify({ title: `Task ${agent}`, state: 'working', steps: ['- [~] Run fixture'] }))
    })))
    const text = readFileSync(progress, 'utf8')
    assert.ok(text.startsWith('Manual text must survive\r\n'))
    for (const agent of ['codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity']) assert.ok(text.includes(`agent=${agent} `), text)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('Codex prompt replays cannot reopen a finished turn or replace its current successor', () => fixture(f => {
  f.install('--apply')
  f.event('UserPromptSubmit', 'turn-1')
  f.event('Stop', 'turn-1')
  const before = readFileSync(f.progress, 'utf8')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(readFileSync(f.progress, 'utf8'), before)
  f.event('UserPromptSubmit', 'turn-2')
  const successor = readFileSync(f.progress, 'utf8')
  f.event('UserPromptSubmit', 'turn-1')
  assert.equal(readFileSync(f.progress, 'utf8'), successor)
  assert.notEqual(f.event('Stop', 'turn-1').status, 0)
}))

test('resuming the same Codex session reactivates its existing block without saying the conversation ended', () => fixture(f => {
  f.install('--apply')
  f.event('UserPromptSubmit', 'turn-1')
  f.event('SessionEnd', 'turn-1')
  assert.match(readFileSync(f.progress, 'utf8'), /state=ended/)
  assert.equal(f.event('SessionStart', null).status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-2').status, 0)
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /state=working/)
  assert.equal((text.match(/source=codex-local/g) ?? []).length, 1)
  assert.doesNotMatch(text, /state=ended/)
}))

const lockedProgress = (f, calls = 'Infinity') => {
  const marker = join(f.home, 'progress-locked')
  const preload = join(f.home, 'locked-progress.cjs')
  f.save(marker, '')
  f.save(preload, `const fs = require('node:fs')
let calls = 0
const isLocked = path => path === ${JSON.stringify(f.progress)} && fs.existsSync(${JSON.stringify(marker)}) && calls++ < ${calls}
const busy = () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }) }
for (const method of ['readFileSync', 'openSync']) {
  const original = fs[method]
  fs[method] = (path, ...args) => { if (isLocked(path)) busy(); return original(path, ...args) }
}
const rename = fs.renameSync
fs.renameSync = (from, to) => { if (isLocked(to)) busy(); return rename(from, to) }
require('node:module').syncBuiltinESMExports()
`)
  return { marker, env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } }
}

const pendingFiles = f => existsSync(join(f.root, 'pending')) ? readdirSync(join(f.root, 'pending')).filter(name => name.endsWith('.json')).sort() : []

// These regressions inspect the queue before deliberately replaying it. A live
// owner keeps automatic draining separate; its own lifecycle is tested below.
const holdAutomaticRecovery = f => {
  const normalized = process.platform === 'win32' ? resolve(f.progress).toLowerCase() : resolve(f.progress)
  const file = join(f.root, `hook-recovery-${createHash('sha256').update(normalized).digest('hex')}.json`)
  f.save(file, JSON.stringify({ version: 1, pid: process.pid, token: createHash('sha256').update(f.root).digest('hex').slice(0, 32), created: Date.now() }))
}


test('a first Codex event names its block and project after its working folder', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const cwd = join(f.home, 'synthetic-work', 'gateway-web')
  const locked = lockedProgress(f)
  const queued = f.event('UserPromptSubmit', 'turn-1', { cwd, prompt: 'PRIVATE_PROMPT' }, locked.env)
  assert.equal(queued.status, 0, queued.stderr)
  const files = pendingFiles(f)
  assert.equal(files.length, 1)
  const text = readFileSync(join(f.root, 'pending', files[0]), 'utf8')
  const entry = JSON.parse(text)
  assert.equal(entry.folder, 'gateway-web')
  assert.deepEqual(entry.payload, { session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' })
  assert.ok(!text.includes(cwd) && !text.includes(JSON.stringify(cwd).slice(1, -1)))
  assert.doesNotMatch(text, /PRIVATE_PROMPT|"cwd"|"prompt"/)
  unlinkSync(locked.marker)
  const result = f.command(['--codex-event'], { session_id: session, hook_event_name: 'SessionStart' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(f.progress, 'utf8'), /^## gateway-web\r?\n<!-- auto [^\n]+\n### gateway-web\r?$/m)
  assert.deepEqual(pendingFiles(f), [])
  for (const file of [f.progress, ...readdirSync(join(f.root, 'sessions')).map(name => join(f.root, 'sessions', name))]) {
    const saved = readFileSync(file, 'utf8')
    assert.ok(!saved.includes(cwd) && !saved.includes(JSON.stringify(cwd).slice(1, -1)) && !saved.includes('PRIVATE_PROMPT'), file)
  }
}))

test('a Codex working folder name is cleaned the way the inbox cleans it', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const messy = f.event('UserPromptSubmit', 'turn-1', { cwd: join(f.home, 'synthetic  gateway<!--web-->') })
  assert.equal(messy.status, 0, messy.stderr)
  const openclaw = f.command(['--codex-event'], { session_id: 'synthetic-openclaw-session', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', cwd: join(f.home, '.openclaw', 'workspace') })
  assert.equal(openclaw.status, 0, openclaw.stderr)
  const board = readFileSync(f.progress, 'utf8')
  assert.match(board, /^## synthetic gateway web\r?\n<!-- auto [^\n]+\n### synthetic gateway web\r?$/m)
  assert.match(board, /^## OpenClaw\r?\n<!-- auto [^\n]+\n### OpenClaw\r?$/m)
  assert.ok(!board.includes(f.home))
}))

test('a Codex event without a working folder keeps the old title and project', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const result = f.event('UserPromptSubmit')
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(f.progress, 'utf8'), /^## codex\r?\n<!-- auto [^\n]+\n### Local codex task\r?$/m)
}))

test('a Cursor event names its block after its working folder', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const root = join(f.home, 'synthetic-work', 'gateway-web')
  const result = f.command(['--codex-event', '--agent', 'cursor'], {
    conversation_id: 'synthetic-cursor-session', hook_event_name: 'beforeSubmitPrompt', generation_id: 'turn-1',
    workspace_roots: [root],
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(f.progress, 'utf8'), /^## gateway-web\r?\n<!-- auto [^\n]+agent=cursor [^\n]+\n### gateway-web\r?$/m)
  for (const file of [f.progress, ...readdirSync(join(f.root, 'sessions')).map(name => join(f.root, 'sessions', name))]) {
    const saved = readFileSync(file, 'utf8')
    assert.ok(!saved.includes(root) && !saved.includes(JSON.stringify(root).slice(1, -1)), file)
  }
}))

test('a later report with another project moves the block under that project', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  for (const project of ['alpha-web', 'beta-web']) {
    const result = f.command(['--codex-report'], { project, title: 'Gateway task', state: 'working', steps: ['- [~] Check routes'] })
    assert.equal(result.status, 0, result.stderr)
  }
  const board = readFileSync(f.progress, 'utf8')
  assert.equal((board.match(/<!-- auto /g) ?? []).length, 1)
  assert.match(board, /^## alpha-web\r?$/m)
  assert.match(board, /^## beta-web\r?\n<!-- auto /m)
  assert.ok(board.indexOf('<!-- auto ') > board.indexOf('## beta-web'))
}))

test('a report that keeps its project leaves a block someone moved where it is', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const report = () => f.command(['--codex-report'], { project: 'alpha-web', title: 'Gateway task', state: 'working', steps: ['- [~] Check routes'] })
  assert.equal(report().status, 0)
  f.save(f.progress, readFileSync(f.progress, 'utf8').replace(/^## alpha-web(?=\r?$)/m, '## Moved by hand'))
  const result = report()
  assert.equal(result.status, 0, result.stderr)
  const board = readFileSync(f.progress, 'utf8')
  assert.equal((board.match(/^## /gm) ?? []).length, 1)
  assert.match(board, /^## Moved by hand\r?\n<!-- auto [^\n]+\n### Gateway task\r?$/m)
}))

test('hook events keep a block in place under a renamed heading or a folder name ending in #', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-1', { cwd: join(f.home, 'synthetic-work', 'notes#') }).status, 0)
  assert.equal(f.event('Stop').status, 0)
  const first = readFileSync(f.progress, 'utf8')
  assert.equal((first.match(/^## /gm) ?? []).length, 1, first)
  assert.match(first, /^## notes#\r?\n<!-- auto /m)
  f.save(f.progress, first.replace(/^## notes#(?=\r?$)/m, '## Renamed by hand'))
  const result = f.event('UserPromptSubmit', 'turn-2')
  assert.equal(result.status, 0, result.stderr)
  const board = readFileSync(f.progress, 'utf8')
  assert.equal((board.match(/^## /gm) ?? []).length, 1, board)
  assert.match(board, /^## Renamed by hand\r?\n<!-- auto /m)
}))

test('a report that changes the project moves a block from the end of a CRLF file with no final line break', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const report = project => f.command(['--codex-report'], { project, title: 'Gateway task', state: 'working', steps: ['- [~] Check routes'] })
  assert.equal(report('alpha-web').status, 0)
  const crlf = readFileSync(f.progress, 'utf8').replace(/\r?\n/g, '\r\n').replace(/\r\n$/, '')
  f.save(f.progress, crlf)
  const result = report('beta-web')
  assert.equal(result.status, 0, result.stderr)
  const board = readFileSync(f.progress, 'utf8')
  const kept = crlf.slice(0, crlf.indexOf('<!-- auto '))
  assert.match(kept, /## alpha-web\r\n$/)
  assert.ok(board.startsWith(`${kept}\r\n## beta-web\r\n<!-- auto `), JSON.stringify(board))
  assert.match(board, /\r\n### Gateway task\r\n- \[~\] Check routes\r\n<!-- \/auto session=[^\r\n]+ -->\r\n$/)
  assert.doesNotMatch(board, /(?<!\r)\n/)
  assert.equal((board.match(/<!-- auto /g) ?? []).length, 1)
}))

test('a report that changes the project moves a block that sat before any heading', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const report = project => f.command(['--codex-report'], { project, title: 'Gateway task', state: 'working', steps: ['- [~] Check routes'] })
  assert.equal(report('alpha-web').status, 0)
  const first = readFileSync(f.progress, 'utf8')
  f.save(f.progress, `Notes by hand\n${first.slice(first.indexOf('<!-- auto '))}`)
  const result = report('beta-web')
  assert.equal(result.status, 0, result.stderr)
  const board = readFileSync(f.progress, 'utf8')
  assert.ok(board.startsWith('Notes by hand\n\n## beta-web\n<!-- auto '), JSON.stringify(board))
  assert.equal((board.match(/<!-- auto /g) ?? []).length, 1)
}))

test('a hook event after a report keeps the reported project', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const report = f.command(['--codex-report'], { project: 'beta-web', title: 'Gateway task', state: 'working', steps: ['- [~] Check routes'] })
  assert.equal(report.status, 0, report.stderr)
  const result = f.event('UserPromptSubmit', 'turn-1', { cwd: join(f.home, 'other-work') })
  assert.equal(result.status, 0, result.stderr)
  const board = readFileSync(f.progress, 'utf8')
  assert.match(board, /^## beta-web\r?\n<!-- auto [^\n]+\n### Gateway task\r?$/m)
  assert.equal((board.match(/^## /gm) ?? []).length, 1)
}))

test('a queued event from an older version without a folder still applies', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  f.save(join(f.root, 'pending', '001.json'), JSON.stringify({
    version: 1, progress: f.progress, mode: '--codex-event', agent: 'codex', session,
    now: new Date().toISOString(), isBoardPrompt: false, isPrompt: false,
    payload: { session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' },
  }))
  const result = f.command(['--codex-event'], { session_id: session, hook_event_name: 'SessionStart' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(f.progress, 'utf8'), /^## codex\r?\n<!-- auto [^\n]+\n### Local codex task\r?$/m)
  assert.deepEqual(pendingFiles(f), [])
}))

const assertBusyFailure = (result, f) => {
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1, result.stderr)
  assert.match(result.stderr, /EBUSY/)
  assert.ok(!result.stderr.includes(f.home), result.stderr)
  assert.doesNotMatch(result.stderr, /\bat /)
}

test('writers taking the native lock: 8 Codex hooks and 4 FORMAT.md writers lose no block on Windows', t => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  f.save(f.progress, '## FORMAT concurrency\n\nManual text must survive\n')
  const gate = join(f.home, 'writers-start')
  const barrier = join(f.home, 'writers-barrier.cjs')
  const writer = join(f.home, 'format-writer.cjs')
  f.save(barrier, `const fs = require('node:fs')
const { performance } = require('node:perf_hooks')
fs.writeFileSync(process.env.WRITER_READY, '')
const until = performance.now() + 15000
while (!fs.existsSync(process.env.WRITERS_START)) {
  if (performance.now() >= until) throw new Error('START_TIMEOUT')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
}
`)
  // Keep this independent of product helpers, using the same documented procedure as the L5 journey.
  f.save(writer, `const fs = require('node:fs')
const main = ${formatWriter.toString()}
const [file, session] = process.argv.slice(2)
// Test-only headroom lets a loaded CI machine schedule every competing writer.
main(fs, { file, session, rounds: 10, spacingMs: 50, lockWaitMs: 8000, gateMs: 15000 }).then(isWritten => { process.exitCode = isWritten ? 0 : 2 })
`)
  const hooks = Array.from({ length: 8 }, (_, i) => `format-concurrent-hook-${i}`)
  const writers = Array.from({ length: 4 }, (_, i) => `f000000${i}`)
  const owners = [...hooks.map(id => createHash('sha256').update(`codex:${id}`).digest('hex').slice(0, 8)), ...writers]
  const ready = owners.map(id => join(f.home, `writer-ready-${id}`))
  const runs = [], stops = []
  // The helper's deadline callback stops its owned tree and waits for closed stdio.
  const after = stop => {
    stops.push(stop)
    return setTimeout(stop, 20000)
  }
  const track = run => {
    runs.push(run)
    run.catch(() => {})
  }
  const environment = i => ({ ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(barrier)}`, WRITER_READY: ready[i], WRITERS_START: gate })
  try {
    for (const [i, id] of hooks.entries()) {
      track(fireHook({ ...f, env: { ...environment(i), CODEX_THREAD_ID: id } }, JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }), 20000, after))
    }
    for (const [i, id] of writers.entries()) {
      track(nativeProcess(process.execPath, [writer, f.progress, id], environment(i + hooks.length), '', after))
    }
    const until = Date.now() + 15000
    while (!ready.every(file => existsSync(file))) {
      assert.ok(Date.now() < until, `all twelve children must reach the shared start gate: ${ready.map(file => existsSync(file))}`)
      await new Promise(done => setTimeout(done, 5))
    }
    f.save(gate, '')
    const results = await Promise.all(runs)
    let text = readFileSync(f.progress, 'utf8')
    const missing = owners.filter(id => !text.includes(`<!-- auto session=${id} `))
    t.diagnostic(JSON.stringify({ phase: 'foreground-exit', exits: results.map(result => result.status), missing }))
    for (const result of results) {
      assert.equal(result.status, 0, hookFailure(result))
      assert.equal(result.error, undefined, hookFailure(result))
    }
    for (const result of results.slice(hooks.length)) {
      assert.match(result.stdout, /^WRITER_OK(?: after .*)?$/m)
      assert.doesNotMatch(result.stdout, /\bLOST\b/)
    }
    // A successful foreground command can leave its event with the bounded recovery worker.
    await waitForAutomaticRecovery(() => {
      text = readFileSync(f.progress, 'utf8')
      return pendingFiles(f).length === 0 && owners.every(id => text.includes(`<!-- auto session=${id} `))
    }, 'all twelve writer events must settle before verifying their blocks')
    assert.ok(text.includes('Manual text must survive\n'), text)
    for (const id of owners) {
      assert.equal(text.split(`<!-- auto session=${id} `).length - 1, 1, text)
      assert.equal(text.split(`<!-- /auto session=${id} -->`).length - 1, 1, text)
    }
    for (const id of writers) assert.match(text, new RegExp(`### Format writer ${id}\\r?\\n> Context: Synthetic FORMAT.md writer\\r?\\n- \\[~\\] Round 10\\r?\\n`))
    assert.deepEqual(pendingFiles(f), [])
    const leftovers = readdirSync(f.root, { recursive: true }).filter(name => /\.agent-board-lock(?:\.recover)?$|\.(?:tmp|format-tmp|board-tmp)$/.test(name))
    assert.deepEqual(leftovers, [])
  } finally {
    for (const stop of stops) stop()
    const settled = await Promise.allSettled(runs)
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value.status !== 0) t.diagnostic(hookFailure(result.value))
    }
    const failure = settled.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  }
}))

test('concurrent writers wait for autonomous recovery before asserting every block exactly once', t => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  f.save(f.progress, '## FORMAT concurrency\n\nManual text must survive\n')
  const gate = join(f.home, 'recovery-writers-start')
  const release = join(f.home, 'recovery-writers-release')
  const recoveryPids = join(f.home, 'recovery-writer-pids')
  const barrier = join(f.home, 'recovery-writers-barrier.cjs')
  const writer = join(f.home, 'recovery-format-writer.cjs')
  const hooks = Array.from({ length: 8 }, (_, i) => `recovery-concurrent-hook-${i}`)
  const writers = Array.from({ length: 4 }, (_, i) => `f100000${i}`)
  const writerDone = writers.map(id => join(f.home, `recovery-format-done-${id}`))
  const selectedHook = hooks[3]
  const selectedHash = createHash('sha256').update(`codex:${selectedHook}`).digest('hex')
  const selectedOwner = selectedHash.slice(0, 8)
  const selectedMarker = `<!-- auto session=${selectedOwner} `
  f.save(barrier, `const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const originalRename = fs.renameSync
fs.renameSync = function(from, to) {
  if (String(to) === ${JSON.stringify(f.progress)}) {
    const next = fs.readFileSync(from, 'utf8')
    const prior = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : ''
    if (next.includes(${JSON.stringify(selectedMarker)}) && !prior.includes(${JSON.stringify(selectedMarker)}) && !fs.existsSync(${JSON.stringify(release)})) {
      throw Object.assign(new Error('synthetic selected event is temporarily busy'), { code: 'EBUSY' })
    }
  }
  return originalRename.apply(this, arguments)
}
require('node:module').syncBuiltinESMExports()
if (process.argv.includes('--recover-pending')) {
  fs.mkdirSync(${JSON.stringify(recoveryPids)}, { recursive: true })
  fs.writeFileSync(path.join(${JSON.stringify(recoveryPids)}, String(process.pid)), '')
}
fs.writeFileSync(process.env.WRITER_READY, '')
const until = performance.now() + 15000
while (!fs.existsSync(process.env.WRITERS_START)) {
  if (performance.now() >= until) throw new Error('START_TIMEOUT')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
}
// The original twelve-writer test covers lock contention. Queue this event only
// after FORMAT writers finish so its deliberate busy write cannot starve them.
if (process.argv.includes('--codex-event')) {
  const writers = ${JSON.stringify(writerDone)}
  while (!writers.every(file => fs.existsSync(file))) {
    if (performance.now() >= until) throw new Error('FORMAT_WRITERS_TIMEOUT')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}
`)
  // Keep this independent of product helpers, using the same documented procedure as the L5 journey.
  f.save(writer, `const fs = require('node:fs')
const main = ${formatWriter.toString()}
const [file, session, done] = process.argv.slice(2)
// Test-only headroom lets a loaded CI machine schedule every competing writer.
main(fs, { file, session, rounds: 10, spacingMs: 50, lockWaitMs: 8000, gateMs: 15000 }).then(isWritten => {
  if (isWritten) fs.writeFileSync(done, '')
  process.exitCode = isWritten ? 0 : 2
})
`)
  const owners = [...hooks.map(id => createHash('sha256').update(`codex:${id}`).digest('hex').slice(0, 8)), ...writers]
  const ready = owners.map(id => join(f.home, `recovery-writer-ready-${id}`))
  const runs = [], stops = []
  const after = stop => {
    stops.push(stop)
    return setTimeout(stop, 20000)
  }
  const track = run => {
    runs.push(run)
    run.catch(() => {})
  }
  const environment = i => ({ ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(barrier)}`, WRITER_READY: ready[i], WRITERS_START: gate })
  const recoveryPidValues = () => existsSync(recoveryPids) ? readdirSync(recoveryPids).map(Number).filter(Number.isSafeInteger) : []
  try {
    for (const [i, id] of hooks.entries()) {
      track(fireHook({ ...f, env: { ...environment(i), CODEX_THREAD_ID: id } }, JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }), 20000, after))
    }
    for (const [i, id] of writers.entries()) {
      track(nativeProcess(process.execPath, [writer, f.progress, id, writerDone[i]], environment(i + hooks.length), '', after))
    }
    const readyUntil = Date.now() + 15000
    while (!ready.every(file => existsSync(file))) {
      assert.ok(Date.now() < readyUntil, `all twelve children must reach the shared start gate: ${ready.map(file => existsSync(file))}`)
      await new Promise(done => setTimeout(done, 5))
    }
    f.save(gate, '')
    const results = await Promise.all(runs)
    for (const result of results) {
      assert.equal(result.status, 0, hookFailure(result))
      assert.equal(result.error, undefined, hookFailure(result))
    }
    for (const result of results.slice(hooks.length)) {
      assert.match(result.stdout, /^WRITER_OK(?: after .*)?$/m)
      assert.doesNotMatch(result.stdout, /\bLOST\b/)
    }
    const beforeRelease = readFileSync(f.progress, 'utf8')
    const missingBeforeRelease = owners.filter(id => !beforeRelease.includes(`<!-- auto session=${id} `))
    const selectedPendingName = pendingFiles(f).find(name => {
      try { return readFileSync(join(f.root, 'pending', name), 'utf8').includes(selectedHook) } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    })
    assert.ok(missingBeforeRelease.includes(selectedOwner), `selected event must be absent before recovery: ${missingBeforeRelease}`)
    assert.ok(selectedPendingName, `selected event must remain identifiable in pending/: ${pendingFiles(f)}`)
    const selectedPending = JSON.parse(readFileSync(join(f.root, 'pending', selectedPendingName), 'utf8'))
    assert.equal(selectedPending.payload.session_id, selectedHook)
    assert.equal(selectedPending.payload.turn_id, 'turn-1')
    assert.ok(Number.isFinite(selectedPending.at))
    assert.ok(Number.isFinite(Date.parse(selectedPending.now)))
    await waitForAutomaticRecovery(() => recoveryPidValues().length > 0, 'the queued event must launch an owned automatic recovery helper')
    const ownedRecoveryPids = recoveryPidValues()
    assert.ok(ownedRecoveryPids.some(isReporterAlive), `an owned recovery helper must be live before release: ${ownedRecoveryPids}`)
    t.diagnostic(JSON.stringify({ phase: 'before-release', exits: results.map(result => result.status), missing: missingBeforeRelease, pending: pendingFiles(f), recoveryPids: ownedRecoveryPids }))
    f.save(release, '')
    let settled = beforeRelease
    await waitForAutomaticRecovery(() => {
      settled = readFileSync(f.progress, 'utf8')
      const isSelectedPending = existsSync(join(f.root, 'pending', selectedPendingName))
      return !isSelectedPending && owners.every(id => settled.includes(`<!-- auto session=${id} `))
    }, 'automatic recovery must drain the selected event and restore all twelve blocks')
    await waitForAutomaticRecovery(() => ownedRecoveryPids.every(pid => !isReporterAlive(pid)), 'every owned recovery helper must exit after draining', 3000)
    const saved = JSON.parse(readFileSync(join(f.root, 'sessions', `${selectedHash}.json`), 'utf8'))
    assert.equal(saved.appliedAt, selectedPending.at)
    assert.equal(Date.parse(saved.updated), Date.parse(selectedPending.now))
    assert.ok(settled.includes('Manual text must survive\n'), settled)
    for (const id of owners) {
      assert.equal(settled.split(`<!-- auto session=${id} `).length - 1, 1, settled)
      assert.equal(settled.split(`<!-- /auto session=${id} -->`).length - 1, 1, settled)
    }
    for (const id of writers) assert.match(settled, new RegExp(`### Format writer ${id}\\r?\\n> Context: Synthetic FORMAT.md writer\\r?\\n- \\[~\\] Round 10\\r?\\n`))
    assert.deepEqual(pendingFiles(f), [])
    const leftovers = readdirSync(f.root, { recursive: true }).filter(name => /\.agent-board-lock(?:\.recover)?$|\.(?:tmp|format-tmp|board-tmp)$/.test(name))
    assert.deepEqual(leftovers, [])
  } finally {
    f.save(release, '')
    for (const stop of stops) stop()
    const settled = await Promise.allSettled(runs)
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value.status !== 0) t.diagnostic(hookFailure(result.value))
    }
    for (const pid of recoveryPidValues()) if (isReporterAlive(pid)) await stopReporter(pid)
    const failure = settled.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  }
}))

test('L5 locked file: the hook retries, exits 0, and the Stop event lands on the next run', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const before = readFileSync(f.progress)
  const locked = lockedProgress(f)
  const result = f.event('Stop', 'turn-1', { prompt: 'PRIVATE_PROMPT', transcript_path: 'PRIVATE_TRANSCRIPT', tool_input: 'PRIVATE_TOOL', last_assistant_message: 'PRIVATE_MESSAGE' }, locked.env)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.deepEqual(readFileSync(f.progress), before)
  const files = pendingFiles(f)
  assert.equal(files.length, 1)
  const text = readFileSync(join(f.root, 'pending', files[0]), 'utf8')
  assert.doesNotMatch(text, /"(?:prompt|transcript(?:_path)?|tool_input|last_assistant_message)"\s*:|PRIVATE_/)
  const entry = JSON.parse(text)
  assert.equal(entry.version, 1)
  assert.ok(Number.isFinite(entry.at))
  assert.ok(files[0].startsWith(`${String(entry.at).padStart(15, '0')}-`))
  assert.equal(entry.progress, f.progress)
  assert.deepEqual(entry.payload, { session_id: session, hook_event_name: 'Stop', turn_id: 'turn-1' })
  unlinkSync(locked.marker)
  const nextSession = 'test-codex-session-456'
  const next = f.event('UserPromptSubmit', 'turn-2', { session_id: nextSession })
  assert.equal(next.status, 0, next.stderr)
  const board = readFileSync(f.progress, 'utf8')
  const firstOwner = createHash('sha256').update(`codex:${session}`).digest('hex').slice(0, 8)
  const nextOwner = createHash('sha256').update(`codex:${nextSession}`).digest('hex').slice(0, 8)
  assert.match(board, new RegExp(`<!-- auto session=${firstOwner} [^\n]*state=waiting`))
  assert.match(board, new RegExp(`<!-- auto session=${nextOwner} [^\n]*state=working`))
  assert.deepEqual(pendingFiles(f), [])
}))

test('a hook whose progress.md is locked only briefly retries and lands the event at once', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const locked = lockedProgress(f, 2)
  const result = f.event('Stop', 'turn-1', {}, locked.env)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(readFileSync(f.progress, 'utf8'), /state=waiting/)
  assert.deepEqual(pendingFiles(f), [])
}))

test('a Codex hook whose lock create gets EPERM twice exits 0 and its event lands on the board or in pending', { skip: process.platform !== 'win32' && 'EPERM means a busy lock only on Windows' }, () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  // Windows refuses a create with EPERM while the previous owner's delete is in flight, and the file is gone a moment later (#241).
  const preload = join(f.home, 'lock-create-eperm.cjs')
  f.save(preload, `const fs = require('node:fs')
const open = fs.openSync
let left = 2
fs.openSync = function (file, flags, ...rest) {
  if (left > 0 && flags === 'wx' && String(file).endsWith('.agent-board-lock')) {
    left -= 1
    throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM', errno: -4048, syscall: 'open', path: String(file) })
  }
  return open.call(this, file, flags, ...rest)
}
require('node:module').syncBuiltinESMExports()
`)
  const env = { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}` }
  const out = await fireHook({ ...f, env }, JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }))
  assert.equal(out.status, 0, hookFailure(out))
  const owner = createHash('sha256').update(`codex:${session}`).digest('hex').slice(0, 8)
  const isOnBoard = existsSync(f.progress) && readFileSync(f.progress, 'utf8').includes(`<!-- auto session=${owner} `)
  assert.ok(isOnBoard || pendingFiles(f).length === 1, `the event is neither on the board nor in pending: ${hookLog(f)}`)
  assert.doesNotMatch(hookLog(f), /REPORTER_FAILED/)
}))

test('an explicit report on a locked progress.md still says in one line that it was not saved', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const before = readFileSync(f.progress)
  const locked = lockedProgress(f)
  const result = f.command(['--codex-report'], { title: 'Task', state: 'working', steps: ['- [~] Real task'] }, locked.env)
  assertBusyFailure(result, f)
  assert.deepEqual(pendingFiles(f), [])
  assert.deepEqual(readFileSync(f.progress), before)
}))

test('an inherited hook deadline queues a locked lifecycle event before the guard closes and replays it next time', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const before = readFileSync(f.progress)
  const locked = lockedProgress(f)
  const deadline = Date.now() + 1200
  const result = f.command(['--codex-event', '--hook-deadline', String(deadline)], {
    session_id: session, hook_event_name: 'Stop', turn_id: 'turn-1', prompt: 'PRIVATE_PROMPT',
  }, locked.env)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.ok(Date.now() < deadline + 300, 'the inherited bound must shorten the 1.8 second retry budget')
  assert.deepEqual(readFileSync(f.progress), before)
  const files = pendingFiles(f)
  assert.equal(files.length, 1)
  const queued = readFileSync(join(f.root, 'pending', files[0]), 'utf8')
  assert.doesNotMatch(queued, /PRIVATE_PROMPT/)
  assert.equal(JSON.parse(queued).payload.hook_event_name, 'Stop')
  unlinkSync(locked.marker)
  assert.equal(f.event('SessionStart').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /state=waiting/)
  assert.deepEqual(pendingFiles(f), [])
}))

test('an inherited deadline also bounds the board lock wait without losing the lifecycle event', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const before = readFileSync(f.progress)
  const lock = `${f.progress}.agent-board-lock`
  f.save(lock, 'held by another process')
  const deadline = Date.now() + 1200
  const result = f.command(['--codex-event', '--hook-deadline', String(deadline)], {
    session_id: session, hook_event_name: 'Stop', turn_id: 'turn-1',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(Date.now() < deadline + 300, 'lock acquisition must share the inherited budget')
  assert.deepEqual(readFileSync(f.progress), before)
  assert.equal(pendingFiles(f).length, 1)
  assert.equal(readFileSync(lock, 'utf8'), 'held by another process')
  unlinkSync(lock)
  assert.equal(f.event('SessionStart').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /state=waiting/)
  assert.deepEqual(pendingFiles(f), [])
}))

test('a hook that replays a backlog past its inherited deadline keeps its own event queued', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const backlog = { version: 1, progress: f.progress, mode: '--codex-event', agent: 'codex', session, now: new Date().toISOString(), isBoardPrompt: false, isPrompt: false, payload: { session_id: session, hook_event_name: 'Stop', turn_id: 'turn-1' } }
  for (let index = 1; index <= 2; index++) f.save(join(f.root, 'pending', `${String(index).padStart(15, '0')}.json`), JSON.stringify(backlog))
  // The lock is free, but each write of progress.md takes longer than the whole hook budget.
  const preload = join(f.home, 'slow-progress.cjs')
  f.save(preload, `const fs = require('node:fs')
const rename = fs.renameSync
fs.renameSync = (from, to) => {
  if (to === ${JSON.stringify(f.progress)}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  return rename(from, to)
}
require('node:module').syncBuiltinESMExports()
`)
  const nextSession = 'test-codex-session-789'
  const result = f.command(['--codex-event', '--hook-deadline', String(Date.now() + 1200)], {
    session_id: nextSession, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1',
  }, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const queued = pendingFiles(f).map(name => JSON.parse(readFileSync(join(f.root, 'pending', name), 'utf8')))
  assert.equal(queued.filter(entry => entry.session === nextSession).length, 1)
  assert.equal(f.event('SessionStart').status, 0)
  const nextOwner = createHash('sha256').update(`codex:${nextSession}`).digest('hex').slice(0, 8)
  assert.match(readFileSync(f.progress, 'utf8'), new RegExp(`<!-- auto session=${nextOwner} [^\n]*state=working`))
  assert.deepEqual(pendingFiles(f), [])
}))

test('an inherited deadline still fails an explicit report instead of queuing its payload', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.report().status, 0)
  const before = readFileSync(f.progress)
  const locked = lockedProgress(f)
  const result = f.command(['--codex-report', '--hook-deadline', String(Date.now() + 700)], {
    title: 'Unsaved explicit report', state: 'done', steps: ['- [x] Private report'],
  }, locked.env)
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1)
  assert.match(result.stderr, /EBUSY|HOOK_TIMEOUT/)
  assert.deepEqual(readFileSync(f.progress), before)
  assert.deepEqual(pendingFiles(f), [])
}))

test('invalid and expired inherited deadlines fail before any lifecycle write', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const before = readFileSync(f.progress)
  for (const value of ['invalid', '1.5', 'Infinity', String(Date.now() - 1000)]) {
    const result = f.command(['--codex-event', '--hook-deadline', value], {
      session_id: session, hook_event_name: 'UserPromptSubmit',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(value === 'invalid' || value === '1.5' || value === 'Infinity' ? 'INVALID_HOOK_DEADLINE' : 'HOOK_TIMEOUT'))
    assert.deepEqual(readFileSync(f.progress), before)
    assert.deepEqual(pendingFiles(f), [])
  }
}))

test('queued hook events stop at 64 and the next one fails in one plain line', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const before = readFileSync(f.progress)
  const queued = JSON.stringify({ version: 1, progress: f.progress, mode: '--codex-event', agent: 'codex', session, now: new Date().toISOString(), isBoardPrompt: false, isPrompt: false, payload: { session_id: session, hook_event_name: 'Stop', turn_id: 'turn-1' } })
  for (let index = 0; index < 64; index++) f.save(join(f.root, 'pending', `${String(index).padStart(3, '0')}.json`), queued)
  const locked = lockedProgress(f)
  const result = f.event('Stop', 'turn-1', {}, locked.env)
  assertBusyFailure(result, f)
  assert.equal(pendingFiles(f).length, 64)
  assert.deepEqual(readFileSync(f.progress), before)
}))

test('a queued event that can no longer apply is dropped without blocking the others', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  f.save(join(f.root, 'pending', '001.json'), 'not valid JSON')
  f.save(join(f.root, 'pending', '002.json'), JSON.stringify({
    version: 1, progress: f.progress, mode: '--codex-event', agent: 'codex', session,
    now: new Date().toISOString(), isBoardPrompt: false, isPrompt: false,
    payload: { session_id: session, hook_event_name: 'Stop', turn_id: 'turn-1' },
  }))
  const result = f.event('SessionStart', null, { session_id: 'test-codex-session-456' })
  assert.equal(result.status, 0, result.stderr)
  const owner = createHash('sha256').update(`codex:${session}`).digest('hex').slice(0, 8)
  assert.match(readFileSync(f.progress, 'utf8'), new RegExp(`<!-- auto session=${owner} [^\n]*state=waiting`))
  assert.deepEqual(pendingFiles(f), [])
}))

test('a refused rename onto progress.md is a lock on Windows and a failure elsewhere, and any other refusal still fails', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const before = readFileSync(f.progress)
  const preload = join(f.home, 'refused-rename.cjs')
  f.save(preload, `const fs = require('node:fs')
const code = process.env.REFUSED_CODE
const rename = fs.renameSync
fs.renameSync = (from, to) => { if (to === ${JSON.stringify(f.progress)}) throw Object.assign(new Error(code + ': operation not permitted, rename'), { code, syscall: 'rename', path: from, dest: to }); return rename(from, to) }
require('node:module').syncBuiltinESMExports()
`)
  const refused = code => f.event('Stop', 'turn-1', {}, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, REFUSED_CODE: code })
  const locked = refused('EPERM')
  if (process.platform === 'win32') {
    assert.equal(locked.status, 0, locked.stderr)
    assert.equal(pendingFiles(f).length, 1)
    for (const name of pendingFiles(f)) unlinkSync(join(f.root, 'pending', name))
  } else {
    assert.equal(locked.status, 1, locked.stderr)
    assert.equal(locked.stderr.trim().split(/\r?\n/).length, 1, locked.stderr)
    assert.match(locked.stderr, /EPERM/)
    assert.deepEqual(pendingFiles(f), [])
  }
  const denied = refused('EACCES')
  assert.equal(denied.status, 1, denied.stderr)
  assert.match(denied.stderr, /EACCES/)
  assert.deepEqual(pendingFiles(f), [])
  assert.deepEqual(readFileSync(f.progress), before)
}))

test('a queued status event older than its session\'s last report is dropped instead of moving the session back', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const grok = 'test-grok-session-123'
  const status = state => f.command(['--agent-status', '--agent', 'grok', '--state', state], { session_id: grok })
  assert.equal(status('working').status, 0, status('working').stderr)
  const owner = createHash('sha256').update(`grok:${grok}`).digest('hex').slice(0, 8)
  assert.match(readFileSync(f.progress, 'utf8'), new RegExp(`<!-- auto session=${owner} [^\n]*state=working`))
  f.save(join(f.root, 'pending', '001.json'), JSON.stringify({
    version: 1, progress: f.progress, mode: '--agent-status', agent: 'grok', session: grok, status: 'waiting',
    now: new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), isBoardPrompt: false, isPrompt: false, payload: {},
  }))
  assert.equal(f.event('UserPromptSubmit').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), new RegExp(`<!-- auto session=${owner} [^\n]*state=working`))
  assert.deepEqual(pendingFiles(f), [])
}))

test('a read-only progress.md fails in one plain line without queuing the event', { skip: process.platform !== 'win32' }, () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const before = readFileSync(f.progress)
  try {
    chmodSync(f.progress, 0o444)
    const result = f.event('Stop')
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stderr.trim().split(/\r?\n/).length, 1, result.stderr)
    assert.match(result.stderr, /EPERM/)
    assert.ok(!result.stderr.includes(f.home), result.stderr)
    assert.doesNotMatch(result.stderr, /\bat /)
    assert.deepEqual(pendingFiles(f), [])
    assert.deepEqual(readFileSync(f.progress), before)
  } finally { chmodSync(f.progress, 0o666) }
}))

test('an explicit Windows report into a denied folder gives a plain permission message and is not queued', { skip: process.platform !== 'win32' && 'Windows ACLs only' }, () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  const folder = join(f.home, 'denied-progress')
  const progress = join(folder, 'progress.md')
  f.save(progress, '## Synthetic denied report\n')
  const before = readFileSync(progress)
  await withDeniedCreation(folder, () => {
    const result = f.command(['--codex-report', '--progress-file', progress, '--lang', 'en'], { title: 'Synthetic report', state: 'working', steps: ['- [~] Synthetic work'] })
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.trim().split(/\r?\n/).length, 1, result.stderr)
    assert.match(result.stderr, /permission denied/i)
    assert.doesNotMatch(result.stderr, /LOCK_BUSY|\bat /)
    assert.ok(!result.stderr.includes(f.home), result.stderr)
    assert.deepEqual(pendingFiles(f), [])
    assert.deepEqual(readFileSync(progress), before)
    assert.equal(existsSync(`${progress}.agent-board-lock`), false)
  })
  const accepted = f.command(['--codex-report', '--progress-file', progress, '--lang', 'en'], { title: 'Synthetic report', state: 'working', steps: ['- [~] Synthetic work'] })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.match(readFileSync(progress, 'utf8'), /Synthetic report/)
}))

test('a queued event with a system error is kept and the hook fails in one plain line', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const owner = createHash('sha256').update(`codex:${session}`).digest('hex')
  const record = join(f.root, 'sessions', `${owner}.json`)
  unlinkSync(record)
  mkdirSync(record)
  const file = join(f.root, 'pending', '001.json')
  const queued = JSON.stringify({
    version: 1, progress: f.progress, mode: '--codex-event', agent: 'codex', session,
    now: new Date().toISOString(), isBoardPrompt: false, isPrompt: false,
    payload: { session_id: session, hook_event_name: 'Stop', turn_id: 'turn-1' },
  })
  f.save(file, queued)
  const before = readFileSync(f.progress)
  const result = f.event('SessionStart', null, { session_id: 'test-codex-session-456' })
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1, result.stderr)
  assert.match(result.stderr, /EISDIR/)
  assert.ok(!result.stderr.includes(f.home), result.stderr)
  assert.doesNotMatch(result.stderr, /\bat /)
  assert.deepEqual(pendingFiles(f), ['001.json'])
  assert.equal(readFileSync(file, 'utf8'), queued)
  assert.deepEqual(readFileSync(f.progress), before)
}))

test('hook replay yields at its deadline while an explicit report drains every queued entry', async () => {
  for (const mode of ['--codex-event', '--codex-report']) await fixture(f => {
    assert.equal(f.install('--apply').status, 0)
    assert.equal(f.event('UserPromptSubmit').status, 0)
    const queued = {
      version: 1, progress: f.progress, mode: '--codex-event', agent: 'codex', session,
      now: new Date().toISOString(), isBoardPrompt: false, isPrompt: false,
      payload: { session_id: session, hook_event_name: 'Stop', turn_id: 'turn-1' },
    }
    f.save(join(f.root, 'pending', '001.json'), JSON.stringify(queued))
    f.save(join(f.root, 'pending', '002.json'), JSON.stringify(queued))
    const preload = join(f.home, 'replay-clock.cjs')
    f.save(preload, `const fs = require('node:fs')
const { performance } = require('node:perf_hooks')
let now = 0
Object.defineProperty(performance, 'now', { value: () => now })
const read = fs.readFileSync
fs.readFileSync = (file, ...args) => {
  const text = read(file, ...args)
  if (file === ${JSON.stringify(join(f.root, 'pending', '001.json'))}) now = 2500
  return text
}
require('node:module').syncBuiltinESMExports()
`)
    const env = { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }
    const result = f.command([mode], mode === '--codex-report'
      ? { title: 'Explicit report', state: 'done', steps: ['- [x] Finished'] }
      : { session_id: 'test-codex-session-456', hook_event_name: 'SessionStart' }, env)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    if (mode === '--codex-report') {
      assert.deepEqual(pendingFiles(f), [])
      assert.equal(JSON.parse(result.stdout).state, 'done')
    } else {
      assert.equal(result.stdout, '')
      const files = pendingFiles(f)
      assert.equal(files.length, 2)
      assert.ok(files.includes('002.json'))
      assert.ok(!files.includes('001.json'))
      const current = JSON.parse(readFileSync(join(f.root, 'pending', files.find(name => name !== '002.json')), 'utf8'))
      assert.equal(current.session, 'test-codex-session-456')
      assert.ok(files.some(name => name.startsWith(`${String(current.at).padStart(15, '0')}-`)))
      assert.doesNotMatch(readFileSync(f.progress, 'utf8'), new RegExp(createHash('sha256').update('codex:test-codex-session-456').digest('hex').slice(0, 8)))
    }
  })
})

test('queued status events use their start time and reject invalid timestamps', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const grok = 'test-grok-session-123'
  const result = f.command(['--agent-status', '--agent', 'grok', '--state', 'working'], { session_id: grok })
  assert.equal(result.status, 0, result.stderr)
  const owner = createHash('sha256').update(`grok:${grok}`).digest('hex')
  const saved = JSON.parse(readFileSync(join(f.root, 'sessions', `${owner}.json`), 'utf8'))
  const at = Date.parse(saved.updated) - 1
  for (const [index, timestamp] of [at, null, 'invalid', 'overflow'].entries()) f.save(join(f.root, 'pending', `${index}.json`), JSON.stringify({
    version: 1, progress: f.progress, mode: '--agent-status', agent: 'grok', session: grok, status: 'waiting', at: timestamp,
    now: new Date(Date.parse(saved.updated) + 60000).toISOString(), isBoardPrompt: false, isPrompt: false, payload: {},
  }).replace('"at":"overflow"', '"at":1e400'))
  assert.equal(f.event('UserPromptSubmit').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), new RegExp(`<!-- auto session=${owner.slice(0, 8)} [^\n]*state=working`))
  assert.deepEqual(pendingFiles(f), [])
}))

// Runs /progress connect from a copy of the bundle, as the plugin does, outside the installer's folder.
const legacyConnect = (f, progress, mode = 'connect', lang = 'en') => {
  const source = readFileSync(resolve('hooks/board-script.ts'), 'utf8')
  const runner = join(f.home, 'connect-runner.mjs')
  if (!existsSync(runner)) f.save(runner, JSON.parse(source.slice(source.indexOf('export const BOARD_SCRIPT = ') + 'export const BOARD_SCRIPT = '.length)))
  const request = { mode, home: f.home, progress, lang, node: process.version, codexExecutable: join(f.home, 'missing-control.exe') }
  const result = spawnSync(process.execPath, [runner, '--legacy-connect-request', JSON.stringify(request)], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  return runner
}
// A board path with characters such as `~` (a Windows short name, as on CI runners) is written into
// skills as code points; read those back before looking for a folder name (as legacy-connect tests do).
const decoded = text => text.replace(/String\.fromCodePoint\(([\d,]+)\)/g, (_, codes) => String.fromCodePoint(...codes.split(',').map(Number)))

test('connection data roots distinguish POSIX apostrophes from encoded PowerShell quoting', async () => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  try {
    const { connectDataRoots } = await import('../hooks/connect-pure.ts')
    const { antigravityCommand } = await import('../hooks/local-agents.ts')
    assert.ok(!connectDataRoots("node '/home/synthetic''x/.claude/progress-hook.mjs'").includes("/home/synthetic'x/.claude"))
    const folder = "C:\\Users\\o'synthetic\\.claude"
    const command = antigravityCommand(['node', `${folder}\\progress-hook.mjs`], true, value => value)
    assert.ok(connectDataRoots(command).includes(folder))
  } finally { resolver.deregister() }
})

test('direct Windows hook argument data preserves ownership roots without executing the command', async () => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  try {
    const { connectDataRoots } = await import('../hooks/connect-pure.ts')
    const { antigravityCommand, directHookArgs, hookCommandArgs } = await import('../hooks/local-agents.ts')
    for (const folder of ["C:\\Users\\o'synthetic\\.claude", "C:\\Users\\o''synthetic\\.claude", 'C:\\synthetic 雪\\board']) {
      const worker = `${folder}\\progress-hook.mjs`
      const argv = hookCommandArgs('C:\\Program Files\\nodejs\\node.exe', folder, 'antigravity', worker, `${folder}\\progress.md`, 'Stop', 'waiting')
      const command = antigravityCommand(argv, true, value => value, 'C:\\synthetic\\node.exe')
      assert.deepEqual(directHookArgs(command), [argv[0], ...argv.slice(4)])
      assert.ok(connectDataRoots(command).includes(folder))
      assert.ok(connectDataRoots(JSON.stringify({ command })).includes(folder))
    }
    const data = JSON.stringify(['node', 'C:\\synthetic\\progress-hook.mjs'])
    const source = `process.argv=JSON.parse(${JSON.stringify(data)});globalThis.syntheticHookDecodeExecuted=true`
    const command = `node --input-type=commonjs -e eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString('utf8'))`
    assert.ok(connectDataRoots(command).includes('C:\\synthetic'))
    assert.equal(globalThis.syntheticHookDecodeExecuted, undefined)
    assert.equal(directHookArgs(command.replace('--input-type=commonjs', '--input-type=module')), null)
    for (const source of ['throw Error()', 'process.argv=JSON.parse("[1]");', 'process.argv=JSON.parse("{}");']) {
      const invalid = `node --input-type=commonjs -e eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString('utf8'))`
      assert.equal(directHookArgs(invalid), null)
    }
    assert.throws(() => antigravityCommand(['node', 'worker.mjs'], true, value => value, 'C:\\synthetic\\node.exe'), /INVALID_HOOK_COMMAND/)
    for (const executable of ['node', 'node.exe']) assert.throws(() => antigravityCommand(['node'], true, value => value, executable), /UNSAFE_HOOK_EXECUTABLE/)
    assert.throws(() => antigravityCommand(['node'], true, value => value, 'node&other'), /UNSAFE_HOOK_EXECUTABLE/)
  } finally { resolver.deregister() }
})

test('Windows Antigravity hook commands start the verified Node directly and keep PowerShell only for an unverified path', async () => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  try {
    const { antigravityCommand, directHookArgs, encodedCommandText, hookCommandArgs } = await import('../hooks/local-agents.ts')
    const home = "C:\\Users\\O'Hara 雪\\.agent-board"
    const worker = home + '\\agent-board-hook.mjs'
    const progress = home + '\\progress.md'
    const argv = hookCommandArgs('C:\\Program Files\\nodejs\\node.exe', home, 'antigravity', worker, progress, 'Stop', 'waiting')
    const node = 'C:\\PROGRA~1\\nodejs\\node.exe'
    const quote = value => '"' + value + '"'
    const command = antigravityCommand(argv, true, quote, node)
    assert.ok(command.startsWith(node + " --input-type=commonjs -e eval(Buffer.from('"))
    assert.doesNotMatch(command, /powershell/i)
    assert.ok(!command.includes('"'))
    assert.ok(command.length < 8191, `${command.length} characters`)
    const args = directHookArgs(command)
    assert.deepEqual(args, [argv[0], ...argv.slice(4)])
    assert.ok(args.includes(worker))
    assert.ok(args.includes(progress))
    const encoded = /Buffer\.from\('([^']+)'/.exec(command)[1]
    assert.ok(Buffer.from(encoded, 'base64').toString('utf8').includes('--hook-started'))

    const fallback = antigravityCommand(argv, true, quote)
    const prefix = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '
    assert.ok(fallback.startsWith(prefix))
    assert.ok(fallback.length < 8191, `${fallback.length} characters`)
    const source = encodedCommandText(fallback.slice(prefix.length))
    assert.ok(source.includes("'C:\\Program Files\\nodejs\\node.exe'"))
    assert.ok(source.includes(worker.replaceAll("'", "''")))
    assert.ok(source.includes('--hook-started'))
    for (const executable of [
      'C:\\Program Files\\nodejs\\node.exe', 'C:\\n"x\\node.exe', 'C:\\n%x%\\node.exe',
      'C:\\n&x\\node.exe', 'C:\\n^x\\node.exe', 'C:\\n!x\\node.exe', 'C:\\n(x)\\node.exe',
      "C:\\n'x\\node.exe", 'C:\\n,x\\node.exe', 'C:\\n;x\\node.exe', 'C:\\n=x\\node.exe', 'C:\\n雪\\node.exe',
      'C:\\nodejs\\node.cmd', '\\\\server\\share\\node.exe', 'node.exe',
    ]) assert.throws(() => antigravityCommand(argv, true, quote, executable), /UNSAFE_HOOK_EXECUTABLE/)

    const posixQuote = value => "'" + value + "'"
    const posix = antigravityCommand(argv, false, posixQuote)
    assert.equal(posix, argv.map(posixQuote).join(' '))
    assert.doesNotMatch(posix, /powershell/i)
  } finally { resolver.deregister() }
})

test('antigravity: setup-agent takes over a home the legacy connect hooked first', () => fixture(async f => {
  mkdirSync(join(f.home, '.gemini', 'antigravity'), { recursive: true })
  const progress = join(f.home, '.claude', 'progress.md')
  legacyConnect(f, progress)
  const skill = join(f.home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')
  const previous = readFileSync(skill, 'utf8')
  const installed = f.install('--agent', 'antigravity', '--apply')
  assert.equal(installed.status, 0, installed.stderr + installed.stdout)
  assert.ok(!(installed.stderr + installed.stdout).includes('INSTALL_CONFLICT'))
  const installerSkill = readFileSync(skill, 'utf8')
  assert.notEqual(installerSkill, previous)
  assert.equal(installerSkill, readFileSync(f.skill, 'utf8'))
  const config = join(f.home, '.gemini', 'config', 'hooks.json')
  assert.ok(JSON.parse(readFileSync(config, 'utf8'))['agent-board-local'])
  legacyConnect(f, progress)
  const hooks = JSON.parse(readFileSync(config, 'utf8'))
  assert.equal(hooks['agent-board'], undefined)
  assert.ok(hooks['agent-board-local'])
  assert.equal(readFileSync(skill, 'utf8'), installerSkill)
  const runner = legacyConnect(f, progress, 'status')
  const status = spawnSync(process.execPath, [runner, '--legacy-connect-request', JSON.stringify({ mode: 'status', home: f.home, progress, lang: 'en', node: process.version })], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(status.status, 0, status.stderr + status.stdout)
  const agent = JSON.parse(status.stdout).state.setup.agents.find(one => one.agent === 'antigravity')
  assert.ok(agent)
  assert.notEqual(agent.hook, 'failed')
  assert.notEqual(agent.board, 'failed')
  const doctor = f.command(['--codex-doctor', '--agent', 'antigravity'])
  assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout)
  assert.equal(JSON.parse(doctor.stdout).reportHook, 'installer')
  // The connect never records setup-agent's skill as its own output, and its remove leaves it.
  const { owned } = JSON.parse(readFileSync(join(f.home, '.agent-board', 'legacy-connect.json'), 'utf8'))
  const installerHash = createHash('sha256').update(installerSkill).digest('hex')
  assert.ok(!Object.values(owned).includes(installerHash), JSON.stringify(owned))
  legacyConnect(f, progress, 'remove')
  assert.equal(readFileSync(skill, 'utf8'), installerSkill)
  assert.ok(JSON.parse(readFileSync(config, 'utf8'))['agent-board-local'])
}))

test('antigravity connect: where setup-agent hooked Antigravity first, the connect adds no definition and no worker', () => fixture(async f => {
  mkdirSync(join(f.home, '.gemini', 'antigravity'), { recursive: true })
  const progress = join(f.home, '.claude', 'progress.md')
  const installed = f.install('--agent', 'antigravity', '--apply')
  assert.equal(installed.status, 0, installed.stderr + installed.stdout)
  const runner = legacyConnect(f, progress)
  const hooks = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json'), 'utf8'))
  assert.equal(hooks['agent-board'], undefined)
  assert.ok(hooks['agent-board-local'])
  assert.ok(!existsSync(join(f.home, '.claude', 'progress-hook.mjs')))
  const status = spawnSync(process.execPath, [runner, '--legacy-connect-request', JSON.stringify({ mode: 'status', home: f.home, progress, lang: 'en', node: process.version })], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(status.status, 0, status.stderr + status.stdout)
  const agent = JSON.parse(status.stdout).state.setup.agents.find(one => one.agent === 'antigravity')
  assert.ok(agent)
  assert.notEqual(agent.hook, 'failed')
}))

test("antigravity: setup-agent takes over the connect's skill for a progress file outside the default folder", () => fixture(async f => {
  mkdirSync(join(f.home, '.gemini', 'antigravity'), { recursive: true })
  const progress = join(f.home, 'synthetic-progress-folder', 'progress.md')
  mkdirSync(dirname(progress), { recursive: true })
  legacyConnect(f, progress)
  const skill = join(f.home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')
  // The connect's skill runs the board beside that progress file.
  assert.ok(decoded(readFileSync(skill, 'utf8')).includes('synthetic-progress-folder'))
  const installed = f.install('--agent', 'antigravity', '--apply')
  assert.equal(installed.status, 0, installed.stderr + installed.stdout)
  assert.ok(!(installed.stderr + installed.stdout).includes('INSTALL_CONFLICT'))
  assert.equal(readFileSync(skill, 'utf8'), readFileSync(f.skill, 'utf8'))
}))

test("antigravity: setup-agent takes over the connect's skill for a progress file that CLAUDE_CONFIG_DIR or CLAUDE_PROGRESS_FILE names", async () => {
  for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROGRESS_FILE']) await fixture(async f => {
    mkdirSync(join(f.home, '.gemini', 'antigravity'), { recursive: true })
    const progress = join(f.home, 'synthetic-config-folder', 'progress.md')
    mkdirSync(dirname(progress), { recursive: true })
    legacyConnect(f, progress)
    // Only the variable names the file: the connect's own record of it is taken out.
    const record = join(f.root, 'legacy-connect.json')
    const { connectedProgress, ...rest } = JSON.parse(readFileSync(record, 'utf8'))
    assert.ok(connectedProgress, name)
    f.save(record, JSON.stringify(rest))
    const skill = join(f.home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')
    const install = (extraEnv, ...args) => spawnSync(process.execPath, [setup, '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--agent', 'antigravity', '--apply', ...args], { env: { ...f.env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    // Without the variable nothing marks the skill as the connect's, so setup-agent refuses it.
    const refused = install({}, '--json')
    assert.match(refused.stderr + refused.stdout, /INSTALL_CONFLICT/, name)
    const installed = install({ [name]: name === 'CLAUDE_CONFIG_DIR' ? dirname(progress) : progress })
    assert.equal(installed.status, 0, `${name}: ${installed.stderr}${installed.stdout}`)
    assert.ok(!(installed.stderr + installed.stdout).includes('INSTALL_CONFLICT'), name)
    assert.equal(readFileSync(skill, 'utf8'), readFileSync(f.skill, 'utf8'), name)
  })
})

test('antigravity: setup-agent keeps the content and order of third-party hooks through install and removal', () => fixture(async f => {
  const config = join(f.home, '.gemini', 'config', 'hooks.json')
  const foreign = { 'orca-status': Object.fromEntries(['PreInvocation', 'PostInvocation', 'Stop', 'PostToolUse'].map(event => [event, [{ type: 'command', command: `synthetic-orca-${event}`, timeout: 5 }]])) }
  const original = JSON.stringify(foreign, null, 2) + '\n'
  f.save(config, original)
  const installed = f.install('--agent', 'antigravity', '--apply')
  assert.equal(installed.status, 0, installed.stderr + installed.stdout)
  const text = readFileSync(config, 'utf8')
  const hooks = JSON.parse(text)
  assert.deepEqual(hooks['orca-status'], foreign['orca-status'])
  assert.equal(Object.keys(hooks)[0], 'orca-status')
  const slice = value => value.slice(value.indexOf('  "orca-status":'), value.indexOf('\n  }') + '\n  }'.length)
  assert.equal(slice(text), slice(original))
  const removed = f.command(['--codex-remove', '--agent', 'antigravity', '--apply'])
  assert.equal(removed.status, 0, removed.stderr + removed.stdout)
  assert.equal(readFileSync(config, 'utf8'), original)
}))

test('Antigravity reports its own waiting question with the command bound by native hooks', async () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN']) for (const connector of ['setup', 'connect']) await fixture(async f => {
    mkdirSync(join(f.home, '.gemini', 'antigravity-cli'), { recursive: true })
    // POSIX hook installation rejects shell expansion characters; its quoted
    // paths still accept spaces and apostrophes. Windows uses encoded hooks.
    const folder = process.platform === 'win32' ? 'synthetic %literal% ` $ board' : "synthetic literal's board"
    const progress = join(f.home, folder, 'progress.md')
    if (connector === 'connect') legacyConnect(f, progress, 'connect', lang)
    else {
      const installed = f.install('--agent', 'antigravity', '--lang', lang, '--progress-file', progress, '--apply')
      assert.equal(installed.status, 0, `${connector} ${lang}: ${installed.stderr}${installed.stdout}`)
    }
    const hooks = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json'), 'utf8'))[connector === 'connect' ? 'agent-board' : 'agent-board-local']
    const conversationId = 'synthetic-agy-question-session'
    const payload = { conversationId, session_id: 'synthetic-foreign-session', invocationNum: 0, transcriptPath: 'PRIVATE_TRANSCRIPT_DO_NOT_OPEN', prompt: 'PRIVATE_PROMPT', toolCall: { args: 'PRIVATE_TOOL' } }
    const fire = event => fireCommand(f, hooks[event][0].command, JSON.stringify(payload))
    const started = await fire('SessionStart')
    assert.equal(started.status, 0, hookFailure(started))
    const context = JSON.parse(started.stdout).injectSteps?.[0]?.systemMessage?.systemMessage
    assert.equal(typeof context, 'string', `${connector} ${lang}: missing native report context`)
    assert.ok(!context.includes('PRIVATE_'))
    const command = context.match(/`(node [^`\r\n]+)`/)?.[1]
    assert.ok(command, context)
    const first = await fire('PreInvocation')
    assert.equal(first.status, 0, hookFailure(first))
    assert.equal(JSON.parse(first.stdout).injectSteps?.[0]?.ephemeralMessage, context)
    payload.invocationNum = 1
    const later = await fire('PreInvocation')
    assert.equal(later.status, 0, hookFailure(later))
    assert.deepEqual(JSON.parse(later.stdout), {})
    const foreign = '<!-- auto session=abcdef12 agent=opencode state=waiting updated=2026-10-24T00:00:00Z -->\n### Foreign question\n- [?] Blue or green?\n<!-- /auto session=abcdef12 -->\n'
    f.save(progress, readFileSync(progress, 'utf8') + foreign)
    const steps = ['- [x] Synthetic first step', '- [x] Synthetic second step', '- [?] Blue or green?']
    const report = await fireCommand(f, command, JSON.stringify({ title: 'Synthetic Antigravity question', project: 'Synthetic test', state: 'waiting', steps }))
    assert.equal(report.status, 0, hookFailure(report))
    const block = createHash('sha256').update(`antigravity:${conversationId}`).digest('hex').slice(0, 8)
    assert.equal(JSON.parse(report.stdout).block, block)
    for (const event of ['PostInvocation', 'Stop']) {
      const result = await fire(event)
      assert.equal(result.status, 0, hookFailure(result))
      assert.deepEqual(JSON.parse(result.stdout), {})
    }
    const text = readFileSync(progress, 'utf8')
    const own = text.match(new RegExp(`<!-- auto session=${block} [^\\n]*-->[\\s\\S]*?<!-- /auto session=${block} -->`))?.[0]
    assert.ok(own, text)
    assert.match(own.split('\n')[0], / agent=antigravity /)
    assert.match(own.split('\n')[0], / state=waiting /)
    for (const step of steps) assert.ok(own.includes(step), own)
    assert.ok(text.includes(foreign), 'another agent question must remain unchanged')
    assert.ok(!text.includes('PRIVATE_') && !text.includes('synthetic-foreign-session'))
    assert.equal(hookLog(f), '')
  })
})

test('antigravity: one synthetic agy turn reaches the board through the connected hook', () => fixture(async f => {
  mkdirSync(join(f.home, '.gemini', 'antigravity-cli'), { recursive: true })
  const progress = join(f.home, '.claude', 'progress.md')
  legacyConnect(f, progress)
  const hooks = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board']
  const conversationId = 'synthetic-agy-turn'
  for (const [event, [hook]] of Object.entries(hooks)) {
    const result = await fireCommand(f, hook.command, JSON.stringify({ conversationId, workspacePaths: ['PRIVATE_WORKSPACE'], prompt: 'PRIVATE_PROMPT' }))
    assert.equal(result.status, 0, `${event} ${hookFailure(result)}`)
    if (event === 'SessionStart') assert.equal(typeof JSON.parse(result.stdout).injectSteps?.[0]?.systemMessage?.systemMessage, 'string')
    else assert.equal(result.stdout.trim(), '{}', event)
  }
  const text = readFileSync(progress, 'utf8')
  const marker = text.split(/\r?\n/).find(line => line.includes('agent=antigravity'))
  assert.ok(marker, text)
  assert.match(marker, /state=waiting/)
  assert.match(marker, new RegExp(`resume=${conversationId}`))
  assert.ok(!text.includes('PRIVATE_'))
  assert.equal(hookLog(f), '')
}))

test('antigravity: a payload the board refuses logs its reason and still answers Antigravity', async () => {
  // A Chinese board brackets the code in full-width parentheses; the log keeps the same code.
  for (const lang of ['en', 'zh-TW', 'zh-CN']) await fixture(async f => {
    mkdirSync(join(f.home, '.gemini', 'antigravity-cli'), { recursive: true })
    const progress = join(f.home, '.claude', 'progress.md')
    legacyConnect(f, progress, 'connect', lang)
    assert.ok(readFileSync(join(f.home, '.claude', 'agent-board.mjs'), 'utf8').split('\n', 1)[0].includes(`"lang":"${lang}"`), lang)
    const [hook] = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board'].PreInvocation
    // No conversationId: the board refuses it, and the log names why with a fixed code only.
    const result = await fireCommand(f, hook.command, JSON.stringify({ conversation_id: 'synthetic-wrong-field', prompt: 'PRIVATE_PROMPT' }))
    assert.equal(result.status, 0, hookFailure(result))
    assert.equal(result.stdout.trim(), '{}')
    assert.ok(!result.stderr.includes('AGENT_BOARD_REASON'), result.stderr)
    assert.match(hookLog(f), /antigravity REPORTER_FAILED INVALID_SESSION\r?\n$/, lang)
    assert.ok(!hookLog(f).includes('PRIVATE_') && !hookLog(f).includes('synthetic-wrong-field'))
  })
})

test('doctor: a host with a skill but no report hook is named', () => fixture(async f => {
  mkdirSync(join(f.home, '.gemini', 'antigravity-cli'), { recursive: true })
  const progress = join(f.home, '.claude', 'progress.md')
  const runner = legacyConnect(f, progress)
  const isolated = ['--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes')]
  const doctor = () => {
    const result = spawnSync(process.execPath, [runner, ...isolated, '--codex-doctor', '--agent', 'antigravity'], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const connected = doctor()
  assert.equal(connected.reportHook, 'connect')
  assert.equal(connected.problem, undefined)
  // An older /progress connect wrote only the skill.
  const config = join(f.home, '.gemini', 'config', 'hooks.json')
  const hooks = JSON.parse(readFileSync(config, 'utf8'))
  delete hooks['agent-board']
  writeFileSync(config, JSON.stringify(hooks))
  const skillOnly = doctor()
  assert.equal(skillOnly.reportHook, 'none')
  assert.equal(skillOnly.problem, 'Antigravity: skill only, no report hook')
  // Once the connect is taken out, the installer's hook is the one named.
  legacyConnect(f, progress, 'remove')
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const installed = doctor()
  assert.equal(installed.reportHook, 'installer')
  assert.equal(installed.problem, undefined)
}))

test('manual hook recovery drains a queued final Stop without waiting for stdin', () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit', 'manual-recovery-turn').status, 0)
  const foreign = '<!-- auto session=abcdef12 agent=opencode state=waiting updated=2026-10-24T00:00:00Z -->\n### Foreign bytes stay exact\n- [?] Blue or green?\n<!-- /auto session=abcdef12 -->\n'
  f.save(f.progress, readFileSync(f.progress, 'utf8') + foreign)
  const locked = lockedProgress(f)
  const queued = f.event('Stop', 'manual-recovery-turn', {}, locked.env)
  assert.equal(queued.status, 0, queued.stderr)
  const [name] = pendingFiles(f)
  assert.ok(name, 'the locked direct CLI event must enter pending/')
  const source = JSON.parse(readFileSync(join(f.root, 'pending', name), 'utf8'))
  assert.equal(source.payload.hook_event_name, 'Stop')
  unlinkSync(locked.marker)
  const isolated = ['--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes')]
  const recovered = await nativeProcess(process.execPath, [f.script, ...isolated, '--recover-hooks'], f.env, '', callback => setTimeout(callback, 10000), stopNativeTree, { isInputOpen: true })
  assert.equal(recovered.error, undefined, hookFailure(recovered))
  assert.equal(recovered.status, 0, hookFailure(recovered))
  assert.deepEqual(JSON.parse(recovered.stdout), { recoveryVersion: 1, processed: 1, pending: 0 })
  assert.equal(recovered.stderr, '')
  assert.deepEqual(pendingFiles(f), [])
  const owner = createHash('sha256').update(`codex:${session}`).digest('hex')
  const record = JSON.parse(readFileSync(join(f.root, 'sessions', `${owner}.json`), 'utf8'))
  assert.equal(record.state, 'waiting')
  assert.equal(record.appliedAt, source.at)
  assert.equal(Date.parse(record.updated), Date.parse(source.now))
  const board = readFileSync(f.progress, 'utf8')
  assert.match(board, new RegExp(`<!-- auto session=${owner.slice(0, 8)} [^\n]*state=waiting`))
  assert.equal(board.split(foreign).length, 2, 'the unrelated block bytes must remain exact and singular')
}))

test('manual hook recovery drops stale metadata and leaves other boards and messages untouched', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const activeSession = 'manual-grok-session-123'
  const working = f.command(['--agent-status', '--agent', 'grok', '--state', 'working'], { session_id: activeSession })
  assert.equal(working.status, 0, working.stderr)
  const owner = createHash('sha256').update(`grok:${activeSession}`).digest('hex')
  const recordFile = join(f.root, 'sessions', `${owner}.json`)
  const newer = JSON.parse(readFileSync(recordFile, 'utf8'))
  const boardBefore = readFileSync(f.progress)
  const staleAt = newer.appliedAt - 1000
  f.save(join(f.root, 'pending', '001.json'), JSON.stringify({
    version: 1, progress: f.progress, mode: '--agent-status', agent: 'grok', session: activeSession, status: 'waiting',
    now: new Date(staleAt).toISOString().replace(/\.\d{3}Z$/, 'Z'), at: staleAt, isBoardPrompt: false, isPrompt: false,
    payload: {},
  }) + '\n')
  const otherProgress = join(f.home, 'other-board', 'progress.md')
  const otherBoard = Buffer.from('## Other board\r\n\r\nForeign bytes stay exact.\r\n')
  f.save(otherProgress, otherBoard)
  const foreignName = '002.json'
  const foreignQueue = JSON.stringify({
    version: 1, progress: otherProgress, mode: '--agent-status', agent: 'grok', session: 'foreign-hook-session-123', status: 'waiting',
    now: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), at: Date.now(), isBoardPrompt: false, isPrompt: false, payload: {},
  }) + '\n'
  f.save(join(f.root, 'pending', foreignName), foreignQueue)
  const messages = join(f.root, 'messages', 'messages.json')
  const messageBytes = Buffer.from(JSON.stringify({ messages: [{ id: 'SYNTHETIC-UNCERTAIN-1', target: 'binding1', turn: 'turn1', from: 'board', to: 'codex:synthetic', text: 'Synthetic message must not be sent', status: 'uncertain', updated: 1, reply: '', error: 'ACK_TIMEOUT' }] }, null, 2) + '\n')
  f.save(messages, messageBytes)
  const invoked = join(f.home, 'unexpected-model-send')
  const standIn = join(f.home, 'unexpected-model-send.cjs')
  f.save(standIn, `require('node:fs').writeFileSync(${JSON.stringify(invoked)}, 'invoked')\n`)
  const result = f.command(['--recover-hooks', '--messages-dir', dirname(messages)], undefined, { AGENT_BOARD_CODEX: standIn })
  assert.equal(result.status, 0, result.stderr)
  // The result counts this selected board; a different board's queue remains below.
  assert.deepEqual(JSON.parse(result.stdout), { recoveryVersion: 1, processed: 1, pending: 0 })
  assert.equal(result.stderr, '')
  assert.deepEqual(readFileSync(f.progress), boardBefore)
  assert.deepEqual(JSON.parse(readFileSync(recordFile, 'utf8')), newer)
  assert.equal(readFileSync(join(f.root, 'pending', foreignName), 'utf8'), foreignQueue)
  assert.deepEqual(pendingFiles(f), [foreignName])
  assert.deepEqual(readFileSync(otherProgress), otherBoard)
  assert.deepEqual(readFileSync(messages), messageBytes)
  assert.equal(existsSync(invoked), false, 'recovery must not invoke a model, Send transport, or approval path')
}))

const automaticRecoveryFixture = f => {
  const pidFile = join(f.home, 'automatic-recovery.pid')
  const attemptsFile = join(f.home, 'automatic-recovery-attempts')
  const preload = join(f.home, 'observe-automatic-recovery.cjs')
  f.save(preload, `const child = require('node:child_process')
const fs = require('node:fs')
const spawn = child.spawn
const spawnSync = child.spawnSync
child.spawn = (executable, args, options) => {
  const result = spawn(executable, args, options)
  if (Array.isArray(args) && args.includes('--recover-pending')) fs.writeFileSync(${JSON.stringify(pidFile)}, String(result.pid))
  return result
}
child.spawnSync = (executable, args, options) => {
  if (Array.isArray(args) && args.includes('--recover-hooks')) fs.appendFileSync(${JSON.stringify(attemptsFile)}, '1\\n')
  return spawnSync(executable, args, options)
}
require('node:module').syncBuiltinESMExports()
`)
  const normalized = process.platform === 'win32' ? resolve(f.progress).toLowerCase() : resolve(f.progress)
  const lease = join(f.root, `hook-recovery-${createHash('sha256').update(normalized).digest('hex')}.json`)
  const hooks = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board-local']
  const conversationId = 'synthetic-automatic-recovery-session'
  const payload = JSON.stringify({ conversationId, invocationNum: 0, prompt: 'PRIVATE_PROMPT', approval: 'PRIVATE_APPROVAL' })
  const record = join(f.root, 'sessions', createHash('sha256').update(`antigravity:${conversationId}`).digest('hex') + '.json')
  return { pidFile, attemptsFile, preload, lease, hooks, conversationId, payload, record }
}

const waitForAutomaticRecovery = async (condition, message, limit = 10000) => {
  const until = Date.now() + limit
  while (!condition() && Date.now() < until) await new Promise(done => setTimeout(done, 25))
  assert.ok(condition(), message)
}

test('automatic hook recovery applies a queued Antigravity Stop after the lock is released', { timeout: 30000 }, () => fixture(async f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const recovery = automaticRecoveryFixture(f)
  const started = await fireCommand(f, recovery.hooks.PreInvocation[0].command, recovery.payload)
  assert.equal(started.status, 0, hookFailure(started))
  assert.equal(JSON.parse(readFileSync(recovery.record, 'utf8')).state, 'working')
  const foreign = Buffer.from('<!-- auto session=abcdef12 agent=opencode state=waiting updated=2026-10-24T00:00:00Z -->\r\n### Foreign bytes stay exact\r\n- [?] Blue or green?\r\n<!-- /auto session=abcdef12 -->\r\n')
  f.save(f.progress, Buffer.concat([readFileSync(f.progress), foreign]))
  const messages = join(f.root, 'messages', 'messages.json')
  const messageBytes = Buffer.from('{"messages":[{"id":"SYNTHETIC-UNCERTAIN-AUTO","status":"uncertain","text":"PRIVATE_MESSAGE"}]}\n')
  f.save(messages, messageBytes)
  const locked = lockedProgress(f)
  const env = { ...f.env, NODE_OPTIONS: `${locked.env.NODE_OPTIONS} --require ${JSON.stringify(recovery.preload)}` }
  let recoveryPid
  try {
    const stopped = await fireCommand({ ...f, env }, recovery.hooks.Stop[0].command, recovery.payload)
    assert.equal(stopped.status, 0, hookFailure(stopped))
    await waitForAutomaticRecovery(() => existsSync(recovery.pidFile) && pendingFiles(f).length === 1, 'the installed Stop hook must queue once and launch its owned recovery helper')
    recoveryPid = Number(readFileSync(recovery.pidFile, 'utf8'))
    assert.ok(isReporterAlive(recoveryPid), 'the tracked automatic recovery helper must be live before the lock is released')
    const [queuedName] = pendingFiles(f)
    const source = JSON.parse(readFileSync(join(f.root, 'pending', queuedName), 'utf8'))
    assert.equal(source.event, 'Stop')
    assert.doesNotMatch(JSON.stringify(source), /PRIVATE_/)
    unlinkSync(locked.marker)
    await waitForAutomaticRecovery(() => pendingFiles(f).length === 0 && !existsSync(recovery.lease) && JSON.parse(readFileSync(recovery.record, 'utf8')).state === 'waiting', 'automatic recovery must drain the selected queue, remove its lease and apply waiting')
    await waitForAutomaticRecovery(() => !isReporterAlive(recoveryPid), 'the owned automatic recovery helper must exit after draining', 3000)
    const saved = JSON.parse(readFileSync(recovery.record, 'utf8'))
    assert.equal(saved.appliedAt, source.at)
    assert.equal(Date.parse(saved.updated), Date.parse(source.now))
    assert.ok(readFileSync(f.progress).includes(foreign), 'the unrelated foreign block bytes must remain exact')
    assert.deepEqual(readFileSync(messages), messageBytes)
  } finally {
    rmSync(locked.marker, { force: true })
    if (Number.isInteger(recoveryPid) && isReporterAlive(recoveryPid)) await stopReporter(recoveryPid)
  }
}))

test('automatic hook recovery exhausts three locked attempts and leaves manual recovery possible', { timeout: 30000 }, () => fixture(async f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const recovery = automaticRecoveryFixture(f)
  const started = await fireCommand(f, recovery.hooks.PreInvocation[0].command, recovery.payload)
  assert.equal(started.status, 0, hookFailure(started))
  const locked = lockedProgress(f)
  const env = { ...f.env, NODE_OPTIONS: `${locked.env.NODE_OPTIONS} --require ${JSON.stringify(recovery.preload)}` }
  let recoveryPid
  try {
    const stopped = await fireCommand({ ...f, env }, recovery.hooks.Stop[0].command, recovery.payload)
    assert.equal(stopped.status, 0, hookFailure(stopped))
    await waitForAutomaticRecovery(() => existsSync(recovery.pidFile) && pendingFiles(f).length === 1, 'the installed Stop hook must launch recovery for its queued metadata')
    recoveryPid = Number(readFileSync(recovery.pidFile, 'utf8'))
    await waitForAutomaticRecovery(() => !isReporterAlive(recoveryPid), 'the bounded automatic helper must exit while the synthetic lock remains held')
    assert.equal(readFileSync(recovery.attemptsFile, 'utf8'), '1\n1\n1\n')
    assert.match(hookLog(f), /antigravity HOOK_RECOVERY_NEEDED\r?\n$/)
    assert.equal(existsSync(recovery.lease), false)
    assert.equal(pendingFiles(f).length, 1)
    assert.equal(JSON.parse(readFileSync(recovery.record, 'utf8')).state, 'working')
    unlinkSync(locked.marker)
    const manual = f.command(['--recover-hooks', '--progress-file', f.progress])
    assert.equal(manual.status, 0, manual.stderr)
    assert.deepEqual(JSON.parse(manual.stdout), { recoveryVersion: 1, processed: 1, pending: 0 })
    assert.deepEqual(pendingFiles(f), [])
    assert.equal(JSON.parse(readFileSync(recovery.record, 'utf8')).state, 'waiting')
  } finally {
    rmSync(locked.marker, { force: true })
    if (Number.isInteger(recoveryPid) && isReporterAlive(recoveryPid)) await stopReporter(recoveryPid)
  }
}))

test('automatic hook recovery preserves an old claim while its owner is still alive', () => fixture(f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const recovery = automaticRecoveryFixture(f)
  const claim = JSON.stringify({ version: 1, pid: process.pid, token: 'a'.repeat(32), created: Date.now() - 60000 })
  f.save(recovery.lease, claim)
  const worker = join(f.root, 'agent-board-hook.mjs')
  const args = [worker, '--hook-version', '1', '--hook-event', 'Stop', '--agent-status', '--agent', 'antigravity', '--state', 'waiting', '--event', 'Stop', '--progress-file', f.progress, '--hook-started', String(Date.now() - 3000)]
  const result = spawnSync(process.execPath, args, { env: { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(recovery.preload)}` }, input: recovery.payload, encoding: 'utf8', windowsHide: true, timeout: 5000 })
  assert.equal(result.status, 0, hookFailure(result))
  assert.equal(pendingFiles(f).length, 1)
  assert.equal(readFileSync(recovery.lease, 'utf8'), claim)
  assert.equal(existsSync(recovery.pidFile), false, 'a live claim must coalesce a new job without spawning another helper')
  assert.equal(existsSync(`${recovery.lease}.recover`), false)
  const manual = f.command(['--recover-hooks', '--progress-file', f.progress])
  assert.equal(manual.status, 0, manual.stderr)
  assert.deepEqual(JSON.parse(manual.stdout), { recoveryVersion: 1, processed: 1, pending: 0 })
  assert.equal(readFileSync(recovery.lease, 'utf8'), claim, 'manual recovery does not take another live owner claim')
}))

test('automatic hook recovery replaces a stale claim only after its owner has exited', { timeout: 15000 }, () => fixture(async f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const recovery = automaticRecoveryFixture(f)
  const exited = spawnSync(process.execPath, ['-e', ''], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 5000 })
  assert.equal(exited.status, 0)
  assert.ok(Number.isInteger(exited.pid) && exited.pid > 0)
  assert.equal(isReporterAlive(exited.pid), false)
  f.save(recovery.lease, JSON.stringify({ version: 1, pid: exited.pid, token: 'b'.repeat(32), created: Date.now() - 31000 }))
  // An earlier worker could crash while holding its secondary guard. The new
  // handover uses the existing board lock and must not depend on that tombstone.
  const crashedGuard = JSON.stringify({ version: 1, pid: exited.pid, token: 'c'.repeat(32), created: Date.now() - 31000 })
  f.save(`${recovery.lease}.recover`, crashedGuard)
  const args = [join(f.root, 'agent-board-hook.mjs'), '--hook-version', '1', '--hook-event', 'Stop', '--agent-status', '--agent', 'antigravity', '--state', 'waiting', '--event', 'Stop', '--progress-file', f.progress, '--hook-started', String(Date.now() - 3000)]
  let pid
  try {
    const result = spawnSync(process.execPath, args, { env: { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(recovery.preload)}` }, input: recovery.payload, encoding: 'utf8', windowsHide: true, timeout: 5000 })
    assert.equal(result.status, 0, hookFailure(result))
    await waitForAutomaticRecovery(() => existsSync(recovery.pidFile), 'a proven-dead stale owner must allow one new helper')
    pid = Number(readFileSync(recovery.pidFile, 'utf8'))
    await waitForAutomaticRecovery(() => !isReporterAlive(pid), 'the replacement helper must exit')
    assert.equal(existsSync(recovery.lease), false)
    assert.equal(readFileSync(`${recovery.lease}.recover`, 'utf8'), crashedGuard)
    assert.deepEqual(pendingFiles(f), [])
    assert.equal(JSON.parse(readFileSync(recovery.record, 'utf8')).state, 'waiting')
  } finally {
    if (Number.isInteger(pid) && isReporterAlive(pid)) await stopReporter(pid)
  }
}))

test('automatic hook recovery serializes competing stale replacement candidates', { timeout: 15000 }, () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  const selected = process.platform === 'win32' ? resolve(f.progress).toLowerCase() : resolve(f.progress)
  const claim = join(f.root, `hook-recovery-${createHash('sha256').update(selected).digest('hex')}.json`)
  const dead = spawnSync(process.execPath, ['-e', ''], { env: f.env, encoding: 'utf8', timeout: 3000, windowsHide: true })
  assert.equal(dead.status, 0)
  assert.throws(() => process.kill(dead.pid, 0), error => error.code === 'ESRCH')
  f.save(claim, JSON.stringify({ version: 1, pid: dead.pid, token: '1'.repeat(32), created: Date.now() - 60000 }))
  const guard = JSON.stringify({ version: 1, pid: dead.pid, token: '2'.repeat(32), created: Date.now() - 60000 })
  f.save(`${claim}.recover`, guard)
  const worker = join(f.home, 'replacement-candidate.mjs')
  f.save(worker, `import { claimHookRecovery } from ${JSON.stringify(new URL('../scripts/hook-recovery-owner.ts', import.meta.url).href)}
import { withLocalLock } from ${JSON.stringify(new URL('../scripts/local-lock.ts', import.meta.url).href)}
const [root, progress, value] = process.argv.slice(2)
const request = { ...JSON.parse(value), pid: process.pid }
const owned = withLocalLock(progress + '.agent-board-lock', () => claimHookRecovery(root, progress, request), { waitMs: 1500 })
process.stdout.write(JSON.stringify({ owned, pid: process.pid, token: request.token }))
`)
  const created = Date.now()
  const results = await Promise.all(['3', '4'].map(token => nativeProcess(process.execPath, [worker, f.root, f.progress, JSON.stringify({ previous: '1'.repeat(32), token: token.repeat(32), created })], f.env, '', callback => setTimeout(callback, 5000))))
  const outcomes = results.map(result => {
    assert.equal(result.error, undefined, hookFailure(result))
    assert.equal(result.status, 0, hookFailure(result))
    return JSON.parse(result.stdout)
  })
  const winners = outcomes.filter(outcome => outcome.owned)
  assert.equal(winners.length, 1)
  assert.deepEqual(JSON.parse(readFileSync(claim, 'utf8')), { version: 1, pid: winners[0].pid, token: winners[0].token, created })
  assert.equal(readFileSync(`${claim}.recover`, 'utf8'), guard)
  assert.equal(existsSync(`${f.progress}.agent-board-lock`), false)
  assert.equal(existsSync(`${f.progress}.agent-board-lock.recover`), false)
}))

test('a recovery whose first pass fails before the lock releases its claim, so the next hook\'s recovery runs at once', { timeout: 30000 }, () => fixture(async f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const recovery = automaticRecoveryFixture(f)
  const failing = join(f.home, 'first-pass-fails.cjs')
  // The helper that makes the first pass ends before it takes the board lock (it timed out, say).
  f.save(failing, `const child = require('node:child_process')
const prior = child.spawnSync
child.spawnSync = (executable, args, options) => Array.isArray(args) && args.includes('--recover-hooks')
  ? { status: null, signal: null, error: Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }
  : prior(executable, args, options)
require('node:module').syncBuiltinESMExports()
`)
  const env = { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(recovery.preload)} --require ${JSON.stringify(failing)}` }
  const worker = join(f.root, 'agent-board-hook.mjs')
  // Started 3 s ago, the hook is past its deadline: it queues the event and asks for recovery at once.
  const fire = () => spawnSync(process.execPath, [worker, '--hook-version', '1', '--hook-event', 'Stop', '--agent-status', '--agent', 'antigravity', '--state', 'waiting', '--event', 'Stop', '--progress-file', f.progress, '--hook-started', String(Date.now() - 3000)], { env, input: recovery.payload, encoding: 'utf8', windowsHide: true, timeout: 5000 })
  const pids = []
  try {
    for (const round of [1, 2]) {
      rmSync(recovery.pidFile, { force: true })
      const result = fire()
      assert.equal(result.status, 0, hookFailure(result))
      await waitForAutomaticRecovery(() => existsSync(recovery.pidFile), `hook ${round} must start a recovery helper at once, not wait out the first helper's claim`)
      const pid = Number(readFileSync(recovery.pidFile, 'utf8'))
      pids.push(pid)
      await waitForAutomaticRecovery(() => !isReporterAlive(pid), `recovery helper ${round} must exit`)
      assert.equal(existsSync(recovery.lease), false, `recovery helper ${round} left its claim behind`)
      assert.equal(pendingFiles(f).length, round)
    }
    assert.match(hookLog(f), /antigravity HOOK_RECOVERY_NEEDED/)
    // Neither event was lost: a replay with a working helper applies both.
    const manual = f.command(['--recover-hooks', '--progress-file', f.progress])
    assert.equal(manual.status, 0, manual.stderr)
    assert.deepEqual(JSON.parse(manual.stdout), { recoveryVersion: 1, processed: 2, pending: 0 })
    assert.deepEqual(pendingFiles(f), [])
  } finally {
    for (const pid of pids) if (isReporterAlive(pid)) await stopReporter(pid)
  }
}))

test('a hook run whose reporter fails saves the event to pending instead of dropping it', { timeout: 30000 }, () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  // Only for its observers: the recovery helper's pid file and attempt count.
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const recovery = automaticRecoveryFixture(f)
  const fault = join(f.home, 'hook-reporter-fault.cjs')
  // Only the reporter the hook starts fails (it carries --hook-recovery-parent); the recovery helper's replay works.
  f.save(fault, `const fs = require('node:fs')
if (process.argv.includes('--hook-recovery-parent')) {
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (String(to) === ${JSON.stringify(f.progress)}) throw Object.assign(new Error('PRIVATE_PATH PRIVATE_INPUT'), { code: 'EIO' })
    return rename(from, to)
  }
  require('node:module').syncBuiltinESMExports()
}
`)
  const env = { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(recovery.preload)} --require ${JSON.stringify(fault)}` }
  const owner = createHash('sha256').update(`codex:${session}`).digest('hex').slice(0, 8)
  const hasEvent = () => existsSync(f.progress) && readFileSync(f.progress, 'utf8').includes(`<!-- auto session=${owner} `)
  let pid
  try {
    const failed = await fireHook({ ...f, env }, JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'PRIVATE_PROMPT' }))
    assert.equal(failed.status, 0, hookFailure(failed))
    assert.match(hookLog(f), /codex REPORTER_FAILED EIO\r?\n[^\n]* codex REPORTER_QUEUED\r?\n$/)
    assert.ok(existsSync(recovery.pidFile), 'a failed run must ask for recovery')
    pid = Number(readFileSync(recovery.pidFile, 'utf8'))
    await waitForAutomaticRecovery(() => hasEvent() && pendingFiles(f).length === 0, 'recovery must apply the event the failed run saved')
    await waitForAutomaticRecovery(() => !isReporterAlive(pid), 'the recovery helper must exit after draining', 5000)
    assert.ok(!readFileSync(f.progress, 'utf8').includes('PRIVATE_PROMPT'))
    // A payload the board refuses cannot succeed on replay: it is logged and not saved.
    rmSync(recovery.pidFile, { force: true })
    const refused = await fireHook({ ...f, env }, JSON.stringify({ session_id: 'bad?', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }))
    assert.equal(refused.status, 0, hookFailure(refused))
    assert.match(hookLog(f), /codex REPORTER_FAILED INVALID_SESSION\r?\n$/)
    assert.deepEqual(pendingFiles(f), [])
    assert.equal(existsSync(recovery.pidFile), false)
  } finally {
    if (Number.isInteger(pid) && isReporterAlive(pid)) await stopReporter(pid)
  }
}))

// Who started a Codex session (#399): the hook reads the first record of the session's history
// file, keeps four short fields of it and nothing else, and writes no block for a strong run.
const RUN_SECRET = 'DO-NOT-STORE-THIS-PRIVATE-MESSAGE'
const helperSession = 'helper-codex-session-456'
const execSession = 'exec-codex-session-789'
const secondSession = 'second-codex-session-321'
// A history file is named for its session, as Codex names it: rollout-<time>-<session id>.jsonl.
const rollout = (f, id, meta) => {
  const file = join(f.home, '.codex', 'sessions', '2026', '10', '27', `rollout-2026-10-27T12-00-00-${id}.jsonl`)
  const first = { timestamp: '2026-10-27T12:00:00Z', type: 'session_meta', payload: { id, cwd: join(f.home, 'demo'), base_instructions: { text: RUN_SECRET }, ...meta } }
  f.save(file, `${JSON.stringify(first)}\n${JSON.stringify({ type: 'response_item', payload: { text: RUN_SECRET } })}\n`)
  return file
}
const markerOf = (f, id) => {
  const text = readFileSync(f.progress, 'utf8')
  const owner = createHash('sha256').update(`codex:${id}`).digest('hex')

  const marker = text.split('\n').find(line => line.startsWith('<!-- auto ') && line.includes(`owner=${owner}`))
  // A missing block must fail the test, not satisfy a check that something is absent.
  assert.ok(marker, `no block for ${id}`)

  return marker
}
const everyFile = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? everyFile(join(dir, entry.name)) : [join(dir, entry.name)])

test('a Codex helper thread writes no block, and the person\'s own session carries no mark', () => fixture(f => {
  f.install('--apply')
  const cwd = join(f.home, 'demo')
  const person = rollout(f, session, { originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' })
  const helper = rollout(f, helperSession, { originator: 'Codex Desktop', source: { subagent: { thread_spawn: { parent_thread_id: session, agent_nickname: 'Archimedes' } } }, thread_source: 'subagent', parent_thread_id: session })
  assert.equal(f.event('UserPromptSubmit', 'turn-1', { cwd, transcript_path: person }).status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-h', { session_id: helperSession, cwd, transcript_path: helper }).status, 0)
  assert.doesNotMatch(markerOf(f, session), /origin=|parent=/)
  assertNoBlock(f, helperSession)
  assert.equal(sessionRecord(f, helperSession).parent, session)
  // Only the four fields are kept: nothing else of the history file reaches the board or its records.
  for (const file of everyFile(f.root)) assert.ok(!readFileSync(file, 'latin1').includes(RUN_SECRET), file)
  assert.ok(!readFileSync(f.hooks, 'latin1').includes('Archimedes'))
  assert.ok(!readFileSync(f.progress, 'utf8').includes('Archimedes'))
}))

test('a codex exec run with no parent named writes nothing beside the person working in the same project', () => fixture(f => {
  f.install('--apply')
  const cwd = join(f.home, 'demo')
  const person = rollout(f, session, { originator: 'codex-tui', source: 'vscode', thread_source: 'user' })
  const run = rollout(f, execSession, { originator: 'codex_exec', source: 'exec', thread_source: 'user' })
  assert.equal(f.event('UserPromptSubmit', 'turn-1', { cwd, transcript_path: person }).status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-e', { session_id: execSession, cwd, transcript_path: run }).status, 0)
  assertNoBlock(f, execSession)
  assert.equal(sessionRecord(f, execSession).parent, undefined)
  // A later Stop keeps the run suppressed after the person's session has stopped.
  assert.equal(f.event('Stop', 'turn-1', { cwd, transcript_path: person }).status, 0)
  assert.equal(f.event('Stop', 'turn-e', { session_id: execSession, cwd, transcript_path: run }).status, 0)
  assertNoBlock(f, execSession)
  assert.equal(sessionRecord(f, execSession).parent, undefined)
  assert.doesNotMatch(markerOf(f, session), /origin=/)
}))

test('a Codex session with no history file is only a hint, and its first prompt with one takes the mark back', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('SessionStart', 'turn-1', { transcript_path: null }).status, 0)
  assert.match(markerOf(f, session), / origin=run -->$/)
  const person = rollout(f, session, { originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' })
  assert.equal(f.event('UserPromptSubmit', 'turn-2', { transcript_path: person }).status, 0)
  assert.doesNotMatch(markerOf(f, session), /origin=/)
  // A hint never undoes a plain statement, however late it comes.
  assert.equal(f.event('UserPromptSubmit', 'turn-3', { transcript_path: null }).status, 0)
  assert.doesNotMatch(markerOf(f, session), /origin=/)
}))

test('a Codex session whose host sends no path, or a path that is not a Codex history file, stays a row', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.notEqual(markerOf(f, session), '')
  assert.doesNotMatch(markerOf(f, session), /origin=/)
  // A file with another name is never opened, even when its first line says it is a run.
  const decoy = join(f.home, 'codex-history', 'notes.jsonl')
  f.save(decoy, `${JSON.stringify({ type: 'session_meta', payload: { originator: 'codex_exec', source: 'exec' } })}\n`)
  assert.equal(f.event('UserPromptSubmit', 'turn-2', { transcript_path: decoy }).status, 0)
  assert.doesNotMatch(markerOf(f, session), /origin=/)
  // A history file whose first line is not a session record gives no signal.
  const odd = join(f.home, 'codex-history', `rollout-2026-10-27T12-00-00-${session}.jsonl`)
  f.save(odd, `${JSON.stringify({ type: 'response_item', payload: { originator: 'codex_exec', source: 'exec' } })}\nnot json\n`)
  assert.equal(f.event('UserPromptSubmit', 'turn-3', { transcript_path: odd }).status, 0)
  assert.doesNotMatch(markerOf(f, session), /origin=/)
}))

test('a hook that names the history file of another session gets no signal from it, and the same file read for its own session does', () => fixture(f => {
  f.install('--apply')
  const cwd = join(f.home, 'demo')
  // The other session's file says it is a run; this session is not that one.
  const other = rollout(f, execSession, { originator: 'codex_exec', source: 'exec', thread_source: 'user' })
  assert.equal(f.event('UserPromptSubmit', 'turn-1', { cwd, transcript_path: other }).status, 0)
  assert.doesNotMatch(markerOf(f, session), /origin=/)
  // A session id that is only the tail of the other session's id does not open it either.
  assert.equal(f.event('UserPromptSubmit', 'turn-t', { session_id: 'codex-session-789', cwd, transcript_path: other }).status, 0)
  assert.doesNotMatch(markerOf(f, 'codex-session-789'), /origin=/)
  assert.equal(f.event('UserPromptSubmit', 'turn-e', { session_id: execSession, cwd, transcript_path: other }).status, 0)
  assertNoBlock(f, execSession)
}))

test('a codex exec run writes nothing when two person sessions are working in its project', () => fixture(f => {
  f.install('--apply')
  const cwd = join(f.home, 'demo')
  const first = rollout(f, session, { originator: 'codex-tui', source: 'vscode', thread_source: 'user' })
  const second = rollout(f, secondSession, { originator: 'codex-tui', source: 'vscode', thread_source: 'user' })
  const run = rollout(f, execSession, { originator: 'codex_exec', source: 'exec', thread_source: 'user' })
  assert.equal(f.event('UserPromptSubmit', 'turn-1', { cwd, transcript_path: first }).status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-2', { session_id: secondSession, cwd, transcript_path: second }).status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-e', { session_id: execSession, cwd, transcript_path: run }).status, 0)
  assertNoBlock(f, execSession)
  assert.equal(sessionRecord(f, execSession).parent, undefined)
  assert.doesNotMatch(markerOf(f, session), /origin=/)
  assert.doesNotMatch(markerOf(f, secondSession), /origin=/)
}))

test('agents that give no signal keep their sessions as rows', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.command(['--agent-status', '--agent', 'opencode', '--state', 'working'], { session_id: 'opencode-session-123', transcript_path: null }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /agent=opencode/)
  assert.doesNotMatch(readFileSync(f.progress, 'utf8'), /origin=/)
}))

const sessionRecord = (f, id) => JSON.parse(readFileSync(join(f.root, 'sessions', createHash('sha256').update(`codex:${id}`).digest('hex') + '.json'), 'utf8'))
const assertNoBlock = (f, id) => assert.ok(!existsSync(f.progress) || !readFileSync(f.progress, 'utf8').includes(createHash('sha256').update(`codex:${id}`).digest('hex')))
const reportPayload = { title: 'Synthetic work', project: 'demo', state: 'working', steps: ['- [~] Verify the change'] }
const folderReport = (f, cwd, payload = reportPayload, extra = []) => spawnSync(process.execPath, [f.script, '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--codex-report', ...extra], {
  cwd, env: { ...f.env, CODEX_THREAD_ID: undefined }, input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 15000,
})
const oldBlock = (id, title, mark = '') => {
  const block = createHash('sha256').update(`codex:${id}`).digest('hex').slice(0, 8)
  return `<!-- auto session=${block} agent=codex state=waiting updated=${new Date().toISOString()} resume=${id}${mark} -->
### ${title}
- [?] Review it, OK?
<!-- /auto session=${block} -->
`
}

test('a block written from a weak hint is withdrawn when the session proves to be a run', async () => {
  for (const hint of ['missing', 'null', 'replay']) await fixture(async f => {
    f.install('--apply')
    const cwd = join(f.home, 'demo')
    const person = rollout(f, session, { originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' })
    assert.equal(f.event('UserPromptSubmit', 'turn-person', { cwd, transcript_path: person }).status, 0)
    const personBytes = readFileSync(f.progress)
    f.save(f.progress, Buffer.concat([Buffer.from('## Foreign\r\nKeep café.\n\r\n'), personBytes, Buffer.from([0xff, 0xc3, 0x0a])]))
    // The withdrawn run leaves nothing behind, not even the heading of the section its block opened.
    const expected = readFileSync(f.progress)
    const path = join(f.home, '.codex', 'sessions', '2026', '10', '27', `rollout-2026-10-27T12-00-00-${execSession}.jsonl`)
    assert.equal(existsSync(path), false)
    assert.equal(f.event(hint === 'replay' ? 'UserPromptSubmit' : 'SessionStart', 'turn-run', { session_id: execSession, cwd, transcript_path: hint === 'null' ? null : path }).status, 0)
    if (hint === 'null') assert.match(markerOf(f, execSession), / origin=run\b/)
    else assert.doesNotMatch(markerOf(f, execSession), /origin=/)
    assert.equal(sessionRecord(f, execSession).isWeak, true)
    const before = readFileSync(f.progress)
    const marker = markerOf(f, execSession).replace(/\r$/, '')
    const start = before.indexOf(Buffer.from(marker))
    const id = createHash('sha256').update(`codex:${execSession}`).digest('hex').slice(0, 8)
    const close = Buffer.from(`<!-- /auto session=${id} -->`)
    const end = before.indexOf(close, start) + close.length
    const afterLine = before[end] === 13 ? end + 2 : end + 1
    assert.equal(rollout(f, execSession, { source: 'exec' }), path)
    const proven = f.event('UserPromptSubmit', 'turn-run', { session_id: execSession, cwd, transcript_path: path })
    assert.equal(proven.status, 0, proven.stderr)
    assertNoBlock(f, execSession)
    assert.deepEqual(readFileSync(f.progress), expected)
    assert.ok(readFileSync(f.progress).includes(personBytes))
    assert.equal(sessionRecord(f, execSession).origin, 'run')
    assert.equal(sessionRecord(f, execSession).isWeak, undefined)
    const stamp = statSync(f.progress).mtimeMs
    assert.equal(f.event('Stop', 'turn-run', { session_id: execSession }).status, 0)
    assertNoBlock(f, execSession)
    const report = f.command(['--codex-report', '--session', execSession], reportPayload)
    assert.equal(report.status, 0, report.stderr)
    assertNoBlock(f, execSession)
    assert.deepEqual(readFileSync(f.progress), expected)
    assert.equal(statSync(f.progress).mtimeMs, stamp)

    const { dropCodexBlock } = await sourceModules()
    const owner = createHash('sha256').update(`codex:${execSession}`).digest('hex')
    const block = before.subarray(start, afterLine).toString('latin1')
    for (const text of [
      block + block,
      block.replace(`owner=${owner}`, `owner=${owner.slice(0, 63)}0`),
      block.replace('agent=codex', 'agent=cursor'),
      `\x60\x60\x60markdown\n${block}\x60\x60\x60\n`,
      '## No matching block\r\nKeep these bytes.\n',
    ]) assert.equal(dropCodexBlock(text, owner), text)
  })
})

test('a codex exec run that another agent started writes nothing to progress.md', () => fixture(f => {
  f.install('--apply')
  unlinkSync(f.progress)
  const signals = [
    { source: 'exec' },
    { originator: 'codex_exec', thread_source: 'user' },
    { source: { subagent: { thread_spawn: { parent_thread_id: session } } } },
    { originator: 'Codex Desktop', parent_thread_id: session },
    { thread_source: 'agent_created_thread' },
    { originator: 'codex_sdk' },
    { originator: 'codex_mcp' },
  ]
  for (const [index, meta] of signals.entries()) {
    const id = `synthetic-run-${index}`
    const path = rollout(f, id, meta)
    const event = f.event('UserPromptSubmit', 'turn-r', { session_id: id, cwd: join(f.home, 'demo'), transcript_path: path })
    assert.equal(event.status, 0, event.stderr)
    assert.equal(existsSync(f.progress), false)
    assert.equal(sessionRecord(f, id).origin, 'run')
    assert.equal(sessionRecord(f, id).isWeak, undefined)
    const report = f.command(['--codex-report', '--session', id], reportPayload)
    assert.equal(report.status, 0, report.stderr)
    assert.equal(f.event('Stop', 'turn-r', { session_id: id }).status, 0)
    assert.equal(existsSync(f.progress), false)
  }
  // An existing file is preserved byte for byte too, including its timestamps.
  f.save(f.progress, '## Synthetic person\r\nKeep these bytes.\r\n')
  const before = readFileSync(f.progress)
  const stamp = statSync(f.progress).mtimeMs
  assert.equal(f.command(['--codex-report', '--session', 'synthetic-run-0'], reportPayload).status, 0)
  assert.deepEqual(readFileSync(f.progress), before)
  assert.equal(statSync(f.progress).mtimeMs, stamp)
}))

test('a Codex App session a person started is written and shows as a row', () => fixture(f => {
  f.install('--apply')
  const cwd = join(f.home, 'demo')
  mkdirSync(cwd)
  const path = rollout(f, session, { originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' })
  assert.equal(f.event('UserPromptSubmit', 'turn-a', { cwd, transcript_path: path }, { CODEX_THREAD_ID: undefined }).status, 0)
  assert.equal(sessionRecord(f, session).folder, 'demo')
  const report = folderReport(f, cwd)
  assert.equal(report.status, 0, report.stderr)
  assert.equal(JSON.parse(report.stdout).session, session)
  assert.match(markerOf(f, session), /state=working/)
  const shown = f.command([])
  assert.equal(shown.status, 0, shown.stderr)
  assert.match(shown.stdout, /Synthetic work/)
  assert.match(readFileSync(f.progress, 'utf8'), /Verify the change/)
  assert.doesNotMatch(shown.stdout, /Background runs|\+1 runs/)
  assert.equal(folderReport(f, cwd, { ...reportPayload, state: 'done', steps: ['- [x] Verified'] }).status, 0)
  assert.match(markerOf(f, session), /state=done/)
}))

test("a run's last line that reads like a question is not listed under Waiting on you", () => fixture(f => {
  f.install('--apply')
  const path = rollout(f, execSession, { source: 'exec' })
  assert.equal(f.event('UserPromptSubmit', 'turn-r', { session_id: execSession, transcript_path: path }).status, 0)
  assert.equal(f.command(['--codex-report', '--session', execSession], { ...reportPayload, state: 'waiting', steps: ['- [?] REQUEST CHANGES: ship it, OK?'] }).status, 0)
  assert.equal(f.event('Stop', 'turn-r', { session_id: execSession, last_assistant_message: 'Ship it, OK?' }).status, 0)
  assert.equal(readFileSync(f.progress, 'utf8'), '')
  const shown = f.command(['--keys', 'j'])
  assert.equal(shown.status, 0, shown.stderr)
  assert.doesNotMatch(shown.stdout, /REQUEST CHANGES|ship it|Synthetic work|Background runs/)
  const ledgerFile = f.progress.replace(/\.md$/, '-questions.json')
  assert.deepEqual(existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')).records : [], [])
}))

test("an old block of an agent's run is archived once and a person's block is kept", () => fixture(f => {
  f.install('--apply')
  rollout(f, execSession, { originator: 'codex_exec' })
  rollout(f, helperSession, { source: { subagent: true } })
  rollout(f, session, { originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' })
  rollout(f, secondSession, { originator: 'codex-tui', thread_source: 'user' })
  f.save(f.progress, '## demo\n' + oldBlock(execSession, 'Old unmarked run') + oldBlock(helperSession, 'Old marked run', ' origin=run') + oldBlock(session, 'Keep App person') + oldBlock(secondSession, 'Keep terminal person with an old hint', ' origin=run'))
  const tidy = f.command(['--tidy'])
  assert.equal(tidy.status, 0, tidy.stderr)
  const text = readFileSync(f.progress, 'utf8')
  assert.doesNotMatch(text, /Old unmarked run|Old marked run/)
  assert.match(text, /Keep App person/)
  assert.match(text, /Keep terminal person/)
  const archives = everyFile(f.root).filter(file => /progress-archive-.*\.md$/.test(file))
  assert.equal(archives.length, 1)
  const before = readFileSync(archives[0], 'utf8')
  assert.equal(before.match(/### Old unmarked run/g)?.length, 1)
  assert.equal(before.match(/### Old marked run/g)?.length, 1)
  assert.match(before, /## demo · \d{4}-\d{2}-\d{2}/)
  assert.match(before, /Review it, OK/)
  assert.equal(f.command(['--tidy']).status, 0)
  assert.equal(readFileSync(archives[0], 'utf8'), before)
}))

test('a block whose session record cannot be read is kept', () => fixture(f => {
  f.install('--apply')
  rollout(f, execSession, { source: 'exec' })
  const unreadable = join(f.home, '.codex', 'sessions', '2026', '10', '27', `rollout-2026-10-27T12-00-00-${helperSession}.jsonl`)
  mkdirSync(unreadable, { recursive: true })
  const odd = rollout(f, secondSession, {})
  f.save(odd, '{"type":"response_item","payload":{"source":"exec"}}\n')
  const kept = oldBlock(session, 'Missing history', ' origin=run') + oldBlock(helperSession, 'Unreadable history') + oldBlock(secondSession, 'Not a session record')
  f.save(f.progress, '## demo\n' + oldBlock(execSession, 'Known run') + kept)
  assert.equal(f.command(['--tidy']).status, 0)
  const after = readFileSync(f.progress, 'utf8')
  assert.doesNotMatch(after, /Known run/)
  assert.ok(after.includes(kept))
}))

const sourceModules = async () => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  try {
    return { ...await import('../scripts/codex-history.ts'), ...await import('../hooks/strings.ts'), ...await import('../hooks/codex.ts') }
  } finally { resolver.deregister() }
}

test('the Codex instructions never tell the person that CODEX_THREAD_ID is missing', async () => {
  const { STRINGS } = await sourceModules()
  for (const s of Object.values(STRINGS)) {
    const fallback = s.codexFallbackInstructions('board --codex-report')
    const skill = s.localAgentSkill('board')
    assert.doesNotMatch(fallback + skill, /CODEX_THREAD_ID/)
    assert.match(fallback, /--codex-report/)
    assert.match(fallback, /\[-\]/)
    assert.match(skill, /--codex-report/)
    assert.ok(s.codexReportUnbound.length > 0)
  }
  assert.match(STRINGS.en.codexFallbackInstructions('board'), /carry on with the work and say nothing/)
})

test('a report without a session record checks its own history before it can write', () => fixture(f => {
  f.install('--apply')
  rollout(f, execSession, { originator: 'codex_sdk' })
  const result = f.command(['--codex-report', '--session', execSession], reportPayload)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(f.progress, 'utf8'), '')
  assert.equal(sessionRecord(f, execSession).origin, 'run')
  const person = f.command(['--codex-report', '--session', session], reportPayload)
  assert.equal(person.status, 0, person.stderr)
  assert.notEqual(markerOf(f, session), '')
  const invalid = rollout(f, helperSession, {})
  f.save(invalid, '{"type":"response_item","payload":{"source":"exec"}}\n')
  assert.equal(f.command(['--codex-report', '--session', helperSession], reportPayload).status, 0)
  assert.notEqual(markerOf(f, helperSession), '')
  assert.equal(sessionRecord(f, helperSession).origin, undefined)
  assert.equal(sessionRecord(f, helperSession).isWeak, undefined)
}))

for (const delivery of ['direct', 'queued']) test(`an older ${delivery} event strengthens run evidence without changing newer lifecycle fields`, () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const cwd = join(f.home, 'demo')
  const path = join(f.home, '.codex', 'sessions', '2026', '10', '27', `rollout-2026-10-27T12-00-00-${execSession}.jsonl`)
  assert.equal(f.event('UserPromptSubmit', 'turn-newer', { session_id: execSession, cwd, transcript_path: path }).status, 0)
  assert.equal(sessionRecord(f, execSession).isWeak, true)
  assert.equal(f.event('Stop', 'turn-newer', { session_id: execSession }).status, 0)
  const before = sessionRecord(f, execSession)
  assert.equal(before.state, 'waiting')
  assert.equal(before.turn, 'turn-newer')
  assert.notEqual(markerOf(f, execSession), '')
  const at = before.appliedAt - 1
  const payload = { session_id: execSession, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-older', cwd, transcript_path: path }
  const pending = join(f.root, 'pending', '001.raw.json')
  const deliver = () => delivery === 'direct'
    ? f.command(['--codex-event', '--hook-started', String(at)], payload)
    : (f.save(pending, JSON.stringify({ version: 1, kind: 'raw', at, argv: ['--codex-event', '--agent', 'codex', '--progress-file', f.progress], env: {}, payload })),
      f.command(['--recover-hooks'], {}))
  const unchanged = readFileSync(f.progress)
  const weak = deliver()
  assert.equal(weak.status, 0, weak.stderr)
  assert.deepEqual(sessionRecord(f, execSession), before)
  assert.deepEqual(readFileSync(f.progress), unchanged)
  assert.equal(rollout(f, execSession, { source: 'exec', parent_thread_id: session }), path)
  const proven = deliver()
  assert.equal(proven.status, 0, proven.stderr)
  assertNoBlock(f, execSession)
  const { isWeak, ...lifecycle } = before
  const expected = { ...lifecycle, origin: 'run', parent: session }
  assert.deepEqual(sessionRecord(f, execSession), expected)
  assert.deepEqual(pendingFiles(f), [])
  const bytes = readFileSync(f.progress)
  const strong = deliver()
  assert.equal(strong.status, 0, strong.stderr)
  assert.deepEqual(sessionRecord(f, execSession), expected)
  assert.deepEqual(readFileSync(f.progress), bytes)
  const report = f.command(['--codex-report', '--session', execSession], reportPayload)
  assert.equal(report.status, 0, report.stderr)
  assertNoBlock(f, execSession)
}))

for (const delivery of ['direct', 'queued']) test(`an older ${delivery} run proof does not undo a newer explicit person statement`, () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const cwd = join(f.home, 'demo')
  const path = rollout(f, execSession, { originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' })
  assert.equal(f.event('UserPromptSubmit', 'turn-newer', { session_id: execSession, cwd, transcript_path: path }).status, 0)
  const before = sessionRecord(f, execSession)
  assert.equal(before.origin, 'person')
  assert.equal(before.isWeak, undefined)
  const bytes = readFileSync(f.progress)
  assert.notEqual(markerOf(f, execSession), '')
  // Contradictory, older evidence: the history now reads like a run.
  rollout(f, execSession, { source: 'exec', parent_thread_id: session })
  const at = before.appliedAt - 1
  const payload = { session_id: execSession, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-older', cwd, transcript_path: path }
  const result = delivery === 'direct'
    ? f.command(['--codex-event', '--hook-started', String(at)], payload)
    : (f.save(join(f.root, 'pending', '001.raw.json'), JSON.stringify({ version: 1, kind: 'raw', at, argv: ['--codex-event', '--agent', 'codex', '--progress-file', f.progress], env: {}, payload })),
      f.command(['--recover-hooks'], {}))
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(sessionRecord(f, execSession), before)
  assert.deepEqual(readFileSync(f.progress), bytes)
  assert.notEqual(markerOf(f, execSession), '')
  assert.deepEqual(pendingFiles(f), [])
}))

test('folder reporting rechecks an inferred session after a two-session backlog', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const cwd = join(f.home, 'demo')
  mkdirSync(cwd)
  const person = rollout(f, session, { source: 'vscode', thread_source: 'user' })
  assert.equal(f.event('UserPromptSubmit', 'turn-person-a', { cwd, transcript_path: person }).status, 0)
  const before = readFileSync(f.progress)
  const record = sessionRecord(f, session)
  const second = rollout(f, secondSession, { source: 'vscode', thread_source: 'user' })
  f.save(join(f.root, 'pending', '001.raw.json'), JSON.stringify({
    version: 1, kind: 'raw', at: Date.now(), argv: ['--codex-event', '--agent', 'codex', '--progress-file', f.progress], env: {},
    payload: { session_id: secondSession, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-person-b', cwd, transcript_path: second },
  }))
  const result = folderReport(f, cwd)
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.trim(), 'This session cannot report steps yet; the board still shows it from its hooks.')
  assert.equal(result.stdout, '')
  assert.ok(readFileSync(f.progress).includes(before))
  assert.deepEqual(sessionRecord(f, session), record)
  assert.equal(sessionRecord(f, secondSession).folder, 'demo')
  assert.deepEqual(pendingFiles(f), [])
  const explicit = folderReport(f, cwd, reportPayload, ['--session', session])
  assert.equal(explicit.status, 0, explicit.stderr)
}))

test('folder reporting refuses ambiguous, stale, ended, old and strong-run records without guessing', () => fixture(f => {
  f.install('--apply')
  const cwd = join(f.home, 'demo')
  mkdirSync(cwd)
  const saveRecord = (id, extra = {}) => f.save(join(f.root, 'sessions', createHash('sha256').update(`codex:${id}`).digest('hex') + '.json'), JSON.stringify({ session: id, agent: 'codex', folder: 'demo', state: 'waiting', updated: new Date().toISOString(), ...extra }))
  const refused = () => {
    const before = everyFile(f.root).map(file => [file, readFileSync(file, 'utf8')])
    const result = folderReport(f, cwd)
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr.trim(), 'This session cannot report steps yet; the board still shows it from its hooks.')
    assert.equal(result.stdout, '')
    assert.deepEqual(everyFile(f.root).map(file => [file, readFileSync(file, 'utf8')]), before)
  }
  refused()
  saveRecord(session, { folder: undefined })
  saveRecord(execSession, { origin: 'run' })
  saveRecord(helperSession, { state: 'ended' })
  saveRecord(secondSession, { updated: '2020-01-01T00:00:00Z' })
  refused()
  saveRecord('weak-run-codex-session-654', { origin: 'run', isWeak: true })
  refused()
  saveRecord(session)
  const person = folderReport(f, cwd)
  assert.equal(person.status, 0, person.stderr)
  assert.equal(JSON.parse(person.stdout).session, session)
  saveRecord(secondSession)
  refused()
  // Explicit bindings win even when folder inference has two candidates.
  assert.equal(folderReport(f, cwd, reportPayload, ['--session', session]).status, 0)
  assert.equal(f.report().status, 0)
}))

test('history lookup is bounded, validates ids and date folders, and keeps only the first record fields', async () => fixture(async f => {
  const { findSessionFile, readSessionMeta } = await sourceModules()
  const codexHome = join(f.home, '.codex')
  const file = rollout(f, session, { source: { subagent: { secret: RUN_SECRET } }, originator: 'codex_exec', thread_source: 'subagent', parent_thread_id: execSession })
  assert.equal(findSessionFile(codexHome, session), file)
  assert.equal(findSessionFile(codexHome, '../bad-id'), null)
  assert.equal(readSessionMeta(file, 'session-123'), null)
  assert.deepEqual(readSessionMeta(file, session), { source: { subagent: true }, originator: 'codex_exec', thread_source: 'subagent', parent_thread_id: execSession })
  assert.equal(readSessionMeta(join(dirname(file), 'notes.jsonl'), session), null)
  for (let year = 2027; year < 2100; year++) mkdirSync(join(codexHome, 'sessions', String(year), '01', '01'), { recursive: true })
  assert.equal(findSessionFile(codexHome, session), null)
  const invalidHome = join(f.home, 'invalid-history')
  for (const folder of [['year', '10', '27'], ['2026', '1', '27'], ['2026', '10', 'day']]) f.save(join(invalidHome, 'sessions', ...folder, file.split(/[\\/]/).at(-1)), readFileSync(file))
  assert.equal(findSessionFile(invalidHome, session), null)
}))

test('a tidy checks at most fifty session histories and the next tidy archives the remainder', () => fixture(f => {
  f.install('--apply')
  const ids = Array.from({ length: 52 }, (_, index) => `synthetic-bounded-run-${String(index).padStart(2, '0')}`)
  for (const id of ids) rollout(f, id, { source: 'exec' })
  f.save(f.progress, '## demo\n' + ids.map(id => oldBlock(id, id).replace(/updated=\S+/, 'updated=2026-10-27T12:00:00Z')).join(''))
  const first = f.command(['--tidy'])
  assert.equal(first.status, 0, first.stderr)
  const remaining = readFileSync(f.progress, 'utf8')
  assert.equal(remaining.match(/<!-- auto /g)?.length, 2)
  assert.match(remaining, /synthetic-bounded-run-00/)
  assert.match(remaining, /synthetic-bounded-run-01/)
  assert.equal(f.command(['--tidy']).status, 0)
  assert.doesNotMatch(readFileSync(f.progress, 'utf8'), /<!-- auto /)
}))

test('tidy keeps an explicit person origin and uses the home history when CODEX_HOME is empty', () => fixture(f => {
  f.install('--apply')
  rollout(f, execSession, { source: 'exec' })
  rollout(f, helperSession, { source: 'exec' })
  const kept = oldBlock(helperSession, 'Explicit person origin', ' origin=person')
  f.save(f.progress, '## demo\n' + oldBlock(execSession, 'Verified run') + kept)
  const result = spawnSync(process.execPath, [f.script, '--tidy'], { env: { ...f.env, CODEX_HOME: '' }, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  const after = readFileSync(f.progress, 'utf8')
  assert.doesNotMatch(after, /Verified run/)
  assert.ok(after.includes(kept))
}))

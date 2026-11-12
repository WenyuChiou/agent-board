import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks } from 'node:module'
import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { availableParallelism, constants, setPriority, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { beforeEach, test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { formatWriter } from './e2e/lib/faults.mjs'
import { neverShown } from './fixtures/never-shown.mjs'
import { hookOrDeferred, turnOrDeferred } from './helpers/deferred-turn.mjs'
import { bundleFromDir } from '../scripts/bundle-text.mjs'
import { reporterPs1, reporterSh } from '../hooks/hook-reporters.ts'
import { HOOK_INPUT_TIMEOUT, REPORT_TOOL_REPLY, hookBootstrap, hookGuardSource, hookWorker } from '../hooks/hook-safety.ts'
import { classifierDiagnostic, observeClassifier } from './fixtures/classifier-diagnostic.mjs'
import { assertNativeProbeReturned, nativeProbeDiagnostic } from './fixtures/native-probe-diagnostic.mjs'
import { withDeniedCreation } from './fixtures/windows-create-denied.mjs'
import { generatedHookCommand } from './fixtures/generated-hook-command.mjs'
import { assertClassifierExited, observeClassifierExit } from './fixtures/classifier-exit-proof.mjs'
import { partTest } from '../scripts/ci-impact.mjs'

// The Windows board job runs this file in two parts, and each part runs its share of the tests: the
// file alone took about 8 minutes there against a ten-minute limit (#899).
const test = partTest(nodeTest)

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
const withoutCodexOnPath = (pathValue, home) => {
  if (!pathValue) return ''
  let isNodeHidden = false
  const cleanPath = pathValue
    .split(delimiter)
    .filter(dir => {
      if (!dir) return false
      try {
        const hasCodex = ['codex.exe', 'codex', 'codex.cmd'].some(name => existsSync(join(dir, name)))
        if (hasCodex && existsSync(join(dir, process.platform === 'win32' ? 'node.exe' : 'node'))) isNodeHidden = true
        return !hasCodex
      } catch {
        return true
      }
    })
    .join(delimiter)
  if (!isNodeHidden) return cleanPath
  // Preserve only this running runtime, never the host commands beside it.
  // A stable fixture-owned location also keeps repeated environment reads inert.
  const runtimeDir = join(home, '.test-node-runtime')
  const runtime = join(runtimeDir, process.platform === 'win32' ? 'node.exe' : 'node')
  if (!existsSync(runtime)) {
    mkdirSync(runtimeDir, { recursive: true })
    if (process.platform === 'win32') {
      try { linkSync(process.execPath, runtime) } catch { copyFileSync(process.execPath, runtime) }
    } else symlinkSync(process.execPath, runtime)
  }
  return [runtimeDir, cleanPath].filter(Boolean).join(delimiter)
}
// A runner may set XDG/host overrides. No synthetic home may inherit those and
// write into another test or the account's actual native configuration.
const isolatedEnv = (home, pathValue) => {
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const originalPath = pathValue ?? process.env[pathKey] ?? ''
  const cleanPath = withoutCodexOnPath(originalPath, home)
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    LANG: 'en', AGENT_BOARD_SETUP_COMMAND: '',
    // A board these tests start opens no window and stops once this test process is gone (#959).
    AGENT_BOARD_TEST_PID: String(process.pid),
    // A bare `board` here prints text, as on CI, where CI is set. Without it the fixture's
    // CODEX_THREAD_ID picks the page, and that server holds the fixture folder open (#975).
    CI: '1',
    LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
    CLAUDE_PROGRESS_FILE: '', CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'), GROK_HOME: join(home, '.grok'), HERMES_HOME: join(home, '.hermes'),
    XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    OPENCLAW_STATE_DIR: join(home, '.openclaw'), DSH_HOME: join(home, '.dsh'),
  }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key]
  }
  env[pathKey] = cleanPath
  return env
}
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

// A hard link is instant and is the same file for any scanner; a 110 MB copy is the fallback (EXDEV, denied link).
const placeNode = destination => { try { linkSync(process.execPath, destination) } catch { copyFileSync(process.execPath, destination) } }

const nativeProcess = (executable, args, env, input, after = setTimeout, stop = stopNativeTree, { isInputOpen = false, inputFd, stdoutFd, stderrFd, ...options } = {}) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, {
    env, ...options, stdio: [inputFd ?? 'pipe', stdoutFd ?? 'pipe', stderrFd ?? 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  })
  let stdout = '', stderr = '', error, termination
  let isClosed = false, isTimedOut = false
  let grace, notifyClosed
  const whenClosed = new Promise(done => { notifyClosed = done })
  child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.on('error', failure => { error ??= failure })
  child.stdin?.on('error', failure => { error ??= failure })
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
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      reject(failure)
    }, 2000)
  }, 30000)
  child.once('close', (status, signal) => {
    isClosed = true
    clearTimeout(timer)
    clearTimeout(grace)
    child.stdin?.destroy()
    notifyClosed({ status, signal })
    resolve({ status, signal, error, termination, stdout, stderr })
  })
  if (isInputOpen) child.stdin?.write(input)
  else child.stdin?.end(input)
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
// Codex 0.164 runs a hook's line through PowerShell on Windows (#623).
const firePowerShell = (f, command, input, limit = 20000) => nativeProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], f.env, input,
  callback => setTimeout(callback, limit), stopNativeTree)
// The hooks import each other without extensions, as the bundler reads them.
const importTs = async path => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  try { return await import(path) } finally { resolver.deregister() }
}
const launchOf = command => Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le')
const turnOf = f => JSON.parse(readFileSync(join(f.root, 'sessions', createHash('sha256').update(`codex:${session}`).digest('hex') + '.json'))).turn

const hookLog = f => existsSync(join(f.root, 'hook-errors.log')) ? readFileSync(join(f.root, 'hook-errors.log'), 'utf8') : ''

const hookFailure = result => JSON.stringify({ status: result.status, signal: result.signal, error: result.error && { code: result.error.code, message: result.error.message }, termination: result.termination, stdout: result.stdout, stderr: result.stderr })

const setupObservations = new WeakMap()
const setupChildSummary = (result, elapsedMs) => ({
  status: Number.isSafeInteger(result.status) ? result.status : 'none',
  signal: result.signal == null ? 'none' : ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV'].includes(result.signal) ? result.signal : 'other',
  code: result.error == null ? 'none' : ['ENOENT', 'EACCES', 'ETIMEDOUT', 'ENOBUFS', 'E2BIG'].includes(result.error.code) ? result.error.code : 'other',
  elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs) : 'unknown',
})
const observeSetupResult = invoke => {
  const started = performance.now()
  const result = invoke()
  setupObservations.set(result, setupChildSummary(result, performance.now() - started))
  return result
}
// A null status cannot distinguish launch failure from a deadline or a signal.
// Keep only fixed fields; raw child output may contain commands and paths.
const assertSetupStatus = (result, expected) => assert.equal(result.status, expected,
  result.status === expected ? undefined : 'setup child failed: ' + JSON.stringify(setupObservations.get(result) ?? setupChildSummary(result, NaN)))

test('setup status failures distinguish launch errors signals and deadlines without private output', () => {
  const failure = (code, signal = null) => ({ status: null, signal, error: Object.assign(new Error('PRIVATE_ERROR'), { code, path: '/PRIVATE_EXECUTABLE', spawnargs: ['PRIVATE_ARGUMENT'] }), stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR', pid: 123456789 })
  const cases = [
    [failure('ETIMEDOUT', 'SIGTERM'), 'none', 'SIGTERM', 'ETIMEDOUT'],
    ...['ENOENT', 'EACCES', 'ENOBUFS', 'E2BIG'].map(code => [failure(code), 'none', 'none', code]),
    [{ status: null, signal: 'SIGKILL', stdout: 'PRIVATE_STDOUT' }, 'none', 'SIGKILL', 'none'],
    [{ status: 7, signal: null, stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR' }, 7, 'none', 'none'],
    [failure('PRIVATE_CODE', 'PRIVATE_SIGNAL'), 'none', 'other', 'other'],
  ]
  for (const [result, status, signal, code] of cases) {
    const before = inspect(result)
    assert.equal(observeSetupResult(() => result), result)
    assert.equal(inspect(result), before)
    assert.throws(() => assertSetupStatus(result, 0), error => {
      assert.equal(error.code, 'ERR_ASSERTION')
      const summary = JSON.parse(/^setup child failed: (\{.*\})/m.exec(error.message)?.[1] ?? 'null')
      assert.notEqual(summary, null, 'the failed child needs an allowlisted summary')
      assert.deepEqual(Object.keys(summary), ['status', 'signal', 'code', 'elapsedMs'])
      assert.deepEqual({ status: summary.status, signal: summary.signal, code: summary.code }, { status, signal, code })
      assert.ok(Number.isSafeInteger(summary.elapsedMs) && summary.elapsedMs >= 0)
      assert.ok(!/PRIVATE_|123456789/.test(inspect(error)))
      assert.ok(error.message.length < 512)
      return true
    })
  }
  for (const status of [0, 1]) {
    const result = { status, signal: null, stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR' }
    assert.equal(observeSetupResult(() => result), result)
    assert.doesNotThrow(() => assertSetupStatus(result, status))
  }
  assert.throws(() => assertSetupStatus(failure('ETIMEDOUT'), 0), error => {
    assert.match(error.message, /"elapsedMs":"unknown"/)
    assert.ok(!/PRIVATE_|123456789/.test(inspect(error)))
    return true
  })
})

const nativeReportContext = (result, label, readLog = () => '') => {
  const context = JSON.parse(result.stdout).injectSteps?.[0]?.systemMessage?.systemMessage
  if (typeof context !== 'string') {
    // Read only on failure, and keep fixed codes instead of commands or log text.
    const known = new Set(['UNSUPPORTED_AGENT', 'HOOK_WORKER_UNAVAILABLE', 'REPORTER_UPGRADE_REQUIRED', 'REPORTER_TIMEOUT', 'INPUT_TOO_LARGE', 'INPUT_TIMEOUT', 'INCOMPLETE_INPUT', 'REPORTER_FAILED', 'REPORTER_QUEUED'])
    let log = '', hasLog = true
    try { log = readLog() } catch { hasLog = false }
    const codes = log.split(/\r?\n/).flatMap(line => {
      const code = /^\S+ antigravity ([A-Z][A-Z0-9_]*)(?: |$)/.exec(line)?.[1]
      return known.has(code) ? [code] : []
    }).slice(-4)
    const status = Number.isInteger(result.status) ? result.status : 'unknown'
    assert.equal(typeof context, 'string', `${label}: missing native report context; status=${status}; hook codes=${hasLog ? codes.join(',') || 'none' : 'unavailable'}`)
  }
  return context
}

test('native report context failures keep hook codes without exposing command output', () => {
  const log = [
    '2026-11-02T00:00:00Z antigravity REPORTER_TIMEOUT',
    '2026-11-02T00:00:01Z antigravity REPORTER_QUEUED',
    '2026-11-02T00:00:02Z antigravity PRIVATE_LOG',
  ].join('\n')
  const result = { status: 0, stdout: '{"unrelated":"PRIVATE_COMMAND"}', stderr: 'PRIVATE_STDERR', signal: 'PRIVATE_SIGNAL' }
  assert.throws(() => nativeReportContext(result, 'setup zh-CN', () => log), error => {
    assert.match(error.message, /REPORTER_TIMEOUT,REPORTER_QUEUED/)
    assert.match(error.message, /status=0/)
    assert.ok(!error.message.includes('PRIVATE_'))
    return true
  })
  assert.throws(() => nativeReportContext(result, 'setup zh-CN', () => { throw Error('PRIVATE_READ') }), error => {
    assert.match(error.message, /missing native report context.*hook codes=unavailable/)
    assert.ok(!error.message.includes('PRIVATE_'))
    return true
  })
  assert.throws(() => nativeReportContext({ ...result, stdout: '{}' }, 'setup en', () => '2026-11-03T00:00:00Z antigravity HOOK_WORKER_UNAVAILABLE PRIVATE_LOG'), error => {
    assert.match(error.message, /status=0; hook codes=HOOK_WORKER_UNAVAILABLE/)
    assert.ok(!error.message.includes('PRIVATE_'))
    return true
  })
  let isLogRead = false
  const started = { stdout: JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: 'Bound command' } }] }) }
  assert.equal(nativeReportContext(started, 'setup en', () => { isLogRead = true; return log }), 'Bound command')
  assert.equal(isLogRead, false)
})

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
  const run = (file, args, input, extraEnv = {}) => observeSetupResult(() => spawnSync(process.execPath, [file, ...args], { env: { ...env, ...extraEnv }, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 15000 }))
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

const tree774 = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = join(dir, entry.name)
  return entry.isDirectory() ? [file, ...tree774(file)] : [file]
}).sort()
const trustKey774 = (f, event, index = 0) => `${resolve(f.hooks)}:${event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}:${index}:0`
const trustTable774 = key => `\n[hooks.state.'${key}']\ntrusted_hash = "sha256:synthetic"\n`
const remove774 = (f, agent, apply = true, extra = []) => spawnSync(process.execPath, [f.script, '--home', f.home, '--codex-remove', '--agent', agent, '--json', ...extra, ...(apply ? ['--apply'] : [])], { cwd: f.home, env: { ...f.env, XDG_RUNTIME_DIR: join(f.home, 'runtime') }, encoding: 'utf8', windowsHide: true })

for (const order of [['codex', 'cursor'], ['cursor', 'codex']]) test(`#774 removal in ${order.join(' then ')} order keeps exactly history and user trust`, () => fixture(f => {
  const toml = join(f.home, '.codex', 'config.toml')
  const original = '# User settings\nmodel = "synthetic"\n'
  f.save(toml, original)
  for (const agent of ['codex', 'cursor']) assert.equal(f.install('--agent', agent, '--apply').status, 0)
  const groups = JSON.parse(readFileSync(join(f.root, 'install-codex.json'), 'utf8')).groups
  const foreign = '\n[hooks.state."foreign"]\ntrusted_hash = "foreign"\n\n[hooks.state.unrelated]\nenabled = true\n'
  f.save(toml, original + '\n[hooks.state]\n' + Object.keys(groups).map(event => trustTable774(trustKey774(f, event))).join('') + foreign)
  const kept = ['progress.md', 'progress-archive-2026-11.md', 'progress-journal-2026-11.md', 'sessions/synthetic.json', 'hook-errors.log', 'progress-answered.json', 'progress-questions.json', 'progress-questions-source-synthetic.json', 'progress-seen.json', 'progress-run-cursor.txt', 'progress-page-state.json', 'progress-page-state-done-synthetic.json', 'progress-inbox/synthetic.json']
  for (const name of kept) f.save(join(f.root, name), name === 'progress.md' ? '' : 'synthetic history')
  const runtime = join(f.home, '.cache', 'agent-board')
  mkdirSync(join(runtime, 'synthetic-messages'), { recursive: true })
  for (const agent of order) {
    const result = remove774(f, agent)
    assert.equal(result.status, 0, result.stderr)
  }
  assert.equal(readFileSync(toml, 'utf8'), original + '\n[hooks.state]\n' + foreign)
  const files = [toml, ...kept.map(name => join(f.root, name))]
  const expected = new Set(files)
  for (const file of files) for (let folder = dirname(file); folder !== f.home; folder = dirname(folder)) expected.add(folder)
  // PATH isolation may supply the fixture's runtime before setup starts.
  if (existsSync(join(f.home, '.test-node-runtime'))) for (const file of [join(f.home, '.test-node-runtime'), ...tree774(join(f.home, '.test-node-runtime'))]) expected.add(file)
  expected.add(join(f.home, '.cache'))
  assert.deepEqual(tree774(f.home), [...expected].sort())
}))

test('#774 existing hooks, existing skill parents and user files survive', () => fixture(f => {
  f.save(f.hooks, '{"hooks": {}}')
  mkdirSync(dirname(dirname(f.skill)), { recursive: true })
  assert.equal(f.install('--apply').status, 0)
  f.save(join(dirname(f.skill), 'user.txt'), 'mine')
  assert.equal(remove774(f, 'codex').status, 0)
  assert.deepEqual(JSON.parse(readFileSync(f.hooks, 'utf8')), { hooks: {} })
  assert.equal(readFileSync(join(dirname(f.skill), 'user.txt'), 'utf8'), 'mine')
  assert.ok(existsSync(dirname(dirname(f.skill))))
}))

test('#774 legacy manifest keeps hooks and skill parents but removes the owned skill folder', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const file = join(f.root, 'install-codex.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  delete manifest.createdConfig
  delete manifest.createdDirs
  f.save(file, JSON.stringify(manifest))
  assert.equal(remove774(f, 'codex').status, 0)
  assert.deepEqual(JSON.parse(readFileSync(f.hooks, 'utf8')), { hooks: {} })
  assert.equal(existsSync(dirname(f.skill)), false)
  assert.equal(existsSync(dirname(dirname(f.skill))), true)
}))

test('#774 setup is byte idempotent and removal preview writes nothing', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const files = tree774(f.home).filter(file => statSync(file).isFile())
  const before = files.map(file => [file, readFileSync(file)])
  const result = f.install('--apply')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).changes, [])
  assert.equal(remove774(f, 'codex', false).status, 0)
  assert.deepEqual(tree774(f.home).filter(file => statSync(file).isFile()), files)
  for (const [file, text] of before) assert.deepEqual(readFileSync(file), text)
}))

test('#774 foreign hooks keep their trust and board trust uses the actual group index', () => fixture(f => {
  const foreign = { hooks: [{ type: 'command', command: 'synthetic-user-hook' }] }
  f.save(f.hooks, JSON.stringify({ hooks: { SessionStart: [foreign] } }))
  assert.equal(f.install('--apply').status, 0)
  const toml = join(f.home, '.codex', 'config.toml')
  const retained = '# user\n' + trustTable774(trustKey774(f, 'SessionStart'))
  f.save(toml, retained + trustTable774(trustKey774(f, 'SessionStart', 1)))
  assert.equal(remove774(f, 'codex').status, 0)
  assert.equal(readFileSync(toml, 'utf8'), retained)
  assert.deepEqual(JSON.parse(readFileSync(f.hooks, 'utf8')), { hooks: { SessionStart: [foreign] } })
}))

test('#774 trust removal preserves TOML bytes and unrecognized table content', async () => {
  const { removeCodexTrustEntries: clean } = await importTs('../scripts/codex-local.ts')
  const key = 'C:\\synthetic\\hooks.json:session_start:0:0'
  const original = '# user\r\nmodel = "synthetic"\r\n'
  const basic = JSON.stringify(key)
  const appended = `\r\n[hooks.state]\r\n\r\n[hooks.state.${basic}]\r\ntrusted_hash = "synthetic"\r\nenabled = true\r\n`
  assert.deepEqual(clean(original + appended, [key]), { text: original, removed: 1 })
  assert.equal(clean(original + trustTable774(key), [key]).text, original)
  const comment = trustTable774(key) + '# user comment\n'
  assert.deepEqual(clean(comment, [key]), { text: comment, removed: 0 })
  const extra = trustTable774(key) + 'user_key = true\n'
  assert.equal(clean(extra, [key]).text, extra)
  const foreign = trustTable774('foreign')
  assert.equal(clean(foreign, [key]).text, foreign)
  const noMatch = '[hooks.state]\n\n' + foreign
  assert.deepEqual(clean(noMatch, [key]), { text: noMatch, removed: 0 })
  const other = '[hooks.state]\nenabled = true\n'
  assert.equal(clean(other + trustTable774(key), [key]).text, other)
  const quoteKey = 'synthetic"hooks.json:session_start:0:0'
  assert.equal(clean(`\n[hooks.state.${JSON.stringify(quoteKey)}]\ntrusted_hash = "synthetic"\n`, [quoteKey]).text, '')
  const changedCase = trustTable774(key.toUpperCase())
  assert.equal(clean(changedCase, [key]).removed, process.platform === 'win32' ? 1 : 0)
})

for (const agent of ['codex', 'cursor', 'gemini', 'grok', 'muse', 'antigravity']) test(`#774 ${agent} removes its newly created empty config and folders`, () => fixture(f => {
  const installed = f.install('--agent', agent, '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const manifest = JSON.parse(readFileSync(join(f.root, `install-${agent}.json`), 'utf8'))
  assert.equal(manifest.createdConfig, true)
  const removed = remove774(f, agent)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(manifest.config), false)
  for (const folder of manifest.createdDirs) {
    if (folder === f.root) continue
    assert.equal(existsSync(folder), false, folder)
  }
}))

test('#774 removing the creator transfers shared directory ownership without a repair', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
  const runtime = join(f.home, '.cache', 'agent-board')
  mkdirSync(runtime, { recursive: true })
  assert.equal(remove774(f, 'codex').status, 0)
  assert.equal(existsSync(runtime), true)
  const file = join(f.root, 'install-cursor.json')
  const before = readFileSync(file, 'utf8')
  assert.ok(JSON.parse(before).createdDirs.includes(dirname(f.skill)))
  const preview = f.install('--agent', 'cursor')
  assert.equal(preview.status, 0, preview.stderr)
  assert.deepEqual(JSON.parse(preview.stdout).changes, [])
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(remove774(f, 'cursor').status, 0)
  assert.equal(existsSync(dirname(dirname(f.skill))), false)
  assert.equal(existsSync(runtime), false)
}))

test('#774 a legacy install rerun leaves the manifest bytes unchanged', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const file = join(f.root, 'install-codex.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  delete manifest.createdConfig
  delete manifest.createdDirs
  const before = `${JSON.stringify(manifest, null, 2)}\n`
  f.save(file, before)
  const result = f.install('--apply')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).changes, [])
  assert.equal(readFileSync(file, 'utf8'), before)
}))

test('#774 removal clears the board root when progress is stored elsewhere', () => fixture(f => {
  const progress = join(f.home, 'history', 'progress.md')
  const result = f.install('--progress-file', progress, '--apply')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(remove774(f, 'codex').status, 0)
  assert.equal(existsSync(f.root), false)
  assert.equal(readFileSync(progress, 'utf8'), '')
  assert.equal(existsSync(dirname(f.skill)), false)
}))

test('#774 runtime cleanup removes only empty folders and keeps message history', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const runtime = join(f.home, 'runtime', 'agent-board')
  const empty = join(runtime, 'empty-messages')
  const occupied = join(runtime, 'history-messages')
  mkdirSync(empty, { recursive: true })
  f.save(join(occupied, 'messages.json'), 'synthetic message history')
  const result = remove774(f, 'codex')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(empty), false)
  assert.equal(readFileSync(join(occupied, 'messages.json'), 'utf8'), 'synthetic message history')
  assert.equal(existsSync(runtime), true)
}))

for (const [agent, parts] of [['openclaw', ['.openclaw', 'openclaw.json']], ['deepseek', ['.dsh', 'cordis.patch.yml']]]) test(`#774 ${agent} removes the hollow config setup created`, () => fixture(f => {
  const installed = f.install('--agent', agent, '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const native = join(f.home, ...parts)
  assert.equal(existsSync(native), true)
  assert.equal(JSON.parse(readFileSync(join(f.root, `install-${agent}.json`), 'utf8')).createdConfig, true)
  const removed = remove774(f, agent)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(dirname(native)), false)
}))

for (const [agent, parts, original] of [['openclaw', ['.openclaw', 'openclaw.json'], '{"user":true}\n'], ['deepseek', ['.dsh', 'cordis.patch.yml'], '# mine\n']]) test(`#774 ${agent} keeps a config it did not create`, () => fixture(f => {
  const native = join(f.home, ...parts)
  f.save(native, original)
  const installed = f.install('--agent', agent, '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const removed = remove774(f, agent)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(native), true)
  assert.match(readFileSync(native, 'utf8'), agent === 'openclaw' ? /"user": true/ : /# mine/)
}))

test('#774 removal cleans the config.toml beside a --codex-dir hooks file', () => fixture(f => {
  const dir = join(f.home, 'custom codex')
  const toml = join(dir, 'config.toml')
  const defaultToml = join(f.home, '.codex', 'config.toml')
  mkdirSync(dir, { recursive: true })
  const installed = spawnSync(process.execPath, [setup, '--home', f.home, '--codex-dir', dir, '--apply'], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true })
  assert.equal(installed.status, 0, installed.stderr)
  f.save(toml, `# mine\n${trustTable774(`${resolve(join(dir, 'hooks.json'))}:session_start:0:0`)}`)
  f.save(defaultToml, '# default account\n')
  const removed = remove774(f, 'codex', true, ['--codex-dir', dir])
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(readFileSync(toml, 'utf8'), '# mine\n')
  assert.equal(readFileSync(defaultToml, 'utf8'), '# default account\n')
}))

test('#774 a linked config.toml stays a link and keeps its permissions', { skip: process.platform === 'win32' }, () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const target = join(f.home, 'dotfiles', 'config.toml')
  const toml = join(f.home, '.codex', 'config.toml')
  f.save(target, `# mine\n${trustTable774(trustKey774(f, 'SessionStart'))}`)
  chmodSync(target, 0o644)
  symlinkSync(target, toml)
  assert.equal(remove774(f, 'codex').status, 0)
  assert.equal(lstatSync(toml).isSymbolicLink(), true)
  assert.equal(readFileSync(target, 'utf8'), '# mine\n')
  assert.equal(statSync(target).mode & 0o777, 0o644)
}))

test('#774 a --data-dir folder the person made stays when empty', () => fixture(f => {
  const own = join(f.home, 'my data')
  mkdirSync(own)
  const progress = join(f.home, 'history', 'progress.md')
  const installed = f.install('--data-dir', own, '--progress-file', progress, '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const removed = spawnSync(process.execPath, [join(own, 'agent-board.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--data-dir', own, '--codex-remove', '--agent', 'codex', '--apply'], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true })
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(join(own, 'agent-board.mjs')), false)
  assert.equal(existsSync(own), true)
}))

test('#774 an empty message folder directly in the runtime folder goes, the runtime folder and a full one stay', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const runtime = join(f.home, 'runtime')
  const empty = join(runtime, 'agent-board-abc-messages')
  const full = join(runtime, 'agent-board-def-messages')
  const other = join(runtime, 'other-messages')
  mkdirSync(empty, { recursive: true })
  mkdirSync(other)
  f.save(join(full, 'messages.json'), 'synthetic')
  assert.equal(remove774(f, 'codex').status, 0)
  assert.equal(existsSync(empty), false)
  assert.equal(existsSync(join(full, 'messages.json')), true)
  assert.equal(existsSync(other), true)
}))

test('#774 a plugins key that is not an object in another agent config blocks neither setup nor removal', () => fixture(f => {
  const settings = join(f.home, '.gemini', 'settings.json')
  f.save(settings, '{"plugins":[]}\n')
  const installed = f.install('--agent', 'gemini', '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const removed = remove774(f, 'gemini')
  assert.equal(removed.status, 0, removed.stderr)
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).plugins, [])
}))

test('#774 a --data-dir folder named agent-board the person made stays when empty', () => fixture(f => {
  const own = join(f.home, 'agent-board')
  mkdirSync(own)
  const progress = join(f.home, 'history', 'progress.md')
  const installed = f.install('--data-dir', own, '--progress-file', progress, '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const removed = spawnSync(process.execPath, [join(own, 'agent-board.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--data-dir', own, '--codex-remove', '--agent', 'codex', '--apply'], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true })
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(join(own, 'agent-board.mjs')), false)
  assert.equal(existsSync(own), true)
}))

test('#774 an unreadable trust file stays without a trust plan change', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const toml = join(f.home, '.codex', 'config.toml')
  mkdirSync(toml)
  const result = remove774(f, 'codex')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!JSON.parse(result.stdout).changes.some(change => change.file === toml))
  assert.equal(statSync(toml).isDirectory(), true)
}))

test('PATH isolation preserves Node beside Codex without exposing Codex', () => fixture(async f => {
  const shared = join(f.home, 'shared tools')
  mkdirSync(shared)
  const runtime = join(shared, process.platform === 'win32' ? 'node.exe' : 'node')
  try { linkSync(process.execPath, runtime) } catch { copyFileSync(process.execPath, runtime) }
  for (const name of ['codex', 'codex.cmd', 'codex.exe']) {
    const host = join(shared, name)
    f.save(host, 'synthetic host must stay undiscoverable')
    const env = { ...f.env }
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
    env.PATH = withoutCodexOnPath(shared, f.home)
    assert.equal(withoutCodexOnPath(shared, f.home), env.PATH, 'repeated isolation keeps the same fixture runtime')
    // `node --version` never reads its input and can exit before an empty write reaches it (EPIPE).
    const node = await nativeProcess('node', ['--version'], env, '', callback => setTimeout(callback, 5000), stopNativeTree, { cwd: f.home, inputFd: 'ignore' })
    assert.equal(node.error, undefined, 'the preserved runtime launches without a process error')
    assert.equal(node.status, 0, `isolated Node failed: ${node.error?.code ?? 'none'}`)
    assert.equal(node.stdout.trim(), process.version)
    const codex = spawnSync('codex', ['--version'], { cwd: f.home, env, encoding: 'utf8', timeout: 5000 })
    assert.equal(codex.error?.code, 'ENOENT', 'the real host must remain undiscoverable')
    unlinkSync(host)
  }
}))

test('PATH isolation keeps explicit no-Node paths without adding a runtime', () => fixture(f => {
  const tools = join(f.home, 'tools without node')
  mkdirSync(tools)
  f.save(join(tools, 'codex'), 'synthetic host')
  const path = withoutCodexOnPath(tools, f.home)
  assert.equal(path, '')
  assert.equal(withoutCodexOnPath('', f.home), '')
  const env = { ...f.env }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = path
  const node = spawnSync('node', ['-e', 'process.exit(0)'], { cwd: f.home, env, encoding: 'utf8', timeout: 5000 })
  assert.equal(node.error?.code, 'ENOENT')
}))

const mailboxFixture = async fn => fixture(async f => {
  const { defaultMessagesDirectory } = await importTs('../scripts/runtime-folder.ts')
  const { enrollMailbox, mailboxId } = await importTs('../hooks/hook-messages.ts')
  const { queueMessage } = await importTs('../hooks/messaging.ts')
  const script = join(f.home, 'mailbox-board.mjs')
  f.save(script, bundleFromDir(new URL('..', import.meta.url)))
  const progress = join(f.home, 'mailbox-progress.md')
  f.save(progress, '')
  const env = { ...f.env, XDG_RUNTIME_DIR: join(f.home, 'runtime') }
  const directory = defaultMessagesDirectory(progress, f.home, env, process.platform)
  const call = (agent, event, extra = {}, flags = []) => spawnSync(process.execPath, [script,
    '--home', f.home, '--data-dir', f.root, '--progress-file', progress, '--agent', agent,
    ...(['codex', 'cursor'].includes(agent) ? ['--codex-event'] : ['--agent-status', '--state', /SessionEnd|sessionEnd/.test(event) ? 'ended' : /SessionStart|Stop|AfterAgent/.test(event) ? 'waiting' : 'working']),
    ...(agent === 'antigravity' ? ['--event', event] : []), ...flags,
  ], { cwd: f.home, env, input: JSON.stringify({ session_id: session, conversation_id: session, conversationId: session, hook_event_name: event, turn_id: 'mailbox-turn', generation_id: 'mailbox-turn', ...extra }), encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const seed = (agent = 'codex') => {
    const now = Date.now()
    const state = enrollMailbox({ messages: [] }, agent, session, 'CLI', now, 43_200_000)
    const target = state.mailboxes[0]
    const queued = queueMessage(state, { id: 'hook-mailbox-message', target: target.id, turn: 'session', text: 'Synthetic mailbox payload' }, 'board', target, now).state
    f.save(join(directory, 'messages.json'), JSON.stringify({ version: 2, ...queued }))
  }
  const state = () => JSON.parse(readFileSync(join(directory, 'messages.json'), 'utf8'))
  await fn({ ...f, script, progress, env, directory, call, seed, state, mailboxId })
})

// Inject only the claim boundary so the real mailbox write and cleanup still run.
const importMailboxWithClaim = async (name, wrap) => {
  const url = new URL('../scripts/board-messaging.ts', import.meta.url)
  url.searchParams.set('claim', name)
  const claim = new URL('../scripts/message-store-claim.ts', import.meta.url)
  const injected = 'data:text/javascript,' + encodeURIComponent(`import { claimMessageStore as original } from ${JSON.stringify(claim.href)}
export const claimMessageStore = directory => (${wrap})(original(directory))`)
  const resolver = registerHooks({ resolve(specifier, context, next) {
    return next(specifier === './message-store-claim' && context.parentURL === url.href ? injected : specifier, context)
  } })
  try { return await importTs(url.href) } finally { resolver.deregister() }
}

// On Windows a scanner can hold a new claim file past the hook's 120 ms store limit.
const codexTurn = (f, mailbox, beforeNext) => turnOrDeferred(mailbox, ['codex', session, 'CLI', Date.now()], () => f.state().messages[0].status, beforeNext)

test('hookWorker preserves host timeouts above 3 seconds instead of clamping to 3000 ms', () => {
  const source = hookWorker('synthetic-home', 'synthetic-script', '')
  assert.ok(source.includes('started + hostTimeout - 1000'))
  assert.ok(!source.includes('Math.min(3000, hostTimeout - 1000)'))
})

test('turn-start hooks deliver queued mailbox messages for Codex, Antigravity, Gemini, Muse, and Cursor sessionStart only', async () => mailboxFixture(async f => {
  const { turnStartEnvelope } = await importTs('../hooks/hook-messages.ts')
  assert.equal(turnStartEnvelope('codex', 'SessionStart', 'message', 'note').hookSpecificOutput.additionalContext, 'note\n\nmessage')
  assert.equal(turnStartEnvelope('codex', 'UserPromptSubmit', 'message', 'note').hookSpecificOutput.additionalContext, 'message')
  for (const [agent, events] of Object.entries({ codex: ['SessionStart', 'UserPromptSubmit'], antigravity: ['SessionStart', 'PreInvocation'], gemini: ['SessionStart', 'BeforeAgent'], muse: ['UserPromptSubmit'], cursor: ['sessionStart'] })) {
    for (const event of events) {
      f.seed(agent)
      let result = f.call(agent, event)
      assert.equal(result.status, 0, result.stderr)
      if (!result.stdout.includes('Synthetic mailbox payload')) {
        assert.equal(result.stderr, 'board: mailbox deferred\n', agent + ' ' + event)
        assert.equal(f.state().messages[0].status, 'queued')
        result = f.call(agent, event)
        assert.equal(result.status, 0, result.stderr)
      }
      const output = JSON.parse(result.stdout)
      assert.ok(JSON.stringify(output).includes('Synthetic mailbox payload'), agent + ' ' + event + ': ' + result.stdout)
      if (agent === 'codex' || agent === 'gemini' || agent === 'muse') assert.equal(output.hookSpecificOutput.hookEventName, event)
      if (agent === 'antigravity') assert.ok((event === 'SessionStart' ? output.injectSteps[0].systemMessage.systemMessage : output.injectSteps[0].ephemeralMessage).includes('Synthetic mailbox payload'))
      if (agent === 'cursor') assert.ok(output.additional_context.includes('Synthetic mailbox payload'))
      assert.equal(f.state().messages[0].status, 'accepted')
      const again = f.call(agent, event)
      assert.equal(again.status, 0, again.stderr)
      assert.ok(!again.stdout.includes('Synthetic mailbox payload'))
      if (agent === 'cursor') assert.equal(output.env.AGENT_BOARD_SESSION_ID, session)
      if (agent === 'gemini') assert.equal(output.decision, 'allow')
    }
  }
}))

test('a Codex hook mailbox is the CLI only when its history file names the terminal, so the app and the editor get no Queue (#826)', async () => mailboxFixture(async f => {
  const { sendDecision } = await importTs('../hooks/messaging.ts')
  const { RECEIVER_ROUTES } = await importTs('../hooks/receiver-routes.ts')
  const history = join(f.home, 'codex-history')
  mkdirSync(history, { recursive: true })
  const file = join(history, `rollout-2026-11-12T00-00-00-${session}.jsonl`)
  const mailboxOf = () => f.state().mailboxes?.find(one => one.agent === 'codex' && one.session === session)
  for (const [originator, surface] of [['codex-tui', 'CLI'], ['Codex Desktop', 'unknown'], ['codex_vscode', 'unknown'], [null, 'unknown']]) {
    f.save(join(f.directory, 'messages.json'), JSON.stringify({ version: 2, messages: [] }))
    if (originator !== null) writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: session, originator, source: 'vscode' } }) + '\n')
    await hookOrDeferred(() => f.call('codex', 'UserPromptSubmit', originator === null ? {} : { transcript_path: file }), () => mailboxOf() !== undefined)
    const box = mailboxOf()
    assert.equal(box?.surface, surface, String(originator))
    const decision = sendDecision(box.id, [], f.state().mailboxes, () => 'idle', RECEIVER_ROUTES, Date.now())
    assert.equal(decision.canSend, surface === 'CLI', String(originator))
    if (!decision.canSend) assert.equal(decision.reason, 'SURFACE_UNKNOWN', String(originator))
  }
}))

test('a held mailbox store claim reports deferral and the next turn delivers after release', async () => mailboxFixture(async f => {
  const { claimMessageStore } = await importTs('../scripts/message-store-claim.ts')
  f.seed()
  const before = readFileSync(join(f.directory, 'messages.json'), 'utf8')
  const claim = claimMessageStore(f.directory)
  const nonce = 'a'.repeat(32)
  const pending = join(f.directory, `.message-pending-${process.pid}-${nonce}.json`)
  f.save(pending, JSON.stringify({ version: 1, pid: process.pid, nonce }) + '\n')
  try {
    assert.ok(existsSync(pending))
    const deferred = f.call('codex', 'UserPromptSubmit')
    assert.equal(deferred.status, 0, deferred.stderr)
    assert.equal(deferred.stdout, '')
    assert.equal(deferred.stderr, 'board: mailbox deferred\n')
    assert.equal(f.state().messages[0].status, 'queued')
    assert.equal(readFileSync(join(f.directory, 'messages.json'), 'utf8'), before)
  } finally {
    claim.release()
    unlinkSync(pending)
  }
  const delivered = f.call('codex', 'UserPromptSubmit')
  assert.equal(delivered.status, 0, delivered.stderr)
  assert.ok(JSON.parse(delivered.stdout).hookSpecificOutput.additionalContext.includes('Synthetic mailbox payload'))
  assert.equal(f.state().messages[0].status, 'accepted')
}))

test('a mailbox turn returns its saved message when claim release throws', async () => mailboxFixture(async f => {
  const { hookMailbox } = await importMailboxWithClaim('release-failure', `claim => ({
    check: directory => claim.check(directory),
    release: () => { claim.release(); throw new Error('SYNTHETIC_RELEASE_FAILURE') },
  })`)
  f.seed()
  const mailbox = hookMailbox(f.directory, Infinity)
  const message = await codexTurn(f, mailbox)
  assert.equal(message?.id, 'hook-mailbox-message')
  assert.equal(message.text, 'Synthetic mailbox payload')
  assert.equal(f.state().messages[0].status, 'uncertain')
  assert.equal(mailbox.hasDeferred, false)
  await mailbox.accept('codex', session, message.id, message.nonce, Date.now())
  assert.equal(f.state().messages[0].status, 'accepted')
  assert.equal(await mailbox.turn('codex', session, 'CLI', Date.now()), null)
  assert.equal(mailbox.hasDeferred, false, 'an empty mailbox is not deferred')
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.message-claim-') || name.endsWith('.tmp')), false)

  const { hookMailbox: beforeWrite } = await importMailboxWithClaim('check-failure', `claim => ({
    check: () => { throw new Error('SYNTHETIC_CHECK_FAILURE') },
    release: () => { claim.release(); throw new Error('SYNTHETIC_RELEASE_FAILURE') },
  })`)
  f.seed()
  const failed = beforeWrite(f.directory, Infinity)
  assert.equal(await failed.turn('codex', session, 'CLI', Date.now()), null)
  assert.equal(failed.hasDeferred, true)
  assert.equal(f.state().messages[0].status, 'queued')
}))

test('a mailbox claim that cannot be removed is reused, so the accept of a message handed out still saves', async () => mailboxFixture(async f => {
  globalThis.syntheticClaims = 0
  globalThis.syntheticStuckReleases = 1
  const { hookMailbox } = await importMailboxWithClaim('stuck-release', `claim => (globalThis.syntheticClaims++, {
    check: directory => claim.check(directory),
    release: () => {
      if (globalThis.syntheticStuckReleases-- > 0) throw Object.assign(new Error('SYNTHETIC_STUCK_RELEASE'), { code: 'EPERM' })
      claim.release()
    },
  })`)
  f.seed()
  const mailbox = hookMailbox(f.directory, Infinity)
  // A deferred first turn used up the stuck release; the turn that delivers gets its own.
  const message = await codexTurn(f, mailbox, () => { globalThis.syntheticStuckReleases = 1 })
  assert.equal(message?.id, 'hook-mailbox-message')
  assert.equal(f.state().messages[0].status, 'uncertain')
  assert.equal(readdirSync(f.directory).filter(name => name.startsWith('.message-claim-')).length, 1)
  await mailbox.accept('codex', session, message.id, message.nonce, Date.now())
  assert.equal(f.state().messages[0].status, 'accepted')
  assert.equal(globalThis.syntheticClaims, 1)
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.message-claim-')), false)
}))

test('a mailbox accept saves after a slow successful claim while turns still defer', async () => mailboxFixture(async f => {
  const { hookMailbox } = await importMailboxWithClaim('slow-claim', `claim => {
    const started = Date.now()
    Date.now = () => started + 121
    return claim
  }`)
  const { takeMailboxMessage } = await importTs('../hooks/hook-messages.ts')
  f.seed()
  const now = Date.now()
  const taken = takeMailboxMessage(f.state(), 'codex', session, 'CLI', now, 43_200_000, 'abcdef')
  assert.ok(taken.message)
  f.save(join(f.directory, 'messages.json'), JSON.stringify({ version: 2, ...taken.state }))
  const clock = Date.now
  Date.now = () => now
  try {
    const mailbox = hookMailbox(f.directory, Infinity)
    await mailbox.accept('codex', session, taken.message.id, taken.message.nonce, now)
    assert.equal(f.state().messages[0].status, 'accepted')
    f.seed()
    assert.equal(await mailbox.turn('codex', session, 'CLI', Date.now()), null)
    assert.equal(mailbox.hasDeferred, true)
    assert.equal(f.state().messages[0].status, 'queued')
  } finally { Date.now = clock }
}))

test('a turn-start hook with an empty mailbox prints exactly what it printed before', async () => mailboxFixture(async f => {
  f.save(join(f.directory, 'messages.json'), JSON.stringify({ version: 2, messages: [] }))
  const expected = { codex: [['UserPromptSubmit', '']], gemini: [['BeforeAgent', '{}\n'], ['SessionStart', '{}\n']], muse: [['UserPromptSubmit', '']], antigravity: [['PostInvocation', '{}\n']] }
  for (const [agent, events] of Object.entries(expected)) for (const [event, output] of events) {
    const result = f.call(agent, event)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.replace(/\r\n/g, '\n'), output, agent + ' ' + event)
  }
  assert.deepEqual(JSON.parse(f.call('cursor', 'sessionStart').stdout), { env: { AGENT_BOARD_SESSION_ID: session, AGENT_BOARD_AGENT: 'cursor' } })
  assert.equal(f.state().messages.length, 0)
}))

test('Cursor beforeSubmitPrompt and terminal hooks leave mailbox messages queued', async () => mailboxFixture(async f => {
  const { isSessionEnd, isTurnStart } = await importTs('../hooks/hook-messages.ts')
  for (const agent of ['codex', 'antigravity', 'gemini', 'muse', 'cursor', 'grok', 'hermes', 'other']) {
    for (const event of ['beforeSubmitPrompt', 'Stop', 'stop', 'afterAgentResponse', 'AfterAgent', 'PostInvocation', 'PermissionRequest', 'Interrupt', 'SessionEnd', 'sessionEnd']) assert.equal(isTurnStart(agent, event), false, agent + ' ' + event)
    assert.equal(isSessionEnd(agent, 'SessionEnd'), ['codex', 'gemini', 'muse'].includes(agent))
    assert.equal(isSessionEnd(agent, 'sessionEnd'), agent === 'cursor')
  }
  for (const [agent, event] of [['cursor', 'beforeSubmitPrompt'], ['cursor', 'stop'], ['codex', 'Stop'], ['gemini', 'AfterAgent'], ['muse', 'Stop'], ['antigravity', 'PostInvocation']]) {
    const start = f.call(agent, agent === 'cursor' ? 'beforeSubmitPrompt' : agent === 'gemini' ? 'BeforeAgent' : agent === 'antigravity' ? 'PreInvocation' : 'UserPromptSubmit')
    assert.equal(start.status, 0, agent + ': ' + start.stderr)
    f.seed(agent)
    const result = f.call(agent, event)
    assert.equal(result.status, 0, agent + ' ' + event + ': ' + result.stderr)
    assert.equal(f.state().messages[0].status, 'queued', agent + ' ' + event)
  }
}))

test('a corrupt or busy message store fails open without failing progress hooks or --codex-report', async () => mailboxFixture(async f => {
  for (const busy of [false, true]) {
    f.seed()
    if (busy) writeFileSync(join(f.directory, 'server.lock'), String(process.pid))
    else writeFileSync(join(f.directory, 'messages.json'), '{broken')
    const before = readFileSync(join(f.directory, 'messages.json'), 'utf8')
    const hook = f.call('codex', 'SessionStart')
    assert.equal(hook.status, 0, hook.stderr)
    const report = spawnSync(process.execPath, [f.script, '--home', f.home, '--data-dir', f.root, '--progress-file', f.progress, '--codex-report', '--session', session], {
      cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, input: JSON.stringify({ title: 'Synthetic report', state: 'working', steps: ['- [~] Check'] }), timeout: 15000,
    })
    assert.equal(report.status, 0, report.stderr)
    assert.equal(readFileSync(join(f.directory, 'messages.json'), 'utf8'), before)
  }
}))

test('a replayed hook event never claims a mailbox message', async () => mailboxFixture(async f => {
  f.seed()
  const pending = join(f.root, 'pending', '000000000000001-replay.json')
  f.save(pending, JSON.stringify({ version: 1, progress: f.progress, mode: '--codex-event', agent: 'codex', session, now: new Date().toISOString(), at: Date.now(), isPrompt: false, isBoardPrompt: false, payload: { session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'replay-turn' } }))
  const result = spawnSync(process.execPath, [f.script, '--home', f.home, '--data-dir', f.root, '--progress-file', f.progress, '--recover-hooks'], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).processed, 1)
  assert.equal(f.state().messages[0].status, 'queued')
}))

test('a live hub takes hook mailbox calls over loopback and the hook does not write the store itself', async () => mailboxFixture(async f => {
  const { createServer } = await import('node:http')
  f.seed()
  const before = readFileSync(join(f.directory, 'messages.json'), 'utf8'), calls = []
  const message = { ...f.state().messages[0], nonce: 'abcdef', status: 'uncertain' }
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push([req.url, JSON.parse(body), req.headers['x-board-token']])
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url.endsWith('mailbox-turn') ? { message } : { ok: true }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    writeFileSync(join(f.directory, 'server.lock'), String(process.pid))
    writeFileSync(join(f.directory, 'server.owner'), JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.address().port}/?t=synthetic-token` }))
    const hook = async () => {
      const child = spawn(process.execPath, [f.script, '--home', f.home, '--data-dir', f.root, '--progress-file', f.progress, '--codex-event'], { cwd: f.home, env: f.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = '', err = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.stderr.on('data', chunk => { err += chunk })
      const exited = new Promise(done => child.once('close', done))
      child.stdin.end(JSON.stringify({ session_id: session, hook_event_name: 'SessionStart' }))
      assert.equal(await exited, 0, err)
      return { out, err }
    }
    let { out, err } = await hook()
    // A hub slower than the hook's 150 ms defers the turn by design, and the next turn delivers (#902).
    const isDeferred = !out.includes('Synthetic mailbox payload')
    if (isDeferred) {
      assert.equal(err, 'board: mailbox deferred\n')
      ;({ out, err } = await hook())
    }
    assert.ok(out.includes('Synthetic mailbox payload'), err)
    // The turn the hook gave up on may or may not have reached the hub before the one that delivered.
    const expected = ['/api/messages/mailbox-turn', '/api/messages/mailbox-accept']
    assert.deepEqual(calls.map(one => one[0]), isDeferred && calls.length === 3 ? [expected[0], ...expected] : expected)
    assert.ok(calls.every(one => one[2] === 'synthetic-token'))
    assert.equal(readFileSync(join(f.directory, 'messages.json'), 'utf8'), before)
  } finally { await new Promise(done => server.close(done)) }
}))

test('a hook never creates the messages folder', async () => mailboxFixture(async f => {
  assert.equal(existsSync(f.directory), false)
  const result = f.call('codex', 'SessionStart')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(f.directory), false)
}))

test('the hook finds the same default messages folder as --serve', async () => mailboxFixture(async f => {
  const { serve } = await import('./e2e/lib/surfaces.mjs')
  const { makeWorld } = await import('./e2e/lib/world.mjs')
  const { defaultMessagesDirectory } = await importTs('../scripts/runtime-folder.ts')
  const world = makeWorld()
  try {
    const server = await serve.start(world)
    const directory = defaultMessagesDirectory(world.path, world.home, world.env, process.platform)
    assert.equal(existsSync(join(directory, 'server.lock')), true)
    const hook = () => spawnSync(process.execPath, [world.script, '--codex-event', '--home', world.home, '--progress-file', world.path], { cwd: world.root, env: world.env, encoding: 'utf8', windowsHide: true, timeout: 15000, input: JSON.stringify({ session_id: session, hook_event_name: 'SessionStart' }) })
    const mailboxes = async () => (await server.get('/api/board')).json().messaging.mailboxes
    const result = await hookOrDeferred(hook, async () => (await mailboxes()).length > 0)
    assert.equal((await mailboxes())[0]?.session, session, result.stderr)
  } finally { await world.close() }
}))

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
    const removed = f.command(['--codex-remove', '--agent', agent, '--apply', '--json'])
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

const setupAgent = (f, ...args) => observeSetupResult(() => spawnSync(process.execPath, [resolve('scripts/setup-agent.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), ...args], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000 }))

const detectedSetupFixture = fn => fixture(f => {
  const bin = mkdtempSync(join(tmpdir(), 'setup commands-'))
  const env = {
    ...f.env, HOME: f.home, USERPROFILE: f.home, CLAUDE_PROGRESS_FILE: '', LANG: 'en',
    CODEX_HOME: join(f.home, '.codex'), GROK_HOME: join(f.home, '.grok'), HERMES_HOME: join(f.home, '.hermes'),
    OPENCODE_CONFIG_DIR: join(f.home, '.config', 'opencode'), XDG_CONFIG_HOME: join(f.home, '.config'),
    OPENCLAW_STATE_DIR: join(f.home, '.openclaw'), DSH_HOME: join(f.home, '.dsh'),
    CLAUDE_CONFIG_DIR: join(f.home, '.claude'), LOCALAPPDATA: join(f.home, 'local-app-data'),
  }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = bin
  const fake = name => {
    const file = join(bin, `${name}${process.platform === 'win32' ? '.cmd' : ''}`)
    writeFileSync(file, process.platform === 'win32' ? '@exit /b 99\r\n' : '#!/bin/sh\nexit 99\n')
    chmodSync(file, 0o755)
  }
  const run = (...args) => observeSetupResult(() => spawnSync(process.execPath, [resolve('scripts/setup-agent.mjs'), ...args], {
    cwd: bin, env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  }))
  try { return fn({ ...f, env, fake, run }) }
  finally { rmSync(bin, { recursive: true, force: true }) }
})

test('a setup preview in a new home lists the agents installed on the PATH', () => detectedSetupFixture(f => {
  f.fake('gemini')
  f.fake('agy')
  const preview = f.run()
  assert.equal(preview.status, 0, preview.stderr)
  assert.equal(preview.stderr, '')
  assert.match(preview.stdout, /^Gemini CLI:/m)
  assert.match(preview.stdout, /^Antigravity:/m)
  assert.doesNotMatch(preview.stdout, /^(Codex|Cursor|OpenCode|Grok Build|Muse Code|Hermes Agent|OpenClaw|DeepSeek):/m)
  const json = f.run('--json')
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout).targets, ['gemini', 'antigravity'])
  f.fake('claude')
  const claude = f.run()
  assert.equal(claude.status, 0, claude.stderr)
  assert.match(claude.stdout, /^Claude Code:/m)
  assert.match(claude.stdout, /claude plugin install agent-board@agent-board/)
  assert.deepEqual(readdirSync(f.home), [])
}))

test('a setup preview in a new home lists an agent whose app is installed', { skip: !['win32', 'darwin'].includes(process.platform) }, () => detectedSetupFixture(f => {
  const app = process.platform === 'win32' ? join(f.env.LOCALAPPDATA, 'Programs', 'cursor') : join(f.home, 'Applications', 'Cursor.app')
  mkdirSync(app, { recursive: true })
  const preview = f.run()
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /^Cursor:/m)
  assert.equal(existsSync(f.root), false)
  assert.equal(existsSync(join(f.home, '.cursor')), false)
}))

test('a setup preview that finds no agent exits 0 and names the next command', () => detectedSetupFixture(f => {
  for (const [lang, hint] of [['en', 'Setup found no agent'], ['zh-TW', 'setup 在這台電腦沒有找到 agent'], ['zh-CN', 'setup 在这台电脑没有找到 agent']]) {
    const result = f.run('--lang', lang)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    // The run starts outside the checkout, so a relative command could not work from here.
    assert.ok(result.stdout.includes(resolve('scripts/setup-agent.mjs')), result.stdout)
    assert.ok(result.stdout.includes(`--lang ${lang} --agent codex`), result.stdout)
    assert.match(result.stdout, /PATH/)
    assert.ok(result.stdout.includes(hint), result.stdout)
    assert.ok(result.stdout.includes(f.home))
    assert.equal(result.stdout.trim().split('\n').length, 1)
    assert.deepEqual(readdirSync(f.home), [])
  }
  const json = f.run('--json')
  assert.equal(json.status, 0, json.stderr)
  assert.equal(json.stderr, '')
  assert.deepEqual(JSON.parse(json.stdout), { targets: [], plans: [], applied: false })
  assert.deepEqual(readdirSync(f.home), [])
}))

test('setup with --home does not read the PATH or apps of the account running it', () => detectedSetupFixture(f => {
  f.fake('gemini')
  f.fake('claude')
  if (process.platform === 'win32') mkdirSync(join(f.env.LOCALAPPDATA, 'Programs', 'cursor'), { recursive: true })
  if (process.platform === 'darwin') mkdirSync(join(f.home, 'Applications', 'Cursor.app'), { recursive: true })
  const home = join(f.home, 'other-home')
  mkdirSync(home)
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const result = f.run('--home', home, '--lang', lang)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.doesNotMatch(result.stdout, /Gemini CLI:|Cursor:|Claude Code:|PATH/)
    assert.ok(result.stdout.includes(home))
  }
  assert.deepEqual(readdirSync(home), [])
}))

test('an unknown agent name still fails and says how to name one', () => detectedSetupFixture(f => {
  const result = f.run('--agent', 'bogus')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.trim().split('\n').length, 1)
  assert.match(result.stderr, /--agent named an agent setup does not know\. Name one: --agent codex/)
  assert.deepEqual(readdirSync(f.home), [])
}))

test('a repeat setup preview lists Antigravity after an all-agent apply', () => fixture(f => {
  const applied = setupAgent(f, '--lang', 'en', '--agent', 'all', '--apply', '--json')
  assert.equal(applied.status, 0, applied.stderr)
  const installed = JSON.parse(applied.stdout).targets
  const result = setupAgent(f, '--lang', 'en')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^Antigravity: already set up/m)
  assert.equal(result.stdout.match(/^.+: already set up/gm)?.length, installed.length, result.stdout)
}))

test('the setup messages for no agent and an unknown agent match all three string tables', () => {
  const installer = readFileSync(resolve('scripts/setup-agent.mjs'), 'utf8')
  const start = installer.indexOf('const noAgentWords = ') + 'const noAgentWords = '.length
  const end = installer.indexOf('\nconst noAgentText = ', start)
  assert.ok(start >= 'const noAgentWords = '.length && end > start)
  const tables = ['hooks/strings-en.ts', 'hooks/i18n.ts', 'hooks/strings-zh-cn.ts'].map(file => {
    const match = readFileSync(resolve(file), 'utf8').match(/  setupNoAgent: (\{[\s\S]*?\n  \}),/)
    assert.ok(match, file)
    return JSON.parse(match[1])
  })
  assert.deepEqual(JSON.parse(installer.slice(start, end)), tables)
})

test('setup finds Grok Build in its own bin folder when it is not on the PATH', () => detectedSetupFixture(f => {
  f.env.GROK_HOME = join(f.home, 'grok elsewhere')
  const own = join(f.home, '.grok', 'bin')
  mkdirSync(own, { recursive: true })
  writeFileSync(join(own, process.platform === 'win32' ? 'grok.exe' : 'grok'), 'synthetic Grok', { mode: 0o755 })
  for (const args of [[], ['--home', f.home]]) {
    const result = f.run('--json', ...args)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).targets, ['grok'], JSON.stringify(args))
  }
}))

test('setup on Windows counts every command spelling and not a bare name', { skip: process.platform !== 'win32' }, () => detectedSetupFixture(f => {
  const targetsWith = name => {
    const file = join(f.env.PATH, name)
    writeFileSync(file, 'synthetic command')
    try {
      const result = f.run('--json')
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout).targets
    } finally { rmSync(file) }
  }
  for (const extension of ['.exe', '.cmd', '.bat', '.com', '.ps1']) assert.deepEqual(targetsWith(`gemini${extension}`), ['gemini'], extension)
  assert.deepEqual(targetsWith('gemini'), [])
}))

test('a removed Antigravity is not listed again once its emptied hooks file is gone', () => fixture(f => {
  const applied = setupAgent(f, '--lang', 'en', '--agent', 'antigravity', '--apply')
  assert.equal(applied.status, 0, applied.stderr)
  const removed = spawnSync(process.execPath, [join(f.root, 'agent-board.mjs'), '--home', f.home, '--codex-remove', '--agent', 'antigravity', '--apply'], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(join(f.home, '.gemini', 'config', 'hooks.json')), false)
  const result = setupAgent(f, '--lang', 'en')
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /^Antigravity:/m)
}))

test('a command on the PATH is listed once setup applies it, and again as already set up', () => detectedSetupFixture(f => {
  f.fake('gemini')
  const applied = f.run('--apply')
  assert.equal(applied.status, 0, applied.stderr)
  assert.match(applied.stdout, /^Gemini CLI: created/m)
  assert.equal(existsSync(join(f.root, 'install-gemini.json')), true)
  const second = f.run()
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.stderr, '')
  assert.match(second.stdout, /^Gemini CLI: already set up/m)
}))

const systemLanguageEnv = () => ({ LANG: '', NODE_OPTIONS: `--require ${JSON.stringify(resolve('tests/fixtures/system-lang-zh-tw.cjs'))}` })

test('setup on a zh-TW system with no LANG previews in zh-TW and bakes zh-TW', () => fixture(f => {
  const system = { ...f, env: { ...f.env, ...systemLanguageEnv() } }
  const preview = setupAgent(system, '--agent', 'codex')
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /將建立/)
  assert.ok(!preview.stdout.includes('would update'))
  const applied = setupAgent(system, '--agent', 'codex', '--apply')
  assert.equal(applied.status, 0, applied.stderr)
  assert.match(readFileSync(f.script, 'utf8').split('\n')[0], /"lang":"zh-TW"/)
  assert.match(readFileSync(f.skill, 'utf8'), /實際任務進度/)
}))

test('after setup on a zh-TW system a plain run and stop speak zh-TW with no flag', () => fixture(f => {
  const applied = setupAgent({ ...f, env: { ...f.env, ...systemLanguageEnv() } }, '--agent', 'codex', '--apply')
  assert.equal(applied.status, 0, applied.stderr)
  for (const [args, expected] of [[[], /進度/], [['--stop'], /這個檔案沒有正在執行的看板網頁/]]) {
    const result = spawnSync(process.execPath, [f.script, ...args], { cwd: f.home, env: { ...f.env, LANG: '', NODE_OPTIONS: '', XDG_RUNTIME_DIR: join(f.home, 'runtime') }, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    assert.equal(result.status, 0, `${JSON.stringify(args)}\n${result.stderr}\n${result.stdout}`)
    assert.match(result.stdout, expected)
    assert.doesNotMatch(result.stdout, /Progress|Stopped the board page|No board page is running/)
  }
}))

test('a hook on a zh-TW install writes its step in zh-TW', () => fixture(f => {
  const applied = setupAgent({ ...f, env: { ...f.env, ...systemLanguageEnv() } }, '--agent', 'codex', '--apply')
  assert.equal(applied.status, 0, applied.stderr)
  const result = f.event('SessionStart', 'language-turn', {}, { LANG: '', NODE_OPTIONS: '' })
  assert.equal(result.status, 0, result.stderr)
  const progress = readFileSync(f.progress, 'utf8')
  assert.match(progress, /等待下一個工作指令/)
  assert.ok(!progress.includes('Waiting for the next instruction'))
}))

test('--lang and LANG still win over a zh-TW system', () => fixture(f => {
  for (const [args, LANG, expected] of [[['--lang', 'en'], '', /would create/], [[], 'en_US.UTF-8', /would create/], [['--lang', 'zh-CN'], '', /将创建/]]) {
    const result = setupAgent({ ...f, env: { ...f.env, ...systemLanguageEnv(), LANG } }, '--agent', 'codex', ...args)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, expected, JSON.stringify({ args, LANG }))
  }
}))

const homeSnapshot = home => Object.fromEntries(readdirSync(home, { recursive: true, withFileTypes: true }).map(entry => {
  const path = join(entry.parentPath, entry.name)
  return [path.slice(home.length), entry.isDirectory() ? 'directory' : { bytes: readFileSync(path).toString('base64'), mtimeMs: statSync(path).mtimeMs }]
}))

const sharedRuntimePath = f => {
  const shared = join(f.home, 'shared tools')
  mkdirSync(shared)
  const runtime = join(shared, process.platform === 'win32' ? 'node.exe' : 'node')
  try { linkSync(process.execPath, runtime) } catch { copyFileSync(process.execPath, runtime) }
  f.save(join(shared, 'codex.cmd'), 'synthetic host must stay undiscoverable')
  const inherited = Object.entries(f.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  return [shared, inherited].filter(Boolean).join(delimiter)
}

test('setup preview lists every planned file under its agent and apply changes only those files', () => fixture(f => {
  f.save(f.hooks, '{"other":{"keep":true},"hooks":{}}\n')
  f.save(join(f.home, 'notes.txt'), 'Keep this file.\n')
  f.save(join(f.home, '.codex', 'auth.json'), '{"synthetic":"keep"}\n')
  const run = (...args) => spawnSync(process.execPath, [resolve('scripts/setup-agent.mjs'), '--home', f.home, '--agent', 'codex', ...args], {
    cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  const before = homeSnapshot(f.home)
  let planned
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const json = run('--lang', lang, '--json')
    assert.equal(json.status, 0, json.stderr)
    const plan = JSON.parse(json.stdout).plans[0]
    const child = f.install('--lang', lang, '--json')
    assert.equal(child.status, 0, child.stderr)
    assert.equal(json.stdout, `${JSON.stringify({ targets: ['codex'], plans: [JSON.parse(child.stdout)], applied: false }, null, 2)}\n`)
    assert.ok(plan.changes.some(change => change.action === 'create'))
    assert.ok(plan.changes.some(change => change.action === 'update'))
    planned = plan.changes.map(change => change.file).sort()
    const preview = run('--lang', lang)
    assert.equal(preview.status, 0, preview.stderr)
    const lines = preview.stdout.split(/\r?\n/)
    assert.match(lines[0], /^Codex:/)
    assert.deepEqual(lines.slice(1, plan.changes.length + 1), plan.changes.map(change => `  ~${change.file.slice(f.home.length)}`))
    assert.deepEqual(homeSnapshot(f.home), before)
  }
  const applied = run('--lang', 'en', '--apply')
  assert.equal(applied.status, 0, applied.stderr)
  assert.ok(!applied.stdout.includes('  ~'), applied.stdout)
  const after = homeSnapshot(f.home)
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => before[path] !== 'directory' && after[path] !== 'directory' && JSON.stringify(before[path]) !== JSON.stringify(after[path]))
    .map(path => `${f.home}${path}`).sort()
  assert.deepEqual(changed, planned)
}))

test('setup preview names the record of another installed agent that apply would rewrite', () => fixture(f => {
  const run = (...args) => spawnSync(process.execPath, [resolve('scripts/setup-agent.mjs'), '--home', f.home, ...args], {
    cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(run('--agent', 'codex,cursor', '--lang', 'en', '--apply').status, 0)
  const before = homeSnapshot(f.home)
  const preview = run('--agent', 'codex', '--lang', 'zh-TW')
  assert.equal(preview.status, 0, preview.stderr)
  const listedIn = out => [...new Set(out.split(/\r?\n/).filter(line => line.startsWith('  ~')).map(line => join(f.home, line.slice(3))))].sort()
  const changedSince = earlier => {
    const after = homeSnapshot(f.home)
    return Object.keys(after).filter(path => after[path] !== 'directory' && JSON.stringify(earlier[path]) !== JSON.stringify(after[path])).map(path => `${f.home}${path}`).sort()
  }
  const listed = listedIn(preview.stdout)
  assert.ok(listed.includes(join(f.root, 'install-cursor.json')), preview.stdout)
  assert.deepEqual(homeSnapshot(f.home), before)
  assert.equal(run('--agent', 'codex', '--lang', 'zh-TW', '--apply').status, 0)
  assert.deepEqual(changedSince(before), listed)
  // An agent selected but skipped for a conflict changes no file of its own, yet its record still changes.
  f.save(join(f.home, '.cursor', 'hooks.json'), '{not json')
  const skipped = homeSnapshot(f.home)
  const mixed = run('--agent', 'codex,cursor', '--lang', 'en')
  assert.ok(listedIn(mixed.stdout).includes(join(f.root, 'install-cursor.json')), mixed.stdout)
  run('--agent', 'codex,cursor', '--lang', 'en', '--apply')
  assert.deepEqual(changedSince(skipped), listedIn(mixed.stdout))
}))

test('setup preview groups shared and agent files and shortens only paths inside the selected home', () => fixture(f => {
  const home = join(f.home, 'home')
  const data = join(f.home, 'home-other')
  mkdirSync(home)
  // Preparing this fixture's runtime is not a change made by preview. Do it
  // before the no-write snapshot, even when Node and Codex share a PATH entry.
  const env = isolatedEnv(home, sharedRuntimePath(f))
  const run = (...args) => spawnSync(process.execPath, [resolve('scripts/setup-agent.mjs'), '--home', home, '--data-dir', data, '--agent', 'codex,hermes', ...args], {
    cwd: f.home, env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  const before = homeSnapshot(f.home)
  const json = run('--json')
  assert.equal(json.status, 0, json.stderr)
  const preview = run()
  assert.equal(preview.status, 0, preview.stderr)
  const lines = preview.stdout.split(/\r?\n/)
  const plans = JSON.parse(json.stdout).plans
  const shared = new Set(plans[0].changes.map(change => change.file).filter(file => plans[1].changes.some(change => change.file === file)))
  const shown = file => file.startsWith(`${home}/`) || file.startsWith(`${home}\\`) ? `~${file.slice(home.length)}` : file
  assert.ok(lines[0].startsWith('Shared:'))
  assert.deepEqual(lines.slice(1, shared.size + 1), [...shared].map(file => `  ${shown(file)}`))
  let offset = shared.size + 1
  for (const [index, name] of ['Codex', 'Hermes Agent'].entries()) {
    const plan = plans[index]
    assert.ok(lines[offset].startsWith(`${name}:`))
    const expected = plan.changes.filter(change => !shared.has(change.file)).map(change => `  ${shown(change.file)}`)
    assert.deepEqual(lines.slice(offset + 1, offset + 1 + expected.length), expected)
    offset += 1 + expected.length
  }
  assert.ok(preview.stdout.includes(`  ${join(data, 'agent-board.mjs')}\n`))
  assert.deepEqual(homeSnapshot(f.home), before)
}))

test('setup prints a plain summary with each agent and the next steps, and --json keeps today\'s JSON', () => fixture(f => {
  const installer = readFileSync(resolve('scripts/setup-agent.mjs'), 'utf8')
  const start = installer.indexOf('const summaries = ') + 'const summaries = '.length
  const end = installer.indexOf('\nconst summary = ', start)
  assert.ok(start >= 'const summaries = '.length && end > start)
  const bootstrap = JSON.parse(installer.slice(start, end))
  const tables = ['hooks/strings-en.ts', 'hooks/i18n.ts', 'hooks/strings-zh-cn.ts'].map(file => {
    const match = readFileSync(resolve(file), 'utf8').match(/  setupSummary: (\{[\s\S]*?\n  \}),/)
    assert.ok(match, file)
    return JSON.parse(match[1])
  })
  assert.deepEqual(bootstrap, tables)

  const noCodex = setupAgent(f, '--lang', 'en', '--agent', 'codex')
  assert.equal(noCodex.status, 0, noCodex.stderr)
  assert.match(noCodex.stdout, /where\.exe codex.*command -v codex/)
  assert.doesNotMatch(noCodex.stdout, /<full path to codex>/)
  const bin = join(f.home, 'synthetic bin')
  mkdirSync(bin)
  const codex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  writeFileSync(codex, 'synthetic Codex', { mode: 0o755 })
  const pathKey = Object.keys(f.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  f.env[pathKey] = [bin, f.env[pathKey]].filter(Boolean).join(delimiter)
  const summaries = []
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const result = setupAgent(f, '--lang', lang, '--agent', 'codex,hermes')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.notEqual(result.stdout.trimStart()[0], '{')
    assert.match(result.stdout, /Codex/)
    assert.match(result.stdout, /Hermes Agent/)
    const codexStep = result.stdout.split(/\r?\n/).find(line => /^\d+\.\s+Codex[：:]/.test(line))
    assert.ok(codexStep, result.stdout)
    for (const text of ['--codex-trust', '--codex-bin', f.script, '/hooks']) assert.ok(codexStep.includes(text), codexStep)
    assert.ok(codexStep.includes(`--codex-bin '${codex}'`), codexStep)
    assert.match(result.stdout, /--apply/)
    assert.match(result.stdout, /agent-board/)
    assert.doesNotMatch(result.stdout, /--serve/)
    assert.match(result.stdout, /^1\. /m)
    summaries.push(result.stdout)
  }
  assert.equal(new Set(summaries).size, 3)

  assert.match(summaries[0], /Hermes Agent: would create \d+ setup files/)
  assert.doesNotMatch(summaries[0], /automatic reporting is unavailable/i)
  assert.match(summaries[0], /^\d+\. Hermes Agent: Hermes asks once whether to trust the board's hooks; answer y\..*--hermes-trust.*--apply/m)
  assert.match(summaries[0], /^\d+\. Then start a new session in each of: Codex, Hermes Agent./m)
  const childPlans = ['codex', 'hermes'].map(agent => JSON.parse(f.install('--lang', 'zh-CN', '--agent', agent).stdout))
  const json = setupAgent(f, '--lang', 'zh-CN', '--agent', 'codex,hermes', '--json')
  assert.equal(json.status, 0, json.stderr)
  assert.equal(json.stderr, '')
  assert.deepEqual(JSON.parse(json.stdout), { targets: ['codex', 'hermes'], plans: childPlans, applied: false })
  assert.equal(existsSync(f.root), false)
}))

test('setup names the Claude Code plugin whenever Claude Code is installed', async () => {
  for (const kind of ['home', 'override', 'with-codex']) await fixture(f => {
    const claude = kind === 'override' ? join(f.home, 'native-claude') : join(f.home, '.claude')
    f.env.CLAUDE_CONFIG_DIR = claude
    mkdirSync(claude)
    if (kind === 'with-codex') mkdirSync(join(f.home, '.codex'))
    const guidance = setupAgent(f, '--lang', 'en')
    assert.equal(guidance.status, 0, guidance.stderr)
    assert.equal(guidance.stderr, '')
    for (const text of ['Claude Code', 'claude plugin marketplace add WenyuChiou/agent-board', 'claude plugin install agent-board@agent-board']) assert.ok(guidance.stdout.includes(text), guidance.stdout)
    if (kind === 'with-codex') assert.match(guidance.stdout, /Codex/)
    assert.doesNotMatch(guidance.stdout, /    at |INVALID_TARGETS/)
    const json = setupAgent(f, '--lang', 'en', '--json')
    assert.equal(json.status, 0, json.stderr)
    assert.equal(json.stderr, '')
    assert.deepEqual(JSON.parse(json.stdout).targets, kind === 'with-codex' ? ['codex'] : [])
    assert.equal(existsSync(f.root), false)
  })
})

test('a conflict in one agent leaves the others set up and names the skipped agent', async () => {
  for (const agents of ['codex,cursor', 'cursor,codex']) await fixture(f => {
    const cursor = join(f.home, '.cursor', 'hooks.json')
    const malformed = Buffer.from('{"hooks":')
    f.save(cursor, malformed)
    const preview = setupAgent(f, '--lang', 'en', '--agent', agents)
    assert.equal(preview.status, 0, preview.stderr)
    assert.equal(preview.stderr, '')
    for (const text of ['Codex', 'Cursor', 'skipped', '--agent cursor']) assert.ok(preview.stdout.includes(text), preview.stdout)
    assert.deepEqual(readFileSync(cursor), malformed)
    assert.equal(existsSync(f.root), false)

    const args = ['--lang', 'en', '--agent', agents, '--apply']
    const applied = setupAgent(f, ...args, ...(agents.startsWith('codex') ? ['--json'] : []))
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(applied.stderr, '')
    assert.ok(existsSync(f.hooks))
    assert.deepEqual(readFileSync(cursor), malformed)
    assert.equal(existsSync(join(f.root, 'install-cursor.json')), false)
    if (agents.startsWith('codex')) {
      const result = JSON.parse(applied.stdout)
      assert.equal(result.applied, true)
      assert.deepEqual(result.targets, ['codex', 'cursor'])
      assert.ok(result.plans.find(plan => plan.agent === 'codex').changes.length > 0)
      assert.deepEqual(result.plans.find(plan => plan.agent === 'cursor').conflicts, [cursor])
    } else {
      for (const text of ['Codex', 'Cursor', 'skipped', '--agent cursor']) assert.ok(applied.stdout.includes(text), applied.stdout)
    }
  })

  await fixture(f => {
    const cursor = join(f.home, '.cursor', 'hooks.json')
    f.save(f.hooks, '{"hooks":')
    f.save(cursor, '{"hooks":')
    for (const args of [[], ['--apply']]) {
      const result = setupAgent(f, '--lang', 'en', '--agent', 'codex,cursor', ...args)
      assert.equal(result.status, 1)
      assert.equal(result.stderr, '')
      for (const text of ['Codex', 'Cursor', 'skipped', '--agent codex', '--agent cursor']) assert.ok(result.stdout.includes(text), result.stdout)
      assert.equal(existsSync(f.root), false)
    }
    const json = setupAgent(f, '--lang', 'en', '--agent', 'codex,cursor', '--apply', '--json')
    assert.equal(json.status, 1)
    assert.equal(json.stderr, '')
    const result = JSON.parse(json.stdout)
    assert.equal(result.applied, false)
    assert.ok(result.plans.every(plan => plan.conflicts.length > 0))
    assert.equal(existsSync(f.root), false)
  })
})

test('a second setup says everything is already set up and writes nothing', () => fixture(f => {
  const first = setupAgent(f, '--lang', 'en', '--agent', 'codex,cursor', '--apply')
  assert.equal(first.status, 0, first.stderr)
  const snapshot = directory => Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = join(entry.parentPath, entry.name)
      return [file.slice(directory.length), { bytes: readFileSync(file), mtimeMs: statSync(file).mtimeMs }]
    }))
  const before = snapshot(f.home)
  const second = setupAgent(f, '--lang', 'en', '--agent', 'codex,cursor', '--apply')
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.stderr, '')
  assert.equal(second.stdout.match(/already set up/g)?.length, 2, second.stdout)
  assert.deepEqual(snapshot(f.home), before)
}))

test('after setup --lang en --apply on a zh-TW system, a plain setup says already set up and writes nothing', () => fixture(f => {
  const zhTw = { ...f, env: { ...f.env, LANG: 'zh_TW.UTF-8' } }
  const first = setupAgent(zhTw, '--lang', 'en', '--agent', 'codex', '--apply')
  assert.equal(first.status, 0, first.stderr)
  const snapshot = directory => Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = join(entry.parentPath, entry.name)
      return [file.slice(directory.length), { bytes: readFileSync(file), mtimeMs: statSync(file).mtimeMs }]
    }))
  const before = snapshot(f.home)
  // Plain setup preview without --lang
  const preview = setupAgent(zhTw, '--agent', 'codex')
  assert.equal(preview.status, 0, preview.stderr)
  assert.equal(preview.stderr, '')
  assert.match(preview.stdout, /已設定完成/)
  assert.doesNotMatch(preview.stdout, /將更新/)
  assert.deepEqual(snapshot(f.home), before)
  // Plain setup apply without --lang
  const second = setupAgent(zhTw, '--agent', 'codex', '--apply')
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.stderr, '')
  assert.match(second.stdout, /已設定完成/)
  assert.doesNotMatch(second.stdout, /已更新/)
  assert.deepEqual(snapshot(f.home), before)
  // Explicit --lang zh-TW preview names the updated files
  const langChange = setupAgent(zhTw, '--agent', 'codex', '--lang', 'zh-TW')
  assert.equal(langChange.status, 0, langChange.stderr)
  assert.match(langChange.stdout, /將更新 3 個設定檔案/)
}))

test('setup on a computer with only Claude Code prints guidance and exits 0 without a stack trace', () => fixture(f => {
  mkdirSync(join(f.home, '.claude'))
  const english = { ...f, env: { ...f.env, ...isolatedEnv(f.home, sharedRuntimePath(f)), LANG: 'en' } }
  const before = homeSnapshot(f.home)
  const guidance = setupAgent(english)
  assert.equal(guidance.status, 0, guidance.stderr)
  assert.equal(guidance.stderr, '')
  assert.ok(guidance.stdout.trim().split('\n').length >= 3)
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
  assert.ok(traditional.stdout.includes('claude plugin install agent-board@agent-board'))
  assert.deepEqual(homeSnapshot(f.home), before)
}))

test('setup on a computer with Claude Code and Codex previews Codex only', async () => {
  await fixture(f => {
    mkdirSync(join(f.home, '.claude'))
    mkdirSync(join(f.home, '.codex'))
    const result = setupAgent(f, '--json')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout).targets, ['codex'])
    assert.equal(existsSync(f.root), false)
  })
  await fixture(f => {
    const result = setupAgent(f, '--lang', 'en')
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.trim().split('\n').length, 1)
    assert.match(result.stdout, /found no agent/)
  })
})

const setupErrorCases = async check => {
  for (const [args, code, cause] of [
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
    check(f, (...extra) => f.install('--agent', 'codex', '--lang', 'en', ...extra), { code: 'EISDIR', message: 'agent-board: setup expected a file but found a folder; move the folder out of the setup data path and run the command again.' })
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
      assert.equal(result.stderr, '')
      assert.match(result.stdout, /Codex.*skipped/s)
      assert.match(result.stdout, /--agent codex/)
      return
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

test('setup and doctor explain each known failure in all three languages', async () => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  try {
    const { setupFailure } = await import('../scripts/codex-local.ts')
    const { STRINGS } = await import('../hooks/strings.ts')
    const common = ['MISSING_ARGUMENT', 'INVALID_INSTALL_RECORD', 'INSTALL_CONFLICT', 'UNSAFE_COMMAND_PATH', 'INVALID_JSON_OBJECT', 'INVALID_HOOK_GROUP', 'INVALID_PLUGIN_CONFIG', 'SHARED_BOARD_PATH_CONFLICT', 'INSTALL_CHANGED', 'LOCK_BUSY', 'LOCK_OWNERSHIP_LOST', 'CODEX_BINARY_REQUIRED', 'ABSOLUTE_CODEX_BINARY_REQUIRED', 'OWNED_CODEX_INSTALL_REQUIRED']
    for (const lang of ['en', 'zh-TW', 'zh-CN']) {
      const strings = STRINGS[lang]
      for (const code of [...common, ...Object.keys(strings.setupErrorDetails)]) {
        const result = setupFailure(Object.assign(new Error(code), { code }), 'codex', strings)
        assert.equal(result.code, code)
        assert.equal(result.message.split('\n').length, 1, `${lang} ${code}`)
        assert.notEqual(result.message, strings.setupErrorOther(strings.agentNames.codex), `${lang} ${code}`)
        assert.equal(result.reason, undefined)
      }
      const unknown = setupFailure(new Error('synthetic underlying reason'), 'codex', strings)
      assert.equal(unknown.code, 'UNKNOWN')
      assert.equal(unknown.message, strings.setupErrorOther(strings.agentNames.codex))
      assert.equal(unknown.reason, 'synthetic underlying reason')
      const unusual = setupFailure(Object.assign(new Error('failure'), { code: 'SYNTHETIC_CODE' }), 'codex', strings)
      assert.match(unusual.message, /SYNTHETIC_CODE/)
    }
  } finally { resolver.deregister() }
})

test('doctor prints plain installation problems and one next step unless JSON is requested', () => fixture(f => {
  const runner = join(f.home, 'doctor-cli.mjs')
  f.save(runner, bundleFromDir(new URL('..', import.meta.url)))
  const run = (lang, ...args) => spawnSync(process.execPath, [runner, '--home', f.home, '--codex-doctor', '--agent', 'antigravity', '--lang', lang, ...args], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  for (const [lang, missing, installed, next, problem] of [
    ['en', 'missing or need repair', 'are installed', 'Next:', 'skill only, no report hook'],
    ['zh-TW', '缺失或需要修復', '已安裝', '下一步：', '只有 skill，沒有回報 hook'],
    ['zh-CN', '缺失或需要修复', '已安装', '下一步：', '只有 skill，没有汇报 hook'],
  ]) {
    const check = expected => {
      const plain = run(lang)
      assert.equal(plain.status, 0, plain.stderr)
      assert.ok(plain.stdout.includes(expected), plain.stdout)
      assert.ok(!plain.stdout.includes('{'), plain.stdout)
      assert.equal(plain.stdout.split(next).length - 1, 1, plain.stdout)
      const json = run(lang, '--json')
      assert.equal(json.status, 0, json.stderr)
      const parsed = JSON.parse(json.stdout)
      assert.equal(json.stdout, `${JSON.stringify(parsed, null, 2)}\n`)
      assert.equal(parsed.agent, 'antigravity')
      return parsed
    }
    if (existsSync(join(f.root, 'install-antigravity.json'))) {
      const removed = spawnSync(process.execPath, [runner, '--home', f.home, '--codex-remove', '--agent', 'antigravity', '--apply'], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
      assert.equal(removed.status, 0, removed.stderr)
    }
    assert.equal(check(missing).installed, false)
    assert.equal(f.install('--agent', 'antigravity', '--lang', lang, '--apply').status, 0)
    assert.equal(check(installed).installed, true)
    const config = join(f.home, '.gemini', 'config', 'hooks.json')
    const bytes = readFileSync(config)
    f.save(config, '{}\n')
    assert.ok(check(problem).problem.includes(problem))
    f.save(config, bytes)
  }
}))

test('removal preview and apply print plain changes and one next step unless JSON is requested', () => fixture(f => {
  const runner = join(f.home, 'remove-cli.mjs')
  f.save(runner, bundleFromDir(new URL('..', import.meta.url)))
  const run = (lang, ...args) => spawnSync(process.execPath, [runner, '--home', f.home, '--codex-remove', '--agent', 'antigravity', '--lang', lang, ...args], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  for (const [lang, preview, applied, next] of [
    ['en', 'removal preview', 'removal applied', 'Next:'],
    ['zh-TW', '移除預覽', '已套用', '下一步：'],
    ['zh-CN', '移除预览', '已应用', '下一步：'],
  ]) {
    const install = () => assert.equal(f.install('--agent', 'antigravity', '--lang', lang, '--apply').status, 0)
    install()
    const snapshot = homeSnapshot(f.home)
    const plainPreview = run(lang)
    assert.equal(plainPreview.status, 0, plainPreview.stderr)
    assert.ok(plainPreview.stdout.includes(preview), plainPreview.stdout)
    assert.ok(!plainPreview.stdout.includes('{'), plainPreview.stdout)
    assert.equal(plainPreview.stdout.split(next).length - 1, 1)
    assert.ok(plainPreview.stdout.includes('--apply'))
    assert.deepEqual(homeSnapshot(f.home), snapshot)
    const jsonPreview = run(lang, '--json')
    const plan = JSON.parse(jsonPreview.stdout)
    assert.equal(jsonPreview.status, 0, jsonPreview.stderr)
    assert.equal(plan.mode, 'remove')
    assert.equal(plan.applied, undefined)
    assert.equal(jsonPreview.stdout, `${JSON.stringify(plan, null, 2)}\n`)
    const skill = join(f.home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')
    const skillBytes = readFileSync(skill)
    f.save(skill, 'Synthetic user edit\n')
    const conflicted = homeSnapshot(f.home)
    for (const args of [[], ['--apply']]) {
      const conflict = run(lang, ...args)
      assert.equal(conflict.status, args.length ? 1 : 0, conflict.stderr)
      assert.equal(conflict.stderr, '')
      assert.ok(conflict.stdout.includes(skill), conflict.stdout)
      assert.ok(!conflict.stdout.includes('{'), conflict.stdout)
      assert.equal(conflict.stdout.split(next).length - 1, 1)
      assert.deepEqual(homeSnapshot(f.home), conflicted)
    }
    const jsonConflict = run(lang, '--apply', '--json')
    assert.equal(jsonConflict.status, 1)
    assert.ok(JSON.parse(jsonConflict.stdout).conflicts.includes(skill))
    assert.equal(JSON.parse(jsonConflict.stderr).error.code, 'INSTALL_CONFLICT')
    f.save(skill, skillBytes)
    const plainApply = run(lang, '--apply')
    assert.equal(plainApply.status, 0, plainApply.stderr)
    assert.ok(plainApply.stdout.includes(applied), plainApply.stdout)
    assert.ok(!plainApply.stdout.includes('{'), plainApply.stdout)
    assert.equal(plainApply.stdout.split(next).length - 1, 1)
    assert.equal(existsSync(join(f.root, 'install-antigravity.json')), false)
    assert.equal(existsSync(f.progress), true)
    install()
    const jsonApply = run(lang, '--apply', '--json')
    assert.equal(jsonApply.status, 0, jsonApply.stderr)
    const result = JSON.parse(jsonApply.stdout)
    assert.equal(result.applied, true)
    assert.equal(jsonApply.stdout, `${JSON.stringify(result, null, 2)}\n`)
    assert.equal(existsSync(join(f.root, 'install-antigravity.json')), false)
  }
}))

test('a removal preview names the shared files it keeps while another agent uses them', () => fixture(f => {
  const runner = join(f.home, 'kept-shared-cli.mjs')
  f.save(runner, bundleFromDir(new URL('..', import.meta.url)))
  const worker = join(f.root, 'agent-board-hook.mjs')
  const shared = [f.script, worker, f.skill]
  const remove = (agent, lang, ...args) => spawnSync(process.execPath, [runner, '--home', f.home, '--codex-remove', '--agent', agent, '--lang', lang, ...args], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  for (const [lang, removeWord, next] of [
    ['en', 'Would remove: ', 'Next:'],
    ['zh-TW', '將移除：', '下一步：'],
    ['zh-CN', '将移除：', '下一步：'],
  ]) {
    assert.equal(f.install('--agent', 'codex', '--lang', lang, '--apply').status, 0)
    assert.equal(f.install('--agent', 'antigravity', '--lang', lang, '--apply').status, 0)
    const snapshot = homeSnapshot(f.home)
    const preview = remove('antigravity', lang)
    assert.equal(preview.status, 0, preview.stderr)
    assert.equal(preview.stdout.split(next).length - 1, 1, preview.stdout)
    for (const file of shared) {
      const keptLine = lang === 'en' ? `Keeps ${file}; still in use by Codex` : `保留 ${file}；Codex 仍在使用`
      assert.ok(preview.stdout.includes(keptLine), preview.stdout)
      assert.ok(!preview.stdout.includes(`${removeWord}${file}`), preview.stdout)
    }
    assert.deepEqual(homeSnapshot(f.home), snapshot)
    const jsonPreview = remove('antigravity', lang, '--json')
    assert.equal(jsonPreview.status, 0, jsonPreview.stderr)
    const plan = JSON.parse(jsonPreview.stdout)
    assert.equal(plan.mode, 'remove')
    assert.equal(plan.applied, undefined)
    assert.deepEqual(plan.keptShared, shared.map(file => ({ file, usedBy: ['codex'] })), jsonPreview.stdout)
    assert.ok(!plan.changes.some(change => shared.includes(change.file)), jsonPreview.stdout)
    // Applying the removal leaves the shared files for Codex.
    const applied = remove('antigravity', lang, '--apply')
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(existsSync(join(f.root, 'install-antigravity.json')), false)
    for (const file of shared) assert.equal(existsSync(file), true, file)
    // Codex is now the last agent: its preview names the shared files as removed.
    const lastPreview = remove('codex', lang)
    assert.equal(lastPreview.status, 0, lastPreview.stderr)
    for (const file of shared) assert.ok(lastPreview.stdout.includes(`${removeWord}${file}`), lastPreview.stdout)
    const lastPlan = JSON.parse(remove('codex', lang, '--json').stdout)
    assert.equal(lastPlan.keptShared, undefined)
    assert.ok(shared.every(file => lastPlan.changes.some(change => change.file === file && change.action === 'remove')), JSON.stringify(lastPlan.changes))
    assert.equal(remove('codex', lang, '--apply').status, 0)
  }
}))

test('doctor and removal print a next step that works when a path holds characters a shell would expand or eat', () => fixture(f => {
  const runner = join(f.home, 'next-step-cli.mjs')
  f.save(runner, bundleFromDir(new URL('..', import.meta.url)))
  const nextStep = stdout => {
    assert.equal(stdout.split('Next:').length - 1, 1, stdout)
    assert.ok(!stdout.includes('{"'), stdout)
    return /^Next: [^:]+: (.+)$/m.exec(stdout)?.[1]
  }
  for (const name of ['odd $HOME 100%', 'bang!x', 'back\\slash', 'trailing space\\']) {
    const home = join(f.home, name)
    mkdirSync(home, { recursive: true })
    const data = join(f.home, 'data')
    const board = (...args) => spawnSync(process.execPath, [runner, '--home', home, '--data-dir', data, ...args, '--agent', 'antigravity', '--lang', 'en'], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    const printed = command => spawnSync(command, { shell: true, cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    const doctor = board('--codex-doctor')
    assert.equal(doctor.status, 0, doctor.stderr)
    const repair = nextStep(doctor.stdout)
    assert.ok(!repair.includes(home), repair)
    const previewed = printed(repair)
    assert.equal(previewed.status, 0, previewed.stderr)
    const repaired = printed(nextStep(previewed.stdout))
    assert.equal(repaired.status, 0, repaired.stderr)
    assert.ok(repaired.stdout.includes('setup repair applied'), repaired.stdout)
    const checked = printed(nextStep(repaired.stdout))
    assert.equal(checked.status, 0, checked.stderr)
    assert.ok(checked.stdout.includes('are installed'), checked.stdout)
    const preview = board('--codex-remove')
    assert.equal(preview.status, 0, preview.stderr)
    const apply = nextStep(preview.stdout)
    assert.ok(!apply.includes(home), apply)
    const applied = printed(apply)
    assert.equal(applied.status, 0, applied.stderr)
    assert.ok(applied.stdout.includes('removal applied'), applied.stdout)
  }
}))

test('the repair the doctor names prints plain lines in the board\'s language, and --codex-setup keeps its JSON otherwise', () => fixture(f => {
  const runner = join(f.home, 'repair-cli.mjs')
  f.save(runner, bundleFromDir(new URL('..', import.meta.url)))
  const board = (...args) => spawnSync(process.execPath, [runner, '--home', f.home, '--data-dir', join(f.home, 'data'), '--agent', 'antigravity', ...args], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  for (const [lang, preview, applied, current, next] of [
    ['en', 'nothing changed', 'repair applied', 'already current', 'Next:'],
    ['zh-TW', '沒有更動任何內容', '修復已套用', '已是最新', '下一步：'],
    ['zh-CN', '没有更改任何内容', '修复已应用', '已是最新', '下一步：'],
  ]) {
    const removed = board('--codex-remove', '--apply', '--lang', lang)
    assert.equal(removed.status, 0, removed.stderr)
    for (const [args, expected] of [[[], preview], [['--apply'], applied], [[], current]]) {
      const plain = board('--codex-setup', '--plain', '--lang', lang, ...args)
      assert.equal(plain.status, 0, plain.stderr)
      assert.ok(plain.stdout.includes(expected), plain.stdout)
      assert.ok(!plain.stdout.includes('{'), plain.stdout)
      assert.equal(plain.stdout.split(next).length - 1, 1, plain.stdout)
    }
    assert.deepEqual(JSON.parse(board('--codex-setup', '--plain', '--json', '--lang', lang).stdout).conflicts, [])
    assert.deepEqual(JSON.parse(board('--codex-setup', '--lang', lang).stdout).conflicts, [])
  }
  f.save(join(f.home, '.gemini', 'config', 'hooks.json'), '{not json')
  const blocked = board('--codex-setup', '--plain', '--lang', 'en', '--apply')
  assert.equal(blocked.status, 1, blocked.stderr)
  assert.equal(blocked.stderr, '')
  assert.ok(blocked.stdout.includes('blocked by conflicting files'), blocked.stdout)
}))

test('doctor and removal say plainly when an adapter is pending, a connector holds the hook, or nothing is left to remove', () => fixture(f => {
  const runner = join(f.home, 'states-cli.mjs')
  f.save(runner, bundleFromDir(new URL('..', import.meta.url)))
  const isolated = ['--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes')]
  const board = (file, ...args) => spawnSync(process.execPath, [file, ...isolated, ...args], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const isOneNext = stdout => stdout.split('Next:').length - 1 === 1

  for (const apply of [[], ['--apply']]) {
    const nothing = board(runner, '--codex-remove', '--agent', 'codex', '--lang', 'en', ...apply)
    assert.equal(nothing.status, 0, nothing.stderr)
    assert.ok(nothing.stdout.includes('no owned Agent Board files to remove'), nothing.stdout)
    assert.ok(nothing.stdout.includes('Next: no removal is needed.'), nothing.stdout)
    assert.ok(!nothing.stdout.includes('removal applied') && !nothing.stdout.includes('restart'), nothing.stdout)
    assert.ok(isOneNext(nothing.stdout), nothing.stdout)
  }

  assert.equal(f.install('--agent', 'hermes', '--lang', 'en', '--apply').status, 0)
  // Hermes has its hooks now, so it is no longer a host whose adapter is pending (#1115).
  const hermes = board(runner, '--codex-doctor', '--agent', 'hermes', '--lang', 'en')
  assert.equal(hermes.status, 0, hermes.stderr)
  assert.ok(!hermes.stdout.includes('Automatic reporting adapter is not available yet.'), hermes.stdout)
  assert.ok(hermes.stdout.includes('Next: start a new Hermes Agent session'), hermes.stdout)
  assert.ok(isOneNext(hermes.stdout), hermes.stdout)

  mkdirSync(join(f.home, '.codex'), { recursive: true })
  const connected = legacyConnect(f, join(f.home, '.claude', 'progress.md'))
  const connector = board(connected, '--codex-doctor', '--agent', 'codex', '--lang', 'en')
  assert.equal(connector.status, 0, connector.stderr)
  assert.ok(connector.stdout.includes('managed by the Claude Code plugin connector'), connector.stdout)
  assert.ok(connector.stdout.includes('Next: start a new Codex session'), connector.stdout)
  assert.ok(!connector.stdout.includes('--codex-bin') && !connector.stdout.includes('hooks are'), connector.stdout)
  assert.ok(isOneNext(connector.stdout), connector.stdout)
  for (const apply of [[], ['--apply']]) {
    const repair = board(connected, '--codex-setup', '--agent', 'codex', '--plain', '--lang', 'en', ...apply)
    assert.equal(repair.status, 0, repair.stderr)
    assert.ok(repair.stdout.includes('managed by the Claude Code plugin connector'), repair.stdout)
    assert.ok(repair.stdout.includes('Next: run /progress connect in Claude Code'), repair.stdout)
    assert.ok(!repair.stdout.includes('{') && isOneNext(repair.stdout), repair.stdout)
    assert.equal(JSON.parse(board(connected, '--codex-setup', '--agent', 'codex', '--plain', '--json', '--lang', 'en', ...apply).stdout).managedBy, 'connector')
  }
}))

test('doctor explains Claude Code plugin support in every language', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const plain = f.command(['--codex-doctor', '--agent', 'claude', '--lang', lang])
    assert.equal(plain.status, 1)
    for (const name of ['codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity', 'deepseek', 'Claude Code', 'claude plugin list']) assert.ok(plain.stderr.includes(name), plain.stderr)
    const json = f.command(['--codex-doctor', '--agent', 'claude', '--lang', lang, '--json'])
    const { error } = JSON.parse(json.stderr)
    assert.equal(error.code, 'UNSUPPORTED_AGENT')
    assert.equal(error.message, plain.stderr.trim())
  }
}))

test('uncoded setup failures preserve their reason in JSON and coded failures name the error', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const preload = join(f.home, 'synthetic-error.cjs')
  f.save(preload, `const fs = require('node:fs')
const original = fs.readFileSync
fs.readFileSync = function(file, ...args) {
  if (file === ${JSON.stringify(join(f.root, 'install-codex.json'))}) {
    const error = new Error('synthetic underlying reason')
    if (process.env.SYNTHETIC_ERROR_CODE) error.code = process.env.SYNTHETIC_ERROR_CODE
    throw error
  }
  return original.call(this, file, ...args)
}
require('node:module').syncBuiltinESMExports()
`)
  const env = { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }
  const plain = f.command(['--codex-doctor', '--lang', 'en'], undefined, env)
  assert.equal(plain.status, 1)
  assert.match(plain.stderr, /Run it again with --json/)
  const json = f.command(['--codex-doctor', '--lang', 'en', '--json'], undefined, env)
  assert.deepEqual(JSON.parse(json.stderr).error, { code: 'UNKNOWN', message: plain.stderr.trim(), reason: 'synthetic underlying reason' })
  const coded = f.command(['--codex-doctor', '--lang', 'en', '--json'], undefined, { ...env, SYNTHETIC_ERROR_CODE: 'EINVAL' })
  assert.equal(JSON.parse(coded.stderr).error.code, 'EINVAL')
  assert.match(JSON.parse(coded.stderr).error.message, /rejected a setup argument/)
  assert.doesNotMatch(coded.stderr, /Run it again with --json/)
  f.env.NODE_OPTIONS = env.NODE_OPTIONS
  const bootstrap = setupAgent(f, '--agent', 'codex', '--lang', 'en', '--json')
  const failure = JSON.parse(bootstrap.stderr).error
  assert.equal(failure.code, 'SETUP_FAILED')
  assert.equal(failure.cause, 'UNKNOWN')
  assert.equal(failure.reason, 'synthetic underlying reason')
}))

test('the setup bootstrap explains helper launch errors in every language', () => fixture(f => {
  const preload = join(f.home, 'synthetic-spawn-error.cjs')
  f.save(preload, `const child = require('node:child_process')
const original = child.spawnSync
child.spawnSync = function(file, args, options) {
  if (Array.isArray(args) && String(args[0]).endsWith('setup-codex.mjs')) {
    const error = new Error('synthetic helper failure')
    if (process.env.SYNTHETIC_ERROR_CODE) error.code = process.env.SYNTHETIC_ERROR_CODE
    return { error, status: null, stdout: '', stderr: '' }
  }
  return original.call(this, file, args, options)
}
require('node:module').syncBuiltinESMExports()
`)
  f.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  f.env.SYNTHETIC_ERROR_CODE = 'EINVAL'
  for (const [lang, detail] of [['en', 'rejected a setup argument'], ['zh-TW', '拒絕了 setup 參數'], ['zh-CN', '拒绝了 setup 参数']]) {
    const result = setupAgent(f, '--agent', 'codex', '--lang', lang, '--json')
    assert.equal(result.status, 1)
    const { error } = JSON.parse(result.stderr)
    assert.equal(error.code, 'SETUP_FAILED')
    assert.equal(error.cause, 'EINVAL')
    assert.ok(error.message.includes(detail), error.message)
    assert.doesNotMatch(error.message, /--json/)
  }
  delete f.env.SYNTHETIC_ERROR_CODE
  const unknown = setupAgent(f, '--agent', 'codex', '--json')
  assert.equal(JSON.parse(unknown.stderr).error.reason, 'synthetic helper failure')
}))

test('Windows Codex npm shims resolve without a shell and unknown shims give a next step', { skip: process.platform !== 'win32' }, () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const bin = join(f.home, 'shim & synthetic')
  const root = join(bin, 'node_modules', '@openai', 'codex')
  const launcher = join(root, 'bin', 'codex.js')
  const entries = Object.entries(JSON.parse(readFileSync(f.hooks, 'utf8')).hooks).map(([event, groups], i) => ({
    sourcePath: f.hooks, eventName: event[0].toLowerCase() + event.slice(1), command: groups[0].hooks[0].command,
    key: `hook-${i}`, enabled: true, currentHash: `sha256:${'a'.repeat(64)}`, trustStatus: 'untrusted',
  }))
  f.save(join(root, 'package.json'), JSON.stringify({ name: '@openai/codex', type: 'module' }))
  f.save(launcher, `import { createInterface } from 'node:readline'
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') console.log(JSON.stringify({ id: request.id, result: {} }))
  if (request.method === 'hooks/list') console.log(JSON.stringify({ id: request.id, result: { data: [{ hooks: ${JSON.stringify(entries)}, errors: [] }] } }))
})
`)
  for (const [name, source] of [
    ['codex.cmd', '@echo off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'],
    ['codex.ps1', '& "$basedir/node" "$basedir/node_modules/@openai/codex/bin/codex.js" $args\n'],
  ]) {
    assert.equal(f.install('--lang', 'en', '--apply').status, 0)
    const shim = join(bin, name)
    f.save(shim, source)
    const result = f.command(['--codex-trust', '--codex-bin', shim, '--json'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).hooks.length, 7)
    assert.ok(JSON.parse(result.stdout).hooks.some(hook => hook.event === 'postToolUse'))
    assert.equal(JSON.parse(result.stdout).applied, false)
    f.save(shim, 'not an npm shim')
    for (const lang of ['en', 'zh-TW', 'zh-CN']) {
      const installed = f.install('--lang', lang, '--apply')
      assert.equal(installed.status, 0, installed.stderr)
      const rejected = f.command(['--codex-trust', '--codex-bin', shim, '--lang', lang, '--json'])
      const error = JSON.parse(rejected.stderr).error
      assert.equal(error.code, 'CODEX_SHIM_UNSUPPORTED')
      assert.match(error.message, /codex\.exe.*Get-ChildItem|Get-ChildItem.*codex\.exe/)
      assert.doesNotMatch(error.message, /EINVAL|--json/)
    }
  }
}))

test('documented doctor and removal previews work from PowerShell and bash in an installed synthetic home', { timeout: 120000 }, t => fixture(f => {
  const bash = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash'
  if (!existsSync(bash)) return t.skip('bash is unavailable')
  assert.equal(f.install('--apply').status, 0)
  const env = { ...f.env }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  env[pathKey] = [dirname(process.execPath), env[pathKey]].filter(Boolean).join(delimiter)
  const guard = process.platform === 'win32' ? '[ "$HOME" -ef "$(cygpath -u "$USERPROFILE")" ] || exit 97; ' : '[ "$HOME" -ef "$USERPROFILE" ] || exit 97; '
  const shells = [[bash, ['-c'], guard]]
  if (process.platform === 'win32') shells.push([join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-Command'], 'if ($HOME -ne $env:USERPROFILE) { exit 97 }; '])
  for (const [shell, prefix, homeGuard] of shells) {
    for (const [args, expected] of [['--codex-doctor --agent codex --json', /"installed":\s*true/], ['--codex-remove --agent codex --json', /"mode":\s*"remove"/]]) {
      const result = spawnSync(shell, [...prefix, `${homeGuard}node "$HOME/.agent-board/agent-board.mjs" ${args}`], { cwd: f.home, env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
      assert.equal(result.status, 0, `${shell}: ${result.stderr}`)
      assert.match(result.stdout, expected)
      assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/)
    }
  }
}))

const jsonHosts = [
  ['cursor', '.cursor/hooks.json', 'Cursor'],
  ['gemini', '.gemini/settings.json', 'Gemini CLI'],
  ['grok', '.grok/hooks/agent-board-local.json', 'Grok Build'],
  ['muse', '.config/muse/settings.json', 'Muse Code'],
  ['antigravity', '.gemini/config/hooks.json', 'Antigravity'],
  ['openclaw', '.openclaw/openclaw.json', 'OpenClaw'],
]

test('Antigravity setup recreates owned config and standalone files that went missing', () => fixture(f => {
  const config = join(f.home, '.gemini', 'config', 'hooks.json')
  const antigravitySkill = join(f.home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')
  const installed = f.install('--agent', 'antigravity', '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  unlinkSync(config)
  unlinkSync(antigravitySkill)

  const preview = f.install('--agent', 'antigravity')
  assert.equal(preview.status, 0, preview.stderr)
  const plan = JSON.parse(preview.stdout)
  assert.deepEqual(plan.conflicts, [])
  assert.equal(plan.changes.find(change => change.file === config)?.action, 'create')
  assert.equal(plan.changes.find(change => change.file === antigravitySkill)?.action, 'create')
  assert.equal(existsSync(config), false)
  assert.equal(existsSync(antigravitySkill), false)

  const applied = f.install('--agent', 'antigravity', '--apply')
  assert.equal(applied.status, 0, applied.stderr)
  assert.ok(JSON.parse(readFileSync(config, 'utf8'))['agent-board-local'])
  assert.deepEqual(readFileSync(antigravitySkill), readFileSync(f.skill))
}))

test('Antigravity setup recreates its missing hook entry without changing unrelated definitions', () => fixture(f => {
  const config = join(f.home, '.gemini', 'config', 'hooks.json')
  const foreign = { 'foreign-hooks': { PreInvocation: [{ type: 'command', command: 'synthetic-foreign', timeout: 5 }] } }
  f.save(config, `${JSON.stringify(foreign, null, 2)}\n`)
  const installed = f.install('--agent', 'antigravity', '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const withoutOwned = JSON.parse(readFileSync(config, 'utf8'))
  delete withoutOwned['agent-board-local']
  const missing = `${JSON.stringify(withoutOwned, null, 2)}\n`
  f.save(config, missing)

  const preview = f.install('--agent', 'antigravity')
  assert.equal(preview.status, 0, preview.stderr)
  const plan = JSON.parse(preview.stdout)
  assert.deepEqual(plan.conflicts, [])
  assert.deepEqual(plan.changes.find(change => change.file === config), { file: config, action: 'create' })
  assert.equal(readFileSync(config, 'utf8'), missing)

  const applied = f.install('--agent', 'antigravity', '--apply')
  assert.equal(applied.status, 0, applied.stderr)
  const restored = JSON.parse(readFileSync(config, 'utf8'))
  assert.deepEqual(restored['foreign-hooks'], foreign['foreign-hooks'])
  assert.ok(restored['agent-board-local'])
}))

test('Antigravity removal finishes when owned files and hook entries are already gone', () => fixture(f => {
  const config = join(f.home, '.gemini', 'config', 'hooks.json')
  const antigravitySkill = join(f.home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')
  const manifest = join(f.root, 'install-antigravity.json')
  const worker = join(f.root, 'agent-board-hook.mjs')
  const foreign = { 'foreign-hooks': { Stop: [{ type: 'command', command: 'synthetic-foreign', timeout: 5 }] } }
  f.save(config, `${JSON.stringify(foreign, null, 2)}\n`)
  const installed = f.install('--agent', 'antigravity', '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  unlinkSync(antigravitySkill)
  const withoutOwned = JSON.parse(readFileSync(config, 'utf8'))
  delete withoutOwned['agent-board-local']
  const missingGroup = `${JSON.stringify(withoutOwned, null, 2)}\n`
  f.save(config, missingGroup)

  const removed = f.command(['--codex-remove', '--agent', 'antigravity', '--apply', '--json'])
  assert.equal(removed.status, 0, removed.stderr)
  const result = JSON.parse(removed.stdout)
  assert.equal(result.applied, true)
  assert.deepEqual(result.conflicts, [])
  assert.ok(result.alreadyGone.includes(antigravitySkill), removed.stdout)
  assert.ok(result.alreadyGone.includes(`${config}:agent-board-local`), removed.stdout)
  assert.match(result.notice, /already gone/i)
  assert.ok(result.notice.includes(antigravitySkill), result.notice)
  assert.ok(result.notice.includes(`${config}:agent-board-local`), result.notice)
  assert.ok(!result.changes.some(change => change.file === antigravitySkill || change.file === config), removed.stdout)
  for (const file of [f.script, worker, f.skill, manifest]) assert.equal(existsSync(file), false, file)
  assert.equal(readFileSync(config, 'utf8'), missingGroup)
  assert.ok(existsSync(f.progress))
}))

test('Antigravity setup still reports a user-edited owned file as a conflict', () => fixture(f => {
  const antigravitySkill = join(f.home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')
  const installed = f.install('--agent', 'antigravity', '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const edited = `${readFileSync(antigravitySkill, 'utf8')}Synthetic user edit\n`
  f.save(antigravitySkill, edited)

  const preview = f.install('--agent', 'antigravity')
  assert.equal(preview.status, 0, preview.stderr)
  assert.ok(JSON.parse(preview.stdout).conflicts.includes(antigravitySkill), preview.stdout)
  const applied = f.install('--agent', 'antigravity', '--apply')
  assert.notEqual(applied.status, 0)
  assert.ok(JSON.parse(applied.stdout).conflicts.includes(antigravitySkill), applied.stdout)
  assert.equal(readFileSync(antigravitySkill, 'utf8'), edited)
}))

test('setup hashes foreign hook entries and restores a missing owned hook beside them', () => fixture(f => {
  const foreign = { hooks: [{ type: 'command', command: 'synthetic-foreign-stop --token synthetic-private-value' }] }
  f.save(f.hooks, JSON.stringify({ hooks: { Stop: [foreign] } }))
  const installed = f.install('--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const manifest = readFileSync(join(f.root, 'install-codex.json'), 'utf8')
  assert.ok(!manifest.includes('synthetic-private-value'))
  assert.ok(!manifest.includes(JSON.stringify(foreign)))
  assert.deepEqual(JSON.parse(manifest).foreignGroups.Stop, [createHash('sha256').update(JSON.stringify(foreign)).digest('hex')])
  const config = JSON.parse(readFileSync(f.hooks, 'utf8'))
  const owned = config.hooks.Stop[1]
  config.hooks.Stop = [foreign]
  f.save(f.hooks, JSON.stringify(config))
  const preview = f.install()
  assert.equal(preview.status, 0, preview.stderr)
  assert.deepEqual(JSON.parse(preview.stdout).conflicts, [])
  assert.equal(JSON.parse(preview.stdout).changes.find(change => change.file === f.hooks)?.action, 'create')
  const applied = f.install('--apply')
  assert.equal(applied.status, 0, applied.stderr + applied.stdout)
  assert.deepEqual(JSON.parse(readFileSync(f.hooks, 'utf8')).hooks.Stop, [foreign, owned])
  f.save(f.hooks, JSON.stringify(config))
  const removed = f.command(['--codex-remove', '--apply', '--json'])
  assert.equal(removed.status, 0, removed.stderr + removed.stdout)
  assert.ok(JSON.parse(removed.stdout).alreadyGone.includes(`${f.hooks}:Stop`))
  assert.deepEqual(JSON.parse(readFileSync(f.hooks, 'utf8')).hooks.Stop, [foreign])
}))

test('removal keeps an ambiguous foreign hook when an older record has no foreign history', () => fixture(f => {
  const foreign = { hooks: [{ type: 'command', command: 'synthetic-foreign-stop' }] }
  f.save(f.hooks, JSON.stringify({ hooks: { Stop: [foreign] } }))
  assert.equal(f.install('--apply').status, 0)
  const manifestFile = join(f.root, 'install-codex.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  delete manifest.foreignGroups
  f.save(manifestFile, JSON.stringify(manifest))
  const config = JSON.parse(readFileSync(f.hooks, 'utf8'))
  config.hooks.Stop = [foreign]
  f.save(f.hooks, JSON.stringify(config))

  const removed = f.command(['--codex-remove', '--apply', '--json'])
  assert.equal(removed.status, 0, removed.stderr + removed.stdout)
  assert.ok(JSON.parse(removed.stdout).alreadyGone.includes(`${f.hooks}:Stop`))
  assert.deepEqual(JSON.parse(readFileSync(f.hooks, 'utf8')).hooks.Stop, [foreign])
  assert.equal(existsSync(manifestFile), false)
}))

test('removal refuses an owned array hook the user edited when the record has foreign history', () => fixture(f => {
  const foreign = { hooks: [{ type: 'command', command: 'synthetic-foreign-stop' }] }
  f.save(f.hooks, JSON.stringify({ hooks: { Stop: [foreign] } }))
  assert.equal(f.install('--apply').status, 0)
  const config = JSON.parse(readFileSync(f.hooks, 'utf8'))
  config.hooks.Stop[1].hooks[0].timeout = 99
  const edited = JSON.stringify(config)
  f.save(f.hooks, edited)
  const files = readdirSync(f.root).sort()

  const removed = f.command(['--codex-remove', '--apply', '--json'])
  assert.notEqual(removed.status, 0)
  const plan = JSON.parse(removed.stdout)
  assert.ok(plan.conflicts.includes(`${f.hooks}:Stop`), removed.stdout)
  assert.ok(!(plan.alreadyGone ?? []).includes(`${f.hooks}:Stop`))
  assert.equal(readFileSync(f.hooks, 'utf8'), edited)
  assert.deepEqual(readdirSync(f.root).sort(), files)
}))

test('setup refuses an edited owned array hook even when its command was completely replaced', () => fixture(f => {
  const installed = f.install('--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const config = JSON.parse(readFileSync(f.hooks, 'utf8'))
  config.hooks.Stop[0].hooks[0].command = 'synthetic-personal-replacement'
  const edited = JSON.stringify(config)
  f.save(f.hooks, edited)
  const applied = f.install('--apply')
  assert.notEqual(applied.status, 0)
  assert.ok(JSON.parse(applied.stdout).conflicts.includes(`${f.hooks}:Stop`))
  assert.equal(readFileSync(f.hooks, 'utf8'), edited)
}))

test('setup restores missing OpenClaw and DeepSeek configuration entries while keeping unrelated settings', async () => {
  for (const agent of ['openclaw', 'deepseek']) await fixture(f => {
    const installed = f.install('--agent', agent, '--apply')
    assert.equal(installed.status, 0, installed.stderr + installed.stdout)
    const file = agent === 'openclaw' ? join(f.home, '.openclaw', 'openclaw.json') : join(f.home, '.dsh', 'cordis.patch.yml')
    unlinkSync(file)
    const preview = f.install('--agent', agent)
    assert.equal(preview.status, 0, preview.stderr + preview.stdout)
    assert.deepEqual(JSON.parse(preview.stdout).conflicts, [], agent)
    assert.equal(JSON.parse(preview.stdout).changes.find(change => change.file === file)?.action, 'create', agent)
    const restored = f.install('--agent', agent, '--apply')
    assert.equal(restored.status, 0, restored.stderr + restored.stdout)
    if (agent === 'openclaw') {
      const config = JSON.parse(readFileSync(file, 'utf8'))
      delete config.plugins.entries['agent-board-local']
      config.synthetic = 'keep me'
      f.save(file, JSON.stringify(config))
    } else f.save(file, '- synthetic-foreign-entry\n')
    const reapplied = f.install('--agent', agent, '--apply')
    assert.equal(reapplied.status, 0, reapplied.stderr + reapplied.stdout)
    assert.ok(readFileSync(file, 'utf8').includes(agent === 'openclaw' ? 'keep me' : 'synthetic-foreign-entry'))
    assert.ok(readFileSync(file, 'utf8').includes('agent-board-local'))
  })
})

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
  for (const [host, relative] of jsonHosts) await fixture(f => {
    const config = join(f.home, relative)
    const original = Buffer.from('\uFEFF{"hooks":\r\n')
    f.save(config, original)
    const preview = f.install('--agent', host)
    assertSetupStatus(preview, 0)
    assert.ok(JSON.parse(preview.stdout).conflicts.includes(config))
    assert.deepEqual(readFileSync(config), original)
    const applied = f.install('--agent', host, '--apply')
    assert.notEqual(applied.status, 0)
    assert.deepEqual(readFileSync(config), original)
    assert.equal(existsSync(f.root), false)
    const common = setupAgent(f, '--lang', 'en', '--agent', host, '--json')
    assertSetupStatus(common, 1)
    assert.equal(common.stderr, '')
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
    const result = setupAgent(f, '--lang', 'en', '--agent', 'codex,cursor', '--json')
    assertSetupStatus(result, 0)
    const preview = JSON.parse(result.stdout)
    assert.deepEqual(preview.targets, ['codex', 'cursor'])
    assert.equal(preview.applied, false)
    assert.equal(preview.plans.length, 2)
    assert.ok(preview.plans[1].conflicts.includes(cursor))
    assert.deepEqual(preview.plans[0].conflicts, [])
    assert.ok(preview.plans[0].changes.some(change => ['create', 'update'].includes(change.action)))
    assert.equal(result.stderr, '')
    assert.equal(existsSync(f.root), false)
  })
  for (const [agent, relative, original] of [
    ['cursor', '.cursor/hooks.json', '{"hooks":[]}'],
    ['cursor', '.cursor/hooks.json', '{"hooks":{"stop":"x"}}'],
    ['openclaw', '.openclaw/openclaw.json', '{"plugins":{"load":{"paths":"x"}}}'],
  ]) await fixture(f => {
    const config = join(f.home, relative)
    f.save(config, original)
    const result = setupAgent(f, '--lang', 'en', '--agent', `codex,${agent}`, '--json')
    assertSetupStatus(result, 0)
    const preview = JSON.parse(result.stdout)
    assert.deepEqual(preview.targets, ['codex', agent])
    assert.equal(preview.applied, false)
    assert.equal(preview.plans.length, 2)
    assert.deepEqual(preview.plans[1].conflicts, [config])
    assert.deepEqual(preview.plans[0].conflicts, [])
    assert.ok(preview.plans[0].changes.some(change => ['create', 'update'].includes(change.action)))
    assert.equal(result.stderr, '')
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
  const doctor = f.command(['--codex-doctor', '--home', f.home, '--json'])
  assert.equal(JSON.parse(doctor.stdout).ready, true, doctor.stdout)
  assert.equal(JSON.parse(doctor.stdout).hooksTrusted, false)
}))

test('on Windows the generated Codex hook command runs through PowerShell and through cmd, with spaces in the worker and progress paths', { skip: process.platform !== 'win32' && 'Windows shells only' }, () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  assert.match(f.progress, / /, 'the fixture home has a space')
  const command = JSON.parse(readFileSync(f.hooks)).hooks.UserPromptSubmit[0].hooks[0].command
  for (const [shell, fire] of [['PowerShell', firePowerShell], ['cmd', fireCommand]]) {
    const turn = `windows-${shell.toLowerCase()}-turn`
    const result = await fire(f, command, JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: turn }))
    assert.equal(result.status, 0, `${shell}: ${hookFailure(result)}`)
    assert.equal(turnOf(f), turn, shell)
    assert.match(readFileSync(f.progress, 'utf8'), /state=working/, shell)
  }
}))

test('on Windows a Codex hook command for a Node path with no quote-free name runs from PowerShell and cmd through an encoded launch', { skip: process.platform !== 'win32' && 'Windows shells only' }, () => fixture(async f => {
  const { hookCommandArgs, windowsHookCommand } = await importTs('../hooks/local-agents.ts')
  assert.equal(f.install('--apply').status, 0)
  const argv = hookCommandArgs(process.execPath, f.home, 'codex', join(f.root, 'agent-board-hook.mjs'), f.progress, 'UserPromptSubmit')
  const command = windowsHookCommand(argv, value => `"${value}"`, undefined)
  assert.match(command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/]+=*$/)
  // The launch hands on its own start time, as the Antigravity one does (#625).
  assert.match(launchOf(command), /' --hook-started \(\[DateTimeOffset\]::new\(\[Diagnostics\.Process\]::GetCurrentProcess\(\)\.StartTime\)\.ToUnixTimeMilliseconds\(\)\); exit \$LASTEXITCODE$/)
  for (const [shell, fire] of [['PowerShell', firePowerShell], ['cmd', fireCommand]]) {
    const turn = `encoded-${shell.toLowerCase()}-turn`
    const result = await fire(f, command, JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: turn }))
    assert.equal(result.status, 0, `${shell}: ${hookFailure(result)}`)
    assert.equal(turnOf(f), turn, shell)
  }
  assert.throws(() => windowsHookCommand(argv, value => `"${value}"`, 'C:\\Program Files\\nodejs\\node.exe'), /UNSAFE_HOOK_EXECUTABLE/)
}))

test('on Windows a Codex hook command whose paths hold curly quotes runs from PowerShell and cmd', { skip: process.platform !== 'win32' && 'Windows shells only' }, () => fixture(async f => {
  const { hookCommandArgs, windowsHookCommand } = await importTs('../hooks/local-agents.ts')
  assert.equal(f.install('--apply').status, 0)
  const safeNode = /^[A-Za-z]:[\\/][A-Za-z0-9_.~\\/-]+\.exe$/i.test(process.execPath) ? process.execPath : 'C:\\Windows\\node.exe'
  // PowerShell reads ’ as a single quote and ” as a double quote.
  for (const [mark, node] of [['\u2019', undefined], ['\u201D', safeNode]]) {
    const folder = join(f.home, `it${mark}s`)
    mkdirSync(folder)
    const argv = hookCommandArgs(process.execPath, f.home, 'codex', join(f.root, 'agent-board-hook.mjs'), join(folder, 'progress.md'), 'UserPromptSubmit')
    const command = windowsHookCommand(argv, value => `"${value}"`, node)
    assert.match(command, /^powershell\.exe .* -EncodedCommand /, mark)
    for (const [shell, fire] of [['PowerShell', firePowerShell], ['cmd', fireCommand]]) {
      const turn = `quote-${mark.charCodeAt(0).toString(16)}-${shell.toLowerCase()}-turn`
      const result = await fire(f, command, JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: turn }))
      assert.equal(result.status, 0, `${shell}: ${hookFailure(result)}`)
      assert.equal(turnOf(f), turn, `${shell} ${mark}`)
    }
  }
}))

test('sharing the encoded launch with Codex leaves the Antigravity command the same bytes', async () => {
  const { antigravityCommand, hookCommandArgs } = await importTs('../hooks/local-agents.ts')
  const quote = value => `"${value}"`
  const argv = hookCommandArgs('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Ann O\'Neil', 'antigravity', 'C:\\Users\\Ann O\'Neil\\.agent-board\\agent-board-hook.mjs', 'C:\\Users\\Ann O\'Neil\\.agent-board\\progress.md', 'SessionStart', 'working')
  // What 0.24.1 wrote, spelled out here so a change to the shared launch shows.
  const single = value => "'" + value.split("'").join("''") + "'"
  const launch = '& ' + argv.map(single).join(' ') + ' --hook-started ([DateTimeOffset]::new([Diagnostics.Process]::GetCurrentProcess().StartTime).ToUnixTimeMilliseconds()); exit $LASTEXITCODE'
  assert.equal(antigravityCommand(argv, true, quote, undefined), `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(launch, 'utf16le').toString('base64')}`)
  assert.equal(antigravityCommand(argv, false, quote, undefined), argv.map(quote).join(' '))
})

test('on Windows setup keeps the Node program it wrote last time when the short-name probe cannot run', { skip: process.platform !== 'win32' && 'Windows only' }, () => fixture(async f => {
  const { windowsHookNode } = await importTs('../scripts/windows-hook-node.ts')
  const spaced = join(f.home, 'node runtime', 'node.exe')
  mkdirSync(dirname(spaced))
  try { linkSync(process.execPath, spaced) } catch { copyFileSync(process.execPath, spaced) }
  const short = windowsHookNode(spaced)
  // A volume with 8.3 names turned off has nothing to keep.
  if (short === undefined) return
  const other = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe')
  const missing = join(f.home, 'missing', 'cmd.exe')
  const comSpec = process.env.ComSpec
  process.env.ComSpec = missing
  try {
    // Without the last install, a probe that cannot run leaves the encoded launch.
    assert.equal(windowsHookNode(spaced), undefined)
    assert.equal(windowsHookNode(spaced, [`${short} "--input-type=commonjs" "-e" "x"`]), short)
    // A program that is another file, or a command of another form, is not kept.
    assert.equal(windowsHookNode(spaced, [`${other} "--input-type=commonjs"`, 'powershell.exe -NoLogo -EncodedCommand AAAA']), undefined)
  } finally { process.env.ComSpec = comSpec }
  // Setup on that Node, then again with the probe failing: Codex keeps trusting the same commands.
  const install = env => spawnSync(spaced, [setup, '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--apply'], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const first = install(f.env)
  assert.equal(first.status, 0, first.stderr)
  const written = readFileSync(f.hooks, 'utf8')
  assert.ok(written.includes(JSON.stringify(short).slice(1, -1)), 'the first install starts Node by its short name')
  const again = install({ ...f.env, ComSpec: missing })
  assert.equal(again.status, 0, again.stderr)
  assert.equal(readFileSync(f.hooks, 'utf8'), written)
}))

test('setup replaces a Codex hook command an earlier release wrote with every word quoted, without the person removing it', () => fixture(async f => {
  const { hookCommandArgs } = await importTs('../hooks/local-agents.ts')
  assert.equal(f.install('--apply').status, 0)
  // Put back what 0.24.0 wrote: every word quoted, in hooks.json and in the install record.
  const manifestFile = join(f.root, 'install-codex.json')
  const old = text => {
    const config = JSON.parse(text)
    const groups = config.hooks ?? config.groups
    for (const [event, entries] of Object.entries(groups)) for (const entry of [entries].flat()) for (const hook of entry.hooks ?? []) {
      if (!hook.command.includes('agent-board') && !/EncodedCommand/.test(hook.command)) continue
      const args = hookCommandArgs(process.execPath, f.home, 'codex', join(f.root, 'agent-board-hook.mjs'), f.progress, event, undefined)
      hook.command = args.map(value => `"${value}"`).join(' ')
    }
    return `${JSON.stringify(config, null, 2)}\n`
  }
  writeFileSync(f.hooks, old(readFileSync(f.hooks, 'utf8')))
  writeFileSync(manifestFile, old(readFileSync(manifestFile, 'utf8')))
  const quoted = `"${process.execPath}" "--input-type=commonjs"`
  assert.ok(readFileSync(f.hooks, 'utf8').includes(JSON.stringify(quoted).slice(1, -1)))
  const again = f.install('--apply')
  assert.equal(again.status, 0, again.stderr)
  const now = readFileSync(f.hooks, 'utf8')
  if (process.platform === 'win32') assert.ok(!now.includes(JSON.stringify(quoted).slice(1, -1)), 'the quoted command is gone')
  // One group of ours per event: the old one was taken out, not left beside the new one.
  for (const [event, entries] of Object.entries(JSON.parse(now).hooks)) assert.equal(entries.filter(entry => entry.hooks.some(hook => /agent-board|EncodedCommand/.test(hook.command))).length, 1, event)
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
        const apply = instantiate(deepseekLocalPlugin(process.execPath, worker, f.progress, f.home, f.script), 'return apply')
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
    assert.ok(performance.now() - started < 11000)
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
  const at = Date.now() - 4050
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

test('a late Codex worker queues an ISO event time and recovery preserves it', t => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  holdAutomaticRecovery(f)
  const at = Date.now() - 10000
  const now = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const worker = join(f.root, 'agent-board-hook.mjs')
  const payload = { session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'late-iso-turn' }
  const result = spawnSync(process.execPath, [worker, '--hook-version', '1', '--hook-event', 'UserPromptSubmit', '--codex-event', '--agent', 'codex', '--progress-file', f.progress, '--hook-started', String(at)], {
    env: f.env, input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
  assert.equal(result.status, 0, hookFailure(result))
  const files = pendingFiles(f)
  assert.equal(files.length, 1)
  assert.match(files[0], /\.raw\.json$/)
  const queued = JSON.parse(readFileSync(join(f.root, 'pending', files[0]), 'utf8'))
  t.diagnostic(JSON.stringify({ reporter: 'node-worker', kind: queued.kind, at: queued.at, hasNow: Object.hasOwn(queued, 'now'), now: queued.now ?? null }))
  assert.equal(queued.kind, 'raw')
  assert.equal(queued.payload.session_id, session)
  assert.equal(queued.payload.turn_id, 'late-iso-turn')
  assert.equal(queued.at, at)
  assert.equal(queued.now, now)
  assert.ok(Number.isFinite(Date.parse(queued.now)))
  assert.equal(f.command(['--recover-hooks']).status, 0)
  const owner = createHash('sha256').update(`codex:${session}`).digest('hex')
  const saved = JSON.parse(readFileSync(join(f.root, 'sessions', `${owner}.json`), 'utf8'))
  assert.equal(saved.turn, 'late-iso-turn')
  assert.equal(saved.appliedAt, at)
  assert.equal(saved.updated, now)
  const text = readFileSync(f.progress, 'utf8')
  assert.equal(text.split(`<!-- auto session=${owner.slice(0, 8)} `).length - 1, 1)
  assert.equal(text.split(`<!-- /auto session=${owner.slice(0, 8)} -->`).length - 1, 1)
  assert.match(text, new RegExp(`updated=${now}`))
  assert.deepEqual(pendingFiles(f), [])
}))

test('recovery derives the original event time for legacy raw entries without now', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const at = Date.now() - 3000
  const now = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const file = join(f.root, 'pending', `${String(at).padStart(15, '0')}-legacy.raw.json`)
  f.save(file, JSON.stringify({
    version: 1, kind: 'raw', at,
    argv: ['--codex-event', '--agent', 'codex', '--progress-file', f.progress], env: {},
    payload: { session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'legacy-raw-turn' },
  }))
  assert.equal(f.command(['--recover-hooks']).status, 0)
  const owner = createHash('sha256').update(`codex:${session}`).digest('hex')
  const saved = JSON.parse(readFileSync(join(f.root, 'sessions', `${owner}.json`), 'utf8'))
  assert.equal(saved.turn, 'legacy-raw-turn')
  assert.equal(saved.appliedAt, at)
  assert.equal(saved.updated, now)
  const text = readFileSync(f.progress, 'utf8')
  assert.equal(text.split(`<!-- auto session=${owner.slice(0, 8)} `).length - 1, 1)
  assert.equal(text.split(`<!-- /auto session=${owner.slice(0, 8)} -->`).length - 1, 1)
  assert.match(text, new RegExp(`updated=${now}`))
  assert.deepEqual(pendingFiles(f), [])
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

test('two Antigravity sessions in one folder show different titles before either reports (#814)', () => fixture(async f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  // No folder reaches the board for Antigravity: its hook binds only the
  // conversation id, so both sessions arrive with the same fixture folder.
  const first = 'synthetic-first-antigravity-814'
  const second = 'synthetic-second-antigravity-814'
  const report = (conversationId, state, event) => f.command(['--agent-status', '--agent', 'antigravity', '--state', state, '--event', event], { conversationId })
  for (const conversationId of [first, second]) {
    assert.equal(report(conversationId, 'waiting', 'SessionStart').status, 0)
    assert.equal(report(conversationId, 'working', 'PreInvocation').status, 0)
  }
  const ownerOf = id => createHash('sha256').update(`antigravity:${id}`).digest('hex')
  const firstRecord = JSON.parse(readFileSync(join(f.root, 'sessions', `${ownerOf(first)}.json`), 'utf8'))
  const secondRecord = JSON.parse(readFileSync(join(f.root, 'sessions', `${ownerOf(second)}.json`), 'utf8'))
  assert.notEqual(firstRecord.title, secondRecord.title)
  // No hash in the title: a default view shows no session id, hash or file
  // path (parity checklist; dot's Question on #849). The distinction is the
  // session's start time, to the millisecond — second precision would let two
  // sessions started in the same second share a title.
  for (const [record, id] of [[firstRecord, first], [secondRecord, second]]) {
    assert.ok(!record.title.includes(ownerOf(id).slice(0, 8)), record.title)
    assert.match(record.title, / · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/, record.title)
  }
  const text = readFileSync(f.progress, 'utf8')
  assert.ok(text.includes(`### ${firstRecord.title}`), text)
  assert.ok(text.includes(`### ${secondRecord.title}`), text)
  // Both distinct titles reach the default terminal view in every language, and
  // the rendered output passes the never-shown check.
  const { parseProgress } = await importTs('../hooks/parse.ts')
  const { buildView } = await importTs('../hooks/view.ts')
  const { boardText, boardScreen, emptyBoardState } = await importTs('../hooks/board.ts')
  const { STRINGS } = await importTs('../hooks/strings.ts')
  const { LANGS } = await importTs('../hooks/i18n.ts')
  for (const lang of LANGS) {
    const s = STRINGS[lang]
    const view = buildView(parseProgress(text), [], null, Date.now(), 0, {}, s)
    for (const drawn of [boardText(view, [], s, { width: 80, isColor: false }), boardScreen(view, [], emptyBoardState, s, { width: 80, isColor: false })]) {
      assert.ok(drawn.includes(firstRecord.title), `${lang}: first title drawn`)
      assert.ok(drawn.includes(secondRecord.title), `${lang}: second title drawn`)
      assert.deepEqual(neverShown(drawn), [], lang)
    }
  }
  // An explicit report still supplies its own title: distinct only until the agent reports.
  const reported = f.command(['--codex-report', '--agent', 'antigravity', '--session', first], { title: 'Reported summary', project: 'antigravity', state: 'working', steps: ['- [~] Reported step'] })
  assert.equal(reported.status, 0, reported.stderr)
  assert.equal(JSON.parse(readFileSync(join(f.root, 'sessions', `${ownerOf(first)}.json`), 'utf8')).title, 'Reported summary')
  assert.equal(JSON.parse(readFileSync(join(f.root, 'sessions', `${ownerOf(second)}.json`), 'utf8')).title, secondRecord.title)
}))

test('an Antigravity session created before the distinct title still gets one on its next event (#814)', () => fixture(f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const conversationId = 'synthetic-legacy-antigravity-814'
  const report = (state, event) => f.command(['--agent-status', '--agent', 'antigravity', '--state', state, '--event', event], { conversationId })
  assert.equal(report('waiting', 'SessionStart').status, 0)
  const owner = createHash('sha256').update(`antigravity:${conversationId}`).digest('hex')
  const recordFile = join(f.root, 'sessions', `${owner}.json`)
  const record = JSON.parse(readFileSync(recordFile, 'utf8'))
  // Rewrite the record and its block heading as the pre-fix shape: the generic title.
  const before = readFileSync(f.progress, 'utf8')
  writeFileSync(recordFile, `${JSON.stringify({ ...record, title: 'Local antigravity task' }, null, 2)}\n`)
  writeFileSync(f.progress, before.replace(`### ${record.title}`, '### Local antigravity task'))
  assert.equal(report('working', 'PreInvocation').status, 0)
  const after = JSON.parse(readFileSync(recordFile, 'utf8'))
  // The re-title is a start time, not the old hash suffix: it differs from the
  // first event's title, carries no hash, and then stays put on later events.
  assert.notEqual(after.title, 'Local antigravity task')
  assert.ok(!after.title.includes(owner.slice(0, 8)), after.title)
  assert.match(after.title, / · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/, after.title)
  assert.ok(readFileSync(f.progress, 'utf8').includes(`### ${after.title}`))
  assert.equal(report('working', 'PostInvocation').status, 0)
  assert.equal(JSON.parse(readFileSync(recordFile, 'utf8')).title, after.title)
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
    const at = Date.now() - 4050
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

test('the PowerShell reporter reads a complete input before it loads any module', { skip: process.platform !== 'win32' }, () => fixture(f => {
  const modules = join(f.home, 'modules'), inbox = join(f.home, '.claude', 'progress-inbox')
  const script = join(f.home, '.claude', 'progress-report.ps1')
  const env = isolatedEnv(f.home)
  const moduleKey = Object.keys(env).find(key => key.toLowerCase() === 'psmodulepath')
  const inheritedModules = moduleKey === undefined ? '' : env[moduleKey]
  if (moduleKey !== undefined) delete env[moduleKey]
  env.PSModulePath = [modules, inheritedModules].filter(Boolean).join(delimiter)
  f.save(join(modules, 'SlowShim', 'SlowShim.psd1'), "@{ RootModule = 'SlowShim.psm1'; ModuleVersion = '1.0'; FunctionsToExport = @('New-Object') }")
  f.save(join(modules, 'SlowShim', 'SlowShim.psm1'), `[Threading.Thread]::Sleep(${HOOK_INPUT_TIMEOUT + 1000})\nfunction New-Object { Microsoft.PowerShell.Utility\\New-Object @args }\n`)
  f.save(script, reporterPs1())
  const payload = '{"session_id":"synthetic-ready-input","id":1234567890123456789}'
  const input = join(f.home, 'complete-input.txt')
  f.save(input, payload)
  const descriptor = openSync(input, 'r')
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  let result
  try {
    result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'cursor', 'turn'], {
      env, stdio: [descriptor, 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, timeout: 30000,
    })
  } finally { closeSync(descriptor) }
  assert.equal(result.error, undefined, hookFailure(result))
  assert.equal(result.status, 0, hookFailure(result))
  assert.equal(result.stdout.trim(), '{}')
  const delivered = existsSync(inbox) ? readdirSync(inbox).filter(name => name.endsWith('.json')) : []
  assert.equal(delivered.length, 1, `${hookFailure(result)}; hookLog=${hookLog(f)}`)
  assert.equal(readFileSync(join(inbox, delivered[0]), 'utf8'), payload)
  assert.doesNotMatch(hookLog(f), /INPUT_TIMEOUT/)
}))

test('the PowerShell reporter calls no cmdlet between its input clock and the payload', () => {
  const source = reporterPs1()
  const start = source.indexOf('$clock = [Diagnostics.Stopwatch]::StartNew()')
  const end = source.indexOf('$Payload = [Text.Encoding]::UTF8.GetString', start)
  assert.ok(start >= 0 && end > start, 'the reporter has an input clock and payload decode')
  assert.doesNotMatch(source.slice(start, end), /\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/)
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

test('PowerShell reporter retries a scratch file released after its first failed removal', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  const inbox = join(f.root, 'progress-inbox'), script = join(f.root, 'progress-report.ps1')
  const held = join(inbox, 'synthetic-held.tmp'), probe = join(f.home, 'retry-started'), release = join(f.home, 'retry-release')
  const old = new Date(Date.now() - 300000)
  f.save(held, 'held'); utimesSync(held, old, old)
  const anchor = '          Start-Sleep -Milliseconds 25'
  const source = reporterPs1()
  assert.equal(source.split(anchor).length, 2)
  // Hold the first retry at a handshake, so scheduler pauses cannot release the lock too late.
  f.save(script, source.replace(anchor, `          [IO.File]::WriteAllText($env:SWEEP_RETRY_STARTED, 'ready')\n          while (-not [IO.File]::Exists($env:SWEEP_RETRY_RELEASED)) { Start-Sleep -Milliseconds 5 }\n${anchor}`))
  let lock = openSync(held, 0x10000000)
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'codex', 'turn'], {
    env: { ...f.env, SWEEP_RETRY_STARTED: probe, SWEEP_RETRY_RELEASED: release }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = '', error
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.on('error', failure => { error = failure })
  child.stdin.on('error', failure => { error = failure })
  const closed = new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })))
  const timer = setTimeout(() => child.kill(), 30000)
  try {
    child.stdin.end(JSON.stringify({ session_id: 'synthetic-retry-sweep' }))
    const deadline = Date.now() + 25000
    while (!existsSync(probe) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(existsSync(probe), `the first removal did not reach its retry: ${stderr}`)
    closeSync(lock); lock = undefined
    f.save(release, 'released')
    const result = await closed
    assert.equal(error, undefined, String(error))
    assert.equal(result.status, 0, `${stdout}\n${stderr}`)
    assert.equal(existsSync(held), false)
    assert.doesNotMatch(hookLog(f), /CLEANUP_FAILED/)
  } finally {
    clearTimeout(timer)
    if (lock !== undefined) closeSync(lock)
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 10000))])
  }
}))

test('PowerShell reporter caps retry sleep across all locked scratch files', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  const inbox = join(f.root, 'progress-inbox'), script = join(f.root, 'progress-report.ps1'), sleeps = join(f.home, 'retry-sleeps')
  const old = new Date(Date.now() - 300000)
  const files = Array.from({ length: 12 }, (_, index) => join(inbox, `synthetic-${index}.tmp`))
  const locks = []
  for (const file of files) { f.save(file, 'held'); utimesSync(file, old, old) }
  const anchor = '          Start-Sleep -Milliseconds 25'
  const source = reporterPs1()
  assert.equal(source.split(anchor).length, 2)
  f.save(script, source.replace(anchor, `${anchor}\n          Add-Content -LiteralPath $env:SWEEP_RETRY_SLEEPS -Value 25`))
  let out
  try {
    for (const file of files) locks.push(openSync(file, 0x10000000))
    out = await nativeProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'codex', 'turn'],
      { ...f.env, SWEEP_RETRY_SLEEPS: sleeps }, JSON.stringify({ session_id: 'synthetic-budget-sweep' }))
  } finally {
    for (const lock of locks) closeSync(lock)
  }
  assert.equal(out.error, undefined, hookFailure(out))
  assert.equal(out.status, 0, hookFailure(out))
  const total = readFileSync(sleeps, 'utf8').trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0)
  assert.ok(total > 0 && total <= 1000, `retry sleeps totaled ${total} ms`)
  for (const file of files) assert.equal(existsSync(file), true, file)
  assert.match(hookLog(f), /CLEANUP_FAILED/)
  assert.equal(readdirSync(inbox).filter(name => name.endsWith('.json')).length, 1)
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

// Only the words outside the folder paths count: a project folder named agent-board is no board request.
// The sh reporter keeps only plain ASCII values; PowerShell keeps every value.
// `kept` lists keys in the receipt's order (RECEIPT_KEYS); the POSIX check also compares the bytes.
// One test per case, so CI spreads the cases over its parts instead of one part taking about 21 s (#910).
const timedOutClassifierCases = isWindows => {
  const grok = { hookEventName: 'UserPromptSubmit' }
  return [
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
}
for (const [index, { key = 'session_id', payload, kept, isBoard = false }] of timedOutClassifierCases(process.platform === 'win32').entries()) {
  test(`a timed-out prompt classifier saves a metadata receipt that marks a board request but not a folder named agent-board, case ${index}`, () => fixture(async f => {
    const isWindows = process.platform === 'win32'
    const inbox = join(f.root, 'progress-inbox'), script = join(f.root, isWindows ? 'progress-report.ps1' : 'progress-report.sh')
    const pidFile = join(f.home, 'classifier.pid'), preload = join(f.home, 'hang-classifier.cjs')
    const exitProof = join(f.home, 'classifier-exit.json')
    f.save(script, isWindows ? observeClassifierExit(reporterPs1(), exitProof) : reporterSh(inbox))
    f.save(preload, `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`)
    const env = { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll('\\', '/'))}` }
    const args = isWindows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'cursor', 'prompt'] : [script, 'cursor', 'prompt']
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
      // On Windows the 2 s budget is shared with the reporter's own JSON work, so on a loaded runner Node can be
      // killed at the deadline before its preload writes a PID (#1080). The reporter's own record that it started
      // and ended the process is the proof there, as in the interrupted-PID test below.
      if (isWindows) assertClassifierExited(exitProof)
      else {
        assert.equal(existsSync(pidFile), true, `exercise the real classifier process, case ${index}: ${hookLog(f)}`)
        assert.equal(isReporterAlive(Number(readFileSync(pidFile, 'utf8'))), false)
      }
      isGone = true
      const files = readdirSync(inbox)
      const log = hookLog(f)
      assert.match(log, /REPORTER_TIMEOUT/)
      assert.doesNotMatch(log, /REPORTER_FAILED/)
      if (key === null) { assert.deepEqual(files, []); return }
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
  }))
}

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

// A loaded machine can kill the classifier before its own code writes anything, so the proof must not need it (#1080).
test('a classifier that never writes anything still proves its owned process exited and saves the receipt', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  const script = join(f.root, 'progress-report.ps1'), exitProof = join(f.home, 'classifier-exit.json')
  const preload = join(f.home, 'silent-classifier.cjs')
  f.save(script, observeClassifierExit(reporterPs1(), exitProof))
  f.save(preload, 'setInterval(() => {}, 1000)\n')
  const env = { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll('\\', '/'))}` }
  const out = await nativeProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'cursor', 'prompt'], env,
    JSON.stringify({ session_id: 'synthetic-silent-classifier', prompt: 'PRIVATE_RAW_PROMPT' }))
  assertClassifierExited(exitProof)
  assert.equal(out.error, undefined, hookFailure(out))
  assert.equal(out.status, 0, hookFailure(out))
  assert.equal(out.stdout.trim(), '{}')
  const inbox = join(f.root, 'progress-inbox')
  const files = readdirSync(inbox)
  assert.equal(files.length, 1)
  assert.deepEqual(JSON.parse(readFileSync(join(inbox, files[0]), 'utf8')), { session_id: 'synthetic-silent-classifier' })
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

test('the doctor and the trust step asked in another language than the install still find it installed', () => fixture(f => {
  // Gemini and OpenCode also get a board command in the install's words.
  const agents = ['codex', 'gemini', 'opencode']
  for (const agent of agents) assert.equal(f.install('--agent', agent, '--lang', 'en', '--apply').status, 0)
  const doctor = (agent, lang) => {
    const run = f.command(['--codex-doctor', '--agent', agent, '--lang', lang, '--json'])
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(run.stdout)
  }
  for (const lang of ['zh-TW', 'zh-CN']) {
    for (const agent of agents) {
      const result = doctor(agent, lang)
      assert.equal(result.installed, true, `${agent} ${lang}: ${JSON.stringify(result)}`)
      assert.equal(result.reportHook, 'installer', agent)
      assert.equal(result.problem, undefined, agent)
    }
    assert.match(f.command(['--codex-trust', '--lang', lang, '--json']).stderr, /CODEX_BINARY_REQUIRED/)
  }
  const [head, ...rest] = readFileSync(f.script, 'utf8').split('\n')
  assert.match(head, /"lang":"en"/)
  // A board script whose language alone was changed no longer matches its skill, in any language asked.
  f.save(f.script, [head.replace('"lang":"en"', '"lang":"zh-TW"'), ...rest].join('\n'))
  for (const lang of ['en', 'zh-TW']) assert.equal(doctor('codex', lang).installed, false, lang)
  assert.match(f.command(['--codex-trust', '--json']).stderr, /OWNED_CODEX_INSTALL_REQUIRED/)
}))

test('--codex-trust prints one plain line by default and the JSON only with --json', async () => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  try {
    const { codexTrustOutput } = await import('../scripts/codex-local.ts')
    const { STRINGS } = await import('../hooks/strings.ts')
    // The step names config.toml under ~, the way the setup preview names its files (#812).
    const home = resolve('synthetic home')
    const shown = join('~', '.codex', 'config.toml')
    const examples = [
      [{ changes: 6, applied: false }, STRINGS.en, `Codex: would trust the board's 6 hooks by writing their [hooks.state] entries in ${shown}. Run the same command again with --apply.`],
      [{ changes: 6, applied: true }, STRINGS.en, `Codex: trusted the board's 6 hooks; their [hooks.state] entries are in ${shown}. Start a new Codex session.`],
      [{ changes: 0, applied: false }, STRINGS.en, "Codex: the board's hooks are already trusted. Start a new Codex session."],
      [{ changes: 0, applied: true }, STRINGS.en, "Codex: the board's hooks are already trusted. Start a new Codex session."],
      [{ changes: 6, applied: false }, STRINGS['zh-TW'], `Codex：將信任看板的 6 個 hooks，在 ${shown} 寫入它們的 [hooks.state] 信任項。加上 --apply 再執行同一命令。`],
      [{ changes: 6, applied: true }, STRINGS['zh-TW'], `Codex：已信任看板的 6 個 hooks，它們的 [hooks.state] 信任項在 ${shown}。開始新的 Codex 工作階段。`],
      [{ changes: 0, applied: false }, STRINGS['zh-TW'], 'Codex：看板的 hooks 已受信任。開始新的 Codex 工作階段。'],
      [{ changes: 6, applied: false }, STRINGS['zh-CN'], `Codex：将信任看板的 6 个 hooks，在 ${shown} 中写入它们的 [hooks.state] 信任项。加上 --apply 再运行同一命令。`],
      [{ changes: 6, applied: true }, STRINGS['zh-CN'], `Codex：已信任看板的 6 个 hooks，它们的 [hooks.state] 信任项在 ${shown} 中。开始新的 Codex 会话。`],
      [{ changes: 0, applied: false }, STRINGS['zh-CN'], 'Codex：看板的 hooks 已受信任。开始新的 Codex 会话。'],
    ]
    for (const [result, strings, expected] of examples) {
      const output = codexTrustOutput({ ...result, file: join(home, '.codex', 'config.toml') }, strings, false, home)
      assert.equal(output, `${expected}\n`)
      assert.doesNotMatch(output.slice(0, -1).replace(shown, ''), /[\r\n{\\/]|sha256:/)
    }
    const result = { file: 'synthetic/config.toml', hooks: [{ hash: 'sha256:synthetic' }], changes: 6, applied: false }
    const json = codexTrustOutput(result, STRINGS.en, true)
    assert.equal(json, `${JSON.stringify(result, null, 2)}\n`)
    assert.deepEqual(JSON.parse(json), result)
  } finally { resolver.deregister() }
})

test('the installed Codex host grants only seven reviewed hashes and preserves unrelated config', { skip: !process.env.AGENT_BOARD_TEST_CODEX }, () => fixture(f => {
  const executable = process.env.AGENT_BOARD_TEST_CODEX
  f.env.CODEX_HOME = join(f.home, '.codex')
  const config = join(f.home, '.codex', 'config.toml')
  const original = '# Keep this comment\n[features]\nhooks = true\n[hooks.state.unrelated]\nenabled = false\n'
  f.save(config, original)
  f.save(f.hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }] } }))
  assert.equal(f.install('--apply').status, 0)
  const args = ['--codex-trust', '--codex-bin', executable, '--json']
  const plan = f.command(args)
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(JSON.parse(plan.stdout).changes, 7)
  assert.equal(readFileSync(config, 'utf8'), original)
  const applied = f.command([...args, '--apply'])
  assert.equal(applied.status, 0, applied.stderr)
  assert.equal(JSON.parse(applied.stdout).trusted, 7)
  const saved = readFileSync(config, 'utf8')
  assert.match(saved, /# Keep this comment/)
  assert.match(saved, /\[hooks.state.unrelated\]\nenabled = false/)
  assert.equal((saved.match(/trusted_hash/g) ?? []).length, 7)
  const again = f.command(args)
  assert.equal(again.status, 0, again.stderr)
  assert.equal(JSON.parse(again.stdout).changes, 0)
  assert.equal(JSON.parse(again.stdout).hooks.length, 7)
  const doctor = f.command(['--codex-doctor', '--codex-bin', executable, '--json'])
  assert.equal(JSON.parse(doctor.stdout).hooksTrusted, true, doctor.stderr)
  assert.equal(JSON.parse(doctor.stdout).connected, 'unverified')
}))

const mockCodexServer = f => {
  const hooksJson = join(f.home, '.codex', 'hooks.json')
  const hooksManifest = JSON.parse(readFileSync(hooksJson, 'utf8'))
  const expectedHooks = Object.entries(hooksManifest.hooks).map(([event, list]) => ({
    event: event[0].toLowerCase() + event.slice(1),
    command: list[0].hooks[0].command,
  }))

  const stateFile = join(f.home, 'mock-codex-state.json')
  writeFileSync(stateFile, JSON.stringify({ trusted: true }))

  const mockServerScript = `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { capabilities: {} } }) + '\\n');
    } else if (msg.method === 'hooks/list') {
      const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
      const expected = ${JSON.stringify(expectedHooks)};
      const hooks = expected.map((item, i) => ({
        sourcePath: ${JSON.stringify(hooksJson)},
        eventName: item.event,
        command: item.command,
        key: 'hook-' + i,
        enabled: true,
        currentHash: 'sha256:' + 'a'.repeat(64),
        trustStatus: state.trusted ? 'trusted' : 'untrusted'
      }));
      process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ hooks, errors: [] }] } }) + '\\n');
    }
  } catch {}
});
`
  return { stateFile, mockServerScript }
}

test('the Codex trust preview names the config.toml it would change and changes nothing, in every language', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const { stateFile, mockServerScript } = mockCodexServer(f)
  const executable = join(f.home, 'bin', 'codex-mock.js')
  f.save(executable, mockServerScript)
  writeFileSync(stateFile, JSON.stringify({ trusted: false }))
  const config = join(f.home, '.codex', 'config.toml')
  f.save(config, '# synthetic user settings\n')
  const shown = join('~', '.codex', 'config.toml')
  for (const [lang, words] of [['en', `by writing their [hooks.state] entries in ${shown}.`], ['zh-TW', `在 ${shown} 寫入它們的 [hooks.state] 信任項`], ['zh-CN', `在 ${shown} 中写入它们的 [hooks.state] 信任项`]]) {
    const preview = f.command(['--codex-trust', '--codex-bin', executable, '--lang', lang])
    assert.equal(preview.status, 0, preview.stderr)
    assert.ok(preview.stdout.includes(words), preview.stdout)
    assert.equal(readFileSync(config, 'utf8'), '# synthetic user settings\n')
  }
}))

test('a repeat setup preview after the hooks are trusted does not ask to trust them again', { skip: process.platform === 'win32' && 'setup finds Codex on the PATH only as a native .exe or an npm shim on Windows' }, () => fixture(f => {
  assert.equal(setupAgent(f, '--lang', 'en', '--agent', 'codex', '--apply').status, 0)
  const bin = join(f.home, 'bin')
  mkdirSync(bin, { recursive: true })
  const { stateFile, mockServerScript } = mockCodexServer(f)
  writeFileSync(join(bin, 'codex'), mockServerScript, { mode: 0o755 })
  const pathKey = Object.keys(f.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  f.env[pathKey] = [bin, f.env[pathKey]].filter(Boolean).join(delimiter)
  const trusted = setupAgent(f, '--lang', 'en', '--agent', 'codex')
  assert.equal(trusted.status, 0, trusted.stderr)
  assert.match(trusted.stdout, /^Codex: already set up/m)
  assert.doesNotMatch(trusted.stdout, /--codex-trust/)
  assert.doesNotMatch(trusted.stdout, /--serve/)
  // Codex saying no keeps the step.
  writeFileSync(stateFile, JSON.stringify({ trusted: false }))
  const untrusted = setupAgent(f, '--lang', 'en', '--agent', 'codex')
  assert.equal(untrusted.status, 0, untrusted.stderr)
  assert.match(untrusted.stdout, /--codex-trust/)
}))

test('a repeat setup preview keeps the trust step when Codex cannot be asked', () => fixture(f => {
  assert.equal(setupAgent(f, '--lang', 'en', '--agent', 'codex', '--apply').status, 0)
  const bin = join(f.home, 'synthetic bin')
  mkdirSync(bin)
  writeFileSync(join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), 'synthetic Codex', { mode: 0o755 })
  const pathKey = Object.keys(f.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  f.env[pathKey] = [bin, f.env[pathKey]].filter(Boolean).join(delimiter)
  const result = setupAgent(f, '--lang', 'en', '--agent', 'codex')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^Codex: already set up/m)
  assert.match(result.stdout, /--codex-trust/)
}))

test('a doctor that reached Codex prints a trust step that runs', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const { stateFile, mockServerScript } = mockCodexServer(f)
  const executable = join(f.home, 'bin', 'codex-mock.js')
  f.save(executable, mockServerScript)
  writeFileSync(stateFile, JSON.stringify({ trusted: false }))
  const doctor = f.command(['--codex-doctor', '--codex-bin', executable])
  assert.equal(doctor.status, 0, doctor.stderr)
  assert.ok(doctor.stdout.includes('Codex hooks are not all trusted.'), doctor.stdout)
  const step = /^Next: preview the hook trust change: (.+)$/m.exec(doctor.stdout)?.[1]
  // This home's --home holds a backslash, so the step goes through code points; read what they say.
  const decoded = step.replace(/String\.fromCodePoint\(([\d,]+)\)/g, (_, points) => String.fromCodePoint(...points.split(',').map(Number)))
  assert.ok(decoded.includes('--codex-trust'), decoded)
  assert.ok(decoded.includes(process.platform === 'win32' ? executable.replaceAll('\\', '/') : executable), decoded)
  const preview = spawnSync(step, { shell: true, cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(preview.status, 0, preview.stderr)
  assert.ok(preview.stdout.includes('would trust'), preview.stdout)
}))

test('--codex-doctor auto-discovers Codex on PATH and verifies hook trust', { skip: process.platform === 'win32' && 'Windows discovery requires native .exe' }, () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  const config = join(f.home, '.codex', 'config.toml')
  const binDir = join(f.home, 'bin')
  mkdirSync(binDir, { recursive: true })
  const mockCodex = join(binDir, 'codex')
  const { stateFile, mockServerScript } = mockCodexServer(f)
  writeFileSync(mockCodex, mockServerScript, { mode: 0o755 })

  const pathKey = Object.keys(f.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const withBinOnPath = { [pathKey]: [binDir, f.env[pathKey]].filter(Boolean).join(delimiter) }

  // Auto-discovery finds mock codex on PATH and verifies matching trust
  const discovered = f.command(['--codex-doctor', '--json'], undefined, withBinOnPath)
  assert.equal(discovered.status, 0, discovered.stderr)
  assert.equal(JSON.parse(discovered.stdout).hooksTrusted, true, discovered.stderr)
  const plainTrusted = f.command(['--codex-doctor'], undefined, withBinOnPath).stdout
  assert.ok(plainTrusted.includes('Codex hooks are trusted.'), plainTrusted)
  assert.ok(plainTrusted.includes('Next: start a new Codex session'), plainTrusted)

  // Untrusted hooks report hooksTrusted: false
  writeFileSync(stateFile, JSON.stringify({ trusted: false }))
  const untrusted = f.command(['--codex-doctor', '--json'], undefined, withBinOnPath)
  assert.equal(untrusted.status, 0, untrusted.stderr)
  assert.equal(JSON.parse(untrusted.stdout).hooksTrusted, false, untrusted.stderr)
  const plainUntrusted = f.command(['--codex-doctor'], undefined, withBinOnPath).stdout
  assert.ok(plainUntrusted.includes('Codex hooks are not all trusted.'), plainUntrusted)
  const step = /^Next: preview the hook trust change: (.+)$/m.exec(plainUntrusted)?.[1]
  assert.ok(step?.includes('--codex-bin'), plainUntrusted)
  const preview = spawnSync(step, { shell: true, cwd: f.home, env: { ...f.env, ...withBinOnPath }, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(preview.status, 0, preview.stderr)
  assert.ok(preview.stdout.includes("would trust the board's 7 hooks"), preview.stdout)
}))

test('a six-hook Codex install from before the plan hook is sent to setup by the doctor, refused by trust, and gets its seventh group from setup', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const manifestFile = join(f.root, 'install-codex.json')
  const older = JSON.parse(readFileSync(f.hooks, 'utf8'))
  delete older.hooks.PostToolUse
  f.save(f.hooks, `${JSON.stringify(older, null, 2)}\n`)
  const record = JSON.parse(readFileSync(manifestFile, 'utf8'))
  delete record.groups.PostToolUse
  delete record.foreignGroups.PostToolUse
  f.save(manifestFile, `${JSON.stringify(record, null, 2)}\n`)
  const doctor = f.command(['--codex-doctor', '--lang', 'en'])
  assert.equal(doctor.status, 0, doctor.stderr)
  const lines = doctor.stdout.split(/\r?\n/)
  assert.ok(lines.some(line => /^Missing or outdated: .*hooks\.json$/.test(line)), doctor.stdout)
  const next = lines.filter(line => line.startsWith('Next:'))
  assert.equal(next.length, 1, doctor.stdout)
  assert.match(next[0], /^Next: preview the setup repair: /)
  assert.doesNotMatch(doctor.stdout, /--codex-trust/)
  const trust = f.command(['--codex-trust', '--codex-bin', join(f.home, 'codex.exe'), '--json'])
  assert.notEqual(trust.status, 0)
  assert.match(trust.stderr, /OWNED_CODEX_INSTALL_REQUIRED/)
  assert.equal(f.install('--apply').status, 0)
  const groups = JSON.parse(readFileSync(f.hooks, 'utf8')).hooks
  assert.equal(groups.PostToolUse.length, 1)
  assert.equal(groups.PostToolUse[0].matcher, 'update_plan')
  assert.equal(Object.keys(groups).length, 7)
  assert.ok(Object.hasOwn(JSON.parse(readFileSync(manifestFile, 'utf8')).groups, 'PostToolUse'))
}))

test('--codex-doctor detects missing trusted_hash and unverified hash without --codex-bin', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  // 1. Missing config.toml: doctor reports hooksTrusted: false
  const initial = f.command(['--codex-doctor', '--json'])
  assert.equal(initial.status, 0, initial.stderr)
  assert.equal(JSON.parse(initial.stdout).hooksTrusted, false)

  // 2. config.toml without trusted_hash: doctor reports hooksTrusted: false
  const config = join(f.home, '.codex', 'config.toml')
  f.save(config, '# Keep this comment\n[features]\nhooks = true\n')
  const partial = f.command(['--codex-doctor', '--json'])
  assert.equal(JSON.parse(partial.stdout).hooksTrusted, false)

  // 3. config.toml with trusted_hash: unverified without Codex execution, reports 'unknown'
  f.save(config, '[hooks.state."session_start"]\ntrusted_hash = "sha256:1"\n')
  const unverified = f.command(['--codex-doctor', '--json'])
  assert.equal(JSON.parse(unverified.stdout).hooksTrusted, 'unknown')
  const plainUnknown = f.command(['--codex-doctor']).stdout
  assert.ok(plainUnknown.includes('Codex hook trust could not be verified.'), plainUnknown)
  assert.ok(plainUnknown.includes('Next: locate Codex'), plainUnknown)
}))

test('--codex-doctor fails when explicit --codex-bin cannot be executed', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const result = f.command(['--codex-doctor', '--codex-bin', join(f.home, 'nonexistent-codex.exe')])
  assert.notEqual(result.status, 0)
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

test('the same report from three agents gives three blocks of the same shape', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const payload = { title: 'Shared report', project: 'Synthetic project', state: 'working', steps: ['- [x] Read the task', '- [~] Check the result'] }
  const shapes = []
  for (const agent of ['codex', 'cursor', 'muse']) {
    const id = `synthetic-report-${agent}`
    const result = f.command(['--report', '--print', '--agent', agent, '--session', id], payload)
    assert.equal(result.status, 0, result.stderr)
    const text = readFileSync(f.progress, 'utf8')
    const owner = createHash('sha256').update(`${agent}:${id}`).digest('hex').slice(0, 8)
    const block = text.match(new RegExp(`<!-- auto session=${owner} [^\\n]*\\n[\\s\\S]*?<!-- /auto session=${owner} -->`))?.[0]
    assert.ok(block, `${agent} has a bound block`)
    assert.match(block, new RegExp(` agent=${agent} `))
    shapes.push(block.replace(/owner=[a-f0-9]{64}/, 'owner=OWNER').replaceAll(owner, 'OWNER').replace(`agent=${agent}`, 'agent=AGENT').replace(`source=${agent}-local`, 'source=AGENT-local').replace(`resume=${id}`, 'resume=SESSION').replace(/updated=\S+/, 'updated=TIME'))
    assert.equal(JSON.parse(result.stdout).cut, 0)
  }
  assert.equal((readFileSync(f.progress, 'utf8').match(/^<!-- auto /gm) ?? []).length, 3)
  assert.equal(new Set(shapes).size, 1)
}))

test('reports normalize list bullets, numbering and uppercase completion marks', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const steps = ['* Star', '+ Plus', '1. Number', '2) Parenthesis', '- Dash', '- [X] Uppercase', '* [x] Complete', '+ [?] Question', '3) [!] Blocked', '- [~] Current', '- [>] Running', '- [-] Cancelled']
  const result = f.command(['--report'], { title: 'List formats', state: 'working', steps })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).dropped, 0)
  const text = readFileSync(f.progress, 'utf8')
  for (const line of ['- [ ] Star', '- [ ] Plus', '- [ ] Number', '- [ ] Parenthesis', '- [ ] Dash', '- [x] Uppercase', '- [x] Complete', '- [?] Question', '- [!] Blocked', '- [~] Current', '- [>] Running', '- [-] Cancelled']) {
    assert.ok(text.includes(`${line}\n`), line)
  }
}))

test('a report with more than forty steps keeps the first forty and reports the number omitted', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const steps = Array.from({ length: 43 }, (_, index) => `- [ ] Step ${index + 1}`)
  steps[0] = `- [ ] ${'a'.repeat(130)}`
  const result = f.command(['--report'], { title: 'Long list', state: 'working', steps })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.cut, 1)
  assert.equal(output.dropped, 3)
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /^- \[ \] Step 40$/m)
  assert.doesNotMatch(text, /^- \[ \] Step (41|42|43)$/m)
}))

test('a report with more than forty steps keeps a question for the user that comes after the fortieth', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const steps = Array.from({ length: 45 }, (_, index) => `- [ ] Step ${index + 1}`)
  steps[42] = '- [?] Deploy it, OK?'
  const result = f.command(['--report'], { title: 'Long list', state: 'working', steps })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).dropped, 5)
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /^- \[\?\] Deploy it, OK\?$/m)
  assert.match(text, /^- \[ \] Step 39$/m)
  assert.doesNotMatch(text, /^- \[ \] Step (40|41|42|44|45)$/m)
}))

test('an unreadable report step names its first sixty characters and the accepted form', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const step = `Synthetic invalid step ${'z'.repeat(70)}`
  const result = f.command(['--report', '--lang', 'en'], { title: 'Invalid step', state: 'working', steps: [step] })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /INVALID_STEP/)
  assert.ok(result.stderr.includes(step.slice(0, 60)))
  assert.ok(!result.stderr.includes(step.slice(0, 61)))
  assert.ok(result.stderr.includes('- [ ] step'))
  assert.equal(readFileSync(f.progress, 'utf8'), '')
  for (const bad of ['- [z] Unknown mark', '- [ ]', 'x'.repeat(501)]) {
    const rejected = f.command(['--report', '--lang', 'en'], { title: 'Invalid step', state: 'working', steps: [bad] })
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /INVALID_STEP/)
    assert.ok(rejected.stderr.includes('- [ ] step'))
  }
  for (const [bad, expected] of [['- [z]  Keep   spacing', '- [z]  Keep   spacing'], [{ toString: null }, '{\\"toString\\":null}']]) {
    const rejected = f.command(['--report', '--lang', 'en'], { title: 'Invalid step', state: 'working', steps: [bad] })
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /INVALID_STEP/)
    assert.ok(rejected.stderr.includes(expected), rejected.stderr)
    assert.ok(rejected.stderr.includes('- [ ] step'))
  }
}))

test('done reports refuse unfinished steps even beyond the forty kept on the board', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const steps = Array.from({ length: 40 }, (_, index) => `- [X] Finished ${index + 1}`)
  const rejected = f.command(['--report'], { title: 'Not done', state: 'done', steps: [...steps, '* Pending'] })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /UNFINISHED_STEPS/)
  assert.equal(readFileSync(f.progress, 'utf8'), '')
  const accepted = f.command(['--report'], { title: 'Done', state: 'done', steps: [...steps, '* [x] Finished 41'] })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(JSON.parse(accepted.stdout).dropped, 1)
}))

test('a report step over 120 characters is cut on the board and kept in full in the journal', () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  const title = 'Synthetic title ' + 't'.repeat(130)
  const long = 'Synthetic detail ' + 's'.repeat(130)
  const exact = 'e'.repeat(120)
  const unicode = '🧪'.repeat(121)
  const result = f.command(['--codex-report'], { title, project: 'Synthetic project', state: 'working', steps: [`- [~] ${long}`, `- [ ] ${exact}`, `- [ ] ${unicode}`] })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.cut, 3)
  const text = readFileSync(f.progress, 'utf8')
  assert.ok(text.includes(`### ${title.slice(0, 119)}…\n`))
  assert.ok(text.includes(`- [~] ${long.slice(0, 119)}…\n`))
  assert.ok(text.includes(`- [ ] ${exact}\n`))
  assert.ok(text.includes(`- [ ] ${'🧪'.repeat(119)}…\n`))
  assert.ok(!text.includes(long))
  const now = new Date(output.updated)
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const journal = readFileSync(join(f.root, `progress-journal-${month}.md`), 'utf8')
  assert.ok(journal.includes(title))
  assert.ok(journal.includes(long))
  assert.ok(journal.includes(unicode))
  const { countDay } = await importTs('../hooks/journal.ts')
  assert.equal(countDay(journal, now.getTime()), 0)
  const titleOnly = f.command(['--report'], { title, state: 'working', steps: ['- [~] Short step'] })
  assert.equal(titleOnly.status, 0, titleOnly.stderr)
  assert.equal(JSON.parse(titleOnly.stdout).cut, 1)
  assert.ok(!readFileSync(join(f.root, `progress-journal-${month}.md`), 'utf8').includes('Short step'))
  const blockedProgress = join(f.root, 'blocked.md')
  f.save(blockedProgress, '## Preserve this project\n')
  mkdirSync(join(f.root, `blocked-journal-${month}.md`))
  const blocked = f.command(['--report', '--progress-file', blockedProgress], { title: 'Blocked journal', state: 'working', steps: [`- [~] ${long}`] })
  assert.notEqual(blocked.status, 0)
  assert.equal(readFileSync(blockedProgress, 'utf8'), '## Preserve this project\n')
}))

const journalOf = (f, updated) => {
  const day = new Date(updated)
  return join(f.root, `progress-journal-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}.md`)
}

test('the same long report sent again a minute later adds no journal line', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const long = 'Synthetic detail ' + 's'.repeat(130)
  const payload = { title: 'Resent plan', project: 'Synthetic project', state: 'working', steps: [`- [~] ${long}`] }
  const started = Math.floor(Date.now() / 60000) * 60000 - 600000
  const first = f.command(['--report', '--hook-started', String(started)], payload)
  assert.equal(first.status, 0, first.stderr)
  const file = journalOf(f, JSON.parse(first.stdout).updated)
  const before = readFileSync(file, 'utf8')
  assert.ok(before.includes(long))
  const again = f.command(['--report', '--hook-started', String(started + 60000)], payload)
  assert.equal(again.status, 0, again.stderr)
  assert.equal(readFileSync(file, 'utf8'), before)
}))

test('a cut title with uncut steps journals only the title, once', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const title = 'Synthetic title ' + 't'.repeat(130)
  const payload = { title, project: 'Synthetic project', state: 'working', steps: ['- [~] First short step', '- [ ] Second short step'] }
  const first = f.command(['--report'], payload)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(JSON.parse(first.stdout).cut, 1)
  const file = journalOf(f, JSON.parse(first.stdout).updated)
  const text = readFileSync(file, 'utf8')
  assert.equal(text.split(title).length - 1, 2, 'the title is the task and the step of its one line')
  assert.equal(text.split(/\r?\n/).filter(line => line.startsWith('> - ')).length, 1)
  assert.ok(!text.includes('short step'))
}))

test('a journal line written between the report read and its replace survives', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const long = 'Synthetic detail ' + 's'.repeat(130)
  const other = '- 2000-01-01 00:00 · Other project · Other task · Finished by the board'
  const result = f.command(['--report'], { title: 'Racing plan', project: 'Synthetic project', state: 'working', steps: [`- [~] ${long}`] }, { AGENT_BOARD_TEST_JOURNAL_RACE: other })
  assert.equal(result.status, 0, result.stderr)
  const text = readFileSync(journalOf(f, JSON.parse(result.stdout).updated), 'utf8')
  assert.ok(text.includes(other))
  assert.ok(text.includes(long))
}))

test('--report and --codex-report write the same block', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const payload = { title: 'Alias report', project: 'Synthetic project', state: 'waiting', steps: ['- [?] Choose the next step', '- [ ] Continue'] }
  const legacy = f.command(['--codex-report', '--print'], payload)
  assert.equal(legacy.status, 0, legacy.stderr)
  const normalize = text => text.replace(/updated=\S+/g, 'updated=TIME')
  const before = normalize(readFileSync(f.progress, 'utf8'))
  const alias = f.command(['--report', '--print'], payload)
  assert.equal(alias.status, 0, alias.stderr)
  assert.equal(normalize(readFileSync(f.progress, 'utf8')), before)
  const { updated: legacyUpdated, ...legacyOutput } = JSON.parse(legacy.stdout)
  const { updated: aliasUpdated, ...aliasOutput } = JSON.parse(alias.stdout)
  assert.deepEqual(aliasOutput, legacyOutput)
  assert.equal(aliasOutput.cut, 0)
  for (const flag of ['--report', '--codex-report']) {
    const rejected = f.command([flag, '--print'], payload, { CODEX_THREAD_ID: '' })
    assert.notEqual(rejected.status, 0)
    assert.equal(rejected.stderr.trim().split('\n').length, 1)
    assert.equal(normalize(readFileSync(f.progress, 'utf8')), before)
  }
  // These are every named agent in the board's three language tables, including report-only hosts.
  for (const agent of ['claude', 'codex', 'gemini', 'cursor', 'grok', 'muse', 'dot', 'hermes', 'openclaw', 'opencode', 'antigravity', 'deepseek']) {
    const id = `synthetic-alias-${agent}`
    for (const flag of ['--report', '--codex-report']) {
      const result = f.command([flag, '--agent', agent, '--session', id], payload)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).session, id)
    }
    const unbound = f.command(['--report', '--agent', agent], payload, { CODEX_THREAD_ID: '', AGENT_BOARD_AGENT: '', AGENT_BOARD_SESSION_ID: '' })
    assert.notEqual(unbound.status, 0)
    assert.equal(unbound.stderr.trim().split('\n').length, 1)
  }
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

// One test per agent, so CI spreads them over its parts (#910).
for (const agent of ['codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity', 'deepseek']) {
  test(`native lifecycle events retain a board-confirmed completion in session JSON instead of reopening old steps: ${agent}`, () => fixture(f => {
    assert.equal(f.install('--apply').status, 0)
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
  }))
}

// Hermes Agent runs a hook command as shlex.split(command) with no shell (#1115). This is that split for the
// quoting setup writes: double quotes, and a backslash escapes only a quote or a backslash inside them.
const shlexSplit = text => {
  const words = []
  let word = null, quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') quoted = false
      else if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) word += text[++i]
      else word += c
    } else if (c === '"') { quoted = true; word ??= '' }
    else if (/\s/.test(c)) { if (word !== null) words.push(word); word = null }
    else if (c === '\\') word = (word ?? '') + (text[++i] ?? '')
    else word = (word ?? '') + c
  }
  assert.equal(quoted, false, 'unterminated quote')
  if (word !== null) words.push(word)
  return words
}
const hermesHooksOf = text => Object.fromEntries([...text.matchAll(/^\s+(\w+):\s*\n\s+- \{command: ("(?:\\.|[^"\\])*"), timeout: (\d+)(?:, matcher: (\w+))?\}\s*$/gm)].filter(match => /agent-board-hook\.mjs/.test(match[2])).map(match => [match[1], { command: JSON.parse(match[2]), timeout: Number(match[3]), ...(match[4] === undefined ? {} : { matcher: match[4] }) }]))
const hermesEvents = ['on_session_start', 'pre_llm_call', 'post_llm_call', 'on_session_end', 'post_tool_call']
const hermesConfig = f => join(f.home, '.hermes', 'config.yaml')
const hermesAllowlist = f => join(f.home, '.hermes', 'shell-hooks-allowlist.json')
// Fire a Hermes hook the way Hermes does: its command split by shlex, no shell, the event's JSON on stdin.
const fireHermes = (f, event, payload) => {
  const hook = hermesHooksOf(readFileSync(hermesConfig(f), 'utf8'))[event]
  assert.ok(hook, event)
  const argv = shlexSplit(hook.command)
  return spawnSync(argv[0], argv.slice(1), { env: f.env, input: JSON.stringify({ hook_event_name: event, tool_name: null, tool_input: null, ...payload }), encoding: 'utf8', windowsHide: true, timeout: 30000 })
}

test('Hermes setup writes its hooks into a fresh config.yaml, quoted for shlex, trusts nothing, and a re-run changes nothing (#1115)', () => fixture(f => {
  const installed = f.install('--agent', 'hermes', '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const text = readFileSync(hermesConfig(f), 'utf8')
  assert.match(text, /^hooks:\n/)
  const hooks = hermesHooksOf(text)
  assert.deepEqual(Object.keys(hooks), hermesEvents)
  for (const event of hermesEvents) {
    assert.equal(hooks[event].timeout, 10)
    const argv = shlexSplit(hooks[event].command)
    // The program, the worker and the board file each survive the split as one word, whatever the folder holds (a space, here).
    assert.equal(argv[0], process.platform === 'win32' ? process.execPath.replaceAll('\\', '/') : process.execPath)
    assert.ok(argv[0].length > 0 && argv.includes('--hook-event') && argv[argv.indexOf('--hook-event') + 1] === event)
    const expected = event === 'post_tool_call'
      ? ['--plan-event', '--agent', 'hermes']
      : ['--agent-status', '--agent', 'hermes', '--state', event === 'pre_llm_call' ? 'working' : 'waiting']
    assert.deepEqual(argv.slice(argv.indexOf(expected[0])), [...expected, '--progress-file', process.platform === 'win32' ? f.progress.replaceAll('\\', '/') : f.progress])
    assert.equal(hooks[event].matcher, event === 'post_tool_call' ? 'todo' : undefined)
    assert.equal(argv[4], process.platform === 'win32' ? join(f.root, 'agent-board-hook.mjs').replaceAll('\\', '/') : join(f.root, 'agent-board-hook.mjs'))
    // Every word is double-quoted, so no raw backslash, dollar or backtick is left for the split to read.
    assert.doesNotMatch(hooks[event].command, /\\|\$|`/)
  }
  assert.doesNotMatch(text, /hooks_auto_accept|accept/i)
  assert.equal(existsSync(hermesAllowlist(f)), false)
  const manifest = JSON.parse(readFileSync(join(f.root, 'install-hermes.json'), 'utf8'))
  assert.ok(manifest.files[join(f.home, '.hermes', 'skills', 'agent-board', 'SKILL.md')])
  assert.deepEqual(Object.keys(manifest.groups.hooks), hermesEvents)
  assert.equal(manifest.config, hermesConfig(f))
  const again = f.install('--agent', 'hermes', '--apply')
  assert.equal(again.status, 0, again.stderr)
  assert.deepEqual(JSON.parse(again.stdout).changes, [])
  assert.equal(readFileSync(hermesConfig(f), 'utf8'), text)
}))

test('Hermes setup keeps a config.yaml with other keys and other hooks, and removal takes out only its own (#1115)', () => fixture(f => {
  const original = [
    'model: synthetic/model',
    'hooks_auto_accept: false',
    'hooks:',
    '  pre_tool_call:',
    '    - {command: "my-guard.sh", timeout: 5}',
    '  post_tool_call:',
    '    - {command: "my-todo.sh", matcher: terminal, timeout: 5}',
    '  on_session_start:',
    '    - command: "my-start.sh"',
    '      timeout: 3',
    'display:',
    '  skin: plain',
    '',
  ].join('\n')
  f.save(hermesConfig(f), original)
  const installed = f.install('--agent', 'hermes', '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const text = readFileSync(hermesConfig(f), 'utf8')
  for (const line of original.split('\n').filter(Boolean)) assert.ok(text.split('\n').includes(line), line)
  assert.deepEqual(Object.keys(hermesHooksOf(text)).sort(), [...hermesEvents].sort())
  // The person's own on_session_start entry still sits under that event, with ours beside it.
  const start = text.slice(text.indexOf('  on_session_start:'), text.indexOf('display:'))
  assert.match(start, /my-start\.sh/)
  assert.match(start, /agent-board-hook\.mjs/)
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  assert.equal(readFileSync(hermesConfig(f), 'utf8'), text)
  const removed = remove774(f, 'hermes')
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(readFileSync(hermesConfig(f), 'utf8'), original)
  assert.equal(existsSync(join(f.root, 'install-hermes.json')), false)
}))

test('Hermes setup keeps a rewritten todo matcher and repairs one changed away from todo', () => fixture(f => {
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  const path = hermesConfig(f)
  const text = readFileSync(path, 'utf8')
  const hook = hermesHooksOf(text).post_tool_call
  assert.equal(hook.matcher, 'todo')
  const flow = `    - {command: ${JSON.stringify(hook.command)}, timeout: ${hook.timeout}, matcher: todo}`
  const block = `    - command: ${JSON.stringify(hook.command)}\n      timeout: ${hook.timeout}\n      matcher: todo`
  assert.ok(text.includes(flow))
  const rewritten = text.replace(flow, block)
  f.save(path, rewritten)
  const again = f.install('--agent', 'hermes', '--apply')
  assert.equal(again.status, 0, again.stderr)
  assert.deepEqual(JSON.parse(again.stdout).changes, [])
  assert.equal(readFileSync(path, 'utf8'), rewritten)
  f.save(path, rewritten.replace('matcher: todo', 'matcher: shell'))
  const repaired = f.install('--agent', 'hermes', '--apply')
  assert.equal(repaired.status, 0, repaired.stderr)
  assert.equal(hermesHooksOf(readFileSync(path, 'utf8')).post_tool_call.matcher, 'todo')
}))

test('Hermes install, refresh and removal keep foreign hooks with the board worker name in their commands', () => fixture(f => {
  const config = hermesConfig(f)
  const foreign = [
    '    - {command: "node ./tools/example-agent-board-hook.mjs", timeout: 5}',
    '    - command: "node ./custom/agent-board-hook.mjs"',
    '      matcher: terminal',
    '      timeout: 6',
    '    - command: node ./tools/plain-agent-board-hook.mjs # personal hook',
    '      timeout: 7',
    '    - command: node ./tools/folded-agent-board-hook.mjs',
    '        --personal',
    '      timeout: 9',
    '    - {command: node ./tools/flow-agent-board-hook.mjs, timeout: 8}',
  ]
  const original = ['model: synthetic/model', 'hooks:', '  pre_tool_call:', foreign[0],
    '  post_tool_call:', ...foreign.slice(1), 'display:', '  skin: plain', ''].join('\n')
  f.save(config, original)
  const install = () => {
    const result = f.install('--agent', 'hermes', '--apply')
    assert.equal(result.status, 0, result.stderr)
    const text = readFileSync(config, 'utf8')
    for (const line of foreign) assert.ok(text.split('\n').includes(line), line)
    return text
  }
  const installed = install()
  const hook = hermesHooksOf(installed).post_tool_call
  assert.equal(hook.matcher, 'todo')
  const flow = `    - {command: ${JSON.stringify(hook.command)}, timeout: ${hook.timeout}, matcher: todo}`
  assert.ok(installed.includes(flow))
  const copied = `    - {command: ${JSON.stringify(hook.command)}, timeout: 5}`
  const addCopy = text => text.replace('  pre_tool_call:\n', `  pre_tool_call:\n${copied}\n`)
  // A dumper may write the recorded command as a folded, single-quoted block entry.
  const folded = hook.command.replaceAll("'", "''").replace(' "--progress-file"', '\n        "--progress-file"')
  assert.notEqual(folded, hook.command)
  const stale = `    - command: '${folded}'\n      timeout: 3\n      matcher: shell`
  f.save(config, addCopy(installed).replace(flow, stale))
  assert.equal(install(), addCopy(installed))
  const removed = remove774(f, 'hermes')
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(readFileSync(config, 'utf8'), addCopy(original))
}))

test('Hermes removal preserves a foreign bare-dash list item after a recorded hook', () => fixture(f => {
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  const config = hermesConfig(f)
  const text = readFileSync(config, 'utf8')
  const event = hermesHooksOf(text).post_tool_call
  const line = `    - {command: ${JSON.stringify(event.command)}, timeout: ${event.timeout}, matcher: todo}`
  assert.ok(text.includes(line))
  const sibling = '    -\n      command: "node ./tools/personal-agent-board-hook.mjs"\n      timeout: 5'
  f.save(config, text.replace(line, `${line}\n${sibling}`))
  const removed = remove774(f, 'hermes')
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(readFileSync(config, 'utf8'), `hooks:\n  post_tool_call:\n${sibling}\n`)
}))

test('Hermes refresh and removal recognize a recorded Unicode path after YAML escaping', () => fixture(f => {
  const data = join(f.home, 'caf\u00e9-\u{1f600}')
  const install = () => f.install('--agent', 'hermes', '--data-dir', data, '--apply')
  const remove = () => remove774({ ...f, script: join(data, 'agent-board.mjs') }, 'hermes', true, ['--data-dir', data])
  const installed = install()
  assert.equal(installed.status, 0, installed.stderr)
  const config = hermesConfig(f)
  const text = readFileSync(config, 'utf8')
  const event = hermesHooksOf(text).post_tool_call
  const command = JSON.stringify(event.command)
  const escaped = command.replaceAll('\u00e9', '\\xE9').replaceAll('\u{1f600}', '\\U0001F600')
  assert.ok(escaped.includes('caf\\xE9-\\U0001F600'), 'the installed command uses the Unicode data path')
  const line = `    - {command: ${command}, timeout: ${event.timeout}, matcher: todo}`
  assert.ok(text.includes(line))
  const foreign = '    - {command: "node ./tools/caf\\xE9-\\U0001F600-agent-board-hook.mjs", timeout: 5}'
  const formatted = `    - command: ${escaped}\n      timeout: ${event.timeout}\n      matcher: todo\n${foreign}`
  const rewritten = text.replace(line, formatted)
  f.save(config, rewritten)
  const same = install()
  assert.equal(same.status, 0, same.stderr)
  assert.deepEqual(JSON.parse(same.stdout).changes, [])
  assert.equal(readFileSync(config, 'utf8'), rewritten)

  const record = join(data, 'install-hermes.json')
  const before = readFileSync(record, 'utf8')
  for (const bad of ['\\caf', '\\U00110000caf']) {
    const broken = rewritten.replace(escaped, escaped.replaceAll('caf', bad))
    assert.notEqual(broken, rewritten)
    f.save(config, broken)
    assert.notEqual(remove().status, 0, 'an invalid escape must not match the recorded command')
    assert.equal(readFileSync(config, 'utf8'), broken)
    assert.equal(readFileSync(record, 'utf8'), before)
  }

  f.save(config, rewritten)
  const removed = remove()
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(readFileSync(config, 'utf8'), `hooks:\n  post_tool_call:\n${foreign}\n`)
  assert.equal(existsSync(record), false)
}))

test('Hermes removal refuses ambiguous recorded commands and duplicate YAML command keys', () => fixture(f => {
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  const config = hermesConfig(f)
  const text = readFileSync(config, 'utf8')
  const event = hermesHooksOf(text).post_tool_call
  const line = `    - {command: ${JSON.stringify(event.command)}, timeout: ${event.timeout}, matcher: todo}`
  assert.ok(text.includes(line))
  const duplicate = `${line}\n${line}`
  const quoted = `    - command: ${JSON.stringify(event.command)}\n      "command": "node ./tools/foreign.mjs"\n      timeout: 5`
  for (const replacement of [duplicate, quoted]) {
    const ambiguous = text.replace(line, replacement)
    f.save(config, ambiguous)
    const removed = remove774(f, 'hermes')
    assert.notEqual(removed.status, 0)
    assert.equal(readFileSync(config, 'utf8'), ambiguous)
    assert.ok(existsSync(join(f.root, 'install-hermes.json')))
  }
}))

test('Hermes leaves the file intact when a foreign hook uses a recorded hook YAML anchor', () => fixture(f => {
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  const config = hermesConfig(f)
  const text = readFileSync(config, 'utf8')
  const event = hermesHooksOf(text).post_tool_call
  const line = `    - {command: ${JSON.stringify(event.command)}, timeout: ${event.timeout}, matcher: todo}`
  assert.ok(text.includes(line))
  const shared = text.replace(line, [
    '    -',
    `      command: ${JSON.stringify(event.command)}`,
    '      timeout: &shared_timeout 10',
    '      matcher: todo',
    '    - command: "node ./tools/foreign.mjs"',
    '      timeout: *shared_timeout',
  ].join('\n'))
  const command = JSON.stringify(event.command)
  const escapedCommand = command.replace('agent-board-hook.mjs', '\\u0061gent-board-hook.mjs')
  assert.notEqual(escapedCommand, command)
  assert.equal(JSON.parse(escapedCommand), event.command)
  const escaped = shared.replace(`      command: ${command}`, `      command: ${escapedCommand}`)
  assert.notEqual(escaped, shared)
  // YAML also accepts hexadecimal escapes that the JSON scalar reader cannot decode.
  const opaque = escaped.replace('\\u0061gent-board-hook.mjs', '\\x61gent-board-hook.mjs')
  assert.notEqual(opaque, escaped)
  const duplicate = opaque.replace('  post_tool_call:\n', `  post_tool_call:\n${line}\n`)
  assert.notEqual(duplicate, opaque)
  for (const variant of [shared, escaped, opaque, duplicate]) {
    f.save(config, variant)
    const removed = remove774(f, 'hermes')
    assert.notEqual(removed.status, 0, 'leave a recorded YAML command with a shared anchor intact')
    assert.equal(readFileSync(config, 'utf8'), variant)
    assert.ok(existsSync(join(f.root, 'install-hermes.json')))
  }
}))

test('Hermes setup leaves a config.yaml it cannot merge into byte for byte and reports a conflict (#1115)', () => fixture(f => {
  for (const original of ['hooks: {pre_tool_call: [{command: "mine.sh"}]}\nmodel: x\n', '- not\n- a mapping\n', 'hooks:\n  on_session_start: [{command: "mine.sh"}]\n']) {
    f.save(hermesConfig(f), original)
    const preview = f.install('--agent', 'hermes')
    assert.equal(preview.status, 0, preview.stderr)
    assert.deepEqual(JSON.parse(preview.stdout).conflicts, [hermesConfig(f)], original)
    const applied = f.install('--agent', 'hermes', '--apply')
    assert.notEqual(applied.status, 0)
    assert.equal(readFileSync(hermesConfig(f), 'utf8'), original)
    assert.equal(existsSync(join(f.root, 'install-hermes.json')), false)
  }
}))

test('Hermes hook events open a session block with its folder, show a closing question as a card, and idle keeps it (#1115)', () => fixture(f => {
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  const id = '20261107_101010_ab12cd'
  const project = join(f.home, 'a project')
  mkdirSync(project)
  const fire = (event, extra) => {
    const result = fireHermes(f, event, { session_id: id, cwd: project, extra })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
  }
  fire('on_session_start', { model: 'synthetic', platform: 'cli' })
  const opened = readFileSync(f.progress, 'utf8')
  assert.match(opened, /^## hermes$/m)
  assert.match(opened, new RegExp(`state=waiting .*resume=${id}`))
  assert.doesNotMatch(opened, /- \[\?\]/)
  const record = JSON.parse(readFileSync(join(f.root, 'sessions', `${createHash('sha256').update(`hermes:${id}`).digest('hex')}.json`), 'utf8'))
  assert.equal(record.folderDigest, createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex'))
  const secret = 'DO-NOT-STORE-THIS-PRIVATE-TEXT'
  fire('post_llm_call', { user_message: secret, assistant_response: 'I built the page.\n\nBlue or green?', conversation_history: [{ role: 'user', content: secret }] })
  const asked = readFileSync(f.progress, 'utf8')
  assert.match(asked, /- \[\?\] Blue or green\?/)
  assert.ok(!asked.includes(secret) && !JSON.stringify(record).includes(secret))
  fire('on_session_end', { completed: true, interrupted: false })
  const idle = readFileSync(f.progress, 'utf8')
  assert.match(idle, /- \[\?\] Blue or green\?/)
  assert.match(idle, /state=waiting/)
  // A reply that asks nothing opens no card for a new session.
  const other = fireHermes(f, 'post_llm_call', { session_id: '20261107_111111_ef34ab', cwd: project, extra: { assistant_response: 'Done.' } })
  assert.equal(other.status, 0, other.stderr)
  assert.equal((readFileSync(f.progress, 'utf8').match(/- \[\?\]/g) ?? []).length, 1)
  // The hook files its events under the session Hermes names, so a report from inside that session binds to it.
  const reported = f.command(['--codex-report', '--agent', 'hermes'], { title: 'Page', state: 'working', steps: ['- [x] Built the page', '- [~] Asking about colour'] }, { HERMES_SESSION_ID: id, CODEX_THREAD_ID: '', AGENT_BOARD_AGENT: '', AGENT_BOARD_SESSION_ID: '' })
  assert.equal(reported.status, 0, reported.stderr)
  assert.equal(JSON.parse(reported.stdout).block, createHash('sha256').update(`hermes:${id}`).digest('hex').slice(0, 8))
  assert.match(readFileSync(f.progress, 'utf8'), /- \[~\] Asking about colour/)
  // With no Hermes session id and no one session in this folder, a report is refused instead of guessed.
  const unbound = f.command(['--codex-report', '--agent', 'hermes'], { title: 'Page', state: 'working', steps: ['- [~] Step'] }, { HERMES_SESSION_ID: '', CODEX_THREAD_ID: '', AGENT_BOARD_AGENT: '', AGENT_BOARD_SESSION_ID: '' })
  assert.notEqual(unbound.status, 0)
}))

test('Hermes trust is only what the person asks for: the board\'s exact commands, others kept, removed with the hooks (#1115)', () => fixture(f => {
  assert.equal(f.install('--agent', 'codex', '--apply').status, 0)
  // Without an owned Hermes install there is nothing to trust.
  assert.notEqual(f.command(['--hermes-trust', '--apply']).status, 0)
  assert.equal(existsSync(hermesAllowlist(f)), false)
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  const doctor = () => JSON.parse(f.command(['--codex-doctor', '--agent', 'hermes', '--json']).stdout)
  assert.equal(doctor().hooksTrusted, false)
  const preview = f.command(['--hermes-trust', '--json'])
  assert.equal(preview.status, 0, preview.stderr)
  assert.deepEqual(JSON.parse(preview.stdout).entries.map(entry => [entry.event, entry.trusted]), hermesEvents.map(event => [event, false]))
  assert.equal(existsSync(hermesAllowlist(f)), false)
  // A non-ASCII command: Hermes reads this file in the system code page, so it must stay ASCII.
  const foreign = { approvals: [{ approved_at: '2026-01-01T00:00:00Z', command: 'C:/使用者/my-guard.sh', event: 'pre_tool_call', script_mtime_at_approval: null }] }
  const isAscii = () => [...readFileSync(hermesAllowlist(f))].every(byte => byte < 0x80)
  f.save(hermesAllowlist(f), JSON.stringify(foreign, null, 2))
  const applied = f.command(['--hermes-trust', '--apply', '--json'])
  assert.equal(applied.status, 0, applied.stderr)
  const approvals = JSON.parse(readFileSync(hermesAllowlist(f), 'utf8')).approvals
  const hooks = hermesHooksOf(readFileSync(hermesConfig(f), 'utf8'))
  assert.deepEqual(approvals[0], foreign.approvals[0])
  assert.ok(isAscii(), 'the trust file stays ASCII after --apply')
  assert.deepEqual(approvals.slice(1).map(entry => [entry.event, entry.command]), hermesEvents.map(event => [event, hooks[event].command]))
  assert.equal(doctor().hooksTrusted, true)
  assert.doesNotMatch(readFileSync(hermesConfig(f), 'utf8'), /accept/i)
  const before = readFileSync(hermesAllowlist(f), 'utf8')
  assert.equal(f.command(['--hermes-trust', '--apply', '--json']).status, 0)
  assert.equal(readFileSync(hermesAllowlist(f), 'utf8'), before)
  const removed = remove774(f, 'hermes')
  assert.equal(removed.status, 0, removed.stderr)
  assert.deepEqual(JSON.parse(readFileSync(hermesAllowlist(f), 'utf8')), foreign)
  assert.ok(isAscii(), 'the trust file stays ASCII after removal')
}))

test('a Hermes upgrade previews trust for the new todo hook without disturbing old approvals', () => fixture(f => {
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  assert.equal(f.command(['--hermes-trust', '--apply', '--json']).status, 0)
  const path = hermesConfig(f)
  const text = readFileSync(path, 'utf8')
  const hook = hermesHooksOf(text).post_tool_call
  const event = `  post_tool_call:\n    - {command: ${JSON.stringify(hook.command)}, timeout: ${hook.timeout}, matcher: todo}\n`
  assert.ok(text.includes(event))
  f.save(path, text.replace(event, ''))
  const manifestFile = join(f.root, 'install-hermes.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  delete manifest.groups.hooks.post_tool_call
  f.save(manifestFile, JSON.stringify(manifest, null, 2))
  const approvals = JSON.parse(readFileSync(hermesAllowlist(f), 'utf8'))
  approvals.approvals = approvals.approvals.filter(one => one.event !== 'post_tool_call')
  f.save(hermesAllowlist(f), JSON.stringify(approvals, null, 2))
  const preview = f.install('--agent', 'hermes')
  assert.equal(preview.status, 0, preview.stderr)
  assert.ok(JSON.parse(preview.stdout).changes.some(change => change.file === path))
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  const trust = f.command(['--hermes-trust', '--json'])
  assert.equal(trust.status, 0, trust.stderr)
  assert.deepEqual(JSON.parse(trust.stdout).entries.map(one => [one.event, one.trusted]), hermesEvents.map(event => [event, event !== 'post_tool_call']))
  assert.deepEqual(JSON.parse(readFileSync(hermesAllowlist(f), 'utf8')), approvals)
  assert.equal(f.command(['--hermes-trust', '--apply', '--json']).status, 0)
  assert.equal(JSON.parse(f.command(['--codex-doctor', '--agent', 'hermes', '--json']).stdout).hooksTrusted, true)
}))

test('Hermes pre_llm_call marks the session working, prints nothing for Hermes to inject, and closes an answered question (#1115)', () => fixture(f => {
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  const id = '20261107_121212_cd56ef'
  const project = join(f.home, 'project')
  mkdirSync(project)
  assert.equal(fireHermes(f, 'on_session_start', { session_id: id, cwd: project, extra: {} }).status, 0)
  const asked = fireHermes(f, 'post_llm_call', { session_id: id, cwd: project, extra: { assistant_response: 'Built it.\n\nBlue or green?' } })
  assert.equal(asked.status, 0, asked.stderr)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Blue or green\?/)
  // Hermes reads this hook's stdout as context to put in front of the model, so it must stay empty.
  const next = fireHermes(f, 'pre_llm_call', { session_id: id, cwd: project, extra: { user_message: 'green', is_first_turn: false } })
  assert.equal(next.status, 0, next.stderr)
  assert.equal(next.stdout, '')
  assert.equal(next.stderr, '')
  const working = readFileSync(f.progress, 'utf8')
  assert.match(working, /state=working/)
  assert.doesNotMatch(working, /- \[\?\]/)
}))

test('Hermes post_llm_call with a 3 MB conversation_history still lands its status and question, and keeps none of the history (#1115)', () => fixture(f => {
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  const project = join(f.home, 'project')
  mkdirSync(project)
  const marker = 'HISTORY-MARKER-DO-NOT-KEEP'
  const history = [{ role: 'user', content: marker + ' ' + 'h'.repeat(3 * 1024 * 1024) }]
  const big = fireHermes(f, 'post_llm_call', { session_id: '20261107_131313_aa11bb', cwd: project, extra: { assistant_response: 'Done.\n\nShip it now?', conversation_history: history } })
  assert.equal(big.status, 0, big.stderr + hookLog(f))
  assert.equal(big.stdout, '')
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /^## hermes$/m, hookLog(f))
  assert.match(text, /- \[\?\] Ship it now\?/)
  assert.equal(hookLog(f).includes('INPUT_TOO_LARGE'), false)
  // A reply that is itself cut by the 1 MB limit gives a status and no question.
  const cut = fireHermes(f, 'post_llm_call', { session_id: '20261107_141414_bb22cc', cwd: project, extra: { assistant_response: 'r'.repeat(2 * 1024 * 1024) + ' Which one?', conversation_history: history } })
  assert.equal(cut.status, 0, cut.stderr)
  const after = readFileSync(f.progress, 'utf8')
  assert.match(after, /state=waiting .*resume=20261107_141414_bb22cc/)
  assert.equal((after.match(/- \[\?\]/g) ?? []).length, 1)
  assert.ok(!after.includes('Which one?'))
  // Nothing from the history reaches the progress file, a session record or a queued copy.
  for (const name of readdirSync(f.root, { recursive: true })) {
    const path = join(f.root, name)
    if (statSync(path).isFile() && statSync(path).size < 5e6) assert.ok(!readFileSync(path, 'utf8').includes(marker), name)
  }
  assert.ok(!after.includes(marker))
}))

test('a Codex hook input past 1 MB is still refused as INPUT_TOO_LARGE, only Hermes keeps reading (#1115)', () => fixture(f => {
  f.install('--apply')
  const worker = join(f.root, 'agent-board-hook.mjs')
  spawnSync(process.execPath, [worker, '--hook-version', '1', '--hook-event', 'UserPromptSubmit', '--codex-event', '--agent', 'codex', '--progress-file', f.progress, '--hook-started', String(Date.now())], { env: f.env, input: JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-big', prompt: 'x'.repeat(2 * 1024 * 1024) }), encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.match(hookLog(f), /INPUT_TOO_LARGE/)
}))

test('the Hermes folder follows Hermes itself: HERMES_HOME, then LOCALAPPDATA on Windows, then ~/.hermes (#1115)', async () => {
  const { hermesHome } = await importTs('../hooks/hermes-home.ts')
  const posix = hermesHome('/home/ann', '/', {}, 'linux')
  assert.equal(posix, '/home/ann/.hermes')
  assert.equal(hermesHome('/home/ann', '/', { LOCALAPPDATA: '/x' }, 'darwin'), '/home/ann/.hermes')
  const own = { USERPROFILE: 'C:\\Users\\ann', LOCALAPPDATA: 'C:\\Users\\ann\\AppData\\Local' }
  assert.equal(hermesHome('C:\\Users\\ann', '\\', own, 'win32'), 'C:\\Users\\ann\\AppData\\Local\\hermes')
  // Same folder spelled differently still counts as the running account's.
  assert.equal(hermesHome('c:/users/ANN/', '\\', own, 'win32'), 'C:\\Users\\ann\\AppData\\Local\\hermes')
  // No LOCALAPPDATA: Hermes's own fallback under the profile.
  assert.equal(hermesHome('C:\\Users\\ann', '\\', { USERPROFILE: 'C:\\Users\\ann' }, 'win32'), 'C:\\Users\\ann\\AppData\\Local\\hermes')
  // Another account's folder never borrows this account's LOCALAPPDATA.
  assert.equal(hermesHome('C:\\Users\\bob', '\\', own, 'win32'), 'C:\\Users\\bob\\AppData\\Local\\hermes')
  // HERMES_HOME wins everywhere, trimmed; an empty one is ignored.
  assert.equal(hermesHome('C:\\Users\\ann', '\\', { ...own, HERMES_HOME: ' D:\\h ' }, 'win32'), 'D:\\h')
  assert.equal(hermesHome('/home/ann', '/', { HERMES_HOME: '/srv/h' }, 'linux'), '/srv/h')
  assert.equal(hermesHome('/home/ann', '/', { HERMES_HOME: '  ' }, 'linux'), '/home/ann/.hermes')
})

test('setup writes Hermes config where --hermes-dir says, ahead of HERMES_HOME (#1115)', () => fixture(f => {
  const elsewhere = join(f.home, 'elsewhere')
  const installed = spawnSync(process.execPath, [setup, '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', elsewhere, '--agent', 'hermes', '--apply'], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(installed.status, 0, installed.stderr)
  assert.ok(existsSync(join(elsewhere, 'config.yaml')))
  assert.equal(existsSync(hermesConfig(f)), false)
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

test('a Codex PermissionRequest adds a waiting approval step with a native line, and Stop closes it', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.event('PermissionRequest', 'turn-1').status, 0)
  const asked = readFileSync(f.progress, 'utf8')
  assert.match(asked, /- \[\?\] Codex (asks to run a command|請你核准指令)\n<!-- native=codex -->\n/)
  const approval = asked.match(/- \[\?\] Codex [^\n]*/)?.[0]
  assert.ok(approval)
  assert.equal(f.event('Stop', 'turn-1').status, 0)
  const stopped = readFileSync(f.progress, 'utf8')
  assert.ok(stopped.includes(approval.replace('[?]', '[x]')))
  assert.ok(!stopped.includes('native=codex'))
  assert.ok(!/- \[\?\]/.test(stopped))
}))

test('a second Codex PermissionRequest after a report reuses the approval step', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.event('PermissionRequest', 'turn-1').status, 0)
  const approval = readFileSync(f.progress, 'utf8').match(/- \[\?\] Codex [^\n]*/)?.[0]
  assert.ok(approval)
  assert.equal(f.report('working', ['- [~] Real task', '- [ ] Next task']).status, 0)
  const reported = readFileSync(f.progress, 'utf8')
  assert.ok(!reported.includes('native=codex'))
  assert.ok(reported.includes('- [~] Real task'))
  assert.ok(reported.includes(approval.replace('[?]', '[x]')))
  assert.equal(f.event('PermissionRequest', 'turn-1').status, 0)
  const again = readFileSync(f.progress, 'utf8')
  assert.match(again, /- \[ \] Next task\n- \[\?\] Codex [^\n]*\n<!-- native=codex -->\n/)
  assert.equal(again.match(/- \[[?x]\] Codex [^\n]*/g)?.length, 1)
  assert.equal(f.event('Stop', 'turn-1').status, 0)
  const stopped = readFileSync(f.progress, 'utf8')
  assert.ok(stopped.includes(approval.replace('[?]', '[x]')))
  assert.ok(!stopped.includes('native=codex'))
}))

test('bundled Codex approval identities survive reload and missed closure observations', async () => {
  const { parseProgress } = await importTs('../hooks/parse.ts')
  const { emptyQuestions, observeQuestions, resolveQuestion } = await importTs('../hooks/questions.ts')
  const { buildView } = await importTs('../hooks/view.ts')
  const { STRINGS } = await importTs('../hooks/strings.ts')
  return fixture(f => {
    f.install('--apply')
    const now = Date.now()
    const projects = () => parseProgress(readFileSync(f.progress, 'utf8'))
    assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
    assert.equal(f.event('PermissionRequest', 'turn-1').status, 0)
    const original = sessionRecord(f, session)
    const open = observeQuestions(emptyQuestions(), projects(), null, [], now, true).ledger
    const oldId = open.records.find(record => record.isUnresolved).id
    assert.equal(f.event('SessionStart', null).status, 0)
    assert.equal(sessionRecord(f, session).approvalRevision, original.approvalRevision)
    assert.equal(f.event('UserPromptSubmit', 'board-turn', { prompt: '/agent-board' }).status, 0)
    assert.equal(sessionRecord(f, session).approvalRevision, original.approvalRevision)
    assert.ok(sessionRecord(f, session).steps[original.approval].startsWith('- [?]'))
    assert.equal(f.report('working', ['- [~] Synthetic work']).status, 0)
    assert.equal(f.event('PermissionRequest', 'board-turn').status, 0)
    const replacement = sessionRecord(f, session)
    assert.equal(replacement.approvalRevision, String(BigInt(original.approvalRevision) + 1n))
    const newer = observeQuestions(open, projects(), null, [], now + 1, true).ledger
    const current = newer.records.find(record => record.isUnresolved)
    assert.notEqual(current.id, oldId)
    const delayed = resolveQuestion(newer, oldId, now + 2)
    assert.equal(delayed.records.filter(record => record.isUnresolved).length, 1)
    assert.equal(buildView(projects(), [], null, now + 2, 0, {}, STRINGS.en, [], {}, delayed).waiting.length, 1)
  })
})

test('bundled Codex full reports preserve every user step and both durable closures after reload', async () => {
  const { parseProgress } = await importTs('../hooks/parse.ts')
  const { emptyQuestions, observeQuestions } = await importTs('../hooks/questions.ts')
  const { buildView } = await importTs('../hooks/view.ts')
  const { STRINGS } = await importTs('../hooks/strings.ts')
  return fixture(f => {
    f.install('--apply')
    const now = Date.now()
    const projects = () => parseProgress(readFileSync(f.progress, 'utf8'))
    assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
    assert.equal(f.event('PermissionRequest', 'turn-1').status, 0)
    let open = observeQuestions(emptyQuestions(), projects(), null, [], now, true).ledger
    assert.equal(f.event('Stop', 'turn-1', { last_assistant_message: 'Which synthetic folder?' }).status, 0)
    open = observeQuestions(open, projects(), null, [], now + 1, true).ledger
    assert.equal(f.command(['--keys', 'j']).status, 0)
    const ledgerFile = f.progress.replace(/\.md$/, '-questions.json')
    assert.equal(JSON.parse(readFileSync(ledgerFile, 'utf8')).records.filter(record => record.isUnresolved).length, 1)
    const original = sessionRecord(f, session)
    for (const count of [39, 40, 40]) {
      const steps = Array.from({ length: count }, (_, index) => `- [ ] Synthetic task ${index}`)
      assert.equal(f.report('working', steps).status, 0)
      // Every command is a fresh process and reads the persisted report cache.
      assert.equal(f.event('SessionStart', null).status, 0)
      const saved = sessionRecord(f, session)
      assert.deepEqual(saved.steps.slice(0, count), steps)
      assert.equal(saved.steps.length, count + 2)
      assert.equal(saved.approval, count)
      assert.equal(saved.asked, count + 1)
      assert.equal(saved.approvalRevision, original.approvalRevision)
      assert.equal(saved.askedRevision, original.askedRevision)
      const parsed = projects()
      assert.equal(parsed.flatMap(project => project.tasks).flatMap(task => task.steps).filter(step => step.questionToken).length, 2)
      const closed = observeQuestions(open, parsed, null, [], now + 2, true).ledger
      assert.equal(closed.records.filter(record => record.isUnresolved).length, 0)
      assert.equal(buildView(parsed, [], null, now + 2, 0, {}, STRINGS.en, [], {}, closed).waiting.length, 0)
      assert.equal(f.command(['--keys', 'j']).status, 0)
      const ledgerFile = f.progress.replace(/\.md$/, '-questions.json')
      assert.equal(JSON.parse(readFileSync(ledgerFile, 'utf8')).records.filter(record => record.isUnresolved).length, 0)
    }
  })
})

test('a Codex report after an approval keeps the approval closed, not waiting', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.event('PermissionRequest', 'turn-1').status, 0)
  const approval = readFileSync(f.progress, 'utf8').match(/- \[\?\] Codex [^\n]*/)?.[0]
  assert.ok(approval)
  assert.equal(f.report('working', ['- [~] Real task']).status, 0)
  const reported = readFileSync(f.progress, 'utf8')
  assert.ok(reported.includes('- [~] Real task'))
  assert.ok(reported.includes(approval.replace('[?]', '[x]')))
  assert.ok(!/- \[\?\]/.test(reported))
  assert.ok(!reported.includes('native=codex'))
}))

test('a native Codex chat reply keeps the durable question open until the next work report', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.event('Stop', 'turn-1', { last_assistant_message: 'The change is ready.\n\nShall I open the pull request now?' }).status, 0)
  const asked = readFileSync(f.progress, 'utf8')
  assert.match(asked, /- \[\?\] Shall I open the pull request now\?\n/)
  assert.ok(!asked.includes('native=codex'))
  const observe = () => {
    assert.equal(f.command(['--keys', 'j']).status, 0)
    return JSON.parse(readFileSync(f.progress.replace(/\.md$/, '-questions.json'), 'utf8')).records
  }
  const first = observe().find(record => record.isUnresolved)
  assert.ok(first)
  assert.equal(f.event('UserPromptSubmit', 'turn-2', { prompt: 'SYNTHETIC-PRIVATE-CHAT' }).status, 0)
  const replied = readFileSync(f.progress, 'utf8')
  assert.match(replied, / replied=\S+Z/)
  assert.match(replied, /- \[\?\] Shall I open the pull request now\?/)
  assert.doesNotMatch(replied, /SYNTHETIC-PRIVATE-CHAT|native=codex/)
  assert.deepEqual(observe().filter(record => record.isUnresolved).map(record => record.id), [first.id])

  assert.equal(f.event('UserPromptSubmit', 'board-turn', { prompt: '/agent-board' }).status, 0)
  assert.equal(f.event('Stop', 'board-turn', { last_assistant_message: 'Here is the board.' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), / replied=\S+Z/)
  assert.deepEqual(observe().filter(record => record.isUnresolved).map(record => record.id), [first.id])

  assert.equal(f.report('working', ['- [~] Prepare the pull request']).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[x\] Shall I open the pull request now\?/)
  assert.doesNotMatch(readFileSync(f.progress, 'utf8'), / replied=/)
  assert.equal(observe().find(record => record.id === first.id)?.isUnresolved, false)
}))

test('a future queued Codex prompt cannot move the clock past a real chat reply', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit', 'asking-turn').status, 0)
  assert.equal(f.event('Stop', 'asking-turn', { last_assistant_message: 'Which folder should I use?' }).status, 0)
  const original = sessionRecord(f, session)
  const board = readFileSync(f.progress)
  const future = Date.now() + 30_000
  f.save(join(f.root, 'pending', '001.raw.json'), JSON.stringify({
    version: 1, kind: 'raw', at: future, env: {},
    argv: ['--codex-event', '--agent', 'codex', '--progress-file', f.progress],
    payload: { session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'future-turn', prompt: 'SYNTHETIC-FUTURE-CHAT' },
  }))
  f.save(join(f.root, 'pending', '002.json'), JSON.stringify({
    version: 1, mode: '--codex-event', progress: f.progress, agent: 'codex', session,
    at: original.appliedAt, now: new Date(future).toISOString(), isPrompt: false, isBoardPrompt: false,
    payload: { session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'future-display-turn' },
  }))
  const recovered = f.command(['--recover-hooks'])
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.deepEqual(JSON.parse(recovered.stdout), { recoveryVersion: 1, processed: 2, pending: 0 })
  assert.deepEqual(sessionRecord(f, session), original)
  assert.deepEqual(readFileSync(f.progress), board)
  assert.equal((hookLog(f).match(/INVALID_EVENT_TIME/g) ?? []).length, 2)
  assert.doesNotMatch(hookLog(f), /SYNTHETIC-FUTURE-CHAT/)

  const replied = f.event('UserPromptSubmit', 'real-turn')
  assert.equal(replied.status, 0, replied.stderr)
  const active = sessionRecord(f, session)
  assert.equal(active.turn, 'real-turn')
  assert.ok(active.appliedAt > original.appliedAt && active.appliedAt < future)
  assert.match(readFileSync(f.progress, 'utf8'), /replied=\S+Z/)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Which folder should I use\?/)
  assert.equal(f.event('Stop', 'real-turn', { last_assistant_message: 'I used the synthetic folder.' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[x\] Which folder should I use\?/)
  assert.doesNotMatch(readFileSync(f.progress, 'utf8'), /replied=/)
}))

test('a Codex question stays owned through a board prompt, a chat reply and the next Stop', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.event('Stop', 'turn-1', { last_assistant_message: 'Which folder should I use?' }).status, 0)
  const original = sessionRecord(f, session)
  assert.equal(f.event('UserPromptSubmit', 'turn-2', { prompt: '/agent-board' }).status, 0)
  assert.equal(sessionRecord(f, session).askedRevision, original.askedRevision)
  assert.ok(readFileSync(f.progress, 'utf8').includes('- [?] Which folder should I use?'))
  assert.equal(f.event('UserPromptSubmit', 'turn-3').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Which folder should I use\?/)
  assert.equal(f.event('Stop', 'turn-3', { last_assistant_message: 'I used the synthetic folder.' }).status, 0)
  const answered = readFileSync(f.progress, 'utf8')
  assert.ok(answered.includes('- [x] Which folder should I use?'))
  assert.ok(!/- \[\?\]/.test(answered))
  assert.ok(!answered.includes('native=codex'))
  assert.equal(sessionRecord(f, session).askedRevision, original.askedRevision)
}))

test('a Codex Stop whose last message ends on a statement adds no waiting step', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.event('Stop', 'turn-1', { last_assistant_message: 'Which folder should I use?\n\nI used the existing folder. The change is ready.' }).status, 0)
  assert.ok(!/- \[\?\]/.test(readFileSync(f.progress, 'utf8')))
}))

test('a Codex Stop keeps nothing of the last message but its closing question', () => fixture(f => {
  f.install('--apply')
  const secret = 'DO-NOT-STORE-THIS-EARLIER-SENTENCE'
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.event('Stop', 'turn-1', { last_assistant_message: `${secret} stays out.\n\nKeep the old name, or rename it?` }).status, 0)
  const digest = createHash('sha256').update(`codex:${session}`).digest('hex')
  const record = readFileSync(join(f.root, 'sessions', `${digest}.json`), 'utf8')
  assert.ok(record.includes('Keep the old name, or rename it?'))
  assert.ok(!record.includes(secret))
  assert.ok(!readFileSync(f.progress, 'utf8').includes(secret))
  assert.ok(!existsSync(join(f.root, 'pending')) || readdirSync(join(f.root, 'pending')).every(name => !readFileSync(join(f.root, 'pending', name), 'utf8').includes(secret)))
}))

test('a Codex question stays waiting through an approval and a board lookup, then settles after chat and a report', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.event('Stop', 'turn-1', { last_assistant_message: 'Which folder should I use?' }).status, 0)
  const original = sessionRecord(f, session)
  assert.equal(f.event('PermissionRequest', 'turn-1').status, 0)
  assert.equal(sessionRecord(f, session).askedRevision, original.askedRevision)
  const tokens = [...readFileSync(f.progress, 'utf8').matchAll(/<!-- question=([a-f0-9]{64}):\d+ -->/g)].map(match => match[1])
  assert.equal(new Set(tokens).size, 2)
  assert.ok(readFileSync(f.progress, 'utf8').includes('- [?] Which folder should I use?'))
  // A board-only prompt does not answer it, so the stop that ends that turn leaves it waiting too.
  assert.equal(f.event('UserPromptSubmit', 'turn-2', { prompt: '/agent-board' }).status, 0)
  assert.equal(f.event('Stop', 'turn-2', { last_assistant_message: 'Here is the board.' }).status, 0)
  const held = readFileSync(f.progress, 'utf8')
  assert.equal(held.match(/- \[[?x]\] Which folder should I use\?/g)?.length, 1)
  assert.ok(held.includes('- [?] Which folder should I use?'))
  assert.equal(f.event('UserPromptSubmit', 'turn-3').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Which folder should I use\?/)
  assert.equal(f.event('Stop', 'turn-3', { last_assistant_message: 'I used the synthetic folder.' }).status, 0)
  const answered = readFileSync(f.progress, 'utf8')
  assert.ok(answered.includes('- [x] Which folder should I use?'))
  assert.ok(!/- \[\?\]/.test(answered))
}))

test('a closing question after the model reported its steps done reopens the block with its card', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.report('done', ['- [x] Read the file', '- [x] Count its lines']).status, 0)
  assert.equal(f.event('Stop', 'turn-1', { last_assistant_message: 'It has 1 line.\n\nBlue or green?' }).status, 0)
  const board = readFileSync(f.progress, 'utf8')
  assert.match(board, /state=waiting/)
  assert.equal(board.match(/- \[\?\] Blue or green\?/g)?.length, 1)
  assert.match(board, /- \[\?\] Blue or green\?\n<!-- question=[a-f0-9]{64}:\d+ -->/)
  assert.ok(sessionRecord(f, session).events.includes('Stop:turn-1'))
}))

test('a stop with no question after a done report keeps the block done and records the stop', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.report('done', ['- [x] Read the file']).status, 0)
  assert.equal(f.event('Stop', 'turn-1', { last_assistant_message: 'It has 1 line.' }).status, 0)
  const board = readFileSync(f.progress, 'utf8')
  assert.match(board, /state=done/)
  assert.ok(!/- \[\?\]/.test(board))
  assert.ok(sessionRecord(f, session).events.includes('Stop:turn-1'))
}))

test('a closing question the model already reported as a [?] step stays one line with its card', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.report('waiting', ['- [x] Read the file', '- [?] Blue or green?']).status, 0)
  assert.equal(f.event('Stop', 'turn-1', { last_assistant_message: 'It has 1 line.\n\nBlue or green?' }).status, 0)
  const board = readFileSync(f.progress, 'utf8')
  assert.equal(board.match(/- \[\?\] Blue or green\?/g)?.length, 1)
  assert.match(board, /- \[\?\] Blue or green\?\n<!-- question=[a-f0-9]{64}:\d+ -->/)
  // The next prompt answers that one line without settling it.
  assert.equal(f.event('UserPromptSubmit', 'turn-2').status, 0)
  const answered = readFileSync(f.progress, 'utf8')
  assert.equal(answered.match(/- \[[?x]\] Blue or green\?/g)?.length, 1)
  assert.match(answered, / replied=\S+Z/)
  assert.match(answered, /- \[\?\] Blue or green\?/)
  assert.equal(f.event('Stop', 'turn-2', { last_assistant_message: 'I picked blue.' }).status, 0)
  const settled = readFileSync(f.progress, 'utf8')
  assert.match(settled, /- \[x\] Blue or green\?/)
  assert.doesNotMatch(settled, / replied=|- \[\?\]/)
}))

test('a replayed closing-question stop changes nothing', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.report('done', ['- [x] Read the file']).status, 0)
  assert.equal(f.event('Stop', 'turn-1', { last_assistant_message: 'It has 1 line.\n\nBlue or green?' }).status, 0)
  // A replay still moves appliedAt forward, so later events order after it; nothing else changes.
  const kept = () => JSON.stringify({ ...sessionRecord(f, session), appliedAt: undefined })
  const board = readFileSync(f.progress, 'utf8'), record = kept()
  assert.equal(f.event('Stop', 'turn-1', { last_assistant_message: 'It has 1 line.\n\nBlue or green?' }).status, 0)
  assert.equal(readFileSync(f.progress, 'utf8'), board)
  assert.equal(kept(), record)
  assert.equal(sessionRecord(f, session).events.filter(one => one === 'Stop:turn-1').length, 1)
}))

test('a Grok report binds to the session Grok names even when the folder has another Grok session (#1155)', () => fixture(f => {
  assert.equal(f.install('--agent', 'grok', '--apply').status, 0)
  const env = { CODEX_THREAD_ID: '', AGENT_BOARD_AGENT: '', AGENT_BOARD_SESSION_ID: '', GROK_SESSION_ID: '' }
  for (const id of ['synthetic-grok-board', 'synthetic-grok-work']) {
    assert.equal(f.command(['--agent-status', '--agent', 'grok', '--state', 'working'], { sessionId: id, hookEventName: 'UserPromptSubmit' }, env).status, 0)
  }
  const steps = { title: 'Synthetic test', state: 'waiting', steps: ['- [x] read claude-one.txt', '- [x] count its lines', '- [?] Blue or green?'] }
  const reported = f.command(['--codex-report', '--agent', 'grok'], steps, { ...env, GROK_SESSION_ID: 'synthetic-grok-work' })
  assert.equal(reported.status, 0, reported.stderr)
  assert.equal(JSON.parse(reported.stdout).block, createHash('sha256').update('grok:synthetic-grok-work').digest('hex').slice(0, 8))
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Blue or green\?/)
  // With no Grok session id and two Grok sessions in this folder, a report is still refused instead of guessed.
  assert.notEqual(f.command(['--codex-report', '--agent', 'grok'], steps, env).status, 0)
}))

test('Grok reopens a done block for a closing question and keeps it done for a plain stop', () => fixture(f => {
  assert.equal(f.install('--agent', 'grok', '--apply').status, 0)
  const id = 'synthetic-grok-done'
  const send = (state, extra = {}) => f.command(['--agent-status', '--agent', 'grok', '--state', state], { sessionId: id, ...extra })
  const report = () => f.command(['--codex-report', '--agent', 'grok', '--session', id], { title: 'Own report', state: 'done', steps: ['- [x] Read the file'] })
  assert.equal(send('working', { hookEventName: 'UserPromptSubmit' }).status, 0)
  assert.equal(report().status, 0)
  assert.equal(send('waiting', { hookEventName: 'Stop', lastAssistantMessage: 'It has 1 line.' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /state=done/)
  assert.equal(send('working', { hookEventName: 'UserPromptSubmit' }).status, 0)
  assert.equal(report().status, 0)
  assert.equal(send('waiting', { hookEventName: 'Stop', lastAssistantMessage: 'It has 1 line.\n\nBlue or green?' }).status, 0)
  const board = readFileSync(f.progress, 'utf8')
  assert.match(board, /state=waiting/)
  assert.equal(board.match(/- \[\?\] Blue or green\?/g)?.length, 1)
}))

test('the approval step and the question step close and reuse their own lines in either order', () => fixture(f => {
  f.install('--apply')
  const question = { last_assistant_message: 'Which folder should I use?' }
  assert.equal(f.event('UserPromptSubmit', 'turn-1').status, 0)
  assert.equal(f.event('Stop', 'turn-1', question).status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-2').status, 0)
  assert.equal(f.event('PermissionRequest', 'turn-2').status, 0)
  const approval = readFileSync(f.progress, 'utf8')
  assert.ok(approval.includes('- [x] Which folder should I use?'))
  assert.match(approval, /- \[\?\] Codex [^\n]*\n<!-- native=codex -->\n/)
  assert.equal(f.event('Stop', 'turn-2', question).status, 0)
  const second = readFileSync(f.progress, 'utf8')
  assert.ok(!second.includes('native=codex'))
  assert.match(second, /- \[x\] Codex [^\n]*\n/)
  assert.equal(second.match(/- \[\?\]/g)?.length, 1)
  assert.equal(second.match(/- \[[?x]\] Which folder should I use\?/g)?.length, 1)
  assert.ok(second.includes('- [?] Which folder should I use?'))
  assert.equal(f.event('UserPromptSubmit', 'turn-3').status, 0)
  const answered = readFileSync(f.progress, 'utf8')
  assert.match(answered, / replied=\S+Z/)
  assert.match(answered, /- \[\?\] Which folder should I use\?/)
  assert.doesNotMatch(answered, /native=codex/)
  assert.equal(f.event('Stop', 'turn-3', { last_assistant_message: 'I used the folder.' }).status, 0)
  const settled = readFileSync(f.progress, 'utf8')
  assert.match(settled, /- \[x\] Which folder should I use\?/)
  assert.doesNotMatch(settled, / replied=|- \[\?\]/)
}))

test('Grok keeps only its closing question through board and end events, then closes and reuses it', () => fixture(f => {
  assert.equal(f.install('--agent', 'grok', '--apply').status, 0)
  const id = 'synthetic-grok-question', secret = 'SYNTHETIC-PRIVATE-GROK-DETAIL'
  const send = (state, extra = {}) => f.command(['--agent-status', '--agent', 'grok', '--state', state], { sessionId: id, ...extra })
  assert.equal(send('working', { hookEventName: 'UserPromptSubmit' }).status, 0)
  assert.equal(send('waiting', { hookEventName: 'Stop', lastAssistantMessage: `${secret}\n\nWhich color?` }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Which color\?/)
  assert.equal(send('working', { hookEventName: 'UserPromptSubmit', prompt: '/agent-board' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Which color\?/)
  assert.equal(send('ended', { hookEventName: 'SessionEnd' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Which color\?/)
  assert.equal(send('working', { hookEventName: 'UserPromptSubmit' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[x\] Which color\?/)
  assert.equal(send('waiting', { last_assistant_message: 'Use the default.' }).status, 0)
  assert.doesNotMatch(readFileSync(f.progress, 'utf8'), /- \[\?\]/)
  assert.equal(send('waiting', { last_assistant_message: 'Which folder?' }).status, 0)
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /- \[\?\] Which folder\?/)
  assert.equal((text.match(/- \[[?x]\] Which (?:color|folder)\?/g) ?? []).length, 1)
  assert.ok(!text.includes(secret))
  const record = readFileSync(join(f.root, 'sessions', createHash('sha256').update(`grok:${id}`).digest('hex') + '.json'), 'utf8')
  assert.ok(!record.includes(secret))
  assert.equal(f.command(['--codex-report', '--agent', 'grok', '--session', id], { title: 'Own report', state: 'working', steps: ['- [~] Continue work'] }).status, 0)
  // A `!` ends a sentence for lastQuestion, so `<!--` never reaches a step; a closing `-->` would.
  assert.equal(send('waiting', { lastAssistantMessage: 'Choose blue --> or green?' }).status, 0)
  const reported = readFileSync(f.progress, 'utf8')
  assert.equal((reported.match(/- \[[?x]\] (?:Which folder|Choose blue or green)\?/g) ?? []).length, 1)
  assert.match(reported, /- \[\?\] Choose blue or green\?/)
  assert.doesNotMatch(reported, /- \[\?\] .*-->/)
  // A later stop with no question leaves the open one waiting; only a prompt answers it.
  assert.equal(send('waiting', { lastAssistantMessage: 'Still thinking about the colors.' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Choose blue or green\?/)
}))

test('Cursor records a closing question on either side of stop and settles it after chat and a report', () => fixture(f => {
  assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
  for (const [index, order] of [['response-first', ['afterAgentResponse', 'stop']], ['stop-first', ['stop', 'afterAgentResponse']]]) {
    const id = `synthetic-cursor-${index}`
    const send = (event, generation, extra = {}) => f.command(['--codex-event', '--agent', 'cursor'], { conversation_id: id, generation_id: generation, hook_event_name: event, ...extra })
    assert.equal(send('beforeSubmitPrompt', 'generation-1').status, 0)
    for (const event of [...order, 'afterAgentResponse']) assert.equal(send(event, 'generation-1', { text: 'SYNTHETIC-PRIVATE-CURSOR\n\nProceed now?' }).status, 0)
    const recordFile = join(f.root, 'sessions', createHash('sha256').update(`cursor:${id}`).digest('hex') + '.json')
    const record = JSON.parse(readFileSync(recordFile, 'utf8'))
    assert.equal(record.steps.filter(step => step === '- [?] Proceed now?').length, 1)
    assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Proceed now\?/)
    assert.ok(!readFileSync(recordFile, 'utf8').includes('SYNTHETIC-PRIVATE-CURSOR'))
    assert.equal(send('beforeSubmitPrompt', 'generation-2').status, 0)
    assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Proceed now\?/)
    // An empty Stop can arrive before the actual response; only the latter settles the question.
    assert.equal(send('stop', 'generation-2').status, 0)
    assert.match(readFileSync(f.progress, 'utf8'), / replied=\S+Z/)
    assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Proceed now\?/)
    assert.equal(send('afterAgentResponse', 'generation-2', { text: 'Continuing the synthetic work.' }).status, 0)
    const answered = JSON.parse(readFileSync(recordFile, 'utf8'))
    assert.equal(answered.steps.filter(step => step === '- [x] Proceed now?').length, 1)
    assert.ok(!answered.steps.some(step => step.startsWith('- [?] ')))
    assert.doesNotMatch(readFileSync(f.progress, 'utf8'), /- \[\?\] Proceed now\?/)
  }
}))

test('bundled Cursor and idle status replays do not reopen resolved questions after reload', async () => {
  const { parseProgress } = await importTs('../hooks/parse.ts')
  const { emptyQuestions, observeQuestions, resolveQuestion } = await importTs('../hooks/questions.ts')
  const { buildView } = await importTs('../hooks/view.ts')
  const { STRINGS } = await importTs('../hooks/strings.ts')
  return fixture(f => {
    for (const agent of ['cursor', 'opencode']) {
      assert.equal(f.install('--agent', agent, '--apply').status, 0)
      const id = `synthetic-${agent}-question-replay`
      const file = join(f.root, 'sessions', createHash('sha256').update(`${agent}:${id}`).digest('hex') + '.json')
      const record = () => JSON.parse(readFileSync(file, 'utf8'))
      const projects = () => parseProgress(readFileSync(f.progress, 'utf8'))
      const send = (state, generation, question) => agent === 'cursor'
        ? f.command(['--codex-event', '--agent', agent], { conversation_id: id, generation_id: generation,
          hook_event_name: state === 'working' ? 'beforeSubmitPrompt' : question === undefined ? 'stop' : 'afterAgentResponse',
          ...(question === undefined ? {} : { text: question }) })
        : f.command(['--agent-status', '--agent', agent, '--state', state], { session_id: id,
          ...(state === 'working' ? { prompt_submitted: true } : {}), ...(question === undefined ? {} : { last_assistant_message: question }) })
      const now = Date.now()
      assert.equal(send('working', 'generation-1').status, 0)
      assert.equal(send('waiting', 'generation-1').status, 0)
      assert.equal(send('waiting', 'generation-1', 'Proceed now?').status, 0)
      const first = record()
      const open = observeQuestions(emptyQuestions(), projects(), null, [], now, true).ledger
      const old = open.records.find(one => one.isUnresolved && one.source.agent === agent)
      assert.ok(old)
      const resolved = resolveQuestion(open, old.id, now + 1)
      // Each command reloads the cache; a second afterAgentResponse or idle status is a replay.
      assert.equal(send('waiting', 'generation-1', 'Proceed now?').status, 0)
      const replay = observeQuestions(resolved, projects(), null, [], now + 2, true).ledger
      assert.equal(replay.records.filter(one => one.isUnresolved && one.source.agent === agent).length, 0)
      assert.equal(record().askedRevision, first.askedRevision)
      assert.equal(buildView(projects(), [], null, now + 2, 0, {}, STRINGS.en, [], {}, replay).waiting.length, 0)
      // A different no-question hook/status persists intervening activity but does not answer A.
      // The later identical delivery must stay resolved even when the consecutive-write shortcut cannot apply.
      assert.equal(send(agent === 'cursor' ? 'waiting' : 'ended', 'generation-1').status, 0)
      assert.equal(send('waiting', 'generation-1', 'Proceed now?').status, 0)
      const delayed = observeQuestions(replay, projects(), null, [], now + 3, true).ledger
      assert.equal(delayed.records.filter(one => one.isUnresolved && one.source.agent === agent).length, 0)
      assert.equal(record().askedRevision, first.askedRevision)
      assert.equal(buildView(projects(), [], null, now + 3, 0, {}, STRINGS.en, [], {}, delayed).waiting.length, 0)
      assert.equal(send('working', 'generation-2').status, 0)
      assert.equal(send('waiting', 'generation-2', 'Proceed now?').status, 0)
      const renewed = observeQuestions(delayed, projects(), null, [], now + 4, true).ledger
      assert.notEqual(record().askedRevision, first.askedRevision)
      assert.notEqual(renewed.records.find(one => one.isUnresolved && one.source.agent === agent)?.id, old.id)
      assert.equal(send('working', 'generation-3').status, 0)
    }
  })
})

test('OpenCode status retains its owned question beyond forty user steps and keeps the new-slot limit', () => fixture(f => {
  assert.equal(f.install('--agent', 'opencode', '--apply').status, 0)
  const id = 'synthetic-opencode-question'
  const send = (state, extra = {}) => f.command(['--agent-status', '--agent', 'opencode', '--state', state], { session_id: id, ...extra })
  assert.equal(send('waiting', { last_assistant_message: 'SYNTHETIC-PRIVATE-OPENCODE\n\nWhich branch?' }).status, 0)
  const first = readFileSync(f.progress, 'utf8')
  assert.equal((first.match(/- \[\?\] Which branch\?/g) ?? []).length, 1)
  assert.ok(!first.includes('SYNTHETIC-PRIVATE-OPENCODE'))
  assert.equal(send('working', { prompt_submitted: true }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[x\] Which branch\?/)
  assert.equal(f.command(['--codex-report', '--agent', 'opencode', '--session', id], { title: 'Forty steps', state: 'working', steps: Array.from({ length: 40 }, (_, index) => `- [ ] Step ${index + 1}`) }).status, 0)
  assert.equal(send('waiting', { last_assistant_message: 'Another question?' }).status, 0)
  const record = JSON.parse(readFileSync(join(f.root, 'sessions', createHash('sha256').update(`opencode:${id}`).digest('hex') + '.json'), 'utf8'))
  assert.equal(record.steps.length, 41)
  assert.deepEqual(record.steps.slice(0, 40), Array.from({ length: 40 }, (_, index) => `- [ ] Step ${index + 1}`))
  assert.equal(record.steps[record.asked], '- [?] Another question?')
  assert.equal(record.askedRevision, '2')
  assert.match(readFileSync(f.progress, 'utf8'), /<!-- question=[a-f0-9]{64}:2 -->/)
  assert.equal(send('working', { prompt_submitted: true, prompt: '/agent-board' }).status, 0)
  const file = join(f.root, 'sessions', createHash('sha256').update(`opencode:${id}`).digest('hex') + '.json')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).askedRevision, record.askedRevision)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).steps[record.asked], '- [?] Another question?')
  assert.equal(send('working', { prompt_submitted: true }).status, 0)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).steps[record.asked], '- [x] Another question?')
  // Main's new-slot policy is unchanged: without an owned question, forty steps stay forty.
  const fresh = 'synthetic-opencode-full-no-question'
  assert.equal(f.command(['--codex-report', '--agent', 'opencode', '--session', fresh], { title: 'Forty steps', state: 'working', steps: record.steps.slice(0, 40) }).status, 0)
  assert.equal(f.command(['--agent-status', '--agent', 'opencode', '--state', 'waiting'], { session_id: fresh, last_assistant_message: 'New question?' }).status, 0)
  const untouched = JSON.parse(readFileSync(join(f.root, 'sessions', createHash('sha256').update(`opencode:${fresh}`).digest('hex') + '.json'), 'utf8'))
  assert.equal(untouched.steps.length, 40)
  assert.equal(untouched.asked, undefined)
  assert.equal(untouched.askedRevision, undefined)
}))

test('local status preserves cached session and step validation after owned-slot retention', () => fixture(f => {
  assert.equal(f.install('--agent', 'opencode', '--apply').status, 0)
  const id = 'synthetic-opencode-invalid-cache'
  const send = () => f.command(['--agent-status', '--agent', 'opencode', '--state', 'waiting'], { session_id: id })
  assert.equal(send().status, 0)
  const file = join(f.root, 'sessions', createHash('sha256').update(`opencode:${id}`).digest('hex') + '.json')
  const original = JSON.parse(readFileSync(file, 'utf8'))
  const before = readFileSync(f.progress, 'utf8')
  for (const changed of [{ session: 'synthetic-wrong-session' }, { steps: ['invalid step'] }]) {
    const corrupted = JSON.stringify({ ...original, ...changed })
    f.save(file, corrupted)
    assert.notEqual(send().status, 0)
    assert.equal(readFileSync(f.progress, 'utf8'), before)
    assert.equal(readFileSync(file, 'utf8'), corrupted)
  }
}))

test('Antigravity reads only a current closing question from a bounded transcript tail', () => fixture(f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const file = join(f.home, 'conversation', 'transcript.jsonl')
  const user = { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'SYNTHETIC-PRIVATE-PROMPT' }
  const model = content => ({ source: 'MODEL', type: 'PLANNER_RESPONSE', content })
  const save = entries => f.save(file, entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n')
  const send = (id, state, event, transcriptPath = file) => f.command(['--agent-status', '--agent', 'antigravity', '--state', state, '--event', event], { conversationId: id, transcriptPath })
  const record = id => JSON.parse(readFileSync(join(f.root, 'sessions', createHash('sha256').update(`antigravity:${id}`).digest('hex') + '.json'), 'utf8'))
  const id = 'synthetic-agy-current-question'
  save([user, model('SYNTHETIC-PRIVATE-REPLY\n\nReady to proceed?')])
  assert.equal(send(id, 'waiting', 'Stop').status, 0)
  assert.ok(record(id).steps.includes('- [?] Ready to proceed?'))
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Ready to proceed\?/)
  assert.equal(send(id, 'working', 'PreInvocation').status, 0)
  assert.ok(record(id).steps.includes('- [x] Ready to proceed?'))
  assert.match(readFileSync(f.progress, 'utf8'), /- \[x\] Ready to proceed\?/)
  assert.ok(!readFileSync(f.progress, 'utf8').includes('SYNTHETIC-PRIVATE'))
  save([user, model('Old question?'), user])
  assert.equal(send('synthetic-agy-new-prompt', 'waiting', 'Stop').status, 0)
  assert.equal(record('synthetic-agy-new-prompt').asked, undefined)
  save([user, model('No question in this reply.')])
  assert.equal(send('synthetic-agy-no-question', 'waiting', 'Stop').status, 0)
  assert.equal(record('synthetic-agy-no-question').asked, undefined)
  save([user, 'not JSON', model('Do not retain this?')])
  assert.equal(send('synthetic-agy-garbage', 'waiting', 'Stop').status, 0)
  assert.equal(record('synthetic-agy-garbage').asked, undefined)
  save([user, 42, model('Invalid shape?')])
  assert.equal(send('synthetic-agy-bad-shape', 'waiting', 'Stop').status, 0)
  assert.equal(record('synthetic-agy-bad-shape').asked, undefined)
  save([user, model('Old question?'), { source: 'MODEL', type: 'PLANNER_RESPONSE', content: { text: 'Invalid reply shape' } }])
  assert.equal(send('synthetic-agy-bad-reply', 'waiting', 'Stop').status, 0)
  assert.equal(record('synthetic-agy-bad-reply').asked, undefined)
  const folder = join(f.home, 'directory', 'transcript.jsonl')
  mkdirSync(folder, { recursive: true })
  for (const [name, path] of [['missing', join(f.home, 'missing', 'transcript.jsonl')], ['directory', folder], ['relative', 'transcript.jsonl'], ['wrong-name', join(f.home, 'other.jsonl')]]) {
    const session = `synthetic-agy-${name}`
    assert.equal(send(session, 'waiting', 'Stop', path).status, 0)
    assert.equal(record(session).state, 'waiting')
    assert.equal(record(session).asked, undefined)
  }
  save([model('a'.repeat(300000)), user, model('A long transcript.\n\nUse the blue one?')])
  assert.equal(f.command(['--agent-status', '--agent', 'antigravity', '--state', 'waiting'], { conversationId: 'synthetic-agy-long-tail', transcriptPath: file }).status, 0)
  assert.ok(record('synthetic-agy-long-tail').steps.includes('- [?] Use the blue one?'))
  // agy 1.5.2 hooks name transcript_full.jsonl, with the same line shape.
  const full = join(f.home, 'conversation', 'transcript_full.jsonl')
  f.save(full, [user, model('SYNTHETIC-PRIVATE-REPLY\n\nShould I pick a third name?')].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  assert.equal(send('synthetic-agy-full-transcript', 'waiting', 'Stop', full).status, 0)
  assert.ok(record('synthetic-agy-full-transcript').steps.includes('- [?] Should I pick a third name?'))
  assert.ok(!readFileSync(f.progress, 'utf8').includes('SYNTHETIC-PRIVATE'))
}))

test('queued Grok status retains only the closing question and replays it', () => fixture(f => {
  assert.equal(f.install('--agent', 'grok', '--apply').status, 0)
  const id = 'synthetic-grok-queued-question', locked = lockedProgress(f)
  const queued = f.command(['--agent-status', '--agent', 'grok', '--state', 'waiting'], { sessionId: id, lastAssistantMessage: 'SYNTHETIC-PRIVATE-QUEUED\n\nKeep this choice?' }, locked.env)
  assert.equal(queued.status, 0, queued.stderr)
  const files = pendingFiles(f)
  assert.equal(files.length, 1)
  const contents = readFileSync(join(f.root, 'pending', files[0]), 'utf8')
  assert.deepEqual(JSON.parse(contents).payload, { question: 'Keep this choice?' })
  assert.ok(!contents.includes('SYNTHETIC-PRIVATE-QUEUED'))
  unlinkSync(locked.marker)
  assert.equal(f.command(['--agent-status', '--agent', 'grok', '--state', 'working'], { sessionId: 'synthetic-grok-other-session' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Keep this choice\?/)
  holdAutomaticRecovery(f)
  const rawId = 'synthetic-grok-raw-question'
  const worker = join(f.root, 'agent-board-hook.mjs')
  const raw = spawnSync(process.execPath, [worker, '--hook-version', '1', '--hook-deadline', String(Date.now() - 1), '--agent-status', '--agent', 'grok', '--state', 'waiting', '--progress-file', f.progress], {
    env: f.env, input: JSON.stringify({ sessionId: rawId, lastAssistantMessage: 'SYNTHETIC-PRIVATE-RAW\n\nCan we continue?' }), encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
  assert.equal(raw.status, 0, raw.stderr)
  const pending = pendingFiles(f)
  assert.equal(pending.length, 1)
  assert.ok(pending[0].endsWith('.raw.json'))
  const rawText = readFileSync(join(f.root, 'pending', pending[0]), 'utf8')
  assert.doesNotMatch(rawText, /SYNTHETIC-PRIVATE-RAW|Can we continue\?|lastAssistantMessage/)
  assert.equal(f.command(['--agent-status', '--agent', 'grok', '--state', 'working'], { sessionId: 'synthetic-grok-replay-session' }).status, 0)
  const record = JSON.parse(readFileSync(join(f.root, 'sessions', createHash('sha256').update(`grok:${rawId}`).digest('hex') + '.json'), 'utf8'))
  assert.equal(record.state, 'waiting')
  assert.equal(record.asked, undefined)
}))

// These synthetic full ids have distinct SHA-256 owners with the same eight-character prefix.
const collisionSessions = ['collision-fixture-9342', 'collision-fixture-29381']
const collisionOwner = id => createHash('sha256').update(`codex:${id}`).digest('hex')
const collisionBlock = (text, owner) => text.match(new RegExp(`<!-- auto session=${owner.slice(0, 8)} [^\\n]*owner=${owner}[^\\n]*-->[\\s\\S]*?<!-- /auto session=${owner.slice(0, 8)} -->`))?.[0]

test('Codex hook events and reports preserve both independent sessions with the same short id', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const [first, second] = collisionSessions
  assert.equal(collisionOwner(first).slice(0, 8), collisionOwner(second).slice(0, 8))
  assert.notEqual(collisionOwner(first), collisionOwner(second))
  const report = (id, project) => f.command(['--codex-report', '--session', id], { title: `${project} task`, project, state: 'working', steps: ['- [~] Keep this work'] })
  assert.equal(report(first, 'First project').status, 0)
  const firstBytes = collisionBlock(readFileSync(f.progress, 'utf8'), collisionOwner(first))
  assert.ok(firstBytes)
  for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    const result = f.event(name, 'collision-turn', { session_id: second })
    assert.equal(result.status, 0, result.stderr)
    const text = readFileSync(f.progress, 'utf8')
    assert.equal(collisionBlock(text, collisionOwner(first)), firstBytes)
    assert.ok(collisionBlock(text, collisionOwner(second)))
    assert.equal((text.match(/^<!-- auto /gm) ?? []).length, 2)
  }
  const secondBytes = collisionBlock(readFileSync(f.progress, 'utf8'), collisionOwner(second))
  assert.equal(report(first, 'Moved first project').status, 0)
  const moved = readFileSync(f.progress, 'utf8')
  assert.equal(collisionBlock(moved, collisionOwner(second)), secondBytes)
  assert.ok(moved.includes(`## Moved first project\n${collisionBlock(moved, collisionOwner(first))}`))
  const savedFirst = collisionBlock(moved, collisionOwner(first))
  assert.equal(report(second, 'Moved second project').status, 0)
  assert.equal(collisionBlock(readFileSync(f.progress, 'utf8'), collisionOwner(first)), savedFirst)
}))

test('Codex same-prefix reporting still refuses duplicate ownership and contradictory or unproven peers', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const [id, peer] = collisionSessions
  const owner = collisionOwner(id), peerOwner = collisionOwner(peer)
  const report = () => f.command(['--codex-report', '--session', id], { title: 'Owned task', state: 'working', steps: ['- [~] Keep this work'] })
  assert.equal(report().status, 0)
  const owned = readFileSync(f.progress, 'utf8')
  const recordPath = join(f.root, 'sessions', `${owner}.json`)
  const record = readFileSync(recordPath)
  const block = collisionBlock(owned, owner)
  const foreign = block.replace(`owner=${owner}`, `owner=${peerOwner}`).replace(`resume=${id}`, `resume=${peer}`)
  for (const text of [
    owned + owned,
    owned.replace(`resume=${id}`, `resume=${peer}`),
    owned.replace('agent=codex', 'agent=cursor'),
    foreign.replace(` owner=${peerOwner}`, ''),
    foreign.replace(`resume=${peer}`, `resume=${id}`),
    foreign.replace(`owner=${peerOwner}`, `owner=${peerOwner.slice(0, -1)}${peerOwner.endsWith('0') ? '1' : '0'}`),
    foreign.replace(` resume=${peer}`, ''),
    owned + foreign.replace(` owner=${peerOwner}`, ''),
  ]) {
    writeFileSync(f.progress, text)
    const result = report()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /BLOCK_CONFLICT/)
    assert.equal(readFileSync(f.progress, 'utf8'), text)
    assert.deepEqual(readFileSync(recordPath), record)
  }
}))

test('native completion and run withdrawal select the full owner beside a same-prefix peer', async () => {
  const { boardConfirmedReport, dropCodexBlock, putCodexBlock } = await importTs('../hooks/codex.ts')
  const [id, peer] = collisionSessions
  const owner = collisionOwner(id), peerOwner = collisionOwner(peer)
  const report = { session: id, agent: 'codex', turn: null, state: 'waiting', title: 'Owned task', project: 'Owned project', steps: ['- [ ] Work'], updated: '2026-10-30T00:00:00Z' }
  const peerText = putCodexBlock('', { ...report, session: peer, title: 'Peer task', project: 'Peer project' }, peerOwner)
  const done = { ...report, state: 'done', steps: ['- [x] Work'], updated: '2026-10-30T00:01:00.000Z' }
  const text = putCodexBlock(peerText, done, owner)
  assert.deepEqual(boardConfirmedReport(text, report, owner), done)
  assert.equal(dropCodexBlock(text, owner), peerText)
  assert.equal(dropCodexBlock(text + text, owner), text + text)
})

test('run withdrawal refuses a block whose native resume contradicts its owner and keeps every byte', async () => {
  const { dropCodexBlock, putCodexBlock } = await importTs('../hooks/codex.ts')
  const [id, peer] = collisionSessions
  const owner = collisionOwner(id), peerOwner = collisionOwner(peer)
  const report = { session: id, agent: 'codex', turn: null, state: 'working', title: 'Owned task', project: 'Owned project', steps: ['- [~] Work'], updated: '2026-10-30T00:00:00Z' }
  const own = putCodexBlock('', report, owner)
  const both = putCodexBlock(putCodexBlock('', { ...report, session: peer, title: 'Peer task', project: 'Peer project' }, peerOwner), report, owner)
  assert.ok(both.includes(`resume=${peer}`))
  // A contradiction beside a valid peer, alone, with mixed line endings, and with a resume that could never be a session's.
  for (const text of [
    both.replace(`resume=${id}`, `resume=${peer}`),
    own.replace(`resume=${id}`, `resume=${peer}`),
    both.replace(`resume=${id}`, `resume=${peer}`).replaceAll('\n', '\r\n') + 'Keep this mixed ending.\n',
    own.replace(`resume=${id}`, 'resume=x'),
  ]) assert.equal(dropCodexBlock(text, owner), text)
  // The peer's own valid binding is still withdrawn alone, and a block with no resume is still its owner's.
  assert.equal(dropCodexBlock(both, peerOwner), putCodexBlock('', report, owner))
  assert.equal(dropCodexBlock(own.replace(` resume=${id}`, ''), owner), '')
})

test('native reports preserve a different agent with the same hash prefix and mixed newline bytes', async () => {
  const { putCodexBlock, dropCodexBlock } = await importTs('../hooks/codex.ts')
  const id = 'cross-collision-fixture-22272', peer = 'cross-collision-fixture-63084'
  const owner = collisionOwner(id)
  const peerOwner = createHash('sha256').update(`cursor:${peer}`).digest('hex')
  assert.equal(owner.slice(0, 8), peerOwner.slice(0, 8))
  const report = { session: id, agent: 'codex', turn: null, state: 'working', title: 'Owned task', project: 'Own project', steps: ['- [~] Work'], updated: '2026-10-30T00:00:00Z' }
  const peerText = putCodexBlock('', { ...report, session: peer, agent: 'cursor', title: 'Peer task', project: 'Peer project' }, peerOwner).replaceAll('\n', '\r\n') + 'Keep this mixed ending.\n'
  const both = putCodexBlock(peerText, report, owner)
  assert.ok(both.startsWith(peerText))
  const rewritten = putCodexBlock(both, { ...report, steps: ['- [?] Keep my question'] }, owner)
  assert.ok(rewritten.startsWith(peerText))
  assert.equal(dropCodexBlock(rewritten, owner), peerText)
})

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
  const result = f.command(['--codex-doctor', '--home', f.home, '--json'])
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

test('multi-agent removal preserves the shared board for an agent skipped by a conflict', () => fixture(async f => {
  for (const agent of ['codex', 'antigravity']) {
    const installed = f.install('--agent', agent, '--apply')
    assert.equal(installed.status, 0, installed.stderr + installed.stdout)
  }
  const skill = join(f.home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')
  const edited = `${readFileSync(skill, 'utf8')}Synthetic user edit\n`
  f.save(skill, edited)
  const args = ['--remove', '--agent', 'codex,antigravity', '--json']
  const preview = setupAgent(f, ...args)
  assert.equal(preview.status, 0, preview.stderr + preview.stdout)
  const before = JSON.parse(preview.stdout)
  const codexPreview = before.plans.find(plan => plan.agent === 'codex')
  const antigravityPreview = before.plans.find(plan => plan.agent === 'antigravity')
  assert.ok(antigravityPreview.conflicts.includes(skill), preview.stdout)
  for (const file of [f.script, f.skill, join(f.root, 'agent-board-hook.mjs')]) {
    assert.ok(!codexPreview.changes.some(change => change.file === file), preview.stdout)
  }
  const textPreview = setupAgent(f, '--remove', '--agent', 'codex,antigravity', '--lang', 'en')
  assert.equal(textPreview.status, 0, textPreview.stderr + textPreview.stdout)
  assert.match(textPreview.stdout, /Antigravity: skipped:/)
  const removed = setupAgent(f, ...args, '--apply')
  assert.equal(removed.status, 0, removed.stderr + removed.stdout)
  const result = JSON.parse(removed.stdout)
  const codexResult = result.plans.find(plan => plan.agent === 'codex')
  assert.equal(codexResult.applied, true)
  assert.deepEqual(codexResult.changes, codexPreview.changes)
  assert.ok(result.plans.find(plan => plan.agent === 'antigravity').conflicts.includes(skill), removed.stdout)
  assert.equal(existsSync(join(f.root, 'install-codex.json')), false)
  assert.equal(existsSync(join(f.root, 'install-antigravity.json')), true)
  assert.equal(readFileSync(skill, 'utf8'), edited)
  for (const file of [f.script, f.skill, join(f.root, 'agent-board-hook.mjs')]) assert.equal(existsSync(file), true, file)
  const hook = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board-local'].PreInvocation[0]
  const fired = await fireCommand(f, hook.command, JSON.stringify({ conversationId: 'synthetic-retained-antigravity' }))
  assert.equal(fired.status, 0, hookFailure(fired))
  assert.match(readFileSync(f.progress, 'utf8'), /agent=antigravity/)
}))

test('a removal that newly conflicts on the second preview is not told to the others, and none applies when all conflict', () => fixture(f => {
  // A stand-in helper: Antigravity always conflicts; Cursor conflicts from its second preview on (as if the
  // person edited its file during the run); every call is logged with the --removing list it was given.
  const helper = join(f.home, 'stand-in-helper.mjs'), log = join(f.home, 'helper-calls.jsonl')
  f.save(helper, `import { appendFileSync, readFileSync, existsSync } from 'node:fs'
const args = process.argv.slice(2), agent = args[args.indexOf('--agent') + 1], removing = args[args.indexOf('--removing') + 1]
const log = ${JSON.stringify(log)}
const seen = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.agent === agent && !call.apply).length : 0
appendFileSync(log, JSON.stringify({ agent, removing, apply: args.includes('--apply') }) + '\\n')
const always = (process.env.STAND_IN_CONFLICTS || '').split(',')
const conflicts = always.includes(agent) || (agent === 'cursor' && seen >= 1) ? ['synthetic-edited-file'] : []
process.stdout.write(JSON.stringify({ agent, mode: 'remove', changes: [{ file: 'synthetic-' + agent, action: 'remove' }], conflicts, applied: args.includes('--apply') }))
`)
  const run = (agents, conflicts) => {
    rmSync(log, { force: true })
    return spawnSync(process.execPath, [resolve('scripts/setup-agent.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--remove', '--agent', agents, '--json', '--apply'],
      { env: { ...f.env, AGENT_BOARD_SETUP_HELPER: helper, STAND_IN_CONFLICTS: conflicts }, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  }
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))

  const some = run('codex,cursor,antigravity', 'antigravity')
  assert.equal(some.status, 0, some.stderr + some.stdout)
  assert.equal(JSON.parse(some.stdout).applied, true)
  assert.deepEqual(calls().filter(call => call.apply), [{ agent: 'codex', removing: 'codex', apply: true }], JSON.stringify(calls()))

  const none = run('cursor,antigravity', 'antigravity')
  assert.equal(none.status, 1, none.stderr + none.stdout)
  assert.equal(JSON.parse(none.stdout).applied, false)
  assert.equal(calls().some(call => call.apply), false, JSON.stringify(calls()))
}))

test('removal with JSON applies through the short remove flag', () => fixture(f => {
  const installed = f.install('--apply')
  assert.equal(installed.status, 0, installed.stderr + installed.stdout)
  const loader = join(f.home, 'source-loader.mjs')
  f.save(loader, `import { registerHooks } from 'node:module'\nregisterHooks({ resolve(specifier, context, next) {\n  try { return next(specifier, context) } catch (error) {\n    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error\n    return next(specifier + '.ts', context)\n  }\n} })\n`)
  const run = agent => spawnSync(process.execPath, ['--experimental-transform-types', '--import', pathToFileURL(loader).href, resolve('scripts/board-cli.ts'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--data-dir', f.root, '--remove', '--agent', agent, '--json', '--apply'], { cwd: f.home, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const refused = run('unsupported')
  assert.equal(refused.status, 1, refused.stderr + refused.stdout)
  assert.equal(JSON.parse(refused.stderr.split(/\r?\n/).find(line => line.startsWith('{"error"'))).error.code, 'UNSUPPORTED_AGENT')
  assert.equal(existsSync(join(f.root, 'install-codex.json')), true)
  const removed = run('codex')
  assert.equal(removed.status, 0, removed.stderr + removed.stdout)
  const result = JSON.parse(removed.stdout)
  assert.equal(result.mode, 'remove')
  assert.equal(result.applied, true)
  assert.equal(existsSync(join(f.root, 'install-codex.json')), false)
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

test('OpenCode adapter and task tool work without Claude', async () => {
  const home = mkdtempSync(join(tmpdir(), 'opencode-adapter-'))
  const exitListeners = process.listeners('exit')
  try {
    const env = isolatedEnv(home)
    const installed = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'opencode', '--apply'], { env, encoding: 'utf8', windowsHide: true })
    assert.equal(installed.status, 0, installed.stderr)
    const plugin = join(home, '.config', 'opencode', 'plugins', 'agent-board-local.js')
    const source = readFileSync(plugin, 'utf8')
    assert.ok(source.includes('session.messages') && !source.includes('transcript'))
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
  writeFileSync(calls + '.timing', '')
  const spawnStub = `import { spawnSync as realSpawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const spawnSync = (file, args, options) => {
  const { session_id, state, cwd } = JSON.parse(options.input)
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ session: session_id, state, isExiting: globalThis.isExiting === true }) + '\\n')
  if (globalThis.isExiting) appendFileSync(${JSON.stringify(exits)}, JSON.stringify(cwd ?? null) + '\\n')
  if (globalThis.isExiting && ${JSON.stringify(mode)} === 'fail') return { status: 1, stdout: '', stderr: '' }
  if (globalThis.isExiting && ${JSON.stringify(mode)} === 'hang') {
    const t0 = performance.now()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.timeout)
    try { appendFileSync(${JSON.stringify(calls + '.timing')}, JSON.stringify({ wait: session_id, asked: options.timeout, t0, t1: performance.now() }) + '\\n') } catch {}
    return { error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGKILL' }
  }
  return realSpawnSync(file, args, options)
}`
  const plugin = join(home, `one-shot-plugin-${mode}-${scenario}.mjs`), main = join(home, `one-shot-${mode}-${scenario}.mjs`)
  const copy = join(home, `one-shot-plugin-${mode}-${scenario}-copy.mjs`)
  assert.ok(source.includes('const hookError = code => {'), 'the timing wrapper for #576 no longer matches the plugin')
  writeFileSync(plugin, source.replace("import { tool } from '@opencode-ai/plugin'", stub).replace("import { spawnSync } from 'node:child_process'", spawnStub)
    // #576: each log write made while exiting is timed, with the log's size before it.
    .replace('const hookError = code => {', `const hookError = code => {
  const t0 = performance.now(), file = ${JSON.stringify(join(home, '.agent-board', 'hook-errors.log'))}
  let size = 0
  try { size = fs.statSync(file).size } catch {}
  try { return timedHookError(code) } finally { if (globalThis.isExiting) try { fs.appendFileSync(${JSON.stringify(calls + '.timing')}, JSON.stringify({ log: code, size, t0, t1: performance.now() }) + '\\n') } catch {} }
}
const timedHookError = code => {`))
  writeFileSync(copy, readFileSync(plugin))
  // Exit listeners run in order, so the ones around the plugin's own time its exit work.
  writeFileSync(main, `import { writeFileSync } from 'node:fs'
const marks = {}
process.on('exit', () => { marks.start = Date.now(); marks.monotonicStart = performance.now(); globalThis.isExiting = true })
const { AgentBoardLocal } = await import(${JSON.stringify(pathToFileURL(plugin).href)})
process.on('exit', () => { marks.end = Date.now(); marks.monotonicEnd = performance.now(); writeFileSync(${JSON.stringify(marks)}, JSON.stringify(marks)) })
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
  return { calls: lines(calls), exitFolders: lines(exits), marks: JSON.parse(readFileSync(marks, 'utf8')), segments: lines(calls + '.timing') }
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
      const spent = run.marks.end - run.marks.start
      // Where the exit's time went (#576), shown on a pass too, so CI runs give the spread.
      const ms = value => value.toFixed(1)
      const segments = `exit took ${spent} ms, ${ms(run.marks.monotonicEnd - run.marks.monotonicStart)} ms monotonic: ${run.segments.map(({ t0, t1, ...what }) => `${JSON.stringify(what)} at ${ms(t0 - run.marks.monotonicStart)} took ${ms(t1 - t0)}`).join('; ')}`
      t.diagnostic(segments)
      assert.equal(readFileSync(log, 'utf8').match(/opencode REPORTER_TIMEOUT/g)?.length, 2)
      assert.ok(spent >= 2000 && spent < 3500, segments)
      for (const session of ['synthetic-one-shot', 'synthetic-second']) assert.equal(oneShotState(text, session), 'waiting', text)
    }
  }, { retry: mode === 'real' && LOST })
})

test('opencode: a reporter that fails while OpenCode exits is logged and does not hold the exit', t => opencodeOneShotHome(t, async (home, progress, log) => {
  const run = opencodeOneShot(home, 'fail', 'two')
  assert.deepEqual(run.calls.filter(call => call.isExiting), ['synthetic-one-shot', 'synthetic-second'].map(session => ({ session, state: 'ended', isExiting: true })))
  assert.equal(readFileSync(log, 'utf8').match(/opencode REPORTER_FAILED/g)?.length, 2)
  const spent = run.marks.end - run.marks.start
  // #1323: the exit fixture has no clock seam for plugin and file I/O work; allow for CI pauses.
  assert.ok(spent < (process.env.CI ? 2000 : 1000), `exit took ${spent} ms`)
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
  const { STRINGS } = await sourceModules()
  // A Chinese board brackets the code in full-width parentheses; the same code comes through.
  for (const lang of ['en', 'zh-TW', 'zh-CN']) await opencodeSpawnFixture(opencodeRealSpawn, async f => {
    assert.ok(readFileSync(join(dirname(f.progress), 'agent-board.mjs'), 'utf8').split('\n', 1)[0].includes(`"lang":"${lang}"`), lang)
    // The step format the model reads is in the board's language and names every mark.
    const plugin = readFileSync(join(dirname(dirname(f.progress)), '.config', 'opencode', 'plugins', 'agent-board-local.js'), 'utf8')
    const format = plugin.slice(plugin.indexOf({ en: 'One Markdown task line', 'zh-TW': '一行 Markdown 任務', 'zh-CN': '一行 Markdown 任务' }[lang])).split(')', 1)[0]
    for (const mark of ['x', '~', ' ', '?', '!', '>', '-']) assert.ok(format.includes(`- [${mark}]`), `${lang} ${mark}`)
    await assert.rejects(f.instance.tool.agent_board_progress.execute({ ...f.payload, title: 'Synthetic refused task', steps: ['Synthetic plain step'] }, f.context), { message: `AGENT_BOARD_REPORT_FAILED: INVALID_STEP: ${STRINGS[lang].reporterInvalidStep('Synthetic plain step')}` })
    assert.ok(!readFileSync(f.progress, 'utf8').includes('Synthetic refused task'))
    assert.match(readFileSync(f.log, 'utf8'), /opencode REPORTER_FAILED INVALID_STEP\r?\n/)
    assert.doesNotMatch(readFileSync(f.log, 'utf8'), /Synthetic plain step/)
  }, { lang })
})

test('an OpenCode report tells the model only how many steps the board left out or shortened', async () => {
  await opencodeSpawnFixture(opencodeRealSpawn, async f => {
    const execute = steps => f.instance.tool.agent_board_progress.execute({ ...f.payload, steps }, f.context)
    assert.equal(await execute(['- [~] Synthetic short step']), 'OK')
    // The reply names neither the session nor the progress file.
    const long = await execute(Array.from({ length: 41 }, (_, index) => `- [ ] Synthetic step ${index + 1}`))
    assert.deepEqual(JSON.parse(long), { dropped: 1, cut: 0 })
    const cut = await execute([`- [ ] ${'x'.repeat(130)}`])
    assert.deepEqual(JSON.parse(cut), { dropped: 0, cut: 1 })
    for (const reply of [long, cut]) assert.doesNotMatch(reply, /session|progress|[\\/]/)
  })
})

test('a report tool reply is both counts or OK, even when a count is missing or not a whole number', () => {
  const toolReply = new Function(`${REPORT_TOOL_REPLY}return toolReply`)()
  assert.equal(toolReply('{"cut":1}'), '{"dropped":0,"cut":1}')
  assert.equal(toolReply('{"dropped":2,"session":"s","progress":"p"}'), '{"dropped":2,"cut":0}')
  assert.equal(toolReply('{"dropped":"3","cut":1.5}'), 'OK')
  assert.equal(toolReply('{"dropped":0,"cut":0,"session":"s"}'), 'OK')
  for (const text of ['', 'null', '[]', 'not json']) assert.equal(toolReply(text), 'OK', text)
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
  assert.ok(existsSync(join(f.env.OPENCODE_CONFIG_DIR, 'commands', 'agent-board.md')))
  assert.ok(!existsSync(join(f.home, '.config', 'opencode')))
  assert.equal(JSON.parse(f.command(['--codex-doctor', '--agent', 'opencode', '--json']).stdout).installed, true)
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
  const preview = spawnSync(process.execPath, [resolve('scripts/setup-agent.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--json'], {env:f.env, encoding:'utf8', windowsHide:true})
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

test('OpenClaw re-apply refuses a user-removed plugin path or allowlist entry without writing', async () => {
  for (const editedPart of ['path', 'allow']) await fixture(f => {
    const file = join(f.home, '.openclaw', 'openclaw.json')
    f.save(file, JSON.stringify({ plugins: { allow: ['user-only'] } }))
    assert.equal(f.install('--agent', 'openclaw', '--apply').status, 0)
    const config = JSON.parse(readFileSync(file, 'utf8'))
    if (editedPart === 'path') config.plugins.load.paths = []
    else config.plugins.allow = ['user-only']
    f.save(file, JSON.stringify(config))
    const before = homeSnapshot(f.home)
    const result = f.install('--agent', 'openclaw', '--apply')
    assert.notEqual(result.status, 0, editedPart)
    assert.ok(JSON.parse(result.stdout).conflicts.includes(`${file}:agent-board-local`), editedPart)
    assert.deepEqual(homeSnapshot(f.home), before, editedPart)
  })
})

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
    assert.deepEqual([...hooks.keys()], ['session_start', 'session_end', 'after_tool_call'])
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

test('OpenClaw session events carry the session folder and progress_card reports to the plugin session', () => fixture(async f => {
  assert.equal(f.install('--agent', 'openclaw', '--apply').status, 0)
  const plugin = (await import(pathToFileURL(join(f.root, 'adapters', 'openclaw', 'agent-board-local.mjs')))).default
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'adapters', 'openclaw', 'openclaw.plugin.json'))).contracts, { tools: ['progress_card'] })
  const work = join(f.home, 'work'), other = join(f.home, 'other')
  mkdirSync(work)
  mkdirSync(other)
  const hooks = new Map()
  let subscription, factory, options
  plugin.register({
    on: (name, fn) => hooks.set(name, fn), config: {}, runtime: { agent: { resolveAgentWorkspaceDir: () => work } },
    registerTool: (value, given) => { factory = value; options = given },
    agent: { events: { registerAgentEventSubscription: value => { subscription = value } } },
  })
  assert.deepEqual(options, { names: ['progress_card'] })
  const id = 'openclaw-folder-session-1'
  const record = () => JSON.parse(readFileSync(join(f.root, 'sessions', createHash('sha256').update(`openclaw:${id}`).digest('hex') + '.json'), 'utf8'))
  // Session start has no workspace in its context: the default agent workspace names the folder.
  await hooks.get('session_start')({ sessionId: id }, { sessionId: id })
  const digestOf = folder => createHash('sha256').update(process.platform === 'win32' ? resolve(folder).toLowerCase() : resolve(folder)).digest('hex')
  assert.equal(record().folderDigest, digestOf(work))
  assert.equal(record().project, 'work')
  // The report command finds that record by its folder.
  const bound = folderReport(f, work, reportPayload, ['--agent', 'openclaw'])
  assert.equal(bound.status, 0, bound.stderr)
  // The tool factory's context names the session's real workspace, which the lifecycle events then carry.
  assert.equal(factory({}), null)
  const tool = factory({ sessionId: id, workspaceDir: other })
  await subscription.handle({ stream: 'lifecycle', sessionId: id, runId: 'folder-run-1', data: { phase: 'start' } })
  assert.equal(record().folderDigest, digestOf(other))
  // No hook that receives the prompt or the conversation is registered.
  for (const name of ['before_prompt_build', 'agent_turn_prepare', 'before_model_resolve', 'before_agent_reply', 'llm_input', 'llm_output', 'before_agent_finalize', 'agent_end', 'before_agent_run', 'before_agent_start']) assert.ok(!hooks.has(name), name)
  assert.equal(tool.name, 'progress_card')
  assert.deepEqual(tool.parameters.required, ['steps'])
  // The plugin reads no reply text: the tool description and the installed skill both tell the agent
  // to send a closing question as a [?] step before the turn ends.
  assert.match(tool.description, /- \[\?\] <the question>/)
  assert.match(tool.description, /before you end the turn/)
  const skillText = readFileSync(join(f.home, '.openclaw', 'skills', 'agent-board', 'SKILL.md'), 'utf8')
  assert.match(skillText, /OpenClaw use the progress_card tool/)
  assert.match(skillText, /`- \[\?\] <the question>` step with state waiting, before ending the turn/)
  await tool.execute('call-1', { title: 'OpenClaw task', state: 'waiting', steps: ['- [?] Pick one', '- [ ] Continue'] })
  assert.equal(record().state, 'waiting')
  assert.equal(record().title, 'OpenClaw task')
  assert.match(readFileSync(f.progress, 'utf8'), /^- \[\?\] Pick one$/m)
  await assert.rejects(tool.execute('call-2', { steps: 'not a list' }), /INVALID_STEPS/)
  await assert.rejects(tool.execute('call-3', { title: 'Invalid', state: 'working', steps: ['not a task line'] }), /Cannot read the step "not a task line".*- \[ \] step/)
  const full = await tool.execute('call-4', { title: 'Many steps', state: 'working', steps: Array.from({ length: 40 }, (_, index) => `- [ ] Step ${index + 1}`) })
  assert.equal(full.content[0].text, 'OK')
  const long = await tool.execute('call-5', { title: 'Many steps', state: 'working', steps: Array.from({ length: 41 }, (_, index) => `- [ ] Step ${index + 1}`) })
  // The model is told how many steps were left out, and nothing about the session or the file.
  const reply = JSON.parse(long.content[0].text)
  assert.deepEqual(Object.keys(reply).sort(), ['cut', 'dropped'])
  assert.equal(reply.dropped, 1)
  assert.doesNotMatch(long.content[0].text, /session|progress|[\\/]/)
  // A shortened step is counted too, even in a short list.
  const cut = await tool.execute('call-6', { title: 'Many steps', state: 'working', steps: [`- [ ] ${'x'.repeat(130)}`] })
  assert.deepEqual(JSON.parse(cut.content[0].text), { dropped: 0, cut: 1 })
}))

test('OpenClaw progress_card derives omitted fields from steps and uses the host workspace on the first report', () => fixture(async f => {
  const installed = f.install('--agent', 'openclaw', '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const plugin = (await import(pathToFileURL(join(f.root, 'adapters', 'openclaw', 'agent-board-local.mjs')))).default
  const work = join(f.home, 'work'), other = join(f.home, 'other')
  mkdirSync(work)
  mkdirSync(other)
  const hooks = new Map()
  let factory, subscription
  plugin.register({
    on: (name, fn) => hooks.set(name, fn), config: {}, runtime: { agent: { resolveAgentWorkspaceDir: () => work } },
    registerTool: make => { factory = make },
    agent: { events: { registerAgentEventSubscription: value => { subscription = value } } },
  })
  const id = 'openclaw-progress-defaults'
  const recordOf = session => join(f.root, 'sessions', createHash('sha256').update('openclaw:' + session).digest('hex') + '.json')
  const record = () => JSON.parse(readFileSync(recordOf(id), 'utf8'))
  await hooks.get('session_start')({ sessionId: id })
  assert.equal(record().project, 'work')
  const tool = factory({ sessionId: id, workspaceDir: other })
  const waiting = ['1. [~] Check the result', '+ [?] Continue the synthetic check?']
  const first = await tool.execute('defaults', { steps: waiting })
  assert.equal(first.content[0].text, 'OK')
  assert.equal(record().project, 'other')
  assert.equal(record().title, 'Check the result')
  assert.equal(record().state, 'waiting')
  assert.deepEqual(record().steps, ['- [~] Check the result', '- [?] Continue the synthetic check?'])
  const board = readFileSync(f.progress, 'utf8')
  assert.match(board, /^## other\r?\n[\s\S]*^### Check the result\r?$/m)
  assert.equal(board.split('### Check the result').length, 2)
  assert.ok(!board.includes(other))

  await subscription.handle({ stream: 'lifecycle', sessionId: id, runId: 'openclaw-defaults-run', data: { phase: 'start' } })
  await tool.execute('state-only', { state: 'waiting', steps: ['- [?] Keep it?'] })
  assert.equal(record().title, 'Keep it?')
  assert.equal(record().state, 'waiting')
  const injected = 'synthetic-other-session'
  await tool.execute('title-only', { title: 'Keep my title', steps: ['- Continue'], sessionId: injected, workspaceDir: work, project: 'wrong' })
  assert.equal(record().title, 'Keep my title')
  assert.equal(record().state, 'working')
  assert.equal(record().project, 'other')
  assert.equal(existsSync(recordOf(injected)), false)
  await assert.rejects(tool.execute('bad-state', { state: 'missing', steps: ['- [ ] Continue'] }), /INVALID_STATE/)
  await assert.rejects(tool.execute('bad-title', { title: null, steps: ['- [ ] Continue'] }), /INVALID_TEXT/)
}))

test('a report from a folder binds to an openclaw record that holds the folder and refuses one that does not', () => fixture(f => {
  f.install('--agent', 'openclaw', '--apply')
  const cwd = join(f.home, 'demo')
  mkdirSync(cwd)
  const normalized = resolve(cwd)
  const folderDigest = createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex')
  const id = 'synthetic-openclaw-session'
  const saveRecord = extra => f.save(join(f.root, 'sessions', createHash('sha256').update(`openclaw:${id}`).digest('hex') + '.json'), JSON.stringify({ session: id, agent: 'openclaw', state: 'waiting', updated: new Date().toISOString(), ...extra }))
  saveRecord({})
  const refused = folderReport(f, cwd, reportPayload, ['--agent', 'openclaw'])
  assert.notEqual(refused.status, 0)
  assert.equal(refused.stderr.trim(), 'This report is not bound to a session; continue your work without editing the board.')
  saveRecord({ folder: 'demo', folderDigest })
  const bound = folderReport(f, cwd, reportPayload, ['--agent', 'openclaw'])
  assert.equal(bound.status, 0, bound.stderr)
}))

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

test('DeepSeek session events carry the session folder and the agent_board tool reports to the plugin session', () => fixture(async f => {
  f.env.DSH_HOME = join(f.home, '.dsh')
  assert.equal(f.install('--agent', 'deepseek', '--apply').status, 0)
  const plugin = await import(pathToFileURL(join(f.root, 'adapters', 'deepseek.mjs')))
  assert.equal(plugin.inject, undefined, 'tools stay optional: a missing service must not stop the lifecycle events')
  const work = join(f.home, 'work')
  mkdirSync(work)
  const hooks = new Map(), tools = []
  plugin.apply({ on: (name, fn) => hooks.set(name, fn), inject: (_names, fn) => fn({ tools: { register: tool => tools.push(tool) } }) })
  // No hook that receives the prompt, the messages or the model is registered.
  assert.deepEqual([...hooks.keys()].sort(), ['agent/created', 'agent/disposed', 'agent/status'])
  assert.equal(tools.length, 1)
  const [tool] = tools
  assert.equal(tool.name, 'agent_board')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, ['report', 'open'])
  assert.match(tool.description, /- \[\?\] <the question>/)
  const id = 'deepseek-folder-session-1'
  const agent = { session: { header: { id, cwd: work } }, status: 'idle' }
  const record = () => JSON.parse(readFileSync(join(f.root, 'sessions', createHash('sha256').update(`deepseek:${id}`).digest('hex') + '.json'), 'utf8'))
  await hooks.get('agent/created')({ agent })
  const digestOf = folder => createHash('sha256').update(process.platform === 'win32' ? resolve(folder).toLowerCase() : resolve(folder)).digest('hex')
  assert.equal(record().folderDigest, digestOf(work))
  assert.equal(record().project, 'work')
  assert.equal(record().agent, 'deepseek')
  const skillText = readFileSync(join(f.env.DSH_HOME, 'skills', 'agent-board', 'SKILL.md'), 'utf8')
  assert.match(skillText, /In DeepSeek, do not run the board command in a shell; use the agent_board tool/)
  assert.match(skillText, /action open to open the board/)
  await tool.execute({ action: 'report', title: 'DeepSeek task', state: 'waiting', steps: ['- [?] Pick one', '- [ ] Continue'] }, { agent })
  assert.equal(record().state, 'waiting')
  assert.equal(record().title, 'DeepSeek task')
  assert.match(readFileSync(f.progress, 'utf8'), /^- \[\?\] Pick one$/m)
  await assert.rejects(tool.execute({ action: 'report', steps: 'not a list' }, { agent }), /AGENT_BOARD_REPORT_FAILED: INVALID_STEPS/)
  await assert.rejects(tool.execute({ action: 'report', title: 'Invalid', state: 'working', steps: ['not a task line'] }, { agent }), /Cannot read the step "not a task line".*- \[ \] step/)
  const full = await tool.execute({ action: 'report', title: 'Many steps', state: 'working', steps: Array.from({ length: 40 }, (_, index) => `- [ ] Step ${index + 1}`) }, { agent })
  assert.equal(full.text, 'OK')
  const long = await tool.execute({ action: 'report', title: 'Many steps', state: 'working', steps: Array.from({ length: 41 }, (_, index) => `- [ ] Step ${index + 1}`) }, { agent })
  // The model is told how many steps were left out, and nothing about the session or the file.
  const reply = JSON.parse(long.text)
  assert.deepEqual(Object.keys(reply).sort(), ['cut', 'dropped'])
  assert.equal(reply.dropped, 1)
  assert.doesNotMatch(long.text, /session|progress|[\\/]/)
  // A shortened step is counted too, even in a short list.
  const cut = await tool.execute({ action: 'report', title: 'Many steps', state: 'working', steps: [`- [ ] ${'x'.repeat(130)}`] }, { agent })
  assert.deepEqual(JSON.parse(cut.text), { dropped: 0, cut: 1 })
  await assert.rejects(tool.execute({ action: 'report', steps: ['- [x] Done'] }, {}), /AGENT_BOARD_REPORT_FAILED: NO_SESSION/)
  await assert.rejects(tool.execute({ action: 'close' }, { agent }), /AGENT_BOARD_REPORT_FAILED: INVALID_ACTION/)
}))

test('DeepSeek lifecycle events still save when the host has no tools service', () => fixture(async f => {
  f.env.DSH_HOME = join(f.home, '.dsh')
  assert.equal(f.install('--agent', 'deepseek', '--apply').status, 0)
  const plugin = await import(pathToFileURL(join(f.root, 'adapters', 'deepseek.mjs')))
  const hooks = new Map()
  let injected = 0
  // A bare context: inject is there but never runs its callback, as with no tools service.
  plugin.apply({ on: (name, fn) => hooks.set(name, fn), inject: () => { injected++ } })
  assert.equal(injected, 1)
  const id = 'deepseek-no-tools-session'
  await hooks.get('agent/created')({ agent: { session: { header: { id } }, status: 'idle' } })
  assert.match(readFileSync(f.progress, 'utf8'), /agent=deepseek .*state=waiting/)
  await hooks.get('agent/disposed')({ agent: { session: { header: { id } } } })
  assert.match(readFileSync(f.progress, 'utf8'), /state=ended/)
}))

test('the DeepSeek tool reports by session id, and opens the board detached without keeping its address', () => fixture(async f => {
  const portable = await (async () => {
    const resolver = registerHooks({ resolve(specifier, context, next) {
      try { return next(specifier, context) } catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
        return next(`${specifier}.ts`, context)
      }
    } })
    try { return await import('../hooks/portable-agents.ts') } finally { resolver.deregister() }
  })()
  const worker = join(f.root, 'agent-board-hook.mjs'), board = join(f.root, 'agent-board.mjs')
  const calls = [], children = []
  let answer = { status: 0, stdout: '', stderr: '' }
  const spawned = (command, args, options) => {
    const listeners = {}, outputs = {}
    const child = {
      unrefs: 0, command, args: [...args], options,
      on: (name, fn) => { listeners[name] = fn },
      fail: () => listeners.error?.(new Error('synthetic spawn failure')),
      unref() { child.unrefs++ },
      stdout: { setEncoding() {}, on: (name, fn) => { outputs[name] = fn }, destroy() { child.destroyed = true } },
      print: (text, code) => { outputs.data?.(Buffer.from(text)); listeners.close?.(code) },
    }
    children.push(child)
    return child
  }
  const source = portable.deepseekLocalPlugin(process.execPath, worker, f.progress, f.home, board)
  const { apply } = new Function('createRequire', 'spawnSync', 'spawn', `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace(/^export /gm, '')}\nreturn { apply }`)(createRequire, (command, args, options) => { calls.push({ command, args: [...args], options, input: options.input }); return answer }, spawned)
  const hooks = new Map(), tools = []
  apply({ on: (name, fn) => hooks.set(name, fn), inject: (_names, fn) => fn({ tools: { register: tool => tools.push(tool) } }) })
  const [tool] = tools
  const work = join(f.home, 'session-folder')
  const agent = { session: { header: { id: 'deepseek-tool-session-2', cwd: work } }, status: 'idle' }
  // Lifecycle payloads carry the folder from the session header, and only when it has one.
  await hooks.get('agent/created')({ agent })
  await hooks.get('agent/created')({ agent: { session: { header: { id: 'deepseek-no-folder' } }, status: 'idle' } })
  assert.equal(JSON.parse(calls[0].input).cwd, work)
  assert.equal('cwd' in JSON.parse(calls[1].input), false)
  calls.length = 0
  // The report names the agent and the session and runs from the session folder.
  const done = await tool.execute({ action: 'report', title: 'T', state: 'done', steps: ['- [x] One'] }, { agent })
  assert.deepEqual(done, { text: 'OK' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, process.execPath)
  assert.equal(calls[0].args[0], worker)
  for (const word of ['--codex-report', '--agent', 'deepseek', '--session', 'deepseek-tool-session-2']) assert.ok(calls[0].args.includes(word), word)
  assert.equal(calls[0].args[calls[0].args.indexOf('--agent') + 1], 'deepseek')
  assert.equal(calls[0].args[calls[0].args.indexOf('--session') + 1], 'deepseek-tool-session-2')
  assert.equal(calls[0].options.cwd, undefined, 'the writer binds by session id, so a missing folder cannot fail the report')
  assert.deepEqual(JSON.parse(calls[0].input), { steps: ['- [x] One'], title: 'T', state: 'done' })
  // A refused report names the board's reason.
  answer = { status: 1, stdout: '', stderr: 'AGENT_BOARD_REASON INVALID_STEP\n' }
  await assert.rejects(tool.execute({ action: 'report', steps: ['- [x] One'] }, { agent }), { message: 'AGENT_BOARD_REPORT_FAILED: INVALID_STEP' })
  answer = { status: 1, stdout: '', stderr: 'free text\n' }
  await assert.rejects(tool.execute({ action: 'report', steps: ['- [x] One'] }, { agent }), { message: 'AGENT_BOARD_REPORT_FAILED' })
  // open starts the board's own command detached and returns the one line it prints.
  const link = 'http://127.0.0.1:43210/?t=synthetic-token'
  const opened = tool.execute({ action: 'open' }, { agent })
  const [child] = children
  assert.equal(child.command, process.execPath)
  assert.deepEqual(child.args, [board, '--html'])
  assert.equal(child.options.detached, true)
  assert.equal(child.options.windowsHide, true)
  assert.equal(child.options.stdio[0], 'ignore')
  assert.equal(child.unrefs, 1)
  child.print(`${link}\n`, 0)
  assert.deepEqual(await opened, { text: link })
  assert.equal(child.destroyed, true)
  // A failed start returns its line and no address; the address is in no log.
  const refused = tool.execute({ action: 'open' }, { agent })
  children[1].print('This AI\'s sandbox can\'t write the board page\'s address folder.\n', 1)
  await assert.rejects(refused, /^Error: AGENT_BOARD_OPEN_FAILED: This AI's sandbox/)
  // A spawn error, and an exit 0 with nothing printed, both fail the call.
  const broken = tool.execute({ action: 'open' }, { agent })
  children[2].fail()
  await assert.rejects(broken, { message: 'AGENT_BOARD_OPEN_FAILED' })
  const silent = tool.execute({ action: 'open' }, { agent })
  children[3].print('', 0)
  await assert.rejects(silent, { message: 'AGENT_BOARD_OPEN_FAILED' })
  const log = join(f.root, 'hook-errors.log')
  if (existsSync(log)) assert.ok(!readFileSync(log, 'utf8').includes('127.0.0.1'))
  assert.equal(tool.output.render({}, { text: link })[0].text, link)
}))

test('deepseekLocalPlugin ignores subagents and gives a waiting board message to an idle root agent through agent.followup (#725)', () => fixture(async f => {
  const portable = await importTs('../hooks/portable-agents.ts')
  const { defaultMessagesDirectory } = await importTs('../scripts/runtime-folder.ts')
  const { enrollMailbox, mailboxId } = await importTs('../hooks/hook-messages.ts')
  const { queueMessage } = await importTs('../hooks/messaging.ts')
  const { randomUUID } = await import('node:crypto')
  const { watch } = await import('node:fs')
  const board = join(f.home, 'deepseek-board.mjs')
  f.save(board, bundleFromDir(new URL('..', import.meta.url)))
  const progress = join(f.home, 'deepseek-progress.md')
  f.save(progress, '')
  // The plugin runs inside dsh, and its board calls inherit that process's environment: here, this test's.
  const directory = defaultMessagesDirectory(progress, f.home, process.env, process.platform)
  const file = join(directory, 'messages.json')
  const store = () => JSON.parse(readFileSync(file, 'utf8'))
  const status = id => store().messages.find(one => one.id === id)?.status
  const queue = (state, session, id, text) => {
    const now = Date.now()
    const enrolled = enrollMailbox(state, 'deepseek', session, 'dsh', now, 43_200_000)
    const target = enrolled.mailboxes.find(one => one.id === mailboxId('deepseek', session))
    f.save(file, JSON.stringify({ version: 2, ...queueMessage(enrolled, { id, target: target.id, turn: 'session', text }, 'board', target, now).state }))
  }
  queue({ messages: [] }, 'deepseek-subagent-session', 'subagent-message', 'Synthetic subagent text')
  queue(store(), 'deepseek-root-session', 'root-message-1', 'Synthetic answer: blue')
  // Every board call the plugin starts is a real child of the board script; the test waits for each to close.
  const children = []
  const spawnMailbox = (...args) => {
    const child = spawn(...args)
    children.push(child)
    child.on('close', () => { child.isClosed = true })
    return child
  }
  const settled = () => children.every(child => child.isClosed)
  const until = async (check, label) => {
    for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(done => setTimeout(done, 50))) if (check()) return
    assert.fail(label)
  }
  const source = portable.deepseekLocalPlugin(process.execPath, join(f.root, 'agent-board-hook.mjs'), progress, f.home, board)
  const names = ['createRequire', 'spawnSync', 'spawn', 'spawnMailbox', 'randomUUID', 'existsSync', 'readFileSync', 'watch', 'join']
  const { apply } = new Function(...names, `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace(/^export /gm, '')}\nreturn { apply }`)(createRequire, () => ({ status: 0, stdout: '', stderr: '' }), () => { throw new Error('UNUSED') }, spawnMailbox, randomUUID, existsSync, readFileSync, watch, join)
  const fake = (id, header = {}) => {
    const agent = { session: { header: { id, ...header } }, status: 'idle', received: [], followup(message) { agent.received.push(message); agent.status = 'running' } }
    return agent
  }
  const root = fake('deepseek-root-session'), sub = fake('deepseek-subagent-session', { origin: 'subagent', parentSession: 'deepseek-root-session' })
  const hooks = new Map()
  try {
    apply({ on: (name, fn) => hooks.set(name, fn) })
    hooks.get('agent/created')({ agent: sub })
    hooks.get('agent/created')({ agent: root })
    await until(() => status('root-message-1') === 'accepted' && settled(), 'the root session took its message')
    assert.equal(root.received.length, 1)
    const [message] = root.received
    assert.equal(message.role, 'user')
    // dsh's page shows it as one folded line, the board and the answer.
    assert.deepEqual(message.source, { kind: 'agent-board', form: 'notice', summary: 'Synthetic answer: blue' })
    assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.ok(Object.isFrozen(message) && Object.isFrozen(message.content) && Object.isFrozen(message.content[0]))
    assert.deepEqual(message.content.map(one => one.type), ['text'])
    assert.ok(message.content[0].text.includes('Synthetic answer: blue'))
    const nonce = store().messages.find(one => one.id === 'root-message-1').nonce
    assert.match(message.content[0].text, new RegExp(`ACK ${nonce}`))
    // A subagent's session never enrolls or receives: its message waits, untouched.
    assert.deepEqual(sub.received, [])
    assert.equal(status('subagent-message'), 'queued')
    assert.ok(!children.some(child => child.spawnargs.includes('deepseek-subagent-session')))
    // A message that comes while the session works waits for it to go idle.
    queue(store(), 'deepseek-root-session', 'root-message-2', 'Synthetic second answer')
    await new Promise(done => setTimeout(done, 600))
    assert.equal(root.received.length, 1)
    assert.equal(status('root-message-2'), 'queued')
    root.status = 'idle'
    hooks.get('agent/status')({ agent: root, status: 'idle' })
    await until(() => status('root-message-2') === 'accepted' && settled(), 'the session took the message at idle')
    assert.equal(root.received.length, 2)
    // An idle session takes a new message as soon as the board writes it, with no event from dsh.
    root.status = 'idle'
    queue(store(), 'deepseek-root-session', 'root-message-3', 'Synthetic third answer')
    await until(() => status('root-message-3') === 'accepted' && settled(), 'the idle session took the new message')
    assert.equal(root.received.length, 3)
    assert.ok(root.received[2].content[0].text.includes('Synthetic third answer'))
    // A closed session ends its mailbox, so its card no longer offers Send.
    hooks.get('agent/disposed')({ agent: root })
    await until(() => !store().mailboxes.some(one => one.id === mailboxId('deepseek', 'deepseek-root-session')) && settled(), 'the closed session ended its mailbox')
    const log = join(f.home, '.agent-board', 'hook-errors.log')
    if (existsSync(log)) assert.ok(!readFileSync(log, 'utf8').includes('MAILBOX_FAILED'), readFileSync(log, 'utf8'))
    // A board script that cannot answer is logged, once, however often the session asks.
    const broken = portable.deepseekLocalPlugin(process.execPath, join(f.root, 'agent-board-hook.mjs'), progress, f.home, join(f.home, 'missing-board.mjs'))
    const failed = new Function(...names, `${broken.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace(/^export /gm, '')}\nreturn { apply }`)(createRequire, () => ({ status: 0, stdout: '', stderr: '' }), () => { throw new Error('UNUSED') }, spawnMailbox, randomUUID, existsSync, readFileSync, watch, join)
    const failedHooks = new Map()
    failed.apply({ on: (name, fn) => failedHooks.set(name, fn) })
    const lonely = fake('deepseek-lonely-session')
    failedHooks.get('agent/created')({ agent: lonely })
    const failures = () => existsSync(log) ? readFileSync(log, 'utf8').split('MAILBOX_FAILED').length - 1 : 0
    await until(() => failures() === 1 && settled(), 'a failed take was logged')
    const taken = children.length
    failedHooks.get('agent/status')({ agent: lonely, status: 'idle' })
    await until(() => children.length === taken + 1 && settled(), 'the second take ran and closed')
    assert.equal(failures(), 1)
    assert.deepEqual(lonely.received, [])
    failedHooks.get('agent/disposed')({ agent: lonely })
    await until(settled, 'the end call closed')
    // A take asked for while another is under way runs right after it, with no further event from dsh.
    const quick = fake('deepseek-quick-session')
    const takes = () => children.filter(child => child.spawnargs.includes('take') && child.spawnargs.includes('deepseek-quick-session')).length
    hooks.get('agent/created')({ agent: quick })
    hooks.get('agent/status')({ agent: quick, status: 'idle' })
    await until(() => takes() === 2 && settled(), 'the second take ran right after the first')
    // A followup that fails is logged and never marked delivered: its claim runs out and the board hands it out again.
    quick.followup = () => Promise.reject(new Error('SYNTHETIC'))
    queue(store(), 'deepseek-quick-session', 'quick-message', 'Synthetic refused answer')
    hooks.get('agent/status')({ agent: quick, status: 'idle' })
    await until(() => failures() === 2 && settled(), 'the failed followup was logged')
    assert.notEqual(status('quick-message'), 'accepted')
    hooks.get('agent/disposed')({ agent: quick })
    await until(settled, 'the quick session ended')
  } finally {
    // A failed check leaves no board call running: each one is stopped and waited for, on Windows too.
    for (const child of children) if (!child.isClosed) child.kill()
    for (const end = Date.now() + 10_000; !settled() && Date.now() < end;) await new Promise(done => setTimeout(done, 50))
  }
}))

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
  const args = [resolve('scripts/setup-agent.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--json']
  const run = () => spawnSync(process.execPath, args, { env: f.env, encoding: 'utf8', windowsHide: true })
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).targets, ['antigravity'])
  assert.equal(existsSync(join(f.home, '.gemini', 'settings.json')), false)
  f.save(join(f.home, '.gemini', 'settings.json'), '{}')
  assert.deepEqual(JSON.parse(run().stdout).targets, ['gemini', 'antigravity'])
}))

test('all targets initialize one shared board and name each adapter capability', () => fixture(f => {
  const installer = resolve('scripts/setup-agent.mjs')
  const result = spawnSync(process.execPath, [installer, '--agent', 'all', '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--apply', '--json'], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, `${JSON.stringify({ error: result.error?.code, signal: result.signal })}\n${result.stderr}`)
  const plans = JSON.parse(result.stdout).plans
  assert.equal(plans.length, 10)
  assert.equal(new Set(plans.map(plan => plan.progress)).size, 1)
  assert.equal(plans.find(plan => plan.agent === 'hermes').capabilities.lifecycle, 'adapter-installed-unverified')
  for (const agent of ['openclaw', 'deepseek']) assert.equal(plans.find(plan => plan.agent === agent).capabilities.lifecycle, 'adapter-installed-unverified')
  assert.equal(plans.find(plan => plan.agent === 'antigravity').capabilities.lifecycle, 'adapter-installed-unverified')
  assert.ok(existsSync(join(f.home, '.gemini', 'commands', 'agent-board.toml')))
  assert.ok(existsSync(join(f.home, '.hermes', 'skills', 'agent-board', 'SKILL.md')))
  assert.match(readFileSync(join(f.home, '.hermes', 'config.yaml'), 'utf8'), /^hooks:\n {2}on_session_start:\n/)
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

test('Windows Muse Code hooks run when the host escapes each quote for cmd, as Muse Code 1.4.14 does', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  const home = join(f.home, 'muse home')
  mkdirSync(home)
  const env = isolatedEnv(home)
  const installed = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'muse', '--apply'], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(installed.status, 0, installed.stderr)
  const hooks = JSON.parse(readFileSync(join(home, '.config', 'muse', 'settings.json'), 'utf8')).hooks
  const record = join(home, '.agent-board', 'sessions', createHash('sha256').update('muse:synthetic-muse-session').digest('hex') + '.json')
  for (const [event, state] of [['UserPromptSubmit', 'working'], ['Stop', 'waiting'], ['SessionEnd', 'ended']]) {
    const command = hooks[event][0].hooks[0].command
    assert.ok(!command.includes('"'), command)
    // Without verbatim arguments Node quotes this one argument as Muse does: each quote inside becomes \".
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], { env, input: JSON.stringify({ session_id: 'synthetic-muse-session' }), encoding: 'utf8', windowsHide: true, timeout: 15000 })
    assert.equal(result.status, 0, hookFailure(result))
    assert.equal(JSON.parse(readFileSync(record, 'utf8')).state, state, event)
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
  // Both stay real copies: a hard link shares node.exe's inode with the Node on PATH and the decoy, and would hide a wrong pick.
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


test('Windows Antigravity fallback commands stay within the command limit at long installation paths', async () => {
  const { antigravityCommand, hookCommandArgs, windowsHookCommand } = await importTs('../hooks/local-agents.ts')
  const { connectDataRoots } = await importTs('../hooks/connect-pure.ts')
  const quote = value => "'" + value.replace(/['‘’‚‛]/g, mark => mark + mark) + "'"
  for (const length of [150, 160, 180]) {
    const home = 'C:\\synthetic ' + 'h'.repeat(length - 'C:\\synthetic '.length)
    const folder = home + '\\.agent-board'
    for (const name of ['agent-board-hook.mjs', 'progress-hook.mjs']) {
      const argv = hookCommandArgs(home + '\\n s\\node.exe', home, 'antigravity', folder + '\\' + name, folder + '\\progress.md', 'Stop', 'waiting')
      assert.ok(windowsHookCommand(argv, quote).length >= 8191, 'the fixture must reach the overlong fallback')
      const command = antigravityCommand(argv, true, quote)
      assert.ok(command.length < 8191, String(command.length) + ' characters at home length ' + length)
      if (name === 'progress-hook.mjs') {
        assert.ok(connectDataRoots(command).includes(folder))
        assert.ok(connectDataRoots(JSON.stringify({ command })).includes(folder))
      }
    }
  }
})

test('compact Antigravity fallback preserves hook arguments and Codex trust command bytes', async () => {
  const { antigravityCommand, hookCommandArgs, windowsHookCommand } = await importTs('../hooks/local-agents.ts')
  const quote = value => "'" + value.replace(/['‘’‚‛]/g, mark => mark + mark) + "'"
  const goldenHome = "C:\\synthetic f'‘’‚‛雪"
  const golden = hookCommandArgs('C:\\node space\\node.exe', goldenHome, 'codex', goldenHome + '\\.agent-board\\agent-board-hook.mjs', goldenHome + '\\.agent-board\\progress.md', 'Stop')
  // These hashes are the main commands before #705; Codex trust binds their exact bytes.
  assert.equal(createHash('sha256').update(windowsHookCommand(golden, quote)).digest('hex'), '456338c74f0b3302852162939307e11ad4dd1b8796e0acb34d5326f609f41cb6')
  assert.equal(createHash('sha256').update(windowsHookCommand(golden, quote, 'C:\\NODE~1\\node.exe')).digest('hex'), '3a10d8477c5f6e44aba0025019403638c42a35aaa1145d083a867200182a1791')
  if (process.platform !== 'win32') return
  await fixture(async f => {
    const prefix = "long f's 雪-"
    const home = join(f.home, prefix + 'h'.repeat(Math.max(0, 160 - f.home.length - prefix.length - 1)))
    const root = join(home, '.agent-board')
    mkdirSync(root, { recursive: true })
    const runtime = join(f.home, 'n s')
    mkdirSync(runtime)
    const node = join(runtime, 'node.exe')
    placeNode(node)
    const worker = join(root, 'agent-board-hook.mjs')
    const capture = join(root, 'synthetic-long-fallback.json')
    const stdout = 'synthetic compact stdout\n', stderr = 'synthetic compact stderr\n'
    writeFileSync(worker, syntheticWindowsWrapperWorker(capture, stdout, stderr, 37))
    const argv = hookCommandArgs(node, home, 'antigravity', worker, join(root, 'progress.md'), 'Stop', 'waiting')
    assert.ok(windowsHookCommand(argv, quote).length >= 8191, 'exercise the compact branch')
    const command = antigravityCommand(argv, true, quote)
    assert.ok(command.length < 8191, String(command.length) + ' characters')
    const input = JSON.stringify({ unicode: '雪', apostrophe: "O'Hara", quotes: '"‘’‚‛“”', newline: 'line one\nline two' }, null, 2)
    assert.ok(input.includes('\n'), 'the command receives multiline JSON stdin')
    const result = await fireCommand(f, command, input)
    assert.equal(result.status, 37, hookFailure(result))
    assert.equal(result.stdout, stdout)
    assert.equal(result.stderr, stderr)
    const saved = JSON.parse(readFileSync(capture, 'utf8'))
    assert.equal(saved.worker, worker)
    assert.equal(saved.input, input)
    assert.deepEqual(saved.argv.slice(0, -2), argv.slice(5))
    assert.equal(saved.argv.at(-2), '--hook-started')
    assert.ok(Number.isSafeInteger(Number(saved.argv.at(-1))) && Number(saved.argv.at(-1)) > 0)
  })
})

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
  const expected = windowsHookNode(process.execPath)
  let checked = 0
  for (const groups of Object.values(JSON.parse(readFileSync(f.hooks, 'utf8')).hooks)) {
    for (const group of groups) for (const { command } of group.hooks) {
      if (!command.includes('--hook-event') && !/^powershell\.exe /i.test(command)) continue
      // On Windows Codex runs the line through PowerShell, so the program goes first unquoted (#623).
      if (process.platform !== 'win32') assert.ok(command.startsWith(`"${process.execPath}" "--input-type=commonjs" "-e" "eval(Buffer.from('`))
      else if (expected === undefined) assert.match(command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand /)
      else assert.ok(command.startsWith(`${expected} "--input-type=commonjs" "-e" "eval(Buffer.from('`), command.slice(0, 120))
      if (process.platform !== 'win32' || expected !== undefined) assert.doesNotMatch(command, /powershell/i)
      checked++
    }
  }
  assert.ok(checked >= 4, `${checked} owned Codex commands checked`)

  const antigravity = f.install('--agent', 'antigravity', '--apply')
  assert.equal(antigravity.status, 0, antigravity.stderr)
  const hooks = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board-local']
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'])
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

const nativeEventRecord = async (record, event) => {
  // A successful native hook may have queued the event for automatic recovery.
  // Observe that event's commit without sending the hook a second time.
  await waitForAutomaticRecovery(() => {
    try { return JSON.parse(readFileSync(record, 'utf8')).activity.at(-1)?.event === event }
    catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }, `the native hook must commit ${event} before its saved activity is asserted`)
  const saved = JSON.parse(readFileSync(record, 'utf8'))
  assert.equal(saved.activity.at(-1).event, event)
  return saved
}

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
    const saved = await nativeEventRecord(record, event)
    assert.equal(saved.session, conversationId)
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
  assert.equal((await nativeEventRecord(record, 'PreInvocation')).state, 'working')
  assert.notEqual(f.command(['--agent-status', '--agent', 'antigravity', '--state', 'ended', '--event', 'Stop'], { conversationId }).status, 0)
}))

test('native Antigravity event assertions await a queued record commit without replaying the hook', { timeout: 30000 }, () => fixture(async f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const recovery = automaticRecoveryFixture(f)
  const payload = JSON.parse(recovery.payload)
  const started = await nativeHook(recovery.hooks.PreInvocation[0].command, f.env, payload)
  assert.equal(started.status, 0, hookFailure(started))
  await waitForAutomaticRecovery(() => existsSync(recovery.record) && JSON.parse(readFileSync(recovery.record, 'utf8')).activity.at(-1).event === 'PreInvocation', 'the first native event must be committed before the controlled lock')
  const locked = lockedProgress(f)
  const env = { ...f.env, NODE_OPTIONS: `${locked.env.NODE_OPTIONS} --require ${JSON.stringify(recovery.preload)}` }
  let recoveryPid, release
  try {
    const posted = await nativeHook(recovery.hooks.PostInvocation[0].command, env, payload)
    assert.equal(posted.status, 0, hookFailure(posted))
    assert.deepEqual(JSON.parse(posted.stdout), {})
    await waitForAutomaticRecovery(() => existsSync(recovery.pidFile) && pendingFiles(f).length === 1, 'the native event must queue once and launch its own recovery helper')
    recoveryPid = Number(readFileSync(recovery.pidFile, 'utf8'))
    assert.ok(isReporterAlive(recoveryPid))
    assert.equal(JSON.parse(readFileSync(recovery.record, 'utf8')).activity.at(-1).event, 'PreInvocation')
    // Let the observer start while the real record is still behind. Releasing the
    // lock lets the already-running recovery apply it without another host event.
    release = setImmediate(() => unlinkSync(locked.marker))
    const saved = await nativeEventRecord(recovery.record, 'PostInvocation')
    assert.equal(saved.session, recovery.conversationId)
    assert.equal(saved.state, 'working')
    assert.deepEqual(saved.activity.map(one => one.event), ['PreInvocation', 'PostInvocation'])
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_/)
    await waitForAutomaticRecovery(() => pendingFiles(f).length === 0 && !existsSync(recovery.lease), 'the one queued event must drain without a second hook')
    await waitForAutomaticRecovery(() => !isReporterAlive(recoveryPid), 'the owned recovery helper must exit', 3000)
  } finally {
    clearImmediate(release)
    // The hook may start recovery before an earlier assertion fails.
    if (recoveryPid === undefined && existsSync(recovery.pidFile)) recoveryPid = Number(readFileSync(recovery.pidFile, 'utf8'))
    if (existsSync(locked.marker)) unlinkSync(locked.marker)
    if (Number.isInteger(recoveryPid) && recoveryPid > 0 && isReporterAlive(recoveryPid)) await stopReporter(recoveryPid)
  }
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
  // Keep phase evidence inside the fixture; a timeout must say where recovery stopped.
  const timing = join(f.home, 'recovery-timing')
  f.save(join(timing, 'parent.jsonl'), '')
  const stamp = phase => writeFileSync(join(timing, 'parent.jsonl'), JSON.stringify({ at: Date.now(), pid: process.pid, phase }) + '\n', { flag: 'a' })
  stamp('test-start')
  f.save(barrier, `const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const trace = (phase, detail) => fs.appendFileSync(path.join(${JSON.stringify(timing)}, process.pid + '.jsonl'), JSON.stringify({ at: Date.now(), pid: process.pid, phase, detail }) + '\\n')
const role = ['--recover-pending', '--recover-hooks', '--codex-event'].find(flag => process.argv.includes(flag)) || 'writer'
trace('start', role)
process.on('exit', code => trace('exit', { role, code }))
const originalOpen = fs.openSync
let isAwaitingLock = false
fs.openSync = function(file, flags) {
  const isLock = String(file).endsWith('.agent-board-lock') && flags === 'wx'
  if (isLock && !isAwaitingLock) { trace('lock-attempt'); isAwaitingLock = true }
  const fd = originalOpen.apply(this, arguments)
  if (isLock) { trace('lock-taken'); isAwaitingLock = false }
  return fd
}
const originalRead = fs.readFileSync
fs.readFileSync = function(file) {
  if (role === '--recover-hooks' && path.dirname(String(file)) === ${JSON.stringify(join(f.root, 'pending'))}) trace('pending-read', path.basename(String(file)))
  return originalRead.apply(this, arguments)
}
const originalUnlink = fs.unlinkSync
fs.unlinkSync = function(file) {
  const result = originalUnlink.apply(this, arguments)
  if (String(file).endsWith('.agent-board-lock')) trace('lock-released')
  if (path.dirname(String(file)) === ${JSON.stringify(join(f.root, 'pending'))}) trace('pending-removed', path.basename(String(file)))
  return result
}
const child = require('node:child_process')
const originalSpawnSync = child.spawnSync
child.spawnSync = function(command, args) {
  if (args?.includes('--recover-hooks')) trace('pass-start')
  const result = originalSpawnSync.apply(this, arguments)
  if (args?.includes('--recover-hooks')) {
    let outcome
    try { outcome = JSON.parse(result.stdout) } catch {}
    trace('pass-end', { status: result.status, error: result.error?.code, processed: outcome?.processed, pending: outcome?.pending, owner: outcome?.owner })
  }
  return result
}
const originalRename = fs.renameSync
let isBusyRecorded = false
fs.renameSync = function(from, to) {
  if (String(to) === ${JSON.stringify(f.progress)}) {
    if (role === '--recover-hooks') trace('progress-rename')
    const next = fs.readFileSync(from, 'utf8')
    const prior = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : ''
    if (next.includes(${JSON.stringify(selectedMarker)}) && !prior.includes(${JSON.stringify(selectedMarker)}) && !fs.existsSync(${JSON.stringify(release)})) {
      if (!isBusyRecorded) { trace('rename-blocked'); isBusyRecorded = true }
      throw Object.assign(new Error('synthetic selected event is temporarily busy'), { code: 'EBUSY' })
    }
  }
  const result = originalRename.apply(this, arguments)
  if (String(to) === ${JSON.stringify(f.progress)}) trace('progress-written')
  return result
}
require('node:module').syncBuiltinESMExports()
if (process.argv.includes('--recover-pending')) {
  fs.mkdirSync(${JSON.stringify(recoveryPids)}, { recursive: true })
  fs.writeFileSync(path.join(${JSON.stringify(recoveryPids)}, String(process.pid)), '')
}
fs.writeFileSync(process.env.WRITER_READY, '')
trace('start-gate-wait')
const until = performance.now() + 15000
while (!fs.existsSync(process.env.WRITERS_START)) {
  if (performance.now() >= until) throw new Error('START_TIMEOUT')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
}
trace('start-gate-passed')
// The original twelve-writer test covers lock contention. Queue this event only
// after FORMAT writers finish so its deliberate busy write cannot starve them.
if (process.argv.includes('--codex-event')) {
  trace('format-writers-wait')
  const writers = ${JSON.stringify(writerDone)}
  while (!writers.every(file => fs.existsSync(file))) {
    if (performance.now() >= until) throw new Error('FORMAT_WRITERS_TIMEOUT')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
  trace('format-writers-passed')
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
  const timeline = () => readdirSync(timing).flatMap(name => readFileSync(join(timing, name), 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line))).sort((a, b) => a.at - b.at)
  let beforeRecovery
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
    stamp('gate-open')
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
    beforeRecovery = { exits: results.map(result => result.status), missing: missingBeforeRelease, pending: pendingFiles(f), recoveryPids: ownedRecoveryPids }
    f.save(release, '')
    stamp('released')
    let settled = beforeRelease
    await waitForAutomaticRecovery(() => {
      settled = readFileSync(f.progress, 'utf8')
      const isSelectedPending = existsSync(join(f.root, 'pending', selectedPendingName))
      return !isSelectedPending && owners.every(id => settled.includes(`<!-- auto session=${id} `))
    }, 'automatic recovery must drain the selected event and restore all twelve blocks')
    await waitForAutomaticRecovery(() => ownedRecoveryPids.every(pid => !isReporterAlive(pid)), 'every owned recovery helper must exit after draining', 3000)
    stamp('recovered')
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
  } catch (error) {
    // Snapshot before cleanup releases the barrier or stops an owned helper.
    try {
      const events = timeline()
      const origin = events.find(event => event.phase === 'released')?.at ?? events[0]?.at ?? Date.now()
      const roles = new Map(events.filter(event => event.phase === 'start').map(event => [event.pid, event.detail]))
      const phases = events.filter(event => event.pid === process.pid || ['--recover-pending', '--recover-hooks'].includes(roles.get(event.pid)))
      const latest = [...new Map(events.map(event => [event.pid, event])).values()]
      const relative = event => ({ ...event, at: event.at - origin })
      error.message += '\n' + JSON.stringify({ beforeRecovery, elapsedSinceReleaseMs: Date.now() - origin, pending: pendingFiles(f), missing: owners.filter(id => !readFileSync(f.progress, 'utf8').includes(`<!-- auto session=${id} `)), lockExists: existsSync(`${f.progress}.agent-board-lock`), helpers: recoveryPidValues().map(pid => ({ pid, isAlive: isReporterAlive(pid) })), phases: phases.map(relative), latest: latest.map(relative) })
    } catch (failure) { error.message += `\nRecovery diagnostics unavailable: ${failure.code ?? failure.name}` }
    throw error
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
  assert.deepEqual(entry.payload, { session_id: session, hook_event_name: 'Stop', turn_id: 'turn-1', has_response: true })
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

// Exercise the current TypeScript source without changing the checked-in board bundle.
const useSourceForPendingReplay = f => {
  f.save(f.script, `import { registerHooks } from 'node:module'
import { extname } from 'node:path'
registerHooks({ resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !extname(specifier)) specifier += '.ts'
  return nextResolve(specifier, context)
} })
const { runCodexLocal } = await import(${JSON.stringify(pathToFileURL(resolve('scripts/codex-local.ts')).href)})
const { STRINGS } = await import(${JSON.stringify(pathToFileURL(resolve('hooks/strings.ts')).href)})
try { await runCodexLocal(process.argv.slice(2), ${JSON.stringify(f.progress)}, STRINGS.en) }
catch (error) { process.stderr.write(String(error.stack || error) + '\\n'); process.exitCode = 1 }
`)
}

test('a queued hook event that fails validation is dropped with one hook-errors.log line naming its event and reason', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  const pending = join(f.root, 'pending', 'invalid.raw.json')
  f.save(pending, JSON.stringify({
    version: 1, kind: 'raw', at: Date.now(),
    argv: ['--codex-event', '--agent', 'codex', '--hook-event', 'UserPromptSubmit', '--progress-file', f.progress, '--unexpected', 'PRIVATE_ARGUMENT'],
    env: {}, payload: { session_id: 'private-session-123', hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_PAYLOAD' },
  }))
  const result = f.event('SessionStart')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(pending), false)
  const lines = hookLog(f).trim().split('\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\S+ codex UserPromptSubmit PENDING_DROPPED_INVALID_RAW_ARGV$/)
  assert.ok(Number.isFinite(Date.parse(lines[0].split(' ')[0])))
  assert.doesNotMatch(lines[0], /[\\/]|private-session-123|PRIVATE_PAYLOAD|PRIVATE_ARGUMENT/)
}))

test('a malformed pending JSON event is dropped with an unknown agent and event in the hook error log', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  const pending = join(f.root, 'pending', 'invalid.raw.json')
  f.save(pending, '{"PRIVATE_PAYLOAD":')
  const result = f.event('SessionStart')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(pending), false)
  const lines = hookLog(f).trim().split('\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\S+ unknown unknown PENDING_DROPPED_INVALID_JSON$/)
  assert.doesNotMatch(lines[0], /[\\/]|PRIVATE_PAYLOAD/)
}))

test('pending diagnostics allow only known agents, events and board error codes', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  const entry = {
    version: 1, kind: 'raw', at: Date.now(),
    argv: ['--codex-event', '--agent', 'codex', '--progress-file', f.progress],
    env: { PRIVATE_ENV: 'secret' }, payload: { session_id: session, hook_event_name: 'Stop' },
  }
  f.save(join(f.root, 'pending', '001.raw.json'), JSON.stringify({
    ...entry, argv: ['--codex-event', '--agent', 'PRIVATE_AGENT', '--progress-file', f.progress],
    payload: { session_id: session, hook_event_name: 'PRIVATE_EVENT' },
  }))
  f.save(join(f.root, 'pending', '002.raw.json'), JSON.stringify(entry))
  const result = f.event('SessionStart')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(pendingFiles(f), [])
  const lines = hookLog(f).trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\S+ unknown unknown PENDING_DROPPED_INVALID_RAW_ARGV$/)
  assert.match(lines[1], /^\S+ codex Stop PENDING_DROPPED_INVALID_RAW_ENV$/)
  assert.doesNotMatch(hookLog(f), /PRIVATE_|secret/)
}))

test('a pending event with an unknown version is logged and another board event stays queued', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  const entry = {
    version: 1, progress: f.progress, mode: '--codex-event', agent: 'codex', session,
    now: new Date().toISOString(), isBoardPrompt: false, isPrompt: false,
    payload: { session_id: session, hook_event_name: 'PermissionRequest' },
  }
  f.save(join(f.root, 'pending', '001.json'), JSON.stringify({ ...entry, version: 2 }))
  const foreign = join(f.root, 'pending', '002.json')
  const foreignEntry = JSON.stringify({ ...entry, progress: join(f.home, 'other-progress.md') })
  f.save(foreign, foreignEntry)
  const result = f.event('SessionStart')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(pendingFiles(f), ['002.json'])
  assert.equal(readFileSync(foreign, 'utf8'), foreignEntry)
  assert.match(hookLog(f), /^\S+ codex PermissionRequest PENDING_DROPPED_UNKNOWN_VERSION\n$/)
}))

test('an overdue queued hook event is dropped with its pending reason without changing its session', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  assert.equal(f.event('UserPromptSubmit').status, 0)
  const owner = createHash('sha256').update(`codex:${session}`).digest('hex')
  const record = join(f.root, 'sessions', `${owner}.json`)
  const before = readFileSync(record, 'utf8')
  const at = Date.now() - 60000
  f.save(join(f.root, 'pending', '001.json'), JSON.stringify({
    version: 1, progress: f.progress, mode: '--codex-event', agent: 'codex', session, at,
    now: new Date(at).toISOString(), isBoardPrompt: false, isPrompt: false,
    payload: { session_id: session, hook_event_name: 'Stop' },
  }))
  const result = f.event('SessionStart', null, { session_id: 'test-codex-session-456' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(pendingFiles(f), [])
  assert.equal(readFileSync(record, 'utf8'), before)
  assert.match(hookLog(f), /^\S+ codex Stop PENDING_DROPPED_OVERDUE\n$/)
}))

test('pending replay still applies an older event carrying strong run evidence', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  assert.equal(f.event('UserPromptSubmit', 'turn-newer').status, 0)
  const owner = createHash('sha256').update(`codex:${session}`).digest('hex')
  const record = join(f.root, 'sessions', `${owner}.json`)
  const before = JSON.parse(readFileSync(record, 'utf8'))
  const at = before.appliedAt - 1
  f.save(join(f.root, 'pending', '001.json'), JSON.stringify({
    version: 1, progress: f.progress, mode: '--codex-event', agent: 'codex', session, at,
    now: new Date(at).toISOString(), isBoardPrompt: false, isPrompt: false, run: { origin: 'run' },
    payload: { session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-older' },
  }))
  const result = f.event('SessionStart', null, { session_id: 'test-codex-session-456' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(pendingFiles(f), [])
  const after = JSON.parse(readFileSync(record, 'utf8'))
  assert.equal(after.origin, 'run')
  assert.equal(after.state, before.state)
  assert.equal(after.turn, before.turn)
  assert.equal(hookLog(f), '')
}))

test('a pending event that fails during application records the board refusal code', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  const missing = 'test-unbound-session-123'
  f.save(join(f.root, 'pending', '001.json'), JSON.stringify({
    version: 1, progress: f.progress, mode: '--codex-event', agent: 'codex', session: missing,
    now: new Date().toISOString(), isBoardPrompt: false, isPrompt: false,
    payload: { session_id: missing, hook_event_name: 'Stop', turn_id: 'turn-1' },
  }))
  const result = f.event('SessionStart')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(pendingFiles(f), [])
  assert.match(hookLog(f), /^\S+ codex Stop PENDING_DROPPED_UNBOUND_SESSION\n$/)
}))

test('pending drop logging bounds old lines and uses the supplied home with a separate data directory', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  const log = join(f.home, '.agent-board', 'hook-errors.log')
  const old = Array.from({ length: 205 }, (_, index) => `old-${index}`)
  f.save(log, `${old.join('\n')}\n`)
  const data = join(f.home, 'other-data')
  f.save(join(data, 'pending', '001.json'), '{')
  const result = f.command(['--codex-event', '--data-dir', data], { session_id: session, hook_event_name: 'SessionStart' })
  assert.equal(result.status, 0, result.stderr)
  const lines = readFileSync(log, 'utf8').trimEnd().split('\n')
  assert.equal(lines.length, 200)
  assert.deepEqual(lines.slice(0, 199), old.slice(-199))
  assert.match(lines[199], /^\S+ unknown unknown PENDING_DROPPED_INVALID_JSON$/)
  assert.equal(existsSync(join(data, 'hook-errors.log')), false)
  if (process.platform !== 'win32') assert.equal(statSync(log).mode & 0o777, 0o600)
}))

test('pending replay ignores an unsafe hook error log without losing the current event', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  const log = join(f.root, 'hook-errors.log')
  mkdirSync(log)
  f.save(join(f.root, 'pending', '001.json'), '{')
  const result = f.event('UserPromptSubmit')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(pendingFiles(f), [])
  assert.ok(statSync(log).isDirectory())
  assert.match(readFileSync(f.progress, 'utf8'), /state=working/)
}))

test('pending replay refuses a symlink hook error log', t => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  const target = join(f.home, 'untouched.txt'), log = join(f.root, 'hook-errors.log')
  f.save(target, 'keep this file')
  let isRealLink = true
  let extraEnv = {}
  try { symlinkSync(target, log, 'file') } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error
    isRealLink = false
    t.diagnostic('Windows refused symlink creation; exercising the same lstat refusal with a stub')
    f.save(log, 'untouched log')
    const preload = join(f.home, 'symlink-log.cjs')
    f.save(preload, `const fs = require('node:fs')
const lstat = fs.lstatSync
fs.lstatSync = (file, ...args) => {
  const stat = lstat(file, ...args)
  if (file === ${JSON.stringify(log)}) { stat.isFile = () => false; stat.isSymbolicLink = () => true }
  return stat
}
require('node:module').syncBuiltinESMExports()
`)
    extraEnv = { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }
  }
  f.save(join(f.root, 'pending', '001.json'), '{')
  const result = f.event('SessionStart', 'turn-1', {}, extraEnv)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(pendingFiles(f), [])
  if (isRealLink) assert.ok(lstatSync(log).isSymbolicLink())
  else assert.equal(readFileSync(log, 'utf8'), 'untouched log')
  assert.equal(readFileSync(target, 'utf8'), 'keep this file')
}))

test('pending replay keeps a system-error entry and writes no dropped-event log', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  const pending = join(f.root, 'pending', '001.json')
  f.save(pending, '{}')
  const preload = join(f.home, 'refuse-pending.cjs')
  f.save(preload, `const fs = require('node:fs')
const read = fs.readFileSync
fs.readFileSync = (file, ...args) => {
  if (file === ${JSON.stringify(pending)}) throw Object.assign(new Error('denied'), { code: 'EACCES' })
  return read(file, ...args)
}
require('node:module').syncBuiltinESMExports()
`)
  const result = f.event('SessionStart', 'turn-1', {}, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
  assert.equal(result.status, 1)
  assert.equal(existsSync(pending), true)
  assert.equal(hookLog(f), '')
}))

test('pending replay does not log an event another board removed first', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  const pending = join(f.root, 'pending', '001.json')
  f.save(pending, '{')
  const preload = join(f.home, 'remove-pending.cjs')
  f.save(preload, `const fs = require('node:fs')
const unlink = fs.unlinkSync
fs.unlinkSync = (file, ...args) => {
  if (file === ${JSON.stringify(pending)}) { unlink(file, ...args); throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }
  return unlink(file, ...args)
}
require('node:module').syncBuiltinESMExports()
`)
  const result = f.event('SessionStart', 'turn-1', {}, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(pending), false)
  assert.equal(hookLog(f), '')
}))

test('pending replay never copies an unexpected error message into the hook log', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  useSourceForPendingReplay(f)
  const pending = join(f.root, 'pending', '001.json')
  f.save(pending, '{}')
  const preload = join(f.home, 'unreadable-pending.cjs')
  f.save(preload, `const fs = require('node:fs')
const read = fs.readFileSync
fs.readFileSync = (file, ...args) => {
  if (file === ${JSON.stringify(pending)}) throw new Error('PRIVATE_PAYLOAD')
  return read(file, ...args)
}
require('node:module').syncBuiltinESMExports()
`)
  const result = f.event('SessionStart', 'turn-1', {}, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(pending), false)
  assert.match(hookLog(f), /^\S+ unknown unknown PENDING_DROPPED_UNREADABLE\n$/)
  assert.doesNotMatch(hookLog(f), /PRIVATE_PAYLOAD/)
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
  const runner = join(f.home, 'connect-runner.mjs')
  if (!existsSync(runner)) f.save(runner, bundleFromDir(resolve('.')))
  const request = { mode, home: f.home, progress, lang, node: process.version, codexExecutable: join(f.home, 'missing-control.exe') }
  const result = spawnSync(process.execPath, [runner, '--legacy-connect-request', JSON.stringify(request)], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  return runner
}
// A board path with characters such as `~` (a Windows short name, as on CI runners) is written into
// skills as code points; read those back before looking for a folder name (as legacy-connect tests do).
const decoded = text => text.replace(/String\.fromCodePoint\(([\d,]+)\)/g, (_, codes) => String.fromCodePoint(...codes.split(',').map(Number)))

test('setup installs its hook when the connector did not configure that agent', async () => {
  for (const hook of ['failed', 'unreadable', 'tooOld', null]) await fixture(f => {
    const progress = join(f.home, '.claude', 'progress.md')
    const record = { version: 1, revision: 1, disabled: false, owned: {}, notified: [], connectedProgress: progress, setup: { agents: [{ agent: 'codex', label: 'Codex', hook, board: 'none' }], problems: [], node: process.version } }
    f.save(join(f.root, 'legacy-connect.json'), JSON.stringify(record))
    const result = f.install('--agent', 'codex', '--apply')
    assert.equal(result.status, 0, `${hook}: ${result.stderr}${result.stdout}`)
    const plan = JSON.parse(result.stdout)
    assert.equal(plan.managedBy, undefined, String(hook))
    assert.equal(plan.progress, progress, String(hook))
    assert.ok(JSON.parse(readFileSync(f.hooks, 'utf8')).hooks.Stop.length, String(hook))
  })
})

test('setup keeps each installer\'s board when the connector and independent installer coexist', () => fixture(f => {
  mkdirSync(join(f.home, '.gemini', 'antigravity'), { recursive: true })
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const before = JSON.parse(f.install('--agent', 'antigravity').stdout)
  mkdirSync(join(f.home, '.codex'), { recursive: true })
  f.save(join(f.home, '.gemini', 'settings.json'), '{}')
  const progress = join(f.home, '.claude', 'progress.md')
  legacyConnect(f, progress)

  for (const apply of [false, true]) {
    const result = setupAgent(f, '--json', ...(apply ? ['--apply'] : []))
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const plans = JSON.parse(result.stdout).plans
    for (const agent of ['codex', 'gemini']) {
      const plan = plans.find(one => one.agent === agent)
      assert.equal(plan.managedBy, 'connector', agent)
      assert.equal(plan.progress, progress, agent)
      assert.equal(plan.script, join(dirname(progress), 'agent-board.mjs'), agent)
      assert.ok(plan.notice.includes(progress), agent)
      if (apply) assert.equal(plan.applied, true, agent)
    }
    const antigravity = plans.find(one => one.agent === 'antigravity')
    assert.equal(antigravity.managedBy, undefined)
    assert.equal(antigravity.progress, f.progress)
    assert.deepEqual(antigravity.changes, before.changes)
    assert.deepEqual(antigravity.conflicts, before.conflicts)
  }
  const explicit = setupAgent(f, '--agent', 'codex', '--progress-file', progress, '--json')
  assert.equal(explicit.status, 0, explicit.stderr + explicit.stdout)
  const wrong = setupAgent(f, '--agent', 'codex', '--progress-file', f.progress, '--json')
  assert.equal(wrong.status, 1)
  assert.equal(JSON.parse(wrong.stderr).error.cause, 'SHARED_BOARD_PATH_CONFLICT')
}))

test('setup explains damaged connector records without changing the home and the recovery works', async () => {
  const sentence = 'agent-board: setup cannot read ~/.agent-board/legacy-connect.json and changed nothing. Move that file and, if present, ~/.agent-board/legacy-connect-authority out of ~/.agent-board, then run /progress connect in Claude Code again.'
  for (const kind of ['invalid JSON', 'unsupported version', 'directory']) await fixture(f => {
    const record = join(f.root, 'legacy-connect.json')
    const authority = join(f.root, 'legacy-connect-authority')
    f.save(authority, '1\n')
    if (kind === 'directory') f.save(join(record, 'keep.txt'), 'synthetic directory contents')
    else f.save(record, kind === 'invalid JSON' ? '{' : JSON.stringify({ version: 2 }))
    const before = homeSnapshot(f.home)
    for (const apply of [false, true]) {
      const options = ['--agent', 'codex', '--lang', 'en', ...(apply ? ['--apply'] : [])]
      const plain = setupAgent(f, ...options)
      assert.equal(plain.status, 1, kind)
      assert.equal(plain.stderr.trimEnd(), sentence, kind)
      const json = setupAgent(f, ...options, '--json')
      assert.equal(json.status, 1, kind)
      assert.equal(JSON.parse(json.stderr).error.code, 'INVALID_CONNECT_RECORD', kind)
      assert.equal(JSON.parse(json.stderr).error.message, sentence, kind)
      assert.deepEqual(homeSnapshot(f.home), before, kind)
    }
    for (const [lang, hint] of [['zh-TW', '讀不懂'], ['zh-CN', '读不懂']]) {
      const result = setupAgent(f, '--agent', 'codex', '--lang', lang)
      assert.equal(result.status, 1, kind)
      assert.ok(result.stderr.includes(hint), `${kind}: ${result.stderr}`)
      assert.ok(result.stderr.includes('legacy-connect-authority'), result.stderr)
      assert.deepEqual(homeSnapshot(f.home), before, kind)
    }
    renameSync(record, join(f.home, 'saved-connector-record'))
    renameSync(authority, join(f.home, 'saved-connector-authority'))
    const progress = join(f.home, '.claude', 'progress.md')
    mkdirSync(dirname(progress), { recursive: true })
    legacyConnect(f, progress)
    assert.equal(JSON.parse(readFileSync(record, 'utf8')).version, 1, kind)
    assert.equal(readFileSync(authority, 'utf8'), '1\n', kind)
  })
})

test('setup previews the connector board without duplicate hooks or conflicts for its managed agents', () => fixture(f => {
  for (const folder of ['.codex', '.cursor', '.gemini/antigravity', '.grok/sessions', '.config/muse', '.config/opencode', '.hermes']) mkdirSync(join(f.home, folder), { recursive: true })
  const progress = join(f.home, '.claude', 'progress.md')
  legacyConnect(f, progress)
  const agents = ['codex', 'cursor', 'gemini', 'grok', 'muse', 'opencode', 'hermes', 'antigravity']
  const files = [f.hooks, join(f.home, '.cursor', 'hooks.json'), join(f.home, '.gemini', 'settings.json'), join(f.home, '.grok', 'hooks', 'agent-board.json'), join(f.home, '.config', 'opencode', 'plugin', 'agent-board.js'), join(f.home, '.gemini', 'config', 'hooks.json')]
  const before = files.map(file => readFileSync(file, 'utf8'))
  const preview = setupAgent(f, '--agent', agents.join(','), '--json')
  assert.equal(preview.status, 0, preview.stderr + preview.stdout)
  const result = JSON.parse(preview.stdout)
  assert.deepEqual(result.targets, agents)
  for (const plan of result.plans) {
    assert.equal(plan.progress, progress, plan.agent)
    assert.equal(plan.managedBy, 'connector', plan.agent)
    assert.deepEqual(plan.changes, [], plan.agent)
    assert.deepEqual(plan.conflicts, [], plan.agent)
  }
  assert.deepEqual(files.map(file => readFileSync(file, 'utf8')), before)
  for (const file of [f.progress, f.script, join(f.home, '.grok', 'hooks', 'agent-board-local.json'), join(f.home, '.config', 'opencode', 'plugins', 'agent-board-local.js')]) assert.equal(existsSync(file), false, file)
  const summary = setupAgent(f, '--agent', 'antigravity')
  assert.equal(summary.status, 0, summary.stderr)
  assert.ok(summary.stdout.includes('managed by the Claude Code plugin connector'))
  assert.ok(summary.stdout.includes(progress))
  assert.ok(!summary.stdout.includes('--codex-trust'))
}))

test('after setup apply each connected hook delivers one synthetic event to the connector board', () => fixture(async f => {
  for (const folder of ['.codex', '.cursor', '.gemini/antigravity', '.grok/sessions', '.config/muse']) mkdirSync(join(f.home, folder), { recursive: true })
  const progress = join(f.home, '.claude', 'progress.md')
  legacyConnect(f, progress)
  const agents = ['codex', 'cursor', 'gemini', 'grok', 'muse', 'antigravity']
  const applied = setupAgent(f, '--agent', agents.join(','), '--apply', '--json')
  assert.equal(applied.status, 0, applied.stderr + applied.stdout)
  assert.equal(JSON.parse(applied.stdout).applied, true)
  const definitions = [
    ['codex', f.hooks, 'Stop'],
    ['cursor', join(f.home, '.cursor', 'hooks.json'), 'afterAgentResponse'],
    ['gemini', join(f.home, '.gemini', 'settings.json'), 'AfterAgent'],
    ['grok', join(f.home, '.grok', 'hooks', 'agent-board.json'), 'Stop'],
    ['muse', join(f.home, '.config', 'muse', 'settings.json'), 'Stop'],
  ]
  for (const [agent, file, event] of definitions) {
    const groups = JSON.parse(readFileSync(file, 'utf8')).hooks[event]
    assert.equal(groups.length, 1, agent)
    const command = groups[0].command ?? groups[0].hooks[0].command
    const id = `synthetic-connected-${agent}`
    const fired = await fireCommand(f, command, JSON.stringify({ session_id: id, conversation_id: id, generation_id: 'synthetic-turn', hook_event_name: event, cwd: f.home, last_assistant_message: `Synthetic ${agent} report`, text: `Synthetic ${agent} report`, prompt_response: `Synthetic ${agent} report` }))
    assert.equal(fired.status, 0, `${agent}: ${hookFailure(fired)}`)
    const inbox = join(dirname(progress), 'progress-inbox')
    const delivered = readdirSync(inbox).filter(name => name.startsWith(`${agent}-turn-`) && name.endsWith('.json'))
    assert.equal(delivered.length, 1, agent)
    assert.ok(readFileSync(join(inbox, delivered[0]), 'utf8').includes(id), agent)
  }
  const hooks = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json'), 'utf8'))
  assert.deepEqual(Object.keys(hooks), ['agent-board'])
  const fired = await fireCommand(f, hooks['agent-board'].Stop[0].command, JSON.stringify({ conversationId: 'synthetic-connected-antigravity', cwd: f.home }))
  assert.equal(fired.status, 0, hookFailure(fired))
  assert.equal((readFileSync(progress, 'utf8').match(/<!-- auto .*agent=antigravity /g) ?? []).length, 1)
  assert.ok(!existsSync(f.progress))
  assert.ok(!existsSync(f.script))
}))

test('the npm launcher keeps a custom connector board after setup apply', () => fixture(f => {
  mkdirSync(join(f.home, '.gemini', 'antigravity'), { recursive: true })
  const progress = join(f.home, 'synthetic-selected-board', 'progress.md')
  mkdirSync(dirname(progress), { recursive: true })
  legacyConnect(f, progress)
  f.save(progress, '## Synthetic project\n### Synthetic connector board\n- [ ] Retain this task\n')
  const applied = setupAgent(f, '--agent', 'antigravity', '--apply', '--json')
  assert.equal(applied.status, 0, applied.stderr + applied.stdout)
  const launched = spawnSync(process.execPath, [resolve('bin/agent-board.mjs'), '--print'], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(launched.status, 0, launched.stderr + launched.stdout)
  assert.match(launched.stdout, /Synthetic connector board/)
  assert.ok(!existsSync(f.progress))
}))

test('the npm launcher prefers the remembered connector board when an independent board also exists', () => fixture(f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  f.save(f.progress, '## Independent project\n### Independent board\n- [ ] Keep this task\n')
  mkdirSync(join(f.home, '.codex'), { recursive: true })
  const progress = join(f.home, 'synthetic-connected-board', 'progress.md')
  mkdirSync(dirname(progress), { recursive: true })
  legacyConnect(f, progress)
  f.save(progress, '## Connector project\n### Selected connector board\n- [ ] Keep this task\n')
  assert.ok(existsSync(f.script))
  const launched = spawnSync(process.execPath, [resolve('bin/agent-board.mjs'), '--print'], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(launched.status, 0, launched.stderr + launched.stdout)
  assert.match(launched.stdout, /Selected connector board/)
  assert.doesNotMatch(launched.stdout, /Independent board/)
}))

test('a connector record written by an automatic probe uses its configured Claude directory', () => fixture(f => {
  mkdirSync(join(f.home, '.codex'), { recursive: true })
  f.env.CLAUDE_CONFIG_DIR = join(f.home, 'synthetic-claude-config')
  mkdirSync(f.env.CLAUDE_CONFIG_DIR, { recursive: true })
  const progress = join(f.env.CLAUDE_CONFIG_DIR, 'progress.md')
  legacyConnect(f, progress, 'auto')
  const record = JSON.parse(readFileSync(join(f.root, 'legacy-connect.json'), 'utf8'))
  assert.equal(record.connectedProgress, undefined)
  const result = setupAgent(f, '--agent', 'codex', '--json')
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const plan = JSON.parse(result.stdout).plans[0]
  assert.equal(plan.managedBy, 'connector')
  assert.equal(plan.progress, progress)
  assert.equal(plan.script, join(dirname(progress), 'agent-board.mjs'))
}))

test('a disabled connector leaves fresh setup on the independent board', () => fixture(f => {
  mkdirSync(join(f.home, '.gemini', 'antigravity'), { recursive: true })
  const progress = join(f.home, '.claude', 'progress.md')
  legacyConnect(f, progress)
  legacyConnect(f, progress, 'remove')
  const installed = setupAgent(f, '--agent', 'antigravity', '--apply', '--json')
  assert.equal(installed.status, 0, installed.stderr + installed.stdout)
  assert.equal(JSON.parse(installed.stdout).plans[0].progress, f.progress)
  assert.ok(existsSync(f.progress))
  assert.ok(existsSync(f.script))
}))

test('fresh setup still creates the independent progress file', () => fixture(f => {
  const result = setupAgent(f, '--agent', 'antigravity', '--apply', '--json')
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(JSON.parse(result.stdout).plans[0].progress, f.progress)
  assert.ok(existsSync(f.progress))
}))

test('Antigravity removal finishes when its owned config file is missing', () => fixture(f => {
  const installed = f.install('--agent', 'antigravity', '--apply')
  assert.equal(installed.status, 0, installed.stderr)
  const config = join(f.home, '.gemini', 'config', 'hooks.json')
  unlinkSync(config)
  const removed = f.command(['--codex-remove', '--agent', 'antigravity', '--apply', '--json'])
  assert.equal(removed.status, 0, removed.stderr + removed.stdout)
  assert.ok(JSON.parse(removed.stdout).alreadyGone.includes(config))
  for (const file of [config, f.script, f.skill, join(f.root, 'install-antigravity.json')]) assert.equal(existsSync(file), false, file)
  assert.ok(existsSync(f.progress))
}))

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

test('antigravity setup leaves an active connector as the owner through its next probe', () => fixture(async f => {
  mkdirSync(join(f.home, '.gemini', 'antigravity'), { recursive: true })
  const progress = join(f.home, '.claude', 'progress.md')
  legacyConnect(f, progress)
  const skill = join(f.home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')
  const config = join(f.home, '.gemini', 'config', 'hooks.json')
  const previous = readFileSync(skill, 'utf8'), hooksBefore = readFileSync(config, 'utf8')
  const installed = f.install('--agent', 'antigravity', '--apply')
  assert.equal(installed.status, 0, installed.stderr + installed.stdout)
  assert.equal(JSON.parse(installed.stdout).managedBy, 'connector')
  assert.equal(readFileSync(skill, 'utf8'), previous)
  assert.equal(readFileSync(config, 'utf8'), hooksBefore)
  assert.ok(!existsSync(f.script))
  legacyConnect(f, progress, 'auto')
  assert.equal(readFileSync(skill, 'utf8'), previous)
  assert.equal(readFileSync(config, 'utf8'), hooksBefore)
  const doctor = spawnSync(process.execPath, [join(dirname(progress), 'agent-board.mjs'), '--home', f.home, '--codex-doctor', '--agent', 'antigravity', '--json'], { env: f.env, encoding: 'utf8', windowsHide: true })
  assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout)
  assert.equal(JSON.parse(doctor.stdout).reportHook, 'connect')
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

test("antigravity: setup keeps the connector's skill for a progress file outside the default folder", () => fixture(async f => {
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
  assert.ok(decoded(readFileSync(skill, 'utf8')).includes('synthetic-progress-folder'))
  assert.equal(JSON.parse(installed.stdout).progress, progress)
  assert.ok(!existsSync(f.script))
}))

test("antigravity: setup keeps the connector board that CLAUDE_CONFIG_DIR or CLAUDE_PROGRESS_FILE names", async () => {
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
    const withoutVariable = install({})
    assert.equal(withoutVariable.status, 0, `${name}: ${withoutVariable.stderr}${withoutVariable.stdout}`)
    assert.equal(JSON.parse(withoutVariable.stdout).progress, join(f.home, '.claude', 'progress.md'), name)
    const installed = install({ [name]: name === 'CLAUDE_CONFIG_DIR' ? dirname(progress) : progress })
    assert.equal(installed.status, 0, `${name}: ${installed.stderr}${installed.stdout}`)
    assert.ok(!(installed.stderr + installed.stdout).includes('INSTALL_CONFLICT'), name)
    assert.equal(JSON.parse(installed.stdout).progress, progress, name)
    assert.ok(decoded(readFileSync(skill, 'utf8')).includes('synthetic-config-folder'), name)
    assert.ok(!existsSync(f.script), name)
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
    const context = nativeReportContext(started, `${connector} ${lang}`, () => hookLog(f))
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
    const result = spawnSync(process.execPath, [runner, ...isolated, '--codex-doctor', '--agent', 'antigravity', '--json'], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
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
// Exercise the real standalone entry without a synchronous bootstrap child;
// the test's own process helper waits for exit and reaps only its child tree.
const folderIdentityFixture = fn => fixture(async f => {
  const bootstrap = join(f.home, 'offline-board.mjs')
  f.save(bootstrap, bundleFromDir(new URL('..', import.meta.url)))
  const args = ['--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes')]
  const invoke = async (flags, input, cwd = f.home, extra = {}, script = f.script) => {
    const payload = join(f.home, 'offline-input.json')
    const output = join(f.home, 'offline-stdout.txt'), errors = join(f.home, 'offline-stderr.txt')
    f.save(payload, input === undefined ? '' : JSON.stringify(input))
    // File-backed stdio makes the real CLI's bytes observable independently of
    // parent pipe delivery; all descriptors remain owned by this fixture.
    const inputFd = openSync(payload, 'r'), stdoutFd = openSync(output, 'w'), stderrFd = openSync(errors, 'w')
    try {
      const ran = await nativeProcess(process.execPath, [script, ...flags, ...args],
        { ...f.env, CODEX_THREAD_ID: undefined, ...extra }, '', callback => setTimeout(callback, 15000), stopNativeTree, { cwd, inputFd, stdoutFd, stderrFd })
      return { ...ran, stdout: readFileSync(output, 'utf8'), stderr: readFileSync(errors, 'utf8') }
    } finally { closeSync(inputFd); closeSync(stdoutFd); closeSync(stderrFd) }
  }
  const installed = await invoke(['--codex-setup', '--apply'], undefined, f.home, {}, bootstrap)
  assert.equal(installed.error, undefined, hookFailure(installed))
  assert.equal(installed.status, 0, hookFailure(installed))
  return fn({ ...f, invoke })
})

const aliasFolders = f => {
  const physical = join(f.home, 'physical'), alias = join(f.home, 'alias')
  mkdirSync(join(physical, 'demo'), { recursive: true })
  symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  return { real: join(physical, 'demo'), alias: join(alias, 'demo') }
}
const aliasEvent = (f, cwd, turn = 'alias-turn', id = session, extra = {}) => f.invoke(['--codex-event'], {
  session_id: id, hook_event_name: 'UserPromptSubmit', turn_id: turn, cwd,
  transcript_path: rollout(f, id, { originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' }),
}, f.home, extra)
const aliasReport = (f, cwd) => f.invoke(['--codex-report'], reportPayload, cwd)
const folderCacheFile = (f, id = session) => join(f.root, 'sessions', createHash('sha256').update(`codex:${id}`).digest('hex') + '.json')
const assertAliasRefused = async (f, cwd) => {
  const before = everyFile(f.root).map(file => [file, readFileSync(file)])
  const ran = await aliasReport(f, cwd)
  assert.notEqual(ran.status, 0)
  assert.equal(ran.stdout, '')
  assert.equal(ran.stderr.trim(), 'This report is not bound to a session; continue your work without editing the board.')
  assert.deepEqual(everyFile(f.root).map(file => [file, readFileSync(file)]), before)
}

test('folder aliases bind one native owner without rebinding another same-named directory', () => folderIdentityFixture(async f => {
  const dirs = aliasFolders(f)
  const started = await aliasEvent(f, dirs.alias)
  assert.equal(started.status, 0, hookFailure(started))
  const history = rollout(f, session, { originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' })
  const historyBytes = readFileSync(history)
  const other = join(f.home, 'other', 'demo')
  mkdirSync(other, { recursive: true })
  await assertAliasRefused(f, other)
  const ran = await aliasReport(f, dirs.real)
  assert.equal(ran.status, 0, hookFailure(ran))
  assert.equal(JSON.parse(ran.stdout).session, session)
  const record = sessionRecord(f, session)
  assert.match(record.folderDigest, /^[a-f0-9]{64}$/)
  assert.match(record.folderCanonicalDigest, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(record).includes(f.home))
  assert.deepEqual(readFileSync(history), historyBytes)
  assert.equal((await aliasEvent(f, dirs.real, 'real-turn')).status, 0)
  assert.equal((await aliasReport(f, dirs.alias)).status, 0)
}))

test('folder aliases keep legacy exact digests and require a fresh hook for old alias hashes', () => folderIdentityFixture(async f => {
  const dirs = aliasFolders(f)
  assert.equal((await aliasEvent(f, dirs.real)).status, 0)
  const { folderCanonicalDigest: discarded, ...legacy } = sessionRecord(f, session)
  f.save(folderCacheFile(f), JSON.stringify(legacy))
  const accepted = await aliasReport(f, dirs.real)
  assert.equal(accepted.status, 0, hookFailure(accepted))
  assert.equal(sessionRecord(f, session).folderDigest, legacy.folderDigest)
  assert.equal((await aliasEvent(f, dirs.alias, 'old-alias-turn')).status, 0)
  const { folderCanonicalDigest: omitted, ...oldAlias } = sessionRecord(f, session)
  f.save(folderCacheFile(f), JSON.stringify(oldAlias))
  await assertAliasRefused(f, dirs.real)
  assert.equal((await aliasEvent(f, dirs.alias, 'fresh-alias-turn')).status, 0)
  assert.equal((await aliasReport(f, dirs.real)).status, 0)
}))

test('folder aliases refuse ambiguous stale ended run and malformed canonical records', () => folderIdentityFixture(async f => {
  const dirs = aliasFolders(f)
  assert.equal((await aliasEvent(f, dirs.alias)).status, 0)
  const original = sessionRecord(f, session)
  for (const change of [
    { state: 'ended' }, { origin: 'run' }, { updated: '2020-01-01T00:00:00Z' },
    { updated: new Date(Date.now() + 60000).toISOString() }, { folderDigest: undefined },
    { folderCanonicalDigest: 'malformed' }, { folderCanonicalDigest: '0'.repeat(64) },
  ]) {
    f.save(folderCacheFile(f), JSON.stringify({ ...original, ...change }))
    await assertAliasRefused(f, dirs.real)
  }
  f.save(folderCacheFile(f), JSON.stringify(original))
  assert.equal((await aliasEvent(f, dirs.real, 'second-owner-turn', secondSession)).status, 0)
  await assertAliasRefused(f, dirs.real)
}))

test('folder aliases keep missing and unreadable paths on exact legacy matching only', () => folderIdentityFixture(async f => {
  const dirs = aliasFolders(f)
  assert.equal((await aliasEvent(f, join(f.home, 'missing', 'demo'))).status, 0)
  assert.equal(sessionRecord(f, session).folderCanonicalDigest, undefined)
  await assertAliasRefused(f, dirs.real)
  const denied = join(f.home, 'deny-realpath.cjs')
  f.save(denied, `const fs = require('node:fs')\nconst original = fs.realpathSync\nfs.realpathSync = (path, ...args) => { if (path === ${JSON.stringify(dirs.alias)}) throw Object.assign(new Error('SYNTHETIC_DENIED'), { code: 'EACCES' }); return original(path, ...args) }\nrequire('node:module').syncBuiltinESMExports()\n`)
  assert.equal((await aliasEvent(f, dirs.alias, 'unreadable-turn', session, { NODE_OPTIONS: `--require ${JSON.stringify(denied)}` })).status, 0)
  assert.equal(sessionRecord(f, session).folderCanonicalDigest, undefined)
  await assertAliasRefused(f, dirs.real)
  assert.equal((await aliasEvent(f, dirs.alias, 'readable-turn')).status, 0)
  assert.equal((await aliasReport(f, dirs.real)).status, 0)
}))
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

test("a report from a folder with the same name as a person's session in another folder is not written to that session", () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const personFolder = join(f.home, 'a', 'demo')
  const otherFolder = join(f.home, 'b', 'demo')
  for (const cwd of [personFolder, otherFolder]) mkdirSync(cwd, { recursive: true })
  const path = rollout(f, session, { originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' })
  assert.equal(f.event('UserPromptSubmit', 'turn-person', { cwd: personFolder, transcript_path: path }).status, 0)
  const before = everyFile(f.root).map(file => [file, readFileSync(file)])
  const result = folderReport(f, otherFolder)
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.trim(), 'This report is not bound to a session; continue your work without editing the board.')
  assert.equal(result.stdout, '')
  assert.deepEqual(everyFile(f.root).map(file => [file, readFileSync(file)]), before)
  assert.equal(sessionRecord(f, session).folder, 'demo')
  const record = sessionRecord(f, session)
  assert.match(record.folderDigest, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(record).includes(personFolder))
  const recordFile = join(f.root, 'sessions', createHash('sha256').update(`codex:${session}`).digest('hex') + '.json')
  const { folderDigest, ...legacy } = record
  f.save(recordFile, JSON.stringify(legacy))
  const legacyBytes = readFileSync(f.progress)
  const unbound = folderReport(f, personFolder)
  assert.notEqual(unbound.status, 0)
  assert.equal(unbound.stdout, '')
  assert.deepEqual(readFileSync(f.progress), legacyBytes)
  assert.deepEqual(sessionRecord(f, session), legacy)
  // Windows aliases and a trailing separator retain the same directory identity.
  const alias = process.platform === 'win32' ? personFolder.toUpperCase() + '\\' : personFolder + '/'
  assert.equal(f.event('UserPromptSubmit', 'turn-next', { cwd: alias, transcript_path: path }).status, 0)
  assert.equal(sessionRecord(f, session).folderDigest, folderDigest)
  const bound = folderReport(f, personFolder)
  assert.equal(bound.status, 0, bound.stderr)
  assert.equal(JSON.parse(bound.stdout).session, session)
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

test("a tidied run's question does not come back as a card", () => fixture(f => {
  f.install('--apply')
  rollout(f, execSession, { source: 'exec' })
  rollout(f, session, { originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' })
  f.save(f.progress, '## demo\n' + oldBlock(execSession, 'Verified run') + oldBlock(session, 'Person session'))
  // A board that has seen both blocks keeps a record for each question, with the same words.
  assert.equal(f.command(['--keys', 'j']).status, 0)
  const ledgerFile = f.progress.replace(/\.md$/, '-questions.json')
  const open = () => JSON.parse(readFileSync(ledgerFile, 'utf8')).records.filter(record => record.isUnresolved).map(record => record.source.task).sort()
  assert.deepEqual(open(), ['Person session', 'Verified run'])
  const tidy = f.command(['--tidy'])
  assert.equal(tidy.status, 0, tidy.stderr)
  assert.doesNotMatch(readFileSync(f.progress, 'utf8'), /Verified run/)
  // The next board pass folds the run's resolved copy into the ledger; the other session's identical question stays live.
  const shown = f.command(['--keys', 'j'])
  assert.equal(shown.status, 0, shown.stderr)
  assert.doesNotMatch(shown.stdout, /Verified run/)
  assert.deepEqual(open(), ['Person session'])
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

test('every reporting prompt gives the same question rule in its own language', async () => {
  const { STRINGS } = await sourceModules()
  const { RULES } = await importTs('../hooks/rule.ts')
  const { RELAY } = await importTs('../hooks/i18n.ts')
  const { boardRequestWords, isBoardRequest } = await importTs('../hooks/board-commands.ts')
  const rules = {
    en: 'When you need the user, mark the step [?] and write one line they can answer: end a yes/no question with "OK?", write a choice as "A or B?", put a command in backticks, start a wait with "waiting for".',
    'zh-TW': '需要使用者時，把步驟標成 [?]，寫一行對方能直接回答的話：是非題用「…可以嗎？」結尾，選擇題寫成「A 還是 B？」，指令放在反引號裡，等別人時用「等」開頭。',
    'zh-CN': '需要用户时，把步骤标成 [?]，写一行对方能直接回答的话：是非题用“…可以吗？”结尾，选择题写成“A 还是 B？”，命令放在反引号里，等别人时用“等”开头。',
  }
  const words = boardRequestWords(Object.values(STRINGS))
  for (const [lang, rule] of Object.entries(rules)) {
    const s = STRINGS[lang]
    for (const prompt of [s.openclawProgressTool, s.deepseekBoardTool, s.localAgentStepFormat, s.localAgentAntigravityContext('board'), s.localAgentSkill('board'), s.boardSkillPrompt('board'), s.codexFallbackInstructions('board'), RULES[lang]]) {
      assert.ok(prompt.includes(rule), lang)
    }
    // The prior installed skill's text remains recognizable after the new paragraph is added.
    assert.ok(isBoardRequest(s.boardSkillPrompt('board').split('\n\n')[0], words), lang)
  }
  assert.ok(RELAY.includes(rules.en))
  assert.ok(readFileSync(new URL('../docs/REMOTE_REPORTERS.md', import.meta.url), 'utf8').includes(rules.en))
  assert.ok(readFileSync(new URL('../scripts/claude-md-rule.md', import.meta.url), 'utf8').includes(rules['zh-TW']))
})

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
  assert.equal(result.stderr.trim(), 'This report is not bound to a session; continue your work without editing the board.')
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
  const normalized = resolve(cwd)
  const folderDigest = createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex')
  const saveRecord = (id, extra = {}) => f.save(join(f.root, 'sessions', createHash('sha256').update(`codex:${id}`).digest('hex') + '.json'), JSON.stringify({ session: id, agent: 'codex', folder: 'demo', folderDigest, state: 'waiting', updated: new Date().toISOString(), ...extra }))
  const refused = () => {
    const before = everyFile(f.root).map(file => [file, readFileSync(file, 'utf8')])
    const result = folderReport(f, cwd)
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr.trim(), 'This report is not bound to a session; continue your work without editing the board.')
    assert.equal(result.stdout, '')
    assert.deepEqual(everyFile(f.root).map(file => [file, readFileSync(file, 'utf8')]), before)
  }
  refused()
  saveRecord(session, { folder: undefined, folderDigest: undefined })
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

test('an older run behind fifty retained blocks is archived by a later tidy', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  rollout(f, execSession, { source: 'exec' })
  const ids = Array.from({ length: 50 }, (_, index) => `synthetic-retained-session-${String(index).padStart(2, '0')}`)
  for (const [index, id] of ids.entries()) {
    if (index % 2 === 0) rollout(f, id, { source: 'vscode', thread_source: 'user' })
    else f.save(rollout(f, id, {}), '{unreadable history\n')
  }
  const kept = ids.map(id => oldBlock(id, id).replace(/updated=\S+/, 'updated=2026-10-27T12:00:00Z')).join('')
  const run = oldBlock(execSession, 'Older verified run').replace(/updated=\S+/, 'updated=2026-10-26T12:00:00Z')
  const original = '## demo\n' + run + kept
  f.save(f.progress, original)
  const first = f.command(['--tidy'])
  assert.equal(first.status, 0, first.stderr)
  assert.equal(readFileSync(f.progress, 'utf8'), original)
  const second = f.command(['--tidy'])
  assert.equal(second.status, 0, second.stderr)
  const after = readFileSync(f.progress, 'utf8')
  assert.doesNotMatch(after, /Older verified run/)
  assert.ok(after.includes(kept))
  const archives = everyFile(f.root).filter(file => /progress-archive-.*\.md$/.test(file))
  assert.equal(archives.length, 1)
  const archived = readFileSync(archives[0], 'utf8')
  assert.equal(archived.match(/### Older verified run/g)?.length, 1)
  assert.doesNotMatch(archived, /synthetic-retained-session/)
  assert.equal(f.command(['--tidy']).status, 0)
  assert.equal(readFileSync(archives[0], 'utf8'), archived)
  assert.equal(readFileSync(f.progress, 'utf8'), after)
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

test('a Codex session a person starts gets the open work of other sessions in its folder at SessionStart, and a run or a resumed session gets none', () => fixture(f => {
  f.install('--apply')
  const cwd = join(f.home, 'demo')
  mkdirSync(cwd, { recursive: true })
  const at = new Date(Date.now() - 3600000).toISOString()
  const block = (id, state, title, steps) => `<!-- auto session=${id} agent=claude state=${state} updated=${at} -->\n### ${title}\n${steps}\n<!-- /auto session=${id} -->\n`
  f.save(f.progress, [
    '## demo',
    block('a1b2c3e1', 'working', 'Synthetic held work', '- [x] One\n- [~] Two'),
    block('a1b2c3e2', 'ended', 'Synthetic ended work', '- [x] One\n- [ ] Synthetic next step'),
    block('a1b2c3e3', 'done', 'Synthetic finished work', '- [x] One'),
    '## elsewhere',
    block('a1b2c3e4', 'working', 'Synthetic other project', '- [~] One'),
  ].join('\n'))
  const start = f.event('SessionStart', null, { session_id: 'synthetic-person-start', cwd, source: 'startup', transcript_path: null })
  assert.equal(start.status, 0, start.stderr)
  const context = JSON.parse(start.stdout).hookSpecificOutput
  assert.equal(context.hookEventName, 'SessionStart')
  assert.match(context.additionalContext, /Synthetic held work/)
  assert.match(context.additionalContext, /Synthetic ended work.*Synthetic next step/)
  assert.match(context.additionalContext, /```text/)
  assert.doesNotMatch(context.additionalContext, /Synthetic finished work|Synthetic other project|TaskCreate/)
  const resumed = f.event('SessionStart', null, { session_id: 'synthetic-person-start', cwd, source: 'resume', transcript_path: null })
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.equal(resumed.stdout, '')
  const id = 'synthetic-run-start'
  const run = f.event('SessionStart', null, { session_id: id, cwd, source: 'startup', transcript_path: rollout(f, id, { originator: 'codex_exec' }) })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, '')
}))

test('a Codex start note keeps another Codex session with the same short id and leaves out its own block', async () => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  const dir = mkdtempSync(join(tmpdir(), 'codex-start-note-'))
  try {
    const { codexStartNote } = await import('../scripts/codex-local.ts')
    const { STRINGS } = await import('../hooks/strings.ts')
    const progress = join(dir, 'progress.md')
    const cwd = join(dir, 'demo')
    mkdirSync(cwd)
    const session = '019a0000-0000-7000-8000-000000000001'
    const id = createHash('sha256').update(`codex:${session}`).digest('hex').slice(0, 8)
    const at = new Date(Date.now() - 3600000).toISOString()
    const block = (resume, title) => `<!-- auto session=${id} agent=codex state=working updated=${at} resume=${resume} -->\n### ${title}\n- [~] One\n<!-- /auto session=${id} -->\n`
    writeFileSync(progress, ['## demo', block(session, 'Synthetic own work'), block('019a0000-0000-7000-8000-000000000002', 'Synthetic peer work')].join('\n'))
    const note = codexStartNote({ hook_event_name: 'SessionStart', source: 'startup', cwd }, undefined, session, progress, STRINGS.en)
    assert.match(note, /Synthetic peer work/)
    assert.doesNotMatch(note, /Synthetic own work/)
  } finally {
    resolver.deregister()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a Codex start note finds the project by a checkout folder, a worktree main folder, its remote name and a folder name with spaces', () => fixture(f => {
  f.install('--apply')
  const at = new Date(Date.now() - 3600000).toISOString()
  const block = (id, title) => `<!-- auto session=${id} agent=claude state=working updated=${at} -->\n### ${title}\n- [~] One\n<!-- /auto session=${id} -->\n`
  f.save(f.progress, [
    '## demo', block('b1b2c3e1', 'Synthetic remote work'),
    '## repo-copy', block('b1b2c3e2', 'Synthetic main folder work'),
    '## my project', block('b1b2c3e3', 'Synthetic spaced work'),
    '## my', block('b1b2c3e4', 'Synthetic first word work'),
    '## other', block('b1b2c3e5', 'Synthetic upstream work'),
    '## modules', block('b1b2c3e6', 'Synthetic submodule folder work'),
  ].join('\n'))
  const start = cwd => {
    const result = f.event('SessionStart', null, { session_id: 'synthetic-person-start', cwd, source: 'startup', transcript_path: null })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout === '' ? '' : JSON.parse(result.stdout).hookSpecificOutput.additionalContext
  }
  // An ordinary checkout: `.git` is a folder, and its remote names the project.
  const checkout = join(f.home, 'checkout')
  mkdirSync(join(checkout, '.git'), { recursive: true })
  writeFileSync(join(checkout, '.git', 'config'), '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://example.invalid/someone/other.git\n[remote "origin"]\n\turl = git@example.invalid:someone/demo.git\n')
  // `origin` wins over a remote listed first.
  const checkoutNote = start(checkout)
  assert.match(checkoutNote, /Synthetic remote work/)
  assert.doesNotMatch(checkoutNote, /Synthetic upstream work/)
  // With no `source`, as an older Codex sends it, the note still comes.
  const noSource = f.event('SessionStart', null, { session_id: 'synthetic-person-start', cwd: checkout, transcript_path: null })
  assert.equal(noSource.status, 0, noSource.stderr)
  assert.match(JSON.parse(noSource.stdout).hookSpecificOutput.additionalContext, /Synthetic remote work/)
  // A submodule: its `.git` file names a folder under `.git/modules`, which is no project's name.
  mkdirSync(join(checkout, '.git', 'modules', 'lib'), { recursive: true })
  const submodule = join(checkout, 'lib')
  mkdirSync(submodule, { recursive: true })
  writeFileSync(join(submodule, '.git'), 'gitdir: ../.git/modules/lib\n')
  assert.doesNotMatch(start(submodule), /Synthetic submodule folder work/)
  // A worktree: `.git` is a file naming a folder inside the main checkout `repo-copy`.
  const main = join(f.home, 'repo-copy')
  mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true })
  writeFileSync(join(main, '.git', 'worktrees', 'feature', 'commondir'), '../..\n')
  writeFileSync(join(main, '.git', 'config'), '[remote "origin"]\n\turl = https://example.invalid/someone/demo.git\n')
  const worktree = join(f.home, 'feature')
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`)
  const both = start(worktree)
  assert.match(both, /Synthetic main folder work/)
  assert.match(both, /Synthetic remote work/)
  // A folder with a space: the whole heading, not only its first word.
  const spaced = join(f.home, 'my project')
  mkdirSync(spaced, { recursive: true })
  const spacedNote = start(spaced)
  assert.match(spacedNote, /Synthetic spaced work/)
  assert.doesNotMatch(spacedNote, /Synthetic first word work/)
}))

test('a Codex start note drops an empty remote url without reading following lines', () => fixture(f => {
  f.install('--apply')
  const at = new Date(Date.now() - 3600000).toISOString()
  const block = (id, title) => `<!-- auto session=${id} agent=claude state=working updated=${at} -->\n### ${title}\n- [~] One\n<!-- /auto session=${id} -->\n`
  f.save(f.progress, ['## *', block('b1b2c3e7', 'Synthetic asterisk work')].join('\n'))
  const empty = join(f.home, 'empty-remote')
  mkdirSync(join(empty, '.git'), { recursive: true })
  writeFileSync(join(empty, '.git', 'config'), '[remote "origin"]\n\turl =\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')
  const result = f.event('SessionStart', null, { session_id: 'synthetic-person-start', cwd: empty, source: 'startup', transcript_path: null })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
}))

test('a Codex start note strips quotes from remote urls before stripping .git', () => fixture(f => {
  f.install('--apply')
  const at = new Date(Date.now() - 3600000).toISOString()
  const block = (id, title) => `<!-- auto session=${id} agent=claude state=working updated=${at} -->\n### ${title}\n- [~] One\n<!-- /auto session=${id} -->\n`
  f.save(f.progress, ['## demo', block('b1b2c3e8', 'Synthetic quoted work')].join('\n'))
  const quoted = join(f.home, 'quoted-checkout')
  mkdirSync(join(quoted, '.git'), { recursive: true })
  writeFileSync(join(quoted, '.git', 'config'), '[remote "origin"]\n\turl = "https://example.invalid/someone/demo.git"\n')
  const result = f.event('SessionStart', null, { session_id: 'synthetic-person-start', cwd: quoted, source: 'startup', transcript_path: null })
  assert.equal(result.status, 0, result.stderr)
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext
  assert.match(context, /Synthetic quoted work/)
}))

test('a Codex start note uses the folder name for a bare repository worktree and drops modules', () => fixture(f => {
  f.install('--apply')
  const at = new Date(Date.now() - 3600000).toISOString()
  const block = (id, title) => `<!-- auto session=${id} agent=claude state=working updated=${at} -->\n### ${title}\n- [~] One\n<!-- /auto session=${id} -->\n`
  f.save(f.progress, [
    '## demo', block('b1b2c3e9', 'Synthetic bare work'),
    '## repos', block('b1b2c3e10', 'Synthetic parent folder work'),
  ].join('\n'))
  const bare = join(f.home, 'repos', 'demo.git')
  mkdirSync(join(bare, 'worktrees', 'demo-feature'), { recursive: true })
  writeFileSync(join(bare, 'worktrees', 'demo-feature', 'commondir'), '../..\n')
  const worktree = join(f.home, 'demo-feature')
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(bare, 'worktrees', 'demo-feature')}\n`)
  const result = f.event('SessionStart', null, { session_id: 'synthetic-person-start', cwd: worktree, source: 'startup', transcript_path: null })
  assert.equal(result.status, 0, result.stderr)
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext
  assert.match(context, /Synthetic bare work/)
  assert.doesNotMatch(context, /Synthetic parent folder work/)
}))

// The plan mirror (#922): a plan tool call becomes the session's steps, through the report's writer.
const planCall = (id, tool, list, extra = {}) => ({
  session_id: id, hook_event_name: tool === 'update_plan' ? 'PostToolUse' : 'AfterTool', tool_name: tool,
  tool_input: tool === 'update_plan' ? { explanation: 'synthetic', plan: list } : { todos: list }, ...extra,
})
const planLong = `Synthetic plan detail ${'p'.repeat(130)}`

test('a Codex update_plan call becomes the session steps, titled and cut like a report, and prints nothing', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const first = f.command(['--plan-event'], planCall(session, 'update_plan', [
    { step: 'Read the spec', status: 'completed' }, { step: 'Write   the\ncode', status: 'in_progress' }, { step: planLong, status: 'pending' },
  ]))
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.stdout, '')
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /state=working/)
  assert.match(text, /^### Write the code$/m)
  assert.match(text, /^- \[x\] Read the spec$/m)
  assert.match(text, /^- \[~\] Write the code$/m)
  const cut = `${planLong.slice(0, 119)}…`
  assert.ok(text.includes(`- [ ] ${cut}`), text)
  assert.ok(!text.includes(planLong))
  assert.ok(readFileSync(journalOf(f, sessionRecord(f, session).updated), 'utf8').includes(planLong))
  // The block's own title stays when a later plan arrives.
  const second = f.command(['--plan-event'], planCall(session, 'update_plan', [{ step: 'Only step', status: 'in_progress' }]))
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.stdout, '')
  const later = readFileSync(f.progress, 'utf8')
  assert.match(later, /^### Write the code$/m)
  assert.match(later, /^- \[~\] Only step$/m)
  assert.ok(!later.includes('Read the spec'))
}))

test('a Gemini write_todos call marks cancelled and blocked todos, and the first todo titles a block with none in progress', () => fixture(f => {
  assert.equal(f.install('--agent', 'gemini', '--apply').status, 0)
  const id = 'gemini-plan-session-1'
  const ran = f.command(['--plan-event', '--agent', 'gemini'], planCall(id, 'write_todos', [
    { description: 'Done one', status: 'completed' }, { description: 'Dropped one', status: 'cancelled' }, { description: 'Stuck one', status: 'blocked' },
  ]))
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(ran.stdout, '')
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /agent=gemini/)
  assert.match(text, /^### Done one$/m)
  assert.match(text, /^- \[-\] Dropped one$/m)
  assert.match(text, /^- \[!\] Stuck one$/m)
}))

test('a plan call that is not a plan, is bad JSON or is empty writes nothing, prints nothing and exits 0', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const before = existsSync(f.progress) ? readFileSync(f.progress, 'utf8') : null
  for (const input of [
    planCall(session, 'shell', [{ step: 'Not a plan', status: 'pending' }]),
    { ...planCall(session, 'update_plan', [{ step: 'x', status: 'pending' }]), tool_name: 'write_todos' },
    planCall(session, 'update_plan', []),
    planCall(session, 'update_plan', [{ step: '   ', status: 'pending' }, 7]),
    { ...planCall(session, 'update_plan', [{ step: 'No session', status: 'pending' }]), session_id: undefined },
  ]) {
    const ran = f.command(['--plan-event'], input)
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.stdout, '')
  }
  const broken = spawnSync(process.execPath, [f.script, '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--plan-event'], { env: f.env, input: '{broken', encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(broken.status, 0, broken.stderr)
  assert.equal(broken.stdout, '')
  assert.equal(existsSync(f.progress) ? readFileSync(f.progress, 'utf8') : null, before)
  assertNoBlock(f, session)
}))

test('a plan call into a denied Windows folder exits 0, prints nothing and names LOCK_DENIED for the hook log', { skip: process.platform !== 'win32' && 'Windows ACLs only' }, () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  const folder = join(f.home, 'denied-plan')
  const progress = join(folder, 'progress.md')
  f.save(progress, '## Synthetic denied plan\n')
  const before = readFileSync(progress)
  await withDeniedCreation(folder, () => {
    const result = f.command(['--plan-event', '--progress-file', progress, '--lang', 'en'], planCall(session, 'update_plan', [{ step: 'Synthetic denied step', status: 'in_progress' }]))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /\(LOCK_DENIED\)/)
    assert.deepEqual(readFileSync(progress), before)
  })
}))

test('setup writes the plan hook as a matcher group for Codex and Gemini, and remove leaves a person\'s own groups', () => fixture(async f => {
  const mine = { matcher: 'shell', hooks: [{ type: 'command', command: 'echo mine' }] }
  const geminiConfig = join(f.home, '.gemini', 'settings.json')
  f.save(f.hooks, JSON.stringify({ hooks: { PostToolUse: [mine] } }))
  f.save(geminiConfig, JSON.stringify({ hooks: { AfterTool: [mine] } }))
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.install('--agent', 'gemini', '--apply').status, 0)
  const codex = JSON.parse(readFileSync(f.hooks, 'utf8')).hooks
  assert.deepEqual(codex.PostToolUse[0], mine)
  assert.equal(codex.PostToolUse.length, 2)
  assert.equal(codex.PostToolUse[1].matcher, 'update_plan')
  assert.match(codex.PostToolUse[1].hooks[0].command, /agent-board|EncodedCommand/)
  assert.equal(codex.PostToolUse[1].hooks[0].matcher, undefined)
  const gemini = JSON.parse(readFileSync(geminiConfig, 'utf8')).hooks
  assert.deepEqual(gemini.AfterTool[0], mine)
  assert.equal(gemini.AfterTool.length, 2)
  assert.equal(gemini.AfterTool[1].matcher, '^write_todos$')
  assert.equal(gemini.AfterTool[1].hooks[0].matcher, undefined)
  // The installed command is the real hook: it writes the steps and prints nothing.
  const fired = await fireCommand(f, codex.PostToolUse[1].hooks[0].command, JSON.stringify(planCall(session, 'update_plan', [{ step: 'Fired through the hook', status: 'in_progress' }])))
  assert.equal(fired.status, 0, fired.stderr)
  assert.equal(fired.stdout, '')
  assert.match(readFileSync(f.progress, 'utf8'), /^- \[~\] Fired through the hook$/m)
  // Installing again adds no second group of ours.
  assert.equal(f.install('--apply').status, 0)
  assert.equal(JSON.parse(readFileSync(f.hooks, 'utf8')).hooks.PostToolUse.length, 2)
  assert.equal(f.command(['--codex-remove', '--apply']).status, 0)
  assert.equal(f.command(['--codex-remove', '--agent', 'gemini', '--apply']).status, 0)
  assert.deepEqual(JSON.parse(readFileSync(f.hooks, 'utf8')), { hooks: { PostToolUse: [mine] } })
  assert.deepEqual(JSON.parse(readFileSync(geminiConfig, 'utf8')), { hooks: { AfterTool: [mine] } })
}))

// Grok Build's todo_write may carry only the changed items; the whole list is in the result (#922).
const grokCall = (id, todos, extra = {}) => ({
  sessionId: id, hookEventName: 'PostToolUse', toolName: 'todo_write', toolResultTruncated: false,
  toolInput: { merge: true, todos: [{ id: 'b', status: 'in_progress' }] },
  toolResult: { type: 'Todo', TodosUpdated: { summary_for_prompt: 'synthetic', todos, state: {} } }, ...extra,
})

test('a Grok todo_write merge call with one changed item reports the whole list from its result', () => fixture(f => {
  assert.equal(f.install('--agent', 'grok', '--apply').status, 0)
  const ran = f.command(['--plan-event', '--agent', 'grok'], grokCall('grok-plan-session-1', [
    { content: 'Grok first', priority: 'high', status: 'completed' }, { content: 'Grok second', priority: 'medium', status: 'in_progress' },
    { content: 'Grok third', priority: 'low', status: 'pending' }, { content: 'Grok dropped', priority: 'low', status: 'cancelled' },
  ]))
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(ran.stdout, '')
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /agent=grok/)
  assert.match(text, /^- \[x\] Grok first$/m)
  assert.match(text, /^- \[~\] Grok second$/m)
  assert.match(text, /^- \[ \] Grok third$/m)
  assert.match(text, /^- \[-\] Grok dropped$/m)
}))

test('a Grok todo_write call with a truncated result, a DuplicateId result, an empty list or another tool writes nothing', () => fixture(f => {
  assert.equal(f.install('--agent', 'grok', '--apply').status, 0)
  const one = [{ content: 'Grok never written', priority: 'low', status: 'pending' }]
  // A good call first, so the refusals below are shown to leave its steps alone.
  assert.equal(f.command(['--plan-event', '--agent', 'grok'], grokCall('grok-plan-session-2', [{ content: 'Grok kept', priority: 'low', status: 'in_progress' }])).status, 0)
  for (const input of [
    grokCall('grok-plan-session-2', one, { toolResultTruncated: true }),
    grokCall('grok-plan-session-2', one, { toolResult: { type: 'Todo', DuplicateId: { id: 'a' } } }),
    grokCall('grok-plan-session-2', []),
    grokCall('grok-plan-session-2', one, { toolName: 'shell' }),
    grokCall('grok-plan-session-2', one, { sessionId: undefined }),
  ]) {
    const ran = f.command(['--plan-event', '--agent', 'grok'], input)
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.stdout, '')
  }
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /^- \[~\] Grok kept$/m)
  assert.ok(!text.includes('Grok never written'))
}))

test('setup installs the Grok PostToolUse plan hook with the todo_write matcher and a 5 second timeout', () => fixture(f => {
  assert.equal(f.install('--agent', 'grok', '--apply').status, 0)
  const grok = JSON.parse(readFileSync(join(f.home, '.grok', 'hooks', 'agent-board-local.json'), 'utf8')).hooks
  assert.equal(grok.PostToolUse.length, 1)
  assert.equal(grok.PostToolUse[0].matcher, '^todo_write$')
  assert.equal(grok.PostToolUse[0].hooks[0].timeout, 5)
  assert.match(grok.PostToolUse[0].hooks[0].command, /--plan-event/)
}))

const hermesTodo = (id, todos, extra = {}) => ({
  hook_event_name: 'post_tool_call', tool_name: 'todo', session_id: id,
  tool_input: { merge: true, todos: [{ id: 'b', status: 'in_progress' }] },
  extra: { result: JSON.stringify({ todos, summary: {} }) }, ...extra,
})

test('a Hermes todo merge hook reports the whole result list as plan steps', () => fixture(f => {
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  const input = hermesTodo('hermes-plan-session-1', [
    { id: 'a', content: 'Hermes first', status: 'completed' },
    { id: 'b', content: 'Hermes second', status: 'in_progress' },
    { id: 'c', content: 'Hermes third', status: 'pending' },
    { id: 'd', content: 'Hermes dropped', status: 'cancelled' },
  ])
  const ran = fireHermes(f, 'post_tool_call', input)
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(ran.stdout, '')
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /agent=hermes/)
  assert.match(text, /^- \[x\] Hermes first$/m)
  assert.match(text, /^- \[~\] Hermes second$/m)
  assert.match(text, /^- \[ \] Hermes third$/m)
  assert.match(text, /^- \[-\] Hermes dropped$/m)
}))

test('a Hermes todo hook ignores a bad result or partial merge and uses complete non-merge input when the result is absent', () => fixture(f => {
  assert.equal(f.install('--agent', 'hermes', '--apply').status, 0)
  const id = 'hermes-plan-session-2'
  const one = [{ id: 'a', content: 'Hermes kept', status: 'in_progress' }]
  const fallback = hermesTodo(id, [], { tool_input: { merge: false, todos: one }, extra: {} })
  const first = f.command(['--plan-event', '--agent', 'hermes'], fallback)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.stdout, '')
  const before = readFileSync(f.progress, 'utf8')
  assert.match(before, /^- \[~\] Hermes kept$/m)
  for (const input of [
    hermesTodo(id, one, { extra: { result: '{broken' } }),
    { ...fallback, extra: { result: '{broken' } },
    hermesTodo(id, one, { extra: {} }),
    hermesTodo(id, one, { extra: { result: '{}' } }),
    hermesTodo(id, one, { hook_event_name: 'pre_tool_call' }),
    hermesTodo(id, one, { tool_name: 'terminal' }),
    hermesTodo(undefined, one),
  ]) {
    const ran = f.command(['--plan-event', '--agent', 'hermes'], input)
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.stdout, '')
    assert.equal(readFileSync(f.progress, 'utf8'), before)
  }
}))

test('Windows fixture Node is a hard link to the running executable when linking works', { skip: process.platform !== 'win32' }, t => fixture(f => {
  const node = join(f.home, 'linked node.exe')
  placeNode(node)
  const linked = statSync(node, { bigint: true }), original = statSync(process.execPath, { bigint: true })
  // Where Windows refuses the link (node.exe under Program Files), the copy is used and the log says so.
  if (linked.nlink < 2n) return t.skip('this computer refused a hard link to node.exe; the fixture copied it')
  assert.equal(linked.ino, original.ino)
}))

test('codex: three turns in one interactive session each reach the board (#289)', () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  const recordFile = join(f.root, 'sessions', createHash('sha256').update(`codex:${session}`).digest('hex') + '.json')
  assert.equal(f.event('SessionStart', undefined, { turn_id: undefined }).status, 0)
  for (const turn of ['t1', 't2', 't3']) {
    const start = f.event('UserPromptSubmit', turn)
    assert.equal(start.status, 0, `${turn} prompt: ${start.stderr}`)
    assert.match(readFileSync(f.progress, 'utf8'), /state=working/, turn)
    const stop = f.event('Stop', turn)
    assert.equal(stop.status, 0, `${turn} stop: ${stop.stderr}`)
    assert.match(readFileSync(f.progress, 'utf8'), /state=waiting/, turn)
  }
  const events = JSON.parse(readFileSync(recordFile, 'utf8')).events
  for (const turn of ['t1', 't2', 't3']) for (const name of ['UserPromptSubmit', 'Stop']) assert.ok(events.includes(`${name}:${turn}`), `${name}:${turn} in ${events}`)
}))

test('codex: every turn of one interactive session claims its mailbox message (#289)', async () => mailboxFixture(async f => {
  const { queueMessage } = await importTs('../hooks/messaging.ts')
  f.seed()
  for (const [index, turn] of ['t1', 't2', 't3'].entries()) {
    if (index > 0) {
      const saved = f.state(), target = saved.mailboxes[0]
      const queued = queueMessage(saved, { id: `hook-mailbox-message-${turn}`, target: target.id, turn: 'session', text: `Synthetic payload ${turn}` }, 'board', target, Date.now()).state
      writeFileSync(join(f.directory, 'messages.json'), JSON.stringify({ version: 2, ...queued }))
    }
    const text = index === 0 ? 'Synthetic mailbox payload' : `Synthetic payload ${turn}`
    // A claim held by a slow scanner defers once; the helper checks that it really was a deferral.
    const result = await hookOrDeferred(() => f.call('codex', 'UserPromptSubmit', { turn_id: turn }), r => r.stdout.includes(text))
    assert.ok(result.stdout.includes(text), `${turn}: ${result.stdout} ${result.stderr}`)
    assert.equal(f.call('codex', 'Stop', { turn_id: turn }).status, 0, turn)
  }
  assert.deepEqual(f.state().messages.map(one => one.status), ['accepted', 'accepted', 'accepted'])
}))

// The plan mirror for OpenCode and OpenClaw (#922): each plugin sends its agent's own plan to the
// worker as a --plan-event, and the worker turns it into the session's steps. The plugin is loaded
// here with a spawnSync that keeps the call, which then runs against the real installed worker.
const planPlugin = async (f, agent, build, exercise) => {
  assert.equal(f.install('--agent', agent, '--apply').status, 0)
  const worker = join(f.root, 'agent-board-hook.mjs')
  const { opencodePlugin } = await importTs('../hooks/local-agents.ts')
  const { openclawLocalPlugin } = await importTs('../hooks/portable-agents.ts')
  const saved = []
  const source = agent === 'opencode' ? opencodePlugin(process.execPath, worker, f.progress, 'Progress', f.home) : openclawLocalPlugin(process.execPath, worker, f.progress, f.home)
  const load = new Function('createRequire', 'spawnSync', 'tool', `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace('export default', 'const plugin =').replace(/^export /gm, '')}\n${build}`)
  const spawn = (_node, args, options) => { saved.push({ args: [...args], input: options.input }); return { status: 0, stdout: '' } }
  const tool = Object.assign(value => value, { schema: { string: () => ({ describe: () => ({}) }), enum: () => ({}), array: () => ({}) } })
  const exitListeners = process.listeners('exit')
  try { await exercise(load(createRequire, spawn, tool), saved) } finally { dropExitReports(exitListeners) }
  return {
    saved,
    // Runs a kept call the way the host would: the worker, with the plugin's own arguments and input.
    deliver: call => spawnSync(process.execPath, [worker, ...call.args.slice(1)], { env: f.env, input: call.input, encoding: 'utf8', windowsHide: true, timeout: 15000 }),
  }
}

test('OpenCode idle events send the last assistant text and preserve status on failed, stalled or oversized replies', () => fixture(async f => {
  const got = await planPlugin(f, 'opencode', 'return AgentBoardLocal', async factory => {
    const client = { session: {
      get: async ({ path }) => ({ data: { id: path.id } }),
      messages: async ({ path }) => {
        if (path.id.endsWith('failed')) throw new Error('synthetic failure')
        if (path.id.endsWith('stalled')) return new Promise(() => {})
        if (path.id.endsWith('oversized')) return { data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'a'.repeat(1100000) }] }] }
        return { data: [
          { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Old answer?' }] },
          { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Visible answer.' }, { type: 'text', text: 'Synthetic?', synthetic: true }, { type: 'text', text: 'Ignored?', ignored: true }, { type: 'text', text: 'Which option?' }] },
          { info: { role: 'user' }, parts: [{ type: 'text', text: 'Not assistant text' }] },
        ] }
      },
    } }
    const hooks = await factory({ client, directory: f.home })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-opencode-idle' } } })
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'synthetic-opencode-status-idle', status: { type: 'idle' } } } })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-opencode-failed' } } })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-opencode-stalled' } } })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'synthetic-opencode-oversized' } } })
  })
  assert.equal(got.saved.length, 5)
  for (const call of got.saved.slice(0, 2)) {
    const sent = JSON.parse(call.input)
    assert.equal(sent.state, 'waiting')
    assert.equal(sent.last_assistant_message, 'Visible answer.\nWhich option?')
  }
  for (const call of got.saved.slice(2)) {
    const sent = JSON.parse(call.input)
    assert.equal(sent.state, 'waiting')
    assert.equal(sent.last_assistant_message, undefined)
  }
}))

test('OpenCode drops an older idle result after a newer prompt, busy status or session deletion', () => fixture(async f => {
  const got = await planPlugin(f, 'opencode', 'return AgentBoardLocal', async factory => {
    const cases = ['prompt', 'busy', 'deleted']
    let enterLookup
    let releaseLookup
    const freshQuestion = 'Should I use the current draft?'
    const answer = text => ({ data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text }] }] })
    const client = { session: {
      get: async ({ path }) => ({ data: { id: path.id } }),
      messages: async ({ path }) => path.id === 'synthetic-current-idle' ? answer(freshQuestion) : new Promise(resolve => {
        releaseLookup = resolve
        enterLookup()
      }),
    } }
    const hooks = await factory({ client, directory: f.home })
    const idle = sessionID => hooks.event({ event: { type: 'session.idle', properties: { sessionID } } })
    for (const kind of cases) {
      const id = `synthetic-old-idle-${kind}`
      const entered = new Promise(resolve => { enterLookup = resolve })
      const pending = idle(id)
      await entered
      if (kind === 'prompt') {
        await hooks['chat.message']({ sessionID: id }, { parts: [{ type: 'text', text: 'Start the new draft.' }] })
        // A different session can report its own current question while the first lookup is held.
        await idle('synthetic-current-idle')
      } else if (kind === 'busy') {
        await hooks.event({ event: { type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } } })
      } else {
        await hooks.event({ event: { type: 'session.deleted', properties: { info: { id } } } })
      }
      releaseLookup(answer('Should I use the old draft?'))
      await pending
    }
  })
  const reports = got.saved.map(call => JSON.parse(call.input))
  assert.deepEqual(reports.map(({ session_id, state, last_assistant_message }) => [session_id, state, last_assistant_message]), [
    ['synthetic-old-idle-prompt', 'working', undefined],
    ['synthetic-current-idle', 'waiting', 'Should I use the current draft?'],
    ['synthetic-old-idle-busy', 'working', undefined],
    ['synthetic-old-idle-deleted', 'ended', undefined],
  ])
}))

test('an OpenCode todo.updated event becomes the session steps; a child session, another event, no session, no todos or a failed session lookup write nothing', () => fixture(async f => {
  const id = 'ses_opencode_plan_1', child = 'ses_opencode_child_1'
  const todos = [
    { content: 'Read the spec', status: 'completed', priority: 'high' }, { content: 'Write the code', status: 'in_progress', priority: 'high' },
    { content: 'Ship it', status: 'pending', priority: 'low' }, { content: 'Dropped idea', status: 'cancelled', priority: 'low' },
  ]
  const got = await planPlugin(f, 'opencode', 'return AgentBoardLocal', async (factory, saved) => {
    const hooks = await factory({ client: { session: { get: async ({ path }) => path.id === 'ses_lookup_fails' ? { error: 'synthetic lookup failure' } : ({ data: { id: path.id, ...(path.id === child ? { parentID: id } : {}) } }) } }, directory: f.home })
    await hooks.event({ event: { type: 'todo.updated', properties: { sessionID: child, todos } } })
    await hooks.event({ event: { type: 'message.updated', properties: { sessionID: id, todos } } })
    await hooks.event({ event: { type: 'todo.updated', properties: { todos } } })
    await hooks.event({ event: { type: 'todo.updated', properties: { sessionID: id, todos: [] } } })
    await hooks.event({ event: { type: 'todo.updated', properties: { sessionID: 'ses_lookup_fails', todos } } })
    assert.equal(saved.length, 0)
    await hooks.event({ event: { type: 'todo.updated', properties: { sessionID: id, todos } } })
  })
  assert.equal(got.saved.length, 1)
  assert.ok(got.saved[0].args.includes('--plan-event'))
  const sent = JSON.parse(got.saved[0].input)
  assert.equal(sent.session_id, id)
  assert.equal(JSON.stringify(sent).includes('high'), false, 'only text and status leave the plugin')
  const ran = got.deliver(got.saved[0])
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(ran.stdout, '')
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /agent=opencode/)
  assert.match(text, /^### Write the code$/m)
  assert.match(text, /^- \[x\] Read the spec$/m)
  assert.match(text, /^- \[~\] Write the code$/m)
  assert.match(text, /^- \[ \] Ship it$/m)
  assert.match(text, /^- \[-\] Dropped idea$/m)
}))

test('an OpenClaw update_plan call becomes the session steps; an error, no plan or another tool writes nothing', () => fixture(async f => {
  const id = 'openclaw-plan-session-1'
  const plan = [{ step: 'Read the spec', status: 'completed' }, { step: 'Write the code', status: 'in_progress' }, { step: 'Ship it', status: 'pending' }]
  const got = await planPlugin(f, 'openclaw', 'return { plugin }', ({ plugin }, saved) => {
    const handlers = new Map()
    plugin.register({ on: (name, handler) => handlers.set(name, handler), agent: { events: { registerAgentEventSubscription: () => {} } } })
    const fire = (event, ctx = { sessionId: id }) => handlers.get('after_tool_call')?.(event, ctx)
    fire({ toolName: 'update_plan', params: { plan }, error: 'tool failed' })
    fire({ toolName: 'update_plan', params: { markdown: 'only text' } })
    fire({ toolName: 'update_plan', params: { plan: [] } })
    fire({ toolName: 'read_file', params: { plan } })
    fire({ toolName: 'update_plan', params: { plan } }, {})
    assert.equal(saved.length, 0)
    fire({ toolName: 'update_plan', params: { plan } })
  })
  assert.equal(got.saved.length, 1)
  assert.ok(got.saved[0].args.includes('--plan-event'))
  assert.equal(JSON.parse(got.saved[0].input).session_id, id)
  const ran = got.deliver(got.saved[0])
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(ran.stdout, '')
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /agent=openclaw/)
  assert.match(text, /^- \[x\] Read the spec$/m)
  assert.match(text, /^- \[~\] Write the code$/m)
  assert.match(text, /^- \[ \] Ship it$/m)
}))

// The plugins pass at most 200 items and the worker keeps the first 40 as steps.
test('a plan of 250 items reaches the board as its first 40 steps, from OpenCode and from OpenClaw', async () => {
  const many = Array.from({ length: 250 }, (_, index) => 'Item ' + (index + 1))
  const fortySteps = progress => {
    const text = readFileSync(progress, 'utf8')
    assert.equal((text.match(/^- \[[ x~!?-]\] Item \d+$/gm) ?? []).length, 40)
    assert.match(text, /^- \[ \] Item 40$/m)
    assert.doesNotMatch(text, /^- \[ \] Item 41$/m)
  }
  await fixture(async f => {
    const got = await planPlugin(f, 'opencode', 'return AgentBoardLocal', async factory => {
      const hooks = await factory({ client: { session: { get: async ({ path }) => ({ data: { id: path.id } }) } }, directory: f.home })
      await hooks.event({ event: { type: 'todo.updated', properties: { sessionID: 'ses_opencode_many', todos: many.map(content => ({ content, status: 'pending', priority: 'low' })) } } })
    })
    assert.equal(got.saved.length, 1)
    assert.equal(JSON.parse(got.saved[0].input).tool_input.todos.length, 200)
    assert.equal(got.deliver(got.saved[0]).status, 0)
    fortySteps(f.progress)
  })
  await fixture(async f => {
    const got = await planPlugin(f, 'openclaw', 'return { plugin }', ({ plugin }) => {
      const handlers = new Map()
      plugin.register({ on: (name, handler) => handlers.set(name, handler), agent: { events: { registerAgentEventSubscription: () => {} } } })
      handlers.get('after_tool_call')?.({ toolName: 'update_plan', params: { plan: many.map(step => ({ step, status: 'pending' })) } }, { sessionId: 'openclaw-plan-session-many' })
    })
    assert.equal(got.saved.length, 1)
    assert.equal(JSON.parse(got.saved[0].input).tool_input.plan.length, 200)
    assert.equal(got.deliver(got.saved[0]).status, 0)
    fortySteps(f.progress)
  })
})

// #922: a new block joins its project's section, and a plan event with no block files like a status event.
const sharedReports = (f, eol) => {
  assert.equal(f.install('--apply').status, 0)
  writeFileSync(f.progress, ['# Progress', '', '## Shared project', '- [ ] hand kept', '', '## Other project', '- [ ] other', ''].join(eol))
  for (const id of ['shared-report-session-1', 'shared-report-session-2']) {
    const ran = f.command(['--report', '--agent', 'codex', '--session', id], { title: `Task ${id.at(-1)}`, project: 'Shared project', state: 'working', steps: ['- [~] Step'] })
    assert.equal(ran.status, 0, ran.stderr)
  }
  return readFileSync(f.progress, 'utf8')
}

for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`#922 two sessions of one project share its one heading, ${label}`, () => fixture(f => {
    const text = sharedReports(f, eol)
    assert.equal(text.match(/^## Shared project\r?$/gm).length, 1, text)
    assert.equal(text.match(/^## Other project\r?$/gm).length, 1, text)
    const other = text.indexOf('## Other project')
    for (const n of ['1', '2']) {
      const at = text.indexOf(`### Task ${n}`)
      assert.ok(at > text.indexOf('## Shared project') && at < other, text)
    }
    assert.ok(text.indexOf('- [ ] hand kept') < text.indexOf('### Task 1'), text)
    assert.ok(text.includes(`<!-- /auto session=${createHash('sha256').update('codex:shared-report-session-2').digest('hex').slice(0, 8)} -->${eol}${eol}## Other project`), JSON.stringify(text))
    if (eol === '\r\n') assert.ok(!/(^|[^\r])\n/.test(text), 'every line keeps its CRLF')
  }))
}

test('#922 a block joins only a heading with its whole project name, not one that shares the first word', async () => {
  const { putCodexBlock } = await importTs('../hooks/codex.ts')
  const base = ['# Progress', '', '## my other', '- [ ] hand kept', ''].join('\n')
  const text = putCodexBlock(base, { session: 'm1', turn: null, state: 'working', title: 'Task', project: 'my project', steps: ['- [~] Step'], updated: '2026-11-06T00:00:00.000Z' }, 'c'.repeat(64))
  assert.equal(text.match(/^## my other$/gm).length, 1, text)
  assert.equal(text.match(/^## my project$/gm).length, 1, text)
  assert.ok(text.indexOf('### Task') > text.indexOf('## my project'), text)
})

test('#922 dropping one of two blocks in a shared section keeps the heading', async () => {
  const { putCodexBlock, dropCodexBlock } = await importTs('../hooks/codex.ts')
  const owners = ['a', 'b'].map(one => one.repeat(64))
  const report = (n) => ({ session: `d${n}`, turn: null, state: 'working', title: `Task ${n}`, project: 'Shared project', steps: ['- [~] Step'], updated: '2026-11-06T00:00:00.000Z' })
  let text = ''
  owners.forEach((owner, index) => { text = putCodexBlock(text, report(index), owner) })
  assert.equal(text.match(/^## Shared project$/gm).length, 1, text)
  const first = dropCodexBlock(text, owners[0])
  assert.match(first, /^## Shared project$/m)
  assert.ok(first.includes('### Task 1') && !first.includes('### Task 0'), first)
  const second = dropCodexBlock(text, owners[1])
  assert.match(second, /^## Shared project$/m)
  assert.ok(second.includes('### Task 0') && !second.includes('### Task 1'), second)
})

test('#922 a block put into an existing section and dropped leaves the file byte for byte, and a cut-off block gets a section of its own', async () => {
  const { putCodexBlock, dropCodexBlock } = await importTs('../hooks/codex.ts')
  const owner = 'c'.repeat(64)
  const report = { session: 'dx', turn: null, state: 'working', title: 'Joined', project: 'demo', steps: ['- [~] Step'], updated: '2026-11-06T00:00:00.000Z' }
  // The section ends the file, is followed by a blank line and a heading, or by a heading at once.
  for (const original of ['## demo\r\n### Mine\r\n- [ ] Keep\r\n', '## demo\r\n### Mine\r\n- [ ] Keep\r\n\r\n## other\r\nx\r\n', '## demo\n### Mine\n- [ ] Keep\n## other\nx\n']) {
    const put = putCodexBlock(original, report, owner)
    assert.equal(put.match(/^## demo\r?$/gm).length, 1, put)
    assert.ok(put.indexOf('### Joined') < (put.indexOf('## other') === -1 ? Infinity : put.indexOf('## other')), put)
    assert.equal(dropCodexBlock(put, owner), original)
  }
  // A block cut off before its closing marker would swallow what follows it in its section.
  const cut = '## demo\n<!-- auto session=aaaaaaaa agent=codex state=working -->\n### Cut\n- [ ] Half\n\n## other\nx\n'
  const put = putCodexBlock(cut, report, owner)
  assert.ok(put.startsWith(cut), put)
  assert.match(put.slice(cut.length), /^\n## demo\n<!-- auto /)
})

test('#922 a Codex plan event with a cwd and no earlier block files under the folder name, not Codex', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const ran = f.command(['--plan-event'], planCall('plan-folder-session-1', 'update_plan', [{ step: 'Folder step', status: 'in_progress' }], { cwd: join(f.home, 'synthetic-plan-folder') }))
  assert.equal(ran.status, 0, ran.stderr)
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /^## synthetic-plan-folder\r?$/m)
  assert.ok(!text.includes('## Codex'), text)
}))

test('#922 a Gemini and a Grok plan event with no earlier block file under their own agent heading', () => fixture(f => {
  assert.equal(f.install('--agent', 'gemini', '--apply').status, 0)
  assert.equal(f.install('--agent', 'grok', '--apply').status, 0)
  assert.equal(f.command(['--plan-event', '--agent', 'gemini'], planCall('gemini-heading-session-1', 'write_todos', [{ description: 'Gemini step', status: 'in_progress' }], { cwd: join(f.home, 'ignored-folder') })).status, 0)
  assert.equal(f.command(['--plan-event', '--agent', 'grok'], grokCall('grok-heading-session-1', [{ content: 'Grok step', priority: 'low', status: 'in_progress' }])).status, 0)
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /^## gemini\r?$/m)
  assert.match(text, /^## grok\r?$/m)
  assert.ok(!text.includes('## Codex') && !text.includes('ignored-folder'), text)
}))

test('#922 a plan event keeps the project of an existing block', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.command(['--codex-report', '--agent', 'codex', '--session', 'plan-keep-session-1'], { title: 'Existing', project: 'Kept project', state: 'working', steps: ['- [~] First'] }).status, 0)
  assert.equal(f.command(['--plan-event'], planCall('plan-keep-session-1', 'update_plan', [{ step: 'Second', status: 'in_progress' }], { cwd: join(f.home, 'other-folder') })).status, 0)
  const text = readFileSync(f.progress, 'utf8')
  assert.match(text, /^## Kept project\r?$/m)
  assert.ok(!text.includes('## other-folder'), text)
}))

// 0.24.2 wrote /board for Gemini CLI and OpenCode, with --serve; #868 renames it to /agent-board and runs no flag.
const commandOf0242 = (f, agent) => {
  const kind = agent === 'gemini' ? { old: join(f.home, '.gemini', 'commands', 'board.toml'), now: join(f.home, '.gemini', 'commands', 'agent-board.toml') }
    : { old: join(f.home, '.config', 'opencode', 'commands', 'board.md'), now: join(f.home, '.config', 'opencode', 'commands', 'agent-board.md') }
  const written = readFileSync(kind.now, 'utf8')
  const text = agent === 'gemini' ? written.replace("}\n'''\n", " --serve}\n'''\n") : written.replace(/`\n$/, ' --serve`\n')
  assert.notEqual(text, written)
  // The 0.24.2 install: the old file on disk, listed in its record, and no new one.
  const record = join(f.root, `install-${agent}.json`)
  const manifest = JSON.parse(readFileSync(record, 'utf8'))
  delete manifest.files[kind.now]
  manifest.files[kind.old] = createHash('sha256').update(text).digest('hex')
  rmSync(kind.now)
  writeFileSync(kind.old, text)
  writeFileSync(record, `${JSON.stringify(manifest, null, 2)}\n`)
  return { ...kind, text, record }
}

for (const agent of ['gemini', 'opencode']) {
  test(`${agent} setup writes /agent-board that opens the page with no flag`, () => fixture(f => {
    assert.equal(f.install('--agent', agent, '--apply').status, 0)
    const file = join(f.home, ...(agent === 'gemini' ? ['.gemini', 'commands', 'agent-board.toml'] : ['.config', 'opencode', 'commands', 'agent-board.md']))
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes(f.script), text)
    assert.ok(!text.includes('--serve'), text)
    assert.equal(existsSync(join(file, '..', agent === 'gemini' ? 'board.toml' : 'board.md')), false)
  }))

  test(`${agent} setup on a 0.24.2 install retires the unchanged /board file, names it and writes /agent-board`, () => fixture(f => {
    assert.equal(f.install('--agent', agent, '--apply').status, 0)
    const old = commandOf0242(f, agent)
    const preview = f.install('--agent', agent, '--json')
    assert.equal(preview.status, 0, preview.stderr)
    const plan = JSON.parse(preview.stdout)
    assert.deepEqual(plan.conflicts, [])
    assert.deepEqual(plan.changes.filter(change => change.file === old.old), [{ file: old.old, action: 'remove' }])
    assert.deepEqual(plan.changes.filter(change => change.file === old.now), [{ file: old.now, action: 'create' }])
    const plain = setupAgent(f, '--lang', 'en', '--agent', agent)
    assert.match(plain.stdout, /board\.(toml|md) \(the old \/board command; setup removes it\)/, plain.stdout)
    assert.equal(existsSync(old.old), true, 'a preview changes nothing')
    const applied = f.install('--agent', agent, '--apply', '--json')
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(existsSync(old.old), false)
    assert.equal(existsSync(old.now), true)
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(old.record, 'utf8')).files, old.old), false)
    assert.deepEqual(JSON.parse(f.install('--agent', agent, '--json').stdout).changes, [])
  }))

  test(`${agent} setup on a 0.24.2 install keeps an edited /board file and names it, with no INSTALL_CONFLICT`, () => fixture(f => {
    assert.equal(f.install('--agent', agent, '--apply').status, 0)
    const old = commandOf0242(f, agent)
    writeFileSync(old.old, `${old.text}\nMy own line\n`)
    const plan = JSON.parse(f.install('--agent', agent, '--json').stdout)
    assert.deepEqual(plan.conflicts, [])
    assert.deepEqual(plan.keptEdited, [old.old])
    assert.equal(plan.changes.some(change => change.file === old.old), false)
    const plain = setupAgent(f, '--lang', 'en', '--agent', agent)
    assert.match(plain.stdout, /board\.(toml|md) \(your edited old \/board command; setup leaves it; the command is now \/agent-board\)/, plain.stdout)
    const applied = f.install('--agent', agent, '--apply', '--json')
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(readFileSync(old.old, 'utf8'), `${old.text}\nMy own line\n`)
    assert.equal(existsSync(old.now), true)
  }))

  test(`${agent} removal of a 0.24.2 install also takes the unchanged /board file, and leaves an edited one`, () => fixture(f => {
    assert.equal(f.install('--agent', agent, '--apply').status, 0)
    const old = commandOf0242(f, agent)
    const removed = remove774(f, agent)
    assert.equal(removed.status, 0, removed.stderr)
    assert.deepEqual(JSON.parse(removed.stdout).conflicts, [])
    assert.equal(existsSync(old.old), false)
    assert.equal(existsSync(old.now), false)
    assert.equal(f.install('--agent', agent, '--apply').status, 0)
    const edited = commandOf0242(f, agent)
    writeFileSync(edited.old, `${edited.text}\nMy own line\n`)
    const kept = remove774(f, agent)
    assert.equal(kept.status, 0, kept.stderr)
    assert.deepEqual(JSON.parse(kept.stdout).keptEdited, [edited.old])
    assert.equal(readFileSync(edited.old, 'utf8'), `${edited.text}\nMy own line\n`)
  }))
}

const cursorSessionRecord = (f, id) => JSON.parse(readFileSync(join(f.root, 'sessions', createHash('sha256').update(`cursor:${id}`).digest('hex') + '.json'), 'utf8'))
const cursorHook = (f, name, id, cwd, extra = {}) => spawnSync(process.execPath, [f.script, '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--codex-event', '--agent', 'cursor'], {
  cwd: f.home, env: { ...f.env, CODEX_THREAD_ID: undefined }, input: JSON.stringify({ conversation_id: id, generation_id: `gen-${id}`, hook_event_name: name, workspace_roots: [cwd], ...extra }), encoding: 'utf8', windowsHide: true, timeout: 15000,
})
const cursorReport = (f, cwd, payload, extraEnv = {}) => spawnSync(process.execPath, [f.script, '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--codex-report', '--agent', 'cursor'], {
  cwd, env: { ...f.env, CODEX_THREAD_ID: undefined, AGENT_BOARD_AGENT: undefined, AGENT_BOARD_SESSION_ID: undefined, ...extraEnv }, input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 15000,
})
const cursorSteps = { title: 'Synthetic Cursor task', project: 'demo', state: 'waiting', steps: ['- [x] Read the files', '- [~] Write the change', '- [?] Blue or green?'] }

test('a Cursor report with no injected environment lands under the one active Cursor session of this folder', () => fixture(f => {
  assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
  const cwd = join(f.home, 'demo')
  mkdirSync(cwd)
  for (const name of ['sessionStart', 'beforeSubmitPrompt']) assert.equal(cursorHook(f, name, 'cursor-session-one', cwd).status, 0)
  assert.match(cursorSessionRecord(f, 'cursor-session-one').folderDigest, /^[a-f0-9]{64}$/)
  const report = cursorReport(f, cwd, cursorSteps)
  assert.equal(report.status, 0, report.stderr)
  assert.equal(JSON.parse(report.stdout).session, 'cursor-session-one')
  const text = readFileSync(f.progress, 'utf8')
  for (const step of cursorSteps.steps) assert.ok(text.includes(step), text)
}))

test('a Cursor report with no injected environment is not connected when two Cursor sessions are active in the folder', () => fixture(f => {
  assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
  const cwd = join(f.home, 'demo')
  mkdirSync(cwd)
  for (const id of ['cursor-session-one', 'cursor-session-two']) for (const name of ['sessionStart', 'beforeSubmitPrompt']) assert.equal(cursorHook(f, name, id, cwd).status, 0)
  const report = cursorReport(f, cwd, cursorSteps)
  assert.notEqual(report.status, 0)
  assert.equal(report.stdout, '')
  assert.equal(report.stderr.trim(), 'This report is not bound to a session; continue your work without editing the board.')
}))

test('a Cursor report with the injected environment still binds to that session', () => fixture(f => {
  assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
  const cwd = join(f.home, 'demo')
  mkdirSync(cwd)
  for (const id of ['cursor-session-one', 'cursor-session-two']) for (const name of ['sessionStart', 'beforeSubmitPrompt']) assert.equal(cursorHook(f, name, id, cwd).status, 0)
  const report = cursorReport(f, cwd, cursorSteps, { AGENT_BOARD_AGENT: 'cursor', AGENT_BOARD_SESSION_ID: 'cursor-session-two' })
  assert.equal(report.status, 0, report.stderr)
  assert.equal(JSON.parse(report.stdout).session, 'cursor-session-two')
}))

test('the local agent instructions tell Cursor to report from the project folder without waiting for injected variables', async () => {
  const { STRINGS } = await sourceModules()
  for (const [lang, s] of Object.entries(STRINGS)) {
    const skill = s.localAgentSkill('board')
    assert.doesNotMatch(skill, /AGENT_BOARD_SESSION_ID|AGENT_BOARD_AGENT/, lang)
    assert.match(skill, /Cursor|cursor/, lang)
    assert.ok(skill.includes('board --codex-report --agent cursor'), lang)
  }
})

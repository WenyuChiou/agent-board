import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { reporterPs1, reporterSh } from '../hooks/hook-reporters.ts'
import { classifierDiagnostic, observeClassifier } from './fixtures/classifier-diagnostic.mjs'

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

const fireCommand = (f, command, input, limit = 10000) => {
  const isWindows = process.platform === 'win32'
  return nativeProcess(isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', isWindows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command], f.env, input,
    callback => setTimeout(callback, limit), stopNativeTree, { windowsVerbatimArguments: isWindows })
}
const fireHook = (f, input, limit) => fireCommand(f, JSON.parse(readFileSync(f.hooks, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command, input, limit)

const hookFailure = result => JSON.stringify({ status: result.status, signal: result.signal, error: result.error && { code: result.error.code, message: result.error.message }, termination: result.termination, stdout: result.stdout, stderr: result.stderr })

// These synthetic reporters are grandchildren, so wait for their recorded PID
// as well as the command's pipes before allowing fixture removal after a failure.
const isReporterAlive = pid => {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}
const stopReporter = async pid => {
  if (!Number.isInteger(pid) || pid <= 0 || !isReporterAlive(pid)) return
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

const fixture = async fn => {
  const home = mkdtempSync(join(tmpdir(), 'codex local-'))
  const root = join(home, '.agent-board')
  const script = join(root, 'agent-board.mjs')
  const progress = join(root, 'progress.md')
  const hooks = join(home, '.codex', 'hooks.json')
  const skill = join(home, '.agents', 'skills', 'agent-board', 'SKILL.md')
  const env = { ...isolatedEnv(home), CODEX_THREAD_ID: session, NO_COLOR: '1' }
  const run = (file, args, input) => spawnSync(process.execPath, [file, ...args], { env, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const isolated = ['--home', home, '--codex-dir', join(home, '.codex'), '--grok-dir', join(home, '.grok'), '--hermes-dir', join(home, '.hermes')]
  const install = (...args) => run(setup, [...isolated, ...args])
  const command = (args, input) => run(script, [...isolated, ...args], input)
  const save = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
  const report = (state = 'working', steps = ['- [~] Real task']) => command(['--codex-report'], { title: 'Task', state, steps })
  const event = (name, turn = 'turn-1', extra = {}) => command(['--codex-event'], { session_id: session, hook_event_name: name, turn_id: turn, ...extra })
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

test('independent prompt metadata answers questions while ordinary activity and replay preserve newer questions', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-prompt-1').status, 0)
  assert.equal(f.report('waiting', ['- [?] Choose database', '- [ ] Continue']).status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-prompt-2', { prompt: 'PRIVATE_NEW_INPUT' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /state=working/)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[x\] Choose database/)
  assert.equal(f.report('waiting', ['- [?] New question', '- [ ] Continue']).status, 0)
  assert.equal(f.event('UserPromptSubmit', 'turn-prompt-2').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] New question/)
  assert.equal(f.install('--agent', 'grok', '--apply').status, 0)
  const owner = 'grok-prompt-owner'
  assert.equal(f.command(['--codex-report', '--agent', 'grok', '--session', owner], { title: 'Grok task', state: 'waiting', steps: ['- [?] Grok decision', '- [ ] Continue'] }).status, 0)
  assert.equal(f.command(['--agent-status', '--agent', 'grok', '--state', 'working'], { session_id: owner }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[\?\] Grok decision/)
  assert.equal(f.command(['--agent-status', '--agent', 'grok', '--state', 'working'], { session_id: owner, hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_NEW_INPUT' }).status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /- \[x\] Grok decision/)
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
  assert.match(readFileSync(f.progress, 'utf8'), /- \[x\] Choose database/)
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
    assert.match(readFileSync(join(f.root, 'hook-errors.log'), 'utf8'), /codex REPORTER_TIMEOUT/)
    assert.deepEqual(readFileSync(f.progress), held)
  } finally {
    // The outer test deadline is a backstop for a broken implementation, too.
    if (!wasReaped && existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      await stopReporter(pid)
    }
  }
}))

test('a reporter error is logged and the previous block is kept', () => fixture(async f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.report().status, 0)
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

test('SDK metadata and reporter execution share one deadline without a late write', () => fixture(async f => {
  const { home, env, root } = f
  const marker = join(home, 'late-report'), pidFile = join(home, 'reporter.pid')
  let childPid
  try {
    const installed = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'opencode', '--apply'], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    assert.equal(installed.status, 0, installed.stderr)
    const source = readFileSync(join(home, '.config', 'opencode', 'plugins', 'agent-board-local.js'), 'utf8')
    const stub = 'const tool = Object.assign(value => value, { schema: { string: () => ({}), enum: () => ({}), array: () => ({}) } })'
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
  const first = await nativeProcess(executable, args, env, payload, callback => setTimeout(callback, 10000))
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.stdout.trim(), '{}')
  const delivered = readdirSync(inbox).filter(name => name.endsWith('.json'))
  assert.equal(delivered.length, 1)
  assert.equal(readFileSync(join(inbox, delivered[0]), 'utf8'), payload)
  const log = join(home, '.agent-board', 'hook-errors.log')
  mkdirSync(dirname(log), { recursive: true })
  writeFileSync(log, Array.from({ length: 250 }, (_, index) => `synthetic old error ${index}\n`).join(''))
  const unfinished = await nativeProcess(executable, args, env, '{"PRIVATE_UNFINISHED_INPUT":',
    callback => setTimeout(callback, 10000), stopNativeTree, { isInputOpen: true })
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
  const lookup = spawnSync(powershell, ['-NoProfile', '-Command', '$c = @(Get-Command node -CommandType Application -ErrorAction Stop); $c.Count'], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(lookup.error, undefined)
  assert.equal(lookup.status, 0, 'the controlled application lookup must succeed')
  assert.equal(lookup.stdout.trim(), '2', 'exercise two real ApplicationInfo results, not a mocked lookup')
  const file = join(f.root, 'progress-report.ps1'), diagnostic = join(f.home, 'classifier-probe.txt')
  const raw = JSON.stringify({ session_id: 'synthetic-multiple-node', cwd: '/synthetic/中文', prompt: '/board' })
  const source = reporterPs1()
  assert.ok(source.includes(' -TotalCount 1'))
  for (const isCapped of [false, true]) {
    rmSync(inbox, { recursive: true, force: true })
    rmSync(diagnostic, { force: true })
    f.save(file, observeClassifier(isCapped ? source : source.replace(' -TotalCount 1', ''), diagnostic))
    const result = await nativeProcess(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, 'codex', 'prompt'], env, raw, callback => setTimeout(callback, 10000))
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, classifierDiagnostic(diagnostic))
    const saved = existsSync(inbox) ? readdirSync(inbox).filter(name => name.endsWith('.json')).map(name => ({ body: readFileSync(join(inbox, name), 'utf8') })) : []
    assert.equal(saved.length, 1, classifierDiagnostic(diagnostic))
    if (isCapped) {
      assert.match(classifierDiagnostic(diagnostic), /phase=complete started=1/)
      assert.deepEqual(JSON.parse(saved[0].body), { session_id: 'synthetic-multiple-node', cwd: '/synthetic/中文', board_request: true })
      assert.ok(!/[^\x20-\x7e]/.test(saved[0].body))
    } else {
      assert.match(classifierDiagnostic(diagnostic), /phase=start started=0 .*nativeCode=2 /)
      assert.deepEqual(JSON.parse(saved[0].body), JSON.parse(raw), 'uncapped control demonstrates the existing non-timeout fallback')
    }
  }
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
      callback => setTimeout(callback, 10000))
    assert.equal(out.error, undefined, hookFailure(out))
    assert.equal(out.status, 0, hookFailure(out))
    assert.equal(out.stdout.trim(), '{}')
    assert.equal(existsSync(pidFile), true, `exercise the real classifier process${isWindows ? ': ' + classifierDiagnostic(diagnostic) : ''}`)
    assert.equal(isReporterAlive(Number(readFileSync(pidFile, 'utf8'))), false)
    assert.deepEqual(readdirSync(inbox), [])
    const log = readFileSync(join(f.root, 'hook-errors.log'), 'utf8')
    assert.match(log, /REPORTER_TIMEOUT/)
    assert.ok(!log.includes('PRIVATE_') && !log.includes(f.home))
  } finally {
    if (existsSync(pidFile)) await stopReporter(Number(readFileSync(pidFile, 'utf8')))
  }
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
    assert.deepEqual(readdirSync(inbox), [])
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
  assert.match(f.command(['--codex-trust']).stderr, /CODEX_BINARY_REQUIRED/)
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

test('Codex lifecycle hooks never read transcripts or retain conversation and approval payloads', () => fixture(f => {
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

test('local reports refuse a closing marker beyond another task block', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  assert.equal(f.report().status, 0)
  const owned = readFileSync(f.progress, 'utf8')
  const end = owned.match(/<!-- \/auto session=[a-f0-9]{8} -->/)[0]
  const other = '## Personal\n<!-- auto session=12345678 agent=dot state=waiting -->\n### Keep this task\n- [ ] Keep this step\n<!-- /auto session=12345678 -->\n'
  const before = owned.replace(end, '') + other + end + '\n'
  writeFileSync(f.progress, before)
  const result = f.report('done', ['- [x] Finished'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /BLOCK_CONFLICT/)
  assert.equal(readFileSync(f.progress, 'utf8'), before)
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
  try {
    const env = isolatedEnv(home)
    const installed = spawnSync(process.execPath, [setup, '--home', home, '--agent', 'opencode', '--apply'], { env, encoding: 'utf8', windowsHide: true })
    assert.equal(installed.status, 0, installed.stderr)
    const plugin = join(home, '.config', 'opencode', 'plugins', 'agent-board-local.js')
    const source = readFileSync(plugin, 'utf8')
    assert.ok(!source.includes('session.messages') && !source.includes('transcript'))
    // A minimal SDK stand-in verifies our adapter only, not OpenCode host discovery.
    const stub = 'const tool = Object.assign(value => value, { schema: { string: () => ({}), enum: () => ({}), array: () => ({}) } })'
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
  } finally { rmSync(home, { recursive: true, force: true }) }
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
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, f.script, '--codex-setup', '--home', f.home, '--codex-dir', join(f.home,'.codex'), '--apply'], {env:f.env, encoding:'utf8', windowsHide:true})
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
  const launch = process.platform === 'win32' ? Buffer.from(stop.split(' ').at(-1), 'base64').toString('utf16le') : stop
  assert.match(launch, /--state['"]? ['"]?waiting['"]? ['"]?--event['"]? ['"]?Stop/)
  assert.deepEqual(JSON.parse(f.install('--agent', 'antigravity').stdout).changes, [])
  assert.equal(f.command(['--codex-remove', '--agent', 'antigravity', '--apply']).status, 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), foreign)
}))

const nativeTreeFixture = f => {
  const ready = join(f.home, 'descendant-ready.json')
  const pulse = join(f.home, 'descendant-pulse.txt')
  const descendant = join(f.home, 'descendant.mjs')
  f.save(descendant, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid })); setInterval(() => writeFileSync(${JSON.stringify(pulse)}, String(Date.now())), 20)`)
  const parent = join(f.home, 'parent.mjs')
  const parentReady = join(f.home, 'parent-ready.json')
  f.save(parent, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(parentReady)}, JSON.stringify({ pid: process.pid, ppid: process.ppid })); spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`)
  const argv = [process.execPath, parent]
  const command = process.platform === 'win32'
    ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`& ${argv.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}; exit $LASTEXITCODE`, 'utf16le').toString('base64')}`
    : argv.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')
  return { command, ready, pulse, parentReady }
}

const waitForNativeTree = async ({ ready, pulse, parentReady }) => {
  const until = Date.now() + 30000
  while ((!existsSync(pulse) || !existsSync(parentReady)) && Date.now() < until) await new Promise(done => setTimeout(done, 25))
  assert.ok(existsSync(ready) && existsSync(pulse) && existsSync(parentReady), 'the synthetic parent and descendant must start before testing timeout cleanup')
}

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
    assert.equal(result.error, undefined, result.stderr)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.ok(Date.now() - started < 45000, 'the isolated test process must actually exit before the watchdog')
    assert.equal(owned?.code, 'NATIVE_HOOK_UNREAPED', JSON.stringify(owned))
    assert.equal(owned.keepFixture, true)
    assert.equal(owned.isStarted, true)
    assert.equal(owned.isVerified, true, 'a probe assertion failure must not masquerade as the expected exit')
    for (const key of ['pid', 'probePid', 'parentPid', 'parentParentPid', 'descendantPid']) assert.ok(Number.isInteger(owned[key]) && owned[key] > 0, `the probe must record ${key}`)
    assert.ok(existsSync(owned.home), 'the failed process must leave its fixture for owned cleanup')
    assert.ok(result.stderr.includes('did not close') || result.stdout.includes('did not close'), result.stdout + result.stderr)
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
        else if (error.code !== 'ESRCH') throw error
        return false
      }
    }
    // A POSIX group can outlive its leader. Windows needs each recorded child:
    // cmd may already be gone while PowerShell and parent.mjs are still alive.
    if (process.platform !== 'win32' && Number.isInteger(owned?.pid)) stopped.push({ pid: owned.pid, ...stopNativeTree({ pid: owned.pid }) })
    for (const pid of pids) if (isAlive(pid)) {
      if (process.platform === 'win32') stopped.push({ pid, ...stopNativeTree({ pid }) })
      else {
        try { process.kill(pid, 'SIGKILL'); stopped.push({ pid, status: 0 }) } catch (error) {
          if (error.code === 'EPERM') notOurs.add(pid)
          else if (error.code !== 'ESRCH') throw error
        }
      }
    }
    const until = Date.now() + 5000
    while (pids.some(isAlive) && Date.now() < until) await new Promise(done => setTimeout(done, 25))
    for (const pid of pids) if (!notOurs.has(pid)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `Owned cleanup failed; fixture retained: ${JSON.stringify({ pid, stopped, home: owned?.home, control })}`)
    const remove = (directory, prefix) => {
      const target = resolve(directory), temporary = resolve(tmpdir())
      assert.equal(dirname(target), temporary)
      assert.ok(target.startsWith(join(temporary, prefix)), 'remove only this owned synthetic fixture')
      rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
    }
    if (owned?.home) remove(owned.home, 'codex local-')
    remove(control, 'native-exit-')
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
    assert.equal(result.status, 0, hookFailure(result)); assert.deepEqual(JSON.parse(result.stdout), {})
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

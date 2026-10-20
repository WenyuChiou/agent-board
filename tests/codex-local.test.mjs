import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const setup = resolve('scripts/setup-codex.mjs')
const session = 'test-codex-session-123'
// A runner may set XDG/host overrides. No synthetic home may inherit those and
// write into another test or the account's actual native configuration.
const isolatedEnv = home => ({
  ...process.env, CLAUDE_PROGRESS_FILE: '',
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

const nativeHook = (command, env, input, after = setTimeout, stop = stopNativeTree) => new Promise((resolve, reject) => {
  const isWin = process.platform === 'win32'
  const child = spawn(isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', [isWin ? '/c' : '-c', command], {
    env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !isWin,
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
    error = Object.assign(new Error('native hook exceeded 30000ms'), { code: 'ETIMEDOUT' })
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
    notifyClosed({ status, signal })
    resolve({ status, signal, error, termination, stdout, stderr })
  })
  child.stdin.end(JSON.stringify(input))
})

const hookFailure = result => JSON.stringify({ status: result.status, signal: result.signal, error: result.error && { code: result.error.code, message: result.error.message }, termination: result.termination, stdout: result.stdout, stderr: result.stderr })

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

test('Codex-only setup previews every persistent change without writing', () => fixture(f => {
  const plan = f.install()
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(JSON.parse(plan.stdout).changes.length, 5)
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

test('the generated Codex hook command runs through the platform shell with JSON on stdin', () => fixture(f => {
  assert.equal(f.install('--apply').status, 0)
  const command = JSON.parse(readFileSync(f.hooks)).hooks.UserPromptSubmit[0].hooks[0].command
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
  const args = isWindows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command]
  const result = spawnSync(shell, args, {
    input: JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', turn_id: 'native-shell-fixture' }),
    encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: isWindows,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(f.progress, 'utf8'), /state=working/)
  const record = JSON.parse(readFileSync(join(f.root, 'sessions', createHash('sha256').update(`codex:${session}`).digest('hex') + '.json')))
  assert.equal(record.turn, 'native-shell-fixture')
  assert.equal(f.event('Stop', 'native-shell-fixture').status, 0)
  const idle = f.command([])
  assert.equal(idle.status, 0, idle.stderr)
  assert.ok(!idle.stdout.includes('running:') && !idle.stdout.includes('session ended'), idle.stdout)
}))

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

test('Cursor initializes independently and binds conversation and generation metadata', () => fixture(f => {
  assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
  const hooks = JSON.parse(readFileSync(join(f.home, '.cursor', 'hooks.json')))
  assert.equal(hooks.version, 1)
  assert.ok(hooks.hooks.sessionStart[0].command.includes('--agent cursor'))
  const send = (hook_event_name, generation_id = 'generation-1') => f.command(['--codex-event', '--agent', 'cursor'], { hook_event_name, conversation_id: 'cursor-conversation-123', generation_id, transcript_path: '/never/read', text: 'NEVER_STORE_CURSOR_TEXT' })
  assert.deepEqual(JSON.parse(send('sessionStart').stdout).env, { AGENT_BOARD_SESSION_ID: 'cursor-conversation-123', AGENT_BOARD_AGENT: 'cursor' })
  assert.equal(send('beforeSubmitPrompt').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /agent=cursor .*state=working/)
  assert.equal(send('stop').status, 0)
  assert.match(readFileSync(f.progress, 'utf8'), /state=waiting/)
  assert.ok(!readFileSync(f.progress, 'utf8').includes('NEVER_STORE_CURSOR_TEXT'))
  send('beforeSubmitPrompt', 'generation-2')
  assert.notEqual(send('stop', 'generation-1').status, 0)
  assert.deepEqual(JSON.parse(f.install('--agent', 'cursor').stdout).changes, [])
}))

test('removing one agent preserves the shared board and skill used by another agent', () => fixture(f => {
  f.install('--apply')
  assert.equal(f.install('--agent', 'cursor', '--apply').status, 0)
  assert.equal(f.command(['--codex-remove', '--agent', 'cursor', '--apply']).status, 0)
  assert.ok(existsSync(f.script) && existsSync(f.skill))
  assert.equal(f.report().status, 0)
  assert.equal(f.command(['--codex-remove', '--apply']).status, 0)
  assert.ok(!existsSync(f.script) && !existsSync(f.skill))
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
    assert.throws(() => emit('end', 'native-run-1'), /AGENT_BOARD_REPORT_FAILED/)
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
    assert.deepEqual(warnings, ['AGENT_BOARD_REPORT_FAILED'])
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
  assert.equal(result.status, 0, result.stderr)
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
  f.save(parent, `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`)
  const argv = [process.execPath, parent]
  const command = process.platform === 'win32'
    ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`& ${argv.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}; exit $LASTEXITCODE`, 'utf16le').toString('base64')}`
    : argv.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')
  return { command, ready, pulse }
}

const waitForNativeTree = async ({ ready, pulse }) => {
  const until = Date.now() + 30000
  while (!existsSync(pulse) && Date.now() < until) await new Promise(done => setTimeout(done, 25))
  assert.ok(existsSync(ready) && existsSync(pulse), 'the synthetic descendant must start before testing timeout cleanup')
}

test('native hook timeouts close their owned descendant tree before fixture cleanup', { timeout: 60000 }, () => fixture(async f => {
  const tree = nativeTreeFixture(f)
  let expire
  const result = nativeHook(tree.command, f.env, {}, callback => { expire = callback })
  let closed
  try {
    await waitForNativeTree(tree)
  } finally {
    expire()
    closed = await result
  }
  assert.equal(closed.error?.code, 'ETIMEDOUT', hookFailure(closed))
  assert.notEqual(closed.status, 0, hookFailure(closed))
  if (process.platform === 'win32') assert.equal(closed.termination?.status, 0, hookFailure(closed))
  const last = readFileSync(tree.pulse, 'utf8')
  await new Promise(done => setTimeout(done, 100))
  assert.equal(readFileSync(tree.pulse, 'utf8'), last, 'a descendant must not keep writing after the helper closes')
}))

test('failed native tree termination reports a bounded error and retains its fixture', { timeout: 60000 }, async () => {
  let failure, home, isStarted = false
  try {
    await assert.rejects(fixture(async f => {
      home = f.home
      const tree = nativeTreeFixture(f)
      let expire
      const result = nativeHook(tree.command, f.env, {}, callback => { expire = callback }, () => ({ status: 1, code: 'SYNTHETIC_DENIED' }))
      try {
        await waitForNativeTree(tree)
        isStarted = true
      } finally {
        expire()
        await result
      }
    }), error => {
      failure = error
      return error.code === 'NATIVE_HOOK_UNREAPED' && error.keepFixture === true && error.termination.code === 'SYNTHETIC_DENIED'
    })
    assert.ok(isStarted)
    assert.ok(existsSync(home), 'unconfirmed termination must not remove the fixture')
  } finally {
    // The deliberate refusal above leaves an owned tree alive. The real OS stop
    // is used now, and its close is confirmed before removing this test's home.
    if (failure?.pid) {
      const stopped = stopNativeTree({ pid: failure.pid })
      assert.equal(stopped.status, 0, JSON.stringify({ ...stopped, pid: failure.pid, home }))
      let guard
      try {
        await Promise.race([failure.whenClosed, new Promise((_, fail) => { guard = setTimeout(() => fail(new Error(`Owned tree ${failure.pid} did not close; fixture retained: ${home}`)), 2000) })])
      } finally { clearTimeout(guard) }
    }
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
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

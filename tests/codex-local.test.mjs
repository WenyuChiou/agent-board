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
const fixture = fn => {
  const home = mkdtempSync(join(tmpdir(), 'codex local-'))
  const root = join(home, '.agent-board')
  const script = join(root, 'agent-board.mjs')
  const progress = join(root, 'progress.md')
  const hooks = join(home, '.codex', 'hooks.json')
  const skill = join(home, '.agents', 'skills', 'agent-board', 'SKILL.md')
  const env = { ...process.env, CLAUDE_PROGRESS_FILE: '', CODEX_THREAD_ID: session, NO_COLOR: '1' }
  const run = (file, args, input) => spawnSync(process.execPath, [file, ...args], { env, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const isolated = ['--home', home, '--codex-dir', join(home, '.codex'), '--grok-dir', join(home, '.grok'), '--hermes-dir', join(home, '.hermes')]
  const install = (...args) => run(setup, [...isolated, ...args])
  const command = (args, input) => run(script, [...isolated, ...args], input)
  const save = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
  const report = (state = 'working', steps = ['- [~] Real task']) => command(['--codex-report'], { title: 'Task', state, steps })
  const event = (name, turn = 'turn-1', extra = {}) => command(['--codex-event'], { session_id: session, hook_event_name: name, turn_id: turn, ...extra })
  try { return fn({ home, root, script, progress, hooks, skill, env, install, command, save, report, event }) }
  finally { rmSync(home, { recursive: true, force: true }) }
}

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
    const env = { ...process.env, CLAUDE_PROGRESS_FILE: '' }
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
    const instance = await AgentBoardLocal({ client: { session: { get: async () => ({ data: {} }) } } })
    await instance.event({ event: { type: 'session.status', properties: { sessionID: 'opencode-session-123', status: { type: 'busy' } } } })
    const progress = join(home, '.agent-board', 'progress.md')
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

test('auto setup does not mistake an Antigravity profile or the shared gemini directory for Gemini CLI', () => fixture(f => {
  mkdirSync(join(f.home, '.gemini', 'antigravity-cli'), { recursive: true })
  const args = [resolve('scripts/setup-agent.mjs'), '--home', f.home, '--codex-dir', join(f.home, '.codex')]
  const run = () => spawnSync(process.execPath, args, { env: { ...process.env, CLAUDE_PROGRESS_FILE: '' }, encoding: 'utf8', windowsHide: true })
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).targets, ['antigravity'])
  assert.equal(existsSync(join(f.home, '.gemini', 'settings.json')), false)
  f.save(join(f.home, '.gemini', 'settings.json'), '{}')
  assert.deepEqual(JSON.parse(run().stdout).targets, ['gemini', 'antigravity'])
}))

test('all targets initialize one shared board and explicitly name unfinished native adapters', () => fixture(f => {
  const installer = resolve('scripts/setup-agent.mjs')
  const result = spawnSync(process.execPath, [installer, '--agent', 'all', '--home', f.home, '--codex-dir', join(f.home, '.codex'), '--grok-dir', join(f.home, '.grok'), '--hermes-dir', join(f.home, '.hermes'), '--apply'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '' }, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  const plans = JSON.parse(result.stdout).plans
  assert.equal(plans.length, 9)
  assert.equal(new Set(plans.map(plan => plan.progress)).size, 1)
  for (const agent of ['hermes', 'openclaw']) assert.equal(plans.find(plan => plan.agent === agent).capabilities.lifecycle, 'adapter-pending')
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

test('native Antigravity hook commands bind conversationId, record metadata only and keep Stop resumable', () => fixture(f => {
  assert.equal(f.install('--agent', 'antigravity', '--apply').status, 0)
  const hooks = JSON.parse(readFileSync(join(f.home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board-local']
  const conversationId = '11111111-2222-4333-8444-555555555555'
  const record = join(f.root, 'sessions', createHash('sha256').update('antigravity:' + conversationId).digest('hex') + '.json')
  // Match the native Windows executor's cmd /c + CreateProcess argument escaping,
  // not Node's shell:true workaround. The installation path deliberately has spaces.
  const fire = event => spawnSync(process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', [process.platform === 'win32' ? '/c' : '-c', hooks[event][0].command], { env: f.env, input: JSON.stringify({ conversationId, session_id: 'foreign-id-must-not-bind', transcriptPath: 'PRIVATE_TRANSCRIPT_DO_NOT_OPEN', workspacePaths: ['PRIVATE_WORKSPACE'], prompt: 'PRIVATE_PROMPT', toolCall: { args: 'PRIVATE_TOOL' } }), encoding: 'utf8', windowsHide: true, timeout: 10000 })
  for (const event of Object.keys(hooks)) {
    const result = fire(event)
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {})
    const saved = JSON.parse(readFileSync(record, 'utf8'))
    assert.equal(saved.session, conversationId)
    assert.equal(saved.activity.at(-1).event, event)
    assert.equal(saved.state, event === 'SessionStart' || event === 'Stop' ? 'waiting' : 'working')
    assert.ok(!JSON.stringify(saved).includes('PRIVATE_'))
  }
  const saved = JSON.parse(readFileSync(record, 'utf8'))
  assert.deepEqual(saved.activity.map(one => one.event), Object.keys(hooks))
  assert.ok(readFileSync(f.progress, 'utf8').includes('resume=' + conversationId))
  assert.equal(fire('PreInvocation').status, 0)
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
    const env = { ...process.env, CLAUDE_PROGRESS_FILE: '' }
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

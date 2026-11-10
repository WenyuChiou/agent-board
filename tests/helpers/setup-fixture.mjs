import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupPrograms } from './setup-programs.mjs'

const installer = fileURLToPath(new URL('../../scripts/setup-agent.mjs', import.meta.url))
const launcher = fileURLToPath(new URL('../../bin/agent-board.mjs', import.meta.url))
const source = readFileSync(installer, 'utf8')
const start = source.indexOf('const summaries = ') + 'const summaries = '.length
export const bootstrap = JSON.parse(source.slice(start, source.indexOf('\nconst summary = ', start)))
export const locales = ['en', 'zh-TW', 'zh-CN']

export const fixture = run => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-setup-guidance-'))
  const env = { ...process.env }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'HERMES_HOME', 'GROK_HOME', 'OPENCLAW_STATE_DIR', 'DSH_HOME', 'TMP', 'TEMP', 'TMPDIR']) {
    env[name] = join(root, name)
    mkdirSync(env[name], { recursive: true, mode: 0o700 })
  }
  env.CLAUDE_PROGRESS_FILE = join(root, 'progress.md')
  env.AGENT_BOARD_SETUP_COMMAND = ''
  for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'AGENT_BOARD_AGENT', 'AGENT_BOARD_SESSION_ID', 'AGENT_BOARD_SETUP_TTY', 'AGENT_BOARD_TEST_CODEX_FAIL', 'AGENT_BOARD_TEST_CLAUDE_FAIL']) delete env[name]
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = [dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'] : ['/usr/bin', '/bin'])].join(delimiter)
  const invoke = (file, prefix, args, input) => spawnSync(process.execPath, [file, ...prefix, '--home', env.HOME, '--data-dir', join(root, 'data'), '--progress-file', env.CLAUDE_PROGRESS_FILE, ...args], { env, input, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  const runCommand = (file, prefix, args) => {
    const child = invoke(file, prefix, args)
    assert.equal(child.status, 0, 'synthetic setup failed: ' + JSON.stringify({ status: child.status, signal: child.signal, code: child.error?.code }))
    return child.stdout
  }
  const setup = (...args) => runCommand(installer, [], args)
  const launch = (...args) => runCommand(launcher, ['setup'], args)
  try { return run(setup, { launch, env, root, invoke: (args, input = '\n') => invoke(installer, [], args, input) }) } finally { rmSync(root, { recursive: true, force: true }) }
}

export const terminal = (run, programs) => fixture((setup, f) => {
  f.env.USERPROFILE = f.env.HOME
  f.env.AGENT_BOARD_SETUP_TTY = '1'
  f.env.AGENT_BOARD_TEST_PID = String(process.pid)
  const commands = setupPrograms(f.root, f.env, programs)
  return run({ ...f, commands })
})
export const succeeded = result => {
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
}
export const claudeCalls = f => f.commands.calls().filter(call => call.program === 'claude').map(call => call.args)
export const pluginCommands = [['plugin', 'marketplace', 'add', 'WenyuChiou/agent-board'], ['plugin', 'install', 'agent-board@agent-board']]
export const assertTrusted = f => {
  const calls = f.commands.calls().filter(call => call.method === 'config/batchWrite')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.edits[0].keyPath, 'hooks.state')
  assert.equal(Object.keys(calls[0].params.edits[0].value).length, 7)
  assert.equal((readFileSync(join(f.env.CODEX_HOME, 'config.toml'), 'utf8').match(/trusted_hash/g) ?? []).length, 7)
  const approvals = JSON.parse(readFileSync(join(f.env.HERMES_HOME, 'shell-hooks-allowlist.json'), 'utf8')).approvals
  const owned = JSON.parse(readFileSync(join(f.root, 'data', 'install-hermes.json'), 'utf8')).groups.hooks
  assert.deepEqual(approvals.map(({ event, command }) => [event, command]), Object.entries(owned))
}

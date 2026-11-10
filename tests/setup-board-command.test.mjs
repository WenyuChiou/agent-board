import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const launcher = fileURLToPath(new URL('../bin/agent-board.mjs', import.meta.url))
const prefix = 'npx @wenyuchiou/agent-board'
const quote = value => /^[\w./:@=-]+$/.test(value) ? value : process.platform === 'win32'
  ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`

const fixture = run => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-command-'))
  const home = join(root, 'synthetic home')
  const env = { ...process.env }
  for (const name of ['HOME', 'USERPROFILE']) env[name] = home
  for (const name of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'HERMES_HOME', 'GROK_HOME', 'OPENCLAW_STATE_DIR', 'DSH_HOME', 'TMP', 'TEMP', 'TMPDIR']) env[name] = join(root, name)
  for (const directory of new Set(Object.values(env).filter(value => typeof value === 'string' && value.startsWith(root)))) mkdirSync(directory, { recursive: true, mode: 0o700 })
  env.CLAUDE_PROGRESS_FILE = ''
  env.AGENT_BOARD_SETUP_COMMAND = ''
  for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'AGENT_BOARD_AGENT', 'AGENT_BOARD_SESSION_ID', 'AGENT_BOARD_SETUP_TTY']) delete env[name]
  const launch = args => spawnSync(process.execPath, [launcher, ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  try { run({ root, home, launch }) } finally { rmSync(root, { recursive: true, force: true }) }
}

for (const [name, options] of [
  ['the default installation', () => []],
  ['a custom data directory with spaces and a quote', root => ['--data-dir', join(root, "board's data")]],
  ['a nondefault progress file', root => ['--progress-file', join(root, 'separate progress', 'work.md')]],
]) test(`setup's printed board command opens ${name} through the package launcher`, () => fixture(({ root, home, launch }) => {
  const args = options(root)
  const setup = launch(['setup', '--agent', 'grok', '--lang', 'en', ...args, '--apply'])
  assert.ifError(setup.error)
  assert.equal(setup.status, 0, setup.stderr)
  const command = setup.stdout.match(/Open the board: (.+)/)?.[1]
  assert.ok(command, 'setup must give its next board command')
  const data = args[0] === '--data-dir' ? args[1] : join(home, '.agent-board')
  const expected = data === join(home, '.agent-board') ? [] : ['--data-dir', data]
  const passed = command === prefix ? [] : ['--data-dir', data]
  // Run exactly the advertised package arguments, with a read-only view instead of opening a browser.
  const board = launch([...passed, '--print'])
  assert.ifError(board.error)
  assert.equal(board.status, 0, 'the printed board command must find the installed board')
  assert.doesNotMatch(board.stderr, /not set up|No board script/)
  assert.ok(board.stdout.trim(), 'the installed board must produce its read-only view')
  assert.equal(command, [prefix, ...expected.map(quote)].join(' '))
}))

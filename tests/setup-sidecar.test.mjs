import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { antigravitySidecarSource } from '../hooks/antigravity-sidecar.ts'

// Setup writes the Antigravity sidecar's two files only when the person says yes (the flag, or the one
// question that defaults to no). It never switches the sidecar on, and a remove takes the files away (#1396).
const installer = fileURLToPath(new URL('../scripts/setup-agent.mjs', import.meta.url))
const TERMS = "Google's terms may not cover it"

const makeEnv = home => {
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  return {
    [pathKey]: process.env[pathKey] ?? '',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } : {}),
    HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), GROK_HOME: join(home, '.grok'),
    HERMES_HOME: join(home, '.hermes'), XDG_CONFIG_HOME: join(home, '.config'),
    OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'), OPENCLAW_STATE_DIR: join(home, '.openclaw'), DSH_HOME: join(home, '.dsh'),
  }
}
const withHome = (body) => {
  const home = mkdtempSync(join(tmpdir(), 'setup-sidecar-test-'))
  try {
    const run = (args, extra = {}) => spawnSync(process.execPath, [installer, '--home', home, '--lang', 'en', ...args], { cwd: home, env: { ...makeEnv(home), ...extra.env }, input: extra.input, encoding: 'utf8', windowsHide: true, timeout: 60000 })
    const dir = join(home, '.gemini', 'config', 'sidecars', 'agent-board')
    body({ home, run, dir })
  } finally { rmSync(home, { recursive: true, force: true }) }
}

test('setup writes no sidecar unless the person asks: a plain apply leaves the folder out', () => withHome(({ run, dir }) => {
  const install = run(['--agent', 'antigravity', '--apply'])
  assert.equal(install.status, 0, install.stderr)
  assert.ok(!existsSync(dir), 'no sidecar folder without a yes')
  assert.ok(!install.stdout.includes(TERMS), install.stdout)
}))

test('with --antigravity-sidecar setup writes sidecar.json and sidecar.mjs, says the terms line, and never enables it', () => withHome(({ home, run, dir }) => {
  const install = run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply'])
  assert.equal(install.status, 0, install.stderr)
  const config = JSON.parse(readFileSync(join(dir, 'sidecar.json'), 'utf8'))
  assert.equal(config.restart_policy, 'always')
  assert.deepEqual(config.args.slice(0, 1), ['sidecar.mjs'])
  assert.equal(config.args[config.args.indexOf('--home') + 1], home)
  assert.ok(!('enabled' in config), 'setup never writes enabled')
  assert.equal(readFileSync(join(dir, 'sidecar.mjs'), 'utf8'), antigravitySidecarSource())
  assert.ok(install.stdout.includes(TERMS), install.stdout)
  assert.ok(install.stdout.includes('Automations'), install.stdout)
}))

test('a later plain setup keeps the sidecar it wrote, and a preview with the flag names it and the terms line', () => withHome(({ run, dir }) => {
  const preview = run(['--agent', 'antigravity', '--antigravity-sidecar'])
  assert.equal(preview.status, 0, preview.stderr)
  assert.ok(preview.stdout.includes('sidecar.json') && preview.stdout.includes(TERMS), preview.stdout)
  assert.ok(!existsSync(dir), 'a preview writes nothing')
  assert.equal(run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply']).status, 0)
  const again = run(['--agent', 'antigravity', '--apply'])
  assert.equal(again.status, 0, again.stderr)
  assert.ok(existsSync(join(dir, 'sidecar.json')) && existsSync(join(dir, 'sidecar.mjs')), 'the second setup keeps the sidecar')
}))

test('--remove takes out both sidecar files setup wrote', () => withHome(({ run, dir }) => {
  assert.equal(run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply']).status, 0)
  assert.ok(existsSync(join(dir, 'sidecar.json')))
  const preview = run(['--remove', '--agent', 'antigravity'])
  assert.ok(preview.stdout.includes('sidecar.json') && preview.stdout.includes('sidecar.mjs'), preview.stdout)
  const removed = run(['--remove', '--agent', 'antigravity', '--apply'])
  assert.equal(removed.status, 0, removed.stderr)
  assert.ok(!existsSync(join(dir, 'sidecar.json')) && !existsSync(join(dir, 'sidecar.mjs')), 'both files are gone')
}))

test('in a terminal the sidecar question defaults to no: an empty second answer writes nothing and the question carries the terms line', () => withHome(({ run, dir }) => {
  // The first answer (yes) is read with the rest of the input; the second read then finds none, which is a no.
  const asked = run(['--agent', 'antigravity'], { input: 'y\n', env: { AGENT_BOARD_SETUP_TTY: '1', AGENT_BOARD_TEST_PID: String(process.pid) } })
  assert.equal(asked.status, 0, asked.stderr)
  assert.ok(asked.stdout.includes(TERMS), asked.stdout)
  assert.ok(asked.stdout.includes('[y/N]'), asked.stdout)
  assert.ok(!existsSync(dir), 'a no writes nothing')
}))

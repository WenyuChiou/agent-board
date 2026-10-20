import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

// Every home, config and temp folder an agent host or the board reads (#212). A child that
// inherits any of them from this process could rewire the machine's real hooks or leave
// a --serve address file outside the world.
export const ISOLATED_VARIABLES = ['HOME', 'USERPROFILE', 'HERMES_HOME', 'GROK_HOME', 'OPENCLAW_STATE_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'LOCALAPPDATA', 'APPDATA', 'TMP', 'TEMP', 'TMPDIR', 'CLAUDE_PROGRESS_FILE', 'CLAUDE_CONFIG_DIR']

// The one place a journey starts a process: only with a world's own isolated environment.
export const spawnIsolated = (file, args, options) => {
  const env = options?.env
  assert.ok(env && env !== process.env, 'Every journey child requires its world\'s isolated environment')
  for (const name of ISOLATED_VARIABLES) {
    assert.ok(env[name], `${name} is not set for a journey child`)
    assert.notEqual(env[name], process.env[name], `${name} would point a journey child at this machine's real folder`)
  }
  return spawn(file, args, { windowsHide: true, ...options })
}

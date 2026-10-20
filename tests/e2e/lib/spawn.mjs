import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { homedir, tmpdir, userInfo } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

// Every home, config and temp folder an agent host or the board reads (#212). A child that
// inherits any of them from this process could rewire the machine's real hooks or leave
// a --serve address file outside the world.
export const ISOLATED_VARIABLES = ['HOME', 'USERPROFILE', 'HERMES_HOME', 'GROK_HOME', 'OPENCLAW_STATE_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'LOCALAPPDATA', 'APPDATA', 'TMP', 'TEMP', 'TMPDIR', 'CLAUDE_PROGRESS_FILE', 'CLAUDE_CONFIG_DIR']

// True when path is folder itself or lies inside it (case-insensitive on Windows, as relative is).
export const within = (folder, path) => {
  const rel = relative(resolve(folder), resolve(path))
  return rel === '' || rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

// The world a working folder belongs to: one of the fresh agent-board-e2e-* folders makeWorld
// creates in this process's temp folder. The temp folder itself, a home or the repository is none.
export const worldOf = cwd => {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
  const rel = relative(resolve(tmpdir()), resolve(cwd))
  const first = rel.split(/[\\/]/)[0]
  if (isAbsolute(rel) || !/^agent-board-e2e-.+$/.test(first)) return undefined
  return join(resolve(tmpdir()), first)
}

// The one place a journey starts a process: only inside a world, with that world's own environment.
export const spawnIsolated = (file, args, options) => {
  const env = options?.env
  assert.ok(env && env !== process.env, 'Every journey child requires its world\'s isolated environment')
  const root = worldOf(options?.cwd)
  assert.ok(root, 'Every journey child runs inside a journey world folder')
  // homedir() follows HOME and USERPROFILE, so a wrapped test run sees its stand-in; userInfo()
  // reads the account and names the real home even then.
  const homes = [homedir(), userInfo().homedir]
  for (const name of ISOLATED_VARIABLES) {
    const value = env[name]
    assert.ok(value && isAbsolute(value) && within(root, value), `${name} must stay inside the journey world`)
    assert.ok(!homes.some(home => within(value, home)), `${name} would point a journey child at this machine's home`)
    assert.ok(!process.env[name] || !within(process.env[name], value) || !within(value, process.env[name]), `${name} would point a journey child at this machine's real folder`)
  }
  return spawn(file, args, { windowsHide: true, ...options })
}

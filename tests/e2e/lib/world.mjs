import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rm } from 'node:fs/promises'
import { BOARD_SCRIPT } from '../../../hooks/board-script.ts'
import { clockPreload, clockText, jump } from './clock.mjs'

// Machine-wide Windows variables every real session has; none names a user's own folder.
const MACHINE_VARIABLES = ['SystemDrive', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS', 'OS', 'DriverData']
// Folders Windows installs for every user. A module folder outside them (a profile's Documents, a
// redirected OneDrive, a share, a relative or unexpanded path) stays out of the world.
const machineFolders = () => ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']
  .map(key => process.env[key]).filter(Boolean)
  .map(dir => { const folder = resolve(dir).toLowerCase(); return folder.endsWith(sep) ? folder : folder + sep })
// The session's PowerShell module path, keeping only folders inside the machine folders. On a CI
// runner the board's first Move-Item took 12-40 s in a world without it (under half a second with
// it), past the board's own 10 s limit for that move.
export const modulePath = (value = process.env.PSModulePath) => (value ?? '').split(';')
  .filter(dir => isAbsolute(dir) && machineFolders().some(folder => resolve(dir).toLowerCase().startsWith(folder)))
  .join(';')

export const makeWorld = ({ lang = 'en' } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-e2e-'))
  const home = join(root, 'home')
  const claudeDir = join(home, '.claude')
  const path = join(claudeDir, 'progress.md')
  const inbox = join(claudeDir, 'progress-inbox')
  const script = join(claudeDir, 'agent-board.mjs')
  const directories = {
    HOME: home, USERPROFILE: home, HERMES_HOME: join(home, '.hermes'),
    GROK_HOME: join(home, '.grok'), OPENCLAW_STATE_DIR: join(home, '.openclaw'),
    CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_RUNTIME_DIR: join(root, 'run'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
    TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'),
    CLAUDE_CONFIG_DIR: claudeDir,
  }
  const env = {}
  for (const key of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'windir', ...MACHINE_VARIABLES]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  const modules = process.platform === 'win32' && modulePath()
  if (modules) env.PSModulePath = modules
  Object.assign(env, directories, { CLAUDE_PROGRESS_FILE: path, NO_COLOR: '1' })
  const inside = file => {
    const rel = relative(root, resolve(file))
    assert.ok(rel && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel), `Outside world: ${file}`)
    return resolve(file)
  }
  try {
    for (const dir of Object.values(directories)) mkdirSync(inside(dir), { recursive: true, mode: 0o700 })
    inside(env.CLAUDE_PROGRESS_FILE)
    mkdirSync(inbox)
    const cleanups = []
    let isClosed = false
    const target = name => inside(join(claudeDir, name))
    const started = Date.now()
    const world = {
      root, home, claudeDir, path, inbox, script, env, lang,
      // The time every process in this world sees: the clock's base plus real time since it was set.
      clock: { base: started, at: started },
      get now() { return this.clock.base + (Date.now() - this.clock.at) },
      cleanups,
      write: (name, text) => {
        const file = target(name)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, text)
        return file
      },
      read: name => readFileSync(target(name), 'utf8'),
      exists: name => existsSync(target(name)),
      files: () => readdirSync(claudeDir, { recursive: true }).map(String).sort(),
      jump: spec => jump(world, spec),
      close: async () => {
        if (isClosed) return
        const errors = []
        for (const cleanup of [...cleanups].reverse()) {
          try { await cleanup() } catch (error) { errors.push(error) }
        }
        // Async retries let child-close callbacks and Windows handle release
        // complete while transient scanner/share locks settle.
        try {
          await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 75 })
        } catch (error) { errors.push(error) }
        isClosed = !existsSync(root)
        if (errors.length) throw new AggregateError(errors, 'World cleanup failed')
      },
    }
    env.E2E_NOW = String(world.clock.base)
    env.E2E_CLOCK_AT = String(world.clock.at)
    env.E2E_BOARD_PATH = path
    env.E2E_BOARD_LANG = lang
    env.E2E_CLOCK_FILE = join(root, 'now')
    writeFileSync(env.E2E_CLOCK_FILE, clockText(world.clock))
    const preload = clockPreload(world)
    env.E2E_CLIPBOARD = join(root, 'clipboard.txt')
    const clipboard = world.write('clipboard-preload.mjs', `import cp from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const original = cp.spawnSync
cp.spawnSync = (file, args, options) => {
  if (/(?:^|[\\\\/])(?:clip(?:\\.exe)?|pbcopy|wl-copy|xclip|xsel)$/.test(String(file))) {
    writeFileSync(process.env.E2E_CLIPBOARD, options.input)
    return { status: 0, stdout: '', stderr: '' }
  }
  return original(file, args, options)
}
syncBuiltinESMExports()
`)
    env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href} --import=${pathToFileURL(clipboard).href}`
    // Both HTML and serve launch paths must stay inside the test process.
    const browserCalls = [...BOARD_SCRIPT.matchAll(/openInBrowser\(([^,]+),/g)]
    assert.equal(browserCalls.length, 2, 'Review every browser launch when the bundle changes')
    assert.deepEqual(browserCalls.map(match => match[1]).sort(), ['html', 'url'])
    // The bytes stay identical across worlds; only the isolated environment
    // supplies this instance's baked configuration.
    world.write('agent-board.mjs', `globalThis.AGENT_BOARD = { path: process.env.E2E_BOARD_PATH, lang: process.env.E2E_BOARD_LANG }\n${BOARD_SCRIPT.replace(/openInBrowser\(([^,]+),/g, '((target, done) => done(false))($1,')}`)
    return world
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 75 })
    throw error
  }
}

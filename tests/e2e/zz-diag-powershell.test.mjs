// Diagnostic only (draft pull request, never merged): which PowerShell module path entries the board's
// Move-Item needs to stay fast in a fresh journey world. Each variant has its own world.
import { test } from 'node:test'
import { writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { makeWorld, modulePath } from './lib/world.mjs'
import { spawnIsolated } from './lib/spawn.mjs'

const quote = text => `'${text.replaceAll("'", "''")}'`
const roots = () => ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']
  .map(key => process.env[key]).filter(Boolean)
  .map(root => { const value = resolve(root).toLowerCase(); return value.endsWith(sep) ? value : value + sep })
const allowed = (value = process.env.PSModulePath) => (value ?? '').split(';')
  .filter(dir => dir && isAbsolute(dir) && !dir.startsWith('\\\\') && roots().some(root => resolve(dir).toLowerCase().startsWith(root)))
  .join(';')
const profiles = dirname(homedir())
const shown = dir => dir.toLowerCase().startsWith(profiles.toLowerCase()) ? `<profiles>${dir.slice(profiles.length)}` : dir
const entries = (process.env.PSModulePath ?? '').split(';').filter(Boolean)
const variants = {
  'world as built (profile filter)': () => modulePath(),
  'machine-folder allowlist': () => allowed(),
  ...Object.fromEntries(entries.map((dir, index) => [`entry ${index} only: ${shown(dir)}`, () => dir])),
  'only what the profile filter keeps beyond the allowlist': () => modulePath().split(';').filter(dir => !allowed().split(';').includes(dir)).join(';'),
}

test('diag: Move-Item in fresh journey worlds with each module path variant', { skip: process.platform !== 'win32', timeout: 900000 }, async () => {
  console.log(`entries: ${entries.map(shown).join(' | ')}`)
  console.log(`profile filter keeps: ${modulePath().split(';').map(shown).join(' | ')}`)
  console.log(`allowlist keeps: ${allowed().split(';').map(shown).join(' | ')}`)
  for (const [label, make] of Object.entries(variants)) {
    const world = makeWorld()
    try {
      const env = { ...world.env, PSModulePath: make() }
      if (!env.PSModulePath) delete env.PSModulePath
      const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const from = join(world.root, 'probe.tmp')
      const to = join(world.root, 'probe.json')
      writeFileSync(from, 'x')
      const start = Date.now()
      const child = spawnIsolated(ps, ['-NoProfile', '-NonInteractive', '-Command', `Move-Item -LiteralPath ${quote(from)} -Destination ${quote(to)} -ErrorAction Stop`], { env, cwd: world.root, stdio: 'ignore', timeout: 120000 })
      const status = await new Promise(resolve => child.once('close', resolve))
      console.log(`${label}, move: ${Date.now() - start} ms, status ${status}, moved ${existsSync(to)}`)
    } finally { await world.close() }
  }
})

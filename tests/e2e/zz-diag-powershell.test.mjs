// Diagnostic only (draft pull request, never merged): why the board's PowerShell Move-Item takes
// over 20 s in a fresh journey world on this runner. Each variant runs in its own fresh world.
import { test } from 'node:test'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorld } from './lib/world.mjs'
import { spawnIsolated, ISOLATED_VARIABLES } from './lib/spawn.mjs'

const quote = text => `'${text.replaceAll("'", "''")}'`
// Machine-wide variables a stripped world leaves out; none of them names a user folder.
const SYSTEM = ['SystemDrive', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS', 'OS', 'COMPUTERNAME', 'USERNAME', 'USERDOMAIN', 'DriverData', 'PSModulePath']
const variants = {
  world: world => { const env = { ...world.env }; delete env.PSModulePath; return env },
  'world+system': world => { const env = { ...world.env }; for (const key of SYSTEM) if (process.env[key] !== undefined) env[key] = process.env[key]; return env },
  'full+world-homes': world => { const env = { ...process.env }; for (const key of [...ISOLATED_VARIABLES, 'NODE_OPTIONS']) delete env[key]; return { ...env, ...Object.fromEntries(ISOLATED_VARIABLES.map(key => [key, world.env[key]])) } },
}

test('diag: PowerShell startup and Move-Item in fresh journey worlds by environment', { skip: process.platform !== 'win32', timeout: 600000 }, async () => {
  console.log('runner variables present: ' + SYSTEM.filter(key => process.env[key] !== undefined).join(' '))
  for (const [label, make] of Object.entries(variants)) {
    for (const op of ['exit', 'move']) {
      const world = makeWorld()
      try {
        const env = make(world)
        const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        const from = join(world.root, 'probe.tmp')
        const to = join(world.root, 'probe.json')
        writeFileSync(from, 'x')
        const command = op === 'exit' ? 'exit 0' : `Move-Item -LiteralPath ${quote(from)} -Destination ${quote(to)} -ErrorAction Stop`
        const start = Date.now()
        const child = spawnIsolated(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { env, cwd: world.root, stdio: 'ignore', timeout: 120000 })
        const status = await new Promise(resolve => child.once('close', resolve))
        console.log(`${label}, ${op}: ${Date.now() - start} ms, status ${status}${op === 'move' ? `, moved ${existsSync(to)}` : ''}`)
      } finally { await world.close() }
    }
  }
})

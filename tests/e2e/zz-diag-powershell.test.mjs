// Diagnostic only (draft pull request, never merged): which machine-wide variable the board's
// PowerShell Move-Item needs to stay fast in a fresh journey world. Each variant has its own world.
import { test } from 'node:test'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorld } from './lib/world.mjs'
import { spawnIsolated } from './lib/spawn.mjs'

const quote = text => `'${text.replaceAll("'", "''")}'`
const MACHINE = ['SystemDrive', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS', 'OS', 'DriverData']
const stripped = world => { const env = { ...world.env }; for (const key of MACHINE) delete env[key]; return env }
const variants = {
  'world as built': world => world.env,
  stripped,
  ...Object.fromEntries(['SystemDrive', 'ProgramData', 'ProgramFiles', 'ALLUSERSPROFILE'].map(key => [`stripped + ${key}`, world => ({ ...stripped(world), [key]: process.env[key] })])),
}

test('diag: Move-Item in fresh journey worlds with and without each machine variable', { skip: process.platform !== 'win32', timeout: 600000 }, async () => {
  for (const [label, make] of Object.entries(variants)) {
    const world = makeWorld()
    try {
      const env = make(world)
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

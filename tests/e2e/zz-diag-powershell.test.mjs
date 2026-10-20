// Diagnostic only (draft pull request, never merged): how long the board's PowerShell Move-Item
// takes in a fresh journey world on this runner, with the world's pinned module path and unset.
import { test } from 'node:test'
import { readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorld } from './lib/world.mjs'
import { spawnIsolated } from './lib/spawn.mjs'

const count = dir => { try { return readdirSync(dir).length } catch { return 'missing' } }
const quote = text => `'${text.replaceAll("'", "''")}'`

test('diag: PowerShell Move-Item in a fresh journey world, pinned and unset module path', { skip: process.platform !== 'win32', timeout: 300000 }, async () => {
  console.log('runner PSModulePath: ' + (process.env.PSModulePath ?? '(unset)').split(';').map(dir => `${dir} [${count(dir)}]`).join(' | '))
  for (const label of ['pinned', 'unset', 'pinned']) {
    const world = makeWorld()
    try {
      const env = { ...world.env }
      if (label === 'unset') delete env.PSModulePath
      const ps = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      for (let attempt = 1; attempt <= 2; attempt++) {
        const from = join(world.root, `probe-${attempt}.tmp`)
        const to = join(world.root, `probe-${attempt}.json`)
        writeFileSync(from, 'x')
        const start = Date.now()
        const child = spawnIsolated(ps, ['-NoProfile', '-NonInteractive', '-Command', `Move-Item -LiteralPath ${quote(from)} -Destination ${quote(to)} -ErrorAction Stop`], { env, cwd: world.root, stdio: 'ignore', timeout: 120000 })
        const status = await new Promise(resolve => child.once('close', resolve))
        console.log(`${label} world, move ${attempt}: ${Date.now() - start} ms, status ${status}, moved ${existsSync(to)}`)
      }
    } finally { await world.close() }
  }
})

import assert from 'node:assert/strict'
import { spawnIsolated } from './spawn.mjs'
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RELEASE_0_20_5 } from '../../fixtures/released.ts'
import { seenWithin } from './expect.mjs'

const childIn = (world, file, args) => {
  const child = spawnIsolated(file, args, { env: world.env, cwd: world.root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', error
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
  child.on('error', failure => { error = failure })
  const done = new Promise(resolve => child.once('close', status => resolve({ status, stdout, stderr, error })))
  const timer = setTimeout(() => child.kill(), 20000)
  let isStopped = false
  const stop = async () => {
    if (isStopped) return
    isStopped = true
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await done
  }
  world.cleanups.push(stop)
  return { child, done, stop, output: () => stdout, failure: () => error }
}

export const killMidWrite = async world => {
  const worker = childIn(world, process.execPath, ['--input-type=module', '-e', `import { openSync, writeSync } from 'node:fs'
const fd = openSync(${JSON.stringify(world.path)}, 'w')
writeSync(fd, '## torn\\n<!-- auto session=')
process.stdout.write('PARTIAL_READY\\n')
setInterval(() => {}, 1000)
`])
  try {
    await seenWithin(worker.output, text => text.includes('PARTIAL_READY'), 3000)
    worker.child.kill()
    return await worker.done
  } finally { await worker.stop() }
}

export const tear = (world, name, at) => {
  const file = join(world.claudeDir, name)
  const bytes = readFileSync(file)
  assert.ok(Number.isInteger(at) && at >= 0 && at < bytes.length)
  writeFileSync(file, bytes.subarray(0, at))
}

export const lockFile = async (world, name) => {
  if (process.platform !== 'win32') return { skip: 'Exclusive Windows sharing locks are unavailable', release: async () => {} }
  const path = join(world.claudeDir, name)
  const quoted = path.replace(/'/g, "''")
  const worker = childIn(world, 'powershell.exe', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${quoted}', 'Open', 'ReadWrite', 'None'); try { [Console]::Out.WriteLine('LOCK_READY'); while ($true) { Start-Sleep -Milliseconds 50 } } finally { $f.Dispose() }`])
  try {
    await seenWithin(() => {
      if (worker.failure()) throw worker.failure()
      return worker.output()
    }, text => text.includes('LOCK_READY'), 5000)
    return { release: worker.stop }
  } catch (error) {
    await worker.stop()
    throw error
  }
}

export const twoWriters = async (world, a, b) => {
  const gate = world.write('writers-go', '')
  const workers = [a, b].map((value, index) => childIn(world, process.execPath, ['--input-type=module', '-e', `import { readFileSync, writeFileSync, renameSync } from 'node:fs'
process.stdout.write('WRITER_READY\\n')
while (readFileSync(${JSON.stringify(gate)}, 'utf8') !== 'go') await new Promise(done => setTimeout(done, 5))
const file = ${JSON.stringify(join(world.claudeDir, value.name))}
const temp = file + '.writer-${index}'
writeFileSync(temp, ${JSON.stringify(value.text)})
renameSync(temp, file)
`]))
  try {
    await Promise.all(workers.map(worker => seenWithin(worker.output, text => text.includes('WRITER_READY'), 3000)))
    writeFileSync(gate, 'go')
    return await Promise.all(workers.map(worker => worker.done))
  } finally { await Promise.all(workers.map(worker => worker.stop())) }
}

const faultPreload = (world, code, name) => {
  const preload = world.write(`fault-${code}.cjs`, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const fail = () => {
  const error = new Error('${code}: synthetic ${name}')
  error.code = '${code}'
  throw error
}
for (const key of ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'truncateSync', 'writeSync', 'writeFile', 'appendFile', 'rename', 'mkdir', 'truncate', 'write']) fs[key] = fail
for (const key of ['writeFile', 'appendFile', 'rename', 'mkdir', 'truncate']) fs.promises[key] = async () => fail()
const originalOpen = fs.openSync
fs.openSync = (path, flags, ...args) => typeof flags === 'string' && /[wa+]/.test(flags) ? fail() : originalOpen(path, flags, ...args)
syncBuiltinESMExports()
`)
  const before = world.env.NODE_OPTIONS
  world.env.NODE_OPTIONS += ` --require=${JSON.stringify(preload)}`
  const restore = () => { world.env.NODE_OPTIONS = before }
  world.cleanups.push(restore)
  return { preload, restore }
}

export const readOnly = world => {
  if (process.platform === 'win32') return faultPreload(world, 'EPERM', 'read-only folder')
  const mode = statSync(world.claudeDir).mode & 0o777
  chmodSync(world.claudeDir, 0o555)
  const restore = () => chmodSync(world.claudeDir, mode)
  world.cleanups.push(restore)
  return { restore }
}
export const diskFull = world => faultPreload(world, 'ENOSPC', 'full disk')

export const skew = (world, session, ms) => {
  const source = world.read('progress.md')
  const pattern = new RegExp(`(<!-- auto session=${session} [^\\n]*?updated=)([^\\s>]+)`)
  assert.match(source, pattern)
  world.write('progress.md', source.replace(pattern, (_, prefix, at) => prefix + new Date(Date.parse(at) + ms).toISOString()))
}

export const updateMidSession = (world, olderBundle) => {
  const previous = world.read('agent-board.mjs')
  const historical = olderBundle ?? RELEASE_0_20_5.board
  const isHistorical = typeof historical === 'string' && historical.includes('node:')
  const replacement = isHistorical ? `globalThis.AGENT_BOARD = ${JSON.stringify({ path: world.path, lang: world.lang })}\n${historical.replace('openInBrowser(html,', '((target, done) => done(false))(html,')}` : `// synthetic-version: e2e-older\n${previous}`
  world.write('agent-board.mjs', replacement)
  return { source: isHistorical ? 'tests/fixtures/released.ts RELEASE_0_20_5.board' : 'current bundle with synthetic-version: e2e-older', restore: () => world.write('agent-board.mjs', previous) }
}

export const uninstall = world => {
  const aside = join(world.root, 'install-aside')
  renameSync(world.claudeDir, aside)
  world.installAside = aside
  world.cleanups.push(() => { if (world.installAside) reinstall(world) })
  return aside
}
export const reinstall = world => {
  assert.ok(world.installAside, 'No isolated install to restore')
  renameSync(world.installAside, world.claudeDir)
  world.installAside = undefined
}

// An exact-file fault can be enabled after server startup and works even under root.
export const storageFault = (world, { file = world.path, code = 'EACCES' } = {}) => {
  const marker = world.write('storage-fault-state', '')
  const preload = world.write('storage-fault.cjs', `const fs = require('node:fs')
const { resolve } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const read = fs.readFileSync
const target = ${JSON.stringify(file)}
const fails = (file, operation) => {
  if (resolve(String(file)) !== resolve(target)) return
  if (read(${JSON.stringify(marker)}, 'utf8') !== operation) return
  throw Object.assign(new Error('synthetic storage fault'), { code: ${JSON.stringify(code)} })
}
fs.readFileSync = (file, ...args) => { fails(file, 'read'); return read(file, ...args) }
const rename = fs.renameSync
fs.renameSync = (from, to) => { fails(to, 'write'); return rename(from, to) }
syncBuiltinESMExports()
`)
  const before = world.env.NODE_OPTIONS
  world.env.NODE_OPTIONS += ` --require=${JSON.stringify(preload)}`
  const restore = () => { world.env.NODE_OPTIONS = before }
  world.cleanups.push(restore)
  return { enable: operation => world.write('storage-fault-state', operation), restore }
}

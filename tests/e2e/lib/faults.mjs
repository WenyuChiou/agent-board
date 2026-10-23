import assert from 'node:assert/strict'
import { spawnIsolated } from './spawn.mjs'
import { chmodSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RELEASE_0_20_5 } from '../../fixtures/released.ts'
import { seenWithin } from './expect.mjs'

// lifetimeMs is how long a helper may live before it is killed: a crashed test must not leave one running.
const childIn = (world, file, args, { lifetimeMs = 20000 } = {}) => {
  const child = spawnIsolated(file, args, { env: world.env, cwd: world.root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', error
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
  child.on('error', failure => { error = failure })
  const done = new Promise(resolve => child.once('close', status => resolve({ status, stdout, stderr, error })))
  const timer = setTimeout(() => child.kill(), lifetimeMs)
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

const LOCK_READY_MS = 30000
export const lockFile = async (world, name) => {
  if (process.platform !== 'win32') return { skip: 'Exclusive Windows sharing locks are unavailable', release: async () => {} }
  const path = join(world.claudeDir, name)
  const quoted = path.replace(/'/g, "''")
  // The holder must outlive its own ready-wait, or it could be killed just as it is ready: it
  // lives 20 s beyond that, which is the time the journey has to use the lock.
  const worker = childIn(world, 'powershell.exe', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${quoted}', 'Open', 'ReadWrite', 'None'); try { [Console]::Out.WriteLine('LOCK_READY'); while ($true) { Start-Sleep -Milliseconds 50 } } finally { $f.Dispose() }`], { lifetimeMs: LOCK_READY_MS + 20000 })
  try {
    // PowerShell can take seconds to start on a slow Windows CI runner; this only
    // waits for the lock holder to be ready and times nothing in the product.
    await seenWithin(() => {
      if (worker.failure()) throw worker.failure()
      return worker.output()
    }, text => text.includes('LOCK_READY'), LOCK_READY_MS)
    return { release: worker.stop }
  } catch (error) {
    await worker.stop()
    throw error
  }
}

// Windows only: a program outside the board holds progress.md open (share mode None) while one
// writer renames over it, so the writer meets a refused rename, not a refused first read.
export const holdNextRename = async world => {
  assert.equal(process.platform, 'win32')
  const request = join(world.root, 'rename-request')
  const ready = join(world.root, 'rename-held')
  const refused = join(world.root, 'rename-refused')
  const quote = value => value.replace(/'/g, "''")
  const worker = childIn(world, 'powershell.exe', ['-NoProfile', '-Command', `
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('HOLDER_READY')
$until = [DateTime]::UtcNow.AddSeconds(20)
while (!(Test-Path -LiteralPath '${quote(request)}')) {
  if ([DateTime]::UtcNow -ge $until) { throw 'Rename never requested' }
  Start-Sleep -Milliseconds 5
}
$f = [IO.File]::Open('${quote(world.path)}', 'Open', 'ReadWrite', 'None')
try {
  [IO.File]::WriteAllText('${quote(ready)}', '')
  $until = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath '${quote(refused)}')) {
    if ([DateTime]::UtcNow -ge $until) { throw 'Rename was never refused' }
    Start-Sleep -Milliseconds 5
  }
} finally { $f.Dispose() }
[Console]::Out.WriteLine('HOLDER_RELEASED')
`], { lifetimeMs: LOCK_READY_MS + 30000 })
  try {
    await seenWithin(() => {
      if (worker.failure()) throw worker.failure()
      return worker.output()
    }, text => text.includes('HOLDER_READY'), LOCK_READY_MS)
    // The holder opens progress.md once the writer's temp file is written, which is before the writer
    // starts its 2 s rename clock: on a loaded machine the holder's start must not use that time up.
    // The first refused rename tells the holder to let go.
    const preload = world.write('hold-rename.cjs', `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const write = fs.writeFileSync
const rename = fs.renameSync
const file = ${JSON.stringify(world.path)}
let isHeld = false
fs.writeFileSync = (target, ...rest) => {
  const result = write(target, ...rest)
  if (!isHeld && typeof target === 'string' && target.startsWith(file + '.') && target.endsWith('.format-tmp')) {
    isHeld = true
    write(${JSON.stringify(request)}, '')
    const until = performance.now() + 8000
    while (!fs.existsSync(${JSON.stringify(ready)})) {
      if (performance.now() >= until) throw new Error('HOLDER_TIMEOUT')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  return result
}
fs.renameSync = (from, to) => {
  try { return rename(from, to) } catch (error) {
    if (to === file && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) write(${JSON.stringify(refused)}, error.code)
    throw error
  }
}
syncBuiltinESMExports()
`)
    const before = world.env.NODE_OPTIONS
    world.env.NODE_OPTIONS += ` --require=${JSON.stringify(preload)}`
    world.cleanups.push(() => { world.env.NODE_OPTIONS = before })
    return { finished: () => worker.done }
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

// Added for the L5 concurrent-writers journey: the write procedure docs/FORMAT.md gives other
// writers ("Concurrent writers"), run as separate processes. Each write takes the native lock
// (`<file>.agent-board-lock`, created exclusively, waited on for at most `lockWaitMs`, 2 s by default), reads the file, changes
// only its own block, writes a temp file beside progress.md and renames it over (on Windows a
// refused rename is tried again with a doubling pause, up to 2 s), and reads back; when its block
// did not read back it tries again, up to three tries in all. It then releases the lock, removing it
// only if it still holds this write's claim. A read of zero bytes from a file seen with content is
// read again (the doc says the pane does this).
// Prints WRITER_OK, or WRITE_FAILED with the error codes it met, and returns whether it wrote.
// The two gates (the start signal, and the writer before it) are waited for at most gateMs: after
// a hard kill of the driver nobody opens them, and without a deadline this process would poll for ever.
export const formatWriter = async (fs, config) => {
  const { file, session, rounds, spacingMs, gate, after, gateMs, lockWaitMs = 2000 } = config
  const pause = ms => new Promise(done => setTimeout(done, ms))
  const isWindows = process.platform === 'win32'
  const lock = `${file}.agent-board-lock`
  process.stdout.write('WRITER_READY\n')
  const deadline = performance.now() + gateMs
  for (const waitingFor of [gate, after]) {
    while (waitingFor && !fs.existsSync(waitingFor)) {
      if (performance.now() > deadline) {
        process.stdout.write(`WRITE_FAILED the start gate stayed closed for ${gateMs} ms\n`)
        return false
      }
      await pause(2)
    }
  }
  const codes = []
  let hasSeenContent = false
  const end = `<!-- /auto session=${session} -->`
  // Returns the lock's descriptor with the claim written in it, or undefined with the reason in codes.
  const take = async claim => {
    const until = performance.now() + lockWaitMs
    for (;;) {
      let fd
      try {
        fd = fs.openSync(lock, 'wx', 0o600)
      } catch (error) {
        // An existing lock, or an access-denied create on Windows, means busy.
        if (error.code !== 'EEXIST' && !(isWindows && error.code === 'EPERM')) {
          codes.push(error.code ?? error.message)
          return undefined
        }
        if (performance.now() >= until) {
          codes.push('LOCK_BUSY')
          return undefined
        }
        await pause(10)
        continue
      }
      try {
        fs.writeFileSync(fd, claim)
        return fd
      } catch (error) {
        // An empty or partial lock is never recovered, so remove the file this writer created.
        codes.push(error.code ?? error.message)
        fs.closeSync(fd)
        fs.unlinkSync(lock)
        return undefined
      }
    }
  }
  for (let round = 0; round < rounds; round++) {
    const own = [`<!-- auto session=${session} agent=format-writer state=working updated=${new Date().toISOString()} -->`, `### Format writer ${session}`, '> Context: Synthetic FORMAT.md writer', `- [~] Round ${round + 1}`, end].join('\n')
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    const claim = JSON.stringify({ version: 1, pid: process.pid, token })
    const fd = await take(claim)
    let isWritten = false
    if (fd !== undefined) {
      try {
        for (let attempt = 1; attempt <= 3 && !isWritten; attempt++) {
          const temp = `${file}.${token}.${attempt}.format-tmp`
          try {
            let source = ''
            for (let again = 0; again < 20; again++) {
              source = fs.readFileSync(file, 'utf8')
              if (source !== '' || !hasSeenContent) break
              await pause(5)
            }
            if (source !== '') hasSeenContent = true
            const start = source.indexOf(`<!-- auto session=${session} `)
            const finish = source.indexOf(end, start)
            const next = start >= 0 && finish > start
              ? source.slice(0, start) + own + source.slice(finish + end.length)
              : source + (source === '' || source.endsWith('\n') ? '' : '\n') + `## format-writer-${session}\n${own}\n`
            fs.writeFileSync(temp, next, { flag: 'wx', mode: 0o600 })
            const stop = performance.now() + 2000
            for (let delay = 10; ; delay *= 2) {
              try {
                fs.renameSync(temp, file)
                break
              } catch (error) {
                if (!isWindows || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || performance.now() >= stop) throw error
                codes.push(error.code)
                await pause(Math.max(0, Math.min(delay, stop - performance.now())))
              }
            }
            if (fs.readFileSync(file, 'utf8').includes(own)) isWritten = true
            else codes.push('LOST')
          } catch (error) {
            codes.push(error.code ?? error.message)
          } finally {
            try { fs.unlinkSync(temp) } catch {}
          }
        }
      } finally {
        fs.closeSync(fd)
        // Compare the whole text: a lock that is not this write's must stay where it is.
        if (fs.readFileSync(lock, 'utf8') === claim) fs.unlinkSync(lock)
      }
    }
    if (!isWritten) {
      process.stdout.write(`WRITE_FAILED round ${round + 1} ${codes.join(',')}\n`)
      return false
    }
    if (spacingMs) await pause(spacingMs)
  }
  process.stdout.write(`WRITER_OK${codes.length ? ` after ${codes.join(',')}` : ''}\n`)
  return true
}

const WRITER_GATE_MS = 20000
// One process per session id, all waiting on a gate file so they start together. With
// isSequential each waits for the one before it to finish instead, so no two overlap. rounds
// and spacingMs repeat the whole procedure to keep writers busy while other writers are active.
export const formatWriters = async (world, sessions, { rounds = 1, spacingMs = 0, isSequential = false, gateMs = WRITER_GATE_MS, lockWaitMs = 2000 } = {}) => {
  const gate = join(world.root, 'format-writers-go')
  const workers = sessions.map((session, index) => {
    const config = { file: world.path, session, rounds, spacingMs, gate, gateMs, lockWaitMs, after: isSequential && index > 0 ? join(world.root, `format-writer-done-${index - 1}`) : undefined }
    return childIn(world, process.execPath, ['--input-type=module', '-e', `import * as fs from 'node:fs'
const main = ${formatWriter.toString()}
process.exitCode = await main(fs, ${JSON.stringify(config)}) ? 0 : 2
fs.writeFileSync(${JSON.stringify(join(world.root, `format-writer-done-${index}`))}, '')
`])
  })
  try {
    await Promise.all(workers.map(worker => seenWithin(worker.output, text => text.includes('WRITER_READY'), 8000)))
  } catch (error) {
    await Promise.all(workers.map(worker => worker.stop()))
    throw error
  }
  return {
    go: () => writeFileSync(gate, 'go'),
    finished: async () => Promise.all(workers.map(worker => worker.done)),
    stop: () => Promise.all(workers.map(worker => worker.stop())),
  }
}

// Added for the L5 concurrent-writers journey: the sessions whose hook events the local reporter
// keeps in its pending folder for its next run. A block waiting there has not landed yet, but it
// is not lost either.
export const keptHookEvents = world => {
  const folder = join(world.home, '.agent-board', 'pending')
  let names = []
  try { names = readdirSync(folder) } catch { return [] }
  return names.filter(name => name.endsWith('.json')).flatMap(name => {
    try { return [JSON.parse(readFileSync(join(folder, name), 'utf8')).session] } catch { return [] }
  })
}

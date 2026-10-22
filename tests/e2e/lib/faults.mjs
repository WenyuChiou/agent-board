import assert from 'node:assert/strict'
import { spawnIsolated } from './spawn.mjs'
import { chmodSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
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
    // PowerShell can take seconds to start on a slow Windows CI runner; this only
    // waits for the lock holder to be ready and times nothing in the product.
    await seenWithin(() => {
      if (worker.failure()) throw worker.failure()
      return worker.output()
    }, text => text.includes('LOCK_READY'), 30000)
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

// Added for the L5 busy-machine journey: processes that keep a CPU core spinning, so a hook
// has to compete with them the way it does on a laptop running other sessions. They stop with
// the world. The self-cap on their lifetime is short (15 s) because this machine-wide load slows
// every other test file that runs at the same time, so a crashed test must not leave it on for
// long. A journey starts them only around the one hook it times, and stop() waits for each
// process to exit (up to 3 s each, in parallel) so the next measurement starts on an idle machine.
// Each process prints a line once it runs, and this waits for all of them (up to 5 s each): on a
// loaded Windows machine a Node start can take longer than any fixed pause, and a hook timed
// before the load is real would not meet it. A process that never starts fails the journey.
export const busyProcesses = async (world, count) => {
  const children = Array.from({ length: count }, () => spawnIsolated(process.execPath, ['-e', "process.stdout.write('SPIN\\n'); const end = Date.now() + 15000; while (Date.now() < end) {}"], { env: world.env, cwd: world.root, stdio: ['ignore', 'pipe', 'ignore'] }))
  // A failed start is reported by the wait below, not as an unhandled error.
  for (const child of children) child.once('error', () => {})
  const stop = async () => {
    await Promise.all(children.map(child => new Promise(done => {
      if (child.exitCode !== null || child.signalCode !== null) return done()
      const timer = setTimeout(done, 3000)
      child.once('exit', () => { clearTimeout(timer); done() })
      child.kill()
    })))
  }
  world.cleanups.push(stop)
  const ready = await Promise.all(children.map(child => new Promise(done => {
    const timer = setTimeout(() => done(false), 5000)
    child.stdout.once('data', () => { clearTimeout(timer); done(true) })
  })))
  if (ready.includes(false)) {
    await stop()
    assert.fail(`${ready.filter(isReady => !isReady).length} of ${count} busy processes never started`)
  }
  return { count, stop }
}

// Added for the L5 concurrent-writers journey: the write procedure docs/FORMAT.md gives other
// writers ("Concurrent writers"), run as separate processes. Each one reads the file right before
// it writes, changes only its own block, writes a temp file beside progress.md, renames it over,
// reads back, and tries again up to three times at once when its block did not read back. A read
// of zero bytes from a file seen with content is read again (the doc says the pane does this).
// Prints WRITER_OK, or WRITE_FAILED with the error codes it met, and returns whether it wrote.
const formatWriter = async (fs, config) => {
  const { file, session, rounds, spacingMs, gate, after } = config
  const pause = ms => new Promise(done => setTimeout(done, ms))
  process.stdout.write('WRITER_READY\n')
  while (!fs.existsSync(gate)) await pause(2)
  while (after && !fs.existsSync(after)) await pause(2)
  const codes = []
  let hasSeenContent = false
  const end = `<!-- /auto session=${session} -->`
  for (let round = 0; round < rounds; round++) {
    const own = [`<!-- auto session=${session} agent=format-writer state=working updated=${new Date().toISOString()} -->`, `### Format writer ${session}`, '> Context: Synthetic FORMAT.md writer', `- [~] Round ${round + 1}`, end].join('\n')
    let isWritten = false
    for (let attempt = 1; attempt <= 3 && !isWritten; attempt++) {
      const temp = `${file}.format-writer-${session}.tmp`
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
        fs.writeFileSync(temp, next)
        fs.renameSync(temp, file)
        if (fs.readFileSync(file, 'utf8').includes(own)) isWritten = true
        else codes.push('LOST')
      } catch (error) {
        codes.push(error.code ?? error.message)
        try { fs.unlinkSync(temp) } catch {}
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

// One process per session id, all waiting on a gate file so they start together. With
// isSequential each waits for the one before it to finish instead, so no two overlap; rounds
// and spacingMs repeat the whole procedure to keep writers busy while other writers are active.
export const formatWriters = async (world, sessions, { rounds = 1, spacingMs = 0, isSequential = false } = {}) => {
  const gate = join(world.root, 'format-writers-go')
  const workers = sessions.map((session, index) => {
    const config = { file: world.path, session, rounds, spacingMs, gate, after: isSequential && index > 0 ? join(world.root, `format-writer-done-${index - 1}`) : undefined }
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

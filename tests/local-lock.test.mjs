import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import test from 'node:test'
import { withLocalLock } from '../scripts/local-lock.ts'
import { withDeniedCreation } from './fixtures/windows-create-denied.mjs'

const moduleUrl = new URL('../scripts/local-lock.ts', import.meta.url).href
const program = `
import { withLocalLock } from ${JSON.stringify(moduleUrl)}
import { existsSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const options = JSON.parse(process.argv[1])
const opened = new Set()
let closed = 0
if (options.initialFailure) {
  const open = fs.openSync, close = fs.closeSync, stat = fs.fstatSync, write = fs.writeFileSync
  let replaced = false
  fs.openSync = (file, ...args) => {
    const fd = open(file, ...args)
    if (file === options.lock) opened.add(fd)
    return fd
  }
  fs.closeSync = fd => {
    if (opened.delete(fd)) closed += 1
    return close(fd)
  }
  fs.fstatSync = (fd, ...args) => {
    if (opened.has(fd) && options.initialFailure.startsWith('fstat')) {
      if (options.initialFailure === 'fstat-replaced' && !replaced) {
        replaced = true
        fs.unlinkSync(options.lock)
        write(options.lock, 'replacement-owner')
      }
      throw Object.assign(new Error('FSTAT_EIO'), { code: 'EIO' })
    }
    return stat(fd, ...args)
  }
  fs.writeFileSync = (file, ...args) => {
    if (opened.has(file) && options.initialFailure === 'write') throw Object.assign(new Error('WRITE_EIO'), { code: 'EIO' })
    return write(file, ...args)
  }
  syncBuiltinESMExports()
}
if (options.busyObserved) {
  const open = fs.openSync
  fs.openSync = (file, ...args) => {
    try { return open(file, ...args) } catch (error) {
      if (file === options.lock && error.code === 'EEXIST') writeFileSync(options.busyObserved, '')
      throw error
    }
  }
  syncBuiltinESMExports()
}
if (options.epermCreates || options.epermStat) {
  // Windows refuses a create (and a stat) with EPERM while the previous owner's delete is in flight.
  const open = fs.openSync, lstat = fs.lstatSync
  let creates = 0, refused = 0
  fs.openSync = (file, ...args) => {
    if (file === options.lock && args[0] === 'wx') {
      creates += 1
      if (refused < (options.epermCreates ?? 0)) {
        refused += 1
        throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM', errno: -4048, syscall: 'open', path: file })
      }
    }
    return open(file, ...args)
  }
  fs.lstatSync = (file, ...args) => {
    if (file === options.lock && options.epermStat) throw Object.assign(new Error('EPERM: operation not permitted, lstat'), { code: 'EPERM', errno: -4048, syscall: 'lstat', path: file })
    return lstat(file, ...args)
  }
  process.on('exit', () => { if (options.attempts) writeFileSync(options.attempts, String(creates)) })
  syncBuiltinESMExports()
}
if (options.recoverReached) {
  const original = fs.unlinkSync
  let held = false
  fs.unlinkSync = file => {
    if (file === options.lock && !held) {
      held = true
      writeFileSync(options.recoverReached, '')
      const until = Date.now() + 10000
      while (!existsSync(options.recoverRelease)) {
        if (Date.now() > until) throw new Error('FIXTURE_RECOVERY_TIMEOUT')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    return original(file)
  }
  syncBuiltinESMExports()
}
try {
  withLocalLock(options.lock, () => {
    if (options.reached) writeFileSync(options.reached, String(process.pid))
    if (options.release) {
      const until = Date.now() + 10000
      while (!existsSync(options.release)) {
        if (Date.now() > until) throw new Error('FIXTURE_RELEASE_TIMEOUT')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    if (options.result) writeFileSync(options.result, 'written')
  }, { waitMs: options.waitMs ?? 2000, staleMs: options.staleMs ?? 0 })
} catch (error) {
  process.stderr.write(error.message)
  process.exitCode = 1
} finally {
  if (options.initialReport) writeFileSync(options.initialReport, JSON.stringify({ closed, open: opened.size }))
}
`

const child = options => {
  const running = spawn(process.execPath, ['--input-type=module', '-e', program, JSON.stringify(options)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  running.stderr.on('data', chunk => { stderr += String(chunk) })
  const done = once(running, 'exit').then(([code]) => ({ code, stderr }))
  return { running, done }
}

const until = async condition => {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('FIXTURE_OBSERVATION_TIMEOUT')
    await delay(10)
  }
}

const fixture = async action => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-lock-'))
  const children = []
  const start = options => { const result = child(options); children.push(result); return result }
  try { await action({ root, lock: join(root, 'install.lock'), start }) } finally {
    for (const item of children) if (item.running.exitCode === null) item.running.kill()
    await Promise.all(children.map(item => item.done))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  }
}

const deadLock = lock => {
  const gone = spawnSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8', windowsHide: true })
  assert.equal(gone.status, 0)
  const record = JSON.stringify({ version: 1, pid: Number(gone.stdout.trim()), token: 'a'.repeat(32) })
  writeFileSync(lock, record)
  utimesSync(lock, new Date(0), new Date(0))
  return record
}

test('a paused live native writer cannot be displaced by an expired lock', async () => fixture(async ({ root, lock, start }) => {
  const reached = join(root, 'reached'), release = join(root, 'release'), result = join(root, 'result')
  const first = start({ lock, reached, release })
  await until(() => existsSync(reached))
  utimesSync(lock, new Date(0), new Date(0))
  const owner = readFileSync(lock, 'utf8')
  const second = start({ lock, result, waitMs: 100 })
  const skipped = await second.done
  assert.equal(skipped.code, 1)
  assert.match(skipped.stderr, /LOCK_BUSY/)
  assert.equal(readFileSync(lock, 'utf8'), owner)
  assert.equal(existsSync(result), false)
  writeFileSync(release, '')
  assert.equal((await first.done).code, 0)
  assert.equal(existsSync(lock), false)
  assert.equal(existsSync(`${lock}.recover`), false)
}))

test('a killed native holder is recovered only after the stale bound', async () => fixture(async ({ root, lock, start }) => {
  const reached = join(root, 'reached')
  const first = start({ lock, reached, release: join(root, 'never') })
  await until(() => existsSync(reached))
  first.running.kill()
  await first.done
  let called = false
  assert.throws(() => withLocalLock(lock, () => { called = true }, { waitMs: 0, staleMs: 60000 }), /LOCK_BUSY/)
  assert.equal(called, false)
  utimesSync(lock, new Date(0), new Date(0))
  withLocalLock(lock, () => { called = true }, { waitMs: 100, staleMs: 30000 })
  assert.equal(called, true)
  assert.equal(existsSync(lock), false)
}))

test('two simultaneous reclaimers cannot replace the successor of a dead native owner', async () => fixture(async ({ root, lock, start }) => {
  deadLock(lock)
  const reached = join(root, 'reached'), release = join(root, 'release')
  const recoverReached = join(root, 'recover-reached'), recoverRelease = join(root, 'recover-release')
  const first = start({ lock, reached, release, recoverReached, recoverRelease, waitMs: 500 })
  await until(() => existsSync(recoverReached))
  // The first reclaimer has observed the old owner and pauses before deletion.
  // The second sees that same dead owner while the exclusive recovery gate stays held.
  const busyObserved = join(root, 'busy-observed')
  const second = start({ lock, reached, release, busyObserved, waitMs: 500 })
  await until(() => existsSync(busyObserved))
  writeFileSync(recoverRelease, '')
  await until(() => existsSync(reached))
  const owner = readFileSync(lock, 'utf8')
  // Recovery and acquisition are separate: either contender may own the successor.
  // The loser must time out while that one complete action stays paused.
  const skipped = await Promise.race([first.done, second.done])
  assert.equal(skipped.code, 1)
  assert.match(skipped.stderr, /LOCK_BUSY/)
  assert.equal(readFileSync(lock, 'utf8'), owner)
  writeFileSync(release, '')
  const results = await Promise.all([first.done, second.done])
  assert.deepEqual(results.map(one => one.code).sort(), [0, 1])
  assert.equal(existsSync(lock), false)
}))

test('unknown owners and abandoned recovery gates are retained without running a native mutation', async () => fixture(async ({ lock }) => {
  for (const record of ['', '{bad', JSON.stringify({ version: 1, pid: 0, token: 'a'.repeat(32) })]) {
    writeFileSync(lock, record)
    utimesSync(lock, new Date(0), new Date(0))
    assert.throws(() => withLocalLock(lock, () => assert.fail('mutation ran'), { waitMs: 0, staleMs: 0 }), /LOCK_BUSY/)
    assert.equal(readFileSync(lock, 'utf8'), record)
  }
  const record = deadLock(lock)
  writeFileSync(`${lock}.recover`, 'abandoned')
  assert.throws(() => withLocalLock(lock, () => assert.fail('mutation ran'), { waitMs: 0, staleMs: 0 }), /LOCK_BUSY/)
  assert.equal(readFileSync(lock, 'utf8'), record)
  assert.equal(readFileSync(`${lock}.recover`, 'utf8'), 'abandoned')
}))

test('native lock cleanup preserves a replacement and releases after an action failure', async () => fixture(async ({ lock }) => {
  assert.throws(() => withLocalLock(lock, () => { throw new Error('ACTION_FAILED') }), /ACTION_FAILED/)
  assert.equal(existsSync(lock), false)
  assert.throws(() => withLocalLock(lock, () => {
    unlinkSync(lock)
    writeFileSync(lock, 'replacement-owner')
  }), /LOCK_OWNERSHIP_LOST/)
  assert.equal(readFileSync(lock, 'utf8'), 'replacement-owner')
}))

test('an uncreatable native lock fails before the mutation runs', async () => fixture(async ({ lock }) => {
  mkdirSync(lock)
  assert.throws(() => withLocalLock(lock, () => assert.fail('mutation ran'), { waitMs: 0 }))
  assert.equal(existsSync(lock), true)
}))

test('a Windows folder that denies lock creation reports LOCK_DENIED without running the mutation', { skip: process.platform !== 'win32' && 'Windows ACLs only' }, () => fixture(async ({ root, lock }) => {
  await withDeniedCreation(root, () => {
    assert.throws(() => withLocalLock(lock, () => assert.fail('mutation ran'), { waitMs: 100 }), /^Error: LOCK_DENIED$/)
    assert.equal(existsSync(lock), false)
    assert.equal(existsSync(`${lock}.recover`), false)
  })
  withLocalLock(lock, () => undefined)
  assert.equal(existsSync(lock), false)
}))

test('a held Windows lock remains LOCK_BUSY when its directory also denies creation', { skip: process.platform !== 'win32' && 'Windows ACLs only' }, () => fixture(async ({ root, lock }) => {
  const owner = JSON.stringify({ version: 1, pid: process.pid, token: 'a'.repeat(32) })
  writeFileSync(lock, owner)
  await withDeniedCreation(root, () => {
    assert.throws(() => withLocalLock(lock, () => assert.fail('mutation ran'), { waitMs: 100 }), /^Error: LOCK_BUSY$/)
    assert.equal(readFileSync(lock, 'utf8'), owner)
  })
}))

const windowsOnly = { skip: process.platform !== 'win32' && 'EPERM means a busy lock only on Windows' }

test('a lock create refused with EPERM while the lock file is absent takes the lock instead of reporting LOCK_DENIED', windowsOnly, () => fixture(async ({ root, lock, start }) => {
  const result = join(root, 'result')
  // Two refusals in a row, as when a releasing owner's unlink lands between the create and the stat, twice.
  const taken = await start({ lock, result, waitMs: 0, epermCreates: 2 }).done
  assert.equal(taken.code, 0, taken.stderr)
  assert.equal(readFileSync(result, 'utf8'), 'written')
  assert.equal(existsSync(lock), false)
  assert.equal(existsSync(`${lock}.recover`), false)
}))

test('a lock create that stays refused with EPERM while the lock file is absent still reports LOCK_DENIED after a bounded number of tries', windowsOnly, () => fixture(async ({ root, lock, start }) => {
  const result = join(root, 'result'), attempts = join(root, 'attempts')
  const denied = await start({ lock, result, waitMs: 0, epermCreates: 1000, attempts }).done
  assert.equal(denied.code, 1)
  assert.match(denied.stderr, /^LOCK_DENIED$/)
  assert.equal(existsSync(result), false)
  // The first round makes 2 creates, each of the 5 further rounds 2 more.
  assert.equal(Number(readFileSync(attempts, 'utf8')), 12)
}))

test('a lock whose stat is refused with EPERM while it is released counts as busy, and a stat that stays refused is reported', windowsOnly, () => fixture(async ({ root, lock, start }) => {
  const result = join(root, 'result')
  // A held lock: recovery cannot stat it and must leave it alone.
  const held = JSON.stringify({ version: 1, pid: process.pid, token: 'a'.repeat(32) })
  writeFileSync(lock, held)
  const first = await start({ lock, result, waitMs: 0, epermStat: true }).done
  assert.equal(first.code, 1)
  assert.match(first.stderr, /^LOCK_BUSY$/)
  assert.equal(readFileSync(lock, 'utf8'), held)
  unlinkSync(lock)
  // A create refused with EPERM whose follow-up stat is refused too: the file cannot be shown absent. It is tried again
  // a bounded number of times, then the stat error is reported as it is, not as a busy lock.
  const attempts = join(root, 'attempts')
  const second = await start({ lock, result, waitMs: 0, epermCreates: 1000, epermStat: true, attempts }).done
  assert.equal(second.code, 1)
  assert.match(second.stderr, /^EPERM: operation not permitted, lstat$/)
  assert.equal(Number(readFileSync(attempts, 'utf8')), 12)
  assert.equal(existsSync(result), false)
}))

test('failed native lock initialization closes its descriptor and preserves a detected replacement', async () => fixture(async ({ root, lock }) => {
  for (const initialFailure of ['write', 'fstat', 'fstat-replaced']) {
    const initialReport = join(root, 'initial-report'), result = join(root, 'result')
    const failed = spawnSync(process.execPath, ['--input-type=module', '-e', program, JSON.stringify({ lock, initialFailure, initialReport, result })], { encoding: 'utf8', windowsHide: true })
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /(?:WRITE|FSTAT)_EIO/)
    assert.deepEqual(JSON.parse(readFileSync(initialReport, 'utf8')), { closed: 1, open: 0 })
    assert.equal(existsSync(result), false)
    if (initialFailure === 'fstat-replaced') {
      assert.equal(readFileSync(lock, 'utf8'), 'replacement-owner')
      unlinkSync(lock)
    } else assert.equal(existsSync(lock), false)
  }
}))

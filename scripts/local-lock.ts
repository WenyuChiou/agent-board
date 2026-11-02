import { randomBytes } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'

type Claim = { fd: number; text: string; device: number; inode: number }
type Bounds = { waitMs?: number; staleMs?: number }
type Synchronous<T> = T extends PromiseLike<unknown> ? never : T

const isBusy = (error: unknown): boolean => {
  const code = (error as { code?: string }).code
  return code === 'EEXIST' || process.platform === 'win32' && code === 'EPERM'
}

// On Windows a file whose delete is still in flight refuses a create, a stat and an open with EPERM until the
// last handle closes, and it is gone a moment later (#241). To a caller that is a lock in its last moments, not a refusal.
const isVanishing = (error: unknown): boolean => process.platform === 'win32' && (error as { code?: string }).code === 'EPERM'

// EPERM with no lock file there, or with a lock file that cannot be stat-ed, can be that same race, so a few more tries
// (each after a pause of at most 10 ms) must show the refusal repeating before it is reported as a refusal.
const DENIED_RETRIES = 5

const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

const claim = (file: string, busy?: (code: string) => void): Claim | null => {
  const text = JSON.stringify({ version: 1, pid: process.pid, token: randomBytes(16).toString('hex') })
  let fd: number
  try { fd = openSync(file, 'wx', 0o600) } catch (error) {
    if (isBusy(error)) {
      busy?.((error as { code: string }).code)
      return null
    }
    throw error
  }
  let identity: Stats | undefined
  try {
    writeFileSync(fd, text)
    identity = fstatSync(fd)
    return { fd, text, device: identity.dev, inode: identity.ino }
  } catch (error) {
    // A failed first write can still identify its descriptor; when fstat itself
    // fails, a complete random ownership token can identify the created file.
    // If neither identity is available, retain the unknown lock rather than guess.
    try {
      if (identity === undefined) {
        try { identity = fstatSync(fd) } catch {}
      }
    } finally {
      closeSync(fd)
    }
    const current = lstatSync(file)
    const isSameFile = current.isFile() && (identity === undefined
      ? readFileSync(file, 'utf8') === text
      : current.dev === identity.dev && current.ino === identity.ino)
    if (isSameFile) unlinkSync(file)
    throw error
  }
}

const release = (file: string, owner: Claim): void => {
  closeSync(owner.fd)
  const current = lstatSync(file)
  if (!current.isFile() || current.dev !== owner.device || current.ino !== owner.inode || readFileSync(file, 'utf8') !== owner.text) {
    throw new Error('LOCK_OWNERSHIP_LOST')
  }
  unlinkSync(file)
}

const isDeadOwner = (text: string): boolean => {
  try {
    const owner = JSON.parse(text) as { version?: unknown; pid?: unknown; token?: unknown }
    if (owner.version !== 1 || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !/^[a-f0-9]{32}$/.test(owner.token)) return false
    try { process.kill(owner.pid, 0) } catch (error) {
      return (error as { code?: string }).code === 'ESRCH'
    }
  } catch {}
  return false
}

const recover = (file: string, staleMs: number): void => {
  // A single recovery owner rereads the lock after taking this gate. A reclaimer
  // that waited for another must never act on its earlier observation. A crashed
  // recovery gate is deliberately retained: age cannot prove it safe to replace.
  const gate = `${file}.recover`
  const owner = claim(gate)
  if (owner === null) return
  try {
    let current
    try { current = lstatSync(file) } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT' || isVanishing(error)) return
      throw error
    }
    if (!current.isFile() || Date.now() - current.mtimeMs < staleMs) return
    let text: string
    try { text = readFileSync(file, 'utf8') } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT' || isVanishing(error)) return
      throw error
    }
    if (!isDeadOwner(text)) return
    // Every cooperating reclaimer holds the gate; a dead owner cannot resume its
    // release. Ordinary acquisition cannot replace the still-existing lock.
    unlinkSync(file)
  } finally {
    release(gate, owner)
  }
}

// The entire action must be synchronous in this native process. A lease around
// asynchronous engine writes would let a paused owner write after replacement.
export const withLocalLock = <T>(file: string, action: () => T & Synchronous<T>, bounds: Bounds = {}): T => {
  const waitMs = bounds.waitMs ?? 2000
  const staleMs = bounds.staleMs ?? 30000
  if (!Number.isFinite(waitMs) || waitMs < 0 || !Number.isFinite(staleMs) || staleMs < 0) throw new Error('INVALID_LOCK_BOUNDS')
  mkdirSync(dirname(file), { recursive: true })
  const started = performance.now()
  let owner: Claim | null = null
  let lastCode = ''
  let absent = 0
  const busy = (code: string): void => { lastCode = code }
  for (;;) {
    owner = claim(file, busy)
    if (owner !== null) break
    recover(file, staleMs)
    owner = claim(file, busy)
    if (owner !== null) break
    if (performance.now() - started >= waitMs) {
      // A disappearing owner can cause EPERM during the wait. Classify only the final
      // failed create, and do not infer absence from an unreadable directory entry.
      if (lastCode === 'EPERM') {
        try { lstatSync(file) } catch (error) {
          const isAbsent = (error as { code?: string }).code === 'ENOENT'
          if (!isAbsent && !isVanishing(error)) throw error
          // One such refusal is the owner's release racing this create: try again. A real refusal repeats, and
          // only then is it reported: LOCK_DENIED when no file is there, the stat error when one cannot be read.
          if (absent < DENIED_RETRIES) {
            absent += 1
            pause(10)
            continue
          }
          if (isAbsent) throw new Error('LOCK_DENIED')
          throw error
        }
      }
      throw new Error('LOCK_BUSY')
    }
    pause(Math.max(0, Math.min(10, waitMs - (performance.now() - started))))
  }
  try { return action() } finally { release(file, owner) }
}

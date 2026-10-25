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
      if ((error as { code?: string }).code === 'ENOENT') return
      throw error
    }
    if (!current.isFile() || Date.now() - current.mtimeMs < staleMs) return
    let text: string
    try { text = readFileSync(file, 'utf8') } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return
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
          if ((error as { code?: string }).code === 'ENOENT') throw new Error('LOCK_DENIED')
          throw error
        }
      }
      throw new Error('LOCK_BUSY')
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.min(10, waitMs - (performance.now() - started))))
  }
  try { return action() } finally { release(file, owner) }
}

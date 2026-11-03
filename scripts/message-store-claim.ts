import { randomBytes } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PREFIX = '.message-claim-'
// A claim is written under this name first and renamed into place.
const PENDING = '.message-pending-'
const LIMIT = 1024
const blocked = (): Error => new Error('MESSAGE_STORE_CLAIM_BLOCKED')
const canonical = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

const readClaim = (file: string): string => {
  const before = lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512) throw blocked()
  const fd = openSync(file, 'r')
  try {
    const opened = fstatSync(fd)
    // Its owner released it while this read: the claim is gone, not broken.
    if (opened.nlink === 0 && opened.dev === before.dev && opened.ino === before.ino) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size > 512) throw blocked()
    const buffer = Buffer.alloc(513)
    const count = readSync(fd, buffer, 0, buffer.length, 0)
    if (count === 0 || count > 512) throw blocked()
    return buffer.subarray(0, count).toString('utf8')
  } finally { closeSync(fd) }
}

export type MessageStoreClaim = {
  check: (directory: string) => void
  release: () => void
}

// Publish before scanning. A later contender must see this claim; contenders that
// see each other both refuse rather than electing a later writer over a live one.
export const claimMessageStore = (directory: string): MessageStoreClaim => {
  const root = resolve(directory)
  const kind = lstatSync(root)
  if (!kind.isDirectory() || kind.isSymbolicLink()) throw blocked()
  const nonce = randomBytes(16).toString('hex')
  const name = PREFIX + process.pid + '-' + nonce + '.json'
  const file = join(root, name)
  const bytes = JSON.stringify({ version: 1, pid: process.pid, nonce }) + '\n'
  const pending = join(root, PENDING + process.pid + '-' + nonce + '.json')
  let isReleased = false
  // Created in place, a claim is empty until it is written, and a contender scanning then takes it
  // for a broken one and refuses. A rename shows the whole claim or nothing.
  try {
    writeFileSync(pending, bytes, { flag: 'wx', mode: 0o600 })
    renameSync(pending, file)
  } catch (cause) {
    // The pending name holds this process's own nonce, so only an existing file is someone else's.
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') try { unlinkSync(pending) } catch {}
    throw new Error('MESSAGE_STORE_CLAIM_BLOCKED', { cause })
  }
  const claim: MessageStoreClaim = {
    check: directory => {
      if (isReleased || canonical(directory) !== canonical(root) || readClaim(file) !== bytes) throw blocked()
    },
    release: () => {
      if (isReleased) return
      try {
        if (readClaim(file) !== bytes) throw blocked()
        unlinkSync(file)
        isReleased = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        isReleased = true
      }
    },
  }
  try {
    const all = readdirSync(root)
    // A writer that died between writing and renaming leaves its pending file; only a proven-dead one goes.
    for (const other of all) {
      const writer = /^\.message-pending-([1-9][0-9]*)-[a-f0-9]{32}\.json$/.exec(other)
      if (!writer || Number(writer[1]) === process.pid) continue
      try { process.kill(Number(writer[1]), 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') try { unlinkSync(join(root, other)) } catch {}
      }
    }
    const names = all.filter(one => one.startsWith(PREFIX))
    if (names.length > LIMIT || !names.includes(name)) throw blocked()
    for (const other of names) {
      if (other === name) { claim.check(root); continue }
      const path = join(root, other)
      let raw: string
      try { raw = readClaim(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw blocked()
      }
      const match = /^\.message-claim-([1-9][0-9]*)-([a-f0-9]{32})\.json$/.exec(other)
      let value: { version?: unknown, pid?: unknown, nonce?: unknown }
      try { value = JSON.parse(raw) as typeof value } catch { throw blocked() }
      if (!match || !value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'nonce,pid,version'
        || value.version !== 1 || value.pid !== Number(match[1]) || value.nonce !== match[2]
        || !Number.isSafeInteger(value.pid) || Number(value.pid) > 2147483647) throw blocked()
      try {
        process.kill(Number(value.pid), 0)
        throw new Error('MESSAGE_STORE_IN_USE')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          if (error instanceof Error && error.message === 'MESSAGE_STORE_IN_USE') throw error
          throw blocked()
        }
      }
      // Only a proven-dead writer's exact immutable claim can be retired.
      try {
        if (readClaim(path) !== raw) throw blocked()
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw blocked()
      }
    }
    return claim
  } catch (error) {
    try { claim.release() } catch (cleanup) { throw new AggregateError([error, cleanup], 'MESSAGE_STORE_CLAIM_BLOCKED') }
    throw error
  }
}

export const hasLiveClaims = (directory: string): boolean => {
  try {
    const root = resolve(directory)
    const names = readdirSync(root).filter(one => one.startsWith(PREFIX))
    for (const other of names) {
      const match = /^\.message-claim-([1-9][0-9]*)-[a-f0-9]{32}\.json$/.exec(other)
      if (!match) continue
      try {
        process.kill(Number(match[1]), 0)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true
      }
    }
  } catch {}
  return false
}

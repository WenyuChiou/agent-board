import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PREFIX = '.message-claim-'
// A claim is written under this name first and renamed into place.
const PENDING = '.message-pending-'
const LIMIT = 1024
// DIAGNOSTIC ONLY (#795 CI): reverted before merge.
export const claimDebug = (why: string): void => { const file = process.env.AGENT_BOARD_CLAIM_DEBUG; if (file) try { appendFileSync(file, (Date.now() % 1e7) + ' ' + process.pid + ' ' + why + String.fromCharCode(10)) } catch {} }
const codeOf = (error: unknown): string => String((error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? error)
const blocked = (why = '?'): Error => { claimDebug('BLOCKED ' + why); return new Error('MESSAGE_STORE_CLAIM_BLOCKED') }
const canonical = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

// Another board's claim (`isOther`) whose owner released it during this read has no name left
// (nlink 0): that claim is gone, not broken. A board's own claim never goes that way.
const readClaimOnce = (file: string, isOther: boolean): string => {
  const before = lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512) throw blocked('B1 lstat file=' + before.isFile() + ' nlink=' + before.nlink + ' size=' + before.size + ' other=' + isOther)
  const fd = openSync(file, 'r')
  try {
    const opened = fstatSync(fd)
    if (isOther && opened.nlink === 0 && opened.dev === before.dev && opened.ino === before.ino) {
      // Gone only if nothing has taken its name since.
      try { lstatSync(file) } catch (error) { if (['ENOENT', 'EPERM', 'EBUSY', 'EAGAIN'].includes(String((error as NodeJS.ErrnoException).code))) throw error }
      throw blocked('B2 nlink0 name still there')
    }
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size > 512) throw blocked('B3 fstat dev=' + (opened.dev === before.dev) + ' ino=' + (opened.ino === before.ino) + ' nlink=' + opened.nlink + ' size=' + opened.size + ' other=' + isOther)
    const buffer = Buffer.alloc(513)
    const count = readSync(fd, buffer, 0, buffer.length, 0)
    if (count === 0 || count > 512) throw blocked('B4 count=' + count + ' other=' + isOther)
    return buffer.subarray(0, count).toString('utf8')
  } finally { closeSync(fd) }
}

const WAITS_MS = [10, 25, 50, 100, 200, 400]
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

// Windows refuses a file for a moment while another process removes it (EPERM until the remover
// closes it), or while a virus scanner holds one just written (EPERM, EBUSY). Every step on a claim
// file is tried again after short waits; only a refusal that outlasts them all counts.
const patiently = <T>(step: () => T, label = '?'): T => {
  for (let attempt = 0; ; attempt++) {
    try {
      return step()
    } catch (error) {
      const wait = WAITS_MS[attempt]
      const code = String((error as NodeJS.ErrnoException).code)
      if (['EPERM', 'EBUSY', 'EAGAIN'].includes(code)) claimDebug('RETRY ' + label + ' ' + code + ' attempt=' + attempt + (wait === undefined ? ' GAVE-UP' : ''))
      if (wait === undefined || !['EPERM', 'EBUSY', 'EAGAIN'].includes(code)) throw error
      pause(wait)
    }
  }
}

// A claim refused while its owner removes it is, after a wait, gone or readable.
const readClaim = (file: string, isOther = false): string => patiently(() => readClaimOnce(file, isOther), isOther ? 'read-other' : 'read-own')

export type MessageStoreClaim = {
  check: (directory: string) => void
  release: () => void
}

// Publish before scanning. A later contender must see this claim; contenders that
// see each other both refuse rather than electing a later writer over a live one.
export const claimMessageStore = (directory: string): MessageStoreClaim => {
  const root = resolve(directory)
  const kind = lstatSync(root)
  if (!kind.isDirectory() || kind.isSymbolicLink()) throw blocked('B5 root')
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
    patiently(() => renameSync(pending, file), 'rename')
  } catch (cause) {
    claimDebug('PUBLISH ' + codeOf(cause))
    // The pending name holds this process's own nonce, so only an existing file is someone else's.
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') try { unlinkSync(pending) } catch {}
    throw new Error('MESSAGE_STORE_CLAIM_BLOCKED', { cause })
  }
  const claim: MessageStoreClaim = {
    check: directory => {
      if (isReleased || canonical(directory) !== canonical(root)) throw blocked('B6 released=' + isReleased + ' same=' + (canonical(directory) === canonical(root)))
      if (readClaim(file) !== bytes) throw blocked('B6b own bytes changed')
    },
    release: () => {
      if (isReleased) return
      try {
        if (readClaim(file) !== bytes) throw blocked('B7 own bytes changed at release')
        // A start that loses to a live board releases its claim just after writing it, while a
        // scanner may still hold it; a refusal here would end that start instead of letting it retry.
        patiently(() => unlinkSync(file), 'release-unlink')
        isReleased = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { claimDebug('RELEASE ' + codeOf(error)); throw error }
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
    if (names.length > LIMIT || !names.includes(name)) throw blocked('B8 count=' + names.length + ' own=' + names.includes(name))
    for (const other of names) {
      if (other === name) { claim.check(root); continue }
      const path = join(root, other)
      let raw: string
      try { raw = readClaim(path, true) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        claimDebug('SCANREAD ' + codeOf(error))
        throw blocked('B9 scan read')
      }
      const match = /^\.message-claim-([1-9][0-9]*)-([a-f0-9]{32})\.json$/.exec(other)
      let value: { version?: unknown, pid?: unknown, nonce?: unknown }
      try { value = JSON.parse(raw) as typeof value } catch { throw blocked('B10 json len=' + raw.length) }
      if (!match || !value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'nonce,pid,version'
        || value.version !== 1 || value.pid !== Number(match[1]) || value.nonce !== match[2]
        || !Number.isSafeInteger(value.pid) || Number(value.pid) > 2147483647) throw blocked('B11 shape match=' + Boolean(match))
      try {
        process.kill(Number(value.pid), 0)
        throw new Error('MESSAGE_STORE_IN_USE')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          if (error instanceof Error && error.message === 'MESSAGE_STORE_IN_USE') throw error
          claimDebug('KILL ' + codeOf(error))
          throw blocked('B12 kill')
        }
      }
      // Only a proven-dead writer's exact immutable claim can be retired.
      claimDebug('RETIRE dead pid claim')
      try {
        if (readClaim(path, true) !== raw) throw blocked('B13 dead claim changed')
        patiently(() => unlinkSync(path), 'retire-unlink')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { claimDebug('RETIRE-FAIL ' + codeOf(error)); throw blocked('B14 retire') }
      }
    }
    return claim
  } catch (error) {
    claimDebug('OUTER ' + codeOf(error))
    try { claim.release() } catch (cleanup) { claimDebug('OUTER-RELEASE ' + codeOf(cleanup)); throw new AggregateError([error, cleanup], 'MESSAGE_STORE_CLAIM_BLOCKED') }
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

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { processStarted, type ProcessStart } from './local-lock.ts'

const PREFIX = '.message-claim-'
// A claim is written under this name first and renamed into place.
const PENDING = '.message-pending-'
const LIMIT = 1024
const blocked = (): Error => new Error('MESSAGE_STORE_CLAIM_BLOCKED')
// A claim file that is not what a board wrote — wrong shape, unreadable, or bytes that no longer
// match — is a broken store, not a contention to wait out (#1484).
const damaged = (): Error => new Error('MESSAGE_STORE_CLAIM_DAMAGED')
// A refusal Windows clears on its own (a file being removed, a scanner holding one just written)
// is contention, not damage: the next call tries again.
const TRANSIENT_ERRNO = new Set(['EPERM', 'EBUSY', 'EAGAIN'])
// The errnos that make a refusal a contention, as in `isClaimContention`
// (`scripts/board-messaging.ts`): a refusal Windows clears on its own, or a name
// another file took.
const CONTENTION_ERRNO = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EAGAIN'])

// Whether a scan failure is itself a contention: a live owner, a blocked error with no
// cause or a contention cause, or a raw refusal in the contention set. Anything else —
// damage, EIO, a generic failure — is not, so the cleanup failure must not wrap it into
// one (#1484).
const isContention = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  if (error.message === 'MESSAGE_STORE_IN_USE') return true
  if (error.message === 'MESSAGE_STORE_CLAIM_BLOCKED') {
    const cause = (error as { cause?: unknown }).cause as NodeJS.ErrnoException | null | undefined
    return cause == null || CONTENTION_ERRNO.has(String(cause.code ?? ''))
  }
  return CONTENTION_ERRNO.has(String((error as NodeJS.ErrnoException).code ?? ''))
}
const canonical = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

// While its owner removes it, another board's claim can still have its name on Windows and yet
// show no link (nlink 0). Looked at again after a wait, it is gone; this is not a broken claim.
const removing = (): Error => Object.assign(new Error('MESSAGE_STORE_CLAIM_REMOVING'), { code: 'EAGAIN' })

// Another board's claim (`isOther`) whose owner released it during this read has no name left
// (nlink 0): that claim is gone, not broken. A board's own claim never goes that way.
const readClaimOnce = (file: string, isOther: boolean): string => {
  const before = lstatSync(file)
  if (isOther && before.isFile() && !before.isSymbolicLink() && before.nlink === 0) throw removing()
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512) throw damaged()
  const fd = openSync(file, 'r')
  try {
    const opened = fstatSync(fd)
    if (isOther && opened.nlink === 0 && opened.dev === before.dev && opened.ino === before.ino) {
      // Gone only if nothing has taken its name since: a name still on this same file is a
      // removal not finished yet, and a name on another file blocks.
      const now = (() => {
        try { return lstatSync(file) } catch (error) {
          if (['ENOENT', 'EPERM', 'EBUSY', 'EAGAIN'].includes(String((error as NodeJS.ErrnoException).code))) throw error
          throw damaged()
        }
      })()
      if (now.dev === opened.dev && now.ino === opened.ino) throw removing()
      throw blocked()
    }
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size > 512) throw damaged()
    const buffer = Buffer.alloc(513)
    const count = readSync(fd, buffer, 0, buffer.length, 0)
    // A claim is never published empty, so another board's that reads empty is being removed.
    if (count === 0 && isOther) throw removing()
    if (count === 0 || count > 512) throw damaged()
    return buffer.subarray(0, count).toString('utf8')
  } finally { closeSync(fd) }
}

const WAITS_MS = [10, 25, 50, 100, 200, 400]
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

// Windows refuses a file for a moment while another process removes it (EPERM until the remover
// closes it), or while a virus scanner holds one just written (EPERM, EBUSY). Every step on a claim
// file is tried again after short waits; only a refusal that outlasts them all counts.
export const patiently = <T>(step: () => T): T => {
  for (let attempt = 0; ; attempt++) {
    try {
      return step()
    } catch (error) {
      const wait = WAITS_MS[attempt]
      if (wait === undefined || !['EPERM', 'EBUSY', 'EAGAIN'].includes(String((error as NodeJS.ErrnoException).code))) throw error
      pause(wait)
    }
  }
}

// A claim refused while its owner removes it is, after a wait, gone or readable.
const readClaim = (file: string, isOther = false): string => patiently(() => readClaimOnce(file, isOther))

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
    patiently(() => renameSync(pending, file))
  } catch (cause) {
    // The pending name holds this process's own nonce, so only an existing file is someone else's.
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') try { unlinkSync(pending) } catch {}
    throw new Error('MESSAGE_STORE_CLAIM_BLOCKED', { cause })
  }
  const claim: MessageStoreClaim = {
    check: directory => {
      if (isReleased || canonical(directory) !== canonical(root)) throw blocked()
      // A claim file that is gone or no longer holds this claim's bytes is damaged, not a
      // contention: no other board retires a live owner's claim (#1484).
      let read: string
      try { read = readClaim(file) } catch (error) {
        // A read failure the check itself did not already name as damage is damage too,
        // unless Windows clears it on its own: the write path defers on anything that is
        // not damage, so only damage may pass through unnamed (#1484).
        if (error instanceof Error && error.message === 'MESSAGE_STORE_CLAIM_DAMAGED') throw error
        if (TRANSIENT_ERRNO.has(String((error as NodeJS.ErrnoException).code ?? ''))) throw error
        throw damaged()
      }
      if (read !== bytes) throw damaged()
    },
    release: () => {
      if (isReleased) return
      try {
        if (readClaim(file) !== bytes) throw damaged()
        // A start that loses to a live board releases its claim just after writing it, while a
        // scanner may still hold it; a refusal here would end that start instead of letting it retry.
        patiently(() => unlinkSync(file))
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
      try { raw = readClaim(path, true) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        // A claim the reader itself refused as blocked — a name another file took while it was
        // being read — stays blocked: that is a contention, not damage (#1484).
        if (error instanceof Error && (error.message === 'MESSAGE_STORE_CLAIM_DAMAGED' || error.message === 'MESSAGE_STORE_CLAIM_BLOCKED')) throw error
        if (TRANSIENT_ERRNO.has(String((error as NodeJS.ErrnoException).code ?? ''))) throw blocked()
        throw damaged()
      }
      const match = /^\.message-claim-([1-9][0-9]*)-([a-f0-9]{32})\.json$/.exec(other)
      let value: { version?: unknown, pid?: unknown, nonce?: unknown }
      try { value = JSON.parse(raw) as typeof value } catch { throw damaged() }
      if (!match || !value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'nonce,pid,version'
        || value.version !== 1 || value.pid !== Number(match[1]) || value.nonce !== match[2]
        || !Number.isSafeInteger(value.pid) || Number(value.pid) > 2147483647) throw damaged()
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
        if (readClaim(path, true) !== raw) throw damaged()
        patiently(() => unlinkSync(path))
      } catch (error) {
        if (error instanceof Error && (error.message === 'MESSAGE_STORE_CLAIM_DAMAGED' || error.message === 'MESSAGE_STORE_CLAIM_BLOCKED')) throw error
        const code = String((error as NodeJS.ErrnoException).code ?? '')
        if (code !== 'ENOENT') {
          if (TRANSIENT_ERRNO.has(code)) throw blocked()
          throw damaged()
        }
      }
    }
    return claim
  } catch (error) {
    try { claim.release() } catch (cleanup) {
      // The cleanup failure must not turn a damaged store into a contention: only a
      // first error that is itself one is wrapped, so it still defers (#1484).
      if (!isContention(error)) throw error
      throw new AggregateError([error, cleanup], 'MESSAGE_STORE_CLAIM_BLOCKED')
    }
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

// M6 (#1596, #1587): the process holding a store's lock, as the system reports it. Its command line and
// start time come from one read. 'gone' when no process has that number; null when it cannot be read
// (another account's, or the lookup timed out), which never counts as proof of anything.
export type StoreHolder = { commandLine: string; started: number }
const liveHolder = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
export const lookUpHolder = (pid: number, timeoutMs = 5000): StoreHolder | 'gone' | null => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return null
  try {
    if (process.platform === 'linux') {
      let raw: string
      try { raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : null }
      const started = processStarted(pid, timeoutMs)
      if (typeof started !== 'number') return liveHolder(pid) ? null : 'gone'
      return raw === '' ? null : { commandLine: raw.replace(/\0+$/, ''), started }
    }
    if (process.platform === 'win32') {
      const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      // UTF-8 out, so a folder name outside the console's code page survives the read.
      const out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; if ($null -eq $p) { 'GONE' } elseif ($null -eq $p.CommandLine -or $null -eq $p.CreationDate) { 'UNREADABLE' } else { [string]$p.CreationDate.ToFileTimeUtc(); $p.CommandLine }`,
      ], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const [first = '', ...rest] = out.replace(/\r/g, '').split('\n')
      if (first.trim() === 'GONE') return 'gone'
      if (!/^\d+$/.test(first.trim())) return null
      return { commandLine: rest.join('\n').trim(), started: Number(BigInt(first.trim()) / 10000n - 11644473600000n) }
    }
    const out = execFileSync('/bin/ps', ['-ww', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim()
    const started = Date.parse(`${out.slice(0, 24)} UTC`)
    return out.length > 25 && Number.isFinite(started) ? { commandLine: out.slice(25).trim(), started } : null
  } catch { return liveHolder(pid) ? null : 'gone' }
}

const BOARD_HEAD = 'globalThis.AGENT_BOARD = '
const headOf = (file: string): string | null => {
  try {
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(BOARD_HEAD.length)
      return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8')
    } finally { closeSync(fd) }
  } catch { return null }
}

// A board page: a command line with a page flag that runs a script whose file starts as every board
// script the board installs does. A program built to copy that is not stopped (as F10 says of a forged
// identity); any other program is never taken for the board.
export const isBoardServe = (commandLine: string, head: (file: string) => string | null = headOf): boolean => {
  if (!/(?:^|[\s\0"])--serve(?:-child)?(?=$|[\s\0"])/.test(commandLine)) return false
  for (const found of commandLine.matchAll(/(?:^|[\s\0"])((?:[A-Za-z]:)?[\\/][^"\0]*?\.(?:mjs|cjs|js|ts))(?=$|[\s\0"])/g)) {
    if (head(found[1]!) === BOARD_HEAD) return true
  }
  return false
}

// What a start does about a live holder of the default store: 'young' and 'kept' wait (a page may take
// seconds to start), 'gone' and 'ended' try again (the dead pid's lock and claim go by the proven-dead paths), and
// 'refused' names the process that holds the folder. A holder is ended only when it is proven to be a
// board page older than any start, and only after its start time is read again, so a number another
// program took meanwhile is never ended. messages.json is replaced whole, so a page ended mid-write
// leaves a complete file.
export type HolderOutcome = { kind: 'young' | 'kept' | 'gone' | 'ended' } | { kind: 'refused'; isBoard: boolean }
export type HolderDeps = {
  look: (pid: number) => StoreHolder | 'gone' | null
  started: (pid: number, look: StoreHolder) => ProcessStart
  isBoard: (commandLine: string) => boolean
  kill: (pid: number, signal: NodeJS.Signals) => void
  isAlive: (pid: number) => boolean
  minAgeMs: number
  waitMs: number
}
export const holderDeps = (minAgeMs: number): HolderDeps => ({
  look: pid => lookUpHolder(pid),
  started: pid => processStarted(pid, 5000),
  isBoard: commandLine => isBoardServe(commandLine),
  kill: (pid, signal) => { process.kill(pid, signal) },
  isAlive: liveHolder,
  minAgeMs,
  waitMs: 3000,
})
export const settleStoreHolder = async (pid: number, deps: HolderDeps): Promise<HolderOutcome> => {
  const look = deps.look(pid)
  if (look === 'gone') return { kind: 'gone' }
  if (look === null || !deps.isBoard(look.commandLine)) return { kind: 'refused', isBoard: false }
  // A board serving a folder given with --messages-dir writes no owner record, so its silence there proves
  // nothing; such a hub is never taken over (board-cli.ts says why), and is waited for as before.
  if (/(?:^|[\s\0"])--messages-dir(?=$|[\s\0"=])/.test(look.commandLine)) return { kind: 'kept' }
  if (Date.now() - look.started < deps.minAgeMs) return { kind: 'young' }
  const again = deps.started(pid, look)
  if (again === null && !deps.isAlive(pid)) return { kind: 'gone' }
  if (typeof again !== 'number' || Math.abs(again - look.started) > 1000) return { kind: 'refused', isBoard: false }
  const pause = (ms: number) => new Promise(done => setTimeout(done, ms))
  const isEnded = async (ms: number): Promise<boolean> => {
    const end = Date.now() + ms
    while (deps.isAlive(pid)) {
      if (Date.now() >= end) return false
      await pause(50)
    }
    return true
  }
  // Windows ends a process at the first signal; elsewhere one that ignores it, or is stopped, gets SIGKILL.
  for (const signal of process.platform === 'win32' ? ['SIGTERM'] as const : ['SIGTERM', 'SIGKILL'] as const) {
    try { deps.kill(pid, signal) } catch (error) {
      // Windows refuses to end a process that is already exiting (another start ended it first): that one is gone.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH' || !deps.isAlive(pid)) return { kind: 'gone' }
      return { kind: 'refused', isBoard: true }
    }
    if (await isEnded(deps.waitMs)) return { kind: 'ended' }
  }
  return { kind: 'refused', isBoard: true }
}

import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pid, platform } from 'node:process'

// The board's settings file (progress-settings.json) is one the person may have replaced with a link
// or a folder. Every reader and writer here refuses those, and none of them can block (#1276).
export type SettingsRead = { kind: 'missing' } | { kind: 'ok'; text: string } | { kind: 'unsafe' }

const isCode = (error: unknown, codes: readonly string[]): boolean => codes.includes(String((error as { code?: unknown } | null)?.code))

// Reads the file only when it is a regular file. The path is checked first, and then opened without waiting for a
// writer and without following a link, so a FIFO with no writer and a link are refused before any byte is read,
// and a path swapped for one of them after the check cannot block the read either. The read is by path, in one
// call, as `--status` must (tests/board-status.test.mjs lists the files it may read).
export const readSettings = (file: string): SettingsRead => {
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) return { kind: 'unsafe' }
  } catch (error) {
    if (isCode(error, ['ENOENT'])) return { kind: 'missing' }
    throw error
  }
  try {
    const flag = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)
    return { kind: 'ok', text: readFileSync(file, { encoding: 'utf8', flag }) }
  } catch (error) {
    if (isCode(error, ['ENOENT'])) return { kind: 'missing' }
    if (isCode(error, ['ELOOP', 'EISDIR', 'ENXIO', 'EAGAIN'])) return { kind: 'unsafe' }
    throw error
  }
}

// A save by our other writer (the plugin's `/progress style` script) between the last re-read and the rename would be
// overwritten while both report success. Both writers therefore take `<settings file>.agent-board.lock`, created
// exclusively (`wx`) and holding the pid and the time, around the re-read, the new file, the rename and the read-back.
// A writer that finds it waits for up to LOCK_WAIT_MS and then names the lock. It never takes over an existing lock:
// its owner may still be writing, and inspecting or deleting another writer's lock can block or race a fresh save.
// The creator removes its own lock in `finally`.
// hooks/settings-script.ts carries the same rules for the plugin's script.
const LOCK_WAIT_MS = 2000
// Windows refuses to create a file at a path whose file is still being deleted (EPERM), and a folder there gives EPERM
// or EACCES: each waits like a held lock, within the same 2 s.
const LOCK_BUSY = platform === 'win32' ? ['EEXIST', 'EPERM', 'EACCES'] : ['EEXIST']
// The lock the open lands in: the folder's real path (a link is followed before a `..`, which a lexical resolve gets wrong).
const nameOf = (lock: string): string => {
  try { return join(realpathSync.native(dirname(lock)), basename(lock)) } catch { return resolve(lock) }
}
// The name every message gives the lock of a settings file: the page, the terminal and both writers name one path.
export const settingsLockName = (file: string): string => nameOf(`${file}.agent-board.lock`)
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
// Windows creates the file a dangling link at the lock path points to, so there anything already at the path counts as
// held. Only whether something is there is looked at, never what it is or who made it.
const isTaken = (path: string): boolean => {
  try { lstatSync(path); return true } catch (error) { return !isCode(error, ['ENOENT']) }
}

export const withSettingsLock = <T>(file: string, run: () => T, onLeft?: (lock: string) => void): T => {
  // The lock is opened beside the file as given, so the file system resolves both paths alike (a lexical resolve
  // turns `link/..` into another folder); the real path is only for the message.
  const lock = `${file}.agent-board.lock`
  const deadline = performance.now() + LOCK_WAIT_MS
  let fd: number
  // File ids are compared as bigints: 64-bit ids can round to one JavaScript number.
  let own: BigIntStats
  for (;;) {
    if (performance.now() >= deadline) throw Object.assign(new Error('another save of the settings file is in progress, or died holding its lock; if none is running, delete ' + nameOf(lock)), { code: 'SETTINGS_LOCKED' })
    if (platform === 'win32' && isTaken(lock)) { pause(25); continue }
    try {
      fd = openSync(lock, 'wx', 0o600)
    } catch (error) {
      if (!isCode(error, LOCK_BUSY)) throw error
      pause(25)
      continue
    }
    // The lock is this writer's only when the path names the file it just created: not when the open went through a
    // link put there in between, and not when its identity cannot be read. Otherwise nothing is written and it waits.
    let made: BigIntStats | undefined
    try {
      const opened = fstatSync(fd, { bigint: true })
      const there = lstatSync(lock, { bigint: true })
      if (opened.dev === there.dev && opened.ino === there.ino) made = opened
    } catch {}
    if (made !== undefined) { own = made; break }
    closeSync(fd)
    pause(25)
  }
  try {
    writeFileSync(fd, `${pid} ${Date.now()}\n`)
    return run()
  } finally {
    let isLeft = false
    try {
      const current = lstatSync(lock, { bigint: true })
      if (current.dev === own.dev && current.ino === own.ino) unlinkSync(lock)
    } catch (error) { isLeft = !isCode(error, ['ENOENT']) }
    closeSync(fd)
    if (isLeft) onLeft?.(nameOf(lock))
  }
}

// Replaces the file with `next`, which was worked out from `base` (the text read earlier, or null for no file).
// The file is read again just before the swap and once more right after it: when it no longer holds `base`
// (another save got in between), nothing is written over it and the answer is 'changed', so the caller works
// the change out again from the fresh text and a save made meanwhile is not undone (#1276).
// The text goes to a new file beside it, which is renamed over the path. A rename puts a file where the path is and
// never writes through what the path points to, so a link swapped in after the check is replaced, and its
// target is left alone. The new file gets the old file's permission bits (0600 when there was none), as the
// rename would otherwise leave it with the process's default. 'unsafe', with nothing written, when the path is a
// link or not a regular file. `between` runs after the new file is written and before the swap, for a test to
// change the path there.
export type Replaced = 'ok' | 'unsafe' | 'changed'

export const replaceSettings = (file: string, base: string | null, next: string, between?: () => void, onLeft?: (lock: string) => void): Replaced =>
  withSettingsLock(file, () => replaceLocked(file, base, next, between), onLeft)

const replaceLocked = (file: string, base: string | null, next: string, between?: () => void): Replaced => {
  let mode = 0o600
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) return 'unsafe'
    mode = stat.mode & 0o777
  } catch (error) {
    if (!isCode(error, ['ENOENT'])) throw error
  }
  const holds = (): Replaced | 'same' => {
    const now = readSettings(file)
    if (now.kind === 'unsafe') return 'unsafe'
    return (now.kind === 'ok' ? now.text : null) === base ? 'same' : 'changed'
  }
  const before = holds()
  if (before !== 'same') return before
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  // Only a temp file this write created is ever deleted: a name that was already taken is somebody else's.
  let isCreated = false
  try {
    const fd = openSync(temp, 'wx', mode)
    isCreated = true
    try { writeFileSync(fd, next) } finally { closeSync(fd) }
    chmodSync(temp, mode)
    between?.()
    const late = holds()
    if (late !== 'same') {
      unlinkSync(temp)
      return late
    }
    renameSync(temp, file)
  } catch (error) {
    if (isCreated) try { unlinkSync(temp) } catch {}
    throw error
  }
  const after = readSettings(file)
  return after.kind === 'ok' && after.text === next ? 'ok' : after.kind === 'unsafe' ? 'unsafe' : 'changed'
}

// Works the change out from the file's text as it is now and saves it, again from the fresh text when another
// save got in between. `change` returns the new text, or null when the text is not something it can change.
export const updateSettings = (file: string, change: (text: string | null) => string | null, between?: () => void): { result: 'ok' | 'invalid' | 'unsafe'; text?: string; lockLeft?: string } => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const found = readSettings(file)
    if (found.kind === 'unsafe') return { result: 'unsafe' }
    const base = found.kind === 'ok' ? found.text : null
    const next = change(base)
    if (next === null) return { result: 'invalid' }
    let lockLeft: string | undefined
    const done = replaceSettings(file, base, next, attempt === 0 ? between : undefined, lock => { lockLeft = lock })
    if (done === 'unsafe') return { result: 'unsafe' }
    if (done === 'ok') return { result: 'ok', text: next, ...(lockLeft === undefined ? {} : { lockLeft }) }
  }
  throw new Error('the settings file kept changing while it was saved')
}

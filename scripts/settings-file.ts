import { chmodSync, constants, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

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

export const replaceSettings = (file: string, base: string | null, next: string, between?: () => void): Replaced => {
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
  try {
    writeFileSync(temp, next, { flag: 'wx', mode })
    chmodSync(temp, mode)
    between?.()
    const late = holds()
    if (late !== 'same') {
      unlinkSync(temp)
      return late
    }
    renameSync(temp, file)
  } catch (error) {
    try { unlinkSync(temp) } catch {}
    throw error
  }
  const after = readSettings(file)
  return after.kind === 'ok' && after.text === next ? 'ok' : after.kind === 'unsafe' ? 'unsafe' : 'changed'
}

// Works the change out from the file's text as it is now and saves it, again from the fresh text when another
// save got in between. `change` returns the new text, or null when the text is not something it can change.
export const updateSettings = (file: string, change: (text: string | null) => string | null, between?: () => void): { result: 'ok' | 'invalid' | 'unsafe'; text?: string } => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const found = readSettings(file)
    if (found.kind === 'unsafe') return { result: 'unsafe' }
    const base = found.kind === 'ok' ? found.text : null
    const next = change(base)
    if (next === null) return { result: 'invalid' }
    const done = replaceSettings(file, base, next, attempt === 0 ? between : undefined)
    if (done === 'unsafe') return { result: 'unsafe' }
    if (done === 'ok') return { result: 'ok', text: next }
  }
  throw new Error('the settings file kept changing while it was saved')
}

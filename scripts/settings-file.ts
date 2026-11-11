import { constants, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

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

// Replaces the file with `text`: the text goes to a new file beside it, which is then renamed over the
// path. A rename puts a file where the path is and never writes through what the path points to, so a
// link swapped in after the check is replaced, and its target is left alone. False, with nothing written,
// when the path is a link or not a regular file. `between` runs after the check and before the rename,
// for a test to swap the path there.
export const replaceSettings = (file: string, text: string, between?: () => void): boolean => {
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) return false
  } catch (error) {
    if (!isCode(error, ['ENOENT'])) throw error
  }
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(temp, text, { flag: 'wx' })
    between?.()
    renameSync(temp, file)
    return true
  } catch (error) {
    try { unlinkSync(temp) } catch {}
    throw error
  }
}

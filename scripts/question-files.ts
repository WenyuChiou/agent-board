import { readFileSync, readdirSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'

type FileWatcher = {
  on: (event: 'error' | 'close', listener: () => void) => unknown
  close: () => void
  unref: () => unknown
}
type WatchFiles = (directory: string, listener: (event: string, name: string | Buffer | null) => void) => FileWatcher

// Companion names bind immutable, validated contents. A live watcher makes unchanged files cheap;
// listings still find additions and removals, and actions or a failed watcher check every stamp.
export const immutableQuestionFiles = <T>(options: {
  directory: string
  isPersistent: boolean
  accepts: (name: string) => boolean
  parse: (text: string, name: string) => T | null
  watchFiles?: WatchFiles
}) => {
  const known = new Map<string, { stamp: string; value: T }>()
  const accepted = new Map<string, boolean>()
  const dirty = new Set<string>()
  let values: T[] = []
  let identity = ''
  let watcher: FileWatcher | null = null
  let hasFailed = false
  let isClosed = false
  let isUncertain = true
  const accepts = (name: string): boolean => {
    const previous = accepted.get(name)
    if (previous !== undefined) return previous
    const result = options.accepts(name)
    accepted.set(name, result)
    return result
  }
  const close = () => {
    const previous = watcher
    watcher = null
    previous?.close()
  }
  const invalidateAll = () => {
    known.clear()
    accepted.clear()
    dirty.clear()
    values = []
    isUncertain = true
  }
  const fail = () => {
    hasFailed = true
    invalidateAll()
    close()
  }
  const watchDirectory = () => {
    if (!options.isPersistent || isClosed || hasFailed || watcher !== null) return
    try {
      const current = (options.watchFiles ?? ((directory, listener) => watch(directory, listener)))(options.directory, (_event, name) => {
        if (name === null) isUncertain = true
        else if (accepts(String(name))) dirty.add(String(name))
      })
      watcher = current
      current.on('error', fail)
      current.on('close', () => { if (watcher === current) fail() })
      current.unref()
    } catch {
      fail()
    }
  }
  return {
    read: (isFresh = true): T[] | null => {
      try {
        // A renamed/replaced directory must not leave a watcher on its old inode.
        const directory = statSync(options.directory)
        const nextIdentity = `${directory.dev}:${directory.ino}:${directory.birthtimeMs}`
        if (identity !== nextIdentity) {
          close()
          invalidateAll()
          identity = nextIdentity
          hasFailed = false
        }
        watchDirectory()
        const names = readdirSync(options.directory)
        const listed = new Set(names)
        // Matching a stable name must not rebuild its path prefix on every poll. Forget absent
        // names so this cache stays bounded by the current directory, including unrelated files.
        for (const name of accepted.keys()) if (!listed.has(name)) accepted.delete(name)
        const next: T[] = []
        for (const name of names) {
          if (!accepts(name)) continue
          const previous = known.get(name)
          if (previous !== undefined && !isFresh && watcher !== null && !isUncertain && !dirty.has(name)) {
            next.push(previous.value)
            continue
          }
          const file = join(options.directory, name)
          const entry = statSync(file)
          const stamp = `${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}:${entry.ino}`
          if (previous === undefined || previous.stamp !== stamp || isUncertain || dirty.has(name)) {
            const parsed = options.parse(readFileSync(file, 'utf8'), name)
            if (parsed === null) {
              dirty.add(name)
              return null
            }
            // Validation of the same immutable name proves the previous value remains equivalent.
            known.set(name, { stamp, value: previous?.value ?? parsed })
          }
          const kept = known.get(name)
          if (kept === undefined) return null
          next.push(kept.value)
        }
        for (const name of known.keys()) if (!listed.has(name)) known.delete(name)
        dirty.clear()
        isUncertain = false
        if (values.length !== next.length || next.some((value, index) => value !== values[index])) values = next
        return values
      } catch {
        isUncertain = true
        return null
      }
    },
    invalidate: (name: string): void => { if (accepts(name)) dirty.add(name) },
    close: (): void => { isClosed = true; close() },
  }
}

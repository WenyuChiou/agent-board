import { readFileSync, readdirSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'

type FileWatcher = {
  on: (event: 'error' | 'close', listener: () => void) => unknown
  close: () => void
  unref: () => unknown
}
type WatchFiles = (directory: string, listener: (event: string, name: string | Buffer | null) => void) => FileWatcher
type InboxEntry = { name: string; at: number; body: string }

// The inbox is mutable. A watcher can spare unchanged display reads, but actions read fresh,
// listings still find changes, and unavailable watchers fall back to checking every stamp.
export const recentInboxFiles = (options: {
  directory: string
  isPersistent: boolean
  accepts: (name: string) => boolean
  watchFiles?: WatchFiles
}) => {
  const known = new Map<string, { stamp: string; at: number; body?: string }>()
  const dirty = new Set<string>()
  let identity = ''
  let watcher: FileWatcher | null = null
  let hasFailed = false
  let isClosed = false
  let isUncertain = true
  const close = () => {
    const previous = watcher
    watcher = null
    previous?.close()
  }
  const fail = () => {
    hasFailed = true
    isUncertain = true
    known.clear()
    close()
  }
  const watchDirectory = () => {
    if (!options.isPersistent || isClosed || hasFailed || watcher !== null) return
    try {
      const current = (options.watchFiles ?? ((directory, listener) => watch(directory, listener)))(options.directory, (_event, name) => {
        if (name === null) isUncertain = true
        else if (options.accepts(String(name))) dirty.add(String(name))
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
    read: (isFresh = true): InboxEntry[] => {
      try {
        const directory = statSync(options.directory)
        const nextIdentity = `${directory.dev}:${directory.ino}:${directory.birthtimeMs}`
        if (identity !== nextIdentity) {
          close()
          known.clear()
          dirty.clear()
          identity = nextIdentity
          isUncertain = true
          hasFailed = false
        }
        watchDirectory()
        const names = readdirSync(options.directory).filter(options.accepts)
        const listed = new Set(names)
        for (const name of known.keys()) if (!listed.has(name)) known.delete(name)
        for (const name of names) {
          const previous = known.get(name)
          if (!isFresh && watcher !== null && !isUncertain && !dirty.has(name) && previous !== undefined) continue
          try {
            const entry = statSync(join(options.directory, name))
            if (!entry.isFile()) { known.delete(name); continue }
            const stamp = `${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}:${entry.ino}`
            const body = !isFresh && !isUncertain && !dirty.has(name) && previous?.stamp === stamp ? previous.body : undefined
            known.set(name, { stamp, at: entry.mtimeMs, ...(body === undefined ? {} : { body }) })
          } catch {
            known.delete(name)
          }
        }
        const selected = names.filter(name => known.has(name)).sort((a, b) => known.get(b)!.at - known.get(a)!.at).slice(0, 30)
        const kept = new Set(selected)
        for (const [name, entry] of known) if (!kept.has(name)) delete entry.body
        const files: InboxEntry[] = []
        for (const name of selected) {
          const entry = known.get(name)!
          try {
            entry.body ??= readFileSync(join(options.directory, name), 'utf8')
            files.push({ name, at: entry.at, body: entry.body })
          } catch {
            delete entry.body
          }
        }
        dirty.clear()
        isUncertain = false
        return files
      } catch {
        isUncertain = true
        return []
      }
    },
    close: (): void => { isClosed = true; close() },
  }
}

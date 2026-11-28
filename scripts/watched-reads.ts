import { statSync, watch as fsWatch } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

// What the page server reads on an idle poll, kept while a folder watch says nothing changed (#254).
//
// One poll of the page read progress.md, the seen, hidden and question lists, the page state, the
// journal and three folder listings again, about 34 file operations, even when nothing had changed.
// Here a watch on each folder forgets a file when an event names it (every file of the folder on an
// event with no name), so an idle poll reads nothing. What a read gets is the file as it was when the
// last event for it arrived, the same as a read just before that write.
//
// The watch is not trusted alone. Each check() stats the folders and the stamp files (progress.md): a
// stamp that moved forgets every file, so a file added, removed, renamed over another or appended to
// shows on that poll. A folder replaced or removed is watched again from its new identity. A watch can
// set up fine and never report (WSL's /mnt/c, some network mounts): a stamp that moved with no event,
// and still none DEAF_AFTER_MS later, turns the cache off for good, and every read goes to the file as
// before. A watch error on a folder that is still there does the same. Only a missing file is kept as
// an answer; any other failure (a file another program holds) is read again next time, since no event
// says when it ends.

type Watcher = { on: (event: 'error' | 'close', listener: () => void) => unknown; close: () => void; unref?: () => unknown }
export type WatchFn = (directory: string, listener: (event: string, name: string | Buffer | null) => void) => Watcher

export const DEAF_AFTER_MS = 500
// The key of what was worked out from a folder's listing: any event in the folder can be a file added
// or removed, so every event forgets it.
const LISTING = '\0listing'

type Kept = { isOk: true; value: unknown } | { isOk: false; error: unknown }
type Folder = { files: Map<string, Map<string, Kept>>; watcher: Watcher | null; identity: string }

const codeOf = (error: unknown): string => (error as { code?: string } | null)?.code ?? 'error'

export type WatchedReads = {
  // Called before each poll's reads: compares the stamps and (re)arms the folder watches.
  check: () => void
  // The answer kept for this file and kind, or `look`'s, which is then kept. A file outside the
  // watched folders, or a cache that is off, always looks.
  get: <T>(file: string, kind: string, look: () => T) => T
  // What was worked out from a watched folder's listing, kept until any event in that folder.
  listing: <T>(directory: string, kind: string, look: () => T) => T
  // Forgets everything: this process wrote a file.
  clear: () => void
  isOn: () => boolean
  close: () => void
}

export const watchedReads = (options: { directories: readonly string[]; files: readonly string[]; watch?: WatchFn; now?: () => number }): WatchedReads => {
  const watch = options.watch ?? ((directory, listener) => fsWatch(directory, listener))
  const now = options.now ?? Date.now
  const folders = new Map<string, Folder>(options.directories.map(directory => [resolve(directory), { files: new Map(), watcher: null, identity: '' }]))
  let isOff = false
  let events = 0
  let eventsAtCheck = 0
  let lastStamp: string | null = null
  // A stamp that moved while no event came, and the events seen by then.
  let suspect: { at: number; events: number } | null = null

  const clear = (): void => { for (const folder of folders.values()) folder.files.clear() }
  const disarm = (folder: Folder): void => {
    const previous = folder.watcher
    folder.watcher = null
    folder.identity = ''
    folder.files.clear()
    try { previous?.close() } catch {}
  }
  const turnOff = (): void => {
    isOff = true
    for (const folder of folders.values()) disarm(folder)
  }
  const arm = (directory: string, folder: Folder, identity: string): void => {
    let current: Watcher
    try {
      current = watch(directory, (_event, name) => {
        if (folder.watcher !== current) return
        events += 1
        if (name === null || name === undefined) { folder.files.clear(); return }
        folder.files.delete(String(name))
        folder.files.delete(LISTING)
      })
    } catch (error) {
      // A folder removed between its stat and its watch is armed again on a later check.
      if (codeOf(error) !== 'ENOENT') turnOff()
      return
    }
    folder.watcher = current
    folder.identity = identity
    // A watch that ends while its folder is still there cannot be told from a deaf one.
    const ended = (): void => {
      if (folder.watcher !== current) return
      let isThere = true
      try { statSync(directory) } catch { isThere = false }
      if (isThere) turnOff()
      else disarm(folder)
    }
    current.on('error', ended)
    current.on('close', ended)
    current.unref?.()
  }
  const stampOf = (file: string): { identity: string; stamp: string } => {
    try {
      const entry = statSync(file, { bigint: true })
      const identity = `${entry.dev}:${entry.ino}`
      return { identity, stamp: `${identity}:${entry.mtimeNs}:${entry.ctimeNs}:${entry.size}` }
    } catch (error) {
      return { identity: '', stamp: codeOf(error) }
    }
  }
  const folderOf = (directory: string): Folder | undefined => {
    const folder = folders.get(resolve(directory))
    return isOff || folder?.watcher === null ? undefined : folder
  }
  const kept = <T>(folder: Folder | undefined, name: string, kind: string, look: () => T): T => {
    if (folder === undefined) return look()
    const found = folder.files.get(name)?.get(kind)
    if (found !== undefined) {
      if (found.isOk) return found.value as T
      throw found.error
    }
    const keep = (one: Kept): void => {
      let kinds = folder.files.get(name)
      if (kinds === undefined) { kinds = new Map(); folder.files.set(name, kinds) }
      kinds.set(kind, one)
    }
    try {
      const value = look()
      keep({ isOk: true, value })
      return value
    } catch (error) {
      if (codeOf(error) === 'ENOENT') keep({ isOk: false, error })
      throw error
    }
  }
  return {
    check: () => {
      if (isOff) return
      const stamps: string[] = []
      for (const [directory, folder] of folders) {
        const found = stampOf(directory)
        stamps.push(found.stamp)
        // A folder replaced or removed since it was armed: its watch sees the old one, if any.
        if (folder.watcher !== null && folder.identity !== found.identity) disarm(folder)
        if (folder.watcher === null && found.identity !== '') {
          // What was kept before the watch was set up was never covered by it.
          folder.files.clear()
          arm(directory, folder, found.identity)
          if (isOff) return
        }
      }
      for (const file of options.files) stamps.push(stampOf(file).stamp)
      const stamp = stamps.join('|')
      const at = now()
      if (lastStamp !== null && stamp !== lastStamp) {
        clear()
        if (events === eventsAtCheck && suspect === null) suspect = { at, events }
      }
      if (suspect !== null) {
        if (events > suspect.events) suspect = null
        else if (at - suspect.at >= DEAF_AFTER_MS) turnOff()
      }
      lastStamp = stamp
      eventsAtCheck = events
    },
    get: (file, kind, look) => kept(folderOf(dirname(file)), basename(file), kind, look),
    listing: (directory, kind, look) => kept(folderOf(directory), LISTING, kind, look),
    clear,
    isOn: () => !isOff && [...folders.values()].some(folder => folder.watcher !== null),
    close: turnOff,
  }
}

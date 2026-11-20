// The page server's file watch (#359): it wakes the page's open board request when progress.md or the
// inbox folder changes, so a hook event reaches the page without a timed poll.
//
// The folder that holds progress.md is watched, not the file: a writer that replaces the file (a temporary
// file renamed over it) would leave a watch on the old file deaf. Only names that start with progress.md's
// stem count there (progress.md, its temporary files, the inbox folder appearing). The inbox folder gets a
// watch of its own once it exists. On Windows fs.watch can report no file name: that counts as a change.
//
// A watch that cannot be set up, or that stops with an error (its folder removed, the system out of
// watches), is closed for good and isWatching() turns false; the server then checks on a timer instead.
// A watch can also set up fine and never report (WSL's /mnt/c, some network mounts): probe() stats the two paths,
// and a change it sees with no event for it, still none 500 ms later, counts as the watch stopping.
import { statSync, watch as fsWatch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname, extname } from 'node:path'

export type WatchFn = (path: string, listener: (event: string, name: string | Buffer | null) => void) => FSWatcher

export type BoardWatch = { isWatching: () => boolean; probe: () => void; close: () => void }

export const watchBoard = ({ progress, inbox, onChange, onFail, watch = fsWatch }: {
  progress: string
  inbox: string
  onChange: () => void
  // Called once, when the watch stops working; the caller falls back to its timer.
  onFail: () => void
  watch?: WatchFn
}): BoardWatch => {
  const folder = dirname(progress)
  const stem = basename(progress, extname(progress))
  const inboxName = basename(inbox)
  const watchers: FSWatcher[] = []
  let inboxWatcher: FSWatcher | null = null
  let isFailed = false
  let isClosed = false
  // Events seen, and the stamp of the two paths with the event count when it was taken.
  let events = 0
  const stampOf = (path: string): string => {
    try {
      const entry = statSync(path)
      return `${entry.mtimeMs}:${entry.size}:${entry.ino}`
    } catch (error) { return (error as NodeJS.ErrnoException).code ?? 'error' }
  }
  const stamp = (): string => `${stampOf(progress)}|${stampOf(inbox)}`
  let lastStamp = stamp()
  let eventsAtStamp = 0
  const closeAll = (): void => {
    for (const one of watchers.splice(0)) { try { one.close() } catch {} }
    inboxWatcher = null
  }
  const fail = (): void => {
    if (isFailed || isClosed) return
    isFailed = true
    closeAll()
    onFail()
  }
  const open = (path: string, listener: (name: string | null) => void): FSWatcher | null => {
    const one = watch(path, (_event, name) => { events += 1; listener(name === null || name === undefined ? null : String(name)) })
    one.on('error', fail)
    watchers.push(one)
    return one
  }
  // The inbox folder may not exist yet: its first file makes it, and the folder watch then arms it.
  const armInbox = (): void => {
    if (inboxWatcher !== null || isFailed || isClosed) return
    try { inboxWatcher = open(inbox, () => onChange()) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail()
    }
  }
  try {
    open(folder, name => {
      // The inbox folder keeps its own name whatever progress.md is called (a custom --progress-file).
      if (name !== null && !name.startsWith(stem) && name !== inboxName) return
      if (name === null || name === inboxName) armInbox()
      onChange()
    })
  } catch {
    fail()
    return { isWatching: () => false, probe: () => {}, close: () => { isClosed = true } }
  }
  armInbox()
  return {
    isWatching: () => !isFailed && !isClosed,
    probe: () => {
      if (isFailed || isClosed) return
      const now = stamp()
      const before = eventsAtStamp
      eventsAtStamp = events
      if (now === lastStamp) return
      lastStamp = now
      if (events !== before) return
      // An event can trail the write a little: only one still missing 500 ms on means the watch is deaf.
      setTimeout(() => { if (events === before) fail() }, 500).unref()
    },
    close: () => {
      isClosed = true
      closeAll()
    },
  }
}

import { closeSync, openSync, readSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import { RESUME } from '../hooks/parse'
import type { CodexMeta } from '../hooks/runs'

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_JSON_OBJECT')
  return value as Record<string, unknown>
}

// Who started a Codex session is in the first record of its history file (#399). Only the
// session's own file is opened: its name must be Codex's own form, rollout-<time>-<session id>.jsonl,
// with exactly this session's id after the time, so another session's file, or any other file a
// hook names, is never read. The file is read in pieces of 4 KiB until the piece that holds the
// first line break, so up to 4 KiB after that break is read into memory with it; only the bytes
// before the break are decoded, and of that record only four fields are kept: the first record is
// decoded whole and everything but those four fields is dropped, and no text from the rest of the
// file is ever decoded, looked at or kept. A path that is not the session's history file, or a
// record that is not readable, gives null and the session keeps its default.
const SESSION_FILE_TIME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/
export const readSessionMeta = (path: string, session: string): CodexMeta | null => {
  const name = basename(path)
  if (!SESSION_FILE_TIME.test(name) || name.replace(SESSION_FILE_TIME, '') !== `${session}.jsonl`) return null
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const piece = Buffer.alloc(4096)
    const line: Buffer[] = []
    let length = 0
    let offset = 0
    for (;;) {
      const size = readSync(fd, piece, 0, piece.length, offset)
      if (size === 0) break
      const end = piece.subarray(0, size).indexOf(0x0a)
      const used = end < 0 ? size : end
      line.push(Buffer.from(piece.subarray(0, used)))
      length += used
      offset += size
      if (end >= 0) break
      if (length >= 262144) return null
    }
    const first = object(JSON.parse(Buffer.concat(line).toString('utf8')))
    if (first.type !== 'session_meta') return null
    const meta = object(first.payload)
    const source = meta.source

    return {
      originator: typeof meta.originator === 'string' ? meta.originator.slice(0, 64) : undefined,
      // A helper's source names its parent and role; only the fact that it is a helper is kept.
      source: typeof source === 'string' ? source.slice(0, 64) : typeof source === 'object' && source !== null && 'subagent' in source ? { subagent: true } : undefined,
      thread_source: typeof meta.thread_source === 'string' ? meta.thread_source.slice(0, 64) : undefined,
      parent_thread_id: typeof meta.parent_thread_id === 'string' ? meta.parent_thread_id.slice(0, 128) : undefined,
    }
  } catch { return null } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

// Bound directory reads across the whole walk, including empty months and years.
// Only date folders and the exact session filename are considered, newest first.
export const findSessionFile = (codexHome: string, id: string): string | null => {
  if (!RESUME.test(id)) return null
  let reads = 0
  const entries = (path: string): Dirent[] => {
    if (reads >= 60) return []
    reads += 1
    try { return readdirSync(path, { withFileTypes: true }) } catch { return [] }
  }
  const folders = (path: string, pattern: RegExp): string[] => entries(path).filter(one => one.isDirectory() && pattern.test(one.name)).map(one => one.name).sort().reverse()
  const root = join(codexHome, 'sessions')
  for (const year of folders(root, /^\d{4}$/)) {
    for (const month of folders(join(root, year), /^\d{2}$/)) {
      for (const day of folders(join(root, year, month), /^\d{2}$/)) {
        const directory = join(root, year, month, day)
        const found = entries(directory).filter(one => one.isFile() && SESSION_FILE_TIME.test(one.name) && one.name.replace(SESSION_FILE_TIME, '') === `${id}.jsonl`).sort((a, b) => b.name.localeCompare(a.name))[0]
        if (found !== undefined) return join(directory, found.name)
        if (reads >= 60) return null
      }
      if (reads >= 60) return null
    }
    if (reads >= 60) return null
  }
  return null
}

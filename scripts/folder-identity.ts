import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

type FolderIdentity = { folderDigest: string; folderCanonicalDigest?: string }
type FolderBinding = { folderDigest?: unknown; folderCanonicalDigest?: unknown }
const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

// Preserve the old lexical digest; a fresh hook may add proof that aliases
// currently resolve to one directory without retaining either raw path.
export const folderIdentity = (cwd: unknown, platform = process.platform, canonicalize: (path: string) => string = realpathSync): FolderIdentity | undefined => {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
  const digest = (path: string): string => createHash('sha256').update(platform === 'win32' ? path.toLowerCase() : path).digest('hex')
  const path = resolve(cwd)
  const identity: FolderIdentity = { folderDigest: digest(path) }
  try { identity.folderCanonicalDigest = digest(canonicalize(path)) } catch { /* No alias proof: retain exact lexical compatibility only. */ }
  return identity
}

export const matchesFolderIdentity = (record: FolderBinding, current: FolderIdentity): boolean => {
  if (!isDigest(record.folderDigest)) return false
  // A present canonical binding must match; never fall back after a symlink
  // changes target, or when a canonical binding is malformed or unreadable.
  if (record.folderCanonicalDigest !== undefined) return isDigest(record.folderCanonicalDigest)
    && current.folderCanonicalDigest !== undefined && record.folderCanonicalDigest === current.folderCanonicalDigest
  return record.folderDigest === current.folderDigest
}

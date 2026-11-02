// Reads the board script out of the hooks/board-script*.ts files, as a checkout or a release tag holds them.
// Tags up to 0.24.0 hold it as one JSON string on one line; later ones as one JSON string per bundle line
// inside an array, so that pull requests changing different code merge (#573). Since #582 the lines are
// kept in parts (hooks/board-script-1.ts, -2.ts, ...), each under Claude Code's 1 MiB module limit, and
// hooks/board-script.ts only imports them. JSON allows the CR of a CRLF line ending between array entries,
// so either ending reads the same. Node built-ins only: bin/agent-board.mjs runs this under Node 22+ with
// no Bun. Read through readBundle (or bundleFromDir / bundleFromRef), which handle every form.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUNDLE_ENTRY = 'hooks/board-script.ts'
// The entry and its parts: one rule for every tool that must treat them as the generated bundle.
export const isBundleFile = path => /^hooks\/board-script(?:-\d+)?\.ts$/.test(path)

const marker = 'export const BOARD_SCRIPT = '
const linesMarker = 'export const LINES = '
const unsupported = (what = 'hooks/board-script.ts') => new Error(`${what} has an unsupported format`)

export const bundleCode = source => {
  const start = source.indexOf(marker)
  if (start === -1) throw unsupported()
  const encoded = source.slice(start + marker.length)
  if (encoded.startsWith('[...')) throw new Error('hooks/board-script.ts is kept in parts: read it with readBundle')
  const value = encoded.startsWith('[') ? JSON.parse(encoded.slice(0, encoded.lastIndexOf(']') + 1)) : JSON.parse(encoded)
  const code = Array.isArray(value) && value.every(line => typeof line === 'string') ? value.join('\n') : value
  if (typeof code !== 'string') throw unsupported()
  return code
}

// The part files the entry imports, in import order; empty for the one-line and per-line forms.
export const bundleParts = entrySource =>
  [...entrySource.matchAll(/^import \{ LINES as PART_\d+ \} from '\.\/(board-script-\d+)\.ts'\r?$/gm)].map(match => `hooks/${match[1]}.ts`)

export const partLines = source => {
  const start = source.indexOf(linesMarker)
  const open = start === -1 ? -1 : source.indexOf('[', start + linesMarker.length)
  if (open === -1) throw unsupported('a board script part')
  const lines = JSON.parse(source.slice(open, source.lastIndexOf(']') + 1))
  if (!Array.isArray(lines) || !lines.every(line => typeof line === 'string')) throw unsupported('a board script part')
  return lines
}

// `read` returns the text of a repository path such as hooks/board-script.ts; a missing file throws its own error.
export const readBundle = read => {
  const entry = read(BUNDLE_ENTRY)
  const parts = bundleParts(entry)
  return parts.length ? parts.flatMap(path => partLines(read(path))).join('\n') : bundleCode(entry)
}

const folderOf = dir => dir instanceof URL ? fileURLToPath(dir) : typeof dir === 'string' && dir.startsWith('file:') ? fileURLToPath(dir) : dir
export const bundleFromDir = dir => {
  const folder = folderOf(dir)
  return readBundle(path => readFileSync(join(folder, path), 'utf8'))
}
export const bundleFromRef = (cwd, ref) =>
  readBundle(path => execFileSync('git', ['show', `${ref}:${path}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))

// The entry and the parts it imports. A checkout with no entry yet lists the entry alone, so a caller that
// walks files still names it; it is the reader (readBundle) that fails on a missing file.
export const bundleFiles = dir => {
  const folder = folderOf(dir)
  let entry
  try {
    entry = readFileSync(join(folder, BUNDLE_ENTRY), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return [BUNDLE_ENTRY]
    throw error
  }
  return [BUNDLE_ENTRY, ...bundleParts(entry)]
}

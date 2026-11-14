import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, posix, resolve } from 'node:path'
import { clip } from '../hooks/mirror'
import { cutLine, oneLine } from '../hooks/step-words'

export const ANTIGRAVITY_TRANSCRIPTS = new Set(['transcript.jsonl', 'transcript_full.jsonl'])
export const ANTIGRAVITY_ROW_TITLE_WIDTH = 48

const MAX_SUMMARY_BYTES = 16 * 1024 * 1024
const MAX_TRANSCRIPT_HEAD_BYTES = 256 * 1024
const CLIENTS = ['antigravity', 'antigravity-cli', 'antigravity-ide'] as const
type ClientKind = typeof CLIENTS[number]

export type AntigravityTitleSource = 'summary' | 'prompt'
export type AntigravityTitleResult = { title: string; titleSource: AntigravityTitleSource }

const sanitizeTitle = (raw: string, clipWidth?: number): string | null => {
  const cleaned = oneLine(raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' '))
  if (cleaned === '') return null
  const sized = clipWidth === undefined ? cleaned : clip(cleaned, clipWidth)
  const bounded = cutLine(sized).text.trim()
  return bounded === '' ? null : bounded
}

// Read a regular file (never a symlink, directory, or FIFO) up to a byte cap.
const readRegularBytes = (filePath: unknown, maxBytes: number, allowHead = false): { bytes: Buffer; isTruncated: boolean } | null => {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) return null
  try {
    if (!lstatSync(filePath).isFile()) return null
    const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size <= 0) return null
      if (!allowHead && stat.size > maxBytes) return null
      const size = allowHead ? Math.min(stat.size, maxBytes) : stat.size
      const bytes = Buffer.alloc(size)
      if (readSync(fd, bytes, 0, size, 0) !== size) return null
      return { bytes, isTruncated: stat.size > size }
    } finally { closeSync(fd) }
  } catch { return null }
}

// Minimal bounds-checked protobuf wire reader for Antigravity summary files
// (`agyhub_summaries_proto.pb` and `jetbox_summaries_proto.pb`):
// root repeated field 1 -> entry { field 1: conversationId (utf8), field 2: { field 1: title (utf8) } }.
// Foreign conversation ids and titles are skipped by offset without decoding into strings.
export const findProtobufTitle = (buf: Buffer, conversationId: string): string | null => {
  if (conversationId === '') return null
  const targetBytes = Buffer.from(conversationId, 'utf8')
  let off = 0

  const readVarint = (limit: number): number => {
    let val = 0
    let factor = 1
    for (let i = 0; i < 8; i += 1) {
      if (off >= limit) return -1
      const byte = buf[off++]!
      val += (byte & 0x7f) * factor
      if (!Number.isSafeInteger(val)) return -1
      if ((byte & 0x80) === 0) return val
      factor *= 128
    }
    return -1
  }

  const skipVarint = (limit: number): boolean => {
    for (let i = 0; i < 10; i += 1) {
      if (off >= limit) return false
      if ((buf[off++]! & 0x80) === 0) return true
    }
    return false
  }

  const skipField = (wireType: number, limit: number): boolean => {
    if (wireType === 0) return skipVarint(limit)
    if (wireType === 1) {
      if (off + 8 > limit) return false
      off += 8
      return true
    }
    if (wireType === 2) {
      const len = readVarint(limit)
      if (len < 0 || off + len > limit) return false
      off += len
      return true
    }
    if (wireType === 5) {
      if (off + 4 > limit) return false
      off += 4
      return true
    }
    return false
  }

  const readTitleSpan = (limit: number): [number, number] | null => {
    let span: [number, number] | null = null
    while (off < limit) {
      const tag = readVarint(limit)
      if (tag < 0) return null
      const fn = Math.floor(tag / 8), wt = tag & 7
      if (fn === 0) return null
      if (fn === 1 && wt === 2) {
        const len = readVarint(limit)
        if (len < 0 || off + len > limit) return null
        span = [off, off + len]
        off += len
      } else if (!skipField(wt, limit)) {
        return null
      }
    }
    return span
  }

  while (off < buf.length) {
    const tag = readVarint(buf.length)
    if (tag < 0) return null
    const fn = Math.floor(tag / 8), wt = tag & 7
    if (fn === 0) return null
    if (fn === 1 && wt === 2) {
      const entryLen = readVarint(buf.length)
      if (entryLen < 0 || off + entryLen > buf.length) return null
      const entryEnd = off + entryLen
      let isMatch = false
      let titleSpan: [number, number] | null = null
      while (off < entryEnd) {
        const entryTag = readVarint(entryEnd)
        if (entryTag < 0) return null
        const efn = Math.floor(entryTag / 8), ewt = entryTag & 7
        if (efn === 0) return null
        if (efn === 1 && ewt === 2) {
          const idLen = readVarint(entryEnd)
          if (idLen < 0 || off + idLen > entryEnd) return null
          if (idLen === targetBytes.length && buf.subarray(off, off + idLen).equals(targetBytes)) isMatch = true
          off += idLen
        } else if (efn === 2 && ewt === 2) {
          const sumLen = readVarint(entryEnd)
          if (sumLen < 0 || off + sumLen > entryEnd) return null
          const sumEnd = off + sumLen
          const span = readTitleSpan(sumEnd)
          if (off !== sumEnd) return null
          if (span !== null) titleSpan = span
        } else if (!skipField(ewt, entryEnd)) {
          return null
        }
      }
      if (isMatch) {
        if (titleSpan === null) return null
        return sanitizeTitle(buf.subarray(titleSpan[0], titleSpan[1]).toString('utf8'))
      }
    } else if (!skipField(wt, buf.length)) {
      return null
    }
  }
  return null
}

export const findCliJsonTitle = (buf: Buffer, conversationId: string): string | null => {
  if (conversationId === '') return null
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const conversations = (parsed as { conversations?: unknown }).conversations
    if (typeof conversations !== 'object' || conversations === null || Array.isArray(conversations)) return null
    if (!Object.hasOwn(conversations, conversationId)) return null
    const entry = (conversations as Record<string, unknown>)[conversationId]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const summary = (entry as { summary?: unknown }).summary
    if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) return null
    const title = (summary as { Title?: unknown }).Title
    return typeof title === 'string' ? sanitizeTitle(title) : null
  } catch { return null }
}

export const clientLocationFromPath = (rawPath: unknown): { kind: ClientKind; clientDir: string } | null => {
  if (typeof rawPath !== 'string' || !isAbsolute(rawPath)) return null
  const slashed = rawPath.replace(/\\/g, '/')
  const uncPrefix = /^\/\/[^/]+\/[^/]+/.exec(slashed)?.[0] ?? ''
  const normalized = uncPrefix === '' ? posix.normalize(slashed) : `${uncPrefix}${posix.normalize(slashed.slice(uncPrefix.length) || '/')}`
  const rawParts = normalized.split('/')
  const lowerParts = rawParts.map(part => part.toLowerCase())
  for (let at = lowerParts.length - 2; at >= 0; at -= 1) {
    if (lowerParts[at] !== '.gemini') continue
    const candidate = lowerParts[at + 1]
    if (candidate === 'antigravity' || candidate === 'antigravity-cli' || candidate === 'antigravity-ide') {
      return { kind: candidate, clientDir: resolve(rawParts.slice(0, at + 2).join('/')) }
    }
  }
  return null
}

const candidateDirs = (transcriptPath: unknown, artifactPath: unknown, home: string): Array<{ kind: ClientKind; dir: string }> => {
  const fromPath = clientLocationFromPath(transcriptPath) ?? clientLocationFromPath(artifactPath)
  const result: Array<{ kind: ClientKind; dir: string }> = []
  const seen = new Set<string>()
  const push = (kind: ClientKind, dir: string): void => {
    const resolved = resolve(dir)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) return
    seen.add(key)
    result.push({ kind, dir: resolved })
  }
  if (fromPath !== null) {
    push(fromPath.kind, fromPath.clientDir)
    push(fromPath.kind, join(home, '.gemini', fromPath.kind))
  }
  for (const kind of CLIENTS) push(kind, join(home, '.gemini', kind))
  return result
}

const readClientSummaryTitle = (kind: ClientKind, dir: string, conversationId: string): string | null => {
  const sources: Array<{ file: string; parse: (buf: Buffer, id: string) => string | null }> = kind === 'antigravity-cli'
    ? [
        { file: join(dir, 'jetbox_summaries_proto.pb'), parse: findProtobufTitle },
        { file: join(dir, 'cache', 'conversation_metadata.json'), parse: findCliJsonTitle },
      ]
    : [{ file: join(dir, 'agyhub_summaries_proto.pb'), parse: findProtobufTitle }]

  for (const source of sources) {
    const read = readRegularBytes(source.file, MAX_SUMMARY_BYTES)
    if (read === null) continue
    const title = source.parse(read.bytes, conversationId)
    if (title !== null) return title
  }
  return null
}

// Antigravity transcripts wrap the explicit prompt in `<USER_REQUEST>...</USER_REQUEST>` followed
// by `<ADDITIONAL_METADATA>...`; unwrap top-level framing so line 1 names the request, not the tag.
const firstPromptLine = (content: string): string => {
  let body = content.replace(/^\s*(?:<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>\s*)*(?=<USER_REQUEST>(?:\r?\n|\s|$))/, '')
  const open = body.match(/^\s*<USER_REQUEST>(?:\r?\n|\s*)/)
  if (open) {
    body = body.slice(open[0].length).replace(/\s*<\/USER_REQUEST>(?:\s*<ADDITIONAL_METADATA>[\s\S]*)?$/, '')
  }
  return body.split(/\r?\n/).find(one => one.trim() !== '') ?? ''
}

const SESSION_ID_SEGMENT = /^(?!\.\.?$)[^\\/\0]+$/
const SESSION_TRANSCRIPT_REL_PATHS: ReadonlyArray<readonly string[]> = [
  ['transcript.jsonl'],
  ['transcript_full.jsonl'],
  ['.system_generated', 'logs', 'transcript.jsonl'],
  ['.system_generated', 'logs', 'transcript_full.jsonl'],
]
const sameNormalizedPath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

// Only read a transcript that resolves directly under this session's own
// `<home>/.gemini/<client>/brain/<conversationId>/` folder, never symlinks or foreign paths.
export const isSessionAntigravityTranscript = (
  transcriptPath: unknown,
  conversationId: string,
  home: string,
): transcriptPath is string => {
  if (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath) || !ANTIGRAVITY_TRANSCRIPTS.has(basename(transcriptPath))) return false
  if (!SESSION_ID_SEGMENT.test(conversationId) || !isAbsolute(home)) return false
  try {
    if (!lstatSync(transcriptPath).isFile()) return false
    const realFile = realpathSync.native(transcriptPath)
    for (const client of CLIENTS) {
      try {
        const realBrain = realpathSync.native(join(home, '.gemini', client, 'brain', conversationId))
        if (SESSION_TRANSCRIPT_REL_PATHS.some(rel => sameNormalizedPath(realFile, join(realBrain, ...rel)))) return true
      } catch { /* missing client brain directory */ }
    }
    return false
  } catch { return false }
}

// Read the first USER_INPUT line from the start of the conversation's own transcript.jsonl,
// bounded and read-only, clipped to row display width. Never reads hook stdin prompt fields.
export const readAntigravityFirstPrompt = (
  transcriptPath: unknown,
  conversationId: string,
  home: string,
): string | null => {
  if (!isSessionAntigravityTranscript(transcriptPath, conversationId, home)) return null
  const read = readRegularBytes(transcriptPath, MAX_TRANSCRIPT_HEAD_BYTES, true)
  if (read === null) return null
  try {
    const text = read.bytes.toString('utf8')
    const lines = text.split(/\r?\n/)
    if (read.isTruncated) lines.pop()
    for (const line of lines) {
      if (line.trim() === '') continue
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      const entry = parsed as Record<string, unknown>
      if (entry.type !== 'USER_INPUT') continue
      if (typeof entry.content !== 'string') return null
      return sanitizeTitle(firstPromptLine(entry.content), ANTIGRAVITY_ROW_TITLE_WIDTH)
    }
    return null
  } catch { return null }
}

export const resolveAntigravityTitle = (
  conversationId: string,
  transcriptPath: unknown,
  artifactPath: unknown,
  home: string,
): AntigravityTitleResult | null => {
  for (const { kind, dir } of candidateDirs(transcriptPath, artifactPath, home)) {
    const title = readClientSummaryTitle(kind, dir, conversationId)
    if (title !== null) return { title, titleSource: 'summary' }
  }
  const promptTitle = readAntigravityFirstPrompt(transcriptPath, conversationId, home)
  return promptTitle === null ? null : { title: promptTitle, titleSource: 'prompt' }
}

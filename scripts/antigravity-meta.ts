import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, posix, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import { clip } from '../hooks/mirror'
import { agentClaimOf } from '../hooks/session-liveness'
import type { AgentClaim } from '../hooks/session-liveness'
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

const isKnownTranscript = (path: unknown): path is string =>
  typeof path === 'string' && isAbsolute(path) && ANTIGRAVITY_TRANSCRIPTS.has(basename(path))
const MAX_ACK_READ_BYTES = 8 * 1024 * 1024

// The transcript's size when the turn-start hook hands a message over: the model's replies to it come after this
// offset (#1416). A transcript not written yet reads as 0; an unknown or unreadable path as null.
export const antigravityTranscriptSize = (path: unknown): number | null => {
  if (!isKnownTranscript(path)) return null
  try { const stat = lstatSync(path); return stat.isFile() ? stat.size : null } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null
  }
}

const ACK_READ_CHUNK_BYTES = 256 * 1024
type TranscriptEntry = { type?: unknown; source?: unknown; status?: unknown; content?: unknown }
const entryOf = (line: string): TranscriptEntry | null => {
  if (line.trim() === '') return null
  try {
    const entry: unknown = JSON.parse(line)
    return typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry as TranscriptEntry : null
  } catch { return null }
}

// Whether the turn's own input is already in the transcript at a hand-over (#1622): true when the last USER_INPUT or model
// entry in the last 256 KiB before `size` is a USER_INPUT, since nothing of a new turn but its input can come before its
// first invocation; false when it is a model entry (the turn's input is still to come); null when the file cannot be read
// or holds neither. A hand-over at a later invocation of a turn knows its input is in without reading.
export const antigravityInputIsIn = (path: unknown, size: number): boolean | null => {
  if (!isKnownTranscript(path) || !Number.isSafeInteger(size) || size <= 0) return null
  try {
    if (!lstatSync(path).isFile()) return null
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size < size) return null
      const start = Math.max(0, size - MAX_TRANSCRIPT_HEAD_BYTES)
      const bytes = Buffer.alloc(size - start)
      if (readSync(fd, bytes, 0, bytes.length, start) !== bytes.length) return null
      let text = bytes.toString('utf8')
      if (start > 0) text = text.slice(text.indexOf('\n') + 1)
      let isIn: boolean | null = null
      for (const line of text.split(/\r?\n/)) {
        const entry = entryOf(line)
        if (entry === null) continue
        if (entry.type === 'USER_INPUT') isIn = true
        else if (entry.source === 'MODEL') isIn = false
      }
      return isIn
    } finally { closeSync(fd) }
  } catch { return null }
}
const replyFirstLine = ({ type, source, content }: TranscriptEntry): string | null =>
  source === 'MODEL' && type === 'PLANNER_RESPONSE' && typeof content === 'string' && content.trim() !== '' ? content.split(/\r?\n/)[0]!.trim() : null

// The first line of each model reply, read from the conversation's own transcript, because the turn-end hook does not
// carry the reply text (#1416). With `from` (the size at the hand-over, still within the file), the replies of the turn
// that hand-over started count, read forward from it up to 8 MiB, so a long turn after the ACK line does not push it out
// of reach. That turn ends at the first USER_INPUT after one of its replies, or at the second USER_INPUT after `from`
// (the turn's own input may be written after the hand-over), so a later turn citing the code never counts, even for a
// claim a Stop could not read and kept. With `isInputIn` (the hand-over found the turn's input already written, #1622),
// the first USER_INPUT after `from` ends the turn, so a turn with no reply never reads the next turn's. Without `from`, or when the file is now shorter, only the last turn's replies
// (after its last USER_INPUT) in the last 256 KiB count.
// Only the reply's own first line is returned (a blank first line stays blank, so an ACK on the line after it does not
// count), and only for a regular file under one of the known transcript names; a line that is not JSON is skipped.
// A path that is missing, unknown or cannot be read returns null, so the caller can keep its claims.
export const antigravityReplyFirstLines = (path: unknown, from?: number, isInputIn = false): string[] | null => {
  if (!isKnownTranscript(path)) return null
  try {
    if (!lstatSync(path).isFile()) return null
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return null
      if (from !== undefined && from <= stat.size) {
        const replies: string[] = []
        const decoder = new StringDecoder('utf8')
        let position = from, carry = '', inputs = 0, isTurnEnded = false
        const take = (line: string): void => {
          const entry = entryOf(line)
          if (entry === null) return
          if (entry.type === 'USER_INPUT') {
            inputs += 1
            if (replies.length > 0 || isInputIn || inputs > 1) isTurnEnded = true
            return
          }
          const first = replyFirstLine(entry)
          if (first !== null) replies.push(first)
        }
        while (!isTurnEnded && position < stat.size && position - from < MAX_ACK_READ_BYTES) {
          const size = Math.min(ACK_READ_CHUNK_BYTES, stat.size - position, from + MAX_ACK_READ_BYTES - position)
          const bytes = Buffer.alloc(size)
          if (readSync(fd, bytes, 0, size, position) !== size) return null
          position += size
          const lines = (carry + decoder.write(bytes)).split(/\r?\n/)
          carry = lines.pop() ?? ''
          for (const line of lines) { take(line); if (isTurnEnded) break }
        }
        // The file's last line may have no line break; a line cut at the 8 MiB limit is not read.
        if (!isTurnEnded && position >= stat.size) take(carry + decoder.end())
        return replies
      }
      const start = Math.max(0, stat.size - MAX_TRANSCRIPT_HEAD_BYTES)
      const size = stat.size - start
      if (size <= 0) return []
      const bytes = Buffer.alloc(size)
      if (readSync(fd, bytes, 0, size, start) !== size) return null
      let text = bytes.toString('utf8')
      // A read that starts inside the file starts mid-line.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1)
      let replies: string[] = []
      for (const line of text.split(/\r?\n/)) {
        const entry = entryOf(line)
        if (entry === null) continue
        if (entry.type === 'USER_INPUT') replies = []
        else {
          const first = replyFirstLine(entry)
          if (first !== null) replies.push(first)
        }
      }
      return replies
    } finally { closeSync(fd) }
  } catch { return null }
}

export const MARK_PREFIX = 'AGENT_BOARD_REPORT_V1 '
const OUTPUT_HEADER = 'Command output:\n'
// The marked lines of reports agy's terminal sandbox refused (#1384), from the conversation's own transcript only. agy
// keeps a command's output in a finished GENERIC entry of the model's, after its "Command output:" header; a marked line
// anywhere else (a reply, a prompt, a command's own text) is counted in `stray` and not returned. With `from` (where the
// last read ended, still within the file) it reads forward up to 8 MiB; without it, or when the file is now shorter, the
// last 256 KiB. Only whole lines are read, and `end` is where the next read starts. null when the file is not this
// conversation's transcript or cannot be read.
export const antigravityMarkedLines = (path: unknown, conversationId: string, home: string, from?: number): { lines: string[]; stray: number; end: number } | null => {
  if (!isSessionAntigravityTranscript(path, conversationId, home)) return null
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return null
      const isForward = from !== undefined && from <= stat.size
      const start = isForward ? from : Math.max(0, stat.size - MAX_TRANSCRIPT_HEAD_BYTES)
      const size = Math.min(stat.size - start, isForward ? MAX_ACK_READ_BYTES : MAX_TRANSCRIPT_HEAD_BYTES)
      const bytes = Buffer.alloc(size)
      if (size > 0 && readSync(fd, bytes, 0, size, start) !== size) return null
      // A read that starts inside the file starts mid-line; a last line with no line break may still be written.
      const first = !isForward && start > 0 ? bytes.indexOf(0x0a) + 1 : 0
      const last = bytes.lastIndexOf(0x0a)
      if (first === 0 && start > 0 && !isForward || last < first) return { lines: [], stray: 0, end: start + first }
      const lines: string[] = []
      let stray = 0
      for (const line of bytes.subarray(first, last + 1).toString('utf8').split(/\r?\n/)) {
        if (!line.includes(MARK_PREFIX.trim())) continue
        const entry = entryOf(line)
        const content = typeof entry?.content === 'string' ? entry.content.replace(/\r\n/g, '\n') : ''
        const header = content.indexOf(OUTPUT_HEADER)
        const isOutput = entry?.source === 'MODEL' && entry.type === 'GENERIC' && entry.status === 'DONE' && (header === 0 || header > 0 && content[header - 1] === '\n')
        const found = isOutput ? content.slice(header + OUTPUT_HEADER.length).split('\n').filter(one => one.startsWith(MARK_PREFIX)) : []
        lines.push(...found)
        if (found.length === 0) stray += 1
      }
      return { lines, stray, end: start + last + 1 }
    } finally { closeSync(fd) }
  } catch { return null }
}

export type ProcEntry = { ppid: number; startTicks: number; comm: string; exe: string | null; cmdline?: string[] }

// Parse Linux `/proc/<pid>/stat` safely around process names that contain spaces or `)`.
export const parseLinuxProcStat = (text: string): { ppid: number; startTicks: number } | null => {
  if (!/^\d+\s+\(/.test(text)) return null
  const end = text.lastIndexOf(')')
  if (end < 0 || !/^\s/.test(text.slice(end + 1))) return null
  const fields = text.slice(end + 1).trim().split(/\s+/)
  const ppid = Number(fields[1])
  const startTicks = Number(fields[19])
  if (!Number.isSafeInteger(ppid) || ppid < 0) return null
  if (!Number.isSafeInteger(startTicks) || startTicks <= 0) return null
  return { ppid, startTicks }
}

const SHARED_ANTIGRAVITY_DAEMONS = new Set(['language_server', 'antigravity', 'electron', 'code'])
const stripExecutableName = (value: string): string =>
  posix.basename(value.replace(/ \(deleted\)$/, '')).toLowerCase().replace(/\.exe$/, '')

// Walk upward from a Linux hook worker without spawning, stopping on shared daemons.
export const findAgyProcess = (
  startPid: number,
  readProc: (pid: number) => ProcEntry | null,
  maxSteps = 16,
): { pid: number; startTicks: number } | null => {
  const seen = new Set<number>()
  let pid = startPid
  for (let step = 0; step < maxSteps && Number.isSafeInteger(pid) && pid > 1; step += 1) {
    if (seen.has(pid)) return null
    seen.add(pid)
    const entry = readProc(pid)
    if (entry === null) return null
    const comm = entry.comm.trim().toLowerCase()
    const exeBase = entry.exe === null ? null : stripExecutableName(entry.exe)
    if (SHARED_ANTIGRAVITY_DAEMONS.has(comm) || comm.startsWith('language_server')
      || (exeBase !== null && (SHARED_ANTIGRAVITY_DAEMONS.has(exeBase) || exeBase.startsWith('language_server')))) {
      return null
    }
    if (comm === 'agy' && exeBase === 'agy') return { pid, startTicks: entry.startTicks }
    pid = entry.ppid
  }
  return null
}

const readLinuxProc = (pid: number): ProcEntry | null => {
  try {
    const stat = parseLinuxProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    if (stat === null) return null
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf8')
    let exe: string | null = null
    try { exe = readlinkSync(`/proc/${pid}/exe`) } catch {}
    return { ppid: stat.ppid, startTicks: stat.startTicks, comm, exe }
  } catch { return null }
}

// Record the owning `agy` CLI process on Linux without spawning a subprocess (#1589).
export const antigravityProcessClaim = (host: string | null, startPid = process.ppid): AgentClaim | null => {
  if (process.platform !== 'linux' || host === null) return null
  const found = findAgyProcess(startPid, readLinuxProc)
  if (found === null) return null
  let started: number | undefined
  try {
    const self = parseLinuxProcStat(readFileSync(`/proc/${process.pid}/stat`, 'utf8'))
    if (self !== null) {
      const estimated = Math.round(performance.timeOrigin + (found.startTicks - self.startTicks) * 10)
      if (Number.isSafeInteger(estimated) && estimated > 0) started = estimated
    }
  } catch {}
  return agentClaimOf({ agentPid: found.pid, ...(started === undefined ? {} : { agentStarted: started }), host })
}

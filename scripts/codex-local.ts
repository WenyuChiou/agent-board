import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { installCommand, installContext } from './setup-command.mjs'
import { newestUse } from './setup-discovery.mjs'
import { blockClaimOf, blockHostOf, boardConfirmedReport, claimText, cleanAntigravityIdentity, codexClaimOf, codexEvent, codexEvents, codexReport, dropCodexBlock, folderProject, isLifecycleStep, limitReport, localAgentLifecycleStep, planReport, hookParentClaim, putCodexBlock, questionSteps, resolveAntigravityIdentity, seenClaimOf, sessionTitle, validateCodexReport } from '../hooks/codex'
import type { AntigravityIdentity, CodexReport } from '../hooks/codex'
import { hermesHome } from '../hooks/hermes-home'
import { agentHooks, BOARD_FOR, editHermesSetup, isReleased, readConfig } from '../hooks/connect-pure'
import type { Strings } from '../hooks/i18n'
import { STRINGS } from '../hooks/strings'
import { parseProgress, STALE_MS } from '../hooks/parse'
import { codexProcessClaim, readingHostHash } from './session-liveness'
import { reporterTail } from './reporter-tail'
import { othersNote } from '../hooks/others'
import { cleanSignal, codexSignal, isStrongRun, pickParent, withSignal } from '../hooks/runs'
import type { RunSignal } from '../hooks/runs'
import { antigravitySidecarConfig, antigravitySidecarSource, ANTIGRAVITY_SIDECAR_ID } from '../hooks/antigravity-sidecar'
import { antigravityCommand, antigravityHooks, cursorEvent, cursorEvents, hookCommandArgs, lifecycleCapability, localAgents, opencodePlugin, planEvents, planPlugins, statusEvents, windowsHookCommand } from '../hooks/local-agents'
import type { LocalAgent } from '../hooks/local-agents'
import type { AgentClaim } from '../hooks/session-liveness'
import { deepseekLocalPlugin, deepseekPatch, openclawLocalPlugin } from '../hooks/portable-agents'
import { BACKGROUND_TURN_ENV, HOOK_SESSION_ENV, HOOK_VERSION, hookWorker, hostHookTimeout } from '../hooks/hook-safety'
import { discoverCodexBinary, inspectCodexConfigToml, trustCodex } from './codex-host'
import { withLocalLock } from './local-lock'
import { installControlRoot, withInstallLock } from './install-control'
import { ConnectTransaction } from './connect-transaction'
import { boardPromptHelper, boardRequestWords, boardRun, deliveryRequestWords, isBoardRequest } from '../hooks/board-commands'
import { PROMPT_EVENTS } from '../hooks/inbox'
import { hookProgram, windowsHookNode } from './windows-hook-node'
import { claimHookRecovery } from './hook-recovery-owner'
import { findSessionFile, readSessionMeta } from './codex-history'
import { RELEASED } from '../hooks/released'
import { deliveryText, SURFACE_IDS } from '../hooks/messaging'
import { antigravitySurface, deliverAntigravityStopWait, deliverTurnEvent } from './hook-delivery'
import { checkStoreFile, hookMailbox } from './board-messaging'
import { defaultMessagesDirectory } from './runtime-folder'
import { folderIdentity, matchesFolderIdentity } from './folder-identity'
import { appendJournal, journalLine, journalPath } from '../hooks/journal'
import { currentPart } from '../hooks/retention'
import { lastQuestion } from '../hooks/digest'
import { antigravityMarkedLines, antigravityProcessClaim, ANTIGRAVITY_TRANSCRIPTS, MARK_PREFIX, resolveAntigravityTitle } from './antigravity-meta'

type Json = Record<string, unknown>
type Manifest = { files: Record<string, string>; groups: Record<string, unknown>; foreignGroups: Record<string, unknown> }

// Only Codex's known trust fields establish ownership of a whole table.
export const removeCodexTrustEntries = (text: string, keys: string[]): { text: string; removed: number } => {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const normalized = (key: string): string => process.platform === 'win32' ? key.toLowerCase() : key
  const owned = new Set(keys.map(normalized))
  const sections: { start: number; end: number; header: string }[] = []
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index]!.trim()
    if (!header.startsWith('[')) continue
    if (sections.length) sections[sections.length - 1]!.end = index
    sections.push({ start: index, end: lines.length, header })
  }
  const deleted = new Set<number>()
  let removed = 0
  const drop = (section: typeof sections[number]): void => {
    let end = section.end
    if (end < lines.length && lines[end - 1]!.trim() === '') end--
    for (let index = section.start; index < end; index++) deleted.add(index)
    // Codex appends tables with a separating blank line.
    if (section.start > 0 && lines[section.start - 1]!.trim() === '') deleted.add(section.start - 1)
  }
  for (const section of sections) {
    const match = /^\[hooks\.state\.(?:'([^']*)'|"((?:[^"\\]|\\[\\"])*)")\]$/.exec(section.header)
    if (!match) continue
    const key = match[1] ?? match[2]!.replace(/\\([\\"])/g, '$1')
    if (!owned.has(normalized(key))) continue
    if (!lines.slice(section.start + 1, section.end).every(line => /^\s*(?:(?:trusted_hash|enabled)\s*=[^\r\n]*)?\s*$/.test(line))) continue
    drop(section)
    removed++
  }
  if (removed && !sections.some(section => section.header.startsWith('[hooks.state.') && !deleted.has(section.start))) {
    for (const section of sections) if (section.header === '[hooks.state]' && lines.slice(section.start + 1, section.end).every(line => line.trim() === '')) drop(section)
  }
  return { text: lines.filter((_, index) => !deleted.has(index)).join(''), removed }
}

const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
// A report agy's terminal sandbox refuses is printed as one marked line, which agy keeps with the command's output in the
// conversation's transcript, for the conversation's next hook to bring in (#1384): the conversation, the board it was
// for, the report's time, the size and digest of its JSON, and the JSON compressed. The whole line is at most 4096 bytes
// and is read whole; the JSON is at most what the report command reads from its input.
const MARK_LIMIT = 4096
const MARK_INPUT_LIMIT = 1024 * 1024
const MARK_MAX_AGE = 24 * 60 * 60 * 1000
const MARK_LINE = /^AGENT_BOARD_REPORT_V1 ([a-zA-Z0-9][a-zA-Z0-9_-]{5,127}) ([0-9a-f]{16}) (\d{1,15}) (\d{1,7}) ([0-9a-f]{16}) ([A-Za-z0-9_-]+)$/
// Only the board Antigravity's setup recorded keeps a refused report, named by that exact path: the hook's own command
// gives it to the hook and to the report command it hands the model, so both name it alike with no lookup of the path
// that could answer two ways. Another spelling, a board setup did not record, or a folder that is not there names
// none, so no line is printed or read for it (#1384).
const boardOf = (progress: string, recorded: unknown): string | undefined => {
  if (typeof recorded !== 'string' || resolve(recorded) !== progress) return undefined
  try { if (!statSync(dirname(progress)).isDirectory()) return undefined } catch { return undefined }
  return hash(`board:${progress}`).slice(0, 16)
}
const markLine = (session: string, board: string, at: number, raw: Json): string | undefined => {
  const text = Buffer.from(JSON.stringify(raw))
  const line = `${MARK_PREFIX}${session} ${board} ${at} ${text.length} ${hash(text).slice(0, 16)} ${deflateRawSync(text).toString('base64url')}`
  return text.length <= MARK_INPUT_LIMIT && Buffer.byteLength(line) <= MARK_LIMIT ? line : undefined
}
const readMark = (line: string): { session: string; board: string; at: number; raw: Json } | undefined => {
  const match = line.length <= MARK_LIMIT ? MARK_LINE.exec(line) : null
  if (match === null) return undefined
  try {
    const size = Number(match[4])
    if (size > MARK_INPUT_LIMIT) return undefined
    const text = inflateRawSync(Buffer.from(match[6]!, 'base64url'), { maxOutputLength: Math.max(1, size) })
    if (text.length !== size || hash(text).slice(0, 16) !== match[5]) return undefined
    const raw: unknown = JSON.parse(text.toString('utf8'))
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { session: match[1]!, board: match[2]!, at: Number(match[3]), raw: raw as Json } : undefined
  } catch { return undefined }
}
// The plan a report applies. A mirrored plan keeps the block's own title, unless it is still the generic or fallback one
// a lifecycle event wrote. A refused Antigravity report is checked with the same plan its replay applies (#1384).
const isGenericTitleOf = (agent: string, title: string): boolean => Object.values(STRINGS).some(one => [one.codexTask, one.localAgentTask(agent)].includes(title) || title.startsWith(`${one.localAgentTask(agent)} · `))
const reportPlan = (payload: Json, previous: CodexReport | null, agent: string): Json => typeof payload.planTitle !== 'string' ? payload : {
  state: payload.state, steps: payload.steps,
  title: previous !== null && !isGenericTitleOf(agent, previous.title) && previous.titleSource !== 'fallback' ? previous.title : payload.planTitle,
  ...(typeof payload.planProject === 'string' ? { project: previous?.project ?? payload.planProject } : {}),
}
// A file is plain when its bytes survive a read as UTF-8 and a write back. One that does not (a lone FF, Big5) would
// come back as EF BF BD, so setup refuses it instead of rewriting it (#1607).
export const isPlain = (bytes: Buffer): boolean => Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)

// Antigravity hooks name their own transcript but do not carry the reply text.
// agy 1.5.2 names transcript_full.jsonl, which has the same line shape as transcript.jsonl.
const antigravityQuestion = (path: unknown): string | null => {
  if (typeof path !== 'string' || !isAbsolute(path) || !ANTIGRAVITY_TRANSCRIPTS.has(basename(path))) return null
  try {
    if (!lstatSync(path).isFile()) return null
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return null
      const size = Math.min(stat.size, 256 * 1024), start = stat.size - size
      const bytes = Buffer.alloc(size)
      if (readSync(fd, bytes, 0, size, start) !== size) return null
      let text = bytes.toString('utf8')
      if (start > 0) {
        const end = text.indexOf('\n')
        if (end < 0) return null
        text = text.slice(end + 1)
      }
      let reply: string | null = null
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue
        const item: unknown = JSON.parse(line)
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
        const entry = item as Json
        if (typeof entry.source !== 'string' || typeof entry.type !== 'string') return null
        if (entry.type === 'USER_INPUT') reply = null
        else if (entry.source === 'MODEL' && entry.type === 'PLANNER_RESPONSE') {
          if (entry.content !== undefined && typeof entry.content !== 'string') return null
          if (typeof entry.content === 'string' && entry.content.trim() !== '') reply = entry.content
          else if (entry.content === undefined) reply = null
        }
      }
      return reply === null ? null : lastQuestion(reply)
    } finally { closeSync(fd) }
  } catch { return null }
}

const pad2 = (value: number): string => String(value).padStart(2, '0')
const pad3 = (value: number): string => String(value).padStart(3, '0')

// A start time a person can read, in local time to the millisecond (#814).
// Second precision is not enough: two sessions started in the same second
// would share a title. The millisecond part keeps back-to-back starts apart
// without showing any hash, id or path on a default view.
const distinctStarted = (at: number): string => {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${pad3(date.getMilliseconds())}`
}

// Recover the original millisecond start time encoded in a pre-#1401 generic local task title
// ("Local antigravity task · YYYY-MM-DD HH:MM:SS.mmm") so upgrading never resets Started times.
const legacyStartedAt = (title: string, agent: LocalAgent): number | undefined => {
  const prefix = Object.values(STRINGS).map(one => `${one.localAgentTask(agent)} · `).find(text => title.startsWith(text))
  if (prefix === undefined) return undefined
  const stamp = title.slice(prefix.length)
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(stamp)
  if (match === null) return undefined
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7])).getTime()
  return Number.isFinite(at) && distinctStarted(at) === stamp ? at : undefined
}
const readBytes = (file: string): Buffer | null => {
  try { return readFileSync(file) } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  }
}
const readLocal = (file: string): string | null => readBytes(file)?.toString('utf8') ?? null
// What setup saw at a path when it planned (#1488): the kind of the path itself (lstat follows no link), a link's
// target, and the bytes read through it. Decoded text is not enough to compare later: bytes that decode alike
// (EF BF BD and FF) would pass, and a dangling link would read as a missing file. lstat sees the last part of the
// path only: a folder above it swapped for a link is not caught. `real` is the path's real path while it resolves (the OS
// settles letter case, relative link targets and link chains), so a removal can tell a file this batch removed from one
// another program removed; it is not compared.
type Snap = { kind: 'none' | 'file' | 'link' | 'other'; link: string | null; bytes: Buffer | null; real: string | null }
const NO_PATH: Snap = { kind: 'none', link: null, bytes: null, real: null }
const take = (file: string): Snap => {
  let kind: Snap['kind']
  try {
    const stat = lstatSync(file)
    kind = stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : 'other'
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return NO_PATH
    throw error
  }
  let real: string | null = null
  try { real = realpathSync.native(file) } catch {}
  return { kind, link: kind === 'link' ? readlinkSync(file) : null, bytes: readBytes(file), real }
}
const sameBytes = (a: Buffer | null, b: Buffer | null): boolean => a === null || b === null ? a === b : a.equals(b)
const same = (a: Snap, b: Snap): boolean => a.kind === b.kind && a.link === b.link && sameBytes(a.bytes, b.bytes)

// The repository name in a remote's address: `demo` from `https://host/x/demo.git` or `git@host:x/demo.git`.
// `origin` when there is one, else the first remote; only that section's own `url` counts.
const remoteName = (config: string): string => {
  const remotes = config.split(/^(?=\s*\[)/m).filter(section => /^\s*\[remote\s/.test(section))
  const remote = remotes.find(section => /^\s*\[remote\s+"origin"\s*\]/.test(section)) ?? remotes[0] ?? ''
  const rawUrl = /^\s*url[ \t]*=[ \t]*(.+?)\s*$/m.exec(remote)?.[1] ?? ''
  const url = rawUrl.replace(/^["']|["']$/g, '')

  return (url.split(/[\\/:]/).filter(Boolean).pop() ?? '').replace(/\.git$/, '')
}

// Names this folder's project may go by, as the Claude mod's `detectHere` has them: the folder
// Codex files its block under, the main repository's folder for a git worktree, and the
// repository's name in its remote. Read from `.git`, `commondir` and `config`, without
// starting git inside the host's time limit; anything unreadable leaves the folder alone.
const hereNames = (cwd: unknown): string[] => {
  const folder = folderProject(cwd)
  const names = new Set(folder === '' ? [] : [folder])
  if (typeof cwd !== 'string' || folder === '' || !isAbsolute(cwd)) return [...names]
  try {
    const dotGit = join(cwd, '.git')
    if (!existsSync(dotGit)) return [...names]
    // A checkout has a `.git` folder; a worktree has a `.git` file that names its own folder.
    const gitDir = statSync(dotGit).isDirectory() ? dotGit : resolve(cwd, /^gitdir:\s*(.+)$/im.exec(readLocal(dotGit) ?? '')?.[1]?.trim() ?? '.git')
    const common = readLocal(join(gitDir, 'commondir'))?.trim()
    const commonDir = common === undefined ? gitDir : resolve(gitDir, common)
    // Only a worktree has `commondir`; a submodule's git folder sits under `.git/modules`, not in a checkout.
    if (common !== undefined) {
      if (basename(commonDir) === '.git') names.add(basename(dirname(commonDir)))
      else if (commonDir.endsWith('.git')) names.add(basename(commonDir).replace(/\.git$/, ''))
    }
    names.add(remoteName(readLocal(join(commonDir, 'config')) ?? ''))
  } catch {}

  return [...names].filter(name => name !== '')
}

// A Codex session a person starts gets, on its SessionStart, the note the Claude mod gives a
// first turn (#502). A run another agent started gets none, by the signal #501 keeps (`run`);
// a resumed, cleared or compacted session already had its chance.
export const codexStartNote = (raw: Json, run: RunSignal | undefined, session: string, progress: string, s: Strings, now = Date.now()): string | null => {
  if (raw.hook_event_name !== 'SessionStart' || raw.source !== undefined && raw.source !== 'startup') return null
  if (run !== undefined && isStrongRun(run)) return null
  // A board the hook cannot read now (busy, no access) gives no note rather than a failed event.
  let text: string | null = null
  try { text = readLocal(progress) } catch {}
  if (text === null) return null

  return othersNote(parseProgress(text), hereNames(raw.cwd), { sessionId: hash(`codex:${session}`).slice(0, 8), agent: 'codex', resume: session }, now, s, s.othersTailCodex)
}
const withoutBom = (text: string): string => text.startsWith('\uFEFF') ? text.slice(1) : text
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_JSON_OBJECT')
  return value as Json
}
// Hermes Agent's trust file: {"approvals": [{event, command, approved_at, script_mtime_at_approval}]}, written with sorted keys.
// An absent file is an empty list; one this cannot read as that shape is left alone (null).
type Approval = Json & { event?: unknown; command?: unknown }
const readAllowlist = (text: string | null, isUnreadable = false): { data: Json; list: Approval[] } | null => {
  if (text === null) return { data: {}, list: [] }
  if (isUnreadable) return null
  try {
    const data = object(JSON.parse(text))
    const list = data.approvals ?? []
    if (!Array.isArray(list) || list.some(entry => typeof entry !== 'object' || entry === null || Array.isArray(entry))) return null
    return { data, list: list as Approval[] }
  } catch { return null }
}
const sortedKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortedKeys) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys((value as Json)[key])])) : value
// Hermes writes this file as ASCII and reads it in the system code page, so a raw non-ASCII byte would stop
// every shell hook from loading: escape it the way Python's json.dumps does.
const allowlistText = (data: Json): string => JSON.stringify(sortedKeys(data), null, 2).replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
// A root that is not a mapping (a list, a flow document) is not something to add a key to. Hermes saves config.yaml
// with PyYAML, which writes a list's items at the left edge right under their key (`toolsets:` then `- hermes-cli`, #1588):
// such an item belongs to the key above it, so the root is still a mapping. Under `hooks:` it is not one the board's
// hooks can go into. The line editor finds the hooks key only as written plain or quoted, so a double-quoted key whose
// escapes spell `hooks` (`"ho\x6fks"`) is refused, as is one it cannot decode; PyYAML's escapes for a key that is not
// ASCII (`"caf\xE9"`) are some other key and pass. A document end marker or a second document is refused too: hooks
// added at the end of the file would land outside the one document Hermes reads.
const YAML_TOP_KEY = /^(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#{[!&*|>%@`"'-][^\n]*?))\s*:(?:\s|$)/
const YAML_ESCAPES: Record<string, string> = { '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' }
const yamlDoubleQuoted = (raw: string): string | undefined => {
  let isBad = false
  const text = raw.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S]|$)/g, (_, escape: string) => {
    const point = escape.length > 1 ? parseInt(escape.slice(1), 16) : undefined
    if (point !== undefined && point <= 0x10ffff) return String.fromCodePoint(point)
    const plain = point === undefined ? YAML_ESCAPES[escape] : undefined
    if (plain === undefined) isBad = true
    return plain ?? ''
  })
  return isBad ? undefined : text
}
const isYamlMapping = (text: string): boolean => {
  let listKey: string | undefined
  let hasContent = false
  return text.split(/\r?\n/).every(line => {
    if (!/^\S/.test(line) || line.startsWith('#')) return true
    if (/^---\s*(?:#.*)?$/.test(line)) return !hasContent
    hasContent = true
    if (/^-(?:\s|$)/.test(line)) return listKey !== undefined && listKey !== 'hooks'
    const key = YAML_TOP_KEY.exec(line)
    if (key === null) return false
    const name = key[1] === undefined ? key[2] ?? key[3] : yamlDoubleQuoted(key[1])
    if (name === undefined || (name === 'hooks' && key[1] !== undefined && key[1] !== 'hooks')) return false
    const rest = line.slice(key[0].length).trim()
    listKey = rest === '' || rest.startsWith('#') ? name : undefined
    return true
  })
}
// A name that was free when setup planned (`isFresh`) is created, never written over (#1693): a rename would replace a
// file that landed there after the last check. A hard link of the finished temporary file places it whole in one step
// and fails when the name is taken, and setup then stops as busy. Where a link is refused for any other reason, as on a
// disk with no hard links, setup checks once more and renames, as for any other file: a file that lands between that
// check and the rename is written over there, a stated limit.
const atomic = (file: string, text: string | Buffer, current: () => void = () => {}, retryRecord = false, isFresh = false): void => {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  let isOpen = true
  try {
    writeFileSync(fd, text)
    closeSync(fd)
    isOpen = false
    let delay = 10, waited = 0, isFree = isFresh
    for (;;) {
      current()
      try {
        if (isFree) linkSync(temporary, file)
        else renameSync(temporary, file)
        break
      } catch (error) {
        if (isFree) {
          if ((error as { code?: string }).code === 'EEXIST') throw new Error('INSTALL_CHANGED')
          isFree = false
          continue
        }
        if (!retryRecord || process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(String((error as { code?: string }).code)) || waited >= 250) throw error
        const wait = Math.min(delay, 250 - waited)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
        waited += wait
        delay *= 2
      }
    }
  } finally {
    if (isOpen) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

// Only board-defined codes may be copied from an error into the diagnostic log.
const pendingErrorCodes = new Set([
  'INVALID_JSON_OBJECT', 'INVALID_RAW_ENTRY', 'INVALID_RAW_ARGV', 'INVALID_RAW_MODE', 'INVALID_RAW_ENV',
  'INVALID_SESSION', 'INVALID_EVENT', 'INVALID_EVENT_TIME', 'INVALID_STATE', 'INVALID_EVENT_STATE', 'SESSION_CONFLICT',
  'UNBOUND_SESSION', 'MISSING_TURN', 'STALE_TURN', 'INVALID_TEXT', 'INVALID_STEPS', 'INVALID_STEP',
  'UNFINISHED_STEPS', 'INVALID_OWNER', 'BLOCK_CONFLICT', 'BLOCK_NOT_VISIBLE',
])
const pendingErrorCode = (error: unknown): string => {
  if (error instanceof SyntaxError) return 'INVALID_JSON'
  return error instanceof Error && pendingErrorCodes.has(error.message) ? error.message : 'UNREADABLE'
}

// Log failures must never change replay, and queued content is never diagnostic text.
const logPendingDrop = (home: string, stored: Json | undefined, code: string): void => {
  try {
    const args = Array.isArray(stored?.argv) ? stored.argv : []
    const rawFlag = (name: string): unknown => {
      for (let index = 1; index + 1 < args.length; index += 2) if (args[index] === name) return args[index + 1]
      return undefined
    }
    const candidate = Array.isArray(stored?.argv) ? rawFlag('--agent') : stored?.agent
    const agent = typeof candidate === 'string' && localAgents.includes(candidate as LocalAgent) ? candidate : 'unknown'
    const payload: Json = stored?.payload && typeof stored.payload === 'object' && !Array.isArray(stored.payload) ? stored.payload as Json : {}
    const eventValue = rawFlag('--hook-event') ?? rawFlag('--event') ?? stored?.event ?? payload.hook_event_name ?? payload.hookEventName
    const events: readonly string[] = [...codexEvents, ...Object.keys(cursorEvents), ...Object.values(cursorEvents), ...Object.values(statusEvents).flatMap(events => Object.keys(events ?? {}))]
    const event = typeof eventValue === 'string' && events.includes(eventValue) ? eventValue : 'unknown'
    const file = join(home, '.agent-board', 'hook-errors.log')
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    let previous = ''
    try {
      if (!lstatSync(file).isFile()) throw new Error('UNSAFE_LOG')
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      try {
        const info = fstatSync(fd)
        if (!info.isFile()) throw new Error('UNSAFE_LOG')
        const length = Math.min(info.size, 65536), bytes = Buffer.alloc(length)
        const count = readSync(fd, bytes, 0, length, info.size - length)
        previous = bytes.subarray(0, count).toString('utf8')
        if (info.size > length) previous = previous.slice(previous.indexOf('\n') + 1)
      } finally { closeSync(fd) }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
    }
    const line = `${new Date().toISOString()} ${agent} ${event} PENDING_DROPPED_${code}`
    // The same temporary name as the reporters' writer, so their sweep removes one a kill leaves.
    const temporary = `${file}.${process.pid}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      try { writeFileSync(fd, `${[...previous.trimEnd().split('\n').filter(Boolean).slice(-199), line].join('\n')}\n`) } finally { closeSync(fd) }
      renameSync(temporary, file)
    } catch (error) {
      try { unlinkSync(temporary) } catch {}
      throw error
    }
  } catch {}
}
const input = async (): Promise<Json> => {
  let text = ''
  for await (const chunk of process.stdin) {
    text += String(chunk)
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('INPUT_TOO_LARGE')
  }
  return object(JSON.parse(text))
}
const quote = (path: string): string => {
  if (/["`$%\r\n]/.test(path)) throw new Error('UNSAFE_COMMAND_PATH')
  return `"${path}"`
}

export const localProgressPath = (explicit: string | undefined, fallback: string, stored?: unknown): string =>
  resolve(explicit ?? (process.env.CLAUDE_PROGRESS_FILE || (typeof stored === 'string' ? stored : fallback)))

// The trust step names the config.toml it writes, the way the setup preview names its files (#812).
export const codexTrustOutput = (result: { changes: number; applied: boolean; file?: string }, s: Strings, isJson: boolean, home?: string): string => {
  if (isJson) return `${JSON.stringify(result, null, 2)}\n`
  const inHome = home === undefined || result.file === undefined ? '' : relative(resolve(home), result.file)
  const file = inHome !== '' && inHome !== '..' && !inHome.startsWith(`..${sep}`) && !isAbsolute(inHome) ? join('~', inHome) : result.file ?? 'config.toml'
  const line = result.changes === 0 ? s.codexTrustNone : result.applied ? s.codexTrustApplied(result.changes, file) : s.codexTrustPreview(result.changes, file)
  return `${line}\n`
}

export type LocalPlan = {
  agent: string
  progress: string
  changes: { file: string; action: string }[]
  conflicts: string[]
  alreadyGone: string[]
  // Shared files this removal leaves alone, and the other agents still using each one.
  // Only set on a removal preview/apply while another agent's install record remains.
  keptShared?: { file: string; usedBy: string[] }[]
  // An old /board command file the person edited: setup leaves it and names it here (#868).
  keptEdited?: string[]
  // Generated files the person edited, which setup never overwrites (#1302). Text a host only reads gets the new
  // version beside it. Code a host loads stays as it is, and the code and hooks that work with it stay with it.
  keptText?: { file: string; beside: string }[]
  keptCode?: string[]
  keptHeld?: { file: string; by: string }[]
  missingHeld?: { file: string; by: string }[]
  // How the person opens the board in this agent, and the file that way rests on (#1698).
  opens?: { way: string; file: string }
  applied?: boolean
}

const keptLines = (result: LocalPlan, words: Strings['localSummary']): string[] => [
  ...(result.keptText ?? []).map(one => words.keptText(one.file, one.beside)),
  ...(result.keptCode ?? []).map(file => words.keptCode(file)),
  ...(result.keptHeld ?? []).map(one => words.keptHeld(one.file, one.by)),
  ...(result.missingHeld ?? []).map(one => words.heldMissing(one.file, one.by)),
]

export const codexDoctorOutput = (result: LocalPlan & {
  installed: boolean
  reportHook: string
  hooksTrusted: boolean | 'unknown'
  problem?: string
  capabilities: { lifecycle: string }
}, s: Strings, command: string, trustCommand?: string, isCodexMissing = false): string => {
  const words = s.localSummary
  const host = s.agentNames[result.agent] ?? result.agent
  const hasHook = result.installed || result.reportHook === 'connect'
  const isOutdated = result.installed && Boolean(result.keptCode?.length || result.keptHeld?.length)
  const lines = [words.doctor(host, isOutdated ? words.outdated : result.installed ? words.installed : hasHook ? words.connector : words.missing)]
  if (result.problem) lines.push(result.problem)
  lines.push(...keptLines(result, words))
  for (const file of result.conflicts) lines.push(words.conflict(file))
  if (!hasHook) for (const change of result.changes) lines.push(words.needsUpdate(change.file))
  const isPending = result.capabilities.lifecycle === 'adapter-pending'
  if (isPending) lines.push(words.pending)
  if (result.agent === 'codex' && result.installed) lines.push(result.hooksTrusted === true ? words.trusted : result.hooksTrusted === false ? words.untrusted : words.trustUnknown)
  lines.push(s.codexDoctor)
  if (isCodexMissing && result.agent === 'codex' && result.installed && result.hooksTrusted !== true && !result.conflicts.length && !isPending) lines.push(words.trust)
  lines.push(result.conflicts.length ? words.review(command)
    : !hasHook ? words.setup(command)
    : isOutdated ? words.outdatedNext
    : isPending ? words.skill(host)
    // --codex-trust works only on an installed Codex, not on one the connector hooked.
    : result.agent === 'codex' && result.installed && result.hooksTrusted !== true ? trustCommand ? words.trustRun(trustCommand) : words.trust
    : words.verify(host))
  return `${lines.join('\n')}\n`
}

export const codexRemoveOutput = (result: LocalPlan, s: Strings, command: string): string => {
  const words = s.localSummary
  const host = s.agentNames[result.agent] ?? result.agent
  const isRemoved = result.applied === true && result.changes.length > 0
  const lines = [words.removal(host, isRemoved ? words.removed : result.conflicts.length ? words.blocked : result.changes.length ? words.preview : words.absent)]
  for (const change of result.changes) lines.push(change.action === 'remove'
    ? result.applied ? words.removedFile(change.file) : words.removeFile(change.file)
    : result.applied ? words.updatedFile(change.file) : words.updateFile(change.file))
  for (const kept of result.keptShared ?? []) lines.push(words.keptShared(kept.file, kept.usedBy.map(one => s.agentNames[one] ?? one).join(s.listSep)))
  for (const file of result.alreadyGone) lines.push(s.setupAlreadyGone(file))
  for (const file of result.conflicts) lines.push(words.conflict(file))
  lines.push(words.kept(result.progress))
  lines.push(result.conflicts.length ? words.review(command)
    : isRemoved ? words.restart(host)
    : result.changes.length ? words.apply(`${command} --apply`) : words.none)
  return `${lines.join('\n')}\n`
}

export const codexSetupOutput = (result: LocalPlan, s: Strings, command: string, check: string): string => {
  const words = s.localSummary
  const host = s.agentNames[result.agent] ?? result.agent
  const isApplied = result.applied === true && result.changes.length > 0
  const lines = [words.removal(host, isApplied ? words.setupApplied : result.conflicts.length ? words.setupBlocked : result.changes.length ? words.setupPreview : words.setupCurrent)]
  for (const change of result.changes) lines.push(isApplied ? words.setupWritten(change.file) : words.setupFile(change.file))
  lines.push(...keptLines(result, words))
  for (const file of result.conflicts) lines.push(words.conflict(file))
  lines.push(result.conflicts.length ? words.review(command)
    : isApplied || !result.changes.length ? words.setupCheck(check)
    : words.setupApply(`${command} --apply`))
  return `${lines.join('\n')}\n`
}

// What a person reads when a setup mode fails (#465): one sentence with its next step, never the code name, a stack or a path.
export const setupFailure = (error: unknown, agent: string, s: Strings): { code: string; message: string; reason?: string } => {
  const detail = error as { code?: unknown; message?: unknown; record?: unknown } | null | undefined
  const isCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
  const code = isCode(detail?.code) ? detail.code : isCode(detail?.message) ? detail.message : 'UNKNOWN'
  const unknown = s.setupAgentUnknown.toLowerCase()
  const host = localAgents.includes(agent as LocalAgent) ? s.agentNames[agent] ?? unknown : unknown
  const record = typeof detail?.record === 'string' && /^install-[a-z]+(?:-sidecar)?\.json$/.test(detail.record) ? detail.record : 'install-*.json'
  const message = code === 'MISSING_ARGUMENT' ? s.setupErrorMissingValue
    : code === 'INVALID_INSTALL_RECORD' ? s.setupErrorRecord(record)
    : code === 'INVALID_CONNECT_RECORD' ? s.setupErrorConnectRecord
    : code === 'INSTALL_CONFLICT' ? s.setupErrorConflict(host)
    : code === 'UNSAFE_COMMAND_PATH' ? s.setupErrorUnsafePath
    : ['INVALID_JSON_OBJECT', 'INVALID_HOOK_GROUP', 'INVALID_PLUGIN_CONFIG'].includes(code) ? s.setupErrorConfig(host)
    : code === 'SHARED_BOARD_PATH_CONFLICT' ? s.setupErrorBoardPath
    : ['INSTALL_CHANGED', 'LOCK_BUSY', 'LOCK_OWNERSHIP_LOST'].includes(code) ? s.setupErrorBusy
    : ['CODEX_BINARY_REQUIRED', 'ABSOLUTE_CODEX_BINARY_REQUIRED'].includes(code) ? s.setupErrorCodexBinary
    : code === 'OWNED_CODEX_INSTALL_REQUIRED' ? s.setupErrorCodexInstall
    : s.setupErrorDetails[code as keyof typeof s.setupErrorDetails] ?? (code === 'UNKNOWN' ? s.setupErrorOther(host) : s.setupErrorCode(code))
  const reason = typeof detail?.message === 'string' && detail.message.trim() ? detail.message : 'Unknown error'
  return code === 'UNKNOWN' ? { code, message, reason } : { code, message }
}

const saveReporterTail = (progress: string, fragment: Buffer): string => {
  const aside = `${progress}.torn-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  const fd = openSync(aside, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, fragment)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    if (!readFileSync(aside).equals(fragment)) throw new Error('INCOMPLETE_PROGRESS_TAIL')
    return aside
  } catch (error) {
    try { unlinkSync(aside) } catch {}
    throw error
  }
}

// Codex and Cursor events name the session's folder. Of the status hooks, only OpenCode's plugin
// (#217) and DeepSeek's (#1118) send one for that; the others keep their agent's heading.
const filesByFolder = (mode: string, agent: string): boolean => mode === '--codex-event' || mode === '--agent-status' && (agent === 'opencode' || agent === 'deepseek')

// `planInput` is a plan the --plan-event step already turned into a report's input: the report then
// runs as --report does and prints nothing, because Codex and Gemini read a hook's stdout as a decision.
export const runCodexLocal = async (args: string[], boardPath: string, s: Strings, planInput?: Json, local?: { output: (value: unknown) => void; beforeApply?: (plan: LocalPlan) => void }): Promise<boolean> => {
  args = args.map(arg => arg === '--report' ? '--codex-report' : arg === '--remove' ? '--codex-remove' : arg)
  const mode = ['--recover-hooks', '--codex-setup', '--codex-doctor', '--codex-remove', '--codex-trust', '--hermes-trust', '--codex-report', '--codex-event', '--agent-status', '--plan-event', '--mailbox'].find(one => args.includes(one))
  if (!mode) return false
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT')
    return value
  }
  const removingAgents = (flag('--removing')?.split(',') ?? []).map(one => one.trim()).filter(Boolean)
  const baked = (globalThis as { AGENT_BOARD?: { codexRoot?: string } }).AGENT_BOARD
  // Reporting needs a known board name, while setup and lifecycle events need a native adapter.
  const agent = (flag('--agent') ?? (mode === '--hermes-trust' ? 'hermes' : 'codex')) as LocalAgent
  if (!(mode === '--codex-report' ? Object.hasOwn(s.agentNames, agent) : localAgents.includes(agent))) throw new Error('UNSUPPORTED_AGENT')
  if (mode === '--plan-event') {
    if (planEvents[agent] === undefined && !planPlugins.includes(agent)) throw new Error('UNSUPPORTED_AGENT')
    const rawPlan = await input()
    const plan = planReport(rawPlan)
    if (plan === null) return true
    // A plan with no block yet files like this agent's own status events: by the session's folder
    // for the agents that name one, else under the agent's own heading (never Codex's for another agent).
    const planProject = ['codex', 'cursor', 'opencode'].includes(agent) ? folderProject(rawPlan.cwd) || agent : agent
    return runCodexLocal([...args.filter(arg => arg !== '--plan-event'), '--codex-report', '--session', plan.session], boardPath, s, { ...plan.input, planProject })
  }
  const home = resolve(flag('--home') ?? homedir())
  const root = resolve(flag('--data-dir') ?? baked?.codexRoot ?? join(home, '.agent-board'))
  const before = new Map<string, Snap>()
  const initial = (file: string): string | null => {
    if (!before.has(file)) before.set(file, take(file))
    return before.get(file)!.bytes?.toString('utf8') ?? null
  }
  // A file whose bytes are not valid UTF-8 is never written over or taken as setup's (#1607). The plan still compares its
  // decoded text with what setup would write; ownership asks isUnreadable, and put refuses such bytes before a write.
  const isUnreadable = (file: string): boolean => {
    initial(file)
    const bytes = before.get(file)!.bytes
    return bytes !== null && !isPlain(bytes)
  }
  // The hash of the bytes setup saw. For valid UTF-8 it is the hash of the text, so a record written earlier still
  // matches; FF and the EF BF BD it would decode to differ, so one is never taken for the other.
  const ownHash = (file: string, text: string): string => hash(before.get(file)?.bytes ?? text)
  // Every re-read after planning compares a path with what setup saw there (#1488): the batch check, the re-read just
  // before each change and the read-back after it, in both writers. Before a write the path must be as planned, or
  // already hold exactly the new bytes as the same kind of path, or as a new regular file where there was none: one
  // file reached by a second name earlier in this batch (a skills folder linked to the shared one, or another letter
  // case on Windows), so writing the same bytes over it loses nothing. Before a removal it must be as planned, or, only
  // when its planned real path is a file this batch itself removed, already gone (a second name of that file) or the
  // same link it was with its target gone (a file link to that file). A file or target another program removed or moved
  // stops the batch. Anything else stops the batch, a link or other bytes put where the file was included.
  // A second name may also find a regular file where it planned a file link, when this batch's own write replaced that
  // link (a skills folder linked to the shared one whose SKILL.md is a file link): only when the path's real path is
  // one this batch wrote and it holds exactly the new bytes (Greptile on #1594).
  // After a write the rename target must be a regular file holding exactly the bytes; after a removal the path is gone.
  // A plain rename or unlink cannot close the instant between the last re-read and the change: a file another program
  // deletes in that instant stops the removal instead of counting as removed by setup (#1611).
  // A stale .new copy and the pending list are read again just before the unlink, as planned, not through the re-read removal.
  const isHolding = (now: Snap, text: string): boolean => sameBytes(now.bytes, Buffer.from(text, 'utf8'))
  const ours = new Set<string>()
  // The real paths of the entries this batch removed, each recorded once its removal was checked: a regular file by
  // its own real path, a file link by the link entry's real path (its parent's real path plus its name), so a second
  // name of either finds its own removal and the batch finishes (#1610). A link's target is never recorded here: the
  // target still exists, and another link to it must not read as removed (F2).
  const gone = new Set<string>()
  const realOf = (file: string): string | null => { try { return realpathSync.native(file) } catch { return null } }
  // The real path of a link entry itself: resolve the parent, keep the name. Two names of one link (a skills folder
  // linked to the shared one) share it; two separate links to one target do not.
  const entryReal = (file: string): string | null => { try { return join(realpathSync.native(dirname(file)), basename(file)) } catch { return null } }
  const isOurs = (file: string, now: Snap, next: string): boolean => now.kind === 'file' && isHolding(now, next) && ours.has(realOf(file) ?? '')
  // A .new path is the exception: a file that appeared there is a second name only when this batch wrote it, since bytes
  // alone would also match a file another program put there (#1693).
  const unchanged = (file: string, next: string | null): Snap => {
    const was = before.get(file) ?? NO_PATH, now = take(file)
    const isSecondName = next !== null && isHolding(now, next) && (now.kind === was.kind && now.link === was.link || was.kind === 'none' && now.kind === 'file' && !file.endsWith('.new') || isOurs(file, now, next))
    // A path already gone, or the same link with its target gone, only where this batch itself removed the entry or
    // the target: a second name of a file this batch removed (its own real path), a second name of a link this batch
    // removed (the link entry's real path, not its target), a link whose target this batch removed, or a dangling
    // link whose link text names an entry this batch removed (a chain H -> S -> C where S went first: H's final
    // target C is not in `gone`, but the break is explained by setup's own verified removal of S).
    const entry = was.kind === 'link' ? entryReal(file) : was.real
    // The entry the link text names: resolve it against the link's folder, then take that entry's real path. The
    // first removed entry in a chain explains the break; a target another program deleted is not named by the link
    // text, so it still stops the batch (F2). `resolve` must not be used here: it collapses `hop/..` lexically
    // before the OS follows `hop`, so the entry named is a file the link never read (Greptile 4627685622). Join
    // the raw text instead, and let `entryReal` resolve the parent with realpath, so `..` goes up from the
    // directory the OS reached through the link, not the lexical one.
    const target = was.link !== null && isAbsolute(was.link) ? was.link : dirname(file) + sep + was.link
    const linkEntry = was.kind === 'link' && was.link !== null ? entryReal(target) : null
    const isGone = next === null && ((now.kind === 'none' && entry !== null && gone.has(entry)) || (was.kind === 'link' && now.kind === 'link' && now.link === was.link && now.bytes === null && was.real !== null && (gone.has(was.real) || (linkEntry !== null && gone.has(linkEntry)))))
    if (!same(was, now) && !isSecondName && !isGone) throw new Error('INSTALL_CHANGED')
    return now
  }
  const written = (file: string, text: string | null): void => {
    const now = take(file)
    if (text === null ? now.kind !== 'none' : now.kind !== 'file' || !isHolding(now, text)) throw new Error('INSTALL_CHANGED')
  }
  // A .new copy where the plan found nothing is created, never written over (#1693). A name this batch already wrote as
  // the same file through another name (a skills folder linked to the shared one) is not written again: it holds the
  // bytes already, and a person's save there would be lost.
  const put = (file: string, text: string, target = file): void => {
    const now = take(target)
    // Last line of defence: whatever the plan, a path holding bytes that are not valid UTF-8 is not written over (#1607).
    if (now.bytes !== null && !isPlain(now.bytes)) throw new Error('INSTALL_CHANGED')
    if (isOurs(target, now, text)) return
    atomic(target, text, () => unchanged(file, text), false, target.endsWith('.new') && (before.get(file) ?? NO_PATH).kind === 'none')
    written(target, text)
    const real = realOf(target)
    if (real !== null) ours.add(real)
  }
  // unlinkSync, not an existsSync check first: a file link whose target this batch already removed reads as gone but
  // is still there, and must go too. A path already gone by this batch's own earlier removal needs no unlink; a path
  // that read as present when re-read, gone by the unlink, was taken by another program in that instant (#1611).
  // Reuse the snapshot `unchanged` validated: a second read could see a deletion by another program and skip the
  // unlink that would have caught it, crediting the outside deletion to setup (F1).
  const drop = (file: string): void => {
    const now = unchanged(file, null)
    if (now.kind !== 'none') {
      try { unlinkSync(file) } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') throw new Error('INSTALL_CHANGED')
        throw error
      }
    }
    written(file, null)
    const was = before.get(file)
    // Record the entry this batch removed: for a link, the link entry itself (its parent's real path plus its name),
    // not its target — the target still exists, and another link to it must not read as removed (F2).
    if (was !== undefined && was.real !== null) {
      const entry = was.kind === 'link' ? entryReal(file) : was.real
      if (entry !== null) gone.add(entry)
    }
  }
  const isAsPlanned = (file: string): boolean => same(take(file), before.get(file) ?? NO_PATH)
  // A board run (a report, a hook event, a status, a hook recovery, the mailbox) only reads where the board is from the
  // install records and writes none of them, so it reads them as main does (#1607).
  const isInstallRun = mode === '--codex-setup' || mode === '--codex-remove' || mode === '--codex-trust' || mode === '--hermes-trust' || mode === '--codex-doctor'
  const jsonInitial = (file: string): Json => {
    try {
      // An install record that is not valid UTF-8 stops setup, removal, trust and doctor, another agent's record too:
      // skipping it could let a removal delete a shared file that record still names (#1607).
      if (isInstallRun && isUnreadable(file)) throw new SyntaxError('not valid UTF-8')
      const record = object(JSON.parse(initial(file) ?? '{}'))
      if (record.files !== undefined) object(record.files)
      if (record.groups !== undefined) object(record.groups)
      if (record.foreignGroups !== undefined) object(record.foreignGroups)
      return record
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof Error && error.message === 'INVALID_JSON_OBJECT') throw Object.assign(new Error('INVALID_INSTALL_RECORD'), { record: basename(file) })
      throw error
    }
  }
  const manifestFile = join(root, `install-${agent}.json`)
  const loaded = jsonInitial(manifestFile)
  const otherAgents = localAgents.filter(one => one !== agent)
  const otherManifests = otherAgents.map(one => jsonInitial(join(root, `install-${one}.json`)))
  // A .new copy reaches the disk before the install record names it, so a setup that stops between the two leaves a copy
  // no record holds (#1302). This list is written before the copy and removed after the record, and it is how the next
  // setup knows that copy is its own: the wanted bytes alone would also match a file the person put there.
  // A file under that name is a list only when it reads as one setup could have written: a regular file holding a JSON
  // object of .new paths, each with hashes. Its name alone says nothing, since a board named there or any note of the
  // person's can have it too. So setup reads, writes over and deletes the file only when it reads so; anything else names
  // nothing, a copy no record holds then stops that agent as any unknown file does, and the file stays.
  // Setup writes into this agent's list only the .new path beside a text file of this run's plan, so its list may name
  // only those. Another agent's list is only read here and its plan is not known, so its paths need only be full ones;
  // an entry of it names a copy only under the exact path this run plans (isOurBeside). That is as far as setup can
  // tell: a file naming this plan's own .new paths with hashes is its list, whoever wrote it.
  const pendingFile = (one: string): string => join(root, `install-pending-${one}.json`)
  const isOwnCopy = (path: string): boolean => isTextFile(path.slice(0, -4)) && Object.hasOwn(files, path.slice(0, -4))
  const listOf = (snap: Snap | undefined, isNamed: (path: string) => boolean = isOwnCopy): Record<string, string[]> | null => {
    if (snap?.kind !== 'file' || snap.bytes === null || !isPlain(snap.bytes)) return null
    let held: unknown
    try { held = JSON.parse(snap.bytes.toString('utf8')) } catch { return null }
    if (typeof held !== 'object' || held === null || Array.isArray(held)) return null
    const entries = Object.entries(held)
    const isList = entries.length > 0 && entries.every(([path, hashes]) => path.endsWith('.new') && isNamed(path) && Array.isArray(hashes) && hashes.length > 0 && hashes.every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)))
    return isList ? Object.fromEntries(entries) as Record<string, string[]> : null
  }
  const pendingOf = (one: string): Record<string, string[]> => {
    initial(pendingFile(one))
    return listOf(before.get(pendingFile(one)), one === agent ? isOwnCopy : isAbsolute) ?? {}
  }
  const control = join(installControlRoot(home), 'legacy-connect.json')
  const authority = join(installControlRoot(home), 'legacy-connect-authority')
  let connection: ConnectTransaction['state'] | undefined
  try {
    connection = mode === '--codex-setup' && (initial(control) !== null || initial(authority) !== null) ? new ConnectTransaction(home, undefined).state : undefined
  } catch {
    throw new Error('INVALID_CONNECT_RECORD')
  }
  const activeConnection = connection?.disabled === false ? connection : undefined
  const connectorProgress = activeConnection === undefined ? undefined : activeConnection.connectedProgress ?? join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'progress.md')
  const storedProgress = loaded.progress ?? otherManifests.find(one => typeof one.progress === 'string')?.progress ?? connectorProgress
  const progress = localProgressPath(flag('--progress-file'), mode === '--codex-setup' ? join(root, 'progress.md') : boardPath, storedProgress)
  // DeepSeek's plugin runs in the dsh process and hands a board message to its idle session itself (#725):
  // it takes the session's next message here (which also keeps the session's mailbox open, so its card
  // has a Send box), gives it to the session, then marks it delivered here. `watch` is the folder whose
  // messages.json changes when the board queues a message.
  if (mode === '--mailbox') {
    const action = flag('--mailbox'), session = flag('--session')
    // OpenCode's plugin (#724) also acknowledges for its own session: ack upgrades an accepted message.
    // open (OpenCode's too) opens or renews the mailbox of a session that is busy, where the plugin takes nothing (#1366).
    // verify (OpenCode's too) answers whether the board accepts its messages file as it is now, and writes nothing (#1366).
    if (agent !== 'deepseek' && agent !== 'opencode' || session === undefined || !['take', 'accept', 'end', ...(agent === 'opencode' ? ['ack', 'release', 'attempt', 'open', 'verify'] : [])].includes(action ?? '')) throw new Error('INVALID_MAILBOX_CALL')
    const directory = defaultMessagesDirectory(progress, home, process.env, process.platform)
    // This path runs in the plugin's own process with seconds to spare, so it waits for a busy board or store (a turn-start hook cannot).
    const mailbox = hookMailbox(directory, 5000, 2000, 2000)
    const answer = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
    // A failed call answers ok false with the board's own code, never a bare failure and never ok true.
    const codeOf = (error: unknown): string => error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'BOARD_NOT_RUNNING'
    // The surface a take or an open records for the mailbox.
    const surfaceOf = (surface: string | undefined): string => surface === SURFACE_IDS.web || surface === SURFACE_IDS.tui || agent === 'opencode' && surface === SURFACE_IDS.cli ? surface : SURFACE_IDS.unknown
    if (action === 'take') {
      const surface = flag('--surface'), ref = flag('--ref')
      // OpenCode's plugin names the claim (12 hex), so it can release it again.
      if (ref !== undefined && (agent !== 'opencode' || !/^[0-9a-f]{12}$/.test(ref))) throw new Error('INVALID_MAILBOX_CALL')
      let message: Awaited<ReturnType<typeof mailbox.turnOrThrow>>
      let taker = mailbox
      if (agent !== 'opencode') {
        // DeepSeek's receiver reads a failed take from the exit status and the code on stderr; a deferred take answers null (#1448).
        // A refused or cut connection to the board is asked again within this take's own five seconds, counted from its
        // first ask, as the receiver asks again after a deferred take, so a board back in a moment still delivers; one that
        // keeps failing is reported. A cut take whose claim did not go back is reported at once: asking again would find
        // nothing while the board still holds that message (#1631).
        const until = Date.now() + 5000
        message = await taker.turn(agent, session, surfaceOf(surface), Date.now())
        while (message === null && taker.hasTransportError && !taker.hasHeldClaim && Date.now() + 500 < until) {
          await new Promise(done => setTimeout(done, 250))
          taker = hookMailbox(directory, Math.max(until - Date.now(), 0), 2000, 2000)
          message = await taker.turn(agent, session, surfaceOf(surface), Date.now())
        }
        if (message === null && taker.error !== null) throw new Error(taker.error)
      } else {
        try {
          message = await mailbox.turnOrThrow(agent, session, surfaceOf(surface), Date.now(), ref)
        } catch (error) {
          // A failed take is not an empty mailbox: the plugin tries again on its own clock.
          // A take the board deferred (its store was busy) is asked again by a plugin that reads deferred (#1429).
          answer({ ok: false, code: error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'BOARD_NOT_RUNNING', watch: directory, message: null, deferred: mailbox.hasDeferred })
          return true
        }
      }
      // The one line DeepSeek's page shows for the message, kept to the 120 characters dsh allows a notice.
      const line = message === null ? '' : message.text.replace(/\s+/g, ' ').trim()
      const summary = line.length > 120 ? `${line.slice(0, 119)}…` : line
      // deferred: the board's store was busy, so null here is "not checked", not "nothing waiting"; the plugin asks again (#1429).
      answer({ watch: directory, message: message === null ? null : { id: message.id, nonce: message.nonce, text: deliveryText(message, s), summary }, deferred: message === null && taker.hasDeferred })
    } else if (action === 'open') {
      // OpenCode's plugin only. It claims nothing, and the plugin reads the board's file to see whether it worked. The answer
      // names the folder to watch. With no board folder at all no board can queue a message, so nothing is enrolled yet
      // (enrolled false), as for end.
      try {
        await mailbox.open(agent, session, surfaceOf(flag('--surface')), Date.now())
        answer({ ok: true, enrolled: true, watch: directory })
      } catch (error) {
        answer(mailbox.hasNoFolder ? { ok: true, enrolled: false, watch: directory } : { ok: false, code: codeOf(error), watch: directory })
      }
    } else if (action === 'verify') {
      // OpenCode's plugin only. mark is the hash of the text the board accepted (null: no file there); the plugin trusts what
      // it read only for that same text. A file the board refuses answers ok false with its code. No lock, no write.
      try {
        answer({ ok: true, ...checkStoreFile(directory, Date.now()) })
      } catch (error) {
        answer({ ok: false, code: codeOf(error) })
      }
    } else if (action === 'release' || action === 'attempt') {
      // OpenCode's plugin only. release hands a claim back (--unsent: the host was never called, so even a started wake goes back);
      // attempt marks the wake it is about to start, and answers CLAIM_LOST when the ref is no longer the claim (#724).
      const ref = flag('--ref')
      if (ref === undefined || !/^[0-9a-f]{12}$/.test(ref)) throw new Error('INVALID_MAILBOX_CALL')
      try {
        if (action === 'attempt') await mailbox.attempt(agent, session, ref, Date.now())
        else await mailbox.release(agent, session, ref, Date.now(), args.includes('--unsent'))
        answer({ ok: true })
      } catch (error) {
        answer({ ok: false, code: codeOf(error) })
      }
    } else if (action === 'accept' && agent !== 'opencode') {
      const id = flag('--id'), nonce = flag('--nonce')
      if (id === undefined || nonce === undefined) throw new Error('INVALID_MAILBOX_CALL')
      answer({ ok: await mailbox.accept(agent, session, id, nonce, Date.now()) })
    } else if (action === 'accept' || action === 'ack') {
      // The plugin passes free text as base64, so a word that starts with two hyphens is not read as a flag.
      const text = (name: string): string | undefined => { const value = flag(name); return value === undefined ? undefined : Buffer.from(value, 'base64').toString('utf8') }
      try {
        if (action === 'accept') {
          // OpenCode's plugin reports a message as given only after the board saved its acceptance.
          const id = flag('--id'), nonce = flag('--nonce')
          if (id === undefined || nonce === undefined) throw new Error('INVALID_MAILBOX_CALL')
          await mailbox.acceptOrThrow(agent, session, id, nonce, Date.now(), args.includes('--awaits-ack'))
        } else {
          const id = flag('--id'), nonce = flag('--nonce'), summary = text('--summary-b64')
          if (id === undefined || nonce === undefined) throw new Error('INVALID_MAILBOX_CALL')
          await mailbox.ack(agent, session, id, nonce, `ACK ${nonce}${summary ? ` ${summary}` : ''}`, Date.now())
        }
        answer({ ok: true })
      } catch (error) {
        answer({ ok: false, code: codeOf(error) })
      }
    } else if (agent === 'opencode') {
      // A write that failed is not an end: the plugin asks again. With no board folder at all there is no mailbox to end.
      try {
        await mailbox.endOrThrow(agent, session, Date.now())
        answer({ ok: true })
      } catch (error) {
        answer(mailbox.hasNoFolder ? { ok: true } : { ok: false, code: codeOf(error) })
      }
    } else {
      await mailbox.end(agent, session, Date.now())
      answer({ ok: true })
    }
    return true
  }
  // Hermes Agent reads its hooks from config.yaml and its trust answers from shell-hooks-allowlist.json, both in its home (#1115).
  const hermesDir = resolve(flag('--hermes-dir') ?? hermesHome(home, sep, process.env, process.platform))
  const configs: Partial<Record<LocalAgent, string>> = {
    codex: resolve(flag('--codex-dir') ?? (process.env.CODEX_HOME || join(home, '.codex')), 'hooks.json'),
    cursor: join(home, '.cursor', 'hooks.json'),
    gemini: join(home, '.gemini', 'settings.json'),
    grok: join(flag('--grok-dir') ?? (process.env.GROK_HOME || join(home, '.grok')), 'hooks', 'agent-board-local.json'),
    muse: join(home, '.config', 'muse', 'settings.json'),
    hermes: join(hermesDir, 'config.yaml'),
    antigravity: join(home, '.gemini', 'config', 'hooks.json'),
  }
  const config = configs[agent] ?? ''
  const script = join(root, 'agent-board.mjs')
  // The doctor, trust step and plain setup compare or keep the board's files in what an install in the
  // board's own language wrote, which its first line holds: asked in another language, or run on a system
  // whose locale differs from the installed board, only the printed words change (#807, #879).
  const fileWords = ((): Strings => {
    if (mode === '--codex-setup' && flag('--lang') !== undefined) return s
    const head = /^globalThis\.AGENT_BOARD = (.*)$/.exec(readLocal(script)?.split('\n', 1)[0] ?? '')
    try {
      const lang = object(JSON.parse(head?.[1] ?? '')).lang
      return typeof lang === 'string' && Object.hasOwn(STRINGS, lang) ? STRINGS[lang as keyof typeof STRINGS] : s
    } catch { return s }
  })()
  const opencodeDir = resolve(flag('--opencode-dir') ?? (process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')))
  const openclawDir = resolve(flag('--openclaw-dir') ?? (process.env.OPENCLAW_STATE_DIR || join(home, '.openclaw')))
  const deepseekDir = resolve(flag('--deepseek-dir') ?? (process.env.DSH_HOME || join(home, '.dsh')))
  const skill = join(home, '.agents', 'skills', 'agent-board', 'SKILL.md')
  // The sidecar's own record (see runSidecarOnly): where it exists, this install keeps and removes those files too.
  const sidecarRecord = join(root, 'install-antigravity-sidecar.json')
  const manifest: Manifest = { files: { ...(agent === 'antigravity' ? object(jsonInitial(sidecarRecord).files ?? {}) : {}), ...object(loaded.files ?? {}) } as Record<string, string>, groups: object(loaded.groups ?? {}), foreignGroups: object(loaded.foreignGroups ?? {}) }
  const commandContext = { ...installContext(args), program: process.argv[1]! }
  // Keep this entry's code-point fallback and path quoting; only the argv policy is shared with setup.
  const nextCommand = (nextMode: string, extra: string[] = [], placeholder?: string): string => installCommand(commandContext, {
    target: 'board', mode: nextMode, agent,
    codexBin: placeholder ? { placeholder } : flag('--codex-bin') ?? (extra.includes('--codex-bin') ? extra[extra.indexOf('--codex-bin') + 1] : undefined),
    extra,
  }, quote, (program, argv, isRunnable) => {
    if (!isRunnable) {
      // A missing-host placeholder stays visible and last even if its context needs code-point quoting.
      const at = argv.indexOf(nextMode)
      return `${boardRun(program, argv.slice(0, at))} ${argv.slice(at).map(arg => /^[\w.:=/-]+$/.test(arg) ? arg : quote(arg)).join(' ')}`
    }
    const rest = argv
      // A Codex path a person can read: Windows takes forward slashes, and they need no code points.
      .map((arg, index, all) => process.platform === 'win32' && all[index - 1] === '--codex-bin' ? arg.replaceAll('\\', '/') : arg)
    if (rest.some(arg => /["`$%!\\\r\n]/.test(arg))) return boardRun(program, rest)
    return `${boardRun(program)} ${rest.map(arg => /^[\w.:=/-]+$/.test(arg) ? arg : quote(arg)).join(' ')}`
  }).text
  const output = (value: unknown): void => {
    if (local) local.output(value)
    else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  }

  // The sidecar's two files (#1396) have a record of their own, apart from the agent's install record, so an
  // Antigravity the connector manages can have them without setup taking over the connector's hooks. Later runs
  // keep them current; --remove takes them out. The sidecar never sees a message's text; setup never switches it on.
  const sidecarDirectory = join(home, '.gemini', 'config', 'sidecars', ANTIGRAVITY_SIDECAR_ID)
  const sidecarOnlyFiles = [join(sidecarDirectory, 'sidecar.json'), join(sidecarDirectory, 'sidecar.mjs')]
  const runSidecarOnly = (progressFile: string, isRemoving: boolean, connector: boolean): void => {
    const recorded = object(jsonInitial(sidecarRecord).files ?? {}) as Record<string, string>
    const desired = [antigravitySidecarConfig(process.execPath, progressFile, home, fileWords.antigravitySidecarDescription), antigravitySidecarSource(fileWords.antigravityWakeLine)]
    const sidecarChanges: { file: string; action: string }[] = []
    const sidecarConflicts: string[] = []
    sidecarOnlyFiles.forEach((file, i) => {
      const existing = initial(file)
      const isOwned = existing !== null && ownHash(file, existing) === recorded[file]
      if (existing !== null && !isOwned && (isRemoving || existing !== desired[i])) sidecarConflicts.push(file)
      else if (isRemoving ? isOwned : existing !== desired[i]) sidecarChanges.push({ file, action: isRemoving ? 'remove' : existing === null ? 'create' : 'update' })
    })
    const nextRecord = `${JSON.stringify({ files: Object.fromEntries(sidecarOnlyFiles.map((file, i) => [file, hash(desired[i]!)])), progress: progressFile }, null, 2)}\n`
    if (isRemoving ? initial(sidecarRecord) !== null : initial(sidecarRecord) !== nextRecord) sidecarChanges.push({ file: sidecarRecord, action: isRemoving ? 'remove' : initial(sidecarRecord) === null ? 'create' : 'update' })
    const sidecarPlan: LocalPlan & Json = {
      mode: isRemoving ? 'remove' : 'install', agent, progress: progressFile, data: root, changes: sidecarChanges, conflicts: sidecarConflicts, alreadyGone: [],
      ...(connector ? { managedBy: 'connector', script: join(dirname(progressFile), 'agent-board.mjs') } : {}),
      notice: s.setupSummary.connector.replace('{progress}', progressFile), privacy: s.codexPrivacy,
      capabilities: { lifecycle: lifecycleCapability(agent), liveReply: false },
    }
    if (args.includes('--apply') && !sidecarConflicts.length) {
      withInstallLock(home, () => {
        for (const file of before.keys()) if (!isAsPlanned(file)) throw new Error('INSTALL_CHANGED')
        // Each file is read again just before its change and checked after it (put and drop), so an edit made before
        // that last re-read is never overwritten or removed, and a change that did not land is not reported as applied.
        for (const change of sidecarChanges) {
          if (change.action === 'remove') drop(change.file)
          else put(change.file, change.file === sidecarRecord ? nextRecord : desired[sidecarOnlyFiles.indexOf(change.file)]!)
        }
      })
      if (isRemoving) try { rmdirSync(sidecarDirectory) } catch {}
      sidecarPlan.applied = true
    }
    if (args.includes('--json') || !isRemoving) output(sidecarPlan)
    else process.stdout.write(codexRemoveOutput(sidecarPlan, s, nextCommand('--codex-remove')))
    if (sidecarConflicts.length && args.includes('--apply')) throw new Error('INSTALL_CONFLICT')
  }
  const wantsSidecarOnly = agent === 'antigravity' && (args.includes('--antigravity-sidecar') || initial(sidecarRecord) !== null)
  // A remove for an Antigravity with no install record of its own: only the sidecar's files are left to take out.
  if (mode === '--codex-remove' && agent === 'antigravity' && initial(manifestFile) === null && initial(sidecarRecord) !== null) {
    runSidecarOnly(typeof jsonInitial(sidecarRecord).progress === 'string' ? jsonInitial(sidecarRecord).progress as string : progress, true, false)
    return true
  }

  // Keep the connector as the sole writer for its agents, including its next automatic probe.
  if (activeConnection?.setup?.agents.some(one => one.agent === agent && one.hook === 'configured') && initial(manifestFile) === null) {
    const connectedProgress = localProgressPath(undefined, connectorProgress!)
    const explicitProgress = flag('--progress-file')
    if (explicitProgress !== undefined && resolve(explicitProgress) !== connectedProgress) throw new Error('SHARED_BOARD_PATH_CONFLICT')
    if (args.includes('--plain') && !args.includes('--json')) {
      process.stdout.write(`${s.localSummary.removal(s.agentNames[agent] ?? agent, s.setupSummary.connector.replace('{progress}', connectedProgress))}\n${s.localSummary.connectRepair}\n`)
      return true
    }
    if (wantsSidecarOnly && !args.includes('--plain')) { runSidecarOnly(connectedProgress, false, true); return true }
    output({
      mode: 'install', agent, progress: connectedProgress, data: root, script: join(dirname(connectedProgress), 'agent-board.mjs'),
      managedBy: 'connector', changes: [], conflicts: [],
      notice: s.setupSummary.connector.replace('{progress}', connectedProgress), privacy: s.codexPrivacy,
      capabilities: { lifecycle: lifecycleCapability(agent), liveReply: false },
      ...(args.includes('--apply') ? { applied: true } : {}),
    })
    return true
  }

  if (mode === '--codex-setup' && otherManifests.some(one => typeof one.progress === 'string' && resolve(one.progress) !== progress)) throw new Error('SHARED_BOARD_PATH_CONFLICT')

  if (mode === '--codex-event' || mode === '--codex-report' || mode === '--agent-status' || mode === '--recover-hooks') {
    const isRecovery = mode === '--recover-hooks'
    // A report a hook brings in from a marked line of its conversation's transcript (#1384).
    const isMarkedReport = mode === '--codex-report' && planInput !== undefined && args.includes('--marked-report')
    const ownerToken = isRecovery ? flag('--recovery-owner-token') : undefined
    const recoveryOwner = ownerToken === undefined ? undefined : {
      token: ownerToken,
      previous: flag('--recovery-previous-token') ?? '',
      pid: Number(flag('--recovery-owner-pid')),
      created: Number(flag('--recovery-owner-created')),
    }
    let ownership: 'busy' | 'owned' | 'coalesced' = 'busy'
    const now = Date.now(), supplied = Number(flag('--hook-started'))
    // Keep the source time even after a slow launch: re-dating an old Stop can replace a newer prompt.
    const started = Number.isSafeInteger(supplied) && supplied >= 0 && supplied <= now ? supplied : now
    // The hook worker names the copy this run queues, so a worker that stops this run can tell the event is saved (#1781).
    // Read once and taken out of the environment: no board run started from here names its own copy the same.
    const suppliedQueueId = process.env.AGENT_BOARD_HOOK_QUEUE_ID
    delete process.env.AGENT_BOARD_HOOK_QUEUE_ID
    const queueId = typeof suppliedQueueId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(suppliedQueueId) ? suppliedQueueId : undefined
    const value = flag('--hook-deadline')
    const suppliedDeadline = value === undefined ? Infinity : Number(value)
    if (value !== undefined && !Number.isSafeInteger(suppliedDeadline)) throw new Error('INVALID_HOOK_DEADLINE')
    // A recovery pass has its own bound; replay keeps each stored event's source time.
    const hookDeadline = isRecovery ? Math.min(Date.now() + 1800, suppliedDeadline) : suppliedDeadline
    const checkDeadline = (): void => { if (Date.now() >= hookDeadline) throw new Error('HOOK_TIMEOUT') }
    checkDeadline()
    const raw: Json = isRecovery ? {} : planInput ?? await input()
    checkDeadline()
    type Pending = {
      version: number; progress: string; mode: string; agent: LocalAgent; session: string; now: string; at?: number
      status: unknown; event?: string; folder?: string; folderDigest?: string; folderCanonicalDigest?: string; isBoardPrompt: boolean; isDelivery?: boolean; isPrompt: boolean; payload: Json
      // Who started the session, as far as the host's own words say (#399); absent when they say nothing.
      run?: RunSignal
      antigravityIdentity?: AntigravityIdentity
      // The Codex terminal this opening event's own hook found (#1092), null when it found none; kept with the
      // event in the pending queue, removed with it once applied.
      seenClaim?: AgentClaim | null
    }
    const reportSession = (targetAgent: LocalAgent = agent): string | undefined => {
      const identity = folderIdentity(process.cwd())
      if (identity === undefined || !existsSync(join(root, 'sessions'))) return undefined
      const candidates: string[] = []
      for (const file of readdirSync(join(root, 'sessions'))) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
        try {
          const record = object(JSON.parse(readLocal(join(root, 'sessions', file)) ?? '{}'))
          const updated = Date.parse(String(record.updated))
          if (record.agent === targetAgent && matchesFolderIdentity(record, identity) && record.origin !== 'run' && (record.state === 'working' || record.state === 'waiting') && updated <= started && started - updated <= STALE_MS && typeof record.session === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/.test(record.session)) candidates.push(record.session)
        } catch {}
        if (candidates.length > 1) return undefined
      }
      return candidates.length === 1 ? candidates[0] : undefined
    }
    const buildEntry = (mode: string, agent: LocalAgent, raw: Json, flag: (name: string) => string | undefined, env: NodeJS.ProcessEnv, progress: string, at: number): Pending => {
      const payload = agent === 'cursor' && mode === '--codex-event' ? cursorEvent(raw) : raw
      const rawCwd = raw.cwd || (agent === 'cursor' && Array.isArray(raw.workspace_roots) && raw.workspace_roots.every(root => typeof root === 'string') ? raw.workspace_roots[0] : undefined) || (typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : undefined)
      // Read before Cursor's adapter drops workspace_roots; a queued raw event keeps cwd and workspace_roots for this (#246).
      const folder = filesByFolder(mode, agent) ? folderProject(rawCwd) : ''
      // Only metadata selected below is retained. Save no prompts, tool inputs,
      // or permission decisions from a hook payload, and nothing of a reply but its closing question.
      // Board approvals (#1318) are a separate route, Claude Code's plugin hook: its journal line
      // keeps the decision, the tool, the command's first words and its hash, never the command.
      // The plan mirror is the
      // one place a tool input is read (--plan-event, before this): only each step's text and status,
      // which a report carries. transcript_path is
      // opened, when it is this session's own history file, for its first record at a session's
      // start or prompt, which says whether a person started it (#399). Antigravity's own transcript
      // supplies its last reply at Stop because its hook does not include that text.
      const session = mode !== '--codex-report'
        ? agent === 'antigravity'
          ? (typeof payload.conversationId === 'string' ? payload.conversationId : payload.session_id ?? payload.sessionId ?? payload.sessionID)
          : payload.session_id ?? payload.sessionId ?? payload.sessionID ?? (agent === 'grok' ? env.GROK_SESSION_ID : undefined)
        : flag('--session') ?? (agent === 'codex' ? env.CODEX_THREAD_ID ?? reportSession() : (env.AGENT_BOARD_AGENT === agent ? env.AGENT_BOARD_SESSION_ID : undefined) ?? (agent === 'hermes' ? env.HERMES_SESSION_ID || undefined : undefined) ?? (agent === 'grok' ? env.GROK_SESSION_ID || undefined : undefined) ?? reportSession())
      if (session === undefined && mode === '--codex-report') throw new Error('UNBOUND_REPORT')
      if (typeof session !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/.test(session)) throw new Error('INVALID_SESSION')
      const now = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')
      if (mode === '--agent-status' && (agent === 'codex' || agent === 'cursor')) throw new Error('INVALID_EVENT')
      const status = flag('--state') ?? payload.state
      if (mode === '--agent-status' && !['working', 'waiting', 'ended'].includes(String(status))) throw new Error('INVALID_STATE')
      const event = agent === 'antigravity' && mode === '--agent-status' ? flag('--event') : undefined
      if (event !== undefined && (event === 'StopWait' ? 'waiting' : statusEvents.antigravity?.[event]) !== status) throw new Error('INVALID_EVENT_STATE')
      // Classify before Cursor's adapter drops prompt text; retain lifecycle
      // ordering without treating a board lookup as an answer to the question.
      const isPromptLike = isPromptEvent(raw) || raw.prompt_submitted === true
      const isBoardCommand = isPromptLike && (raw.board_request === true || isBoardRequest(raw, boardRequestWords(Object.values(STRINGS))))
      // A delivered board message is not the person's reply, yet the turn it starts is real work: its closing question still counts.
      const isDelivery = isPromptLike && !isBoardCommand && (raw.delivery_request === true || isBoardRequest(raw, deliveryRequestWords(Object.values(STRINGS))))
      const isBoardPrompt = isBoardCommand || isDelivery
      // No longer changes any step (#243); kept so events queued by an older version still validate.
      const isPrompt = !isBoardPrompt && mode === '--agent-status' && status === 'working' && (payload.prompt_submitted === true || /^(?:UserPromptSubmit|user_prompt_submit|BeforeAgent)$/.test(String(payload.hook_event_name ?? payload.hookEventName)))
      // Only Codex says it, and only as a session opens or takes a prompt; the other local agents
      // give no signal, so their sessions stay rows as they were.
      const opens = agent === 'codex' && mode === '--codex-event' && /^(?:SessionStart|UserPromptSubmit)$/.test(String(payload.hook_event_name))
      const path = payload.transcript_path
      const run = opens ? codexSignal(Object.hasOwn(payload, 'transcript_path'), path, typeof path === 'string' && path !== '' ? readSessionMeta(path, session) : null) : undefined
      const identity = mode !== '--codex-report' ? folderIdentity(rawCwd) : undefined
      // A queued event keeps only metadata and the closing question, not the host's other fields.
      // Hermes carries the turn's reply under extra, on post_llm_call only (#1115).
      const hermesReply = agent === 'hermes' && raw.hook_event_name === 'post_llm_call' && typeof raw.extra === 'object' && raw.extra !== null && !Array.isArray(raw.extra) ? (raw.extra as Json).assistant_response : undefined
      const message = typeof raw.last_assistant_message === 'string' ? raw.last_assistant_message : typeof raw.lastAssistantMessage === 'string' ? raw.lastAssistantMessage : typeof hermesReply === 'string' ? hermesReply : ''
      const hasResponse = agent === 'codex' && raw.hook_event_name === 'Stop' && message.trim() !== ''
        || agent === 'cursor' && raw.hook_event_name === 'afterAgentResponse' && typeof raw.text === 'string' && raw.text.trim() !== ''
      const question = mode === '--codex-event' && agent === 'codex' && raw.hook_event_name === 'Stop' ? lastQuestion(String(raw.last_assistant_message ?? ''))
        : mode === '--codex-event' && agent === 'cursor' && raw.hook_event_name === 'afterAgentResponse' ? lastQuestion(String(raw.text ?? ''))
          : mode === '--agent-status' && status === 'waiting' && (agent === 'grok' || agent === 'opencode' || agent === 'hermes') ? lastQuestion(message)
            : mode === '--agent-status' && status === 'waiting' && agent === 'antigravity' && (event === undefined || event === 'Stop') ? antigravityQuestion(raw.transcriptPath) : null
      const antigravityTitle = mode === '--agent-status' && agent === 'antigravity'
        ? resolveAntigravityTitle(session, raw.transcriptPath, raw.artifactDirectoryPath, home)
        : null
      return {
        version: 1, progress, mode, agent, session, now, at, status: mode === '--agent-status' ? status : undefined, event, isBoardPrompt, ...(isDelivery ? { isDelivery } : {}), isPrompt,
        ...(filesByFolder(mode, agent) ? { folder } : {}),
        ...(identity !== undefined && (agent !== 'codex' || folderProject(rawCwd) !== '') ? identity : {}),
        ...(run === undefined ? {} : { run }),
        payload: mode === '--codex-report' ? payload : mode === '--codex-event' ? {
          session_id: payload.session_id, hook_event_name: payload.hook_event_name,
          turn_id: payload.turn_id, prompt_submitted: payload.prompt_submitted,
          ...(hasResponse ? { has_response: true } : {}),
          // The end of a `codex exec` run the board started for a Codex app conversation (#557), told by the board's mark.
          ...(agent === 'codex' && payload.hook_event_name === 'SessionEnd' && env[BACKGROUND_TURN_ENV] === '1' ? { background_turn: true } : {}),
          ...(question === null ? {} : { question }),
        } : {
          ...(antigravityTitle === null ? {} : antigravityTitle),
          ...(question === null ? {} : { question }),
        },
      }
    }
    const current = isRecovery ? undefined : buildEntry(mode, agent, raw, flag, process.env, progress, started)
    // The OpenCode process this event ran under (#1595), only for this process's own event from the hook worker.
    // The Codex terminal (#1092): only a live opening event from the hook walks to it, and only on Linux.
    const isLiveHook = current !== undefined && flag('--hook-deadline') !== undefined
    const codexEventName = agent === 'codex' && mode === '--codex-event' ? String(current?.payload.hook_event_name ?? '') : undefined
    const liveClaim = !isLiveHook ? null
      : agent === 'opencode' ? hookParentClaim(process.env.AGENT_BOARD_HOOK_PARENT, readingHostHash())
        : codexEventName === 'SessionStart' || codexEventName === 'UserPromptSubmit' ? codexProcessClaim() : null
    // A Codex opening event keeps what its walk found, so a replay from the pending queue applies the same record.
    if (current !== undefined && isLiveHook && (codexEventName === 'SessionStart' || codexEventName === 'UserPromptSubmit')) current.seenClaim = liveClaim
    const antigravityDecision = (entry: Pending, payloadRaw: Json, allowProcWalk: boolean): AntigravityIdentity | undefined => {
      if (entry.agent !== 'antigravity' || entry.mode !== '--agent-status') return undefined
      const surface = antigravitySurface(payloadRaw.transcriptPath, payloadRaw.artifactDirectoryPath)
      if (surface === SURFACE_IDS.antigravityIde) return { kind: 'clear' }
      if (surface === SURFACE_IDS.antigravityTui) {
        if (allowProcWalk) {
          const found = antigravityProcessClaim(readingHostHash())
          if (found !== null) return { kind: 'claim', claim: found }
        }
        if (process.platform === 'win32') {
          const host = readingHostHash()
          if (host !== null) return { kind: 'host', host }
        }
      }
      return entry.event === 'SessionStart' || entry.event === 'PreInvocation' ? { kind: 'clear' } : undefined
    }
    if (current !== undefined && flag('--hook-deadline') !== undefined) {
      const agyId = antigravityDecision(current, raw, true)
      if (agyId !== undefined) current.antigravityIdentity = agyId
    }
    const isInferredReport = mode === '--codex-report' && flag('--session') === undefined && (agent === 'codex' ? process.env.CODEX_THREAD_ID === undefined : !(process.env.AGENT_BOARD_AGENT === agent && process.env.AGENT_BOARD_SESSION_ID !== undefined) && !(agent === 'hermes' && process.env.HERMES_SESSION_ID) && !(agent === 'grok' && process.env.GROK_SESSION_ID))
    const rawEntry = (raw: Json): Pending => {
      if (raw.version !== 1 || raw.kind !== 'raw' || !Number.isSafeInteger(raw.at) || Number(raw.at) < 0 || Number(raw.at) > Date.now() + 60000) throw new Error('INVALID_RAW_ENTRY')
      if (!Array.isArray(raw.argv) || !raw.argv.every(value => typeof value === 'string')) throw new Error('INVALID_RAW_ARGV')
      const argv = raw.argv as string[]
      const entryMode = argv[0]
      if (entryMode !== '--codex-event' && entryMode !== '--agent-status') throw new Error('INVALID_RAW_MODE')
      const flags = new Map<string, string>()
      const allowed = ['--agent', '--state', '--event', '--hook-event', '--progress-file']
      for (let index = 1; index < argv.length; index += 2) {
        const name = argv[index]!, value = argv[index + 1]
        if (!allowed.includes(name) || flags.has(name) || !value || value.startsWith('--')) throw new Error('INVALID_RAW_ARGV')
        flags.set(name, value)
      }
      const entryAgent = flags.get('--agent') as LocalAgent
      if (!localAgents.includes(entryAgent) || !flags.has('--progress-file')) throw new Error('INVALID_RAW_ARGV')
      const isCodexEvent = entryMode === '--codex-event'
      if (!isCodexEvent && (entryAgent === 'codex' || entryAgent === 'cursor') || isCodexEvent && flags.has('--state')) throw new Error('INVALID_RAW_ARGV')
      if (entryAgent !== 'antigravity' && flags.has('--event')) throw new Error('INVALID_RAW_ARGV')
      const hookEvent = flags.get('--hook-event')
      if (hookEvent !== undefined) {
        const events = entryAgent === 'codex' ? codexEvents : entryAgent === 'cursor' ? Object.keys(cursorEvents) : Object.keys(statusEvents[entryAgent] ?? {})
        if (!events.some(event => event === hookEvent) || !isCodexEvent && statusEvents[entryAgent]?.[hookEvent] !== (flags.get('--state') ?? object(raw.payload).state) || flags.has('--event') && hookEvent !== flags.get('--event')) throw new Error('INVALID_RAW_ARGV')
      }
      const env = object(raw.env)
      if (Object.entries(env).some(([name, value]) => !(HOOK_SESSION_ENV[entryAgent] ?? []).includes(name) || typeof value !== 'string')) throw new Error('INVALID_RAW_ENV')
      const payload = object(raw.payload)
      const entry = buildEntry(entryMode, entryAgent, payload, name => flags.get(name), env as NodeJS.ProcessEnv, resolve(flags.get('--progress-file')!), Number(raw.at))
      const agyId = antigravityDecision(entry, payload, false)
      if (agyId !== undefined) entry.antigravityIdentity = agyId
      return entry
    }
    // A program holding progress.md open makes Windows refuse its read (EBUSY) and the rename
    // onto it (EPERM). A read-only progress.md fails the rename with the same EPERM, so its
    // read-only flag tells it apart and it fails. A refusal from the file's access list is
    // not told apart and is treated as a lock.
    const isWritable = (): boolean => {
      try { return (statSync(progress).mode & 0o200) !== 0 } catch { return true }
    }
    const isBusy = (error: unknown): boolean => {
      const failure = error as { code?: string; syscall?: string; dest?: string } | null
      const isLockedRename = process.platform === 'win32' && failure?.code === 'EPERM' && failure.syscall === 'rename' && typeof failure.dest === 'string' && resolve(failure.dest) === progress && isWritable()
      return failure?.code === 'EBUSY' || failure?.code === 'EAGAIN' || isLockedRename || error instanceof Error && error.message === 'LOCK_BUSY'
    }
    const withdrawRunBlock = (owner: string): void => {
      const before = readBytes(progress)
      if (before === null) return
      const next = Buffer.from(dropCodexBlock(before.toString('latin1'), owner), 'latin1')
      if (!next.equals(before)) atomic(progress, next, checkDeadline)
    }
    let isFirstSessionEvent = false
    let reportCut = 0
    let reportDropped = 0
    // Set once this call's own report or event is on the board: a refusal after that is no reason to keep it (#1384).
    let isBoardWritten = false
    const apply = (entry: Pending, isRawReplay = false): CodexReport => {
      const { mode, agent, session, now, at, status, event, folder = '', folderDigest, folderCanonicalDigest, isBoardPrompt, isDelivery = false, payload, run } = entry
      const displayAt = Date.parse(now)
      const sourceAt = at ?? displayAt
      const observedAt = Date.now()
      const owner = hash(`${agent}:${session}`)
      const recordFile = join(root, 'sessions', `${owner}.json`)
      const saved = readLocal(recordFile)
      const original = saved === null ? null : JSON.parse(saved) as CodexReport & { appliedAt?: number; pushed?: string[]; reportedAt?: unknown }
      // Raw recovery can start a fresh session within its allowed clock skew.
      // An existing session's clock must not move past the next real hook.
      const isSkewedBootstrap = isRawReplay && original === null
      if (mode === '--codex-event' && (!Number.isFinite(sourceAt) || !Number.isFinite(displayAt) ||
        !isSkewedBootstrap && (sourceAt > observedAt || displayAt > observedAt))) throw new Error('INVALID_EVENT_TIME')
      if (entry === current && original === null) isFirstSessionEvent = true
      if (original?.agent && original.agent !== agent) throw new Error('SESSION_CONFLICT')
      // A marked report no newer than the conversation's last report is not applied: one with the same time is that
      // report, read again (#1384). The time is the conversation's, kept in this record, which every report of the
      // conversation writes whatever name of its board's file it was given, so no name of the file gets a newer report past
      // it. An earlier build kept a time for each board; that form reads as none.
      const reportedAt = typeof original?.reportedAt === 'number' && Number.isFinite(original.reportedAt) ? original.reportedAt : undefined
      if (isMarkedReport && entry === current && reportedAt !== undefined && sourceAt <= reportedAt) return original
      // A marked report over a day old by a clock read after the record is refused too, as the hook refuses an older line.
      if (isMarkedReport && entry === current && Date.now() - sourceAt > MARK_MAX_AGE) throw new Error('MARK_TOO_OLD')
      // Direct events can arrive out of order too, before they ever enter the pending queue.
      if (mode !== '--codex-report' && original !== null && sourceAt < (original.appliedAt ?? Date.parse(original.updated))) {
        const signal = cleanSignal(run)
        // A newer explicit person statement is never undone by older run proof.
        if (signal === undefined || !isStrongRun(signal) || isStrongRun(original) || original.origin === 'person' && original.isWeak !== true) return original
        // Origin proof can arrive late without reopening an older lifecycle event.
        const { isWeak: _isWeak, ...kept } = original
        const report = { ...kept, origin: 'run' as const, ...(signal.parent === undefined ? {} : { parent: signal.parent }) }
        withdrawRunBlock(owner)
        atomic(recordFile, `${JSON.stringify(report, null, 2)}\n`, checkDeadline, true)
        return report
      }
      const history = agent === 'codex' && mode === '--codex-report' && original === null ? findSessionFile(dirname(configs.codex!), session) : null
      const meta = history === null ? null : readSessionMeta(history, session)
      const origin = withSignal(original, cleanSignal(run) ?? (meta === null ? undefined : codexSignal(true, history, meta)))
      const isRun = isStrongRun(origin)
      const bytes = isRun ? Buffer.alloc(0) : readBytes(progress) ?? Buffer.alloc(0)
      const text = bytes.toString('utf8')
      const previous = original === null || mode === '--codex-report' || isRun ? original : boardConfirmedReport(text, original, owner)
      const clock = previous === null ? now : new Date(Math.max(displayAt, Date.parse(previous.updated))).toISOString()
      const isGenericTitle = (title: string): boolean => isGenericTitleOf(agent, title)
      const given = reportPlan(payload, previous, agent)
      // A reply that ends on a question waits for the person, even after the agent reported its own steps done.
      const state = isBoardPrompt && previous ? previous.state : status === 'working' ? 'working' : previous?.state === 'done' && !(typeof payload.question === 'string' && payload.question.trim() !== '') ? 'done' : status
      const placeholder = localAgentLifecycleStep(state, s)
      const held = !Array.isArray(previous?.steps)
        ? [placeholder]
        : previous.steps.map((step, index) =>
            index === 0 && isLifecycleStep(step)
              ? state === 'done' && /^- \[[x\-]\]/.test(step)
                ? step
                : placeholder
              : step
          )
      const question = questionSteps(held, previous?.asked, state, payload.question, isBoardPrompt, previous?.askedRevision, false, payload.options, previous?.askedOptions)
      // Keep the recovery format. Causality uses the host event's milliseconds,
      // which the display clock can round or carry forward.
      const base = mode === '--codex-event' ? codexEvent(previous, isDelivery ? { ...payload, delivery_request: true } : isBoardPrompt ? { ...payload, board_request: true } : payload, clock, s, sourceAt, { lastAppliedAt: original?.appliedAt, observedAt })
        : mode === '--agent-status' ? validateCodexReport({
          // These are already validated stored steps, including up to two owned lines beyond
          // the explicit report's forty user steps. A status is not a fresh task report.
          ...(previous ?? codexReport(null, session, { title: s.localAgentTask(agent), project: agent, state, steps: question.steps }, clock, s)),
          state: state as CodexReport['state'], steps: question.steps, updated: clock, asked: question.asked,
          ...(question.askedRevision === undefined ? {} : { askedRevision: question.askedRevision }),
          askedOptions: question.askedOptions,
        }, session) : codexReport(previous, session, given, clock, s)
      // A queued folder is cleaned again: the queue file is not trusted to hold a clean name.
      const name = folderProject(folder)
      // Antigravity hooks carry no folder or title (#814, #1401): name each row by the client's
      // conversation summary title, else the clipped first line of its first prompt, else the
      // fallback name, and keep its millisecond start time as secondary context text.
      const antigravityState = (() => {
        if (mode !== '--agent-status' || agent !== 'antigravity') return null
        const startedAt = previous === null
          ? sourceAt
          : previous.startedAt ?? legacyStartedAt(previous.title, agent) ?? (Number.isFinite(Date.parse(previous.updated)) ? Date.parse(previous.updated) : undefined) ?? sourceAt
        const isGeneric = previous !== null && isGenericTitle(previous.title)
        const isExplicit = previous !== null && !isGeneric && previous.titleSource !== 'fallback' && previous.titleSource !== 'prompt' && previous.titleSource !== 'summary'
        const context = isExplicit && previous.context ? previous.context : s.localAgentStarted(distinctStarted(startedAt))
        const incoming = typeof payload.title === 'string' && (payload.titleSource === 'summary' || payload.titleSource === 'prompt') ? { title: payload.title, source: payload.titleSource } : null
        const picked: { title: string; titleSource: CodexReport['titleSource'] } = isExplicit
          ? { title: previous.title, titleSource: previous.titleSource }
          : incoming?.source === 'summary'
            ? { title: incoming.title, titleSource: 'summary' }
            : previous?.titleSource === 'summary' && !isGeneric
              ? { title: previous.title, titleSource: 'summary' }
              : incoming?.source === 'prompt'
                ? { title: incoming.title, titleSource: 'prompt' }
                : previous?.titleSource === 'prompt' && !isGeneric
                  ? { title: previous.title, titleSource: 'prompt' }
                  : { title: sessionTitle(name, s.localAgentTask(agent)), titleSource: 'fallback' }
        return { ...picked, startedAt, context }
      })()
      const initial = antigravityState !== null ? validateCodexReport({
        ...base, ...antigravityState, project: previous?.project ?? (name || agent),
      }, session) : filesByFolder(mode, agent) && !previous ? validateCodexReport({
        ...base, title: sessionTitle(name, s.localAgentTask(agent)), project: previous?.project ?? (name || agent),
      }, session) : mode === '--codex-report' ? {
        ...base, titleSource: typeof payload.planTitle === 'string'
          ? (previous !== null && !isGenericTitle(previous.title) && previous.titleSource !== 'fallback' && previous.titleSource !== undefined ? previous.titleSource : 'plan' as const)
          : 'report' as const,
      } : base
      const priorActivity = previous?.activity ?? []
      // Only a weak hint needs a parent; a strong run keeps its record without a block.
      const parent = origin.origin !== 'run' ? undefined : isRun ? origin.parent : origin.parent ?? pickParent(parseProgress(text), initial.project, Date.parse(clock), [owner, owner.slice(0, 8), session]) ?? undefined
      const marked = { ...(origin.origin === undefined ? {} : { origin: origin.origin }), ...(parent === undefined ? {} : { parent }), ...(origin.isWeak === true ? { isWeak: true as const } : {}) }
      const { origin: _origin, parent: _parent, isWeak: _isWeak, ...lifecycle } = initial
      const directory = agent === 'codex' && mode === '--codex-event' && name !== ''
        ? { folder: name, folderDigest, folderCanonicalDigest }
        : { folder: original?.folder, folderDigest: folderDigest ?? original?.folderDigest,
          folderCanonicalDigest: folderDigest === undefined ? original?.folderCanonicalDigest : folderCanonicalDigest }
      const full = { ...lifecycle, ...marked, ...directory, appliedAt: Math.max(sourceAt, original?.appliedAt ?? (original === null ? displayAt : Date.parse(original.updated))), ...(original?.pushed === undefined ? {} : { pushed: original.pushed }), ...(agent === 'antigravity' && mode === '--codex-report' ? { reportedAt: Math.max(sourceAt, reportedAt ?? 0) } : reportedAt === undefined ? {} : { reportedAt }), ...(isBoardPrompt && previous ? { state: previous.state, steps: previous.steps, ...(previous.approval === undefined ? {} : { approval: previous.approval }), ...(previous.asked === undefined ? {} : { asked: previous.asked }), ...(previous.askedOptions === undefined ? {} : { askedOptions: previous.askedOptions }) } : {}), agent, ...(event === undefined ? {} : { activity: [...priorActivity, { event, state: String(status), updated: clock }].slice(-16) }) }
      const { report, entries, cut } = limitReport(full)
      if (entry === current) {
        reportCut = cut
        reportDropped = mode === '--codex-report' && Array.isArray(given.steps) ? Math.max(0, given.steps.length - 40) : 0
      }
      const saveFullText = (): void => {
        if (entries.length === 0) return
        const now = Date.parse(clock)
        const journal = currentPart(journalPath(progress, now), file => {
          try { return statSync(file).size } catch (error) {
            if ((error as { code?: string }).code === 'ENOENT') return null
            throw error
          }
        })
        // Everything after the minute stamp: the same overflow reported again is not new.
        const tail = (line: string): string => line.replace(/^(?:> )?- \d{4}-\d{2}-\d{2} \d{2}:\d{2} · /, '')
        const changed = new Error('JOURNAL_CHANGED')
        let hasRaced = false
        // The board's own writers (a done or tick press) share this file. Read it again just
        // before the replace and again after it; when it moved, work from the new text so a
        // line another writer added survives. checkDeadline bounds the retries.
        for (;;) {
          checkDeadline()
          const past = readLocal(journal) ?? ''
          // Test-only seam: lands one line from another writer between this read and the replace.
          const racing = process.env.AGENT_BOARD_TEST_JOURNAL_RACE
          if (racing !== undefined && !hasRaced) {
            hasRaced = true
            writeFileSync(journal, appendJournal(past, [racing], s))
          }
          const seen = new Set(past.split(/\r?\n/).map(tail))
          // Overflow is evidence of the report, not a newly completed step.
          const lines = entries.map(entry => `> ${journalLine(entry, now, s)}`).filter(line => !seen.has(tail(line)))
          const next = appendJournal(past, lines, s)
          if (next === past) return
          try {
            atomic(journal, next, () => {
              checkDeadline()
              if ((readLocal(journal) ?? '') !== past) throw changed
            })
          } catch (error) {
            if (error === changed) continue
            throw error
          }
          if (readLocal(journal) === next) return
        }
      }
      if (isRun) {
        // A lazy history file can prove that a block written from a hint is a run.
        // Once the record is strong, later reports still never read the board.
        saveFullText()
        if (original !== null && !isStrongRun(original)) withdrawRunBlock(owner)
        atomic(recordFile, `${JSON.stringify(report, null, 2)}\n`, checkDeadline, true)
        return report
      }
      // A replay can skip writes only after a board completion reached the cache too.
      // A new hook event is not a replay even when the block reads the same: its record keeps the event.
      const repaired = reporterTail(bytes)
      const named = blockClaimOf(text, owner, agent, session)
      const namedHost = agent === 'antigravity' ? blockHostOf(text, owner, agent, session) : null
      const { claim, hostOnly } = agent === 'antigravity'
        ? resolveAntigravityIdentity(cleanAntigravityIdentity(entry.antigravityIdentity) ?? undefined, named, namedHost)
        : agent === 'codex'
          ? { claim: codexClaimOf({ event: mode === '--codex-event' ? String(payload.hook_event_name ?? '') : undefined, seen: seenClaimOf(entry.seenClaim), named }), hostOnly: null }
          : { claim: entry === current && liveClaim !== null ? liveClaim : named, hostOnly: null }
      const namedHostOnly = named === null ? namedHost : null
      if (repaired.fragment === null && mode !== '--codex-report' && claimText(named) === claimText(claim) && namedHostOnly === hostOnly && previous === original && original !== null && previous !== null && previous.state === report.state && previous.turn === report.turn && previous.title === report.title && previous.context === report.context && previous.startedAt === report.startedAt && previous.titleSource === report.titleSource && JSON.stringify(previous.steps) === JSON.stringify(report.steps) && JSON.stringify(previous.askedOptions ?? null) === JSON.stringify(report.askedOptions ?? null) && JSON.stringify(previous.events) === JSON.stringify(report.events) && JSON.stringify(previous.retiredTurns) === JSON.stringify(report.retiredTurns) && previous.origin === report.origin && previous.parent === report.parent && previous.isWeak === report.isWeak && previous.folder === report.folder && previous.folderDigest === report.folderDigest && previous.folderCanonicalDigest === report.folderCanonicalDigest && (event === undefined || priorActivity.at(-1)?.event === event)) {
        if (report.appliedAt > (original.appliedAt ?? Date.parse(original.updated))) atomic(recordFile, `${JSON.stringify({ ...original, appliedAt: report.appliedAt }, null, 2)}\n`, checkDeadline, true)
        return report
      }
      // Encode only the new report; existing bytes, including partial UTF-8, pass through unchanged.
      const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('latin1')
      const next = Buffer.from(putCodexBlock(repaired.bytes.toString('latin1'), {
        ...report, title: encoded(report.title), project: encoded(report.project), ...(report.context === undefined ? {} : { context: encoded(report.context) }), steps: report.steps.map(encoded),
      }, owner, mode === '--codex-report' && previous !== null && previous.project !== report.project, report.context === undefined ? undefined : encoded(s.contextNote(report.context)), encoded, claim, hostOnly), 'latin1')
      saveFullText()
      const aside = repaired.fragment === null ? null : saveReporterTail(progress, repaired.fragment)
      try { atomic(progress, next, checkDeadline) } catch (error) {
        if (aside !== null) {
          try { unlinkSync(aside) } catch {}
        }
        throw error
      }
      if (entry === current) isBoardWritten = true
      // Once progress.md holds the event the session record follows it even past the
      // deadline: a record left behind would make the next Stop fail as a stale turn.
      atomic(recordFile, `${JSON.stringify(report, null, 2)}\n`, undefined, true)
      return report
    }
    const pending = join(root, 'pending')
    const pendingFiles = (): string[] => existsSync(pending) ? readdirSync(pending).filter(name => name.endsWith('.json')).sort() : []
    const readPending = (file: string): Json => {
      // Native input is at most 1 MiB. Allow its metadata envelope, not an unbounded file.
      if (statSync(file).size > 2 * 1024 * 1024) throw Object.assign(new Error('PENDING_FILE_TOO_LARGE'), { code: 'E2BIG' })
      const text = readFileSync(file, 'utf8')
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Object.assign(new Error('PENDING_FILE_TOO_LARGE'), { code: 'E2BIG' })
      return object(JSON.parse(text))
    }
    // A queued entry passes the same checks a live event passes above before it is applied.
    const isHookEntry = (entry: Pending): boolean =>
      (entry.mode === '--codex-event' || entry.mode === '--agent-status' && entry.agent !== 'codex' && entry.agent !== 'cursor' && ['working', 'waiting', 'ended'].includes(String(entry.status)))
      && localAgents.includes(entry.agent) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/.test(String(entry.session))
      && typeof entry.now === 'string' && typeof entry.isPrompt === 'boolean' && typeof entry.isBoardPrompt === 'boolean'
      && (entry.folder === undefined || typeof entry.folder === 'string')
      && (entry.folderDigest === undefined || typeof entry.folderDigest === 'string' && /^[a-f0-9]{64}$/.test(entry.folderDigest))
      && (entry.folderCanonicalDigest === undefined || typeof entry.folderCanonicalDigest === 'string' && /^[a-f0-9]{64}$/.test(entry.folderCanonicalDigest))
      && (!Object.hasOwn(entry, 'at') || typeof entry.at === 'number' && Number.isFinite(entry.at))
      && (entry.event === undefined || entry.agent === 'antigravity' && entry.mode === '--agent-status' && statusEvents.antigravity?.[entry.event] === entry.status)
      // A live event's own session_id is either missing or the session it is filed under.
      && (entry.mode !== '--codex-event' || [undefined, entry.session].includes(object(entry.payload).session_id as string | undefined))
      && (entry.antigravityIdentity === undefined || entry.agent === 'antigravity' && entry.mode === '--agent-status' && cleanAntigravityIdentity(entry.antigravityIdentity) !== null)
      && (object(entry.payload).options === undefined || Array.isArray(object(entry.payload).options) && (object(entry.payload).options as unknown[]).every(value => typeof value === 'string'))
    // Raw Codex events can precede a newer turn too. Milliseconds settle events in
    // the same second; older records and pending entries retain their timestamp fallback.
    const isOverdue = (entry: Pending): boolean => {
      const saved = readLocal(join(root, 'sessions', `${hash(`${entry.agent}:${entry.session}`)}.json`))
      if (saved === null) return false
      const record = object(JSON.parse(saved))
      return (entry.at ?? Date.parse(entry.now)) < (typeof record.appliedAt === 'number' ? record.appliedAt : Date.parse(String(record.updated)))
    }
    // Only hooks have the 2.4 s cap to stay within their 3 s timeout.
    const retryDeadline = mode === '--codex-report' || isRecovery ? performance.now() + 1800 : Math.min(performance.now() + 1800, 2400)
    const inheritedDeadline = performance.now() + (hookDeadline - Date.now())
    // Stop 200 ms before the inherited deadline, when the hook worker kills this process:
    // a process killed while holding the board lock blocks every hook until the lock goes stale.
    const deadline = Math.min(retryDeadline, inheritedDeadline - 200)
    let queuedFile: string | undefined
    const queue = (error: unknown): void => {
      if (current === undefined || queuedFile !== undefined) return
      mkdirSync(pending, { recursive: true })
      if (pendingFiles().length >= 64) throw error
      const file = join(pending, `${String(started).padStart(15, '0')}-${queueId ?? randomUUID()}.json`)
      atomic(file, `${JSON.stringify(current)}\n`, checkDeadline)
      queuedFile = file
    }
    // A board that refuses writes, for its lock or any file under it, as agy's terminal sandbox does (#1384).
    const isDenied = (error: unknown): boolean => !isBusy(error)
      && (error instanceof Error && error.message === 'LOCK_DENIED' || ['EACCES', 'EPERM', 'EROFS'].includes(String((error as { code?: unknown } | null)?.code)))
    // An Antigravity report bound to its conversation that the board refused, or could not take in time, is printed as
    // one marked line for the conversation's next hook (#1384). The plan is checked first, as its replay applies it, so
    // one the board would refuse fails now instead of being dropped unseen at that hook. A report too large for one line
    // is not printed, and one the board already holds is not kept: its refusal is the answer.
    const markReport = (error: unknown): boolean => {
      if (mode !== '--codex-report' || agent !== 'antigravity' || planInput !== undefined || flag('--session') === undefined || current === undefined || isBoardWritten) return false
      if (!isDenied(error) && !isBusy(error) && !(error instanceof Error && error.message === 'HOOK_TIMEOUT')) return false
      // A board folder that is not there names no board the hook would name the same way: the refusal stands.
      const board = boardOf(progress, loaded.progress)
      if (board === undefined) return false
      let original: CodexReport | null = null
      try { original = JSON.parse(readLocal(join(root, 'sessions', `${hash(`antigravity:${current.session}`)}.json`)) ?? 'null') as CodexReport | null } catch {}
      if (original?.agent && original.agent !== agent) throw new Error('SESSION_CONFLICT')
      codexReport(original, current.session, reportPlan(current.payload, original, agent), new Date(started).toISOString(), s)
      const line = markLine(current.session, board, started, raw)
      if (line === undefined) throw new Error('REPORT_TOO_LARGE')
      process.stdout.write(`${line}\n`)
      output({ session: current.session, kept: true, progress, note: s.reportKept })
      return true
    }
    // The conversation's next hook, which runs outside the sandbox, brings the last marked line of its own transcript in
    // as the report it was, with its own time (#1384). The conversation's `reportedAt` in its session record keeps it from
    // being applied twice or over a newer report. A board that cannot take it yet leaves it for the next hook; a report the board refuses is
    // dropped. Where the read ended is kept, so the next hook reads only what came after.
    const bringMarkedReport = async (conversation: string): Promise<void> => {
      const path = raw.transcriptPath
      // The data folder can serve more than one board: each board reads the conversation's lines from where it last ended.
      const board = boardOf(progress, loaded.progress)
      // A board folder that is not there yet names no board: the lines wait, unread, for a hook after it is made.
      if (board === undefined) return
      const offsetFile = join(root, 'antigravity-reports', `${hash(`antigravity:${conversation}:${board}`)}.json`)
      let from: number | undefined
      try {
        const kept = object(JSON.parse(readLocal(offsetFile) ?? '{}'))
        if (kept.version === 1 && typeof path === 'string' && kept.file === resolve(path) && Number.isSafeInteger(kept.offset) && Number(kept.offset) >= 0) from = Number(kept.offset)
      } catch {}
      const read = antigravityMarkedLines(path, conversation, home, from)
      if (read === null) return
      if (read.stray > 0) logPendingDrop(home, { agent, event: current?.event }, 'MARK_OUTSIDE_OUTPUT')
      const now = Date.now()
      const marks = read.lines.map(readMark).filter((one): one is NonNullable<ReturnType<typeof readMark>> => one !== undefined && one.session === conversation && one.at <= now && now - one.at <= MARK_MAX_AGE)
      const mark = marks.filter(one => one.board === board).at(-1)
      // Lines for this conversation that name only another board are logged, so a board named two ways shows up.
      if (mark === undefined && marks.length > 0) logPendingDrop(home, { agent, event: current?.event }, 'MARK_OTHER_BOARD')
      if (mark !== undefined) {
        try {
          await runCodexLocal(['--codex-report', '--agent', 'antigravity', '--session', conversation, '--progress-file', progress, '--home', home, '--data-dir', root,
            '--hook-started', String(mark.at), '--hook-deadline', String(Math.min(hookDeadline - 1500, Date.now() + 900)), '--marked-report'], boardPath, s, mark.raw)
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code
          if (isBusy(error) || isDenied(error) || error instanceof Error && error.message === 'HOOK_TIMEOUT' || typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) return
        }
      }
      // A conversation with no marked line keeps no file: each hook reads the transcript's last 256 KiB. Once one is
      // read, where the read ended is kept and moved on.
      if (read.lines.length === 0 && (from === undefined || read.end === from)) return
      try {
        mkdirSync(dirname(offsetFile), { recursive: true })
        atomic(offsetFile, `${JSON.stringify({ version: 1, file: resolve(path as string), offset: read.end })}\n`, checkDeadline)
      } catch {}
    }
    if (mode === '--agent-status' && agent === 'antigravity' && current?.event === 'StopWait') {
      const delivered = await deliverAntigravityStopWait({
        session: current.session, raw, progress, home, root, hookDeadline, s, hash, readLocal, atomic, checkDeadline,
      })
      if (!delivered) output({})
      return true
    }
    if (mode === '--agent-status' && agent === 'antigravity' && planInput === undefined && current !== undefined) await bringMarkedReport(current.session)
    let delay = 50
    let processed = 0
    let report: CodexReport | undefined
    for (;;) {
      try {
        checkDeadline()
        report = withLocalLock(`${progress}.agent-board-lock`, () => {
          checkDeadline()
          if (recoveryOwner !== undefined) {
            ownership = claimHookRecovery(root, progress, recoveryOwner) ? 'owned' : 'coalesced'
            if (ownership === 'coalesced') return
          }
          // Interrupted queue writes are disposable only after active writers have had time to finish.
          if (existsSync(pending)) for (const name of readdirSync(pending).filter(name => name.endsWith('.tmp'))) {
            checkDeadline()
            const file = join(pending, name)
            // Best effort: a temporary file a scanner holds open must not fail the hook and lose its event.
            try {
              const info = statSync(file)
              if (info.isFile() && info.mtimeMs < Date.now() - 60000) unlinkSync(file)
            } catch {}
          }
          // A hook with a backlog to replay saves its own event first: if the replay runs out
          // of time, the queue write itself would be past the deadline and the event lost.
          const backlog = pendingFiles().length
          if (value !== undefined && mode !== '--codex-report' && backlog > 0 && backlog < 64) queue(Object.assign(new Error('LOCK_BUSY'), { code: 'EBUSY' }))
          // Queued events go first, oldest first, so every session's events land in the order
          // they happened. Invalid or missing entries are dropped; system errors keep them for retry.
          for (const name of pendingFiles()) {
            // Stay within the 3 s hook timeout: a killed lock holder leaves the stale-lock wait.
            if (mode !== '--codex-report' && performance.now() >= deadline) {
              queue(Object.assign(new Error('LOCK_BUSY'), { code: 'EBUSY' }))
              return
            }
            const file = join(pending, name)
            if (file === queuedFile) continue
            let stored: Json | undefined
            let dropped: string | undefined
            try {
              stored = readPending(file)
              const isRaw = name.endsWith('.raw.json')
              const entry = isRaw ? rawEntry(stored) : stored as Pending
              if (entry.version === 1 && typeof entry.progress === 'string' && isHookEntry(entry)) {
                if (entry.progress !== progress) continue
                const signal = cleanSignal(entry.run)
                if (!isOverdue(entry) || signal !== undefined && isStrongRun(signal)) apply(entry, isRaw)
                else dropped = 'OVERDUE'
              } else dropped = 'UNKNOWN_VERSION'
            } catch (error) {
              const code = (error as { code?: unknown } | null)?.code
              if (isBusy(error) || typeof code === 'string' && code !== 'ENOENT' || error instanceof Error && ['INCOMPLETE_PROGRESS_TAIL', 'HOOK_TIMEOUT'].includes(error.message)) throw error
              dropped = pendingErrorCode(error)
            }
            // Two boards sharing one data folder can both drop the same entry.
            let isRemoved = false
            try {
              unlinkSync(file)
              isRemoved = true
            } catch (error) {
              if ((error as { code?: string }).code !== 'ENOENT') throw error
            }
            if (isRemoved && dropped !== undefined) logPendingDrop(home, stored, dropped)
            processed += 1
          }
          if (current === undefined) return
          if (isInferredReport && reportSession() !== current.session) throw new Error('UNBOUND_REPORT')
          const applied = apply(current)
          if (queuedFile !== undefined) {
            try { unlinkSync(queuedFile) } catch (error) {
              if ((error as { code?: string }).code !== 'ENOENT') throw error
            }
          }
          return applied
        }, { waitMs: value !== undefined && mode !== '--codex-report' && queuedFile === undefined ? 0 : Math.max(0, deadline - performance.now()) })
        break
      } catch (error) {
        if (isDenied(error) && markReport(error)) return true
        if (!isBusy(error) && !(error instanceof Error && error.message === 'HOOK_TIMEOUT')) throw error
        // Save before a bounded wait: Windows lock recovery and timer scheduling
        // can consume the remaining budget, after which the write guard must close.
        // A full queue does not fail yet: like a hook without a deadline, it waits and retries.
        if (value !== undefined && mode !== '--codex-report') {
          try { queue(error) } catch (failure) { if (failure !== error) throw failure }
        }
        const left = deadline - performance.now()
        if (left <= 0) {
          if (markReport(error)) return true
          if (mode === '--codex-report') throw error
          queue(error)
          break
        }
        await new Promise(done => setTimeout(done, Math.min(delay, left)))
        delay = Math.min(delay * 2, 400)
      }
    }
    if (current === undefined) {
      const remaining = pendingFiles().filter(name => {
        try {
          const stored = readPending(join(pending, name))
          const entry = name.endsWith('.raw.json') ? rawEntry(stored) : stored as Pending
          return entry.version === 1 && isHookEntry(entry) && entry.progress === progress
        } catch (error) { return (error as { code?: string }).code !== 'ENOENT' }
      }).length
      output({ recoveryVersion: 1, processed, pending: remaining, ...(recoveryOwner === undefined ? {} : { owner: ownership }) })
      return true
    }
    const { session } = current
    if (mode !== '--codex-report' && args.includes('--hook-recovery-parent') && queuedFile !== undefined && existsSync(queuedFile)) process.stderr.write('AGENT_BOARD_HOOK_PENDING\n')
    const event = String(agent === 'antigravity' ? current.event ?? '' : raw.hook_event_name ?? raw.hookEventName ?? '')
    const isStart = current.event === 'SessionStart'
    const isFirst = current.event === 'PreInvocation' && (raw.invocationNum === 0 || isFirstSessionEvent)
    const base = agent === 'codex' ? codexStartNote(raw, current.run, session, progress, s) : agent === 'antigravity' && (isStart || isFirst) ? s.localAgentAntigravityContext(boardRun(process.argv[1] ?? script, [
      '--codex-report', '--agent', 'antigravity', '--session', session,
      '--progress-file', progress, '--home', home, '--data-dir', root,
    ])) : null
    if (await deliverTurnEvent({
      mode, agent, event, session, report, raw, folder: current.folder, base, progress, home, root, hookDeadline, s,
      hash, readLocal, atomic, checkDeadline, hereNames,
    })) return true
    if (mode === '--codex-report' && planInput !== undefined) return true
    if (mode === '--codex-report') output({ session, block: hash(`${agent}:${session}`).slice(0, 8), state: report!.state, updated: report!.updated, progress, cut: reportCut, dropped: reportDropped })
    else if (agent === 'cursor') output(raw.hook_event_name === 'sessionStart' ? { env: { AGENT_BOARD_SESSION_ID: session, AGENT_BOARD_AGENT: agent } } : {})
    else if (agent === 'antigravity') {
      // The host supplies the binding; the agent supplies semantic summaries. A first
      // invocation also covers resumed conversations that have no SessionStart event.
      // Legacy connect runs a bundle beside its chosen progress file, outside root.
      const context = base ?? ''
      output(isStart ? { injectSteps: [{ systemMessage: { systemMessage: context } }] } : isFirst ? { injectSteps: [{ ephemeralMessage: context }] } : {})
    } else if (agent === 'gemini') output({})
    else if (agent === 'codex' && mode === '--codex-event') {
      const note = base
      // Codex adds `additionalContext` to the conversation as developer context.
      if (note !== null) output({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } })
    }
    return true
  }

  const hasHooks = agent === 'codex' || agent === 'cursor' || statusEvents[agent] !== undefined
  // Hermes keeps its hooks in YAML, which the text editor below owns; no JSON group stands for them.
  const ownEvents: readonly string[] = !hasHooks || agent === 'antigravity' || agent === 'hermes' ? [] : [...(agent === 'cursor' ? Object.keys(cursorEvents) : agent === 'codex' ? codexEvents : Object.keys(statusEvents[agent] ?? {})), ...(planEvents[agent] === undefined ? [] : [planEvents[agent].event])]
  const nativeConfig = agent === 'openclaw' ? join(openclawDir, 'openclaw.json') : agent === 'deepseek' ? join(deepseekDir, 'cordis.patch.yml') : config
  const nativeConfigText = initial(nativeConfig) ?? ''
  // Windows tools may start any JSON host config with a UTF-8 BOM; JSON.parse does not accept it.
  const configText = withoutBom(nativeConfigText)
  const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
  const isListOrAbsent = (value: unknown): boolean => value === undefined || Array.isArray(value)
  const isShaped = (config: Json): boolean => {
    const hooks = config.hooks
    if (hooks !== undefined && !isRecord(hooks)) return false
    if (isRecord(hooks) && ownEvents.some(event => !isListOrAbsent(hooks[event]))) return false
    if (agent === 'openclaw' && config.plugins !== undefined) {
      if (!isRecord(config.plugins)) return false
      const { load, entries, allow } = config.plugins
      if (load !== undefined && (!isRecord(load) || !isListOrAbsent(load.paths))) return false
      if (entries !== undefined && !isRecord(entries)) return false
      if (!isListOrAbsent(allow)) return false
    }
    return true
  }
  const read = hasHooks && agent !== 'hermes' || agent === 'openclaw' ? isUnreadable(nativeConfig) ? null : readConfig(configText) : {}
  // Wrong shapes are the same one conflict as unreadable JSON, so other agents still preview (#465).
  const parsedConfig = read !== null && !isShaped(read) ? null : read
  const hookConfig = parsedConfig ?? {}
  // A config that cannot be read is one conflict of its own; its groups are not also reported as edited.
  const isReadable = parsedConfig !== null
  const hooks = object(hookConfig.hooks ?? {})
  const worker = join(root, 'agent-board-hook.mjs')
  // Only the program is kept from the last install; every other word is written from this run.
  const commandsOf = (value: unknown): unknown[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(commandsOf) : [(value as Json).command, ...commandsOf((value as Json).hooks)]
  // Hermes records each event's command by name, not in groups.
  const hermesRecord = agent === 'hermes' ? Object.values(object(manifest.groups.hooks ?? {})) : []
  const earlier = [...commandsOf(Object.values(manifest.groups)), ...hermesRecord].filter((command): command is string => typeof command === 'string')
  // The Node setup wrote last time, spelled as setup wrote it, still runs the same hooks. So it is
  // kept even when this run's Node is a copy in another folder or another name for the same file:
  // rewriting a command would drop the approval its host bound to it (#1662). Every path asked
  // about here comes from setup's own records, so it was a working Node by any name when written.
  const keptNodes = new Map<string, boolean>()
  const isKeptNode = (path: string): boolean => {
    if (!isAbsolute(path)) return false
    const known = keptNodes.get(path)
    if (known !== undefined) return known
    const decide = (): boolean => {
      try {
        const kept = statSync(path, { bigint: true }), running = statSync(process.execPath, { bigint: true })
        if (!kept.isFile()) return false
        if (kept.ino > 0n && kept.dev === running.dev && kept.ino === running.ino) return true
      } catch { return false }
      // Another program in that place is not kept. A probe that runs out of time keeps it, so a
      // slow computer does not change the command (#625). SIGKILL, since a program may ignore SIGTERM.
      const probe = spawnSync(path, ['-p', 'process.release.name'], { encoding: 'utf8', windowsHide: true, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096 })
      if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') return true
      return probe.error === undefined && probe.status === 0 && probe.stdout.trim() === 'node'
    }
    const isKept = decide()
    keptNodes.set(path, isKept)
    return isKept
  }
  // Every host reads the Node of the files beside its hooks from the skill they all share: a host's
  // own hook commands would let two hosts write that skill with different Nodes in turn. Only a skill
  // setup wrote and still owns is read: one the person edited may name any program.
  const scriptWord = quote(script).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const skillNow = initial(skill)
  const isSetupSkill = skillNow !== null && !isUnreadable(skill) && [manifest.files, ...otherManifests.map(one => object(one.files ?? {}))].some(files => files[skill] === ownHash(skill, skillNow))
  const skillNode = isSetupSkill ? new RegExp('"([^"\\r\\n]+)" ' + scriptWord).exec(skillNow)?.[1] : undefined
  const commandNode = skillNode !== undefined && isKeptNode(skillNode) ? skillNode : process.execPath
  // A host's hooks keep the program they start, which on Windows may be an 8.3 name or sit inside an encoded launch.
  // Antigravity's hooks carry no approval, and its PowerShell launch moves to a direct command once this run's Node
  // can be verified, so they follow this run's Node as before.
  const hookNode = agent === 'antigravity' ? process.execPath : earlier.map(hookProgram).find(isKeptNode) ?? commandNode
  const hookArgs = (event: string, state?: string): string[] => hookCommandArgs(hookNode, home, agent, worker, progress, event, state)
  const isSame = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  const remove = mode === '--codex-remove'
  // setup --update (#1314): keeps what the person turned off, and reports what its one question must show.
  const isUpdate = !remove && args.includes('--update')
  // The board's hook groups the person removed, which an update leaves removed and does not read trust for.
  const removedByPerson = new Set<string>()
  const conflicts: string[] = []
  const changes: { file: string; action: string }[] = []
  // Beside the hooks.json it trusts, as the doctor reads it, so --codex-dir finds the same installation.
  const trustConfig = agent === 'codex' ? join(dirname(resolve(config)), 'config.toml') : ''
  let nextTrust: string | undefined
  if (remove && agent === 'codex') {
    const keys = Object.entries(manifest.groups).flatMap(([event, group]) => {
      const entries = hooks[event]
      const index = Array.isArray(entries) ? entries.findIndex(entry => isSame(entry, group)) : -1
      return index < 0 ? [] : [`${resolve(config)}:${event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}:${index}:0`]
    })
    try {
      const text = initial(trustConfig)
      // A config.toml that is not valid UTF-8 is not edited, a linked one included: the snapshot reads through the link.
      if (text !== null && isUnreadable(trustConfig)) conflicts.push(trustConfig)
      else if (text !== null) {
        const result = removeCodexTrustEntries(text, keys)
        if (result.text !== text) { nextTrust = result.text; changes.push({ file: trustConfig, action: 'update' }) }
      }
    } catch { before.delete(trustConfig) }
  }
  const keptShared: { file: string; usedBy: string[] }[] = []
  const alreadyGone: string[] = []
  let hasMissingGroup = false
  const nextHooks: Json = { ...hooks }
  const groups: Json = {}
  const foreignGroups: Json = {}
  // Codex runs its hooks through PowerShell on Windows (#623).
  const isPowerShellHost = agent === 'codex' && process.platform === 'win32'
  // Muse Code 1.4.14 on Windows hands the line to cmd as one argument with each quote escaped as \",
  // which cmd does not read, so every quoted hook failed live. It gets Antigravity's quote-free line.
  const isQuoteFreeHost = agent === 'muse' && process.platform === 'win32'
  const hostNode = isPowerShellHost || isQuoteFreeHost ? windowsHookNode(hookNode, earlier) : undefined
  for (const event of ownEvents) {
    const state = statusEvents[agent]?.[event]
    const argv = hookArgs(event, state)
    const eventCommand = isPowerShellHost ? windowsHookCommand(argv, quote, hostNode) : isQuoteFreeHost ? antigravityCommand(argv, true, quote, hostNode) : argv.map(quote).join(' ')
    // The plan mirror's group carries its tool matcher on the group, not on the hook inside it.
    const matcher = planEvents[agent]?.event === event ? planEvents[agent].matcher : undefined
    const group = agent === 'cursor' ? { command: eventCommand, timeout: hostHookTimeout(agent, event) } : { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: eventCommand, timeout: hostHookTimeout(agent, event) }] }
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error('INVALID_HOOK_GROUP')
    const entries = (hooks[event] ?? []) as unknown[]
    const old = manifest.groups[event]
    const kept = old === undefined ? entries : entries.filter(entry => !isSame(entry, old))
    foreignGroups[event] = kept.map(entry => hash(JSON.stringify(entry)))
    if (isReadable && old !== undefined && !entries.some(entry => isSame(entry, old))) {
      // Remember foreign entries so a removed group cannot be confused with an edited command.
      const foreign = manifest.foreignGroups[event]
      const hasUnknown = entries.some(entry => !Array.isArray(foreign) || !foreign.includes(hash(JSON.stringify(entry))))
      // With foreign history, an unknown entry is the user's edit of this hook; older records cannot tell.
      if (remove && Array.isArray(foreign) && hasUnknown) conflicts.push(`${config}:${event}`)
      else if (remove) alreadyGone.push(`${config}:${event}`)
      else if (entries.length && hasUnknown) conflicts.push(`${config}:${event}`)
      // An update leaves a hook group the person removed removed, and keeps it in the record so the next one does too.
      else if (isUpdate) { groups[event] = old; removedByPerson.add(event); continue }
      else hasMissingGroup = true
    }
    if (!remove) {
      // Exact generated bytes can be adopted after a partially interrupted install.
      const next = kept.filter(entry => !isSame(entry, group))
      // Codex binds approval to a group's slot, so replacing ours must not move a person's later group.
      const index = agent === 'codex' ? entries.findIndex(entry => old !== undefined && isSame(entry, old) || isSame(entry, group)) : -1
      next.splice(index < 0 ? next.length : index, 0, group)
      nextHooks[event] = next
      groups[event] = group
    } else if (kept.length) nextHooks[event] = kept
    else delete nextHooks[event]
  }
  let nextConfig: Json = {
    ...(agent === 'cursor' && !('version' in hookConfig) ? { version: 1 } : agent === 'muse' && !('schema_version' in hookConfig) ? { schema_version: 1 } : {}),
    ...hookConfig, hooks: nextHooks,
  }
  if (agent === 'antigravity') {
    const name = 'agent-board-local'
    const directNode = windowsHookNode(process.execPath)
    const desired = antigravityHooks((event, state) => antigravityCommand(hookArgs(event, state), process.platform === 'win32', quote, directNode))
    const existing = hookConfig[name], owned = manifest.groups[name]
    if (isReadable && existing !== undefined && !(owned !== undefined && isSame(existing, owned)) && !(!remove && isSame(existing, desired))) conflicts.push(`${config}:${name}`)
    if (isReadable && owned !== undefined && existing === undefined) {
      if (remove) alreadyGone.push(`${config}:${name}`)
      // An update leaves the group the person removed removed, and keeps it in the record so the next one does too.
      else if (isUpdate) removedByPerson.add(name)
      else hasMissingGroup = true
    }
    nextConfig = { ...hookConfig }
    if (removedByPerson.has(name)) groups[name] = owned
    else if (!remove) { nextConfig[name] = desired; groups[name] = desired }
    else if (owned !== undefined) delete nextConfig[name]
  }
  let nextConfigText: string | null = null
  // An update that finds the board's whole part of a config removed leaves that config as the person left it.
  let isConfigKept = false
  if (agent === 'openclaw') {
    const id = 'agent-board-local'
    const pluginFile = join(root, 'adapters', 'openclaw', 'agent-board-local.mjs')
    const plugins = object(hookConfig.plugins ?? {})
    const load = object(plugins.load ?? {})
    const entries = object(plugins.entries ?? {})
    if (load.paths !== undefined && !Array.isArray(load.paths) || plugins.allow !== undefined && !Array.isArray(plugins.allow)) throw new Error('INVALID_PLUGIN_CONFIG')
    const paths = (load.paths ?? []) as unknown[]
    const allow = plugins.allow as unknown[] | undefined
    const existing = entries[id], owned = manifest.groups[id]
    const desired = { enabled: true, hooks: { allowConversationAccess: false } }
    if (isReadable && (plugins.enabled === false || existing !== undefined && !isSame(existing, owned ?? desired) || owned !== undefined && existing !== undefined && (!paths.includes(pluginFile) || allow?.length && !allow.includes(id)))) conflicts.push(`${nativeConfig}:${id}`)
    if (isReadable && owned !== undefined && existing === undefined) {
      if (remove) alreadyGone.push(`${nativeConfig}:${id}`)
      // An update leaves the entry the person removed removed, with its path and allow list as the person left them.
      else if (isUpdate) removedByPerson.add(id)
      else hasMissingGroup = true
    }
    nextConfig = removedByPerson.has(id) ? { ...hookConfig } : { ...hookConfig, plugins: {
      ...plugins,
      load: { ...load, paths: remove ? paths.filter(path => path !== pluginFile) : [...paths.filter(path => path !== pluginFile), pluginFile] },
      entries: { ...entries, ...(!remove ? { [id]: desired } : {}) },
      ...(allow === undefined ? {} : { allow: remove && manifest.groups.allowAdded === true ? allow.filter(one => one !== id) : !remove && allow.length && !allow.includes(id) ? [...allow, id] : allow }),
    } }
    if (removedByPerson.has(id)) {
      groups[id] = owned
      if (manifest.groups.allowAdded !== undefined) groups.allowAdded = manifest.groups.allowAdded
    } else if (remove) delete object(object(nextConfig.plugins).entries)[id]
    else {
      groups[id] = desired
      groups.allowAdded = manifest.groups.allowAdded ?? Boolean(allow?.length && !allow.includes(id))
    }
  }
  if (agent === 'deepseek') {
    const text = initial(nativeConfig) ?? ''
    if (manifest.groups.patch !== undefined && !text.includes('agent-board-local')) {
      if (remove) alreadyGone.push(`${nativeConfig}:agent-board-local`)
      else if (isUpdate) removedByPerson.add('patch')
      else hasMissingGroup = true
    }
    if (isUnreadable(nativeConfig)) { if (!conflicts.includes(nativeConfig)) conflicts.push(nativeConfig) }
    else if (removedByPerson.has('patch')) { groups.patch = manifest.groups.patch; isConfigKept = true }
    else {
      const patch = deepseekPatch(text, manifest.groups.patch, pathToFileURL(join(root, 'adapters', 'deepseek.mjs')).href, remove)
      if (patch.conflict) conflicts.push(nativeConfig)
      nextConfigText = patch.text
      if (patch.group) groups.patch = patch.group
    }
  }
  // The trust file Hermes keeps beside config.yaml: an approval is an (event, command) pair, and only ours are touched here.
  const allowlistFile = join(hermesDir, 'shell-hooks-allowlist.json')
  // Hermes splits a hook command with shlex and runs it without a shell: every word is double-quoted,
  // and a Windows path takes forward slashes, since a backslash could be read as an escape.
  const hermesCommand = (event: string): string => hookArgs(event, statusEvents.hermes?.[event]).map(word => quote(process.platform === 'win32' ? word.replaceAll('\\', '/') : word)).join(' ')
  const hermesEvents = (): Array<[string, string, string?]> => [
    ...Object.keys(statusEvents.hermes ?? {}).map((event): [string, string] => [event, hermesCommand(event)]),
    [planEvents.hermes!.event, hermesCommand(planEvents.hermes!.event), planEvents.hermes!.matcher],
  ]
  let nextAllowlist: string | undefined
  let isHermesPartial = false
  if (agent === 'hermes') {
    const text = initial(nativeConfig) ?? ''
    const events = hermesEvents()
    const recorded = new Map(Object.entries(object(manifest.groups.hooks ?? {})).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    let patch = !isUnreadable(nativeConfig) && isYamlMapping(text) ? editHermesSetup(text, events, recorded, remove, isUpdate) : null
    // An update leaves an entry the person removed removed: its event is not written again, and the record keeps its
    // command so the next update does too.
    if (isUpdate && patch !== null && patch.missing.length) {
      for (const event of patch.missing) removedByPerson.add(event)
      patch = editHermesSetup(text, events.filter(([event]) => !removedByPerson.has(event)), new Map([...recorded].filter(([event]) => !removedByPerson.has(event))), false, isUpdate)
    }
    if (manifest.groups.hooks !== undefined && patch !== null && !patch.hasOwned) {
      if (remove) alreadyGone.push(`${nativeConfig}:hooks`)
      else if (!isUpdate) hasMissingGroup = true
    }
    if (patch === null) conflicts.push(nativeConfig)
    // An entry the person changed is refused by its event, like the JSON agents' `${config}:${event}`,
    // so the message names the exact lines instead of the whole file.
    else for (const event of patch.refused) conflicts.push(`${nativeConfig}:${event}`)
    isHermesPartial = manifest.groups.hooks !== undefined && patch !== null && !patch.isComplete
    nextConfigText = patch?.text ?? text
    if (!remove && patch !== null) groups.hooks = Object.fromEntries(events.map(([event, command]) => [event, removedByPerson.has(event) ? recorded.get(event) : command]))
    if (remove) {
      const approvals = readAllowlist(initial(allowlistFile), isUnreadable(allowlistFile))
      const mine = Object.entries(object(manifest.groups.hooks ?? {}))
      // A trust file that is not valid UTF-8 is not rewritten, so a removal stops on it (#1607).
      if (approvals === null && isUnreadable(allowlistFile)) conflicts.push(allowlistFile)
      if (approvals !== null) {
        const kept = approvals.list.filter(entry => !mine.some(([event, command]) => entry.event === event && entry.command === command))
        if (kept.length !== approvals.list.length) {
          nextAllowlist = allowlistText({ ...approvals.data, approvals: kept })
          changes.push({ file: allowlistFile, action: 'update' })
        }
      }
    }
  }
  const skillText = `---\nname: agent-board\ndescription: ${JSON.stringify(fileWords.localAgentSkillDescription)}\n---\n\n${fileWords.localAgentSkill(`${quote(commandNode)} ${quote(script)}`)}\n\n${fileWords.localAgentHandoff}\n\n${fileWords.codexTrust}\n\nCodex: ${configs.codex}\n${codexEvents.join(', ')}\n`
  // The connect writes its board beside the progress file it connected: the default one, one a
  // CLAUDE_CONFIG_DIR or CLAUDE_PROGRESS_FILE names, or the one its own record keeps (#285).
  // Releases before de40dde wrote the command as node "<path>" for any path; later ones use boardRun.
  const connectRecord = ((): Json => {
    try { return object(JSON.parse(readFileSync(join(installControlRoot(home), 'legacy-connect.json'), 'utf8'))) } catch { return {} }
  })()
  const connected = connectRecord.connectedProgress
  // The folder Hermes' config still names when a connect's move did not reach it, or the one a
  // session start's connect wrote there (#1664).
  const hermesConnected = connectRecord.hermesProgress
  const legacyProgress = [join(home, '.claude', 'progress.md'), process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'progress.md') : '', process.env.CLAUDE_PROGRESS_FILE ?? '', typeof connected === 'string' ? connected : '']
  const legacyBoards = legacyProgress.filter(path => path !== '').flatMap(path => [path.replace(/[\\/][^\\/]*$/, '') + (process.platform === 'win32' ? '\\' : '/') + 'agent-board.mjs', join(dirname(path), 'agent-board.mjs')])
  const legacySkills = Object.values(STRINGS).flatMap(words => [...new Set(legacyBoards.flatMap(board => [boardRun(board), `node "${board}"`]))].map(run => `---\nname: agent-board\ndescription: ${JSON.stringify(words.boardCommandDescription)}\n---\n\n${words.boardSkillPrompt(run)}\n`))
  // /progress connect writes Antigravity's skill too; that one is taken over like the shared one (#285).
  const antigravitySkill = join(home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')
  const original = readFileSync(process.argv[1] ?? '', 'utf8').replace(/^globalThis\.AGENT_BOARD[^\n]*\n/, '')
  const files: Record<string, string> = {
    [script]: `globalThis.AGENT_BOARD = ${JSON.stringify({ hookVersion: HOOK_VERSION, path: progress, codexRoot: root, lang: Object.entries(STRINGS).find(([, words]) => words === fileWords)?.[0] ?? 'en' })}\n${original}`,
    [worker]: hookWorker(home, script, boardPromptHelper(boardRequestWords(Object.values(STRINGS)), deliveryRequestWords(Object.values(STRINGS)))),
    [skill]: skillText,
  }
  if (agent === 'opencode') files[join(opencodeDir, 'plugins', 'agent-board-local.js')] = opencodePlugin(commandNode, worker, progress, fileWords.localAgentSkillDescription, home, fileWords.localAgentStepFormat, script, fileWords)
  if (agent === 'openclaw') {
    files[join(root, 'adapters', 'openclaw', 'agent-board-local.mjs')] = openclawLocalPlugin(commandNode, worker, progress, home, fileWords.openclawProgressTool, fileWords.localAgentStepFormat)
    // activation.onStartup: OpenClaw 2026.6.35 loads a plugin when its gateway starts only when the manifest asks for it (#1489).
    files[join(root, 'adapters', 'openclaw', 'openclaw.plugin.json')] = `${JSON.stringify({ id: 'agent-board-local', activation: { onStartup: true }, contracts: { tools: ['progress_card'] }, configSchema: { type: 'object', additionalProperties: false, properties: {} } }, null, 2)}\n`
    files[join(openclawDir, 'skills', 'agent-board', 'SKILL.md')] = skillText
  }
  if (agent === 'deepseek') {
    files[join(root, 'adapters', 'deepseek.mjs')] = deepseekLocalPlugin(commandNode, worker, progress, home, script, fileWords.deepseekBoardTool, fileWords.localAgentStepFormat)
    files[join(deepseekDir, 'skills', 'agent-board', 'SKILL.md')] = skillText
  }
  if (agent === 'hermes') files[join(hermesDir, 'skills', 'agent-board', 'SKILL.md')] = skillText
  if (agent === 'antigravity') files[antigravitySkill] = skillText
  // The sidecar is written only on the person's flag, or kept as it is where an earlier setup wrote it (#1396). Setup never switches it on: the person does, in Antigravity's Automations page.
  if (agent === 'antigravity') {
    const sidecarDir = join(home, '.gemini', 'config', 'sidecars', ANTIGRAVITY_SIDECAR_ID)
    const sidecarFiles = [join(sidecarDir, 'sidecar.json'), join(sidecarDir, 'sidecar.mjs')]
    if (args.includes('--antigravity-sidecar') || sidecarFiles.some(file => Object.hasOwn(manifest.files, file))) {
      files[sidecarFiles[0]!] = antigravitySidecarConfig(process.execPath, progress, home, fileWords.antigravitySidecarDescription)
      files[sidecarFiles[1]!] = antigravitySidecarSource(fileWords.antigravityWakeLine)
    }
  }
  if (agent === 'gemini') files[join(home, '.gemini', 'commands', 'agent-board.toml')] = `description = ${JSON.stringify(fileWords.boardCommandDescription)}\nprompt = '''${fileWords.boardCommandPrompt}\n\n!{${quote(commandNode)} ${quote(script)}}\n'''\n`
  if (agent === 'opencode') files[join(opencodeDir, 'commands', 'agent-board.md')] = `---\ndescription: ${JSON.stringify(fileWords.boardCommandDescription)}\n---\n\n${fileWords.boardCommandPrompt}\n\n!\`${quote(commandNode)} ${quote(script)}\`\n`
  // 0.24.2 and earlier wrote /board here. The command is now /agent-board, so setup takes the old file
  // away when it is still the bytes setup or a release wrote, and leaves one the person edited (#868).
  const retired = agent === 'gemini' ? [join(home, '.gemini', 'commands', 'board.toml')] : agent === 'opencode' ? [join(opencodeDir, 'commands', 'board.md')] : []
  const keptEdited: string[] = []
  const records = [manifest.files, ...otherManifests.map(one => object(one.files ?? {}))]
  const boardRecords = records.map(record => record[script]).filter(value => typeof value === 'string')
  // A released board is one setup may replace: its body is a release's, and its settings line is exactly what setup or
  // the connect writes for this install. Any other settings line is the person's own (#1302). A record that held this
  // same body under another settings line means the line was changed after setup wrote it; a body other than the
  // recorded one is a board a later connect replaced, which still upgrades.
  const isReleasedBoard = (text: string): boolean => {
    const head = /^globalThis\.AGENT_BOARD = ([^\n]*)\n/.exec(text)
    if (head === null) return false
    const body = text.slice(head[0].length)
    if (!RELEASED.some(release => release.board.includes(hash(body)))) return false
    let settings: unknown
    try { settings = JSON.parse(head[1]!) } catch { return false }
    if (!isRecord(settings) || JSON.stringify(settings) !== head[1]) return false
    const { hookVersion, path, codexRoot, lang } = settings
    const paths = boardRecords.length ? [progress] : [progress, ...legacyProgress.filter(one => one !== '')]
    if (Object.keys(settings).some(key => !['hookVersion', 'path', 'codexRoot', 'lang'].includes(key))) return false
    if (hookVersion !== undefined && !(Number.isInteger(hookVersion) && (hookVersion as number) >= 1 && (hookVersion as number) <= HOOK_VERSION)) return false
    if (typeof path !== 'string' || !paths.includes(path) || codexRoot !== undefined && codexRoot !== root) return false
    if (typeof lang !== 'string' || !Object.hasOwn(STRINGS, lang)) return false
    const versions = [undefined, ...Array.from({ length: HOOK_VERSION }, (_, index) => index + 1)]
    const heads = Object.keys(STRINGS).flatMap(one => versions.flatMap(version => [undefined, root].map(folder => JSON.stringify({ hookVersion: version, path: progress, codexRoot: folder, lang: one }))))
    return !heads.some(line => boardRecords.includes(hash(`globalThis.AGENT_BOARD = ${line}\n${body}`)))
  }
  // A file that is not valid UTF-8 is never setup's, even when its decoded text reads as a released board or skill (#1607).
  const isOwnedFile = (file: string, existing: string): boolean => !isUnreadable(file) && (ownHash(file, existing) === manifest.files[file] || !remove && (otherManifests.some(one => object(one.files ?? {})[file] === ownHash(file, existing)) || (file === script && isReleasedBoard(existing)) || (file === skill || file === antigravitySkill) && legacySkills.includes(existing)))
  // Text a host only reads can take a new version beside it. Everything else is code a host loads or a manifest it trusts.
  const isTextFile = (file: string): boolean => /\.(?:toml|md)$/.test(file)
  const isKeptRunner = (file: string): boolean => {
    const existing = initial(file)
    return !remove && existing !== null && existing !== files[file] && !isOwnedFile(file, existing) && manifest.files[file] !== undefined
  }
  // The board script and the hook runner are what the host starts. While the person's copy of one stays, the code and
  // the hook lines written for it stay too, since a new hook line could ask the old program for something it cannot do.
  const isScriptHeld = isKeptRunner(script)
  const isWorkerHeld = !isScriptHeld && isKeptRunner(worker)
  const isHeld = isScriptHeld || isWorkerHeld
  const heldBy = basename(isScriptHeld ? script : worker)
  // A kept board script whose record is not this version's script, in any language, came from an earlier version: new
  // words can ask it for options it lacks, and only the old /board command is known to work with it. So while it stays,
  // setup writes no new command and no missing skill, and keeps the /board file with its record entry (#1698).
  const isOlderHeld = isScriptHeld && !Object.keys(STRINGS).some(lang => manifest.files[script] === hash(`globalThis.AGENT_BOARD = ${JSON.stringify({ hookVersion: HOOK_VERSION, path: progress, codexRoot: root, lang })}\n${original}`))
  const commandFile = agent === 'gemini' ? join(home, '.gemini', 'commands', 'agent-board.toml') : agent === 'opencode' ? join(opencodeDir, 'commands', 'agent-board.md') : ''
  const keptFiles = new Set<string>()
  const keptText: { file: string; beside: string }[] = []
  const keptCode: string[] = []
  const keptHeld: { file: string; by: string }[] = []
  const missingHeld: { file: string; by: string }[] = []
  // The limit, as far as setup can tell: a record or a pending list that names a .new path with the SHA-256 of the bytes
  // now at it makes that copy setup's, whoever wrote that file. A list entry counts only under the exact path this run
  // plans; only a record also counts through a second name for the same file (a skills folder linked to the shared one,
  // or another letter case on Windows).
  const pendingCopies = [agent, ...otherAgents].flatMap(one => Object.entries(pendingOf(one)).flatMap(([path, hashes]) => hashes.map((value): [string, unknown] => [path, value])))
  const isOurBeside = (copy: string, text: string): boolean => pendingCopies.some(([path, value]) => path === copy && value === ownHash(copy, text))
    || records.flatMap(record => Object.entries(record)).some(([path, value]) => value === ownHash(copy, text) && (path === copy || path.endsWith('.new') && realOf(path) !== null && realOf(path) === realOf(copy)))
  for (const [file, desired] of Object.entries(files)) {
    const existing = initial(file)
    const shared = file === script || file === worker || file === skill
    if (remove && shared) {
      // The same record that keeps a shared file out of this removal names the
      // agents still using it, so the preview says why the file stays (#816).
      const usedBy = otherAgents.filter((one, index) => !removingAgents.includes(one) && otherManifests[index]?.files !== undefined)
      if (usedBy.length) { keptShared.push({ file, usedBy }); continue }
    }
    if (remove && existing === null && Object.hasOwn(manifest.files, file)) alreadyGone.push(file)
    const owned = existing !== null && isOwnedFile(file, existing)
    const isEdited = existing !== null && !owned && existing !== desired
    // Words setup wrote earlier wait with the person's board script, since new words could ask that script for a flag it
    // lacks. An edited text file still gets its .new copy. A missing one is written beside an edit of this version's
    // script, which knows every option the words ask for, and waits beside an older one (#1698).
    const isHeldText = isScriptHeld && isTextFile(file) && (owned || isOlderHeld && existing === null)
    if (isHeld && (!isTextFile(file) || isHeldText) && !(isWorkerHeld && file === script)) {
      if (existing === desired) continue
      keptFiles.add(file)
      if (isHeldText && !owned) keptHeld.push({ file, by: heldBy })
      else if (isEdited && manifest.files[file] === undefined) conflicts.push(file)
      else if (isEdited) keptCode.push(file)
      else if (existing === null && manifest.files[file] !== undefined) { missingHeld.push({ file, by: heldBy }); conflicts.push(file) }
      else keptHeld.push({ file, by: heldBy })
    } else if (isEdited && !remove && isTextFile(file)) {
      keptFiles.add(file)
      const beside = `${file}.new`
      const current = initial(beside)
      // An edited text file stops this agent only when the .new path holds something setup did not write.
      if (current === null ? before.get(beside)?.kind !== 'none' : !isOurBeside(beside, current)) conflicts.push(beside)
      else {
        keptText.push({ file, beside })
        files[beside] = desired
        if (current !== desired) changes.push({ file: beside, action: current === null ? 'create' : 'update' })
      }
    } else if (isEdited && !remove && manifest.files[file] !== undefined) {
      keptFiles.add(file)
      keptCode.push(file)
    }
    // An edited file with no record may not be setup's at all, and a removal never takes a file it did not write.
    else if (isEdited) conflicts.push(file)
    else if (remove ? owned : existing !== desired) changes.push({ file, action: remove ? 'remove' : existing === null ? 'create' : 'update' })
  }
  // A new version left beside a file that no longer needs one: the person's edit is gone, or setup is removing this
  // agent. It goes only as setup wrote it, and only when no other agent that stays still names it.
  const ownPending = pendingOf(agent)
  const staleBeside = new Set([...Object.keys(manifest.files), ...Object.keys(ownPending)].filter(file => file.endsWith('.new') && !(file in files) && file.slice(0, -4) in files))
  // One copy can have two names, as through a Hermes skills folder linked to the shared one (#1695). Names are compared
  // by real path, so another agent that names the copy by either name keeps it, and the copy is removed once.
  const isSameCopy = (one: string, other: string): boolean => one === other || other.endsWith('.new') && realOf(one) !== null && realOf(one) === realOf(other)
  const removedCopies = new Set<string>()
  for (const file of staleBeside) {
    const current = initial(file)
    const isStillNamed = otherAgents.some((one, index) => !removingAgents.includes(one) && [...Object.keys(object(otherManifests[index]?.files ?? {})), ...Object.keys(pendingOf(one))].some(name => isSameCopy(file, name)))
    if (current === null) { if (remove && manifest.files[file] !== undefined) alreadyGone.push(file) }
    else if ((ownHash(file, current) === manifest.files[file] || ownPending[file]?.includes(ownHash(file, current))) && !isStillNamed && !removedCopies.has(realOf(file) ?? file)) {
      removedCopies.add(realOf(file) ?? file)
      changes.push({ file, action: 'remove' })
    }
  }
  const hasNativeConfig = hasHooks || agent === 'openclaw' || agent === 'deepseek'
  // The hook lines stay as the kept program knows them. A hook the person's program needs and no longer has cannot be
  // put back from here, and a moved board file would leave that program writing to the old one.
  if (isHeld) {
    if (typeof loaded.progress === 'string' && resolve(loaded.progress) !== progress) conflicts.push(isScriptHeld ? script : worker)
    if (hasMissingGroup || isHermesPartial) { missingHeld.push({ file: nativeConfig, by: heldBy }); conflicts.push(nativeConfig) }
    else if (hasNativeConfig && Object.keys(groups).some(key => !isSame(groups[key], manifest.groups[key]))) keptHeld.push({ file: nativeConfig, by: heldBy })
    for (const key of Object.keys(groups)) delete groups[key]
    Object.assign(groups, manifest.groups)
  }
  // The old /board command the kept older script answers stays with it, as setup wrote it or as the person edited it.
  const keptBoards = isOlderHeld ? retired.filter(file => initial(file) !== null) : []
  // How the person opens the board in this agent once the plan is done, and the file that way rests on: /board while
  // its /agent-board waits with an older script, the command file, else the agent's own skill or the shared one it reads.
  // The plan names that file even when it is not there now: setup names the way only while it is a file as it prints its
  // next steps, and otherwise gives the board command for a terminal. Cursor has no board command (#1698).
  const isCommandHeld = isOlderHeld && keptFiles.has(commandFile)
  const opensFile = isCommandHeld ? retired[0] : commandFile || Object.keys(files).find(file => file.endsWith('SKILL.md') && file !== skill) || (BOARD_FOR.skills?.includes(agent) ? skill : undefined)
  const opens = remove || agent === 'cursor' || opensFile === undefined ? undefined : { way: isCommandHeld ? '/board' : commandFile ? '/agent-board' : 'skill', file: opensFile }
  for (const file of keptBoards) keptHeld.push({ file, by: heldBy })
  for (const file of retired) {
    const existing = initial(file)
    if (keptBoards.includes(file)) continue
    if (existing === null) {
      if (remove && Object.hasOwn(manifest.files, file)) alreadyGone.push(file)
    } else if (ownHash(file, existing) === manifest.files[file] || [script, ...legacyBoards].some(board => isReleased(agent === 'gemini' ? 'gemini' : 'opencode', existing, { board }))) changes.push({ file, action: 'remove' })
    else keptEdited.push(file)
  }
  // A host-directory override must not strand an old active plugin outside the
  // new ownership record. Remove the old scoped install before changing roots.
  for (const file of Object.keys(manifest.files)) if (!(file in files) && !retired.includes(file) && !staleBeside.has(file)) conflicts.push(file)
  nextConfigText ??= `${JSON.stringify(nextConfig, null, 2)}\n`
  if (hasNativeConfig && (!remove || Object.keys(manifest.groups).length)) {
    const isHollowOpenclaw = (): boolean => {
      const plugins = object(nextConfig.plugins ?? {})
      return Object.keys(nextConfig).every(key => key === 'plugins') && Object.keys(plugins).every(key => key === 'load' || key === 'entries' || key === 'allow' && Array.isArray(plugins.allow) && plugins.allow.length === 0) && isSame(plugins.load ?? { paths: [] }, { paths: [] }) && isSame(plugins.entries ?? {}, {})
    }
    const isEmptyCreatedConfig = loaded.createdConfig === true && (agent === 'deepseek' || agent === 'hermes' ? nextConfigText.trim() === '' : agent === 'openclaw' ? isHollowOpenclaw() : agent === 'antigravity' ? Object.keys(nextConfig).length === 0 : Object.keys(nextHooks).length === 0 && Object.keys(nextConfig).every(key => key === 'hooks' || key === 'version' && agent === 'cursor' && nextConfig[key] === 1 || key === 'schema_version' && agent === 'muse' && nextConfig[key] === 1))
    if (parsedConfig === null) conflicts.push(nativeConfig)
    else if (remove && initial(nativeConfig) === null) alreadyGone.push(nativeConfig)
    else if (remove && isReadable && isEmptyCreatedConfig) changes.push({ file: nativeConfig, action: 'remove' })
    else if (!isHeld && !isConfigKept && (agent === 'deepseek' || agent === 'hermes' ? initial(nativeConfig) !== nextConfigText : !isSame(hookConfig, nextConfig))) changes.push({ file: nativeConfig, action: initial(nativeConfig) === null || hasMissingGroup ? 'create' : 'update' })
  }
  if (!remove && readLocal(progress) === null) { before.set(progress, NO_PATH); changes.push({ file: progress, action: 'create' }) }
  const createdDirs = new Set(Array.isArray(loaded.createdDirs) ? loaded.createdDirs.filter((value): value is string => typeof value === 'string') : [])
  const folderKey = (folder: string): string => process.platform === 'win32' ? resolve(folder).toLowerCase() : resolve(folder)
  const isBelow = (folder: string, parent: string): boolean => folderKey(folder).startsWith(`${folderKey(parent)}${process.platform === 'win32' ? '\\' : '/'}`)
  // A board file named like a pending list stops setup before it writes, with the board named, so the person learns why.
  // This is for the message only: the list is written over or deleted only when it reads as one (listOf), whatever path
  // the board has. A name through a linked folder is compared by the real folder above it, so it is caught before the
  // file exists.
  const realNameOf = (file: string): string | null => {
    const folder = realOf(dirname(file))
    return folder === null ? null : join(folder, basename(file))
  }
  const isPendingList = (file: string, one: string): boolean => {
    const real = realNameOf(file), list = realNameOf(pendingFile(one))
    return folderKey(file) === folderKey(pendingFile(one)) || realOf(file) !== null && realOf(file) === realOf(pendingFile(one)) || real !== null && list !== null && folderKey(real) === folderKey(list)
  }
  if (!remove && localAgents.some(one => isPendingList(progress, one))) conflicts.push(progress)
  // A .new copy is due, so setup would write its pending list first: a file there that is not a list stops it before that.
  const ownList = before.get(pendingFile(agent)) ?? NO_PATH
  const isCopyDue = keptText.some(one => changes.some(change => change.file === one.beside))
  if (!remove && isCopyDue && ownList.kind !== 'none' && listOf(ownList) === null && !conflicts.includes(pendingFile(agent))) conflicts.push(pendingFile(agent))
  if (!remove) for (const file of [...changes.filter(change => change.action === 'create').map(change => change.file), ...(initial(manifestFile) === null ? [manifestFile] : [])]) {
    for (let folder = dirname(file); folder !== dirname(folder) && folder !== home && !isBelow(home, folder) && !existsSync(folder); folder = dirname(folder)) createdDirs.add(folder)
  }
  const createdConfig = hasNativeConfig && (initial(nativeConfig) === null || loaded.createdConfig === true)
  // Whether the host trusts the board's hooks now, as an update reads it before it asks (#1314): Hermes from its trust
  // file, Codex from Codex itself, never from config.toml. A Codex setup cannot ask is 'unknown', never trusted.
  const hermesTrust = (): boolean | 'unknown' => {
    const approvals = readAllowlist(initial(allowlistFile), isUnreadable(allowlistFile))
    // An entry the person removed is not asked about, as for Codex; with every entry removed there is nothing left to approve.
    const recordedHooks = Object.entries(object(manifest.groups.hooks ?? {})), wanted = recordedHooks.filter(([event]) => !removedByPerson.has(event))
    return approvals === null ? 'unknown' : recordedHooks.length > 0 && wanted.every(([event, command]) => approvals.list.some(entry => entry.event === event && entry.command === command))
  }
  let trustNow: boolean | 'unknown' | undefined
  if (isUpdate && !args.includes('--apply') && (agent === 'codex' || agent === 'hermes') && initial(manifestFile) !== null) {
    const executable = flag('--codex-bin')
    try { trustNow = agent === 'hermes' ? hermesTrust() : executable ? (await trustCodex(executable, config, Object.fromEntries(Object.entries(manifest.groups).filter(([event]) => !removedByPerson.has(event))), false)).hooks.every(hook => hook.trust === 'trusted') : 'unknown' } catch { trustNow = 'unknown' }
  }
  // Whether this board approved the hooks before, so an update tells an approval the person revoked from one never given
  // (#1314). A record from before this field says neither, and an update treats that as revoked.
  const isApproved = loaded.approved === true || args.includes('--hooks-approved') || trustNow === true
  const approval = agent !== 'codex' && agent !== 'hermes' ? {} : isApproved ? { approved: true } : loaded.approved === false || initial(manifestFile) === null && flag('--setup-version') !== undefined ? { approved: false } : {}
  // A new record keeps the newest use's version however it was set up (Settings, or this script's own setup), as setup
  // writes it, so an update does not ask about a use the install has had from the start. An older record without one keeps none.
  const setupVersion = flag('--setup-version') ?? (typeof loaded.version === 'string' ? loaded.version : initial(manifestFile) === null ? newestUse : undefined)
  // A kept /board file keeps its record entry, so it still goes as setup wrote it once the script is taken (#1698).
  const nextManifest = `${JSON.stringify({ files: Object.fromEntries([...Object.entries(files).flatMap(([file, text]) => !keptFiles.has(file) ? [[file, hash(text)]] : manifest.files[file] === undefined ? [] : [[file, manifest.files[file]]]), ...keptBoards.flatMap(file => manifest.files[file] === undefined ? [] : [[file, manifest.files[file]]])]), groups, foreignGroups, progress, ...(config === '' ? {} : { config }), ...(createdConfig ? { createdConfig: true } : {}), ...(createdDirs.size ? { createdDirs: [...createdDirs].sort() } : {}), ...(setupVersion === undefined ? {} : { version: setupVersion }), ...approval }, null, 2)}\n`
  if (remove ? initial(manifestFile) !== null : initial(manifestFile) !== nextManifest) changes.push({ file: manifestFile, action: remove ? 'remove' : initial(manifestFile) === null ? 'create' : 'update' })
  if (remove && agent === 'antigravity' && initial(sidecarRecord) !== null) changes.push({ file: sidecarRecord, action: 'remove' })
  if (remove && listOf(ownList) !== null) changes.push({ file: pendingFile(agent), action: 'remove' })
  const removedDirs = new Set<string>()
  let handover: { file: string; text: string } | undefined
  if (remove) {
    // A folder named by --data-dir may be the person's own: it goes only when setup recorded making it.
    const candidates = new Set([...createdDirs, ...(basename(root) === '.agent-board' ? [root] : [])])
    for (const change of changes) if (change.action === 'remove') {
      for (let folder = dirname(change.file); folderKey(folder) !== folderKey(root) && (basename(folder) === 'agent-board' || isBelow(folder, root)); folder = dirname(folder)) {
        candidates.add(folder)
        if (folder === dirname(folder)) break
      }
    }
    const siblingIndex = otherManifests.findIndex((one, idx) => !removingAgents.includes(otherAgents[idx]) && one.files !== undefined)
    const hasOtherManifest = otherAgents.some((other, idx) => !removingAgents.includes(other) && initial(join(root, `install-${other}.json`)) !== null)
    if (!hasOtherManifest) for (const runtime of [join(home, '.cache', 'agent-board'), ...(process.env.XDG_RUNTIME_DIR ? [join(process.env.XDG_RUNTIME_DIR, 'agent-board')] : [])]) {
      candidates.add(runtime)
      try { for (const name of readdirSync(runtime)) if (name.endsWith('-messages')) candidates.add(join(runtime, name)) } catch {}
    }
    // Outside Windows the message folders sit directly in the runtime folder, which is not ours.
    if (!hasOtherManifest && process.env.XDG_RUNTIME_DIR) try { for (const name of readdirSync(process.env.XDG_RUNTIME_DIR)) if (/^agent-board-.*-messages$/.test(name)) candidates.add(join(process.env.XDG_RUNTIME_DIR, name)) } catch {}
    const deletedFiles = new Set(changes.filter(change => change.action === 'remove').map(change => change.file))
    for (const folder of [...candidates].sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length)) {
      if (folderKey(folder) === folderKey(home) || isBelow(home, folder)) continue
      try {
        if (readdirSync(folder).every(name => deletedFiles.has(join(folder, name)) || removedDirs.has(join(folder, name)))) {
          removedDirs.add(folder)
          changes.push({ file: folder, action: 'remove' })
        }
      } catch {}
    }
    if (siblingIndex >= 0) {
      const sibling = otherManifests[siblingIndex]!
      const carried = [...createdDirs].filter(folder => !removedDirs.has(folder))
      if (carried.length) {
        const dirs = Array.isArray(sibling.createdDirs) ? sibling.createdDirs.filter((value): value is string => typeof value === 'string') : []
        handover = { file: join(root, `install-${otherAgents[siblingIndex]}.json`), text: `${JSON.stringify({ ...sibling, createdDirs: [...new Set([...dirs, ...carried])].sort() }, null, 2)}\n` }
      }
    }
  }
  // What an update's question shows (#1314): each hook whose command changes, as the host will run it, and every changed
  // file a host loads as code (not text it only reads, which keeps the person's edit beside it).
  const commandsIn = (value: unknown): string[] => typeof value !== 'object' || value === null ? [] : Object.entries(value).flatMap(([key, one]) => key === 'command' && typeof one === 'string' ? [one] : commandsIn(one))
  const hookCommands = (all: Json): Map<string, string[]> => new Map(agent === 'hermes' ? Object.entries(object(all.hooks ?? {})).map(([event, command]) => [event, typeof command === 'string' ? [command] : []]) : Object.entries(all).map(([event, group]) => [event, commandsIn(group)]))
  const wasHooks = hookCommands(manifest.groups), nowHooks = hookCommands(groups)
  const update = !isUpdate ? undefined : {
    version: typeof loaded.version === 'string' ? loaded.version : null, approved: typeof loaded.approved === 'boolean' ? loaded.approved : null,
    ...(trustNow === undefined ? {} : { trust: trustNow }),
    hooks: [...new Set([...wasHooks.keys(), ...nowHooks.keys()])].filter(event => !isSame(wasHooks.get(event) ?? [], nowHooks.get(event) ?? [])).map(event => ({ event, before: wasHooks.get(event) ?? [], after: nowHooks.get(event) ?? [] })),
    loaded: changes.filter(change => change.action !== 'remove' && Object.hasOwn(files, change.file) && !isTextFile(change.file) && !change.file.endsWith('.new')).map(change => change.file),
  }
  const plan = {
    mode: remove ? 'remove' : 'install', agent, progress, data: root, changes, conflicts, ...(update === undefined ? {} : { update }),
    alreadyGone, ...(keptShared.length ? { keptShared } : {}), ...(keptEdited.length ? { keptEdited } : {}), ...(keptText.length ? { keptText } : {}), ...(keptCode.length ? { keptCode } : {}), ...(keptHeld.length ? { keptHeld } : {}), ...(missingHeld.length ? { missingHeld } : {}), ...(opens === undefined ? {} : { opens }), notice: [agent === 'codex' ? s.codexTrust : s.localHostReview, ...(alreadyGone.length ? [s.setupAlreadyGone(alreadyGone.join(', '))] : [])].join(' '), privacy: s.codexPrivacy,
    capabilities: { ui: 'web-and-tui', progress: 'explicit-reports', lifecycle: lifecycleCapability(agent), turnBinding: agent === 'codex' || agent === 'cursor' || agent === 'openclaw' ? 'host-event-id' : 'unavailable-in-status-events', liveReply: false },
  }
  // setup-codex.mjs and its callers still read --codex-setup's JSON, so a person reaches its plain lines through the doctor's --plain.
  const isPlainPlan = !args.includes('--json') && (remove || args.includes('--plain'))
  const outputPlan = (result: LocalPlan): void => {
    if (!isPlainPlan) output(result)
    else if (remove) process.stdout.write(codexRemoveOutput(result, s, nextCommand('--codex-remove')))
    else process.stdout.write(codexSetupOutput(result, s, nextCommand('--codex-setup', ['--plain']), nextCommand('--codex-doctor')))
  }
  // An approval this board gave is written in the record, so a later update tells it revoked from never given (#1314).
  const markApproved = (): void => {
    if (loaded.approved !== true) withInstallLock(home, () => {
      if (!isAsPlanned(manifestFile)) throw new Error('INSTALL_CHANGED')
      put(manifestFile, `${JSON.stringify({ ...loaded, approved: true }, null, 2)}
`)
    })
  }
  if (mode === '--codex-trust') {
    if (agent !== 'codex' || conflicts.length || changes.length || readLocal(manifestFile) === null) throw new Error('OWNED_CODEX_INSTALL_REQUIRED')
    const executable = flag('--codex-bin')
    if (!executable) throw new Error('CODEX_BINARY_REQUIRED')
    const result = await trustCodex(executable, config, manifest.groups, args.includes('--apply'))
    if (args.includes('--apply')) markApproved()
    if (local) output(result)
    else process.stdout.write(codexTrustOutput(result, s, args.includes('--json'), home))
    return true
  }
  if (mode === '--hermes-trust') {
    // Hermes asks the person at a terminal, and a chat gateway cannot ask: this adds only the board's own commands to its trust file, on request.
    if (agent !== 'hermes' || conflicts.length || changes.length || readLocal(manifestFile) === null) throw new Error('OWNED_HERMES_INSTALL_REQUIRED')
    const wanted = Object.entries(object(manifest.groups.hooks ?? {})).filter((pair): pair is [string, string] => typeof pair[1] === 'string')
    const approvals = readAllowlist(initial(allowlistFile), isUnreadable(allowlistFile))
    if (approvals === null) throw new Error('INVALID_HERMES_ALLOWLIST')
    const missing = wanted.filter(([event, command]) => !approvals.list.some(entry => entry.event === event && entry.command === command))
    const isApplied = args.includes('--apply')
    if (isApplied && missing.length) {
      withInstallLock(home, () => {
        if (!isAsPlanned(allowlistFile)) throw new Error('INSTALL_CHANGED')
        const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
        // The allowlist is read again just before the rename and checked after it (put, as every other write in the
        // batch does), so an edit made before that last re-read is kept; an edit saved after the re-read and before
        // the rename is still written over (#1606).
        put(allowlistFile, allowlistText({ ...approvals.data, approvals: [...approvals.list, ...missing.map(([event, command]) => ({ event, command, approved_at: stamp, script_mtime_at_approval: null }))] }))
      })
    }
    if (isApplied) markApproved()
    output({ mode: 'trust', agent, file: allowlistFile, entries: wanted.map(([event, command]) => ({ event, command, trusted: isApplied || !missing.some(one => one[0] === event) })), changes: missing.length, ...(isApplied ? { applied: true } : {}) })
    return true
  }
  if (mode === '--codex-doctor') {
    const installed = conflicts.length === 0 && changes.length === 0 && readLocal(manifestFile) !== null
    const configToml = join(dirname(configs.codex!), 'config.toml')
    const explicitBin = flag('--codex-bin')
    const executable = installed && agent === 'codex' ? (explicitBin ?? discoverCodexBinary()) : undefined
    let host: { hooks: { trust: string }[] } | null = null
    if (executable) {
      if (explicitBin) {
        host = await trustCodex(executable, config, manifest.groups, false)
      } else {
        try {
          host = await trustCodex(executable, config, manifest.groups, false)
        } catch {
          host = null
        }
      }
    }
    let hooksTrusted: boolean | 'unknown' = 'unknown'
    if (agent === 'hermes' && installed) hooksTrusted = hermesTrust()
    if (host) {
      hooksTrusted = host.hooks.every(hook => hook.trust === 'trusted')
    } else if (installed && agent === 'codex') {
      hooksTrusted = inspectCodexConfigToml(configToml)
    }
    // /progress connect may have hooked the host instead, or left only its skill (#285).
    // Exact Hermes attribution needs the connection's actual data path even in this read-only check.
    const connectorProgress = typeof connected === 'string' && isAbsolute(connected) ? connected : progress
    const connectorFolder = dirname(connectorProgress)
    const connectedHooks = agentHooks({
      home, sep: process.platform === 'win32' ? '\\' : '/', isWindows: process.platform === 'win32',
      script: join(connectorFolder, `progress-report.${process.platform === 'win32' ? 'ps1' : 'sh'}`), inbox: join(connectorFolder, 'progress-inbox'),
      codexHome: dirname(configs.codex!), grokHome: dirname(dirname(configs.grok!)), hermesHome: hermesDir,
      openclawHome: openclawDir, opencodeHome: opencodeDir, board: join(connectorFolder, 'agent-board.mjs'),
      node: process.execPath, progress: connectorProgress,
      ...(typeof hermesConnected === 'string' && isAbsolute(hermesConnected) ? { previousProgress: hermesConnected } : {}),
    })
    const hasConnectHook = connectedHooks.some(one => {
      if (one.agent !== agent || one.label === '') return false
      const original = readLocal(one.file)
      if (original === null) return false
      const text = withoutBom(original)
      if (one.generated) return text !== ''
      const removed = one.edit(text, true)
      return typeof removed === 'string' && removed !== text
    })
    // The board files this host reads: the shared skill only where it reads that one.
    const skills = [...Object.keys(files).filter(file => file.endsWith('SKILL.md') && (file !== skill || BOARD_FOR.skills!.includes(agent))), ...connectedHooks.filter(one => one.label === '' && BOARD_FOR[one.agent]?.includes(agent)).map(one => one.file)]
    const reportHook = installed ? 'installer' : hasConnectHook ? 'connect' : 'none'
    const isSkillOnly = reportHook === 'none' && skills.some(file => readLocal(file) !== null)
    const result = { ...plan, installed, ready: installed && lifecycleCapability(agent) !== 'adapter-pending', connected: 'unverified', hooksTrusted, reportHook, ...(isSkillOnly ? { problem: s.setupAgent(s.agentNames[agent] ?? agent, [s.setupSkillOnly]) } : {}), notice: s.codexDoctor }
    if (args.includes('--json')) output(result)
    // Name the Codex this check just reached: on Windows, command -v and where.exe's first line can be an npm shim that cannot start.
    else {
      // Keep the missing-program placeholder readable even when the install arguments need code-point quoting.
      const trustCommand = host && executable ? nextCommand('--codex-trust', explicitBin ? [] : ['--codex-bin', executable])
        : executable ? undefined
        : nextCommand('--codex-trust', [], s.setupSummary.codexPath)
      process.stdout.write(codexDoctorOutput(result, s, nextCommand('--codex-setup', ['--plain']), trustCommand, !executable))
    }
    return true
  }
  // A copy another setup run is writing reads as a file setup did not write until that run's record names it (#1694).
  // So before a conflict is reported for an apply, the public command's preview for one included, it is checked again
  // under the install lock: a path this plan was built from that changed since means another setup ran, and a lock
  // still held means one is running. Either stops as busy, and the next run plans again from the files as they are.
  // The lock lives in the home's .agent-board folder. With no folder no run holds it, so the check runs at once without
  // taking it: a refused run leaves no empty folder behind, as on main, and a removal that emptied and deleted the
  // folder after another run wrote does not skip the check.
  if (conflicts.length && (args.includes('--apply') || args.includes('--check-conflicts'))) {
    // A progress file setup cannot read, a link to nothing, is planned as absent, so it would never match and is left out
    // while it still reads so (#1712): a new plan would read it the same way. One setup can read, setup's own record
    // included, is checked like every other path, so a target that appeared since the plan stops the run as busy. A link
    // to the install lock reads only while this check holds the lock, a file the check itself writes, and is left out too,
    // only then: without the lock, a file there is not this run's.
    const lockFile = join(installControlRoot(home), 'install.lock')
    const isUnreadProgress = (file: string, isLocked: boolean): boolean => {
      const now = file === progress && before.get(file)?.kind === 'none' ? take(file) : null
      if (now?.kind !== 'link') return false
      const real = isLocked && now.bytes !== null ? realOf(file) : null
      return now.bytes === null || real !== null && real === realOf(lockFile)
    }
    const isChanged = (isLocked: boolean): void => { for (const file of before.keys()) if (!isUnreadProgress(file, isLocked) && !isAsPlanned(file)) throw new Error('INSTALL_CHANGED') }
    if (existsSync(installControlRoot(home))) withInstallLock(home, () => isChanged(true))
    else isChanged(false)
  }
  if (!args.includes('--apply')) { outputPlan(plan); return true }
  if (conflicts.length) {
    outputPlan(plan)
    // The plain removal already explains the conflict and its single next step.
    if (isPlainPlan) { process.exitCode = 1; return true }
    throw new Error('INSTALL_CONFLICT')
  }
  withInstallLock(home, () => {
    // Compare what each path held when the plan was built (its kind, link and bytes), not a fresh
    // snapshot taken after planning: another installer or host may have changed them in that interval.
    for (const file of before.keys()) if (!isAsPlanned(file)) throw new Error('INSTALL_CHANGED')
    local?.beforeApply?.(plan)
    // Each file is read again just before its change and checked after it (#1488, put and drop, as runSidecarOnly does),
    // so an edit made before that last re-read is never overwritten or removed, and a change that did not land is not
    // reported as applied. A stale copy and the pending list go only as planned, not through the re-read removal.
    // A mismatch stops the batch at once: files written or removed before it stay (no rollback, as in the connect
    // transaction). This agent's install record changes after every planned file (on install, other agents'
    // records are updated after it; on remove, the handover to another agent's record comes first), so a mismatch among
    // the planned files leaves the record as it was. The next setup plans again from the files as they are. A .new copy is named in the pending list before any of them, and an older entry stays
    // beside the new one, since a stop right here leaves the older copy on disk.
    // Setup is deliberately explicit. It changes neither hook trust nor config.toml; removal takes only the board's own trust tables.
    const copies = keptText.filter(one => changes.some(change => change.file === one.beside))
    const pendingWith = (named: typeof copies): string => `${JSON.stringify({ ...ownPending, ...Object.fromEntries(named.map(one => [one.beside, [...new Set([...(ownPending[one.beside] ?? []), hash(files[one.beside] ?? '')])]])) }, null, 2)}\n`
    const pendingText = pendingWith(copies)
    if (copies.length) put(pendingFile(agent), pendingText)
    // A copy leaves the list only when its write stops on proof that someone else's file is at its name (#1693), and
    // under every name of that file (a skills folder linked to the shared one): otherwise the next setup would take that
    // file as its own. Any other failure leaves the list whole, as on main, so the next run still finds setup's copy.
    // A list someone else changed in the meantime is left as it is.
    const realName = (file: string): string => join(realOf(dirname(file)) ?? dirname(file), basename(file))
    const dropPending = (file: string): void => {
      const list = pendingFile(agent)
      if (!isHolding(take(list), pendingText)) return
      const kept = copies.filter(one => realName(one.beside) !== realName(file))
      if (!kept.length && initial(list) === null) unlinkSync(list)
      else atomic(list, pendingWith(kept), () => { if (!isHolding(take(list), pendingText)) throw new Error('INSTALL_CHANGED') })
    }
    for (const change of changes) {
      if (change.file === manifestFile || removedDirs.has(change.file)) continue
      if (change.file === trustConfig && nextTrust !== undefined) {
        // A linked config.toml stays a link, and the person's permissions stay.
        const target = realpathSync(trustConfig)
        const mode = statSync(target).mode & 0o777
        put(trustConfig, nextTrust, target)
        // A link further along config.toml's chain repointed after `target` was found leaves the write on a file
        // config.toml no longer reaches (#1606): the write counts only where config.toml still points.
        let resolved: string | null = null
        try { resolved = realpathSync(trustConfig) } catch {}
        // `put` already replaced the target (its temp file is 0600), so restore the person's
        // permissions before the resolution check can report a failure (#1606).
        if (process.platform !== 'win32') chmodSync(target, mode)
        if (resolved !== target) throw new Error('INSTALL_CHANGED')
      }
      else if (change.file === allowlistFile && nextAllowlist !== undefined) put(allowlistFile, nextAllowlist)
      else if (change.file === nativeConfig) {
        if (change.action === 'remove') drop(nativeConfig)
        else put(nativeConfig, nextConfigText!)
      }
      else if (change.file === progress) {
        mkdirSync(dirname(progress), { recursive: true })
        writeFileSync(progress, '', { flag: 'wx', mode: 0o600 })
      } else if (staleBeside.has(change.file) || change.file === pendingFile(agent)) {
        // The list goes as planned or not at all, as a stale copy does. A file saved there between this read and the
        // unlink is a gap no check closes, the same for every file a removal deletes.
        if (!isAsPlanned(change.file)) throw new Error('INSTALL_CHANGED')
        unlinkSync(change.file)
      } else if (remove || retired.includes(change.file)) drop(change.file)
      else {
        try { put(change.file, files[change.file] ?? '') }
        catch (error) {
          if ((error as Error).message === 'INSTALL_CHANGED' && copies.some(one => one.beside === change.file)) try { dropPending(change.file) } catch {}
          throw error
        }
      }
    }
    if (remove) {
      if (handover) put(handover.file, handover.text)
      unchanged(manifestFile, null)
      // Only a record that read as one when setup planned, as the plan lists it: a dangling link there stays, as on main.
      if (initial(manifestFile) !== null) drop(manifestFile)
    } else {
      put(manifestFile, nextManifest)
      for (const other of localAgents.filter(one => one !== agent)) {
        const siblingFile = join(root, `install-${other}.json`)
        const siblingText = initial(siblingFile)
        if (siblingText === null) continue
        const sibling = object(JSON.parse(siblingText))
        if (sibling.files === undefined) continue
        const siblingFiles = { ...object(sibling.files) } as Record<string, string>
        let updatedSibling = false
        for (const sharedFile of [script, worker, skill, ...Object.keys(siblingFiles).filter(one => one.endsWith('.new'))]) {
          const nextText = files[sharedFile]
          if (Object.hasOwn(siblingFiles, sharedFile) && nextText !== undefined && changes.some(change => change.file === sharedFile) && siblingFiles[sharedFile] !== hash(nextText)) {
            siblingFiles[sharedFile] = hash(nextText)
            updatedSibling = true
          }
        }
        if (updatedSibling) put(siblingFile, `${JSON.stringify({ ...sibling, files: siblingFiles }, null, 2)}\n`)
      }
      // The records now name every copy. This also clears a list an earlier setup left when it stopped after its record;
      // a file under that name that is not a list stays.
      if (listOf(take(pendingFile(agent))) !== null) unlinkSync(pendingFile(agent))
    }
  })
  // A folder that cannot go (something appeared in it, or Windows holds it) stays and is not reported as removed.
  for (const folder of removedDirs) try { rmdirSync(folder) } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') changes.splice(changes.findIndex(change => change.file === folder), 1)
  }
  outputPlan({ ...plan, applied: true })
  return true
}

const isPromptEvent = (payload: Json): boolean => PROMPT_EVENTS.test(String(payload.hook_event_name ?? payload.hookEventName))

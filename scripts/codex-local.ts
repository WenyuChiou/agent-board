import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { boardConfirmedReport, codexEvent, codexEvents, codexReport, dropCodexBlock, folderProject, isLifecycleStep, limitReport, localAgentLifecycleStep, planReport, putCodexBlock, questionSteps, sessionTitle, validateCodexReport } from '../hooks/codex'
import type { CodexReport } from '../hooks/codex'
import { hermesHome } from '../hooks/hermes-home'
import { agentHooks, BOARD_FOR, editHermesSetup, isReleased, readConfig } from '../hooks/connect-pure'
import type { Strings } from '../hooks/i18n'
import { STRINGS } from '../hooks/strings'
import { parseProgress, STALE_MS } from '../hooks/parse'
import { reporterTail } from './reporter-tail'
import { othersNote } from '../hooks/others'
import { cleanSignal, codexSignal, isStrongRun, pickParent, withSignal } from '../hooks/runs'
import type { RunSignal } from '../hooks/runs'
import { antigravityCommand, antigravityHooks, cursorEvent, cursorEvents, hookCommandArgs, lifecycleCapability, localAgents, opencodePlugin, planEvents, planPlugins, statusEvents, windowsHookCommand } from '../hooks/local-agents'
import type { LocalAgent } from '../hooks/local-agents'
import { deepseekLocalPlugin, deepseekPatch, openclawLocalPlugin } from '../hooks/portable-agents'
import { HOOK_SESSION_ENV, HOOK_VERSION, hookWorker, hostHookTimeout } from '../hooks/hook-safety'
import { discoverCodexBinary, inspectCodexConfigToml, trustCodex } from './codex-host'
import { withLocalLock } from './local-lock'
import { installControlRoot, withInstallLock } from './install-control'
import { ConnectTransaction } from './connect-transaction'
import { boardPromptHelper, boardRequestWords, boardRun, isBoardRequest } from '../hooks/board-commands'
import { PROMPT_EVENTS } from '../hooks/inbox'
import { windowsHookNode } from './windows-hook-node'
import { claimHookRecovery } from './hook-recovery-owner'
import { findSessionFile, readSessionMeta } from './codex-history'
import { RELEASED } from '../hooks/released'
import { deliveryText, SURFACE_IDS } from '../hooks/messaging'
import { deliverTurnEvent } from './hook-delivery'
import { hookMailbox } from './board-messaging'
import { defaultMessagesDirectory } from './runtime-folder'
import { folderIdentity, matchesFolderIdentity } from './folder-identity'
import { appendJournal, journalLine, journalPath } from '../hooks/journal'
import { currentPart } from '../hooks/retention'
import { lastQuestion } from '../hooks/digest'

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

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

// Antigravity hooks name their own transcript but do not carry the reply text.
// agy 1.5.2 names transcript_full.jsonl, which has the same line shape as transcript.jsonl.
const antigravityTranscripts = new Set(['transcript.jsonl', 'transcript_full.jsonl'])
const antigravityQuestion = (path: unknown): string | null => {
  if (typeof path !== 'string' || !isAbsolute(path) || !antigravityTranscripts.has(basename(path))) return null
  try {
    if (!lstatSync(path).isFile()) return null
    const fd = openSync(path, 'r')
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
          if (typeof entry.content !== 'string') return null
          if (entry.content.trim() !== '') reply = entry.content
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
const readBytes = (file: string): Buffer | null => {
  try { return readFileSync(file) } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  }
}
const readLocal = (file: string): string | null => readBytes(file)?.toString('utf8') ?? null

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
const readAllowlist = (text: string | null): { data: Json; list: Approval[] } | null => {
  if (text === null) return { data: {}, list: [] }
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
// A root that is not a mapping (a list, a flow document) is not something to add a key to.
const isYamlMapping = (text: string): boolean => text.split(/\r?\n/).every(line => !/^\S/.test(line) || /^(?:#|---|\.\.\.)/.test(line) || /^(?:"[^"\n]*"|'[^'\n]*'|[^\s#{[!&*|>%@`"'-][^\n]*?)\s*:(?:\s|$)/.test(line))
const atomic = (file: string, text: string | Buffer, current: () => void = () => {}, retryRecord = false): void => {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  let isOpen = true
  try {
    writeFileSync(fd, text)
    closeSync(fd)
    isOpen = false
    let delay = 10, waited = 0
    for (;;) {
      current()
      try {
        renameSync(temporary, file)
        break
      } catch (error) {
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
  applied?: boolean
}

export const codexDoctorOutput = (result: LocalPlan & {
  installed: boolean
  reportHook: string
  hooksTrusted: boolean | 'unknown'
  problem?: string
  capabilities: { lifecycle: string }
}, s: Strings, command: string, trustCommand?: string): string => {
  const words = s.localSummary
  const host = s.agentNames[result.agent] ?? result.agent
  const hasHook = result.installed || result.reportHook === 'connect'
  const lines = [words.doctor(host, result.installed ? words.installed : hasHook ? words.connector : words.missing)]
  if (result.problem) lines.push(result.problem)
  for (const file of result.conflicts) lines.push(words.conflict(file))
  if (!hasHook) for (const change of result.changes) lines.push(words.needsUpdate(change.file))
  const isPending = result.capabilities.lifecycle === 'adapter-pending'
  if (isPending) lines.push(words.pending)
  if (result.agent === 'codex' && result.installed) lines.push(result.hooksTrusted === true ? words.trusted : result.hooksTrusted === false ? words.untrusted : words.trustUnknown)
  lines.push(s.codexDoctor)
  lines.push(result.conflicts.length ? words.review(command)
    : !hasHook ? words.setup(command)
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
  const record = typeof detail?.record === 'string' && /^install-[a-z]+\.json$/.test(detail.record) ? detail.record : 'install-*.json'
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
  const before = new Map<string, string | null>()
  const initial = (file: string): string | null => {
    if (!before.has(file)) before.set(file, readLocal(file))
    return before.get(file)!
  }
  const jsonInitial = (file: string): Json => {
    try {
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
    if (agent !== 'deepseek' && agent !== 'opencode' || session === undefined || !['take', 'accept', 'end', ...(agent === 'opencode' ? ['ack', 'release', 'attempt'] : [])].includes(action ?? '')) throw new Error('INVALID_MAILBOX_CALL')
    const directory = defaultMessagesDirectory(progress, home, process.env, process.platform)
    // This path runs in the plugin's own process with seconds to spare, so it waits for a busy board or store (a turn-start hook cannot).
    const mailbox = hookMailbox(directory, 5000, 2000, 2000)
    const answer = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
    // A failed call answers ok false with the board's own code, never a bare failure and never ok true.
    const codeOf = (error: unknown): string => error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'BOARD_NOT_RUNNING'
    if (action === 'take') {
      const surface = flag('--surface'), ref = flag('--ref')
      // OpenCode's plugin names the claim (12 hex), so it can release it again.
      if (ref !== undefined && (agent !== 'opencode' || !/^[0-9a-f]{12}$/.test(ref))) throw new Error('INVALID_MAILBOX_CALL')
      let message: Awaited<ReturnType<typeof mailbox.turnOrThrow>>
      try {
        message = await mailbox.turnOrThrow(agent, session, surface === SURFACE_IDS.web || surface === SURFACE_IDS.tui || agent === 'opencode' && surface === SURFACE_IDS.cli ? surface : SURFACE_IDS.unknown, Date.now(), ref)
      } catch (error) {
        // A failed take is not an empty mailbox: the plugin tries again on its own clock.
        answer({ ok: false, code: error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'BOARD_NOT_RUNNING', watch: directory, message: null })
        return true
      }
      // The one line DeepSeek's page shows for the message, kept to the 120 characters dsh allows a notice.
      const line = message === null ? '' : message.text.replace(/\s+/g, ' ').trim()
      const summary = line.length > 120 ? `${line.slice(0, 119)}…` : line
      answer({ watch: directory, message: message === null ? null : { id: message.id, nonce: message.nonce, text: deliveryText(message, s), summary } })
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
      await mailbox.accept(agent, session, id, nonce, Date.now())
      answer({ ok: true })
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
        answer(codeOf(error) === 'BOARD_NOT_RUNNING' && !existsSync(directory) ? { ok: true } : { ok: false, code: codeOf(error) })
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
  const manifest: Manifest = { files: object(loaded.files ?? {}) as Record<string, string>, groups: object(loaded.groups ?? {}), foreignGroups: object(loaded.foreignGroups ?? {}) }
  // A check must not fail on the words of its next step: an argument a shell would expand or eat goes through boardRun's code points.
  const nextCommand = (nextMode: string, extra: string[] = []): string => {
    const rest = [nextMode, ...args.filter(arg => arg !== mode && arg !== '--apply' && arg !== '--json' && arg !== '--plain'), ...extra]
      // A Codex path a person can read: Windows takes forward slashes, and they need no code points.
      .map((arg, index, all) => process.platform === 'win32' && all[index - 1] === '--codex-bin' ? arg.replaceAll('\\', '/') : arg)
    if (rest.some(arg => /["`$%!\\\r\n]/.test(arg))) return boardRun(process.argv[1]!, rest)
    return `${boardRun(process.argv[1]!)} ${rest.map(arg => /^[\w.:=/-]+$/.test(arg) ? arg : quote(arg)).join(' ')}`
  }
  const output = (value: unknown): void => {
    if (local) local.output(value)
    else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
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
      status: unknown; event?: string; folder?: string; folderDigest?: string; folderCanonicalDigest?: string; isBoardPrompt: boolean; isPrompt: boolean; payload: Json
      // Who started the session, as far as the host's own words say (#399); absent when they say nothing.
      run?: RunSignal
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
      if (event !== undefined && statusEvents.antigravity?.[event] !== status) throw new Error('INVALID_EVENT_STATE')
      // Classify before Cursor's adapter drops prompt text; retain lifecycle
      // ordering without treating a board lookup as an answer to the question.
      const isBoardPrompt = (isPromptEvent(raw) || raw.prompt_submitted === true) && (raw.board_request === true || isBoardRequest(raw, boardRequestWords(Object.values(STRINGS))))
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
      return {
        version: 1, progress, mode, agent, session, now, at, status: mode === '--agent-status' ? status : undefined, event, isBoardPrompt, isPrompt,
        ...(filesByFolder(mode, agent) ? { folder } : {}),
        ...(identity !== undefined && (agent !== 'codex' || folderProject(rawCwd) !== '') ? identity : {}),
        ...(run === undefined ? {} : { run }),
        payload: mode === '--codex-report' ? payload : mode === '--codex-event' ? {
          session_id: payload.session_id, hook_event_name: payload.hook_event_name,
          turn_id: payload.turn_id, prompt_submitted: payload.prompt_submitted,
          ...(hasResponse ? { has_response: true } : {}),
          ...(question === null ? {} : { question }),
        } : { ...(question === null ? {} : { question }) },
      }
    }
    const current = isRecovery ? undefined : buildEntry(mode, agent, raw, flag, process.env, progress, started)
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
      return buildEntry(entryMode, entryAgent, object(raw.payload), name => flags.get(name), env as NodeJS.ProcessEnv, resolve(flags.get('--progress-file')!), Number(raw.at))
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
    const apply = (entry: Pending, isRawReplay = false): CodexReport => {
      const { mode, agent, session, now, at, status, event, folder = '', folderDigest, folderCanonicalDigest, isBoardPrompt, payload, run } = entry
      const displayAt = Date.parse(now)
      const sourceAt = at ?? displayAt
      const observedAt = Date.now()
      const owner = hash(`${agent}:${session}`)
      const recordFile = join(root, 'sessions', `${owner}.json`)
      const saved = readLocal(recordFile)
      const original = saved === null ? null : JSON.parse(saved) as CodexReport & { appliedAt?: number; pushed?: string[] }
      // Raw recovery can start a fresh session within its allowed clock skew.
      // An existing session's clock must not move past the next real hook.
      const isSkewedBootstrap = isRawReplay && original === null
      if (mode === '--codex-event' && (!Number.isFinite(sourceAt) || !Number.isFinite(displayAt) ||
        !isSkewedBootstrap && (sourceAt > observedAt || displayAt > observedAt))) throw new Error('INVALID_EVENT_TIME')
      if (entry === current && original === null) isFirstSessionEvent = true
      if (original?.agent && original.agent !== agent) throw new Error('SESSION_CONFLICT')
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
      // A mirrored plan keeps the block's own title, unless it is still the generic one a lifecycle event wrote.
      const given = typeof payload.planTitle !== 'string' ? payload : {
        state: payload.state, steps: payload.steps,
        title: previous !== null && !Object.values(STRINGS).some(one => [one.codexTask, one.localAgentTask(agent)].includes(previous.title)) ? previous.title : payload.planTitle,
        ...(typeof payload.planProject === 'string' ? { project: previous?.project ?? payload.planProject } : {}),
      }
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
      const question = questionSteps(held, previous?.asked, state, payload.question, isBoardPrompt, previous?.askedRevision)
      // Keep the recovery format. Causality uses the host event's milliseconds,
      // which the display clock can round or carry forward.
      const base = mode === '--codex-event' ? codexEvent(previous, isBoardPrompt ? { ...payload, board_request: true } : payload, clock, s, sourceAt, { lastAppliedAt: original?.appliedAt, observedAt })
        : mode === '--agent-status' ? validateCodexReport({
          // These are already validated stored steps, including up to two owned lines beyond
          // the explicit report's forty user steps. A status is not a fresh task report.
          ...(previous ?? codexReport(null, session, { title: s.localAgentTask(agent), project: agent, state, steps: question.steps }, clock, s)),
          state: state as CodexReport['state'], steps: question.steps, updated: clock, asked: question.asked,
          ...(question.askedRevision === undefined ? {} : { askedRevision: question.askedRevision }),
        }, session) : codexReport(previous, session, given, clock, s)
      // A queued folder is cleaned again: the queue file is not trusted to hold a clean name.
      const name = folderProject(folder)
      // An Antigravity session keeps no folder (its hook binds only the conversation
      // id), so a new one would otherwise read as every other unreported Antigravity
      // session. A session that still carries only the generic title is re-titled
      // the same way on its next lifecycle event (#814). The distinct part is the
      // session's start time in local time, to the millisecond: second precision
      // would let two sessions started in the same second share a title, and a
      // hash prefix is not shown on a default view. The title is set once and kept
      // by later events (stillGeneric only matches the generic title), and an
      // explicit report title still wins; no new data is retained, and the
      // translated fallback needs no new string.
      const stillGeneric = previous !== null && Object.values(STRINGS).some(one => one.localAgentTask(agent) === previous.title)
      const distinctAntigravity = mode === '--agent-status' && agent === 'antigravity' && (previous === null || stillGeneric)
      const initial = (filesByFolder(mode, agent) && !previous) || distinctAntigravity ? validateCodexReport({
        ...base, title: sessionTitle(name, s.localAgentTask(agent), distinctAntigravity ? distinctStarted(sourceAt) : ''), project: previous?.project ?? (name || agent),
      }, session) : base
      const priorActivity = previous?.activity ?? []
      // Only a weak hint needs a parent; a strong run keeps its record without a block.
      const parent = origin.origin !== 'run' ? undefined : isRun ? origin.parent : origin.parent ?? pickParent(parseProgress(text), initial.project, Date.parse(clock), [owner, owner.slice(0, 8), session]) ?? undefined
      const marked = { ...(origin.origin === undefined ? {} : { origin: origin.origin }), ...(parent === undefined ? {} : { parent }), ...(origin.isWeak === true ? { isWeak: true as const } : {}) }
      const { origin: _origin, parent: _parent, isWeak: _isWeak, ...lifecycle } = initial
      const directory = agent === 'codex' && mode === '--codex-event' && name !== ''
        ? { folder: name, folderDigest, folderCanonicalDigest }
        : { folder: original?.folder, folderDigest: folderDigest ?? original?.folderDigest,
          folderCanonicalDigest: folderDigest === undefined ? original?.folderCanonicalDigest : folderCanonicalDigest }
      const full = { ...lifecycle, ...marked, ...directory, appliedAt: Math.max(sourceAt, original?.appliedAt ?? (original === null ? displayAt : Date.parse(original.updated))), ...(original?.pushed === undefined ? {} : { pushed: original.pushed }), ...(isBoardPrompt && previous ? { state: previous.state, steps: previous.steps, ...(previous.approval === undefined ? {} : { approval: previous.approval }), ...(previous.asked === undefined ? {} : { asked: previous.asked }) } : {}), agent, ...(event === undefined ? {} : { activity: [...priorActivity, { event, state: String(status), updated: clock }].slice(-16) }) }
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
      if (repaired.fragment === null && mode !== '--codex-report' && previous === original && original !== null && previous !== null && previous.state === report.state && previous.turn === report.turn && previous.title === report.title && JSON.stringify(previous.steps) === JSON.stringify(report.steps) && JSON.stringify(previous.events) === JSON.stringify(report.events) && JSON.stringify(previous.retiredTurns) === JSON.stringify(report.retiredTurns) && previous.origin === report.origin && previous.parent === report.parent && previous.isWeak === report.isWeak && previous.folder === report.folder && previous.folderDigest === report.folderDigest && previous.folderCanonicalDigest === report.folderCanonicalDigest && (event === undefined || priorActivity.at(-1)?.event === event)) {
        if (report.appliedAt > (original.appliedAt ?? Date.parse(original.updated))) atomic(recordFile, `${JSON.stringify({ ...original, appliedAt: report.appliedAt }, null, 2)}\n`, checkDeadline, true)
        return report
      }
      // Encode only the new report; existing bytes, including partial UTF-8, pass through unchanged.
      const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('latin1')
      const next = Buffer.from(putCodexBlock(repaired.bytes.toString('latin1'), {
        ...report, title: encoded(report.title), project: encoded(report.project), steps: report.steps.map(encoded),
      }, owner, mode === '--codex-report' && previous !== null && previous.project !== report.project), 'latin1')
      saveFullText()
      const aside = repaired.fragment === null ? null : saveReporterTail(progress, repaired.fragment)
      try { atomic(progress, next, checkDeadline) } catch (error) {
        if (aside !== null) {
          try { unlinkSync(aside) } catch {}
        }
        throw error
      }
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
      const file = join(pending, `${String(started).padStart(15, '0')}-${randomUUID()}.json`)
      atomic(file, `${JSON.stringify(current)}\n`, checkDeadline)
      queuedFile = file
    }
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
        if (!isBusy(error) && !(error instanceof Error && error.message === 'HOOK_TIMEOUT')) throw error
        // Save before a bounded wait: Windows lock recovery and timer scheduling
        // can consume the remaining budget, after which the write guard must close.
        // A full queue does not fail yet: like a hook without a deadline, it waits and retries.
        if (value !== undefined && mode !== '--codex-report') {
          try { queue(error) } catch (failure) { if (failure !== error) throw failure }
        }
        const left = deadline - performance.now()
        if (left <= 0) {
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
  const read = hasHooks && agent !== 'hermes' || agent === 'openclaw' ? readConfig(configText) : {}
  // Wrong shapes are the same one conflict as unreadable JSON, so other agents still preview (#465).
  const parsedConfig = read !== null && !isShaped(read) ? null : read
  const hookConfig = parsedConfig ?? {}
  // A config that cannot be read is one conflict of its own; its groups are not also reported as edited.
  const isReadable = parsedConfig !== null
  const hooks = object(hookConfig.hooks ?? {})
  const worker = join(root, 'agent-board-hook.mjs')
  const hookArgs = (event: string, state?: string): string[] => hookCommandArgs(process.execPath, home, agent, worker, progress, event, state)
  const isSame = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  const remove = mode === '--codex-remove'
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
      if (text !== null) {
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
  // Only the program is kept from the last install; every other word is written from this run.
  const commandsOf = (value: unknown): unknown[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(commandsOf) : [(value as Json).command, ...commandsOf((value as Json).hooks)]
  const earlier = commandsOf(Object.values(manifest.groups)).filter((command): command is string => typeof command === 'string')
  const hostNode = isPowerShellHost || isQuoteFreeHost ? windowsHookNode(process.execPath, earlier) : undefined
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
      else hasMissingGroup = true
    }
    if (!remove) {
      // Exact generated bytes can be adopted after a partially interrupted install.
      nextHooks[event] = [...kept.filter(entry => !isSame(entry, group)), group]
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
      else hasMissingGroup = true
    }
    nextConfig = { ...hookConfig }
    if (!remove) { nextConfig[name] = desired; groups[name] = desired }
    else if (owned !== undefined) delete nextConfig[name]
  }
  let nextConfigText: string | null = null
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
      else hasMissingGroup = true
    }
    nextConfig = { ...hookConfig, plugins: {
      ...plugins,
      load: { ...load, paths: remove ? paths.filter(path => path !== pluginFile) : [...paths.filter(path => path !== pluginFile), pluginFile] },
      entries: { ...entries, ...(!remove ? { [id]: desired } : {}) },
      ...(allow === undefined ? {} : { allow: remove && manifest.groups.allowAdded === true ? allow.filter(one => one !== id) : !remove && allow.length && !allow.includes(id) ? [...allow, id] : allow }),
    } }
    if (remove) delete object(object(nextConfig.plugins).entries)[id]
    else {
      groups[id] = desired
      groups.allowAdded = manifest.groups.allowAdded ?? Boolean(allow?.length && !allow.includes(id))
    }
  }
  if (agent === 'deepseek') {
    const text = initial(nativeConfig) ?? ''
    if (manifest.groups.patch !== undefined && !text.includes('agent-board-local')) {
      if (remove) alreadyGone.push(`${nativeConfig}:agent-board-local`)
      else hasMissingGroup = true
    }
    const patch = deepseekPatch(text, manifest.groups.patch, pathToFileURL(join(root, 'adapters', 'deepseek.mjs')).href, remove)
    if (patch.conflict) conflicts.push(nativeConfig)
    nextConfigText = patch.text
    if (patch.group) groups.patch = patch.group
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
  if (agent === 'hermes') {
    const text = initial(nativeConfig) ?? ''
    const events = hermesEvents()
    const recorded = new Map(Object.entries(object(manifest.groups.hooks ?? {})).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    const patch = isYamlMapping(text) ? editHermesSetup(text, events, recorded, remove) : null
    if (manifest.groups.hooks !== undefined && patch !== null && !patch.hasOwned) {
      if (remove) alreadyGone.push(`${nativeConfig}:hooks`)
      else hasMissingGroup = true
    }
    if (patch === null) conflicts.push(nativeConfig)
    nextConfigText = patch?.text ?? text
    if (!remove && patch !== null) groups.hooks = Object.fromEntries(events.map(([event, command]) => [event, command]))
    if (remove) {
      const approvals = readAllowlist(initial(allowlistFile))
      const mine = Object.entries(object(manifest.groups.hooks ?? {}))
      if (approvals !== null) {
        const kept = approvals.list.filter(entry => !mine.some(([event, command]) => entry.event === event && entry.command === command))
        if (kept.length !== approvals.list.length) {
          nextAllowlist = allowlistText({ ...approvals.data, approvals: kept })
          changes.push({ file: allowlistFile, action: 'update' })
        }
      }
    }
  }
  const skillText = `---\nname: agent-board\ndescription: ${JSON.stringify(fileWords.localAgentSkillDescription)}\n---\n\n${fileWords.localAgentSkill(`${quote(process.execPath)} ${quote(script)}`)}\n\n${fileWords.localAgentHandoff}\n\n${fileWords.codexTrust}\n\nCodex: ${configs.codex}\n${codexEvents.join(', ')}\n`
  // The connect writes its board beside the progress file it connected: the default one, one a
  // CLAUDE_CONFIG_DIR or CLAUDE_PROGRESS_FILE names, or the one its own record keeps (#285).
  // Releases before de40dde wrote the command as node "<path>" for any path; later ones use boardRun.
  const connected = ((): unknown => {
    try { return object(JSON.parse(readFileSync(join(installControlRoot(home), 'legacy-connect.json'), 'utf8'))).connectedProgress } catch { return undefined }
  })()
  const legacyProgress = [join(home, '.claude', 'progress.md'), process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'progress.md') : '', process.env.CLAUDE_PROGRESS_FILE ?? '', typeof connected === 'string' ? connected : '']
  const legacyBoards = legacyProgress.filter(path => path !== '').flatMap(path => [path.replace(/[\\/][^\\/]*$/, '') + (process.platform === 'win32' ? '\\' : '/') + 'agent-board.mjs', join(dirname(path), 'agent-board.mjs')])
  const legacySkills = Object.values(STRINGS).flatMap(words => [...new Set(legacyBoards.flatMap(board => [boardRun(board), `node "${board}"`]))].map(run => `---\nname: agent-board\ndescription: ${JSON.stringify(words.boardCommandDescription)}\n---\n\n${words.boardSkillPrompt(run)}\n`))
  // /progress connect writes Antigravity's skill too; that one is taken over like the shared one (#285).
  const antigravitySkill = join(home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')
  const original = readFileSync(process.argv[1] ?? '', 'utf8').replace(/^globalThis\.AGENT_BOARD[^\n]*\n/, '')
  const files: Record<string, string> = {
    [script]: `globalThis.AGENT_BOARD = ${JSON.stringify({ hookVersion: HOOK_VERSION, path: progress, codexRoot: root, lang: Object.entries(STRINGS).find(([, words]) => words === fileWords)?.[0] ?? 'en' })}\n${original}`,
    [worker]: hookWorker(home, script, boardPromptHelper(boardRequestWords(Object.values(STRINGS)))),
    [skill]: skillText,
  }
  if (agent === 'opencode') files[join(opencodeDir, 'plugins', 'agent-board-local.js')] = opencodePlugin(process.execPath, worker, progress, fileWords.localAgentSkillDescription, home, fileWords.localAgentStepFormat, script, fileWords)
  if (agent === 'openclaw') {
    files[join(root, 'adapters', 'openclaw', 'agent-board-local.mjs')] = openclawLocalPlugin(process.execPath, worker, progress, home, fileWords.openclawProgressTool, fileWords.localAgentStepFormat)
    files[join(root, 'adapters', 'openclaw', 'openclaw.plugin.json')] = `${JSON.stringify({ id: 'agent-board-local', contracts: { tools: ['progress_card'] }, configSchema: { type: 'object', additionalProperties: false, properties: {} } }, null, 2)}\n`
    files[join(openclawDir, 'skills', 'agent-board', 'SKILL.md')] = skillText
  }
  if (agent === 'deepseek') {
    files[join(root, 'adapters', 'deepseek.mjs')] = deepseekLocalPlugin(process.execPath, worker, progress, home, script, fileWords.deepseekBoardTool, fileWords.localAgentStepFormat)
    files[join(deepseekDir, 'skills', 'agent-board', 'SKILL.md')] = skillText
  }
  if (agent === 'hermes') files[join(hermesDir, 'skills', 'agent-board', 'SKILL.md')] = skillText
  if (agent === 'antigravity') files[antigravitySkill] = skillText
  if (agent === 'gemini') files[join(home, '.gemini', 'commands', 'agent-board.toml')] = `description = ${JSON.stringify(fileWords.boardCommandDescription)}\nprompt = '''${fileWords.boardCommandPrompt}\n\n!{${quote(process.execPath)} ${quote(script)}}\n'''\n`
  if (agent === 'opencode') files[join(opencodeDir, 'commands', 'agent-board.md')] = `---\ndescription: ${JSON.stringify(fileWords.boardCommandDescription)}\n---\n\n${fileWords.boardCommandPrompt}\n\n!\`${quote(process.execPath)} ${quote(script)}\`\n`
  // 0.24.2 and earlier wrote /board here. The command is now /agent-board, so setup takes the old file
  // away when it is still the bytes setup or a release wrote, and leaves one the person edited (#868).
  const retired = agent === 'gemini' ? [join(home, '.gemini', 'commands', 'board.toml')] : agent === 'opencode' ? [join(opencodeDir, 'commands', 'board.md')] : []
  const keptEdited: string[] = []
  const isReleasedBoard = (text: string): boolean => {
    const bodyHash = hash(text.replace(/^globalThis\.AGENT_BOARD[^\n]*\n/, ''))
    return RELEASED.some(release => release.board.includes(bodyHash))
  }
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
    const owned = existing !== null && (hash(existing) === manifest.files[file] || (!remove && (otherManifests.some(one => object(one.files ?? {})[file] === hash(existing)) || (file === script && isReleasedBoard(existing)) || (file === skill || file === antigravitySkill) && legacySkills.includes(existing))))
    if (existing !== null && !owned && existing !== desired) conflicts.push(file)
    else if (remove ? owned : existing !== desired) changes.push({ file, action: remove ? 'remove' : existing === null ? 'create' : 'update' })
  }
  for (const file of retired) {
    const existing = initial(file)
    if (existing === null) {
      if (remove && Object.hasOwn(manifest.files, file)) alreadyGone.push(file)
    } else if (hash(existing) === manifest.files[file] || [script, ...legacyBoards].some(board => isReleased(agent === 'gemini' ? 'gemini' : 'opencode', existing, { board }))) changes.push({ file, action: 'remove' })
    else keptEdited.push(file)
  }
  // A host-directory override must not strand an old active plugin outside the
  // new ownership record. Remove the old scoped install before changing roots.
  for (const file of Object.keys(manifest.files)) if (!(file in files) && !retired.includes(file)) conflicts.push(file)
  const hasNativeConfig = hasHooks || agent === 'openclaw' || agent === 'deepseek'
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
    else if (agent === 'deepseek' || agent === 'hermes' ? initial(nativeConfig) !== nextConfigText : !isSame(hookConfig, nextConfig)) changes.push({ file: nativeConfig, action: initial(nativeConfig) === null || hasMissingGroup ? 'create' : 'update' })
  }
  if (!remove && readLocal(progress) === null) { before.set(progress, null); changes.push({ file: progress, action: 'create' }) }
  const createdDirs = new Set(Array.isArray(loaded.createdDirs) ? loaded.createdDirs.filter((value): value is string => typeof value === 'string') : [])
  const folderKey = (folder: string): string => process.platform === 'win32' ? resolve(folder).toLowerCase() : resolve(folder)
  const isBelow = (folder: string, parent: string): boolean => folderKey(folder).startsWith(`${folderKey(parent)}${process.platform === 'win32' ? '\\' : '/'}`)
  if (!remove) for (const file of [...changes.filter(change => change.action === 'create').map(change => change.file), ...(initial(manifestFile) === null ? [manifestFile] : [])]) {
    for (let folder = dirname(file); folder !== dirname(folder) && folder !== home && !isBelow(home, folder) && !existsSync(folder); folder = dirname(folder)) createdDirs.add(folder)
  }
  const createdConfig = hasNativeConfig && (initial(nativeConfig) === null || loaded.createdConfig === true)
  const nextManifest = `${JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, hash(text)])), groups, foreignGroups, progress, ...(config === '' ? {} : { config }), ...(createdConfig ? { createdConfig: true } : {}), ...(createdDirs.size ? { createdDirs: [...createdDirs].sort() } : {}) }, null, 2)}\n`
  if (remove ? initial(manifestFile) !== null : initial(manifestFile) !== nextManifest) changes.push({ file: manifestFile, action: remove ? 'remove' : initial(manifestFile) === null ? 'create' : 'update' })
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
  const plan = {
    mode: remove ? 'remove' : 'install', agent, progress, data: root, changes, conflicts,
    alreadyGone, ...(keptShared.length ? { keptShared } : {}), ...(keptEdited.length ? { keptEdited } : {}), notice: [agent === 'codex' ? s.codexTrust : s.localHostReview, ...(alreadyGone.length ? [s.setupAlreadyGone(alreadyGone.join(', '))] : [])].join(' '), privacy: s.codexPrivacy,
    capabilities: { ui: 'web-and-tui', progress: 'explicit-reports', lifecycle: lifecycleCapability(agent), turnBinding: agent === 'codex' || agent === 'cursor' || agent === 'openclaw' ? 'host-event-id' : 'unavailable-in-status-events', liveReply: false },
  }
  // setup-codex.mjs and its callers still read --codex-setup's JSON, so a person reaches its plain lines through the doctor's --plain.
  const isPlainPlan = !args.includes('--json') && (remove || args.includes('--plain'))
  const outputPlan = (result: LocalPlan): void => {
    if (!isPlainPlan) output(result)
    else if (remove) process.stdout.write(codexRemoveOutput(result, s, nextCommand('--codex-remove')))
    else process.stdout.write(codexSetupOutput(result, s, nextCommand('--codex-setup', ['--plain']), nextCommand('--codex-doctor')))
  }
  if (mode === '--codex-trust') {
    if (agent !== 'codex' || conflicts.length || changes.length || readLocal(manifestFile) === null) throw new Error('OWNED_CODEX_INSTALL_REQUIRED')
    const executable = flag('--codex-bin')
    if (!executable) throw new Error('CODEX_BINARY_REQUIRED')
    const result = await trustCodex(executable, config, manifest.groups, args.includes('--apply'))
    if (local) output(result)
    else process.stdout.write(codexTrustOutput(result, s, args.includes('--json'), home))
    return true
  }
  if (mode === '--hermes-trust') {
    // Hermes asks the person at a terminal, and a chat gateway cannot ask: this adds only the board's own commands to its trust file, on request.
    if (agent !== 'hermes' || conflicts.length || changes.length || readLocal(manifestFile) === null) throw new Error('OWNED_HERMES_INSTALL_REQUIRED')
    const wanted = Object.entries(object(manifest.groups.hooks ?? {})).filter((pair): pair is [string, string] => typeof pair[1] === 'string')
    const approvals = readAllowlist(initial(allowlistFile))
    if (approvals === null) throw new Error('INVALID_HERMES_ALLOWLIST')
    const missing = wanted.filter(([event, command]) => !approvals.list.some(entry => entry.event === event && entry.command === command))
    const isApplied = args.includes('--apply')
    if (isApplied && missing.length) {
      withInstallLock(home, () => {
        if (readLocal(allowlistFile) !== initial(allowlistFile)) throw new Error('INSTALL_CHANGED')
        const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
        atomic(allowlistFile, allowlistText({ ...approvals.data, approvals: [...approvals.list, ...missing.map(([event, command]) => ({ event, command, approved_at: stamp, script_mtime_at_approval: null }))] }))
      })
    }
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
    if (agent === 'hermes' && installed) {
      const approvals = readAllowlist(initial(allowlistFile))
      const wanted = Object.entries(object(manifest.groups.hooks ?? {}))
      hooksTrusted = approvals === null ? 'unknown' : wanted.length > 0 && wanted.every(([event, command]) => approvals.list.some(entry => entry.event === event && entry.command === command))
    }
    if (host) {
      hooksTrusted = host.hooks.every(hook => hook.trust === 'trusted')
    } else if (installed && agent === 'codex') {
      hooksTrusted = inspectCodexConfigToml(configToml)
    }
    // /progress connect may have hooked the host instead, or left only its skill (#285).
    const connected = agentHooks({
      home, sep: process.platform === 'win32' ? '\\' : '/', isWindows: process.platform === 'win32', script: '', inbox: '',
      codexHome: dirname(configs.codex!), grokHome: dirname(dirname(configs.grok!)), hermesHome: hermesDir,
      openclawHome: openclawDir, opencodeHome: opencodeDir, board: script,
    })
    const hasConnectHook = connected.some(one => {
      if (one.agent !== agent || one.label === '') return false
      const original = readLocal(one.file)
      if (original === null) return false
      const text = withoutBom(original)
      if (one.generated) return text !== ''
      const removed = one.edit(text, true)
      return typeof removed === 'string' && removed !== text
    })
    // The board files this host reads: the shared skill only where it reads that one.
    const skills = [...Object.keys(files).filter(file => file.endsWith('SKILL.md') && (file !== skill || BOARD_FOR.skills!.includes(agent))), ...connected.filter(one => one.label === '' && BOARD_FOR[one.agent]?.includes(agent)).map(one => one.file)]
    const reportHook = installed ? 'installer' : hasConnectHook ? 'connect' : 'none'
    const isSkillOnly = reportHook === 'none' && skills.some(file => readLocal(file) !== null)
    const result = { ...plan, installed, ready: installed && lifecycleCapability(agent) !== 'adapter-pending', connected: 'unverified', hooksTrusted, reportHook, ...(isSkillOnly ? { problem: s.setupAgent(s.agentNames[agent] ?? agent, [s.setupSkillOnly]) } : {}), notice: s.codexDoctor }
    if (args.includes('--json')) output(result)
    // Name the Codex this check just reached: on Windows, command -v and where.exe's first line can be an npm shim that cannot start.
    else process.stdout.write(codexDoctorOutput(result, s, nextCommand('--codex-setup', ['--plain']), host ? nextCommand('--codex-trust', explicitBin ? [] : ['--codex-bin', executable!]) : undefined))
    return true
  }
  if (!args.includes('--apply')) { outputPlan(plan); return true }
  if (conflicts.length) {
    outputPlan(plan)
    // The plain removal already explains the conflict and its single next step.
    if (isPlainPlan) { process.exitCode = 1; return true }
    throw new Error('INSTALL_CONFLICT')
  }
  withInstallLock(home, () => {
    // Compare the bytes used to build the plan, not a fresh snapshot taken after
    // planning: another installer or host may have changed them in that interval.
    for (const [file, expected] of before) if (readLocal(file) !== expected) throw new Error('INSTALL_CHANGED')
    local?.beforeApply?.(plan)
    // Setup is deliberately explicit. It changes neither hook trust nor config.toml; removal takes only the board's own trust tables.
    for (const change of changes) {
      if (change.file === manifestFile || removedDirs.has(change.file)) continue
      if (change.file === trustConfig && nextTrust !== undefined) {
        // A linked config.toml stays a link, and the person's permissions stay.
        const target = realpathSync(trustConfig)
        const mode = statSync(target).mode & 0o777
        atomic(target, nextTrust)
        if (process.platform !== 'win32') chmodSync(target, mode)
      }
      else if (change.file === allowlistFile && nextAllowlist !== undefined) atomic(allowlistFile, nextAllowlist)
      else if (change.file === nativeConfig) {
        if (change.action === 'remove') unlinkSync(nativeConfig)
        else atomic(nativeConfig, nextConfigText!)
      }
      else if (change.file === progress) {
        mkdirSync(dirname(progress), { recursive: true })
        writeFileSync(progress, '', { flag: 'wx', mode: 0o600 })
      } else if (remove || retired.includes(change.file)) unlinkSync(change.file)
      else atomic(change.file, files[change.file] ?? '')
    }
    if (remove) {
      if (handover) atomic(handover.file, handover.text)
      if (readLocal(manifestFile) !== null) unlinkSync(manifestFile)
    } else {
      atomic(manifestFile, nextManifest)
      for (const other of localAgents.filter(one => one !== agent)) {
        const siblingFile = join(root, `install-${other}.json`)
        const siblingText = initial(siblingFile)
        if (siblingText === null) continue
        const sibling = object(JSON.parse(siblingText))
        if (sibling.files === undefined) continue
        const siblingFiles = { ...object(sibling.files) } as Record<string, string>
        let updatedSibling = false
        for (const sharedFile of [script, worker, skill]) {
          const nextText = files[sharedFile]
          if (Object.hasOwn(siblingFiles, sharedFile) && nextText !== undefined && changes.some(change => change.file === sharedFile) && siblingFiles[sharedFile] !== hash(nextText)) {
            siblingFiles[sharedFile] = hash(nextText)
            updatedSibling = true
          }
        }
        if (updatedSibling) atomic(siblingFile, `${JSON.stringify({ ...sibling, files: siblingFiles }, null, 2)}\n`)
      }
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

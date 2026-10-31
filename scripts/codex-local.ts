import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { boardConfirmedReport, codexEvent, codexEvents, codexReport, dropCodexBlock, folderProject, putCodexBlock, sessionTitle } from '../hooks/codex'
import type { CodexReport } from '../hooks/codex'
import { agentHooks, BOARD_FOR, readConfig } from '../hooks/connect-pure'
import type { Strings } from '../hooks/i18n'
import { STRINGS } from '../hooks/strings'
import { parseProgress, progressTail, RESUME, STALE_MS } from '../hooks/parse'
import { othersNote } from '../hooks/others'
import { cleanSignal, codexSignal, isStrongRun, pickParent, withSignal } from '../hooks/runs'
import type { RunSignal } from '../hooks/runs'
import { antigravityCommand, antigravityHooks, cursorEvent, cursorEvents, hookCommandArgs, lifecycleCapability, localAgents, opencodePlugin, statusEvents, windowsHookCommand } from '../hooks/local-agents'
import type { LocalAgent } from '../hooks/local-agents'
import { deepseekLocalPlugin, deepseekPatch, openclawLocalPlugin } from '../hooks/portable-agents'
import { HOOK_SESSION_ENV, HOOK_VERSION, hookWorker, hostHookTimeout } from '../hooks/hook-safety'
import { trustCodex } from './codex-host'
import { withLocalLock } from './local-lock'
import { installControlRoot, withInstallLock } from './install-control'
import { boardPromptHelper, boardRequestWords, boardRun, isBoardRequest } from '../hooks/board-commands'
import { PROMPT_EVENTS } from '../hooks/inbox'
import { windowsHookNode } from './windows-hook-node'
import { claimHookRecovery } from './hook-recovery-owner'
import { findSessionFile, readSessionMeta } from './codex-history'

type Json = Record<string, unknown>
type Manifest = { files: Record<string, string>; groups: Record<string, unknown> }

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
// Folder names are display labels; reports bind to the whole directory without retaining its path.
const cwdDigest = (cwd: unknown): string | undefined => {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
  const normalized = resolve(cwd)
  return hash(process.platform === 'win32' ? normalized.toLowerCase() : normalized)
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
  const url = /^\s*url\s*=\s*(.+?)\s*$/m.exec(remote)?.[1] ?? ''

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
    if (common !== undefined) names.add(basename(dirname(commonDir)))
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

  return othersNote(parseProgress(text), hereNames(raw.cwd), hash(`codex:${session}`).slice(0, 8), now, s, s.othersTailCodex)
}
const withoutBom = (text: string): string => text.startsWith('\uFEFF') ? text.slice(1) : text
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_JSON_OBJECT')
  return value as Json
}
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
  'INVALID_SESSION', 'INVALID_EVENT', 'INVALID_STATE', 'INVALID_EVENT_STATE', 'SESSION_CONFLICT',
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

export const codexTrustOutput = (result: { changes: number; applied: boolean }, s: Strings, isJson: boolean): string => {
  if (isJson) return `${JSON.stringify(result, null, 2)}\n`
  const line = result.changes === 0 ? s.codexTrustNone : result.applied ? s.codexTrustApplied(result.changes) : s.codexTrustPreview(result.changes)
  return `${line}\n`
}

// What a person reads when a setup mode fails (#465): one sentence with its next step, never the code name, a stack or a path.
export const setupFailure = (error: unknown, agent: string, s: Strings): { code: string; message: string } => {
  const detail = error as { code?: unknown; message?: unknown; record?: unknown } | null | undefined
  const isCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
  const code = isCode(detail?.code) ? detail.code : isCode(detail?.message) ? detail.message : error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'UNKNOWN'
  const unknown = s.setupAgentUnknown.toLowerCase()
  const host = localAgents.includes(agent as LocalAgent) ? s.agentNames[agent] ?? unknown : unknown
  const record = typeof detail?.record === 'string' && /^install-[a-z]+\.json$/.test(detail.record) ? detail.record : 'install-*.json'
  const message = code === 'MISSING_ARGUMENT' ? s.setupErrorMissingValue
    : code === 'INVALID_INSTALL_RECORD' ? s.setupErrorRecord(record)
    : code === 'INSTALL_CONFLICT' ? s.setupErrorConflict(host)
    : code === 'UNSAFE_COMMAND_PATH' ? s.setupErrorUnsafePath
    : ['INVALID_JSON_OBJECT', 'INVALID_HOOK_GROUP', 'INVALID_PLUGIN_CONFIG'].includes(code) ? s.setupErrorConfig(host)
    : code === 'SHARED_BOARD_PATH_CONFLICT' ? s.setupErrorBoardPath
    : ['INSTALL_CHANGED', 'LOCK_BUSY', 'LOCK_OWNERSHIP_LOST'].includes(code) ? s.setupErrorBusy
    : ['CODEX_BINARY_REQUIRED', 'ABSOLUTE_CODEX_BINARY_REQUIRED'].includes(code) ? s.setupErrorCodexBinary
    : code === 'OWNED_CODEX_INSTALL_REQUIRED' ? s.setupErrorCodexInstall
    : s.setupErrorOther(host)
  return { code, message }
}

const reporterTail = (original: Buffer): { bytes: Buffer; fragment: Buffer | null } => {
  // Latin-1 keeps offsets in bytes, even when the last UTF-8 character was interrupted.
  const tail = progressTail(original.toString('latin1'))
  if (tail === null) return { bytes: original, fragment: null }
  const fragment = original.subarray(tail.offset)
  const lines = fragment.toString('latin1').split('\n')
  if (/\S/.test(lines.slice(1).join('\n'))) return { bytes: original, fragment: null }
  const eol = original.includes(Buffer.from('\r\n')) ? '\r\n' : '\n'
  const replacement = Buffer.from(tail.close === null ? '' : `<!-- /auto session=${tail.close} -->${eol}`, 'latin1')
  const bytes = Buffer.concat([original.subarray(0, tail.offset), replacement])
  if (progressTail(bytes.toString('latin1')) !== null) throw new Error('INCOMPLETE_PROGRESS_TAIL')
  return { bytes, fragment }
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
// sends one for that (#217); the others keep their agent's heading.
const filesByFolder = (mode: string, agent: string): boolean => mode === '--codex-event' || mode === '--agent-status' && agent === 'opencode'

export const runCodexLocal = async (args: string[], boardPath: string, s: Strings): Promise<boolean> => {
  const mode = ['--recover-hooks', '--codex-setup', '--codex-doctor', '--codex-remove', '--codex-trust', '--codex-report', '--codex-event', '--agent-status'].find(one => args.includes(one))
  if (!mode) return false
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT')
    return value
  }
  const baked = (globalThis as { AGENT_BOARD?: { codexRoot?: string } }).AGENT_BOARD
  const agent = (flag('--agent') ?? 'codex') as LocalAgent
  if (!localAgents.includes(agent)) throw new Error('UNSUPPORTED_AGENT')
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
      return record
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof Error && error.message === 'INVALID_JSON_OBJECT') throw Object.assign(new Error('INVALID_INSTALL_RECORD'), { record: basename(file) })
      throw error
    }
  }
  const manifestFile = join(root, `install-${agent}.json`)
  const loaded = jsonInitial(manifestFile)
  const otherManifests = localAgents.filter(one => one !== agent).map(one => jsonInitial(join(root, `install-${one}.json`)))
  const storedProgress = loaded.progress ?? otherManifests.find(one => typeof one.progress === 'string')?.progress
  const progress = localProgressPath(flag('--progress-file'), mode === '--codex-setup' ? join(root, 'progress.md') : boardPath, storedProgress)
  if (mode === '--codex-setup' && otherManifests.some(one => typeof one.progress === 'string' && resolve(one.progress) !== progress)) throw new Error('SHARED_BOARD_PATH_CONFLICT')
  const configs: Partial<Record<LocalAgent, string>> = {
    codex: resolve(flag('--codex-dir') ?? (process.env.CODEX_HOME || join(home, '.codex')), 'hooks.json'),
    cursor: join(home, '.cursor', 'hooks.json'),
    gemini: join(home, '.gemini', 'settings.json'),
    grok: join(flag('--grok-dir') ?? (process.env.GROK_HOME || join(home, '.grok')), 'hooks', 'agent-board-local.json'),
    muse: join(home, '.config', 'muse', 'settings.json'),
    antigravity: join(home, '.gemini', 'config', 'hooks.json'),
  }
  const config = configs[agent] ?? ''
  const script = join(root, 'agent-board.mjs')
  const opencodeDir = resolve(flag('--opencode-dir') ?? (process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')))
  const openclawDir = resolve(flag('--openclaw-dir') ?? (process.env.OPENCLAW_STATE_DIR || join(home, '.openclaw')))
  const deepseekDir = resolve(flag('--deepseek-dir') ?? (process.env.DSH_HOME || join(home, '.dsh')))
  const skill = join(home, '.agents', 'skills', 'agent-board', 'SKILL.md')
  const manifest: Manifest = { files: object(loaded.files ?? {}) as Record<string, string>, groups: object(loaded.groups ?? {}) }
  const output = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }

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
    const raw: Json = isRecovery ? {} : await input()
    checkDeadline()
    type Pending = {
      version: number; progress: string; mode: string; agent: LocalAgent; session: string; now: string; at?: number
      status: unknown; event?: string; folder?: string; folderDigest?: string; isBoardPrompt: boolean; isPrompt: boolean; payload: Json
      // Who started the session, as far as the host's own words say (#399); absent when they say nothing.
      run?: RunSignal
    }
    const reportSession = (): string | undefined => {
      const digest = cwdDigest(process.cwd())
      if (digest === undefined || !existsSync(join(root, 'sessions'))) return undefined
      const candidates: string[] = []
      for (const file of readdirSync(join(root, 'sessions'))) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
        try {
          const record = object(JSON.parse(readLocal(join(root, 'sessions', file)) ?? '{}'))
          const updated = Date.parse(String(record.updated))
          if (record.agent === 'codex' && record.folderDigest === digest && record.origin !== 'run' && (record.state === 'working' || record.state === 'waiting') && updated <= started && started - updated <= STALE_MS && typeof record.session === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/.test(record.session)) candidates.push(record.session)
        } catch {}
        if (candidates.length > 1) return undefined
      }
      return candidates.length === 1 ? candidates[0] : undefined
    }
    const buildEntry = (mode: string, agent: LocalAgent, raw: Json, flag: (name: string) => string | undefined, env: NodeJS.ProcessEnv, progress: string, at: number): Pending => {
      const payload = agent === 'cursor' && mode === '--codex-event' ? cursorEvent(raw) : raw
      // Read before Cursor's adapter drops workspace_roots; a queued raw event keeps cwd and workspace_roots for this (#246).
      const folder = filesByFolder(mode, agent) ? folderProject(raw.cwd || (agent === 'cursor' && Array.isArray(raw.workspace_roots) && raw.workspace_roots.every(root => typeof root === 'string') ? raw.workspace_roots[0] : undefined)) : ''
      // Only metadata selected below is retained. Save no prompts, tool inputs,
      // last_assistant_message, or permission decisions from a hook payload. transcript_path is
      // opened, when it is this session's own history file, for its first record at a session's
      // start or prompt, which says whether a person started it (#399), and for nothing else.
      const session = mode !== '--codex-report'
        ? agent === 'antigravity'
          ? (typeof payload.conversationId === 'string' ? payload.conversationId : payload.session_id ?? payload.sessionId ?? payload.sessionID)
          : payload.session_id ?? payload.sessionId ?? payload.sessionID ?? (agent === 'grok' ? env.GROK_SESSION_ID : undefined)
        : flag('--session') ?? (typeof payload.session === 'string' ? payload.session : typeof payload.conversationId === 'string' ? payload.conversationId : typeof payload.sessionId === 'string' ? payload.sessionId : (agent === 'codex' ? env.CODEX_THREAD_ID ?? reportSession() : env.AGENT_BOARD_AGENT === agent ? env.AGENT_BOARD_SESSION_ID : undefined))
      if (session === undefined && mode === '--codex-report' && agent === 'codex') throw new Error('UNBOUND_REPORT')
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
      const explicitOrigin = raw.origin === 'run' || payload.origin === 'run' || raw.is_run === true || raw.isRun === true || payload.is_run === true || payload.isRun === true ? 'run' : raw.origin === 'person' || payload.origin === 'person' ? 'person' : undefined
      const explicitParent = typeof raw.parent === 'string' && RESUME.test(raw.parent) ? raw.parent : typeof payload.parent === 'string' && RESUME.test(payload.parent) ? payload.parent : undefined
      const explicitSignal: RunSignal | undefined = explicitOrigin !== undefined ? { origin: explicitOrigin, ...(explicitParent !== undefined ? { parent: explicitParent } : {}) } : undefined
      const opens = agent === 'codex' && mode === '--codex-event' && /^(?:SessionStart|UserPromptSubmit)$/.test(String(payload.hook_event_name))
      const path = payload.transcript_path
      const run = opens ? codexSignal(Object.hasOwn(payload, 'transcript_path'), path, typeof path === 'string' && path !== '' ? readSessionMeta(path, session) : null) : explicitSignal
      // A queued event keeps metadata only: the host's own fields stay out, as they do above.
      return {
        version: 1, progress, mode, agent, session, now, at, status: mode === '--agent-status' ? status : undefined, event, isBoardPrompt, isPrompt,
        ...(filesByFolder(mode, agent) ? { folder } : {}),
        ...(agent === 'codex' && mode === '--codex-event' ? { folderDigest: cwdDigest(raw.cwd) } : {}),
        ...(run === undefined ? {} : { run }),
        payload: mode === '--codex-report' ? payload : mode === '--codex-event' ? {
          session_id: payload.session_id, hook_event_name: payload.hook_event_name,
          turn_id: payload.turn_id, prompt_submitted: payload.prompt_submitted,
        } : {},
      }
    }
    const current = isRecovery ? undefined : buildEntry(mode, agent, raw, flag, process.env, progress, started)
    const isInferredReport = mode === '--codex-report' && agent === 'codex' && flag('--session') === undefined && process.env.CODEX_THREAD_ID === undefined
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
    const apply = ({ mode, agent, session, now, at, status, event, folder = '', folderDigest, isBoardPrompt, payload, run }: Pending): CodexReport => {
      const owner = hash(`${agent}:${session}`)
      const recordFile = join(root, 'sessions', `${owner}.json`)
      const saved = readLocal(recordFile)
      const original = saved === null ? null : JSON.parse(saved) as CodexReport & { appliedAt?: number }
      if (original?.agent && original.agent !== agent) throw new Error('SESSION_CONFLICT')
      // Direct events can arrive out of order too, before they ever enter the pending queue.
      if (mode !== '--codex-report' && original !== null && (at ?? Date.parse(now)) < (original.appliedAt ?? Date.parse(original.updated))) {
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
      const isRun = isStrongRun(origin) && agent === 'codex'
      const bytes = isRun ? Buffer.alloc(0) : readBytes(progress) ?? Buffer.alloc(0)
      const text = bytes.toString('utf8')
      const previous = original === null || mode === '--codex-report' || isRun ? original : boardConfirmedReport(text, original, owner)
      const clock = previous === null ? now : new Date(Math.max(Date.parse(now), Date.parse(previous.updated))).toISOString()
      const base = mode === '--codex-event' ? codexEvent(previous, isBoardPrompt ? { ...payload, prompt_submitted: false } : payload, clock, s) : codexReport(previous, session, mode === '--agent-status' ? {
        title: previous?.title ?? s.localAgentTask(agent), project: previous?.project ?? agent,
        state: isBoardPrompt && previous ? previous.state : status === 'working' ? 'working' : previous?.state === 'done' ? 'done' : status,
        steps: previous?.steps ?? [`- [ ] ${s.localAgentLifecycle}`],
      } : payload, clock, s)
      // A queued folder is cleaned again: the queue file is not trusted to hold a clean name.
      const name = folderProject(folder)
      const initial = filesByFolder(mode, agent) && !previous ? codexReport(base, session, {
        ...base, title: sessionTitle(name, s.localAgentTask(agent)), project: name || agent,
      }, clock, s) : base
      const priorActivity = previous?.activity ?? []
      // Only a weak hint needs a parent; a strong run keeps its record without a block.
      const parent = origin.origin !== 'run' ? undefined : isRun ? origin.parent : origin.parent ?? pickParent(parseProgress(text), initial.project, Date.parse(clock), [owner.slice(0, 8), session]) ?? undefined
      const marked = { ...(origin.origin === undefined ? {} : { origin: origin.origin }), ...(parent === undefined ? {} : { parent }), ...(origin.isWeak === true ? { isWeak: true as const } : {}) }
      const { origin: _origin, parent: _parent, isWeak: _isWeak, ...lifecycle } = initial
      const directory = agent === 'codex' && mode === '--codex-event' && name !== ''
        ? { folder: name, folderDigest }
        : { folder: original?.folder, folderDigest: original?.folderDigest }
      const report = { ...lifecycle, ...marked, ...directory, appliedAt: Math.max(at ?? Date.parse(now), original?.appliedAt ?? Date.parse(original?.updated ?? now)), ...(isBoardPrompt && previous ? { state: previous.state, steps: previous.steps } : {}), agent, ...(event === undefined ? {} : { activity: [...priorActivity, { event, state: String(status), updated: clock }].slice(-16) }) }
      if (isRun) {
        // A lazy history file can prove that a block written from a hint is a run.
        // Once the record is strong, later reports still never read the board.
        if (original !== null && !isStrongRun(original)) withdrawRunBlock(owner)
        atomic(recordFile, `${JSON.stringify(report, null, 2)}\n`, checkDeadline, true)
        return report
      }
      // A replay can skip writes only after a board completion reached the cache too.
      const repaired = reporterTail(bytes)
      if (repaired.fragment === null && mode !== '--codex-report' && previous === original && original !== null && previous !== null && previous.state === report.state && previous.turn === report.turn && JSON.stringify(previous.steps) === JSON.stringify(report.steps) && previous.origin === report.origin && previous.parent === report.parent && previous.isWeak === report.isWeak && previous.folder === report.folder && previous.folderDigest === report.folderDigest && (event === undefined || priorActivity.at(-1)?.event === event)) {
        if (report.appliedAt > (original.appliedAt ?? Date.parse(original.updated))) atomic(recordFile, `${JSON.stringify({ ...original, appliedAt: report.appliedAt }, null, 2)}\n`, checkDeadline, true)
        return report
      }
      // Encode only the new report; existing bytes, including partial UTF-8, pass through unchanged.
      const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('latin1')
      const next = Buffer.from(putCodexBlock(repaired.bytes.toString('latin1'), {
        ...report, title: encoded(report.title), project: encoded(report.project), steps: report.steps.map(encoded),
      }, owner, mode === '--codex-report' && previous !== null && previous.project !== report.project), 'latin1')
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
              const entry = name.endsWith('.raw.json') ? rawEntry(stored) : stored as Pending
              if (entry.version === 1 && typeof entry.progress === 'string' && isHookEntry(entry)) {
                if (entry.progress !== progress) continue
                const signal = cleanSignal(entry.run)
                if (!isOverdue(entry) || signal !== undefined && isStrongRun(signal)) apply(entry)
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
    if (mode === '--codex-report') output({ session, block: hash(`${agent}:${session}`).slice(0, 8), state: report!.state, updated: report!.updated, progress })
    else if (agent === 'cursor') output(raw.hook_event_name === 'sessionStart' ? { env: { AGENT_BOARD_SESSION_ID: session, AGENT_BOARD_AGENT: agent } } : {})
    else if (agent === 'antigravity') {
      // The host supplies the binding; the agent supplies semantic summaries. A first
      // invocation also covers resumed conversations that have no SessionStart event.
      const isStart = current.event === 'SessionStart'
      const isFirst = current.event === 'PreInvocation' && raw.invocationNum === 0
      // Legacy connect runs a bundle beside its chosen progress file, outside root.
      const context = isStart || isFirst ? s.localAgentAntigravityContext(boardRun(process.argv[1] ?? script, [
        '--codex-report', '--agent', 'antigravity', '--session', session,
        '--progress-file', progress, '--home', home, '--data-dir', root,
      ])) : ''
      output(isStart ? { injectSteps: [{ systemMessage: { systemMessage: context } }] } : isFirst ? { injectSteps: [{ ephemeralMessage: context }] } : {})
    } else if (agent === 'gemini') output({})
    else if (agent === 'codex' && mode === '--codex-event') {
      const note = codexStartNote(raw, current.run, session, progress, s)
      // Codex adds `additionalContext` to the conversation as developer context.
      if (note !== null) output({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } })
    }
    return true
  }

  const hasHooks = agent === 'codex' || agent === 'cursor' || statusEvents[agent] !== undefined
  const ownEvents = !hasHooks || agent === 'antigravity' ? [] : agent === 'cursor' ? Object.keys(cursorEvents) : agent === 'codex' ? codexEvents : Object.keys(statusEvents[agent] ?? {})
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
  const read = hasHooks || agent === 'openclaw' ? readConfig(configText) : {}
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
  const nextHooks: Json = { ...hooks }
  const groups: Json = {}
  // Codex runs its hooks through PowerShell on Windows (#623).
  const isPowerShellHost = agent === 'codex' && process.platform === 'win32'
  const hostNode = isPowerShellHost ? windowsHookNode(process.execPath) : undefined
  for (const event of ownEvents) {
    const state = statusEvents[agent]?.[event]
    const eventCommand = isPowerShellHost ? windowsHookCommand(hookArgs(event, state), quote, hostNode) : hookArgs(event, state).map(quote).join(' ')
    const group = agent === 'cursor' ? { command: eventCommand, timeout: hostHookTimeout(agent, event) } : { hooks: [{ type: 'command', command: eventCommand, timeout: hostHookTimeout(agent, event) }] }
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error('INVALID_HOOK_GROUP')
    const entries = (hooks[event] ?? []) as unknown[]
    const old = manifest.groups[event]
    const kept = old === undefined ? entries : entries.filter(entry => !isSame(entry, old))
    if (isReadable && old !== undefined && !entries.some(entry => isSame(entry, old))) conflicts.push(`${config}:${event}`)
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
    if (isReadable && owned !== undefined && existing === undefined) conflicts.push(`${config}:${name}`)
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
    if (isReadable && (plugins.enabled === false || existing !== undefined && !isSame(existing, owned ?? desired) || owned !== undefined && (!isSame(existing, owned) || !paths.includes(pluginFile) || allow?.length && !allow.includes(id)))) conflicts.push(`${nativeConfig}:${id}`)
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
    const patch = deepseekPatch(initial(nativeConfig) ?? '', manifest.groups.patch, pathToFileURL(join(root, 'adapters', 'deepseek.mjs')).href, remove)
    if (patch.conflict) conflicts.push(nativeConfig)
    nextConfigText = patch.text
    if (patch.group) groups.patch = patch.group
  }
  const skillText = `---\nname: agent-board\ndescription: ${JSON.stringify(s.localAgentSkillDescription)}\n---\n\n${s.localAgentSkill(`${quote(process.execPath)} ${quote(script)}`)}\n\n${s.localAgentHandoff}\n\n${s.codexTrust}\n\nCodex: ${configs.codex}\n${codexEvents.join(', ')}\n`
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
    [script]: `globalThis.AGENT_BOARD = ${JSON.stringify({ hookVersion: HOOK_VERSION, path: progress, codexRoot: root, lang: Object.entries(STRINGS).find(([, words]) => words === s)?.[0] ?? 'en' })}\n${original}`,
    [worker]: hookWorker(home, script, boardPromptHelper(boardRequestWords(Object.values(STRINGS)))),
    [skill]: skillText,
  }
  if (agent === 'opencode') files[join(opencodeDir, 'plugins', 'agent-board-local.js')] = opencodePlugin(process.execPath, worker, progress, s.localAgentSkillDescription, home, s.localAgentStepFormat)
  if (agent === 'openclaw') {
    files[join(root, 'adapters', 'openclaw', 'agent-board-local.mjs')] = openclawLocalPlugin(process.execPath, worker, progress, home)
    files[join(root, 'adapters', 'openclaw', 'openclaw.plugin.json')] = `${JSON.stringify({ id: 'agent-board-local', configSchema: { type: 'object', additionalProperties: false, properties: {} } }, null, 2)}\n`
    files[join(openclawDir, 'skills', 'agent-board', 'SKILL.md')] = skillText
  }
  if (agent === 'deepseek') {
    files[join(root, 'adapters', 'deepseek.mjs')] = deepseekLocalPlugin(process.execPath, worker, progress, home)
    files[join(deepseekDir, 'skills', 'agent-board', 'SKILL.md')] = skillText
  }
  if (agent === 'hermes') files[join(flag('--hermes-dir') ?? (process.env.HERMES_HOME || join(home, '.hermes')), 'skills', 'agent-board', 'SKILL.md')] = skillText
  if (agent === 'antigravity') files[antigravitySkill] = skillText
  if (agent === 'gemini') files[join(home, '.gemini', 'commands', 'board.toml')] = `description = ${JSON.stringify(s.boardCommandDescription)}\nprompt = '''${s.boardCommandPrompt}\n\n!{${quote(process.execPath)} ${quote(script)} --serve}\n'''\n`
  if (agent === 'opencode') files[join(opencodeDir, 'commands', 'board.md')] = `---\ndescription: ${JSON.stringify(s.boardCommandDescription)}\n---\n\n${s.boardCommandPrompt}\n\n!\`${quote(process.execPath)} ${quote(script)} --serve\`\n`
  for (const [file, desired] of Object.entries(files)) {
    const existing = initial(file)
    const shared = file === script || file === worker || file === skill
    if (remove && shared && otherManifests.some(one => one.files !== undefined)) continue
    const owned = existing !== null && (hash(existing) === manifest.files[file] || (!remove && (otherManifests.some(one => object(one.files ?? {})[file] === hash(existing)) || (file === skill || file === antigravitySkill) && legacySkills.includes(existing))))
    if (existing !== null && !owned && existing !== desired) conflicts.push(file)
    else if (remove ? owned : existing !== desired) changes.push({ file, action: remove ? 'remove' : existing === null ? 'create' : 'update' })
  }
  // A host-directory override must not strand an old active plugin outside the
  // new ownership record. Remove the old scoped install before changing roots.
  for (const file of Object.keys(manifest.files)) if (!(file in files)) conflicts.push(file)
  const hasNativeConfig = hasHooks || agent === 'openclaw' || agent === 'deepseek'
  nextConfigText ??= `${JSON.stringify(nextConfig, null, 2)}\n`
  if (hasNativeConfig && (!remove || Object.keys(manifest.groups).length)) {
    if (parsedConfig === null) conflicts.push(nativeConfig)
    else if (agent === 'deepseek' ? initial(nativeConfig) !== nextConfigText : !isSame(hookConfig, nextConfig)) changes.push({ file: nativeConfig, action: 'update' })
  }
  if (!remove && readLocal(progress) === null) { before.set(progress, null); changes.push({ file: progress, action: 'create' }) }
  const nextManifest = `${JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, hash(text)])), groups, progress }, null, 2)}\n`
  if (remove ? initial(manifestFile) !== null : initial(manifestFile) !== nextManifest) changes.push({ file: manifestFile, action: remove ? 'remove' : initial(manifestFile) === null ? 'create' : 'update' })
  const plan = {
    mode: remove ? 'remove' : 'install', agent, progress, data: root, changes, conflicts,
    notice: agent === 'codex' ? s.codexTrust : s.localHostReview, privacy: s.codexPrivacy,
    capabilities: { ui: 'web-and-tui', progress: 'explicit-reports', lifecycle: lifecycleCapability(agent), turnBinding: agent === 'codex' || agent === 'cursor' || agent === 'openclaw' ? 'host-event-id' : 'unavailable-in-status-events', liveReply: false },
  }
  if (mode === '--codex-trust') {
    if (agent !== 'codex' || conflicts.length || changes.length || readLocal(manifestFile) === null) throw new Error('OWNED_CODEX_INSTALL_REQUIRED')
    const executable = flag('--codex-bin')
    if (!executable) throw new Error('CODEX_BINARY_REQUIRED')
    const result = await trustCodex(executable, config, manifest.groups, args.includes('--apply'))
    process.stdout.write(codexTrustOutput(result, s, args.includes('--json')))
    return true
  }
  if (mode === '--codex-doctor') {
    const installed = conflicts.length === 0 && changes.length === 0 && readLocal(manifestFile) !== null
    const host = installed && agent === 'codex' && flag('--codex-bin') ? await trustCodex(flag('--codex-bin')!, config, manifest.groups, false) : null
    // /progress connect may have hooked the host instead, or left only its skill (#285).
    const connected = agentHooks({
      home, sep: process.platform === 'win32' ? '\\' : '/', isWindows: process.platform === 'win32', script: '', inbox: '',
      codexHome: dirname(configs.codex!), grokHome: dirname(dirname(configs.grok!)), hermesHome: flag('--hermes-dir') ?? (process.env.HERMES_HOME || join(home, '.hermes')),
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
    output({ ...plan, installed, ready: installed && lifecycleCapability(agent) !== 'adapter-pending', connected: 'unverified', hooksTrusted: host ? host.hooks.every(hook => hook.trust === 'trusted') : 'unknown', reportHook, ...(isSkillOnly ? { problem: s.setupAgent(s.agentNames[agent] ?? agent, [s.setupSkillOnly]) } : {}), notice: s.codexDoctor })
    return true
  }
  if (!args.includes('--apply')) { output(plan); return true }
  if (conflicts.length) { output(plan); throw new Error('INSTALL_CONFLICT') }
  withInstallLock(home, () => {
    // Compare the bytes used to build the plan, not a fresh snapshot taken after
    // planning: another installer or host may have changed them in that interval.
    for (const [file, expected] of before) if (readLocal(file) !== expected) throw new Error('INSTALL_CHANGED')
    // Setup is deliberately explicit. It changes neither hook trust nor config.toml.
    for (const change of changes) {
      if (change.file === manifestFile) continue
      if (change.file === nativeConfig) atomic(nativeConfig, nextConfigText!)
      else if (change.file === progress) {
        mkdirSync(dirname(progress), { recursive: true })
        writeFileSync(progress, '', { flag: 'wx', mode: 0o600 })
      } else if (remove) unlinkSync(change.file)
      else atomic(change.file, files[change.file] ?? '')
    }
    if (remove) {
      if (readLocal(manifestFile) !== null) unlinkSync(manifestFile)
    } else atomic(manifestFile, nextManifest)
  })
  output({ ...plan, applied: true })
  return true
}

const isPromptEvent = (payload: Json): boolean => PROMPT_EVENTS.test(String(payload.hook_event_name ?? payload.hookEventName))

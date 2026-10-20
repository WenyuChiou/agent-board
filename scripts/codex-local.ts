import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { answerLocalQuestions, boardConfirmedReport, codexEvent, codexEvents, codexReport, putCodexBlock } from '../hooks/codex'
import type { CodexReport } from '../hooks/codex'
import { readConfig } from '../hooks/connect-pure'
import type { Strings } from '../hooks/i18n'
import { STRINGS } from '../hooks/strings'
import { progressTail } from '../hooks/parse'
import { antigravityHooks, cursorEvent, cursorEvents, lifecycleCapability, localAgents, opencodePlugin, statusEvents } from '../hooks/local-agents'
import type { LocalAgent } from '../hooks/local-agents'
import { deepseekLocalPlugin, deepseekPatch, openclawLocalPlugin } from '../hooks/portable-agents'
import { trustCodex } from './codex-host'
import { withLocalLock } from './local-lock'
import { withInstallLock } from './install-control'
import { boardRequestWords, isBoardRequest } from '../hooks/board-commands'
import { PROMPT_EVENTS } from '../hooks/inbox'

type Json = Record<string, unknown>
type Manifest = { files: Record<string, string>; groups: Record<string, unknown> }

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const readBytes = (file: string): Buffer | null => {
  try { return readFileSync(file) } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  }
}
const readLocal = (file: string): string | null => readBytes(file)?.toString('utf8') ?? null
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_JSON_OBJECT')
  return value as Json
}
const atomic = (file: string, text: string | Buffer): void => {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  let isOpen = true
  try {
    writeFileSync(fd, text)
    closeSync(fd)
    isOpen = false
    renameSync(temporary, file)
  } finally {
    if (isOpen) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
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

export const runCodexLocal = async (args: string[], boardPath: string, s: Strings): Promise<boolean> => {
  const mode = ['--codex-setup', '--codex-doctor', '--codex-remove', '--codex-trust', '--codex-report', '--codex-event', '--agent-status'].find(one => args.includes(one))
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
  const jsonInitial = (file: string): Json => object(JSON.parse(initial(file) ?? '{}'))
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

  if (mode === '--codex-event' || mode === '--codex-report' || mode === '--agent-status') {
    const raw = await input()
    const payload = agent === 'cursor' && mode === '--codex-event' ? cursorEvent(raw) : raw
    // Only metadata selected below is retained. Never open transcript_path or save prompts,
    // tool inputs, last_assistant_message, or permission decisions from a hook payload.
    const session = mode !== '--codex-report' ? agent === 'antigravity' ? payload.conversationId : payload.session_id ?? payload.sessionId ?? payload.sessionID ?? (agent === 'grok' ? process.env.GROK_SESSION_ID : undefined) : flag('--session') ?? (agent === 'codex' ? process.env.CODEX_THREAD_ID : process.env.AGENT_BOARD_AGENT === agent ? process.env.AGENT_BOARD_SESSION_ID : undefined)
    if (typeof session !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/.test(session)) throw new Error('INVALID_SESSION')
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    if (mode === '--agent-status' && (agent === 'codex' || agent === 'cursor')) throw new Error('INVALID_EVENT')
    const status = flag('--state') ?? payload.state
    if (mode === '--agent-status' && !['working', 'waiting', 'ended'].includes(String(status))) throw new Error('INVALID_STATE')
    const event = agent === 'antigravity' && mode === '--agent-status' ? flag('--event') : undefined
    if (event !== undefined && statusEvents.antigravity?.[event] !== status) throw new Error('INVALID_EVENT_STATE')
    // Classify before Cursor's adapter drops prompt text; retain lifecycle
    // ordering without treating a board lookup as an answer to the question.
    const isBoardPrompt = (isPromptEvent(raw) || raw.prompt_submitted === true) && (raw.board_request === true || isBoardRequest(raw, boardRequestWords(Object.values(STRINGS))))
    const isPrompt = !isBoardPrompt && mode === '--agent-status' && status === 'working' && (payload.prompt_submitted === true || /^(?:UserPromptSubmit|user_prompt_submit|BeforeAgent)$/.test(String(payload.hook_event_name ?? payload.hookEventName)))
    type Pending = {
      version: number; progress: string; mode: string; agent: LocalAgent; session: string; now: string
      status: unknown; event?: string; isBoardPrompt: boolean; isPrompt: boolean; payload: Json
    }
    // A queued event keeps metadata only: the host's own fields stay out, as they do above.
    const current: Pending = {
      version: 1, progress, mode, agent, session, now, status: mode === '--agent-status' ? status : undefined, event, isBoardPrompt, isPrompt,
      payload: mode === '--codex-report' ? payload : mode === '--codex-event' ? {
        session_id: payload.session_id, hook_event_name: payload.hook_event_name,
        turn_id: payload.turn_id, prompt_submitted: payload.prompt_submitted,
      } : {},
    }
    // A program holding progress.md open makes Windows refuse its read (EBUSY) and the rename
    // onto it (EPERM). Any other EPERM or EACCES is a real refusal and fails as before.
    const isBusy = (error: unknown): boolean => {
      const failure = error as { code?: string; syscall?: string; dest?: string } | null
      const isLockedRename = process.platform === 'win32' && failure?.code === 'EPERM' && failure.syscall === 'rename' && typeof failure.dest === 'string' && resolve(failure.dest) === progress
      return failure?.code === 'EBUSY' || failure?.code === 'EAGAIN' || isLockedRename || error instanceof Error && error.message === 'LOCK_BUSY'
    }
    const apply = ({ mode, agent, session, now, status, event, isBoardPrompt, isPrompt, payload }: Pending): CodexReport => {
      const owner = hash(`${agent}:${session}`)
      const recordFile = join(root, 'sessions', `${owner}.json`)
      const saved = readLocal(recordFile)
      const original = saved === null ? null : JSON.parse(saved) as CodexReport
      if (original?.agent && original.agent !== agent) throw new Error('SESSION_CONFLICT')
      const bytes = readBytes(progress) ?? Buffer.alloc(0)
      const text = bytes.toString('utf8')
      const previous = original === null || mode === '--codex-report' ? original : boardConfirmedReport(text, original, owner)
      const clock = previous === null ? now : new Date(Math.max(Date.parse(now), Date.parse(previous.updated))).toISOString()
      const base = mode === '--codex-event' ? codexEvent(previous, isBoardPrompt ? { ...payload, prompt_submitted: false } : payload, clock, s) : codexReport(previous, session, mode === '--agent-status' ? {
        title: previous?.title ?? s.localAgentTask(agent), project: previous?.project ?? agent,
        state: isBoardPrompt && previous ? previous.state : status === 'working' ? 'working' : previous?.state === 'done' ? 'done' : status,
        steps: isPrompt && previous ? answerLocalQuestions(previous.steps) : previous?.steps ?? [`- [ ] ${s.localAgentLifecycle}`],
      } : payload, clock, s)
      const priorActivity = previous?.activity ?? []
      const report = { ...base, ...(isBoardPrompt && previous ? { state: previous.state, steps: previous.steps } : {}), agent, ...(mode === '--codex-event' && !previous ? { title: s.localAgentTask(agent), project: agent } : {}), ...(event === undefined ? {} : { activity: [...priorActivity, { event, state: String(status), updated: clock }].slice(-16) }) }
      // A replay can skip writes only after a board completion reached the cache too.
      const repaired = reporterTail(bytes)
      if (repaired.fragment === null && mode !== '--codex-report' && previous === original && previous !== null && previous.state === report.state && previous.turn === report.turn && JSON.stringify(previous.steps) === JSON.stringify(report.steps) && (event === undefined || priorActivity.at(-1)?.event === event)) return report
      // Encode only the new report; existing bytes, including partial UTF-8, pass through unchanged.
      const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('latin1')
      const next = Buffer.from(putCodexBlock(repaired.bytes.toString('latin1'), {
        ...report, title: encoded(report.title), project: encoded(report.project), steps: report.steps.map(encoded),
      }, owner), 'latin1')
      const aside = repaired.fragment === null ? null : saveReporterTail(progress, repaired.fragment)
      try { atomic(progress, next) } catch (error) {
        if (aside !== null) {
          try { unlinkSync(aside) } catch {}
        }
        throw error
      }
      atomic(recordFile, `${JSON.stringify(report, null, 2)}\n`)
      return report
    }
    const pending = join(root, 'pending')
    const pendingFiles = (): string[] => existsSync(pending) ? readdirSync(pending).filter(name => name.endsWith('.json')).sort() : []
    // A queued entry passes the same checks a live event passes above before it is applied.
    const isHookEntry = (entry: Pending): boolean =>
      (entry.mode === '--codex-event' || entry.mode === '--agent-status' && entry.agent !== 'codex' && entry.agent !== 'cursor' && ['working', 'waiting', 'ended'].includes(String(entry.status)))
      && localAgents.includes(entry.agent) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/.test(String(entry.session))
      && typeof entry.now === 'string' && typeof entry.isPrompt === 'boolean' && typeof entry.isBoardPrompt === 'boolean'
      && (entry.event === undefined || entry.agent === 'antigravity' && entry.mode === '--agent-status' && statusEvents.antigravity?.[entry.event] === entry.status)
      // A live event's own session_id is either missing or the session it is filed under.
      && (entry.mode !== '--codex-event' || [undefined, entry.session].includes(object(entry.payload).session_id as string | undefined))
    // A status event has no turn to order it by: one that lands behind a newer event of its
    // session would move that session back, so it is dropped instead. `now` keeps whole seconds,
    // so an older event from the same second as the session's last report is not caught and applies.
    const isOverdue = (entry: Pending): boolean => {
      if (entry.mode !== '--agent-status') return false
      const saved = readLocal(join(root, 'sessions', `${hash(`${entry.agent}:${entry.session}`)}.json`))
      return saved !== null && Date.parse(entry.now) < Date.parse(String(object(JSON.parse(saved)).updated))
    }
    const deadline = performance.now() + 1800
    let delay = 50
    let report: CodexReport | undefined
    for (;;) {
      try {
        report = withLocalLock(`${progress}.agent-board-lock`, () => {
          // Queued events go first, oldest first, so every session's events land in the order
          // they happened. One that can never apply is dropped rather than block the rest.
          for (const name of pendingFiles()) {
            const file = join(pending, name)
            try {
              const entry = object(JSON.parse(readFileSync(file, 'utf8'))) as Pending
              if (entry.version === 1 && typeof entry.progress === 'string' && isHookEntry(entry)) {
                if (entry.progress !== progress) continue
                if (!isOverdue(entry)) apply(entry)
              }
            } catch (error) {
              if (isBusy(error)) throw error
            }
            // Two boards sharing one data folder can both drop the same entry.
            try { unlinkSync(file) } catch (error) {
              if ((error as { code?: string }).code !== 'ENOENT') throw error
            }
          }
          return apply(current)
        }, { waitMs: Math.max(0, deadline - performance.now()) })
        break
      } catch (error) {
        if (!isBusy(error)) throw error
        const left = deadline - performance.now()
        if (left <= 0) {
          if (mode === '--codex-report') throw error
          mkdirSync(pending, { recursive: true })
          if (pendingFiles().length >= 64) throw error
          atomic(join(pending, `${String(Date.now()).padStart(15, '0')}-${randomUUID()}.json`), `${JSON.stringify(current)}\n`)
          break
        }
        await new Promise(done => setTimeout(done, Math.min(delay, left)))
        delay = Math.min(delay * 2, 400)
      }
    }
    if (mode === '--codex-report') output({ session, block: hash(`${agent}:${session}`).slice(0, 8), state: report!.state, updated: report!.updated, progress })
    else if (agent === 'cursor') output(raw.hook_event_name === 'sessionStart' ? { env: { AGENT_BOARD_SESSION_ID: session, AGENT_BOARD_AGENT: agent } } : {})
    else if (agent === 'gemini' || agent === 'antigravity') output({})
    return true
  }

  const hasHooks = agent === 'codex' || agent === 'cursor' || statusEvents[agent] !== undefined
  const nativeConfig = agent === 'openclaw' ? join(openclawDir, 'openclaw.json') : agent === 'deepseek' ? join(deepseekDir, 'cordis.patch.yml') : config
  const parsedConfig = hasHooks || agent === 'openclaw' ? readConfig(initial(nativeConfig) ?? '') : {}
  const hookConfig = parsedConfig ?? {}
  // A config that cannot be read is one conflict of its own; its groups are not also reported as edited.
  const isReadable = parsedConfig !== null
  const hooks = object(hookConfig.hooks ?? {})
  const command = `${quote(process.execPath)} ${quote(script)} --codex-event --agent ${agent} --progress-file ${quote(progress)}`
  const isSame = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  const remove = mode === '--codex-remove'
  const conflicts: string[] = []
  const changes: { file: string; action: string }[] = []
  const nextHooks: Json = { ...hooks }
  const groups: Json = {}
  for (const event of !hasHooks || agent === 'antigravity' ? [] : agent === 'cursor' ? Object.keys(cursorEvents) : agent === 'codex' ? codexEvents : Object.keys(statusEvents[agent] ?? {})) {
    const state = statusEvents[agent]?.[event]
    const eventCommand = state === undefined ? command : `${quote(process.execPath)} ${quote(script)} --agent-status --agent ${agent} --state ${state} --progress-file ${quote(progress)}`
    const group = agent === 'cursor' ? { command: eventCommand } : { hooks: [{ type: 'command', command: eventCommand, timeout: agent === 'gemini' ? 3000 : 3 }] }
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
    const desired = antigravityHooks((event, state) => {
      const argv = [process.execPath, script, '--agent-status', '--agent', 'antigravity', '--state', state, '--event', event, '--progress-file', progress]
      if (process.platform !== 'win32') return argv.map(quote).join(' ')
      // Antigravity's Windows executor passes one quoted argument to cmd /c using
      // CreateProcess escaping. Embedded executable quotes become literal \" bytes.
      // Keep that command free of inner quotes; PowerShell forwards stdin to Node.
      const launch = `& ${argv.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}; exit $LASTEXITCODE`
      return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(launch, 'utf16le').toString('base64')}`
    })
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
  const legacySkills = Object.values(STRINGS).map(words => `---\nname: agent-board\ndescription: ${JSON.stringify(words.boardCommandDescription)}\n---\n\n${words.boardSkillPrompt(`node "${join(home, '.claude', 'agent-board.mjs')}"`)}\n`)
  const original = readFileSync(process.argv[1] ?? '', 'utf8').replace(/^globalThis\.AGENT_BOARD[^\n]*\n/, '')
  const files: Record<string, string> = {
    [script]: `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, codexRoot: root, lang: Object.entries(STRINGS).find(([, words]) => words === s)?.[0] ?? 'en' })}\n${original}`,
    [skill]: skillText,
  }
  if (agent === 'opencode') files[join(opencodeDir, 'plugins', 'agent-board-local.js')] = opencodePlugin(process.execPath, script, progress, s.localAgentSkillDescription)
  if (agent === 'openclaw') {
    files[join(root, 'adapters', 'openclaw', 'agent-board-local.mjs')] = openclawLocalPlugin(process.execPath, script, progress)
    files[join(root, 'adapters', 'openclaw', 'openclaw.plugin.json')] = `${JSON.stringify({ id: 'agent-board-local', configSchema: { type: 'object', additionalProperties: false, properties: {} } }, null, 2)}\n`
    files[join(openclawDir, 'skills', 'agent-board', 'SKILL.md')] = skillText
  }
  if (agent === 'deepseek') {
    files[join(root, 'adapters', 'deepseek.mjs')] = deepseekLocalPlugin(process.execPath, script, progress)
    files[join(deepseekDir, 'skills', 'agent-board', 'SKILL.md')] = skillText
  }
  if (agent === 'hermes') files[join(flag('--hermes-dir') ?? (process.env.HERMES_HOME || join(home, '.hermes')), 'skills', 'agent-board', 'SKILL.md')] = skillText
  if (agent === 'antigravity') files[join(home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')] = skillText
  if (agent === 'gemini') files[join(home, '.gemini', 'commands', 'board.toml')] = `description = ${JSON.stringify(s.boardCommandDescription)}\nprompt = '''${s.boardCommandPrompt}\n\n!{${quote(process.execPath)} ${quote(script)} --serve}\n'''\n`
  if (agent === 'opencode') files[join(opencodeDir, 'commands', 'board.md')] = `---\ndescription: ${JSON.stringify(s.boardCommandDescription)}\n---\n\n${s.boardCommandPrompt}\n\n!\`${quote(process.execPath)} ${quote(script)} --serve\`\n`
  for (const [file, desired] of Object.entries(files)) {
    const existing = initial(file)
    const shared = file === script || file === skill
    if (remove && shared && otherManifests.some(one => one.files !== undefined)) continue
    const owned = existing !== null && (hash(existing) === manifest.files[file] || (!remove && (otherManifests.some(one => object(one.files ?? {})[file] === hash(existing)) || file === skill && legacySkills.includes(existing))))
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
    output(await trustCodex(executable, config, manifest.groups, args.includes('--apply')))
    return true
  }
  if (mode === '--codex-doctor') {
    const installed = conflicts.length === 0 && changes.length === 0 && readLocal(manifestFile) !== null
    const host = installed && agent === 'codex' && flag('--codex-bin') ? await trustCodex(flag('--codex-bin')!, config, manifest.groups, false) : null
    output({ ...plan, installed, ready: installed && lifecycleCapability(agent) !== 'adapter-pending', connected: 'unverified', hooksTrusted: host ? host.hooks.every(hook => hook.trust === 'trusted') : 'unknown', notice: s.codexDoctor })
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

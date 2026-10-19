import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { codexEvent, codexEvents, codexReport, putCodexBlock } from '../hooks/codex'
import type { CodexReport } from '../hooks/codex'
import type { Strings } from '../hooks/i18n'
import { STRINGS } from '../hooks/strings'
import { cursorEvent, cursorEvents, lifecycleCapability, localAgents, opencodePlugin, statusEvents } from '../hooks/local-agents'
import type { LocalAgent } from '../hooks/local-agents'
import { trustCodex } from './codex-host'

type Json = Record<string, unknown>
type Manifest = { files: Record<string, string>; groups: Record<string, unknown> }

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const readLocal = (file: string): string | null => {
  try { return readFileSync(file, 'utf8') } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  }
}
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_JSON_OBJECT')
  return value as Json
}
const json = (file: string): Json => object(JSON.parse(readLocal(file) ?? '{}'))
const atomic = (file: string, text: string): void => {
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
const locked = <T>(file: string, action: () => T): T => {
  mkdirSync(dirname(file), { recursive: true })
  const started = Date.now()
  let fd: number
  for (;;) {
    try { fd = openSync(file, 'wx', 0o600); break } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST' || Date.now() - started > 2000) throw error
      // Different agents share a board. Wait briefly for its writer, but never remove
      // a lock whose owning process we cannot verify.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  try { return action() } finally { closeSync(fd); unlinkSync(file) }
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
  const manifestFile = join(root, `install-${agent}.json`)
  const loaded = json(manifestFile)
  const otherManifests = localAgents.filter(one => one !== agent).map(one => json(join(root, `install-${one}.json`)))
  const storedProgress = loaded.progress ?? otherManifests.find(one => typeof one.progress === 'string')?.progress
  const progress = resolve(flag('--progress-file') ?? (process.env.CLAUDE_PROGRESS_FILE || (typeof storedProgress === 'string' ? storedProgress : mode === '--codex-setup' ? join(root, 'progress.md') : boardPath)))
  if (mode === '--codex-setup' && otherManifests.some(one => typeof one.progress === 'string' && resolve(one.progress) !== progress)) throw new Error('SHARED_BOARD_PATH_CONFLICT')
  const configs: Partial<Record<LocalAgent, string>> = {
    codex: resolve(flag('--codex-dir') ?? (process.env.CODEX_HOME || join(home, '.codex')), 'hooks.json'),
    cursor: join(home, '.cursor', 'hooks.json'),
    gemini: join(home, '.gemini', 'settings.json'),
    grok: join(flag('--grok-dir') ?? (process.env.GROK_HOME || join(home, '.grok')), 'hooks', 'agent-board-local.json'),
    muse: join(home, '.config', 'muse', 'settings.json'),
  }
  const config = configs[agent] ?? ''
  const script = join(root, 'agent-board.mjs')
  const skill = join(home, '.agents', 'skills', 'agent-board', 'SKILL.md')
  const manifest: Manifest = { files: object(loaded.files ?? {}) as Record<string, string>, groups: object(loaded.groups ?? {}) }
  const output = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }

  if (mode === '--codex-event' || mode === '--codex-report' || mode === '--agent-status') {
    const raw = await input()
    const payload = agent === 'cursor' && mode === '--codex-event' ? cursorEvent(raw) : raw
    // Only metadata selected below is retained. Never open transcript_path or save prompts,
    // tool inputs, last_assistant_message, or permission decisions from a hook payload.
    const session = mode !== '--codex-report' ? payload.session_id ?? payload.sessionId ?? payload.sessionID ?? (agent === 'grok' ? process.env.GROK_SESSION_ID : undefined) : flag('--session') ?? (agent === 'codex' ? process.env.CODEX_THREAD_ID : process.env.AGENT_BOARD_AGENT === agent ? process.env.AGENT_BOARD_SESSION_ID : undefined)
    if (typeof session !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/.test(session)) throw new Error('INVALID_SESSION')
    const owner = hash(`${agent}:${session}`)
    const recordFile = join(root, 'sessions', `${owner}.json`)
    const saved = readLocal(recordFile)
    const previous = saved === null ? null : JSON.parse(saved) as CodexReport
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    if (previous?.agent && previous.agent !== agent) throw new Error('SESSION_CONFLICT')
    if (mode === '--agent-status' && (agent === 'codex' || agent === 'cursor')) throw new Error('INVALID_EVENT')
    const status = flag('--state') ?? payload.state
    if (mode === '--agent-status' && !['working', 'waiting', 'ended'].includes(String(status))) throw new Error('INVALID_STATE')
    const base = mode === '--codex-event' ? codexEvent(previous, payload, now, s) : codexReport(previous, session, mode === '--agent-status' ? {
      title: previous?.title ?? s.localAgentTask(agent), project: previous?.project ?? agent,
      state: status === 'working' ? 'working' : previous?.state === 'done' ? 'done' : status,
      steps: previous?.steps ?? [`- [>] ${s.codexLifecycle}`],
    } : payload, now, s)
    const report = { ...base, agent, ...(mode === '--codex-event' && !previous ? { title: s.localAgentTask(agent), project: agent } : {}) }
    if (mode !== '--codex-report' && previous) {
      // Replayed hooks do not refresh the time or regress an explicit task report.
      const same = previous.state === report.state && previous.turn === report.turn
      if (same) {
        if (agent === 'cursor') output(raw.hook_event_name === 'sessionStart' ? { env: { AGENT_BOARD_SESSION_ID: session, AGENT_BOARD_AGENT: agent } } : {})
        else if (agent === 'gemini') output({})
        return true
      }
    }
    locked(`${progress}.agent-board-lock`, () => {
      // Read both records again under the common board lock: separate sessions cannot
      // clobber each other's blocks and two processes for one session cannot race.
      if (readLocal(recordFile) !== saved) throw new Error('CONCURRENT_REPORT')
      const text = readLocal(progress) ?? ''
      const next = putCodexBlock(text, report, owner)
      atomic(progress, next)
      atomic(recordFile, `${JSON.stringify(report, null, 2)}\n`)
    })
    if (mode === '--codex-report') output({ session, block: owner.slice(0, 8), state: report.state, updated: report.updated, progress })
    else if (agent === 'cursor') output(raw.hook_event_name === 'sessionStart' ? { env: { AGENT_BOARD_SESSION_ID: session, AGENT_BOARD_AGENT: agent } } : {})
    else if (agent === 'gemini') output({})
    return true
  }

  const hasHooks = agent === 'codex' || agent === 'cursor' || statusEvents[agent] !== undefined
  const hookConfig = hasHooks ? json(config) : {}
  const hooks = object(hookConfig.hooks ?? {})
  const command = `${quote(process.execPath)} ${quote(script)} --codex-event --agent ${agent} --progress-file ${quote(progress)}`
  const isSame = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  const remove = mode === '--codex-remove'
  const conflicts: string[] = []
  const changes: { file: string; action: string }[] = []
  const nextHooks: Json = { ...hooks }
  const groups: Json = {}
  for (const event of !hasHooks ? [] : agent === 'cursor' ? Object.keys(cursorEvents) : agent === 'codex' ? codexEvents : Object.keys(statusEvents[agent] ?? {})) {
    const state = statusEvents[agent]?.[event]
    const eventCommand = state === undefined ? command : `${quote(process.execPath)} ${quote(script)} --agent-status --agent ${agent} --state ${state} --progress-file ${quote(progress)}`
    const group = agent === 'cursor' ? { command: eventCommand } : { hooks: [{ type: 'command', command: eventCommand, timeout: agent === 'gemini' ? 3000 : 3 }] }
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error('INVALID_HOOK_GROUP')
    const entries = (hooks[event] ?? []) as unknown[]
    const old = manifest.groups[event]
    const kept = old === undefined ? entries : entries.filter(entry => !isSame(entry, old))
    if (old !== undefined && !entries.some(entry => isSame(entry, old))) conflicts.push(`${config}:${event}`)
    if (!remove) {
      // Exact generated bytes can be adopted after a partially interrupted install.
      nextHooks[event] = [...kept.filter(entry => !isSame(entry, group)), group]
      groups[event] = group
    } else if (kept.length) nextHooks[event] = kept
    else delete nextHooks[event]
  }
  const nextConfig = { ...(agent === 'cursor' ? { version: 1 } : agent === 'muse' ? { schema_version: 1 } : {}), ...hookConfig, hooks: nextHooks }
  const skillText = `---\nname: agent-board\ndescription: ${JSON.stringify(s.localAgentSkillDescription)}\n---\n\n${s.localAgentSkill(`${quote(process.execPath)} ${quote(script)}`)}\n\n${s.localAgentHandoff}\n\n${s.codexTrust}\n\nCodex: ${configs.codex}\n${codexEvents.join(', ')}\n`
  const legacySkills = Object.values(STRINGS).map(words => `---\nname: agent-board\ndescription: ${JSON.stringify(words.boardCommandDescription)}\n---\n\n${words.boardSkillPrompt(`node "${join(home, '.claude', 'agent-board.mjs')}"`)}\n`)
  const original = readFileSync(process.argv[1] ?? '', 'utf8').replace(/^globalThis\.AGENT_BOARD[^\n]*\n/, '')
  const files: Record<string, string> = {
    [script]: `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, codexRoot: root, lang: Object.entries(STRINGS).find(([, words]) => words === s)?.[0] ?? 'en' })}\n${original}`,
    [skill]: skillText,
  }
  if (agent === 'opencode') files[join(home, '.config', 'opencode', 'plugins', 'agent-board-local.js')] = opencodePlugin(process.execPath, script, progress, s.localAgentSkillDescription)
  if (agent === 'hermes') files[join(flag('--hermes-dir') ?? (process.env.HERMES_HOME || join(home, '.hermes')), 'skills', 'agent-board', 'SKILL.md')] = skillText
  if (agent === 'antigravity') files[join(home, '.gemini', 'config', 'skills', 'agent-board', 'SKILL.md')] = skillText
  if (agent === 'gemini') files[join(home, '.gemini', 'commands', 'board.toml')] = `description = ${JSON.stringify(s.boardCommandDescription)}\nprompt = '''${s.boardCommandPrompt}\n\n!{${quote(process.execPath)} ${quote(script)} --serve}\n'''\n`
  if (agent === 'opencode') files[join(home, '.config', 'opencode', 'commands', 'board.md')] = `---\ndescription: ${JSON.stringify(s.boardCommandDescription)}\n---\n\n${s.boardCommandPrompt}\n\n!\`${quote(process.execPath)} ${quote(script)} --serve\`\n`
  for (const [file, desired] of Object.entries(files)) {
    const existing = readLocal(file)
    const shared = file === script || file === skill
    if (remove && shared && otherManifests.some(one => one.files !== undefined)) continue
    const owned = existing !== null && (hash(existing) === manifest.files[file] || (!remove && (otherManifests.some(one => object(one.files ?? {})[file] === hash(existing)) || file === skill && legacySkills.includes(existing))))
    if (existing !== null && !owned && existing !== desired) conflicts.push(file)
    else if (remove ? owned : existing !== desired) changes.push({ file, action: remove ? 'remove' : existing === null ? 'create' : 'update' })
  }
  if (hasHooks && (!remove || Object.keys(manifest.groups).length) && !isSame(hookConfig, nextConfig)) changes.push({ file: config, action: 'update' })
  if (!remove && readLocal(progress) === null) changes.push({ file: progress, action: 'create' })
  const nextManifest = `${JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, hash(text)])), groups, progress }, null, 2)}\n`
  if (remove ? readLocal(manifestFile) !== null : readLocal(manifestFile) !== nextManifest) changes.push({ file: manifestFile, action: remove ? 'remove' : readLocal(manifestFile) === null ? 'create' : 'update' })
  const plan = {
    mode: remove ? 'remove' : 'install', agent, progress, data: root, changes, conflicts,
    notice: s.codexTrust, privacy: s.codexPrivacy,
    capabilities: { ui: 'web-and-tui', progress: 'explicit-reports', lifecycle: lifecycleCapability(agent), turnBinding: agent === 'codex' || agent === 'cursor' ? 'host-event-id' : 'unavailable-in-status-events', liveReply: false },
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
  const before = new Map([...changes.map(change => change.file), manifestFile].map(file => [file, readLocal(file)]))
  locked(join(root, 'install.lock'), () => {
    for (const [file, expected] of before) if (readLocal(file) !== expected) throw new Error('INSTALL_CHANGED')
    // Setup is deliberately explicit. It changes neither hook trust nor config.toml.
    for (const change of changes) {
      if (change.file === manifestFile) continue
      if (change.file === config) atomic(config, `${JSON.stringify(nextConfig, null, 2)}\n`)
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

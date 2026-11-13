// Shared background-resume helper (#1402): runs an AI CLI's own resume command on an
// existing conversation in the background, reads its reply and ACK line from stdout, and
// records the receipt within the owner's limits (loopback only, default permission mode
// only, never mid-turn, and only with a live receiver record before sending).
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import type { Strings } from '../hooks/i18n'
import { ZH_TW } from '../hooks/i18n'
import { ACK_MAX, address, deliveryText } from '../hooks/messaging'
import type { Message, ReceiverRoutes, Route, RouteKind, RowState } from '../hooks/messaging'
import { RECEIVER_ROUTES } from '../hooks/receiver-routes'
import type { SendPlan } from '../hooks/serve'
import { agentLabel } from '../hooks/strings'

export const MAX_RESUME_WAIT = 10 * 60 * 1000
// After a turn that took too long is killed, how long to wait for it to exit.
export const KILL_RESUME_WAIT = 15 * 1000

const isWindows = process.platform === 'win32'

export type Program = { command: string; args: string[]; isShell: boolean }

// Permission-widening, auto-approval, sandbox-bypass, and mode-override flags that violate
// the owner limit requiring the AI's own default permission mode.
const DISALLOWED_PERMISSION_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--bypass-permissions',
  '--bypass',
  '--yolo',
  '--full-auto',
  '--auto-approve',
  '--approve-all',
  '--allow-all',
  '--skip-permissions',
  '--no-confirm',
  '--no-approval',
  '--trust',
  '--trust-all',
  '--permission-mode',
  '--approval-mode',
  '--ask-for-approval',
  '--sandbox',
  '--yes',
  '-y',
])

const isDisallowedOption = (token: string): boolean => {
  const eq = token.indexOf('=')
  const name = (eq === -1 ? token : token.slice(0, eq)).toLowerCase()
  return DISALLOWED_PERMISSION_FLAGS.has(name) || name.startsWith('--dangerously-') || name.startsWith('--bypass-')
}

/**
 * Returns the first disallowed permission-override flag in `args`, or null when every
 * option leaves the CLI in its default permission mode.
 */
export const disallowedPermissionFlag = (args: readonly string[]): string | null => {
  for (const arg of args) {
    if (arg === '--') break
    if (arg.startsWith('-') && isDisallowedOption(arg)) return arg
  }
  return null
}

/**
 * Checks that a URL points strictly to loopback (`127.0.0.1`, `localhost`, or `[::1]`)
 * over plain local HTTP with a port and no userinfo.
 */
export const isLoopbackUrl = (addressUrl: string): boolean => {
  try {
    const parsed = new URL(addressUrl)
    const host = parsed.hostname.toLowerCase()
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
    return parsed.protocol === 'http:' && isLoopback && Boolean(parsed.port) && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// A program by its full path, from PATH's absolute folders only. Windows looks in the current
// folder first, and a reply runs in the session's folder, which can be a cloned repository
// with an untrusted shim of its own.
export const onPath = (name: string, exts: readonly string[]): string | null => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue
    for (const ext of exts) {
      const file = join(dir, `${name}${ext}`)
      if (isFile(file)) return file
    }
  }
  return null
}

// AGENT_BOARD_<AGENT> names a program to run in the agent's place (tests' stand-in);
// a .js or .mjs one runs on this Node without a shell.
export const programOf = (plan: { agent: string; command: string; args: readonly string[] }): Program | null => {
  const stand = process.env[`AGENT_BOARD_${plan.agent.toUpperCase()}`]
  if (stand) return /\.m?js$/i.test(stand) ? { command: process.execPath, args: [stand, ...plan.args], isShell: false } : { command: stand, args: [...plan.args], isShell: false }
  if (plan.agent === 'grok') {
    // Grok Build installs itself in ~/.grok/bin, which is not always on PATH.
    const own = join(homedir(), '.grok', 'bin', isWindows ? 'grok.exe' : 'grok')
    const found = existsSync(own) ? own : onPath('grok', isWindows ? ['.exe', '.com'] : [''])
    return found === null ? null : { command: found, args: [...plan.args], isShell: false }
  }
  const found = onPath(plan.command, isWindows ? ['.exe', '.cmd', '.bat', '.com'] : [''])
  if (found === null) return null
  if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args: [...plan.args], isShell: false }
  // A .cmd runs only through cmd.exe; refuse unsafe shell metacharacters or control bytes.
  if (plan.args.some(arg => /[\r\n\0"&|<>^%!;`]/.test(arg))) return null
  const quoted = plan.args.map(arg => /[\s]/.test(arg) ? `"${arg}"` : arg)
  return { command: `"${found}" ${quoted.join(' ')}`, args: [], isShell: true }
}

// The whole process tree: on Windows, killing a shell leaves the child running; elsewhere the
// child leads a detached process group that goes with it.
export const killTree = (child: ChildProcess): void => {
  if (!isWindows && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {}
  }
  if (isWindows && child.pid !== undefined) {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
      return
    } catch {}
  }
  child.kill()
}

export type ProcessResult = {
  started: boolean
  exitCode: number | null
  timedOut: boolean
  spawnErrorCode: string | null
  spawnErrorMessage: string | null
  stdout: string
  stderr: string
}

export const runBackgroundProcess = (
  program: Program,
  options: { cwd?: string | null; stdin?: string | null; maxWaitMs?: number; killWaitMs?: number } = {},
): Promise<ProcessResult> =>
  new Promise(resolve => {
    const maxWaitMs = options.maxWaitMs ?? MAX_RESUME_WAIT
    const killWaitMs = options.killWaitMs ?? KILL_RESUME_WAIT
    let out = ''
    let err = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    let isTimedOut = false
    let isDone = false
    let isStarted = false
    const finish = (partial: Omit<ProcessResult, 'stdout' | 'stderr'>): void => {
      if (isDone) return
      isDone = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ ...partial, stdout: out, stderr: err })
    }
    // The current folder is never searched for a program a shell or script starts by name.
    const spawnOptions = {
      cwd: options.cwd ?? homedir(),
      detached: !isWindows,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
    }
    let child: ChildProcess
    try {
      child = program.isShell ? spawn(program.command, { ...spawnOptions, shell: true }) : spawn(program.command, program.args, spawnOptions)
      isStarted = child.pid !== undefined
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? null
      finish({ started: false, exitCode: null, timedOut: false, spawnErrorCode: code, spawnErrorMessage: error instanceof Error ? error.message : String(error) })
      return
    }
    timer = setTimeout(() => {
      isTimedOut = true
      killTree(child)
      timer = setTimeout(() => finish({ started: isStarted, exitCode: null, timedOut: true, spawnErrorCode: null, spawnErrorMessage: null }), killWaitMs)
    }, maxWaitMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(-8000)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-2000)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ started: false, exitCode: null, timedOut: false, spawnErrorCode: error.code ?? null, spawnErrorMessage: error.message })
    })
    const settle = (code: number | null): void => {
      if (isTimedOut) {
        finish({ started: isStarted, exitCode: code, timedOut: true, spawnErrorCode: null, spawnErrorMessage: null })
        return
      }
      finish({ started: true, exitCode: code, timedOut: false, spawnErrorCode: null, spawnErrorMessage: null })
    }
    child.on('close', settle)
    // A child started by the agent (e.g. an MCP server) can hold stdio open after the agent exits.
    child.on('exit', code => {
      setTimeout(() => settle(code), 2000)
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.stdin ?? '')
  })

/**
 * Legacy `--allow-resume` runner used by `scripts/board-serve.ts` for ended sessions.
 * Preserves `replies[]` formatting while still enforcing default-permission and folder safety.
 */
export const runSendPlan = async (plan: SendPlan, s: Strings, label: string): Promise<{ ok: boolean; note: string }> => {
  if (disallowedPermissionFlag(plan.args) !== null) return { ok: false, note: s.serveSendFailed(label, s.servePermissionRestricted) }
  const program = programOf(plan)
  if (program === null) return { ok: false, note: s.serveSendFailed(label, s.serveSendMissing(plan.agent)) }
  const result = await runBackgroundProcess(program, { cwd: plan.cwd, stdin: plan.stdin })
  if (!result.started) {
    return {
      ok: false,
      note: s.serveSendFailed(label, result.spawnErrorCode === 'ENOENT' ? s.serveSendMissing(plan.agent) : result.spawnErrorMessage ?? 'SPAWN_FAILED'),
    }
  }
  if (result.timedOut) return { ok: false, note: s.serveSendFailed(label, s.serveSendTimeout) }
  const said = (result.exitCode === 0 ? result.stdout : result.stderr || result.stdout).trim()
  const tail = said.length > 600 ? `…${said.slice(-600)}` : said
  return result.exitCode === 0
    ? { ok: true, note: s.serveSent(label, tail) }
    : { ok: false, note: s.serveSendFailed(label, `${s.serveSendExit(result.exitCode ?? -1)} ${tail}`.trim()) }
}

export type ParsedResumeOutput = {
  ack: string | null
  reply: string
  receiptReply: string | null
}

/**
 * Extracts the exact `ACK <nonce>` line and single-line reply summary from resume CLI stdout.
 * When `ACK <nonce>` is present on its own line, subsequent reply lines form the receipt summary.
 */
export const parseResumeOutput = (stdout: string, nonce: string): ParsedResumeOutput => {
  const prefix = `ACK ${nonce}`
  const lines = stdout.split(/\r?\n/)
  const ackIndex = lines.findIndex(line => line === prefix || line.startsWith(`${prefix} `))
  const inlineReply = ackIndex >= 0 ? lines[ackIndex]!.slice(prefix.length).trim() : ''
  const otherReply = lines
    .filter((_, index) => index !== ackIndex)
    .map(line => line.trim())
    .filter(line => line !== '' && !/^<<<\s*AB-|^AB-[0-9a-zA-Z_-]+\s*>>>$/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const reply = (inlineReply || otherReply).replace(/\s+/g, ' ').trim()
  if (ackIndex < 0) return { ack: null, reply, receiptReply: null }
  const ack = lines[ackIndex]!.length > ACK_MAX ? prefix : lines[ackIndex]!
  const combined = reply === '' ? prefix : `${prefix} ${reply}`.slice(0, ACK_MAX).trimEnd()
  return { ack, reply, receiptReply: combined }
}

const isSafeConversation = (conversation: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(conversation)

export type LiveRecordCheck =
  | { ok: true; route: Route }
  | { ok: false; error: 'NO_RECORDED_ROUTE' }

/**
 * Checks that `routes` includes a live `reopen` record for `agent` in `state` on `surface`.
 */
export const checkLiveResumeRecord = (
  agent: string,
  state: RowState,
  routes: readonly ReceiverRoutes[] = RECEIVER_ROUTES,
  surface?: string,
  kind?: RouteKind,
): LiveRecordCheck => {
  if (state === 'working') return { ok: false, error: 'NO_RECORDED_ROUTE' }
  const normalized = agent === '' ? 'claude' : agent
  const matching = routes.filter(one => one.agent === normalized && (kind === undefined || one.kind === kind))
  for (const entry of matching) {
    const route = entry.routes[state]
    if (route.line !== 'reopen' || typeof route.record !== 'string' || route.record === '') continue
    if (surface === undefined ? route.surfaces.length > 0 : route.surfaces.includes(surface)) return { ok: true, route }
  }
  return { ok: false, error: 'NO_RECORDED_ROUTE' }
}

export type BackgroundResumeError =
  | 'LOOPBACK_ONLY'
  | 'TURN_IN_PROGRESS'
  | 'STATE_UNKNOWN'
  | 'NO_RECORDED_ROUTE'
  | 'PERMISSION_MODE_DISALLOWED'
  | 'INVALID_CONVERSATION'
  | 'FOLDER_GONE'
  | 'COMMAND_MISSING'
  | 'SPAWN_FAILED'
  | 'EXIT_TIMEOUT'
  | 'EXIT_FAILED'
  | 'ACK_REQUIRED'
  | ''

export type BackgroundResumeReceipt = {
  id: string
  nonce: string
  started: boolean
  status: 'acknowledged' | 'uncertain' | 'rejected'
  ack: string | null
  reply: string
  receiptReply: string | null
  error: BackgroundResumeError
}

export type BackgroundResumeTarget = {
  agent: string
  command: string
  resumeFlag: string | readonly string[]
  conversation: string
  cwd: string
  surface?: string
  kind?: RouteKind
  extraArgs?: readonly string[]
  messageArg?: (prompt: string, conversation: string) => { args: readonly string[]; stdin?: string | null }
}

export type BackgroundResumeContext = {
  message: { id: string; text: string; nonce?: string; prompt?: string }
  isLan?: boolean
  boardUrl?: string
  state?: RowState
  isTurnRunning?: boolean
  routes?: readonly ReceiverRoutes[]
  activeTurns?: Set<string>
  recordReceipt?: (receipt: BackgroundResumeReceipt) => void | Promise<void>
  maxWaitMs?: number
  killWaitMs?: number
  s?: Strings
}

export type BackgroundResumeOutcome = BackgroundResumeReceipt & {
  ok: boolean
  note: string
}

const buildResumePrompt = (target: BackgroundResumeTarget, message: BackgroundResumeContext['message'], nonce: string, s: Strings): string => {
  if (typeof message.prompt === 'string' && message.prompt.trim() !== '') return message.prompt
  const model: Message = {
    id: message.id,
    target: 'reopen',
    turn: 'session',
    from: 'board',
    to: address(target.agent, target.conversation),
    text: message.text,
    hash: '',
    origin: 'local',
    status: 'queued',
    updated: Date.now(),
    reply: '',
    error: '',
    hops: 0,
    claimed: 0,
    nonce,
  }
  return deliveryText(model, s)
}

/**
 * Runs `<ai> <resume flag> <conversation> <message>` in the background, reads its reply and
 * `ACK <code>` line from stdout, and records the resulting receipt while enforcing every
 * owner limit (loopback only, default permission mode, never mid-turn, live record required).
 */
export const runBackgroundResume = async (
  target: BackgroundResumeTarget,
  context: BackgroundResumeContext,
): Promise<BackgroundResumeOutcome> => {
  const s = context.s ?? ZH_TW
  const label = agentLabel(target.agent, s)
  const nonce = context.message.nonce && context.message.nonce !== '' ? context.message.nonce : randomBytes(3).toString('hex')
  const finishPreStart = async (error: Exclude<BackgroundResumeError, '' | 'EXIT_TIMEOUT' | 'EXIT_FAILED' | 'ACK_REQUIRED' | 'SPAWN_FAILED'>, note: string): Promise<BackgroundResumeOutcome> => {
    const receipt: BackgroundResumeReceipt = { id: context.message.id, nonce, started: false, status: 'rejected', ack: null, reply: '', receiptReply: null, error }
    await context.recordReceipt?.(receipt)
    return { ...receipt, ok: false, note }
  }

  if (context.isLan === true || context.boardUrl !== undefined && !isLoopbackUrl(context.boardUrl)) {
    return finishPreStart('LOOPBACK_ONLY', s.serveLanSend(label))
  }
  const sessionKey = address(target.agent, target.conversation)
  if (context.isTurnRunning === true || context.state === 'working' || context.activeTurns?.has(sessionKey) === true) {
    return finishPreStart('TURN_IN_PROGRESS', s.serveSendBusy(label))
  }
  if (context.state === undefined) {
    return finishPreStart('STATE_UNKNOWN', s.serveLineStateUnknown)
  }
  const live = checkLiveResumeRecord(target.agent, context.state, context.routes ?? RECEIVER_ROUTES, target.surface, target.kind)
  if (!live.ok) {
    return finishPreStart('NO_RECORDED_ROUTE', s.serveLineUnrecorded)
  }
  if (!isSafeConversation(target.conversation)) {
    return finishPreStart('INVALID_CONVERSATION', s.serveSendFailed(label, 'INVALID_CONVERSATION'))
  }
  const flags = Array.isArray(target.resumeFlag) ? [...target.resumeFlag] : [target.resumeFlag]
  const optionArgs = [target.command, ...flags, ...(target.extraArgs ?? [])]
  if (disallowedPermissionFlag(optionArgs) !== null) {
    return finishPreStart('PERMISSION_MODE_DISALLOWED', s.serveSendFailed(label, s.servePermissionRestricted))
  }
  if (!isFolder(target.cwd)) {
    return finishPreStart('FOLDER_GONE', s.serveSendFailed(label, s.serveFolderGone(basename(target.cwd))))
  }
  const prompt = buildResumePrompt(target, context.message, nonce, s)
  const payload = target.messageArg
    ? target.messageArg(prompt, target.conversation)
    : { args: [...flags, ...(target.extraArgs ?? []), target.conversation, prompt], stdin: null }
  // Inspect option-like tokens added by custom messageArg builders as well (excluding the message body itself).
  if (disallowedPermissionFlag(payload.args.filter(arg => arg !== prompt)) !== null) {
    return finishPreStart('PERMISSION_MODE_DISALLOWED', s.serveSendFailed(label, s.servePermissionRestricted))
  }
  const program = programOf({ agent: target.agent, command: target.command, args: payload.args })
  if (program === null) {
    return finishPreStart('COMMAND_MISSING', s.serveSendFailed(label, s.serveSendMissing(label)))
  }

  context.activeTurns?.add(sessionKey)
  try {
    const result = await runBackgroundProcess(program, {
      cwd: target.cwd,
      stdin: payload.stdin ?? null,
      maxWaitMs: context.maxWaitMs,
      killWaitMs: context.killWaitMs,
    })
    if (!result.started) {
      const error: BackgroundResumeError = result.spawnErrorCode === 'ENOENT' ? 'COMMAND_MISSING' : 'SPAWN_FAILED'
      const receipt: BackgroundResumeReceipt = { id: context.message.id, nonce, started: false, status: 'rejected', ack: null, reply: '', receiptReply: null, error }
      await context.recordReceipt?.(receipt)
      return {
        ...receipt,
        ok: false,
        note: s.serveSendFailed(label, error === 'COMMAND_MISSING' ? s.serveSendMissing(label) : result.spawnErrorMessage ?? error),
      }
    }
    if (result.timedOut) {
      const receipt: BackgroundResumeReceipt = { id: context.message.id, nonce, started: true, status: 'uncertain', ack: null, reply: '', receiptReply: null, error: 'EXIT_TIMEOUT' }
      await context.recordReceipt?.(receipt)
      return { ...receipt, ok: false, note: s.serveSendFailed(label, s.serveSendTimeout) }
    }
    const parsed = parseResumeOutput(result.stdout, nonce)
    if (result.exitCode !== 0) {
      const receipt: BackgroundResumeReceipt = { id: context.message.id, nonce, started: true, status: 'uncertain', ack: parsed.ack, reply: parsed.reply, receiptReply: parsed.receiptReply, error: 'EXIT_FAILED' }
      await context.recordReceipt?.(receipt)
      return { ...receipt, ok: false, note: s.serveSendFailed(label, `${s.serveSendExit(result.exitCode ?? -1)} ${parsed.reply}`.trim()) }
    }
    if (parsed.ack === null || parsed.receiptReply === null) {
      const receipt: BackgroundResumeReceipt = { id: context.message.id, nonce, started: true, status: 'uncertain', ack: null, reply: parsed.reply, receiptReply: null, error: 'ACK_REQUIRED' }
      await context.recordReceipt?.(receipt)
      return { ...receipt, ok: false, note: s.messagesUncertain }
    }
    const receipt: BackgroundResumeReceipt = { id: context.message.id, nonce, started: true, status: 'acknowledged', ack: parsed.ack, reply: parsed.reply, receiptReply: parsed.receiptReply, error: '' }
    await context.recordReceipt?.(receipt)
    const doneLine = s.serveReopenDone(label)
    return { ...receipt, ok: true, note: parsed.reply ? `${doneLine} · ${parsed.reply}` : doneLine }
  } finally {
    context.activeTurns?.delete(sessionKey)
  }
}

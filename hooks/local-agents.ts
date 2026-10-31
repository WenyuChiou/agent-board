import { boardPromptHelper, boardRequestWords } from './board-commands'
import { STRINGS } from './strings'
import { HOOK_VERSION, HOOK_WORKER_GRACE, hookBootstrap, hookGuardSource, hookTimeout, hostHookTimeout } from './hook-safety'

const BOARD_PROMPT_HELPER = boardPromptHelper(boardRequestWords(Object.values(STRINGS)))

// Base64 without Buffer or btoa: /progress connect also builds these commands where neither
// exists (#285).
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const base64 = (bytes: Uint8Array): string => {
  let text = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i]! << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0)
    text += BASE64[n >> 18 & 63]! + BASE64[n >> 12 & 63]! + (i + 1 < bytes.length ? BASE64[n >> 6 & 63]! : '=') + (i + 2 < bytes.length ? BASE64[n & 63]! : '=')
  }
  return text
}
const fromBase64 = (text: string): Uint8Array => {
  const digits = text.replace(/=+$/, '')
  const bytes = new Uint8Array(digits.length * 3 >> 2)
  for (let i = 0, value = 0, bits = 0, at = 0; i < digits.length; i++) {
    const digit = BASE64.indexOf(digits[i]!)
    if (digit < 0) throw new Error('INVALID_BASE64')
    value = (value << 6 | digit) & 0xffff
    bits += 6
    if (bits >= 8) { bits -= 8; bytes[at++] = value >> bits & 255 }
  }
  return bytes
}
// PowerShell's -EncodedCommand is base64 of the command's UTF-16LE bytes.
const utf16le = (text: string): Uint8Array => Uint8Array.from({ length: text.length * 2 }, (_, i) => i % 2 ? text.charCodeAt(i >> 1) >> 8 : text.charCodeAt(i >> 1) & 255)
export const encodedCommandText = (encoded: string): string => {
  const bytes = fromBase64(encoded)
  let text = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode(bytes[i]! | bytes[i + 1]! << 8)
  return text
}

export type LocalAgent = 'codex' | 'cursor' | 'opencode' | 'gemini' | 'grok' | 'muse' | 'hermes' | 'openclaw' | 'antigravity' | 'deepseek' | 'dot' | 'duet' | 'bot'
export const localAgents: LocalAgent[] = ['codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity', 'deepseek', 'dot', 'duet', 'bot']
export const statusEvents: Partial<Record<LocalAgent, Record<string, string>>> = {
  gemini: { SessionStart: 'waiting', BeforeAgent: 'working', AfterAgent: 'waiting', SessionEnd: 'ended' },
  grok: { SessionStart: 'waiting', UserPromptSubmit: 'working', Stop: 'waiting', SessionEnd: 'ended' },
  muse: { UserPromptSubmit: 'working', Stop: 'waiting', SessionEnd: 'ended' },
  antigravity: { SessionStart: 'waiting', PreInvocation: 'working', PostInvocation: 'working', Stop: 'waiting' },
}
export const lifecycleCapability = (agent: LocalAgent): string =>
  agent === 'hermes' ? 'adapter-pending' : ['dot', 'duet', 'bot'].includes(agent) ? 'report-only' : 'adapter-installed-unverified'

// Antigravity groups events under a named definition, rather than hooks.<event>.
// Stop ends an execution loop, not the conversation. No session-end event is invented.
export const antigravityHooks = (command: (event: string, state: string) => string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(statusEvents.antigravity!).map(([event, state]) => [event, [{ type: 'command', command: command(event, state), timeout: hostHookTimeout('antigravity', event) }]]))

// One installed hook: Node runs a bootstrap that fails open and loads the worker, which runs
// the board script within the host's limit (#241). The installer and /progress connect write
// the same commands (#285). Two encoding layers amplify indentation enough to exceed cmd.exe's
// command limit.
export const hookCommandArgs = (node: string, home: string, agent: LocalAgent, worker: string, progress: string, event: string, state?: string): string[] => [
  node, '--input-type=commonjs', '-e',
  `eval(Buffer.from('${base64(new TextEncoder().encode(hookBootstrap(home, agent).split('\n').map(line => line.trim()).join('\n')))}','base64').toString('utf8'))`,
  worker, '--hook-version', String(HOOK_VERSION), '--hook-event', event,
  state === undefined ? '--codex-event' : '--agent-status', '--agent', agent,
  ...(state === undefined ? [] : ['--state', state]),
  ...(agent === 'antigravity' ? ['--event', event] : []), '--progress-file', progress,
]

// Decode data only: ownership checks need the worker path inside the direct Windows command.
export const directHookArgs = (command: string): string[] | null => {
  const encoded = /--input-type=commonjs\s+-e\s+eval\(Buffer\.from\('([A-Za-z0-9+/]+={0,2})','base64'\)\.toString\('utf8'\)\)/.exec(command)?.[1]
  if (!encoded || encoded.length > 32768) return null
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64(encoded))
    const literal = /^process\.argv=JSON\.parse\(("(?:\\[\s\S]|[^"\\])*")\);/.exec(source)?.[1]
    if (!literal) return null
    const args: unknown = JSON.parse(JSON.parse(literal))
    return Array.isArray(args) && args.length <= 256 && args.every(value => typeof value === 'string' && value.length <= 4096) ? args : null
  } catch { return null }
}

// Antigravity's executor adds one quoted cmd argument and cannot preserve embedded executable
// quotes. A verified quote-free Node starts directly; all paths and bootstrap bytes stay encoded.
export const antigravityCommand = (argv: string[], isWindows: boolean, quote: (value: string) => string, windowsNode?: string): string => {
  if (!isWindows) return argv.map(quote).join(' ')
  if (windowsNode !== undefined) {
    if (!/^[A-Za-z]:[\\/][A-Za-z0-9_.~\\/-]+\.exe$/i.test(windowsNode)) throw new Error('UNSAFE_HOOK_EXECUTABLE')
    if (argv[1] !== '--input-type=commonjs' || argv[2] !== '-e' || !argv[3]) throw new Error('INVALID_HOOK_COMMAND')
    const args = JSON.stringify([argv[0], ...argv.slice(4)])
    const source = `process.argv=JSON.parse(${JSON.stringify(args)});process.argv.push('--hook-started',String(Math.floor(require('node:perf_hooks').performance.timeOrigin)));${argv[3]}`
    return `${windowsNode} --input-type=commonjs -e eval(Buffer.from('${base64(new TextEncoder().encode(source))}','base64').toString('utf8'))`
  }
  const launch = `& ${argv.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')} --hook-started ([DateTimeOffset]::new([Diagnostics.Process]::GetCurrentProcess().StartTime).ToUnixTimeMilliseconds()); exit $LASTEXITCODE`
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${base64(utf16le(launch))}`
}

// A host's hook command on Windows, which cmd and PowerShell both run: Codex 0.164 runs hooks
// through PowerShell, which reads a line that starts with a quoted word as a string, so the program
// goes first unquoted (`windowsNode`, a path of safe characters or its verified 8.3 name) and the
// other words stay quoted. A spaced path with no 8.3 name goes inside an encoded PowerShell launch,
// which also runs from cmd but costs a PowerShell start (#533, #623).
export const windowsHookCommand = (argv: string[], quote: (value: string) => string, windowsNode?: string): string => {
  if (windowsNode !== undefined) {
    if (!/^[A-Za-z]:[\\/][A-Za-z0-9_.~\\/-]+\.exe$/i.test(windowsNode)) throw new Error('UNSAFE_HOOK_EXECUTABLE')
    return [windowsNode, ...argv.slice(1).map(quote)].join(' ')
  }
  const launch = `& ${argv.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}; exit $LASTEXITCODE`
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${base64(utf16le(launch))}`
}

export const cursorEvents: Record<string, string> = {
  sessionStart: 'SessionStart', beforeSubmitPrompt: 'UserPromptSubmit',
  stop: 'Stop', afterAgentResponse: 'Stop', sessionEnd: 'SessionEnd',
}

// Cursor supplies a stable conversation id and a generation id for each user message.
export const cursorEvent = (input: Record<string, unknown>): Record<string, unknown> => {
  const event = cursorEvents[String(input.hook_event_name)]
  if (!event) throw new Error('INVALID_EVENT')
  return { session_id: input.conversation_id ?? input.session_id, turn_id: input.generation_id, hook_event_name: event }
}

// OpenCode supplies session status but no stable turn id on those status events. Keep
// that limit explicit instead of manufacturing a turn id or fetching conversation text.
export const opencodePlugin = (node: string, script: string, progress: string, description: string, home: string, stepFormat = STRINGS.en.localAgentStepFormat): string => `import { spawnSync } from 'node:child_process'
import { tool } from '@opencode-ai/plugin'
${hookGuardSource(home, 'opencode')}
${BOARD_PROMPT_HELPER}

const run = (mode, payload, session, deadline) => {
  const args = [${JSON.stringify(script)}, '--hook-version', '${HOOK_VERSION}', mode, '--agent', 'opencode', '--progress-file', ${JSON.stringify(progress)}]
  if (session) args.push('--session', session)
  // The worker always gets the end time, so a retried worker never outlives this call's limit.
  const end = deadline ?? Date.now() + ${hookTimeout('opencode') - 1000}
  args.push('--hook-deadline', String(end))
  if (end - Date.now() <= 0) throw Error('HOOK_TIMEOUT')
  const options = { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: end - Date.now() + ${HOOK_WORKER_GRACE}, killSignal: 'SIGKILL' }
  let result = spawnSync(${JSON.stringify(node)}, args, options)
  // Bun 1.3 in OpenCode ends spawnSync early after an idle event loop (#217).
  if (result.error?.code === 'ETIMEDOUT' && end - Date.now() > 100) result = spawnSync(${JSON.stringify(node)}, args, { ...options, timeout: end - Date.now() + ${HOOK_WORKER_GRACE} })
  if (result.error?.code === 'ETIMEDOUT') throw Error('HOOK_TIMEOUT')
  // A refused report names the board's reason (INVALID_STEP, say), so the model can correct it (#217).
  const reason = result.error ? undefined : /^AGENT_BOARD_REASON ([A-Z][A-Z0-9_]{2,63})$/m.exec(result.stderr ?? '')?.[1]
  if (result.error || result.status !== 0) throw new Error(reason ? 'AGENT_BOARD_REPORT_FAILED: ' + reason : 'AGENT_BOARD_REPORT_FAILED')
  return result.stdout
}

// A one-shot \`opencode run\` exits without session.deleted (#217). As OpenCode exits, the
// top-level sessions reported here and not seen to end are ended, all within one hook limit;
// a board that is too slow gets them queued or logged, and OpenCode's exit never waits longer.
// Each one keeps its folder and whether a reply was still being written at its last report:
// such a session is left as it is, and its row goes stale by age instead. One list and one exit
// listener serve the process, however many times OpenCode loads this plugin.
const OPEN_SESSIONS = Symbol.for('agent-board.opencode-open-sessions')
const isFirstLoad = globalThis[OPEN_SESSIONS] === undefined
const open = globalThis[OPEN_SESSIONS] ??= new Map()
if (isFirstLoad) process.once('exit', () => {
  try {
    const deadline = Date.now() + ${hookTimeout('opencode') - 1000}
    for (const [session, { isReplying, where }] of open) {
      if (isReplying) continue
      try { run('--agent-status', { session_id: session, state: 'ended', ...where }, undefined, deadline) }
      catch (error) { hookError(error?.message === 'HOOK_TIMEOUT' ? 'REPORTER_TIMEOUT' : 'REPORTER_FAILED') }
    }
  } catch {}
})

// The session's folder, else the plugin's own, files a new block under it (#217); only its name is kept.
const folderOf = (info, directory) => {
  const folder = typeof info.directory === 'string' ? info.directory : directory
  return typeof folder === 'string' ? { cwd: folder } : {}
}

export const AgentBoardLocal = async ({ client, directory }) => ({
  'chat.message': async ({ sessionID }, output) => withHook(async (current, deadline) => {
      // A known session notes the new reply at once, as events do before their lookup.
      if (open.has(sessionID)) open.get(sessionID).isReplying = true
      const info = current(await client.session.get({ path: { id: sessionID } }))
      if (info.error) throw Error('HOST_METADATA_FAILED')
      if (!info.data || info.data.id !== sessionID || info.data.parentID) return
      const where = folderOf(info.data, directory)
      // The reply may have ended while the lookup ran: a known session keeps what was noted since.
      const known = open.get(sessionID)
      if (known) known.where = where
      else open.set(sessionID, { isReplying: true, where })
      run('--agent-status', { session_id: sessionID, state: 'working', prompt_submitted: true, ...where, ...(isBoardRequest(output) ? { board_request: true } : {}) }, undefined, deadline)
  }),
  event: async ({ event }) => withHook(async (current, deadline) => {
    const p = event.properties ?? {}
    const session = p.sessionID ?? p.info?.id
    if (!session || !['session.created', 'session.status', 'session.idle', 'session.deleted'].includes(event.type)) return
    if (event.type === 'session.status' && !['busy', 'retry', 'idle'].includes(p.status?.type)) return
    const state = event.type === 'session.deleted' ? 'ended' : event.type === 'session.status' && p.status?.type !== 'idle' ? 'working' : 'waiting'
    // A known session notes a finished reply at once: OpenCode may exit before the lookup returns.
    if (open.has(session) && state !== 'ended') open.get(session).isReplying = state === 'working'
    const info = event.type === 'session.deleted' ? { data: p.info } : current(await client.session.get({ path: { id: session } }))
    if (info.error) throw Error('HOST_METADATA_FAILED')
    if (!info.data || info.data.id !== session || info.data.parentID) return
    const where = folderOf(info.data, directory)
    // A known session keeps the state its latest event noted: an earlier lookup may return last.
    const known = open.get(session)
    if (state === 'ended') open.delete(session)
    else if (known) known.where = where
    else open.set(session, { isReplying: state === 'working', where })
    run('--agent-status', { session_id: session, state, ...where }, undefined, deadline)
  }),
  tool: {
    agent_board_progress: tool({
      description: ${JSON.stringify(description)},
      // The board takes each step as one Markdown task line (#217).
      args: { title: tool.schema.string(), project: tool.schema.string(), state: tool.schema.enum(['working', 'waiting', 'done', 'ended']), steps: tool.schema.array(tool.schema.string().describe(${JSON.stringify(stepFormat)})) },
      execute: async (args, context) => {
        try { return run('--codex-report', args, context.sessionID) }
        catch (error) {
          hookError(error?.message === 'HOOK_TIMEOUT' ? 'REPORTER_TIMEOUT' : 'REPORTER_FAILED')
          throw error
        }
      },
    }),
  },
})
`

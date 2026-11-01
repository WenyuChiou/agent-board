import { hookRecoverySource } from './hook-recovery.ts'

// Milliseconds internally; Gemini stores milliseconds, the other command hosts seconds.
// Keep the existing per-event host floors until the host descriptors own this table.
export const HOOK_VERSION = 1
// Only GROK_SESSION_ID for Grok is read by replayed lifecycle events.
// Other lifecycle identities come from stdin; configuration and credentials stay out.
export const HOOK_SESSION_ENV: Record<string, string[]> = {
  grok: ['GROK_SESSION_ID'],
}
// Let the worker reap its reporter before an SDK caller applies its outer backstop.
export const HOOK_WORKER_GRACE = 500
// A worker that starts after its host's stop line still reads its input this long, then queues it.
export const HOOK_LATE_INPUT_GRACE = 500
export const HOOK_TIMEOUTS: Record<string, { timeout: number; events?: Record<string, number> }> = {
  codex: { timeout: 3000, events: { Stop: 10000 } },
  cursor: { timeout: 3000 },
  gemini: { timeout: 5000 },
  grok: { timeout: 5000, events: { Stop: 10000 } },
  muse: { timeout: 5000, events: { Stop: 10000 } },
  hermes: { timeout: 10000 },
  antigravity: { timeout: 3000 },
  opencode: { timeout: 3000 },
  openclaw: { timeout: 3000 },
  deepseek: { timeout: 3000 },
}
export const hookTimeout = (agent: string, event = ''): number => {
  const policy = HOOK_TIMEOUTS[agent]
  if (!policy) throw new Error('UNSUPPORTED_AGENT')
  return policy.events?.[event] ?? policy.timeout
}
export const hostHookTimeout = (agent: string, event = ''): number => hookTimeout(agent, event) / (agent === 'gemini' ? 1 : 1000)
export const HOOK_INPUT_TIMEOUT = Math.min(...Object.values(HOOK_TIMEOUTS).map(policy => policy.timeout)) - 1000

// A worker can run seconds past its host's stop, so a kill can leave its temporary log file.
// The worker's own log writes remove stale ones; the bootstrap, which rides on a cmd.exe
// command line, stays without this.
const HOOK_LOG_SWEEP = `    try {
      const folder = path.dirname(file), cutoff = Date.now() - 60000
      for (const name of fs.readdirSync(folder)) {
        if (!/^hook-errors\\.log\\.\\d+\\.tmp$/.test(name)) continue
        // Another writer may remove the same file first.
        try {
          const stale = path.join(folder, name), stat = fs.lstatSync(stale)
          if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(stale)
        } catch {}
      }
    } catch {}
`

// Only fixed diagnostic codes reach this file, the board's own refusal code among them, never a
// payload, other stderr text, session id or path.
// Read a bounded tail and replace atomically; a failed log cannot block a host hook.
export const hookLogSource = (home: string, agent: string, sweep = false): string => `const fs = require('node:fs'), path = require('node:path')
const hookError = code => {
  let temporary, owned = false
  try {
    const file = path.join(${JSON.stringify(home)}, '.agent-board', 'hook-errors.log')
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    let previous = ''
    try {
      if (!fs.lstatSync(file).isFile()) throw Error('UNSAFE_LOG')
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
      try {
        if (!fs.fstatSync(fd).isFile()) throw Error('UNSAFE_LOG')
        const size = fs.fstatSync(fd).size, length = Math.min(size, 65536)
        const bytes = Buffer.alloc(length)
        const count = fs.readSync(fd, bytes, 0, length, size - length)
        previous = bytes.subarray(0, count).toString('utf8')
        if (size > length) previous = previous.slice(previous.indexOf('\\n') + 1)
      } finally { fs.closeSync(fd) }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const line = new Date().toISOString() + ' ' + ${JSON.stringify(agent)} + ' ' + code
    const lines = [...previous.trimEnd().split('\\n').filter(Boolean).slice(-199), line]
    temporary = file + '.' + process.pid + '.tmp'
    const output = fs.openSync(temporary, 'wx', 0o600)
    owned = true
    try { fs.writeFileSync(output, lines.join('\\n') + '\\n') }
    finally { fs.closeSync(output) }
    fs.renameSync(temporary, file)
    owned = false
${sweep ? HOOK_LOG_SWEEP : ''}  } catch { process.stderr.write('AGENT_BOARD_HOOK_LOG_FAILED\\n') }
  finally { if (owned) { try { fs.unlinkSync(temporary) } catch {} } }
}
`

// A small bootstrap also fails open when the owned helper is missing or cannot load.
// Keeping the worker in a file avoids an oversized Windows EncodedCommand.
export const hookBootstrap = (home: string, agent: string): string => `${hookLogSource(home, agent)}
import(require('node:url').pathToFileURL(process.argv[1]).href).catch(() => { hookError('HOOK_WORKER_UNAVAILABLE'); ${['cursor', 'gemini', 'antigravity'].includes(agent) ? "process.stdout.write('{}\\n'); " : ''}process.exitCode = 0 })
`

// SDK callbacks also need a bound: a metadata request may never settle. Check the
// guard after each await so a late response cannot write an expired event.
export const hookGuardSource = (home: string, agent: string): string => `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
${hookLogSource(home, agent)}
const withHook = async action => {
  let isActive = true, timer
  const deadline = Date.now() + ${hookTimeout(agent) - 1000}
  const current = value => { if (!isActive || Date.now() >= deadline) throw Error('HOOK_TIMEOUT'); return value }
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('HOOK_TIMEOUT')), ${hookTimeout(agent) - 1000}) })
    const result = await Promise.race([
      Promise.resolve(action(current, deadline)),
      timeout,
    ])
    return current(result)
  } catch (error) { hookError(error?.message === 'HOOK_TIMEOUT' ? 'REPORTER_TIMEOUT' : 'REPORTER_FAILED') }
  finally { isActive = false; clearTimeout(timer) }
}
`

// Late events queue under the board's data folder: the script's own folder unless named (#285).
export const hookWorker = (home: string, script: string, boardPromptHelper: string, dataRoot?: string): string => `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { spawn, spawnSync } = require('node:child_process')
const { randomUUID, createHash } = require('node:crypto')
const { fileURLToPath } = require('node:url')
const { performance } = require('node:perf_hooks')
${boardPromptHelper}
const args = process.argv.slice(2)
const value = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const agent = value('--agent')
const policies = ${JSON.stringify(HOOK_TIMEOUTS)}
const safeAgent = Object.hasOwn(policies, agent) ? agent : 'unknown'
${hookLogSource(home, '__AGENT__', true).replace(JSON.stringify('__AGENT__'), 'safeAgent')}
const isReport = args.includes('--codex-report')
const fail = code => { hookError(code); process.exitCode = isReport ? 1 : 0; if (!isReport && ['cursor', 'gemini', 'antigravity'].includes(agent)) process.stdout.write('{}\\n'); return false }
${hookRecoverySource(home, script, dataRoot)}
const run = async () => {
  const now = Date.now(), supplied = Number(value('--hook-started'))
  const started = Math.floor(Math.min(performance.timeOrigin, Number.isSafeInteger(supplied) && supplied >= 0 && supplied <= now ? supplied : Infinity))
  if (safeAgent === 'unknown') return fail('UNSUPPORTED_AGENT')
  const required = Number(value('--hook-version'))
  if (!Number.isInteger(required) || required < 1 || required > ${HOOK_VERSION}) return fail('REPORTER_UPGRADE_REQUIRED')
  const fd = fs.openSync(${JSON.stringify(script)}, 'r')
  let prefix
  try { const bytes = Buffer.alloc(1024); prefix = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8') }
  finally { fs.closeSync(fd) }
  const installed = Number(/^globalThis\\.AGENT_BOARD = \\{"hookVersion":(\\d+),/.exec(prefix)?.[1] ?? 0)
  if (installed < required) return fail('REPORTER_UPGRADE_REQUIRED')
  const policy = policies[agent]
  const inherited = value('--hook-deadline')
  if (inherited !== undefined && !Number.isSafeInteger(Number(inherited))) return fail('REPORTER_FAILED')
  const hostTimeout = policy.events?.[value('--hook-event')] ?? policy.timeout
  const deadline = Math.min(started + Math.min(3000, hostTimeout - 1000), inherited === undefined ? Infinity : Number(inherited))
  // Input may arrive until 300 ms before the host's limit, whether the worker starts before or
  // after its deadline: one starting just before it must not give up sooner. A worker that starts
  // even later, after a slow Windows PowerShell start (#241), still reads its input for a short
  // grace and queues the event, unless the host stops it first.
  // A report is never queued, so it waits only until its deadline.
  const budget = isReport ? deadline - Date.now() : Math.max(started + hostTimeout - 300 - Date.now(), ${HOOK_LATE_INPUT_GRACE})
  if (budget <= 0) return fail('REPORTER_TIMEOUT')
  let text = '', timer
  process.stdin.setEncoding('utf8')
  try {
    await Promise.race([
      (async () => { for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 1048576) throw Error('INPUT_TOO_LARGE') } })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('INPUT_TIMEOUT')), budget) }),
    ])
  } catch (error) { process.stdin.destroy(); return fail(error.message === 'INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'INPUT_TIMEOUT') }
  finally { clearTimeout(timer) }
  let payload
  try { payload = JSON.parse(text.replace(/^\\uFEFF/, '')); if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error() }
  catch { return fail('INCOMPLETE_INPUT') }
  const internal = ['--hook-version', '--hook-event', '--hook-deadline', '--hook-started', '--home']
  const reporterArgs = args.filter((arg, index) => !internal.includes(arg) && !internal.includes(args[index - 1]))
  // A reporter run that failed passes its own log code as 'failure'; a saved copy is logged after it as REPORTER_QUEUED.
  const queue = failure => {
    let temporary
    try {
      // A late copy is still written: it holds the worker's start time, and replay drops it once a
      // newer event was applied. A host that stops the worker mid-write leaves a .tmp file that is swept.
      if (isReport) return fail('REPORTER_TIMEOUT')
      const pending = path.join(${dataRoot === undefined ? `path.dirname(${JSON.stringify(script)})` : JSON.stringify(dataRoot)}, 'pending')
      fs.mkdirSync(pending, { recursive: true, mode: 0o700 })
      // Concurrent workers can pass 64 by a few because the count and write are separate.
      if (fs.readdirSync(pending).filter(name => name.endsWith('.json')).length >= 64) return fail(failure ?? 'REPORTER_TIMEOUT')
      const env = Object.fromEntries((${JSON.stringify(HOOK_SESSION_ENV)}[agent] ?? []).filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]]))
      // Replay reads only session_id, sessionId, sessionID, conversationId,
      // conversation_id, generation_id, turn_id, hook_event_name, hookEventName,
      // state, prompt_submitted, cwd and the first of workspace_roots (for the
      // session's folder name, #246). Classify the prompt before discarding its text.
      const kept = Object.fromEntries(['session_id', 'sessionId', 'sessionID', 'conversationId', 'conversation_id', 'generation_id', 'turn_id', 'hook_event_name', 'hookEventName', 'state', 'prompt_submitted'].filter(name => typeof payload[name] === 'string' && payload[name].length <= 4096 || name === 'prompt_submitted' && typeof payload[name] === 'boolean').map(name => [name, payload[name]]))
      kept.board_request = payload.board_request === true || isBoardRequest(payload)
      // A bounded folder path: replay must not stall on an oversized one.
      if (typeof payload.cwd === 'string' && payload.cwd.length <= 4096) kept.cwd = payload.cwd
      const roots = payload.workspace_roots
      if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0].length <= 4096) kept.workspace_roots = [roots[0]]
      const file = path.join(pending, String(started).padStart(15, '0') + '-' + randomUUID() + '.raw.json')
      temporary = file + '.tmp'
      // Match normalized entries' UTC text; replay still orders by the precise source milliseconds.
      const now = new Date(started).toISOString().replace(/\\.\\d{3}Z$/, 'Z')
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, kind: 'raw', at: started, now, argv: reporterArgs, env, payload: kept }), { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
      temporary = undefined
      requestRecovery()
      if (failure) hookError(failure)
      return fail('REPORTER_QUEUED')
    } catch { return fail(failure ?? 'REPORTER_FAILED') }
    finally { if (temporary) { try { fs.unlinkSync(temporary) } catch {} } }
  }
  const remaining = deadline - Date.now()
  if (remaining <= 0) return queue()
  const childArgs = [...reporterArgs, ...(!isReport ? ['--hook-recovery-parent'] : []), '--hook-deadline', String(deadline), '--hook-started', String(started), '--home', ${JSON.stringify(home)}]
  const result = spawnSync(process.execPath, [${JSON.stringify(script)}, ...childArgs], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true,
    timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 1048576,
  })
  if (result.error?.code === 'ETIMEDOUT' || result.signal || (result.error || result.status !== 0) && Date.now() >= deadline) return queue()
  if (result.error || result.status !== 0) {
    // The board names why it refused (INVALID_SESSION, say), in brackets that are full-width in
    // Chinese, and the log line keeps that fixed code. A refused report also passes it on, on a
    // line of its own, for the agent to correct (#217).
    const reason = /[(（]([A-Z][A-Z0-9_]{2,63})[)）]/.exec(result.stderr ?? '')?.[1]
    if (reason && isReport) process.stderr.write('AGENT_BOARD_REASON ' + reason + '\\n')
    const failure = reason ? 'REPORTER_FAILED ' + reason : 'REPORTER_FAILED'
    // A report is answered to its agent, never queued. Any other event that failed is saved, so a failure nobody
    // foresaw (#241) costs a retry, not the event. A refusal of the event itself (INVALID_SESSION, say) would refuse
    // its replay too, and replay drops such an entry, so it is only logged. A refusal missing here is saved and dropped
    // at replay, which wastes a replay; a retryable code listed here would lose its event.
    if (isReport || /^(?:INVALID_|BLOCK_|SESSION_CONFLICT$|UNSUPPORTED_AGENT$|MISSING_ARGUMENT$|MISSING_TURN$|STALE_TURN$|SHARED_BOARD_PATH_CONFLICT$|UNSAFE_COMMAND_PATH$)/.test(reason ?? '')) return fail(failure)
    return queue(failure)
  }
  if (!isReport && result.stderr?.split(/\\r?\\n/).includes('AGENT_BOARD_HOOK_PENDING')) requestRecovery()
  process.stdout.write(result.stdout)
  return true
}
if (args.includes('--recover-pending')) recoverPending()
else await run().catch(() => fail('REPORTER_FAILED'))
`

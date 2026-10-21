// Milliseconds internally; Gemini stores milliseconds, the other command hosts seconds.
// Keep the existing per-event host floors until the host descriptors own this table.
export const HOOK_VERSION = 1
// Let the worker reap its reporter before an SDK caller applies its outer backstop.
export const HOOK_WORKER_GRACE = 500
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

// Only fixed diagnostic codes reach this file, never a payload, stderr, session id or path.
// Read a bounded tail and replace atomically; a failed log cannot block a host hook.
export const hookLogSource = (home: string, agent: string): string => `const fs = require('node:fs'), path = require('node:path')
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
  } catch { process.stderr.write('AGENT_BOARD_HOOK_LOG_FAILED\\n') }
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

export const hookWorker = (home: string, script: string): string => `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const value = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const agent = value('--agent')
const policies = ${JSON.stringify(HOOK_TIMEOUTS)}
const safeAgent = Object.hasOwn(policies, agent) ? agent : 'unknown'
${hookLogSource(home, '__AGENT__').replace(JSON.stringify('__AGENT__'), 'safeAgent')}
const isReport = args.includes('--codex-report')
const fail = code => { hookError(code); process.exitCode = isReport ? 1 : 0; if (!isReport && ['cursor', 'gemini', 'antigravity'].includes(agent)) process.stdout.write('{}\\n'); return false }
const run = async () => {
  const started = Date.now()
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
  const deadline = Math.min(started + Math.min(3000, (policy.events?.[value('--hook-event')] ?? policy.timeout) - 1000), inherited === undefined ? Infinity : Number(inherited))
  const budget = deadline - Date.now()
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
  const remaining = deadline - Date.now()
  if (remaining <= 0) return fail('REPORTER_TIMEOUT')
  const internal = ['--hook-version', '--hook-event', '--hook-deadline']
  const childArgs = [...args.filter((arg, index) => !internal.includes(arg) && !internal.includes(args[index - 1])), '--hook-deadline', String(deadline), '--home', ${JSON.stringify(home)}]
  const result = spawnSync(process.execPath, [${JSON.stringify(script)}, ...childArgs], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true,
    timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 1048576,
  })
  if (result.error?.code === 'ETIMEDOUT') return fail('REPORTER_TIMEOUT')
  if (Date.now() >= deadline) return fail('REPORTER_TIMEOUT')
  if (result.error || result.status !== 0) return fail('REPORTER_FAILED')
  process.stdout.write(result.stdout)
  return true
}
await run().catch(() => fail('REPORTER_FAILED'))
`

// The Antigravity sidecar setup writes only when the person asks for it (#1396, PR A).
//
// Antigravity runs a "sidecar" (a folder of its own under ~/.gemini/config/sidecars) in its desktop
// app, and only after the person switches it on in the app's Automations page. Setup never does that.
// This one asks the board whether a wake is owed and, when it is, runs Antigravity's own
// `agentapi send-message <conversation> <fixed line>`. The message text never passes through it: the
// turn-start hook hands the queued message over as it does today.
//
// The contract with the board (the board half is PR B; until then a board answers `wake-poll` with an
// error, which the sidecar reads as "no wakes"):
//   POST /api/messages/wake-poll   {agent:'antigravity'}  ->  {wakes:[{id, conversation, nonce}]}
//   POST /api/messages/wake-report {id, nonce, status:'sent'|'failed', error?}  ->  {ok:true}
// A wake `id` and `nonce` match a message id ([A-Za-z0-9][A-Za-z0-9_-]{0,127}). The sidecar handles every
// wake a poll returns, in order, and never runs a wake twice. A report that gets no answer is sent again
// (the same body, up to three times in all), so the board treats a repeated report of one wake as the same
// report; a report still unanswered after that is only logged, and that wake stays uncertain on the board.
// It reaches the board the way the hooks do: the messages folder's server.lock and server.owner. Every
// poll is also the board's sign that the sidecar is alive. It reads no Antigravity port or token.

export const ANTIGRAVITY_WAKE_LINE = 'Agent Board: a message from the board is attached to this turn. Follow it.'
export const ANTIGRAVITY_SIDECAR_ID = 'agent-board'
// While a board is up the sidecar polls every `fast` ms; with no board (or no answer) it backs off to `slow`.
export const ANTIGRAVITY_POLL_MS = { fast: 2000, slow: 30000 } as const
export const ANTIGRAVITY_SEND_TIMEOUT_MS = 60000
// What setup prints whenever it writes the sidecar files, and the one line its question carries.
export const ANTIGRAVITY_TERMS_LINE = "Google's terms may not cover running this sidecar."

// `description` is the Automations page's line for this sidecar, in the words the board was set up in (the strings tables).
export const antigravitySidecarConfig = (node: string, progress: string, home: string, description: string): string => `${JSON.stringify({
  command: node,
  args: ['sidecar.mjs', '--progress-file', progress, '--home', home],
  restart_policy: 'always',
  description,
}, null, 2)}\n`

// Plain ESM for node. It holds no backtick and no dollar-brace, so it can sit in a String.raw template.
export const antigravitySidecarSource = (): string => String.raw`// Written by Agent Board setup (#1396). Runs only after you switch it on in Antigravity's Automations page.
// It never receives the text of a board message; it sends one fixed line and reports sent or failed.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const WAKE_LINE = ${JSON.stringify(ANTIGRAVITY_WAKE_LINE)}
const FAST_MS = ${ANTIGRAVITY_POLL_MS.fast}
const SLOW_MS = ${ANTIGRAVITY_POLL_MS.slow}
const args = process.argv.slice(2)
const arg = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const sendLimit = Number(arg('--send-timeout-ms') ?? ${ANTIGRAVITY_SEND_TIMEOUT_MS})
const reportRetryMs = Number(arg('--report-retry-ms') ?? 1000)
const home = arg('--home') ?? homedir()
const progress = arg('--progress-file')

// The same folder the board and its hooks use (defaultMessagesDirectory in scripts/runtime-folder.ts).
const isOwnFolder = dir => {
  try { const found = lstatSync(dir); return found.isDirectory() && (process.getuid === undefined || (found.uid === process.getuid() && (found.mode & 0o077) === 0)) } catch { return false }
}
const messagesDirectory = () => {
  const runtime = process.env.XDG_RUNTIME_DIR
  const folder = process.platform === 'win32' ? (runtime ? join(runtime, 'agent-board') : join(home, '.cache', 'agent-board')) : runtime && isOwnFolder(runtime) ? runtime : join(home, '.cache', 'agent-board')
  return join(folder, 'agent-board-' + createHash('sha256').update(resolve(progress)).digest('hex').slice(0, 16) + '-messages')
}
const folder = arg('--messages-dir') ?? (progress ? messagesDirectory() : undefined)
if (args.includes('--print-folder')) { console.log(folder ?? ''); process.exit(0) }
if (!folder) { console.log('no progress file given'); process.exit(1) }

// The running board's local address, from the files the board keeps in that folder.
const findBoard = () => {
  try {
    const found = lstatSync(folder)
    if (!found.isDirectory() || found.isSymbolicLink()) return null
    const lock = readFileSync(join(folder, 'server.lock'), 'utf8')
    if (!/^[1-9][0-9]*$/.test(lock)) return null
    const pid = Number(lock)
    try { process.kill(pid, 0) } catch (error) { if (error.code !== 'EPERM') return null }
    const owner = JSON.parse(readFileSync(join(folder, 'server.owner'), 'utf8'))
    if (owner.pid !== pid || typeof owner.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(owner.url)) return null
    return new URL(owner.url)
  } catch { return null }
}
const post = (board, action, body) => new Promise((done, fail) => {
  const req = http.request(new URL('/api/messages/' + action, board), { method: 'POST', headers: { 'x-board-token': board.searchParams.get('t'), 'content-type': 'application/json' }, timeout: 5000 }, res => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy() })
    res.on('end', () => { try { const result = JSON.parse(text); if (res.statusCode === 200) done(result); else fail(new Error('BOARD_ERROR')) } catch { fail(new Error('BOARD_ERROR')) } })
    res.on('error', () => fail(new Error('BOARD_ERROR')))
  })
  req.on('timeout', () => req.destroy())
  req.on('error', () => fail(new Error('BOARD_ERROR')))
  req.end(JSON.stringify(body))
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isToken = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const stamp = () => new Date().toISOString()
// Reports are safe to repeat: the same id, nonce and status. Three tries, then the wake stays uncertain on the board.
const report = async (board, body) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await post(board, 'wake-report', body); return true } catch {}
    if (attempt < 3) await new Promise(done => setTimeout(done, reportRetryMs * attempt))
  }
  return false
}
// One argument list, no shell, no output kept: Antigravity's own executable sends the one fixed line.
const send = (exe, conversation) => new Promise(done => {
  let isDone = false, timer
  const end = outcome => { if (!isDone) { isDone = true; clearTimeout(timer); done(outcome) } }
  let child
  try { child = spawn(exe, ['agentapi', 'send-message', '--title=Agent Board', conversation, WAKE_LINE], { stdio: 'ignore', windowsHide: true }) } catch { end('SPAWN_FAILED'); return }
  timer = setTimeout(() => { try { child.kill() } catch {} end('TIMEOUT') }, sendLimit)
  child.on('error', () => end('SPAWN_FAILED'))
  child.on('exit', code => end(code === 0 ? 'sent' : 'EXIT_' + String(code)))
})

// One round: true when a board answered (poll again soon), false to back off.
const cycle = async () => {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE
  if (!exe) return false
  const board = findBoard()
  if (!board) return false
  let result
  try { result = await post(board, 'wake-poll', { agent: 'antigravity' }) } catch { return false }
  for (const wake of Array.isArray(result?.wakes) ? result.wakes : []) {
    // Nothing to report back to without a usable id and nonce, so this one is logged, never dropped silently.
    if (!isToken(wake?.id) || !isToken(wake?.nonce)) { console.log(stamp() + ' wake INVALID_WAKE (cannot be reported)'); continue }
    const outcome = typeof wake.conversation === 'string' && UUID.test(wake.conversation) ? await send(exe, wake.conversation) : 'INVALID_CONVERSATION'
    const isReported = await report(board, { id: wake.id, nonce: wake.nonce, status: outcome === 'sent' ? 'sent' : 'failed', ...(outcome === 'sent' ? {} : { error: outcome }) })
    console.log(stamp() + ' wake ' + outcome + (isReported ? '' : ' (report lost)'))
  }
  return true
}

if (args.includes('--once')) { await cycle(); process.exit(0) }
for (;;) {
  const isUp = await cycle()
  await new Promise(done => setTimeout(done, isUp ? FAST_MS : SLOW_MS))
}
`

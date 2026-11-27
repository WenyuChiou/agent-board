import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, posix, win32 } from 'node:path'
import { ackLine, boardClient, deliveryPrompt } from './message-client.mjs'
import { openWebSocketStdio } from './ws-stdio.mjs'

/** @type {import('./message-client.mjs').MessagingReceiverRecord} */
export const messagingReceiver = {
  host: 'Codex',
  agent: 'codex',
  kind: 'live',
  // The live run woke an idle Codex CLI session on the shared daemon after its ~10-minute watch (#1578, #1814);
  // a message during a running turn is not recorded (#1409). With a Codex terminal window open a message goes in at the next
  // tick (#1652; timing record docs/validation/2026-11-26-codex-daemon-short-wait-live.md).
  surfaces: [{ name: 'Daemon', id: 'Codex daemon', evidence: 'docs/validation/2026-11-13-codex-cli-wake-live.md' }],
  routes: {
    idle: { line: 'afterWait', record: 'docs/validation/2026-11-13-codex-cli-wake-live.md', surfaces: ['Codex daemon'] },
    working: { line: 'stepEnd', record: null, surfaces: [] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
  tier: 1,
  primitive: '[P1]',
  isImplemented: true,
}

// SURFACE_IDS.codexDaemon in hooks/messaging.ts; a test pins the two together. This file runs under plain Node and cannot import the .ts table.
const SURFACE = 'Codex daemon'
const THREAD = /^[a-f0-9-]{36}$/i
// A turn that never ends cannot hold a message for ever; the board's own limit on an unanswered message is 30 minutes.
const ACK_LIMIT_MS = 30 * 60_000
const TICK_MS = 3000
// A person who quits leaves the thread loaded for 60 s (the daemon's unload delay), and the receiver reads it as still attached for
// that long. A board turn that waits on an approval nobody is there to answer is stopped after this (docs/validation/2026-11-14-codex-attached-client.md).
const APPROVAL_LIMIT_MS = 120_000
// The first daemon whose unload delay the record read and ran live; an older or unnamed one is read as "nobody attached".
const MIN_DAEMON = [0, 169, 0]
// The daemon's unload delay when its config names none (60 s), and the margin added to it for the time a request and its answer
// take and for two clocks that do not run alike. A person can set the delay (`thread_unload_delay_secs` in Codex's config), so the
// receiver asks the daemon for the delay of the thread's folder. A delay set for one thread only (`codex -c
// thread_unload_delay_secs=…`, or a client's `config` on `thread/start`) is not in that answer, and no answer of the daemon names
// it (Codex 0.169.0), so without a way to tell that a Codex terminal window is open the receiver never waits less than 10
// minutes with the margin (UNLOAD_LEAST_MS): a per-thread delay up to 10 minutes cannot keep a thread listed past that with
// nobody on it (#1578). Every thread this receiver watches is on the background service that a terminal `codex` starts and
// uses, and a terminal's own thread has the folder's delay (a `-c` override runs in a process of its own, never on the
// daemon), so while at least one Codex terminal window process is alive a message needs no quiet wait at all: that process is the
// sign a person is there (#1652). The process list is read only once a message is claimed (`readClients`), never while nothing waits.
const UNLOAD_DEFAULT_SECS = 60
const UNLOAD_MARGIN_MS = 5000
const UNLOAD_LEAST_MS = 10 * 60_000
const UNLOAD_MS = UNLOAD_LEAST_MS + UNLOAD_MARGIN_MS
// How a Codex terminal window is told from the rest of the process list (#1652), and how long the list may take. A window is a
// Codex program that is not the app-server and is not the npm launcher; one is known by its process id and start time, and the
// same window is the same id with a start time within the drift hooks/session-liveness.ts allows.
const AGENT_START_DRIFT_MS = 3000
// The live run of 2026-11-26 timed the Windows list (PowerShell, CIM) at 1.6 to 5.7 s on a busy computer: a slow read is still an
// answer, and one cut short sends the message to the 10-minute route.
const CLIENTS_LIMIT_MS = 10_000
const CLIENTS_ASK_LIMIT_MS = 11_000
// A thread with no window found is kept off the short wait for this many ticks, so a waiting message costs one read in that time.
const HOLD_TICKS = 10
// A Codex program running as a server, not as a person's window: the command anywhere after the flags.
const SERVER_COMMAND = /(?:^|[\s"])(?:app|exec|mcp)-server(?=\s|"|$)/
// Codex's commands that run with no window of a person's (`codex --help`, 0.174): a one-shot run (`exec`, `e`, `review`) such as
// another tool's, the account and setup tools, and the servers. Only the word right after the program is read: Codex reads that
// word as its command, never as a prompt, so a prompt or a resumed session (`resume`, `fork`) is still a window. A command after
// flags (`codex -c k=v exec`) is still read as a window, the wait the person's own window would give.
const NO_WINDOW_COMMANDS = new Set(['exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'migrate-nfs-db', 'unarchive', 'exec-server', 'mcp-server', 'features', 'help'])
const commandWord = argv => /^\s*(?:"[^"]*"|\S+)\s+([^\s"]+)(?=\s|$)/.exec(argv)?.[1] ?? ''
// Whether a listing asked at `listedAt` is one wait after a stretch that began at `since`: the longer of `unloadMs` and the
// folder's unload delay (`delay`) with its margin (#1578).
export const isWaitOver = ({ since, listedAt, delay, unloadMs = UNLOAD_MS, unloadMarginMs = UNLOAD_MARGIN_MS }) =>
  listedAt >= since + Math.max(unloadMs, delay + unloadMarginMs)
// How long the answer to a leave is waited for, and how many leaves in a row may fail before the receiver ends its connection to
// the daemon: a connection that is gone is in no thread.
const LEAVE_LIMIT_MS = 5000
const LEAVE_TRIES = 3
// A turn left waiting on an approval is asked to stop this many times before the receiver reports that it could not.
const INTERRUPT_TRIES = 3
// The answers to thread/unsubscribe that say this connection is out of the thread.
const LEFT = new Set(['unsubscribed', 'notSubscribed', 'notLoaded'])
// The ways a turn is over, as `thread/turns/list` names them; any other status is a turn that still runs.
const OVER = new Set(['completed', 'interrupted', 'failed'])
// The board's refusals of a receipt that are about the message itself (it expired, was dismissed, or is settled otherwise): the
// same receipt would be refused again, whichever connection sent it.
const SETTLED = new Set(['MESSAGE_EXPIRED', 'MESSAGE_DISMISSED', 'RECEIPT_CONFLICT', 'TARGET_MISMATCH', 'CLAIM_REQUIRED', 'INVALID_RECEIPT', 'INVALID_TEXT', 'UNKNOWN_FIELD', 'ACK_REQUIRED'])
const RETRY_MAX_MS = 30_000

// The Codex terminal windows among process rows `{ pid, started (ms), name, argv }` (`argv` a string, or null when unreadable).
// A window is a row named `codex.exe` (Windows, any letter case) or `codex` (elsewhere) whose command line is readable, does not
// name the app-server, and whose start time is known. Returns each window as `pid:started` and whether the list is unsure: a
// Codex-named row that cannot be read, with no clear window found.
export const terminalClients = (rows, platform = process.platform) => {
  const isCodex = platform === 'win32' ? name => /^codex\.exe$/i.test(name) : name => name === 'codex'
  const clients = []
  let isUnsure = false
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isCodex(String(row?.name ?? ''))) continue
    const isKnown = typeof row.argv === 'string' && row.argv !== '' && Number.isSafeInteger(row.started) && row.started > 0 && Number.isSafeInteger(row.pid) && row.pid > 0
    if (!isKnown) { isUnsure = true; continue }
    // The app-server, and the servers the Codex desktop app starts (exec-server) or a host starts (mcp-server), are no window.
    if (SERVER_COMMAND.test(row.argv) || NO_WINDOW_COMMANDS.has(commandWord(row.argv))) continue
    clients.push(`${row.pid}:${row.started}`)
  }
  return { clients, isUnsure: isUnsure && clients.length === 0 }
}
// Whether one window is in both lists: the same process id, started within the drift of each other. A fresh list alone would take
// any new Codex process for the window that was there, so the list read right before the start is held to the decision's.
export const hasSameClient = (before, after) => {
  const split = one => { const at = String(one).indexOf(':'); return [Number(String(one).slice(0, at)), Number(String(one).slice(at + 1))] }
  return before.some(a => after.some(b => {
    const [pidA, startA] = split(a), [pidB, startB] = split(b)
    return pidA === pidB && Math.abs(startA - startB) <= AGENT_START_DRIFT_MS
  }))
}
// Rows from the Windows query: `pid|creation time in 100 ns ticks since 1601|name|command line` per line; a line that is not
// that is the rest of the line before it. Anything else, or nothing before the first row, is an unreadable list.
export const parseWindowsClients = text => {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue
    const head = /^(\d+)\|(\d*)\|([^|]*)\|(.*)$/.exec(line)
    if (head === null) {
      if (rows.length === 0) throw new Error('CLIENTS_UNPARSABLE')
      const last = rows[rows.length - 1]
      if (last.argv !== null) last.argv += '\n' + line
      continue
    }
    const started = head[2] === '' ? null : Number(BigInt(head[2]) / 10000n - 11644473600000n)
    rows.push({ pid: Number(head[1]), started, name: head[3], argv: head[4] === '' ? null : head[4] })
  }
  return rows
}
// Rows from `ps -axo pid=,lstart=,command=` (C locale, UTC); only the Codex programs are kept.
export const parsePsClients = text => {
  const rows = []
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue
    const head = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line)
    if (head === null) throw new Error('CLIENTS_UNPARSABLE')
    const command = head[3]
    // ps joins a program's words with spaces, unquoted. A command whose first word is the codex program is one. A `/codex` further
    // on may be a program in a folder with a space, or another program's argument: that row is kept with no command line, so it
    // reads as one that cannot be read (the 10-minute route), never as a window.
    const isProgram = /^(?:\S*\/)?codex(?=\s|$)/.test(command)
    if (!isProgram && !/\/codex(?=\s|$)/.test(command)) continue
    const started = Date.parse(`${head[2]} UTC`)
    rows.push({ pid: Number(head[1]), started: Number.isFinite(started) && started > 0 ? started : null, name: 'codex', argv: isProgram ? command : null })
  }
  return rows
}
// The process list, asked without blocking the page's server (never execFileSync), with a limit. Any error, timeout or odd output
// rejects: the list cannot be read, and the receiver then keeps the 10-minute wait.
const askProcesses = (program, args, options, parse) => new Promise((done, fail) => {
  const child = execFile(program, args, { windowsHide: true, timeout: CLIENTS_LIMIT_MS, maxBuffer: 16_000_000, encoding: 'utf8', ...options }, (error, stdout) => {
    if (error) { fail(error); return }
    try { done(parse(stdout)) } catch (odd) { fail(odd) }
  })
  child.stdin?.end()
})
const readWindowsClients = () => {
  const shell = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = '$ErrorActionPreference = \'Stop\'; Get-CimInstance Win32_Process -Filter "Name=\'codex.exe\'" | ForEach-Object { $t = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { \'\' }; \'{0}|{1}|{2}|{3}\' -f $_.ProcessId, $t, $_.Name, $_.CommandLine }'
  return askProcesses(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { env: childEnvironment(process.env) }, parseWindowsClients)
}
const readMacClients = () => askProcesses('/bin/ps', ['-axo', 'pid=,lstart=,command='], { env: { ...childEnvironment(process.env), LC_ALL: 'C', TZ: 'UTC' } }, parsePsClients)
const linuxTicks = stat => {
  const close = stat.lastIndexOf(')')
  const ticks = close < 0 ? NaN : Number(stat.slice(close + 2).trim().split(/\s+/)[19])
  return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null
}
// /proc/<pid>/cmdline holds the exact arguments, split by NUL. They are written as one line the way Windows gives it: an argument
// with a space or a quote is put in quotes, so a prompt (`codex "review this"`) is not read as Codex's `review` command.
export const linuxCommandLine = text => String(text).split('\0').filter(one => one !== '')
  .map(one => /[\s"]/.test(one) ? `"${one.replace(/"/g, "'")}"` : one).join(' ') || null
// Linux reads /proc, with no process started; the start time is worked out as scripts/local-lock.ts does.
const readLinuxClients = async () => {
  const self = linuxTicks(await readFile('/proc/self/stat', 'utf8'))
  const rows = []
  for (const id of (await readdir('/proc')).filter(name => /^[1-9]\d*$/.test(name))) {
    let stat
    try { stat = await readFile(`/proc/${id}/stat`, 'utf8') } catch { continue }
    const open = stat.indexOf('('), close = stat.lastIndexOf(')')
    if (open < 0 || close < open || stat.slice(open + 1, close) !== 'codex') continue
    const ticks = linuxTicks(stat)
    let argv = null
    try { argv = linuxCommandLine(await readFile(`/proc/${id}/cmdline`, 'utf8')) } catch { /* Unreadable: the row says so. */ }
    rows.push({ pid: Number(id), started: ticks === null || self === null ? null : Math.round(performance.timeOrigin + (ticks - self) * 10), name: 'codex', argv })
  }
  return rows
}
export const readCodexClients = () => process.platform === 'win32' ? readWindowsClients()
  : process.platform === 'linux' ? readLinuxClients()
    : process.platform === 'darwin' ? readMacClients() : Promise.reject(new Error('CLIENTS_UNSUPPORTED'))

// The Codex program to run, as a path that needs no shell: an `.exe` or a script Node runs. On Windows
// the `codex.cmd` an npm install leaves is a shell script, so its Codex script is run by Node instead,
// and a `.cmd` with no script beside it is refused (null).
export const resolveCodexExecutable = ({ env = process.env, platform = process.platform, exists = existsSync } = {}) => {
  // The platform asked about decides how a path is read, not the one the board runs on.
  const flavor = platform === 'win32' ? win32 : posix
  const path = env.PATH ?? env.Path ?? ''
  for (const folder of path.split(flavor.delimiter)) {
    if (!flavor.isAbsolute(folder)) continue
    const join = flavor.join
    if (platform !== 'win32') {
      const file = join(folder, 'codex')
      if (exists(file)) return file
      continue
    }
    const exe = join(folder, 'codex.exe')
    if (exists(exe)) return exe
    const script = join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (exists(join(folder, 'codex.cmd')) && exists(script)) return script
  }
  return null
}

// An explicit path (AGENT_BOARD_CODEX_BIN) is held to the same rule: a `.cmd` or `.bat` is a shell script, so on Windows it
// is replaced by the Codex script beside it, or refused (null) when there is none.
export const explicitCodexExecutable = (given, { platform = process.platform, exists = existsSync } = {}) => {
  const flavor = platform === 'win32' ? win32 : posix
  if (!flavor.isAbsolute(given)) return null
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(given)) return given
  const script = flavor.join(flavor.dirname(given), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  return exists(script) ? script : null
}

// The board's address and token live only in this process: the Codex program gets neither in its
// arguments nor in its environment.
const childEnvironment = env => Object.fromEntries(Object.entries(env).filter(([name, value]) => typeof value === 'string' && !/^AGENT_BOARD_/i.test(name)))

const connectDaemon = async ({ executable, socket, env, onMessage, onClose }) => {
  if (!isAbsolute(executable)) throw new Error('EXPLICIT_EXECUTABLE_REQUIRED')
  const args = ['app-server', 'proxy', ...(socket ? ['--sock', socket] : [])]
  const options = { windowsHide: true, env: childEnvironment(env) }
  const child = /\.m?js$/i.test(executable) ? spawn(process.execPath, [executable, ...args], options) : spawn(executable, args, options)
  const closed = new Promise(done => child.once('close', done))
  const exited = Promise.race([closed, new Promise(done => setTimeout(done, 3000).unref())])
  const requests = new Map()
  let sequence = 0, isOpen = true
  const lost = () => {
    if (!isOpen) return
    isOpen = false
    for (const one of requests.values()) { clearTimeout(one.timer); one.reject(new Error('OWNER_DISCONNECTED')) }
    requests.clear()
    onClose()
  }
  child.on('error', lost); child.on('exit', lost)
  child.stderr.on('data', () => undefined)
  child.stdin.on('error', lost)
  const websocket = openWebSocketStdio({
    input: child.stdout, output: child.stdin,
    onClose: () => { lost(); child.kill() },
    onMessage: text => {
      let value; try { value = JSON.parse(text) } catch { return }
      if (!value || typeof value !== 'object') return
      if (value.id !== undefined && !value.method) {
        const one = requests.get(value.id)
        if (!one) return
        requests.delete(value.id); clearTimeout(one.timer)
        if (value.error) one.reject(new Error('OWNER_REJECTED'))
        else { one.onAnswer?.(); one.done(value.result) }
        return
      }
      // A request the daemon makes of its clients (an approval) is left unanswered: it is the person's own client that answers it.
      if (typeof value.method === 'string') onMessage(value)
    },
  })
  // onAnswer runs the moment the answer is read: notices that follow it in the same read are handled before the caller resumes.
  const request = (method, params, limit = 5000, onAnswer) => new Promise((done, reject) => {
    if (!isOpen) { reject(new Error('OWNER_DISCONNECTED')); return }
    const id = ++sequence
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('OWNER_TIMEOUT')) }, limit)
    requests.set(id, { done, reject, timer, onAnswer })
    try { websocket.send(JSON.stringify({ id, method, params })) } catch (error) { clearTimeout(timer); requests.delete(id); reject(error) }
  })
  // Sync, so a process that is exiting can still end the Codex program.
  const kill = () => { lost(); websocket.close(); child.kill() }
  let info
  try {
    await websocket.ready
    info = await request('initialize', { clientInfo: { name: 'agent-board-codex-receiver', version: '1' } })
    websocket.send(JSON.stringify({ method: 'initialized', params: {} }))
  } catch (error) { kill(); await exited; throw error }
  return { request, info, isOpen: () => isOpen, kill, close: async () => { kill(); await exited } }
}

// Every thread the running daemon has loaded. A thread that is not in this list is never resumed, so a
// saved thread is never opened from disk.
const loadedThreads = async daemon => {
  const loaded = new Set()
  const seen = new Set()
  let cursor = null
  do {
    const listed = await daemon.request('thread/loaded/list', { cursor, limit: 100 })
    if (!Array.isArray(listed?.data)) throw new Error('INVALID_OWNER_RESPONSE')
    for (const id of listed.data) loaded.add(id)
    cursor = listed.nextCursor ?? null
    if (cursor !== null && (typeof cursor !== 'string' || seen.has(cursor) || seen.size >= 100)) throw new Error('INVALID_OWNER_RESPONSE')
    seen.add(cursor)
  } while (cursor !== null)
  return loaded
}

// Whether the daemon unloads a thread 60 s after its last subscriber leaves, the one trace a person's client leaves. It names itself
// in the answer to `initialize`; one that does not, or an older one, is read as not telling.
export const hasUnloadDelay = info => {
  const found = /\/(\d+)\.(\d+)\.(\d+)/.exec(String(info?.userAgent ?? ''))
  if (found === null) return false
  const version = found.slice(1).map(Number)
  for (const [i, least] of MIN_DAEMON.entries()) if (version[i] !== least) return (version[i] ?? 0) > least
  return true
}

// The unload delay, in ms, that the daemon's answer to `config/read` gives a thread loaded now: `thread_unload_delay_secs`, or the
// default when the config names none. Anything else (no config in the answer, a value that is not a whole number of seconds from
// zero up) is null: the delay is not known, and the receiver then reads nobody on the thread.
export const unloadDelayOf = answer => {
  const config = answer?.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null
  const seconds = config.thread_unload_delay_secs ?? UNLOAD_DEFAULT_SECS
  return Number.isSafeInteger(seconds) && seconds >= 0 && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : null
}

// How long a page started by a test watches a thread before it reads it as a person's, in place of the daemon's own delay and
// margin: the tests' stand-in daemon unloads sooner. Only a page that the test process started itself may take it. The test names
// its own process id (AGENT_BOARD_TEST_PID), and that must be `parent`, the id of the process that started the page. Any other
// id, or none, gives undefined, and the page waits as long as for a real daemon.
export const testUnloadMs = (env, parent) => {
  const pid = env.AGENT_BOARD_TEST_PID, given = Number(env.AGENT_BOARD_CODEX_UNLOAD_MS)
  return typeof pid === 'string' && /^[1-9]\d*$/.test(pid) && Number(pid) === parent && Number.isInteger(given) && given >= 100 && given <= 65_000 ? given : undefined
}

// What a page started by a test finds in the process list, in place of the real one: AGENT_BOARD_CODEX_CLIENTS is `none`, `one` or
// `unreadable`, and is taken only from a test process that named itself (AGENT_BOARD_TEST_PID) and started the page, as testUnloadMs.
export const testClients = (env, parent, platform = process.platform) => {
  const pid = env.AGENT_BOARD_TEST_PID, given = env.AGENT_BOARD_CODEX_CLIENTS
  if (!(typeof pid === 'string' && /^[1-9]\d*$/.test(pid) && Number(pid) === parent)) return undefined
  if (given === 'none') return async () => []
  if (given === 'one') return async () => [{ pid: 4242, started: 1_700_000_000_000, name: platform === 'win32' ? 'codex.exe' : 'codex', argv: 'codex' }]
  if (given === 'unreadable') return async () => { throw new Error('CLIENTS_UNREADABLE') }
  return undefined
}

const input = prompt => [{ type: 'text', text: prompt, text_elements: [] }]
// Whether a user message item is this delivery's own: its echoed claim nonce, or the exact text it was sent with.
const isOwnInput = (item, pending) => item.clientId === pending.nonce
  || Array.isArray(item.content) && item.content.some(part => part?.type === 'text' && part.text === pending.prompt)
// Takes a board message for each Codex thread that a person has open and the board knows, and starts one turn with it when the
// thread reads idle. Every thread here is on the background service. The daemon tells nobody who is subscribed to a thread, so a
// person's Codex window is told from the process list (#1652), read only when a message was claimed (`readClients`: 'decide' at the
// claim, 'join' right before the receiver joins, 'start' before the turn when the board took long to answer). A window found: the
// message goes in at the next tick of a thread that reads idle in a fresh look and listing, however recently its last turn ended.
// No window: the claim goes back `unsent` and the thread is kept off this route for HOLD_TICKS ticks. A list that cannot be read:
// the claim goes back and the thread waits as it did before the process check (`quiet`, `sample`): the daemon keeps a thread loaded
// until 60 s (its config's delay for the folder) after the last client left or the last turn ended, so a listing one wait after
// an unbroken stretch the receiver saw, with no subscription of its own and idle statuses, shows a person's client; the wait is
// the folder's delay with a margin, never less than unloadMs, and a delay that cannot be read is not guessed. The
// receiver stays out of the thread while it waits: it joins to deliver one message and leaves when the turn ends. A claim that
// meets a busy thread or nobody attached is given back or held here, and the board's own 30-minute limit on an unanswered message
// covers it. `threads()` gives the Codex session ids the board knows, and
// throws when it cannot tell. Nothing is started for a thread the daemon has not loaded, nothing goes through Codex's queue,
// and a running turn is never steered (#1409).
export const startCodexReceiver = ({
  boardUrl, threads, executable, socket, env = process.env,
  tickMs = TICK_MS, ackMs = ACK_LIMIT_MS, approvalMs = APPROVAL_LIMIT_MS, unloadMs = UNLOAD_MS, unloadMarginMs = UNLOAD_MARGIN_MS, leaveMs = LEAVE_LIMIT_MS,
  // How often each board connection asks the board for messages; the tests ask more often.
  pollMs = 2000,
  // A clock that never goes back and is not the wall clock, which a person or a time sync can move.
  now = () => performance.now(), onError = () => undefined,
  // The tick that the watch's gap rule counts in on `now`'s clock (two looks more than two of these apart end the stretch). It
  // is tickMs, the timer's own period, except in a test that runs `now` faster than the wall clock to watch a whole wait (#1578).
  watchTickMs = tickMs,
  // The process list, `async (why) => rows` (why: 'decide', 'join' or 'start'), and the platform its rows are read for (#1652).
  clients = readCodexClients, platform = process.platform,
}) => {
  if (typeof threads !== 'function' || !isAbsolute(executable ?? '')) throw new Error('EXPLICIT_EXECUTABLE_REQUIRED')
  const client = boardClient(boardUrl)
  const attached = new Map()
  let daemon = null, isTicking = false, isClosed = false, closing = null, connecting = null, failures = 0, retryAt = 0
  // The newest list of loaded threads, with the time its request was sent: a thread it shows was still loaded after that time.
  let listing = { set: new Set(), sentAt: 0 }, canTell = false
  // What this receiver's connection to the daemon has in each thread, kept apart from the board connection for it (`attached`),
  // which can end (a contest, a row read as ended) while the subscription, a leave or an interrupt is still there.
  // mayBeSubscribed: set before the join is sent, and cleared only when the daemon confirms a leave or the connection is gone.
  // isInUse: a delivery is joining or running its turn, so nothing else may leave. joins: counts the joins, so the answer to a
  // leave asked before a join changes nothing. leaving: the leave in flight. interrupt: the turn an approval left waiting, still
  // being asked to stop. isChecking: a look at a watched turn is in flight. owed: what the board is still to be told about a
  // message whose turn was stopped (`report`).
  // watch: the turn a delivery started, with the timer of its wait on an approval. It is made when turn/start is sent and belongs
  // to the turn, not to the delivery: whatever ends the delivery (a receipt the board refuses, a contest, a lost board or daemon
  // connection, an error), the watch lives until its turn is known to be over (its end was heard, the thread was unloaded or reads
  // as not active, its interrupt was answered or given up) or known not to be this delivery's (the daemon refused the start, the
  // request never left, or the turn began with someone else's message). So a turn the receiver started is still stopped when its
  // approval has waited too long, and only a turn shown to be the delivery's own ever is. Its fields: message, the board message the turn carries, until someone has told the board what
  // became of it; turn, the turn known to be the delivery's own (the answer to turn/start named it, or its first user message was
  // the delivery's); heard, a turn whose start was heard since the start was sent and whose owner is not known yet (it is never asked to stop
  // while it is only that); ended, the
  // ends the delivery with no receipt of its own while it still runs; naming, the thread/turns/list lookup in flight; checking, the
  // approval-limit check in flight.
  const subs = new Map()
  const subOf = thread => {
    if (!subs.has(thread)) subs.set(thread, { mayBeSubscribed: false, isInUse: false, joins: 0, leaving: null, hasLeaveFailed: false, leaveFails: 0, interrupt: null, watch: null, isChecking: false, owed: null, acking: null })
    return subs.get(thread)
  }
  // What the receiver has seen of each thread from outside it. since: the start of the unbroken stretch described above, or null
  // when there is none yet. last: when the last look was answered. marker: the thread's `updatedAt` at that look. epoch: counts
  // the breaks, so a look asked before one cannot start a stretch after it. sampling: the look in flight. delay: the longest
  // unload delay the daemon's config gave for the thread's folder at any look, or null while none could be read. The daemon fixes
  // a thread's delay when it loads it, so a config that was changed to a shorter one since does not shorten the wait. noneEpoch:
  // the epoch a find of no window started, so a later find in the same stretch does not start it again.
  const quiet = new Map()
  let hasConfigFailed = false, hasClientsFailed = false
  // A thread kept off the short wait (#1652). none: a claim found no Codex window, so for HOLD_TICKS ticks it is not claimed on the
  // short wait; unreadable: the process list could not be read. Either way the message waits as it did before the process check
  // and goes with no check once that wait is over; for none the wait counts from the find (holdNone): a thread nobody holds is
  // unloaded long before, so one still listed is held by a client the list does not show as a window, and a message never waits
  // with no end. An unreadable hold ends when its message
  // goes, and the next message reads the list again, so one failed read is not kept for the thread. A readable list that finds a
  // window ends either.
  const holds = new Map()
  // How many times the daemon said it closed each thread: a close during a process-list read voids what the read decided.
  const closes = new Map()
  const holdOf = thread => {
    const hold = holds.get(thread)
    if (hold === undefined) return null
    if (hold.until !== null && Date.now() >= hold.until) { holds.delete(thread); return null }
    return hold
  }
  // No window found: the 10-minute wait starts again, since the stretch may have begun while a window was open, and a thread whose
  // window just closed is still listed for its unload delay. Only the first such find in a stretch starts it again: a later one,
  // after the hold ended and the list was read again, does not, so the message never waits with no end.
  const holdNone = thread => {
    holds.set(thread, { kind: 'none', until: Date.now() + HOLD_TICKS * tickMs })
    const q = quietOf(thread)
    if (q.noneEpoch !== q.epoch) { restart(thread); q.noneEpoch = q.epoch }
  }
  const quietOf = thread => {
    if (!quiet.has(thread)) quiet.set(thread, { since: null, last: null, marker: undefined, epoch: 0, sampling: null, delay: null, isIdle: false, noneEpoch: null })
    return quiet.get(thread)
  }
  // Something happened that the stretch cannot span: it starts again at a later look.
  const restart = thread => {
    const q = quiet.get(thread)
    if (q) { q.since = null; q.epoch += 1 }
  }

  const ask = (method, params, limit, onAnswer) => daemon === null ? Promise.reject(new Error('OWNER_DISCONNECTED')) : daemon.request(method, params, limit, onAnswer)
  const list = async () => {
    const on = daemon
    if (on === null) throw new Error('OWNER_DISCONNECTED')
    const sentAt = now()
    const set = await loadedThreads(on)
    if (daemon !== on) throw new Error('OWNER_DISCONNECTED')
    // A thread that any listing leaves out was unloaded, whatever a later one shows.
    for (const thread of quiet.keys()) if (!set.has(thread)) restart(thread)
    if (sentAt >= listing.sentAt) listing = { set, sentAt }
    return set
  }
  const read = async thread => {
    const found = (await ask('thread/read', { threadId: thread, includeTurns: false }))?.thread
    if (typeof found?.status?.type !== 'string') throw new Error('INVALID_OWNER_RESPONSE')
    return { status: found.status.type, marker: found.updatedAt, cwd: found.cwd, isEphemeral: found.ephemeral === true, isWaiting: Array.isArray(found.status.activeFlags) && found.status.activeFlags.includes('waitingOnApproval') }
  }
  // The unload delay the daemon's config gives a thread in this folder, project config included. Asked of the daemon, which reads
  // its own config: the receiver never opens the person's Codex home. A refusal or an odd answer is reported once per connection.
  const unloadDelay = async cwd => {
    try {
      if (typeof cwd !== 'string' || cwd === '') throw new Error('INVALID_OWNER_RESPONSE')
      const delay = unloadDelayOf(await ask('config/read', { includeLayers: false, cwd }))
      if (delay === null) throw new Error('UNLOAD_DELAY_UNKNOWN')
      return delay
    } catch (error) {
      if (error?.message !== 'OWNER_DISCONNECTED' && !hasConfigFailed) { hasConfigFailed = true; onError(new Error('UNLOAD_DELAY_UNKNOWN')) }
      return null
    }
  }
  // One look at a thread from outside it; one at a time, a second caller gets the look in flight. It starts a stretch only when it
  // reads idle, was asked after the last break, and this receiver is out of a thread the newest listing shows. The stretch starts
  // when the answer arrives, never earlier. A look that fails, gets no answer or reads anything but idle ends the stretch. So does
  // one that comes more than two ticks after the last (a tick is skipped while the one before it still runs, so one look per tick
  // cannot be promised), counted from the answer of the one to the asking of the next and to its answer: the receiver was not
  // watching. A look that is answered late starts a new stretch with its own answer. A turn that began and ended between two
  // looks, however far apart, shows only in the thread's `updatedAt`: a changed one ends the stretch, and a thread that reports
  // none never has one. A look that cannot read the thread's unload delay ends it too.
  const sample = thread => {
    const q = quietOf(thread)
    if (q.sampling !== null) return q.sampling
    q.sampling = (async () => {
      const on = daemon, sentAt = now()
      if (q.last === null || sentAt - q.last > 2 * watchTickMs) restart(thread)
      // In the thread, or maybe in it, the receiver's own subscription keeps it loaded: nothing read now is about a person.
      if (subs.get(thread)?.mayBeSubscribed === true) { q.since = null; q.isIdle = false; return }
      const epoch = q.epoch
      let seen = null, delay = null
      try { seen = await read(thread) } catch { /* A look that failed saw nothing. */ }
      if (seen?.status === 'idle') delay = await unloadDelay(seen.cwd)
      // The connection it was asked on is gone, and with it everything seen through it.
      if (daemon !== on || quiet.get(thread) !== q) return
      const at = now()
      // Asked in time and answered late: what the thread did meanwhile nobody saw, as when it is asked late.
      if (q.last !== null && at - q.last > 2 * watchTickMs) q.since = null
      q.last = at
      // What the short route needs from a look: the thread read idle, is not an ephemeral one, and the receiver is out of it.
      q.isIdle = seen?.status === 'idle' && seen.isEphemeral !== true && subs.get(thread)?.mayBeSubscribed !== true
      if (delay !== null) q.delay = Math.max(q.delay ?? 0, delay)
      const hasMarker = typeof seen?.marker === 'number' || typeof seen?.marker === 'string'
      // An ephemeral thread (a short one the daemon closes by itself) is never a person's.
      if (seen?.status !== 'idle' || seen.isEphemeral || delay === null || !hasMarker || q.epoch !== epoch || subs.get(thread)?.mayBeSubscribed === true || !listing.set.has(thread)) { q.since = null; return }
      if (seen.marker !== q.marker) { q.marker = seen.marker; q.since = null }
      if (q.since === null) q.since = at
    })().finally(() => { q.sampling = null })
    return q.sampling
  }
  // A person's client is on the thread, or left it less than 60 s ago: the receiver is out of it, the stretch is unbroken up to
  // a look and a listing no older than two ticks, and that listing was asked for one wait after the stretch began. With no client
  // on it and no turn, the daemon would have unloaded the thread by then. Anything not known reads as nobody.
  const isPersonAttached = (thread, floor = unloadMs) => {
    const q = quiet.get(thread), at = now()
    // The short route (#1652) has no quiet wait: a person's Codex window is told by the process check in `deliver`, so a thread that
    // reads idle in a fresh look and a fresh listing can take a message at the next tick, however recently a turn ended.
    if (holdOf(thread) === null) {
      return canTell && q !== undefined && q.last !== null && q.isIdle && subs.get(thread)?.mayBeSubscribed !== true && listing.set.has(thread)
        && at - q.last <= 2 * watchTickMs && at - listing.sentAt <= 2 * watchTickMs
    }
    if (!canTell || q === undefined || q.since === null || q.last === null || q.delay === null || subs.get(thread)?.mayBeSubscribed === true || !listing.set.has(thread)) return false
    if (at - q.last > 2 * watchTickMs || at - listing.sentAt > 2 * watchTickMs) return false
    return isWaitOver({ since: q.since, listedAt: listing.sentAt, delay: q.delay, unloadMs: floor, unloadMarginMs })
  }
  // The least wait for a thread: none (the folder's delay and the margin) unless it is on hold. No process list is read here: this
  // runs on every board poll, whether or not a message waits.
  const floorOf = thread => holdOf(thread) === null ? 0 : unloadMs
  // Whether a message can go to the thread now, from a fresh look and a listing no older than two ticks.
  const isReady = async thread => {
    if (!canTell || subs.get(thread)?.mayBeSubscribed === true) return false
    await sample(thread)
    if (now() - listing.sentAt > 2 * watchTickMs) try { await list() } catch { return false }
    // A thread with no Codex window found is not claimed on the short wait until its hold is over; the 10-minute wait still holds.
    return isPersonAttached(thread, floorOf(thread))
  }
  // Whether the process list shows a Codex terminal window now: 'clients' (with their ids), 'none', or 'unreadable' (an error, a
  // timeout, an odd answer, or a Codex row that cannot be read with no clear window). Told once per daemon connection.
  const readClients = async why => {
    try {
      const rows = await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error('CLIENTS_TIMEOUT')), CLIENTS_ASK_LIMIT_MS)
        timer.unref?.()
        Promise.resolve().then(() => clients(why)).then(value => { clearTimeout(timer); done(value) }, error => { clearTimeout(timer); fail(error) })
      })
      if (!Array.isArray(rows)) throw new Error('CLIENTS_UNKNOWN')
      const found = terminalClients(rows, platform)
      if (found.clients.length > 0) return { kind: 'clients', ids: found.clients }
      if (!found.isUnsure) return { kind: 'none', ids: [] }
    } catch { /* Told below. */ }
    if (!hasClientsFailed) { hasClientsFailed = true; onError(new Error('CLIENTS_UNKNOWN')) }
    return { kind: 'unreadable', ids: [] }
  }
  // Whether the window found before is still there: one window of the earlier list, by process id and start time.
  const isWindowThere = async (before, why) => {
    const found = await readClients(why)
    return found.kind === 'clients' && hasSameClient(before, found.ids)
  }
  // Leaves the thread so the daemon can unload it once nobody else is on it. One leave at a time: a second caller gets the one in
  // flight. Only the daemon's own word that this connection is out, or a lost connection (the daemon drops its subscriptions),
  // marks the thread left. A refused, odd or missing answer keeps it marked subscribed, so nothing reads this receiver's own
  // subscription as a person; it is reported once and asked again on each tick. After LEAVE_TRIES of those in a row the receiver
  // ends its connection to the daemon, the one way left to be out of the thread for certain. The answer to a leave asked before
  // a later join is about the old subscription and changes nothing.
  const leave = thread => {
    const sub = subs.get(thread)
    if (!sub) return Promise.resolve()
    if (sub.leaving !== null) return sub.leaving
    if (!sub.mayBeSubscribed || sub.isInUse || sub.interrupt !== null || sub.watch !== null) return Promise.resolve()
    const on = daemon, joins = sub.joins
    sub.leaving = (async () => {
      try {
        const answer = await ask('thread/unsubscribe', { threadId: thread }, leaveMs)
        if (!LEFT.has(answer?.status)) throw new Error('INVALID_OWNER_RESPONSE')
        if (daemon !== on || sub.joins !== joins) return
        sub.mayBeSubscribed = false
        sub.hasLeaveFailed = false
        sub.leaveFails = 0
        // The receiver's own leave starts the daemon's delay again: only a look asked after it counts.
        restart(thread)
      } catch (error) {
        // lost() has run: the daemon dropped every subscription of the connection.
        if (error?.message === 'OWNER_DISCONNECTED' || daemon !== on) return
        if (!sub.hasLeaveFailed) { sub.hasLeaveFailed = true; onError(error) }
        sub.leaveFails += 1
        if (sub.leaveFails >= LEAVE_TRIES) { onError(new Error('LEAVE_FAILED')); on.kill() }
      } finally { sub.leaving = null }
    })()
    return sub.leaving
  }
  const isWaitingOnApproval = sub => sub !== undefined && sub.watch !== null && (sub.watch.timer !== null || sub.watch.isOverdue || sub.watch.checking !== null)
  // An approval that is no longer waited on takes its passed limit with it: the next wait is timed anew.
  const stopWaiting = sub => {
    if (sub.watch === null) return
    sub.watch.isOverdue = false
    if (sub.watch.timer !== null) { clearTimeout(sub.watch.timer); sub.watch.timer = null }
  }
  const endWatch = sub => { stopWaiting(sub); sub.watch = null }
  // A refused or unanswered interrupt leaves the turn waiting on an approval nobody answers: it is asked again on each tick while
  // that turn still runs (route() clears it when the turn ends), and reported once the tries are used up; the turn is then no
  // longer watched. A try that the lost connection took with it is not one of them: whether it reached the daemon is not known,
  // and the next connection asks again.
  const retryInterrupt = thread => {
    const sub = subs.get(thread), asked = sub?.interrupt ?? null
    if (asked === null) return Promise.resolve()
    if (asked.isAsking) return asked.inFlight ?? Promise.resolve()
    asked.tries += 1
    asked.isAsking = true
    asked.inFlight = ask('turn/interrupt', { threadId: thread, turnId: asked.turn }).then(async () => {
      if (sub.interrupt === asked) sub.interrupt = null
      if (sub.watch !== null && sub.watch === asked.watch) endWatch(sub)
      await leave(thread)
    }, async error => {
      asked.isAsking = false
      if (error?.message === 'OWNER_DISCONNECTED') { asked.tries -= 1; return }
      if (sub.interrupt !== asked || asked.tries < INTERRUPT_TRIES) return
      sub.interrupt = null
      if (sub.watch !== null && sub.watch === asked.watch) endWatch(sub)
      onError(new Error('INTERRUPT_FAILED'))
      await leave(thread)
    }).finally(() => { asked.inFlight = null })
    return asked.inFlight
  }
  // The board is told once what became of a message whose delivery outlived its board connection or timed out waiting
  // on an approval: `uncertain` (`APPROVAL_TIMEOUT`) or a late `acknowledged` (#1796). The delivery sends no receipt of
  // its own for it, so this is the only receipt after `accepted`. It goes through the board connection the receiver has
  // for the session now, the one the message came on or a later one: the board takes a message's receipt from any
  // connection of its session that is not contested. A receipt the board refuses because of the connection (contested, or let go)
  // or does not answer is kept for the next tick and the next connection, and says the same again. One it refuses because of the
  // message ends here, and so does one the board's own limit on an unanswered message has overtaken.
  const report = thread => {
    const sub = subs.get(thread), owed = sub?.owed ?? null, receiver = attached.get(thread)?.receiver
    if (owed === null) return Promise.resolve()
    if (owed.isAsking) return owed.inFlight ?? Promise.resolve()
    if (Date.now() - owed.at >= ackMs) { sub.owed = null; return Promise.resolve() }
    if (!receiver || receiver.isClosed() || receiver.isContested()) return Promise.resolve()
    owed.isAsking = true
    owed.inFlight = receiver.receipt(owed.message, owed.status, owed.reply, owed.error).then(() => { if (sub.owed === owed) sub.owed = null }, error => {
      owed.isAsking = false
      if (sub.owed === owed && SETTLED.has(error?.message)) sub.owed = null
    }).finally(() => { owed.inFlight = null })
    return owed.inFlight
  }
  const queueOwed = (thread, message, status, { reply, error } = {}) => {
    subOf(thread).owed = { message, status, ...(reply === undefined ? {} : { reply }), ...(error === undefined ? {} : { error }), at: Date.now(), isAsking: false, inFlight: null }
  }
  const settleWatchedAck = (thread, sub, watch) => {
    if (watch === null || watch.message === null || watch.turn === null) return false
    if (watch.ended.get(watch.turn) !== 'completed') return false
    const line = watch.acked.get(watch.turn)
    if (line === undefined) return false
    queueOwed(thread, watch.message, 'acknowledged', { reply: line })
    watch.message = null
    void report(thread)
    return true
  }
  // Which turn a watch is for, when no answer to turn/start said: the thread's newest turn, asked for with its first user message
  // (`thread/turns/list` gives the newest turn first, and its summary of a turn carries that message). A turn that began with this
  // delivery's message is its own. One that began with someone else's is not, and the watch ends: a person's turn is never
  // stopped. One whose summary carries no user message is not shown to be the delivery's (the summary has a turn's first user
  // message whenever the turn has one, and the delivery's turn begins with its message): it names nothing, is never stopped, and
  // the next look asks again. A newest turn that is over names nothing.
  const nameTurn = (thread, watch) => {
    if (watch.naming !== null) return watch.naming
    const sub = subs.get(thread), on = daemon
    const run = (async () => {
      try {
        const turns = (await ask('thread/turns/list', { threadId: thread, limit: 1 }))?.data
        if (daemon !== on || sub?.watch !== watch || watch.turn !== null) return
        const last = Array.isArray(turns) ? turns[0] : undefined
        if (typeof last?.id !== 'string' || OVER.has(last.status)) return
        const first = Array.isArray(last.items) ? last.items.find(item => item?.type === 'userMessage') : undefined
        if (first === undefined) return
        if (isOwnInput(first, watch)) watch.turn = last.id
        else endWatch(sub)
      } catch { /* Asked again at the next look. */ } finally { if (watch.naming === run) watch.naming = null }
    })()
    watch.naming = run
    return run
  }
  // A delivered turn that waits on an approval may have nobody to answer it (the person quit less than one unload delay ago, or
  // set that delay for the thread in a way the receiver cannot see). After the limit the turn is interrupted and its message
  // settles as uncertain: it was delivered, and what became of it is not known. The timer belongs to the turn, not to the
  // delivery or its board connection. Outside the thread, no notice arrives, so the limit check waits for any naming in flight and
  // reads the thread's status again after the limit before stopping the turn. A limit that passed with no confirmation from a live
  // daemon waits overdue without restarting the timer: the turn is stopped as soon as a look confirms it still waits.
  const stopApprovalWatch = (thread, sub, watch, waitForReport = false) => {
    if (watch.checking !== null) return watch.checking
    const run = (async () => {
      stopWaiting(sub)
      while (!sub.mayBeSubscribed && daemon !== null && daemon.isOpen()) {
        const on = daemon
        if (watch.turn === null) {
          await nameTurn(thread, watch)
          if (sub.watch !== watch) return
          if (daemon !== on) continue
        }
        if (daemon === null || !daemon.isOpen()) break
        let seen
        try { seen = await read(thread) } catch {
          if (sub.watch !== watch) return
          if (daemon !== on) continue
          watch.isOverdue = true
          return
        }
        if (sub.watch !== watch) return
        if (daemon !== on) continue
        if (seen.status !== 'active') { endWatch(sub); return }
        if (!seen.isWaiting) return
        break
      }
      // The message settles first: the interrupt makes the turn end as interrupted, which would otherwise be what the card reads.
      // A delivery that already told the board how it ended (an unanswered start, say) has left no message here.
      if (watch.message !== null) {
        queueOwed(thread, watch.message, 'uncertain', { error: 'APPROVAL_TIMEOUT' })
        watch.message = null
        onError(new Error('APPROVAL_TIMEOUT'))
      }
      watch.finish?.()
      const reporting = report(thread)
      if (waitForReport) await reporting
      // The receiver stays in the thread until the interrupt is done, so it hears whether the turn is still running.
      // Outside the thread, naming already finished before the status read above, so never name after reading without a fresh read.
      if (sub.mayBeSubscribed && watch.turn === null && daemon !== null && daemon.isOpen()) await nameTurn(thread, watch)
      if (sub.watch !== watch) return
      if (sub.interrupt === null) {
        // Only a turn shown to be the delivery's is asked to stop: the start's answer named it, or its first user message was the
        // delivery's, heard or read (`nameTurn`). One whose start was heard and no more may be a person's.
        const turn = watch.turn
        // With no live daemon (or no turn named), wait overdue for the next connection rather than stopping blindly.
        if (daemon === null || !daemon.isOpen()) { watch.isOverdue = true; return }
        if (turn === null) {
          endWatch(sub); onError(new Error('INTERRUPT_FAILED'))
          return
        }
        sub.interrupt = { turn, tries: 0, isAsking: false, inFlight: null, watch }
      }
      await retryInterrupt(thread)
    })().finally(() => { if (watch.checking === run) watch.checking = null })
    watch.checking = run
    return run
  }
  const waitOnApproval = thread => {
    const sub = subs.get(thread), watch = sub?.watch ?? null
    if (watch === null || watch.checking !== null) return
    const isDue = watch.isOverdue && watch.turn !== null
    if (watch.timer !== null) {
      if (!isDue) return
      clearTimeout(watch.timer)
    }
    watch.timer = setTimeout(() => {
      watch.timer = null
      if (sub.watch !== watch) return
      void stopApprovalWatch(thread, sub, watch, false)
    }, isDue ? 0 : approvalMs)
    watch.timer.unref?.()
  }
  // What became of a turn this receiver started, read from the thread's own status when notices cannot tell. Out of the thread
  // (the connection it joined on is gone) no notice arrives: a thread that is not listed, or reads anything but active, has no
  // running turn; one that still runs is asked to stop again when it was being asked, and otherwise its wait on an approval is
  // timed as before. In the thread, notices tell of a turn that is known; a watch whose turn no answer named (the start got no
  // answer, or an odd one) is looked at here on each tick, until its turn is named, or is someone else's, or the thread has none.
  const checkTurn = async (thread, isLoaded) => {
    const sub = subs.get(thread)
    if (!sub || sub.isChecking || sub.isInUse) return
    const watch = sub.watch, asked = sub.interrupt, on = daemon, isInside = sub.mayBeSubscribed
    if (isInside ? watch === null || watch.turn !== null : (watch === null || watch.checking !== null) && asked === null) return
    const end = () => { if (sub.watch === watch && watch !== null) endWatch(sub); if (sub.interrupt === asked) sub.interrupt = null }
    if (!isLoaded) { end(); return }
    sub.isChecking = true
    try {
      const seen = await read(thread)
      if (daemon !== on || sub.isInUse || sub.mayBeSubscribed !== isInside) return
      if (seen.status !== 'active') { end(); return }
      if (sub.interrupt !== null) { if (!isInside) retryInterrupt(thread); return }
      if (sub.watch !== watch || watch === null) return
      if (watch.turn === null) {
        await nameTurn(thread, watch)
        if (daemon !== on || sub.watch !== watch) return
        // From outside, this look does not act on the read above for a turn it has just named (the approval may have been answered
        // while the lookup was out); the next look reads again and acts. A timer that was already running keeps its start time; if it
        // fires before the next look, stopApprovalWatch reads the status again after the limit (#1502).
        if (watch.turn !== null && !isInside) return
      }
      if (seen.isWaiting) waitOnApproval(thread)
      else if (!isInside) stopWaiting(sub)
    } catch { /* Asked again on the next tick. */ } finally { sub.isChecking = false }
  }

  const route = value => {
    const p = value.params
    if (typeof p?.threadId !== 'string') return
    const thread = p.threadId, sub = subs.get(thread), one = attached.get(thread)
    if (value.method === 'thread/closed') {
      listing.set.delete(thread)
      holds.delete(thread)
      closes.set(thread, (closes.get(thread) ?? 0) + 1)
      restart(thread)
      // An unloaded thread has no turn left to stop. Whether this connection is still subscribed is asked, not assumed (the tick's leave).
      if (sub) { sub.interrupt = null; endWatch(sub) }
      // The daemon unloaded the thread: it is dropped at once, not on the next tick.
      if (one) void drop(thread)
      return
    }
    // A turn, or a status that is not idle, heard of a thread: it was not quiet.
    if (value.method === 'turn/started' || value.method === 'turn/completed' || value.method === 'thread/status/changed' && p.status?.type !== 'idle') restart(thread)
    if (value.method === 'turn/completed' && sub && sub.interrupt !== null && sub.interrupt.turn === p.turn?.id) sub.interrupt = null
    // The watched turn is followed here, whether its delivery still runs and a board connection is still there for the thread or
    // not: whose turn it is, its wait on an approval, and its end.
    if (sub && sub.watch !== null) {
      const watch = sub.watch
      if (value.method === 'thread/status/changed' && typeof p.status?.type === 'string') {
        if (Array.isArray(p.status.activeFlags) && p.status.activeFlags.includes('waitingOnApproval')) waitOnApproval(thread)
        else stopWaiting(sub)
      }
      else if (typeof value.method === 'string' && value.method.endsWith('/requestApproval')) waitOnApproval(thread)
      else if (value.method === 'serverRequest/resolved') stopWaiting(sub)
      else if (value.method === 'turn/started' && p.turn?.id) {
        watch.begun.add(p.turn.id)
        if (watch.turn === null) watch.heard = p.turn.id
      }
      else if ((value.method === 'item/started' || value.method === 'item/completed') && p.item?.type === 'userMessage' && typeof p.turnId === 'string') {
        // A turn's first user message says whose it is. The delivery's own makes the turn known, before turn/start is answered
        // and also if it never is. Someone else's ends the watch of that turn; while the delivery still waits for the answer to
        // turn/start it is left to say so itself (TURN_JOINED).
        if (!watch.firstInput.has(p.turnId)) {
          const isOwn = isOwnInput(p.item, watch)
          watch.firstInput.set(p.turnId, isOwn)
          if (isOwn) { if (watch.turn === null) watch.turn = p.turnId }
          else if (watch.turn === p.turnId || watch.turn === null && watch.finish === null && watch.heard === p.turnId) endWatch(sub)
        }
      }
      else if (value.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.turnId === 'string') {
        const line = ackLine(String(p.item.text ?? ''), watch.nonce)
        if (line !== null) watch.acked.set(p.turnId, line)
      }
      else if (value.method === 'turn/completed' && p.turn?.id) {
        stopWaiting(sub)
        // Kept on the watch itself: a turn can end before turn/start has named it.
        watch.ended.set(p.turn.id, typeof p.turn.status === 'string' ? p.turn.status : '')
        const wasHeard = watch.heard === p.turn.id
        if (wasHeard) watch.heard = null
        // A watch whose delivery already ended or whose board connection dropped/contested mid-turn carries a completed ACK
        // forward via `sub.owed` so the card updates once the receiver reconnects (#1796).
        if (watch.finish === null || !one || !one.receiver || one.receiver.isClosed() || one.receiver.isContested()) {
          settleWatchedAck(thread, sub, watch)
        }
        // The watch ends with its turn, and the tick's leave follows. So does one whose delivery is over and whose only
        // possible turn, heard to start and never named, has ended.
        if (watch.turn === p.turn.id || watch.turn === null && watch.finish === null && wasHeard) {
          endWatch(sub)
          if (!sub.isInUse) void leave(thread)
        }
      }
    }
    if (!one) return
    const state = one.state
    // Whatever the thread reports can end a held claim's wait.
    one.wake()
    if (value.method === 'thread/status/changed' && typeof p.status?.type === 'string') { state.status = p.status.type; state.statusEvents += 1 }
    else if (value.method === 'turn/started' && p.turn?.id) { state.turn = p.turn.id; state.pending?.begun.add(p.turn.id) }
    else if (value.method === 'turn/completed' && p.turn?.id) {
      if (state.turn === p.turn.id) state.turn = null
      if (state.pending) { state.pending.ended.set(p.turn.id, typeof p.turn.status === 'string' ? p.turn.status : ''); one.settle() }
    } else if (value.method === 'item/completed' && p.item?.type === 'agentMessage' && state.pending) {
      const line = ackLine(String(p.item.text ?? ''), state.pending.nonce)
      if (line !== null) { state.pending.acked.set(p.turnId, line); one.settle() }
    } else if ((value.method === 'item/started' || value.method === 'item/completed') && p.item?.type === 'userMessage' && state.pending && typeof p.turnId === 'string') {
      // A turn's first user message says who started it: this delivery (the daemon echoes the claim nonce as `clientId`,
      // docs/validation/2026-11-06-send-to-codex.md), or someone else, whose turn the delivery then joined.
      if (!state.pending.firstInput.has(p.turnId)) { state.pending.firstInput.set(p.turnId, isOwnInput(p.item, state.pending)); one.settle() }
    }
  }

  // A lost connection has left every thread it was in (the daemon drops its subscriptions), whether the board connection for the
  // thread is still there or not. Nothing seen through it is kept: the next connection sees every thread for the first time.
  // A turn this receiver started, or may have started, runs on in the daemon all the same: its watch and its interrupt are kept,
  // and the next connection looks at the thread, names the turn if no answer did, and asks again (`checkTurn`).
  const lost = () => {
    daemon = null
    listing = { set: new Set(), sentAt: 0 }
    quiet.clear()
    hasConfigFailed = false
    hasClientsFailed = false
    holds.clear()
    for (const sub of subs.values()) { sub.mayBeSubscribed = false; sub.hasLeaveFailed = false; sub.leaveFails = 0; if (sub.interrupt !== null) sub.interrupt.isAsking = false }
  }
  // close() waits for a connection still being made, and one that is made after close() began is ended at once (#1632).
  const connect = () => connecting ??= (async () => {
    let made
    try {
      // Only the connection in use ends what the receiver knows: an older one that closes late says nothing about the new one.
      made = await connectDaemon({ executable, socket, env, onMessage: route, onClose: () => { if (daemon === null || daemon === made) lost() } })
      if (isClosed) { await made.close(); throw new Error('RECEIVER_CLOSED') }
      daemon = made
      canTell = hasUnloadDelay(daemon.info)
      failures = 0
    } finally { connecting = null }
  })()

  // ended: the board read the session as ended. Any other loss (the daemon went, a contest) is no sign of that, so the
  // board keeps what was queued for this connection and hands it to the next one (#318). Only the board connection ends here:
  // what the daemon connection has in the thread stays in `subs`, and the tick goes on asking its interrupt and its leave.
  const drop = async (thread, ended = false) => {
    const one = attached.get(thread)
    if (!one) return
    attached.delete(thread)
    one.state.pending?.reject(new Error('OWNER_DISCONNECTED'))
    await one.receiver?.close({ ended }).catch(() => undefined)
    // A claim held for this thread stops waiting once the board has the disconnect, and so sends no receipt of its own.
    one.wake()
  }

  const attach = async thread => {
    const state = { status: 'unknown', turn: null, pending: null, statusEvents: 0 }
    const waiters = new Set()
    const sub = subOf(thread)
    // deliveries: claims being handled now.
    const one = { state, receiver: null, isLost: false, deliveries: 0, settle: () => undefined, wake: () => { for (const done of [...waiters]) done() } }
    attached.set(thread, one)
    // The delivery turn settles when its own turn has ended: an ACK seen in another turn, or none, or a
    // turn that failed after its ACK never reads as a receipt. A turn may end before turn/start answers,
    // so ended turns are kept by id.
    one.settle = () => {
      const pending = state.pending
      if (!pending?.turn) return
      // The answer named a turn that began with someone else's message, heard after the answer (#1370).
      if (pending.firstInput.get(pending.turn) === false) { pending.reject(new Error('TURN_JOINED')); return }
      if (!pending.ended.has(pending.turn)) return
      const line = pending.acked.get(pending.turn)
      if (line === undefined) pending.reject(new Error('ACK_MISSING'))
      else {
        // Only an explicit `completed` is a success; a status that is missing or unknown proves nothing.
        const status = pending.ended.get(pending.turn)
        if (status === 'completed') pending.done(line)
        else if (status === 'failed' || status === 'interrupted') pending.reject(new Error('TURN_NOT_COMPLETED'))
        else pending.reject(new Error('TURN_STATUS_UNKNOWN'))
      }
    }
    // Reads the thread's status from inside it, right before a turn is started. A status notice that came while the answer was on
    // its way is at least as new as the answer, which can reach this code after notices that followed it in the same read.
    // Otherwise the read is newer than anything heard before it: an idle thread with no delivery of its own has no running turn,
    // even one whose end this connection did not hear.
    const readStatus = async () => {
      const statusEvents = state.statusEvents
      const { status } = await read(thread)
      if (state.statusEvents === statusEvents && !state.pending) {
        state.status = status
        if (status === 'idle') state.turn = null
      }
      return status
    }
    const isIdle = () => !state.pending && state.turn === null && state.status === 'idle'
    // Until the thread reports something, or one tick has passed (a notice that never came must not stall a claim).
    const nextEvent = () => new Promise(done => {
      const timer = setTimeout(() => finish(), tickMs)
      const finish = () => { clearTimeout(timer); waiters.delete(finish); done() }
      timer.unref?.()
      waiters.add(finish)
    })
    // Whether this thread's connection is still this one's to deliver on.
    // The board client's own close counts too: it closes on a poll error that is not retryable or a lapsed lease, and the board then
    // settles the claim as disconnected, so a read that answers after that starts nothing.
    const isHeld = () => attached.get(thread) === one && !one.isLost && !isClosed && daemon !== null && one.receiver?.isClosed() !== true
    try {
      // A thread whose status cannot be read gets no board connection.
      await read(thread)
      const verify = async () => {
        let isLoaded = false
        try { isLoaded = daemon !== null && daemon.isOpen() && (await list()).has(thread) } catch { isLoaded = false }
        if (!isLoaded) one.isLost = true
        return isLoaded
      }
      one.receiver = await client.attach({
        agent: 'codex', session: thread, scope: 'session', turn: 'session', surface: SURFACE, unclaimed: true, marksStart: true, pollMs, verify, onError,
        // Nobody attached, or busy, is not a refusal: the lease stays alive and the message waits in the board, unclaimed.
        canReceive: async () => !state.pending && one.deliveries === 0 && !sub.isInUse && await isReady(thread),
        deliver: async (message, accepted, begin, unsent, starting) => {
          // The claim is held until a person has the thread open and it reads idle: a turn that began after the board's poll, or
          // one this connection has not heard of yet (the thread is read fresh right before the start), keeps the message waiting
          // here, or goes back to the board's queue (below). A connection that is lost meanwhile, or a wait past the board's limit, ends this with no
          // receipt: the board settles a claim it lost the connection of (`uncertain`, `DISCONNECTED`) or expired itself.
          // Measured from the board's own claim time, which is what it expires from, so nothing starts for a claim the card already shows as expired.
          const waitsSince = Number.isFinite(message.claimed) && message.claimed > 0 ? message.claimed : Date.now()
          const isDone = () => !isHeld() || Date.now() - waitsSince >= ackMs
          // A claim that waits (the thread was busy, or a join was refused or got no answer, and each starts the wait again) goes back
          // to the board's queue, text and all, once too little of its time is left for a whole wait and two ticks: nothing was asked
          // of Codex for it, since turn/start comes only after this loop. The board then hands it out again when the thread reads as a
          // person's, with its own 30 minutes. Without this the claim ran out and the board dropped its text (#1578). An answer that says
          // the board saved nothing (it refused the give-back, as an older board does, or its store was busy) leaves the claim this
          // delivery's: it goes on waiting, and starts the message if the thread reads as a person's in time. A refused give-back is
          // not asked again. A busy store is asked again a tick later, while the claim still waits, so a claim held through a long busy
          // turn still goes back before it runs out (#1625; the owner's choice, 2026-11-16, over "receipts are never retried": the store
          // saved nothing, so the give-back is asked for the first time again, not a second time). A give-back whose answer is not
          // known (none came, or any other error answer) may have put the message back in the queue, so this delivery ends with no
          // turn/start and never asks again: the board hands the message out again if it took the give-back, and expires the claim if
          // it did not.
          let canGiveBack = typeof unsent === 'function', giveBackAt = 0, wasBusy = false
          const isShort = () => ackMs - (Date.now() - waitsSince) < (holdOf(thread) === null ? 0 : Math.max(unloadMs, (quiet.get(thread)?.delay ?? 0) + unloadMarginMs)) + 2 * tickMs
          // 'back': the board took it; 'held': the board saved nothing, so the claim is still this delivery's; 'unknown': either may be so.
          const giveBack = async () => {
            if (!canGiveBack || Date.now() < giveBackAt) return 'held'
            try { await unsent(); return 'back' } catch (error) {
              // A store that stays busy is reported once, not on every tick it is asked again.
              if (error?.isBusy !== true || !wasBusy) onError(error)
              if (error?.isRefused !== true) return 'unknown'
              if (error?.isBusy === true) { wasBusy = true; giveBackAt = Date.now() + tickMs } else canGiveBack = false
              return 'held'
            }
          }
          // Tells the board, right before turn/start, that this delivery is about to ask Codex for the message: until then a
          // connection that ends sends the claim back to the queue (#1507). 'said': the board took it; 'held': its store was busy
          // and saved nothing, so it is asked again after the next event, from inside the thread (below); 'end': any other answer,
          // or none. The board may have taken it or not, so, as for a give-back whose answer is not known, this delivery ends with
          // no turn/start and asks nothing again: a claim the board did not mark goes back when the connection ends, and one it
          // marked expires.
          let wasStartBusy = false
          const sayStarting = async () => {
            try { await starting(); return 'said' } catch (error) {
              if (error?.isBusy !== true || !wasStartBusy) onError(error)
              if (error?.isBusy === true) { wasStartBusy = true; return 'held' }
              return 'end'
            }
          }
          one.deliveries += 1
          // isMine: this delivery is the one in the thread, so only it gives the thread back.
          // hasNoTurn: no turn of this delivery runs, for certain (the daemon refused the start, the request never left, or the
          // text joined someone else's turn).
          let timer, isMine = false, watch = null, pending = null, hasNoTurn = false, isDecided = false, isKept = false
          const release = () => { if (isMine) { isMine = false; sub.isInUse = false } }
          // What becomes of the watch when the delivery ends, decided once, whichever way it ends: it is kept unless its turn is
          // known to be over or known not to be this delivery's. A watch that something else already ended (its turn's end was
          // heard, the thread was unloaded) is gone already.
          const keepWatch = () => {
            if (isDecided) return isKept
            isDecided = true
            if (watch === null || sub.watch !== watch) return false
            watch.finish = null
            const isOver = watch.turn !== null && watch.ended.has(watch.turn)
            const isOthers = watch.turn === null && watch.heard !== null && watch.firstInput.get(watch.heard) === false
            if (hasNoTurn || isOver || isOthers) endWatch(sub)
            else isKept = true
            return isKept
          }
          // The board's answer to `starting` holds for the whole claim: once it took the receipt, a busy read and a new join lead to
          // a fresh idle read and turn/start, with no second `starting`, whose answer, if lost, would end a claim the board has
          // already marked.
          let said = null, startingSince = 0, ids = null, settledAck = null, acking = null, finishAck = null
          try {
          try {
            // A message was claimed, so now the process list is read: is a Codex terminal window open? None: the claim goes back and
            // the thread is held off the short wait. Unreadable: it goes back too, and the message waits as it did before this check,
            // then goes with no check. A thread already on that wait reads no list (#1652).
            const decide = async () => {
              const found = await readClients('decide')
              if (found.kind === 'clients') { ids = found.ids; holds.delete(thread); return true }
              if (found.kind === 'none') holdNone(thread)
              else holds.set(thread, { kind: 'unreadable', until: null })
              return false
            }
            if (holdOf(thread) === null && !await decide() && await giveBack() !== 'held') return undefined
            for (;;) {
              for (;;) {
                if (isDone()) return undefined
                // A leave that was refused or got no answer is asked again while this claim waits: the receiver is still in the
                // thread for all it knows, and stays out of it until it can tell a person from its own subscription.
                if (sub.mayBeSubscribed) await leave(thread)
                else if (!sub.isInUse && await isReady(thread) && !isDone()) {
                  // On the 10-minute wait (a list that could not be read, or no window found), the message goes with no check, as
                  // before the check.
                  if (ids === null && holdOf(thread) !== null) break
                  // The short route needs a window found for this claim. The window the decision found must be the one there now,
                  // right before the join: the same process id and start time; a reused id is not that window. A claim with none
                  // found (it kept its claim when it gave back, and its hold ended while it waited) reads the list again here.
                  // Nothing was joined or asked of Codex, so a claim with no window goes back.
                  // The read may take seconds: a thread the daemon unloaded meanwhile (thread/closed) is not joined, which would load
                  // it again, even when it is listed again by then.
                  const closed = closes.get(thread) ?? 0
                  if (ids === null ? await decide() : await isWindowThere(ids, 'join')) {
                    if (isDone()) return undefined
                    if ((closes.get(thread) ?? 0) === closed && listing.set.has(thread)) break
                  }
                  if (ids !== null) { ids = null; holdNone(thread) }
                  if (await giveBack() !== 'held') return undefined
                }
                if (!isDone() && isShort() && await giveBack() !== 'held') return undefined
                await nextEvent()
              }
              // Joining a loaded thread subscribes this connection to its events without starting a turn. The join itself, and the
              // leave after it, start the daemon's delay again, so whatever was seen of the thread before no longer counts.
              sub.isInUse = true; isMine = true
              restart(thread)
              sub.joins += 1
              sub.mayBeSubscribed = true
              try {
                const statusEvents = state.statusEvents
                const resumed = await ask('thread/resume', { threadId: thread, excludeTurns: true })
                if (state.statusEvents === statusEvents) state.status = typeof resumed?.thread?.status?.type === 'string' ? resumed.thread.status.type : 'unknown'
              } catch (error) {
                release()
                if (error?.message === 'OWNER_DISCONNECTED') return undefined
                // A thread the daemon refuses (it has no saved history yet, or was just unloaded) is tried again once it can be,
                // and so is a join that got no answer. Either way only the daemon's answer to a leave says this connection is out.
                await leave(thread)
                if (error?.message !== 'OWNER_REJECTED' && error?.message !== 'OWNER_TIMEOUT') throw error
                await nextEvent()
                continue
              }
              // The thread is read before the starting receipt and again after the board's answer, so turn/start follows a fresh
              // read with no board request between them: a turn begun while the board was asked, whose notice has not come yet,
              // holds the claim as a busy read does (#1370). A busy store saved nothing, so the receiver stays in the thread and asks
              // again after the next event: leaving and joining again would start the daemon's delay, and with it a whole wait. A
              // claim that is done, or too short of time for that wait, leaves as a busy one does, so the wait above gives it back.
              let status, isWindowGone = false
              for (;;) {
                // A starting receipt that took more than a tick may have outlived the window: the list is read once more, before the
                // thread's last fresh read, so turn/start still follows that read with nothing asked between them (#1370). A turn the
                // person starts while the list is read shows in that read.
                if (said === 'said' && ids !== null && startingSince !== 0 && Date.now() - startingSince > tickMs) {
                  startingSince = 0
                  if (!await isWindowThere(ids, 'start')) { isWindowGone = true; break }
                }
                status = undefined
                try { status = await readStatus() } catch (error) {
                  // A read that got no answer started nothing either: it is asked again. A refused or odd answer is a refusal.
                  if (error?.message === 'OWNER_DISCONNECTED') return undefined
                  if (error?.message !== 'OWNER_TIMEOUT') throw error
                }
                if (status !== 'idle' || !isIdle() || isDone() || said === 'said') break
                if (startingSince === 0) startingSince = Date.now()
                said = await sayStarting()
                if (said === 'end') return undefined
                if (said === 'held') {
                  if (isDone() || isShort()) break
                  await nextEvent()
                }
              }
              if (!isWindowGone && said === 'said' && status === 'idle' && isIdle() && !isDone()) break
              if (isWindowGone) { ids = null; holdNone(thread) }
              // Busy: the receiver leaves again, so the thread is not kept loaded for a person who has gone.
              release()
              await leave(thread)
              if (isWindowGone && await giveBack() !== 'held') return undefined
              await nextEvent()
            }
            const answer = new Promise((done, reject) => {
              // begun: the turns whose start this connection heard while turn/start was out. firstInput: for each turn, whether
              // its first user message was this delivery.
              state.pending = { nonce: message.nonce, prompt: message.prompt, turn: null, begun: new Set(), firstInput: new Map(), acked: new Map(), ended: new Map(), done, reject }
              timer = setTimeout(() => reject(new Error('ACK_TIMEOUT')), ackMs)
              endWatch(sub)
              sub.watch = watch = { message: { id: message.id, nonce: message.nonce }, nonce: message.nonce, prompt: message.prompt, turn: null, heard: null, begun: new Set(), firstInput: new Map(), acked: new Map(), ended: new Map(), timer: null, isOverdue: false, naming: null, checking: null, finish: () => done(undefined) }
            })
            void answer.catch(() => undefined)
            const prompt = deliveryPrompt(message)
            // The daemon's own error answer (a refused request) is a refusal before anything was done: the message is rejected,
            // not uncertain. Anything else that goes wrong after the request left (no answer, a closed connection, an odd
            // answer) may have been delivered. The claim nonce is the message id Codex records.
            let result, begunBefore = new Set()
            pending = state.pending
            // The message goes now, so a hold for a list that could not be read ends with it: the next message reads the list again.
            if (holds.get(thread)?.kind === 'unreadable') holds.delete(thread)
            // A request that cannot leave (the connection is already gone) starts nothing, as one the daemon refuses.
            const canLeave = daemon !== null && daemon.isOpen()
            try { result = await ask('turn/start', { threadId: thread, input: input(prompt), clientUserMessageId: message.nonce }, 10_000, () => { begunBefore = new Set([...pending.begun, ...watch.begun]) }) } catch (error) {
              if (error?.message === 'OWNER_REJECTED' || !canLeave) hasNoTurn = true
              if (error?.message !== 'OWNER_REJECTED') begin()
              throw error
            }
            begin()
            if (!result?.turn?.id) throw new Error('INVALID_TURN_RESPONSE')
            // turn/start has no idle-only form: on a running turn it adds the text to that turn and answers with its id. A turn
            // whose start was heard before this answer arrived, or whose first user message is someone else's, was already
            // running, so the text joined it: uncertain, never an ordinary acceptance (#1370). A turn that began before the
            // answer but whose first user message is this delivery's is our own turn, not a joined one. When someone else's
            // message is heard only after the answer, settle() turns the acceptance into the same uncertain receipt.
            const firstOfTurn = pending.firstInput.get(result.turn.id) ?? watch.firstInput.get(result.turn.id)
            if (firstOfTurn === false || (begunBefore.has(result.turn.id) && firstOfTurn !== true)) { hasNoTurn = true; throw new Error('TURN_JOINED') }
            state.pending.turn = result.turn.id
            watch.turn = result.turn.id
            if (!state.pending.ended.has(result.turn.id)) state.turn = result.turn.id
            // The turn runs whether the board hears of it or not. A receipt the board refuses or does not answer (a contest, a
            // board that is away) is reported and does not end the delivery, which goes on waiting for the turn's end and its ACK.
            // None is sent once the board has been told that the turn was stopped (an approval limit shorter than this answer).
            if (watch.message !== null) await accepted().catch(onError)
            one.settle()
            const line = await answer
            if (typeof line === 'string' && line.trim() && watch.message !== null) {
              settledAck = { message: watch.message, line }
              watch.message = null
              acking = new Promise(done => { finishAck = done })
              sub.acking = acking
            }
          } catch (error) {
            // A delivery that its board connection or the daemon connection ended under a turn that is still watched sends no
            // receipt: the board settles the claim it lost the connection of, and the watch tells it if the turn has to be stopped
            // (`report`). Any other error is the delivery's own word on the message, and the watch then only stops the turn.
            if (error?.message === 'OWNER_DISCONNECTED' && watch !== null && !hasNoTurn) {
              settleWatchedAck(thread, sub, watch)
              keepWatch()
              return undefined
            }
            if (keepWatch()) {
              watch.message = null
            }
            throw error
          } finally {
            clearTimeout(timer); state.pending = null
            keepWatch()
            release()
            one.deliveries -= 1
            // On every way out (the turn ended, a refused start, a lost connection). A leave that must wait, for another delivery in
            // the thread, for an interrupt still asked of its turn or for a turn still watched, is the tick's.
            await leave(thread)
          }
          // Send the final ACK receipt only after `leave(thread)` completes (#318, #1796), falling back to `sub.owed` if disconnected or busy.
          if (settledAck !== null) {
            const { message: messageToAck, line } = settledAck
            if (!one.receiver || one.receiver.isClosed() || one.receiver.isContested()) {
              queueOwed(thread, messageToAck, 'acknowledged', { reply: line })
              if (attached.get(thread)?.receiver && attached.get(thread).receiver !== one.receiver) void report(thread)
              return undefined
            }
            try {
              await one.receiver.receipt(messageToAck, 'acknowledged', line)
            } catch (error) {
              if (!SETTLED.has(error?.message)) {
                queueOwed(thread, messageToAck, 'acknowledged', { reply: line })
                if (attached.get(thread)?.receiver && attached.get(thread).receiver !== one.receiver) void report(thread)
              }
              onError(error)
            }
          }
          return undefined
          } finally {
            if (acking !== null && sub.acking === acking) sub.acking = null
            finishAck?.()
          }
        },
      })
    } catch (error) { attached.delete(thread); throw error }
  }

  const tick = async () => {
    if (isTicking || isClosed) return
    isTicking = true
    try {
      // Whatever the board reads as: an interrupt that was refused or got no answer is asked again while its turn still runs, and
      // so is a leave, for every thread this connection may be in, attached or not. Not awaited: one with no answer would hold
      // every tick for its whole limit. A turn of a connection that is gone is looked at first, further down (checkTurn).
      if (daemon !== null && daemon.isOpen()) for (const [thread, sub] of [...subs]) { if (sub.mayBeSubscribed) retryInterrupt(thread); void leave(thread) }
      let wanted = []
      // A board that cannot be read for a moment (a writer replacing the file) keeps every receiver as it is: this tick does nothing more.
      try { wanted = [...new Set(threads())].filter(id => THREAD.test(id)) } catch (error) { onError(error); return }
      // The Codex program is not kept running for a board that knows no Codex session. Ending it leaves every thread. It is kept
      // while a turn this receiver started is still watched or asked to stop: nobody else would stop it.
      if (wanted.length === 0 && attached.size === 0 && ![...subs.values()].some(sub => sub.watch !== null || sub.interrupt !== null)) {
        if (daemon !== null) { const old = daemon; daemon = null; await old.close() }
        return
      }
      if (daemon !== null && !daemon.isOpen()) daemon = null
      if (daemon === null) {
        for (const thread of [...attached.keys()]) await drop(thread)
        if (Date.now() < retryAt) return
        // A daemon that cannot be reached is tried again later, waiting longer after each failure, up to RETRY_MAX_MS.
        const error = await connect().then(() => null, one => one)
        if (error !== null && isClosed) return
        if (error !== null) {
          failures += 1
          retryAt = Date.now() + Math.min(RETRY_MAX_MS, tickMs * 2 ** Math.min(failures, 5))
          onError(error)
          return
        }
      }
      let loaded
      try { loaded = await list() } catch (error) { onError(error); return }
      for (const [thread, one] of [...attached]) if (one.isLost || one.receiver?.isClosed() || one.receiver?.isContested() || !loaded.has(thread) || !wanted.includes(thread)) await drop(thread, !wanted.includes(thread))
      for (const thread of [...subs.keys()]) void checkTurn(thread, loaded.has(thread))
      // A thread whose session the board no longer knows gets no connection again: what was owed for it goes with the rest.
      for (const [thread, sub] of [...subs]) if (!wanted.includes(thread) && !attached.has(thread) && !sub.mayBeSubscribed && !sub.isInUse && sub.leaving === null && sub.interrupt === null && sub.watch === null && sub.acking === null) subs.delete(thread)
      for (const thread of wanted) {
        if (isClosed || attached.has(thread) || !loaded.has(thread)) continue
        // A thread this connection may still be in is not attached again until it is out: the card would offer a thread that only
        // the receiver's own subscription keeps loaded.
        const sub = subs.get(thread)
        if (sub && (sub.mayBeSubscribed || sub.isInUse)) continue
        // A session someone else holds (TARGET_CLAIMED) is tried again on a later tick: this receiver never contests it.
        try { await attach(thread) } catch (error) { if (error.message !== 'OWNER_REJECTED' && error.message !== 'TARGET_CLAIMED') onError(error) }
      }
      // What the board is still owed goes through the connection each thread has now, a new one included.
      for (const thread of [...subs.keys()]) report(thread)
      // One look at every thread the board knows and the daemon lists, attached or not, so the stretch is watched without a gap.
      await Promise.all(wanted.filter(thread => loaded.has(thread)).map(sample))
      for (const [thread, q] of [...quiet]) if (q.sampling === null && (!wanted.includes(thread) || !loaded.has(thread))) quiet.delete(thread)
    } finally { isTicking = false }
  }

  const timer = setInterval(() => { void tick() }, tickMs)
  timer.unref?.()
  void tick()
  return {
    // The Codex session ids this receiver is attached to now.
    attached: () => [...attached.keys()],
    // Active Codex deliveries (held claims, turn/start, or running turns) that are not waiting on an approval.
    sending: () => [...attached].filter(([thread, one]) =>
      (one.deliveries > 0 || one.receiver?.isSending?.() === true || subs.get(thread)?.isInUse === true)
      && !isWaitingOnApproval(subs.get(thread))).length,
    // Sync, for a process that is exiting: the Codex program is ended, so the daemon drops this connection.
    kill: () => { isClosed = true; clearInterval(timer); daemon?.kill() },
    close: () => closing ??= (async () => {
      isClosed = true
      clearInterval(timer)
      await connecting?.catch(() => undefined)
      for (const one of attached.values()) one.wake()
      await Promise.all([...subs.entries()].map(async ([thread, sub]) => {
        if (sub.watch !== null && !isWaitingOnApproval(sub) && !sub.mayBeSubscribed && daemon !== null && daemon.isOpen()) {
          await checkTurn(thread, true)
        }
        if (isWaitingOnApproval(sub)) await stopApprovalWatch(thread, sub, sub.watch, true)
        if (sub.interrupt !== null) await retryInterrupt(thread)
        if (sub.leaving !== null) await sub.leaving
        else if (sub.mayBeSubscribed) await leave(thread)
        if (sub.acking !== null) await sub.acking
        if (sub.owed !== null) await report(thread)
      }))
      for (const thread of [...attached.keys()]) await drop(thread)
      if (daemon !== null) { const old = daemon; daemon = null; await old.close() }
    })(),
  }
}

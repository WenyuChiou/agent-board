import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, posix, win32 } from 'node:path'
import { ackLine, boardClient, deliveryPrompt } from './message-client.mjs'
import { openWebSocketStdio } from './ws-stdio.mjs'

/** @type {import('./message-client.mjs').MessagingReceiverRecord} */
export const messagingReceiver = {
  host: 'Codex',
  agent: 'codex',
  kind: 'live',
  // The live run woke an idle Codex CLI session on the shared daemon; a message during a running turn is not recorded (#1409).
  surfaces: [{ name: 'Daemon', id: 'Codex daemon', evidence: 'docs/validation/2026-11-13-codex-cli-wake-live.md' }],
  routes: {
    idle: { line: 'now', record: 'docs/validation/2026-11-13-codex-cli-wake-live.md', surfaces: ['Codex daemon'] },
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
// receiver asks the daemon for it and never waits less than the default with its margin (UNLOAD_MS).
const UNLOAD_DEFAULT_SECS = 60
const UNLOAD_MARGIN_MS = 5000
const UNLOAD_MS = UNLOAD_DEFAULT_SECS * 1000 + UNLOAD_MARGIN_MS
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
const SETTLED = new Set(['MESSAGE_EXPIRED', 'MESSAGE_DISMISSED', 'RECEIPT_CONFLICT', 'TARGET_MISMATCH', 'CLAIM_REQUIRED', 'INVALID_RECEIPT', 'INVALID_TEXT', 'UNKNOWN_FIELD'])
const RETRY_MAX_MS = 30_000

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

const input = prompt => [{ type: 'text', text: prompt, text_elements: [] }]
// Whether a user message item is this delivery's own: its echoed claim nonce, or the exact text it was sent with.
const isOwnInput = (item, pending) => item.clientId === pending.nonce
  || Array.isArray(item.content) && item.content.some(part => part?.type === 'text' && part.text === pending.prompt)
// Takes a board message for each Codex thread that a person has open and the board knows, and starts one turn with it when the
// thread reads idle. The daemon tells nobody who is subscribed to a thread. It keeps a thread loaded while any client is subscribed
// to it or a turn runs, and unloads it 60 s after the later of "the last one left" and "the last turn ended". So a listed thread
// shows a person's client only when nothing else can have kept it loaded: the receiver counts a listing only if it was asked for
// one wait after the start of an unbroken stretch in which the receiver itself saw all three, that it held no subscription to
// the thread, that every status it read was idle, and that every listing showed the thread (`quiet`, `sample`). The wait is the
// unload delay the daemon's config gives the thread's folder, with a margin, and never less than unloadMs; a delay that cannot be
// read is not guessed. Whatever the receiver did not see starts the stretch again, and until one is complete the answer is
// "nobody": the message stays queued. So the first message to a thread waits one wait after the receiver first sees it, and so
// does each message after a delivery. The
// receiver stays out of the thread while it waits: it joins to deliver one message and leaves when the turn ends. A claim that
// meets a busy thread or nobody attached is held here, never given back (the board's claim is the only change of owner), and the
// board's own 30-minute limit on an unanswered message covers it. `threads()` gives the Codex session ids the board knows, and
// throws when it cannot tell. Nothing is started for a thread the daemon has not loaded, nothing goes through Codex's queue,
// and a running turn is never steered (#1409).
export const startCodexReceiver = ({
  boardUrl, threads, executable, socket, env = process.env,
  tickMs = TICK_MS, ackMs = ACK_LIMIT_MS, approvalMs = APPROVAL_LIMIT_MS, unloadMs = UNLOAD_MS, unloadMarginMs = UNLOAD_MARGIN_MS, leaveMs = LEAVE_LIMIT_MS,
  // How often each board connection asks the board for messages; the tests ask more often.
  pollMs = 2000,
  // A clock that never goes back and is not the wall clock, which a person or a time sync can move.
  now = () => performance.now(), onError = () => undefined,
}) => {
  if (typeof threads !== 'function' || !isAbsolute(executable ?? '')) throw new Error('EXPLICIT_EXECUTABLE_REQUIRED')
  const client = boardClient(boardUrl)
  const attached = new Map()
  let daemon = null, isTicking = false, isClosed = false, failures = 0, retryAt = 0
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
  // turns heard to end; isOverdue, the approval limit passed with no turn named and no connection to the daemon; finish, which ends the delivery with no receipt of its own while it still runs.
  const subs = new Map()
  const subOf = thread => {
    if (!subs.has(thread)) subs.set(thread, { mayBeSubscribed: false, isInUse: false, joins: 0, leaving: null, hasLeaveFailed: false, leaveFails: 0, interrupt: null, watch: null, isChecking: false, owed: null })
    return subs.get(thread)
  }
  // What the receiver has seen of each thread from outside it. since: the start of the unbroken stretch described above, or null
  // when there is none yet. last: when the last look was answered. marker: the thread's `updatedAt` at that look. epoch: counts
  // the breaks, so a look asked before one cannot start a stretch after it. sampling: the look in flight. delay: the longest
  // unload delay the daemon's config gave for the thread's folder at any look, or null while none could be read. The daemon fixes
  // a thread's delay when it loads it, so a config that was changed to a shorter one since does not shorten the wait.
  const quiet = new Map()
  let hasConfigFailed = false
  const quietOf = thread => {
    if (!quiet.has(thread)) quiet.set(thread, { since: null, last: null, marker: undefined, epoch: 0, sampling: null, delay: null })
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
    return { status: found.status.type, marker: found.updatedAt, cwd: found.cwd, isWaiting: Array.isArray(found.status.activeFlags) && found.status.activeFlags.includes('waitingOnApproval') }
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
      if (q.last === null || sentAt - q.last > 2 * tickMs) restart(thread)
      // In the thread, or maybe in it, the receiver's own subscription keeps it loaded: nothing read now is about a person.
      if (subs.get(thread)?.mayBeSubscribed === true) { q.since = null; return }
      const epoch = q.epoch
      let seen = null, delay = null
      try { seen = await read(thread) } catch { /* A look that failed saw nothing. */ }
      if (seen?.status === 'idle') delay = await unloadDelay(seen.cwd)
      // The connection it was asked on is gone, and with it everything seen through it.
      if (daemon !== on || quiet.get(thread) !== q) return
      const at = now()
      // Asked in time and answered late: what the thread did meanwhile nobody saw, as when it is asked late.
      if (q.last !== null && at - q.last > 2 * tickMs) q.since = null
      q.last = at
      if (delay !== null) q.delay = Math.max(q.delay ?? 0, delay)
      const hasMarker = typeof seen?.marker === 'number' || typeof seen?.marker === 'string'
      if (seen?.status !== 'idle' || delay === null || !hasMarker || q.epoch !== epoch || subs.get(thread)?.mayBeSubscribed === true || !listing.set.has(thread)) { q.since = null; return }
      if (seen.marker !== q.marker) { q.marker = seen.marker; q.since = null }
      if (q.since === null) q.since = at
    })().finally(() => { q.sampling = null })
    return q.sampling
  }
  // A person's client is on the thread, or left it less than 60 s ago: the receiver is out of it, the stretch is unbroken up to
  // a look and a listing no older than two ticks, and that listing was asked for one wait after the stretch began. With no client
  // on it and no turn, the daemon would have unloaded the thread by then. Anything not known reads as nobody.
  const isPersonAttached = thread => {
    const q = quiet.get(thread), at = now()
    if (!canTell || q === undefined || q.since === null || q.last === null || q.delay === null || subs.get(thread)?.mayBeSubscribed === true || !listing.set.has(thread)) return false
    if (at - q.last > 2 * tickMs || at - listing.sentAt > 2 * tickMs) return false
    return listing.sentAt >= q.since + Math.max(unloadMs, q.delay + unloadMarginMs)
  }
  // Whether a message can go to the thread now, from a fresh look and a listing no older than two ticks.
  const isReady = async thread => {
    if (!canTell || subs.get(thread)?.mayBeSubscribed === true) return false
    await sample(thread)
    if (now() - listing.sentAt > 2 * tickMs) try { await list() } catch { return false }
    return isPersonAttached(thread)
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
    if (asked === null || asked.isAsking) return
    asked.tries += 1
    asked.isAsking = true
    void ask('turn/interrupt', { threadId: thread, turnId: asked.turn }).then(() => {
      if (sub.interrupt === asked) sub.interrupt = null
      if (sub.watch !== null && sub.watch === asked.watch) endWatch(sub)
    }, error => {
      asked.isAsking = false
      if (error?.message === 'OWNER_DISCONNECTED') { asked.tries -= 1; return }
      if (sub.interrupt !== asked || asked.tries < INTERRUPT_TRIES) return
      sub.interrupt = null
      if (sub.watch !== null && sub.watch === asked.watch) endWatch(sub)
      onError(new Error('INTERRUPT_FAILED'))
    })
  }
  // The board is told once what became of a message whose turn this receiver stopped: `uncertain`, with the reason. The delivery
  // sends no receipt of its own for it (it ends without one when the wait runs out, and it ended without one if its board or
  // daemon connection went first), so this is the only receipt after `accepted`. It goes through the board connection the
  // receiver has for the session now, the one the message came on or a later one: the board takes a message's receipt from any
  // connection of its session that is not contested. A receipt the board refuses because of the connection (contested, or let go)
  // or does not answer is kept for the next tick and the next connection, and says the same again. One it refuses because of the
  // message ends here, and so does one the board's own limit on an unanswered message has overtaken.
  const report = thread => {
    const sub = subs.get(thread), owed = sub?.owed ?? null, receiver = attached.get(thread)?.receiver
    if (owed === null || owed.isAsking) return
    if (Date.now() - owed.at >= ackMs) { sub.owed = null; return }
    if (!receiver || receiver.isClosed() || receiver.isContested()) return
    owed.isAsking = true
    receiver.receipt(owed.message, 'uncertain', undefined, owed.error).then(() => { if (sub.owed === owed) sub.owed = null }, error => {
      owed.isAsking = false
      if (sub.owed === owed && SETTLED.has(error?.message)) sub.owed = null
    })
  }
  // Which turn a watch is for, when no answer to turn/start said: the thread's newest turn, asked for with its first user message
  // (`thread/turns/list` gives the newest turn first, and its summary of a turn carries that message). A turn that began with this
  // delivery's message is its own. One that began with someone else's is not, and the watch ends: a person's turn is never
  // stopped. One whose summary carries no user message is not shown to be the delivery's (the summary has a turn's first user
  // message whenever the turn has one, and the delivery's turn begins with its message): it names nothing, is never stopped, and
  // the next look asks again. A newest turn that is over names nothing.
  const nameTurn = async (thread, watch) => {
    const sub = subs.get(thread), on = daemon
    try {
      const turns = (await ask('thread/turns/list', { threadId: thread, limit: 1 }))?.data
      if (daemon !== on || sub?.watch !== watch || watch.turn !== null) return
      const last = Array.isArray(turns) ? turns[0] : undefined
      if (typeof last?.id !== 'string' || OVER.has(last.status)) return
      const first = Array.isArray(last.items) ? last.items.find(item => item?.type === 'userMessage') : undefined
      if (first === undefined) return
      if (isOwnInput(first, watch)) watch.turn = last.id
      else endWatch(sub)
    } catch { /* Asked again at the next look. */ }
  }
  // A delivered turn that waits on an approval may have nobody to answer it (the person quit less than one unload delay ago, or
  // set that delay for the thread in a way the receiver cannot see). After the limit the turn is interrupted and its message
  // settles as uncertain: it was delivered, and what became of it is not known. The timer belongs to the turn, not to the
  // delivery or its board connection. A limit that passed while no turn was named and no connection was there to ask on is not
  // timed again: the turn is stopped as soon as a later connection has named it, also when a new wait was begun before it did.
  const waitOnApproval = thread => {
    const sub = subs.get(thread), watch = sub?.watch ?? null
    if (watch === null) return
    const isDue = watch.isOverdue && watch.turn !== null
    if (watch.timer !== null) {
      if (!isDue) return
      clearTimeout(watch.timer)
    }
    watch.timer = setTimeout(() => {
      watch.timer = null
      if (sub.watch !== watch) return
      watch.isOverdue = false
      // The message settles first: the interrupt makes the turn end as interrupted, which would otherwise be what the card reads.
      // A delivery that already told the board how it ended (an unanswered start, say) has left no message here.
      if (watch.message !== null) {
        sub.owed = { message: watch.message, error: 'APPROVAL_TIMEOUT', at: Date.now(), isAsking: false }
        watch.message = null
        onError(new Error('APPROVAL_TIMEOUT'))
      }
      watch.finish?.()
      report(thread)
      // The receiver stays in the thread until the interrupt is done, so it hears whether the turn is still running.
      const interrupt = () => {
        if (sub.watch !== watch || sub.interrupt !== null) return
        // Only a turn shown to be the delivery's is asked to stop: the start's answer named it, or its first user message was the
        // delivery's, heard or read (`nameTurn`). One whose start was heard and no more may be a person's.
        const turn = watch.turn
        // No turn can be named: there is nothing to ask the daemon to stop. With no connection to ask on, the watch waits for
        // the next one, overdue: a turn that one names as the delivery's is stopped then, and one it cannot name is timed again.
        if (turn === null) {
          if (daemon === null || !daemon.isOpen()) { watch.isOverdue = true; return }
          endWatch(sub); onError(new Error('INTERRUPT_FAILED'))
          return
        }
        sub.interrupt = { turn, tries: 0, isAsking: false, watch }
        retryInterrupt(thread)
      }
      if (watch.turn !== null) interrupt()
      else void nameTurn(thread, watch).then(interrupt)
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
    if (isInside ? watch === null || watch.turn !== null : watch === null && asked === null) return
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
      else if (value.method === 'turn/started' && p.turn?.id) { if (watch.turn === null) watch.heard = p.turn.id }
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
      else if (value.method === 'turn/completed' && p.turn?.id) {
        stopWaiting(sub)
        // Kept on the watch itself: a turn can end before turn/start has named it.
        watch.ended.add(p.turn.id)
        const wasHeard = watch.heard === p.turn.id
        if (wasHeard) watch.heard = null
        // The watch ends with its turn, and the tick's leave follows. So does one whose delivery is over and whose only
        // possible turn, heard to start and never named, has ended.
        if (watch.turn === p.turn.id || watch.turn === null && watch.finish === null && wasHeard) endWatch(sub)
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
    for (const sub of subs.values()) { sub.mayBeSubscribed = false; sub.hasLeaveFailed = false; sub.leaveFails = 0; if (sub.interrupt !== null) sub.interrupt.isAsking = false }
  }
  const connect = async () => {
    let made
    // Only the connection in use ends what the receiver knows: an older one that closes late says nothing about the new one.
    made = await connectDaemon({ executable, socket, env, onMessage: route, onClose: () => { if (daemon === null || daemon === made) lost() } })
    daemon = made
    canTell = hasUnloadDelay(daemon.info)
    failures = 0
  }

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
        agent: 'codex', session: thread, scope: 'session', turn: 'session', surface: SURFACE, unclaimed: true, pollMs, verify, onError,
        // Nobody attached, or busy, is not a refusal: the lease stays alive and the message waits in the board, unclaimed.
        canReceive: async () => !state.pending && one.deliveries === 0 && !sub.isInUse && await isReady(thread),
        deliver: async (message, accepted, begin) => {
          // The claim is held until a person has the thread open and it reads idle: a turn that began after the board's poll, or
          // one this connection has not heard of yet (the thread is read fresh right before the start), keeps the message waiting
          // here. Nothing is given back. A connection that is lost meanwhile, or a wait past the board's limit, ends this with no
          // receipt: the board settles a claim it lost the connection of (`uncertain`, `DISCONNECTED`) or expired itself.
          // Measured from the board's own claim time, which is what it expires from, so nothing starts for a claim the card already shows as expired.
          const waitsSince = Number.isFinite(message.claimed) && message.claimed > 0 ? message.claimed : Date.now()
          const isDone = () => !isHeld() || Date.now() - waitsSince >= ackMs
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
          try {
            for (;;) {
              for (;;) {
                if (isDone()) return undefined
                // A leave that was refused or got no answer is asked again while this claim waits: the receiver is still in the
                // thread for all it knows, and stays out of it until it can tell a person from its own subscription.
                if (sub.mayBeSubscribed) await leave(thread)
                else if (!sub.isInUse && await isReady(thread) && !isDone()) break
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
              let status
              try { status = await readStatus() } catch (error) {
                // A read that got no answer started nothing either: it is asked again. A refused or odd answer is a refusal.
                if (error?.message === 'OWNER_DISCONNECTED') return undefined
                if (error?.message !== 'OWNER_TIMEOUT') throw error
              }
              if (status === 'idle' && isIdle() && !isDone()) break
              // Busy: the receiver leaves again, so the thread is not kept loaded for a person who has gone.
              release()
              await leave(thread)
              await nextEvent()
            }
            const answer = new Promise((done, reject) => {
              // begun: the turns whose start this connection heard while turn/start was out. firstInput: for each turn, whether
              // its first user message was this delivery.
              state.pending = { nonce: message.nonce, prompt: message.prompt, turn: null, begun: new Set(), firstInput: new Map(), acked: new Map(), ended: new Map(), done, reject }
              timer = setTimeout(() => reject(new Error('ACK_TIMEOUT')), ackMs)
              endWatch(sub)
              sub.watch = watch = { message: { id: message.id, nonce: message.nonce }, nonce: message.nonce, prompt: message.prompt, turn: null, heard: null, firstInput: new Map(), ended: new Set(), timer: null, isOverdue: false, finish: () => done(undefined) }
            })
            void answer.catch(() => undefined)
            const prompt = deliveryPrompt(message)
            // The daemon's own error answer (a refused request) is a refusal before anything was done: the message is rejected,
            // not uncertain. Anything else that goes wrong after the request left (no answer, a closed connection, an odd
            // answer) may have been delivered. The claim nonce is the message id Codex records.
            let result, begunBefore = new Set()
            pending = state.pending
            // A request that cannot leave (the connection is already gone) starts nothing, as one the daemon refuses.
            const canLeave = daemon !== null && daemon.isOpen()
            try { result = await ask('turn/start', { threadId: thread, input: input(prompt), clientUserMessageId: message.nonce }, 10_000, () => { begunBefore = new Set(pending.begun) }) } catch (error) {
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
            if (pending.firstInput.get(result.turn.id) === false || (begunBefore.has(result.turn.id) && pending.firstInput.get(result.turn.id) !== true)) { hasNoTurn = true; throw new Error('TURN_JOINED') }
            state.pending.turn = result.turn.id
            watch.turn = result.turn.id
            if (!state.pending.ended.has(result.turn.id)) state.turn = result.turn.id
            // The turn runs whether the board hears of it or not. A receipt the board refuses or does not answer (a contest, a
            // board that is away) is reported and does not end the delivery, which goes on waiting for the turn's end and its ACK.
            // None is sent once the board has been told that the turn was stopped (an approval limit shorter than this answer).
            if (watch.message !== null) await accepted().catch(onError)
            one.settle()
            return await answer
          } catch (error) {
            // A delivery that its board connection or the daemon connection ended under a turn that is still watched sends no
            // receipt: the board settles the claim it lost the connection of, and the watch tells it if the turn has to be stopped
            // (`report`). Any other error is the delivery's own word on the message, and the watch then only stops the turn.
            if (keepWatch()) {
              if (error?.message === 'OWNER_DISCONNECTED') return undefined
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
      for (const [thread, sub] of [...subs]) if (!wanted.includes(thread) && !attached.has(thread) && !sub.mayBeSubscribed && !sub.isInUse && sub.leaving === null && sub.interrupt === null && sub.watch === null) subs.delete(thread)
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
    // Sync, for a process that is exiting: the Codex program is ended, so the daemon drops this connection.
    kill: () => { isClosed = true; clearInterval(timer); daemon?.kill() },
    close: async () => {
      isClosed = true
      clearInterval(timer)
      for (const thread of [...attached.keys()]) await drop(thread)
      if (daemon !== null) { const old = daemon; daemon = null; await old.close() }
    },
  }
}

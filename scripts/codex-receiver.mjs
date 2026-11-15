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
// The daemon's unload delay (60 s) plus a margin for the time a request and its answer take, and for two clocks that do not run alike.
const UNLOAD_MS = 65_000
// How long the answer to a leave is waited for, and how many leaves in a row may fail before the receiver ends its connection to
// the daemon: a connection that is gone is in no thread.
const LEAVE_LIMIT_MS = 5000
const LEAVE_TRIES = 3
// A turn left waiting on an approval is asked to stop this many times before the receiver reports that it could not.
const INTERRUPT_TRIES = 3
// The answers to thread/unsubscribe that say this connection is out of the thread.
const LEFT = new Set(['unsubscribed', 'notSubscribed', 'notLoaded'])
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

const input = prompt => [{ type: 'text', text: prompt, text_elements: [] }]
// Whether a user message item is this delivery's own: its echoed claim nonce, or the exact text it was sent with.
const isOwnInput = (item, pending) => item.clientId === pending.nonce
  || Array.isArray(item.content) && item.content.some(part => part?.type === 'text' && part.text === pending.prompt)
// Takes a board message for each Codex thread that a person has open and the board knows, and starts one turn with it when the
// thread reads idle. The daemon tells nobody who is subscribed to a thread. It keeps a thread loaded while any client is subscribed
// to it or a turn runs, and unloads it 60 s after the later of "the last one left" and "the last turn ended". So a listed thread
// shows a person's client only when nothing else can have kept it loaded: the receiver counts a listing only if it was asked for
// unloadMs after the start of an unbroken stretch in which the receiver itself saw all three, that it held no subscription to
// the thread, that every status it read was idle, and that every listing showed the thread (`quiet`, `sample`). Whatever it did
// not see starts the stretch again, and until one is complete the answer is "nobody": the message stays queued. So the first
// message to a thread waits one unloadMs after the receiver first sees it, and so does each message after a delivery. The
// receiver stays out of the thread while it waits: it joins to deliver one message and leaves when the turn ends. A claim that
// meets a busy thread or nobody attached is held here, never given back (the board's claim is the only change of owner), and the
// board's own 30-minute limit on an unanswered message covers it. `threads()` gives the Codex session ids the board knows, and
// throws when it cannot tell. Nothing is started for a thread the daemon has not loaded, nothing goes through Codex's queue,
// and a running turn is never steered (#1409).
export const startCodexReceiver = ({
  boardUrl, threads, executable, socket, env = process.env,
  tickMs = TICK_MS, ackMs = ACK_LIMIT_MS, approvalMs = APPROVAL_LIMIT_MS, unloadMs = UNLOAD_MS, leaveMs = LEAVE_LIMIT_MS,
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
  // being asked to stop.
  const subs = new Map()
  const subOf = thread => {
    if (!subs.has(thread)) subs.set(thread, { mayBeSubscribed: false, isInUse: false, joins: 0, leaving: null, hasLeaveFailed: false, leaveFails: 0, interrupt: null })
    return subs.get(thread)
  }
  // What the receiver has seen of each thread from outside it. since: the start of the unbroken stretch described above, or null
  // when there is none yet. last: when the last look was answered. marker: the thread's `updatedAt` at that look. epoch: counts
  // the breaks, so a look asked before one cannot start a stretch after it. sampling: the look in flight.
  const quiet = new Map()
  const quietOf = thread => {
    if (!quiet.has(thread)) quiet.set(thread, { since: null, last: null, marker: undefined, epoch: 0, sampling: null })
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
    return { status: found.status.type, marker: found.updatedAt }
  }
  // One look at a thread from outside it; one at a time, a second caller gets the look in flight. It starts a stretch only when it
  // reads idle, was asked after the last break, and this receiver is out of a thread the newest listing shows. The stretch starts
  // when the answer arrives, never earlier. A look that fails, gets no answer or reads anything but idle ends the stretch, and so
  // does one that comes more than two ticks after the last: a turn may have run and ended in between, which starts the daemon's
  // delay again with nobody there. A changed `updatedAt` is read the same way.
  const sample = thread => {
    const q = quietOf(thread)
    if (q.sampling !== null) return q.sampling
    q.sampling = (async () => {
      const on = daemon, sentAt = now()
      if (q.last === null || sentAt - q.last > 2 * tickMs) restart(thread)
      // In the thread, or maybe in it, the receiver's own subscription keeps it loaded: nothing read now is about a person.
      if (subs.get(thread)?.mayBeSubscribed === true) { q.since = null; return }
      const epoch = q.epoch
      let seen = null
      try { seen = await read(thread) } catch { /* A look that failed saw nothing. */ }
      // The connection it was asked on is gone, and with it everything seen through it.
      if (daemon !== on || quiet.get(thread) !== q) return
      const at = now()
      q.last = at
      if (seen?.status !== 'idle' || q.epoch !== epoch || subs.get(thread)?.mayBeSubscribed === true || !listing.set.has(thread)) { q.since = null; return }
      if (seen.marker !== q.marker) { q.marker = seen.marker; q.since = null }
      if (q.since === null) q.since = at
    })().finally(() => { q.sampling = null })
    return q.sampling
  }
  // A person's client is on the thread, or left it less than 60 s ago: the receiver is out of it, the stretch is unbroken up to
  // a look and a listing no older than two ticks, and that listing was asked for unloadMs after the stretch began. With no client
  // on it and no turn, the daemon would have unloaded the thread by then. Anything not known reads as nobody.
  const isPersonAttached = thread => {
    const q = quiet.get(thread), at = now()
    if (!canTell || q === undefined || q.since === null || q.last === null || subs.get(thread)?.mayBeSubscribed === true || !listing.set.has(thread)) return false
    if (at - q.last > 2 * tickMs || at - listing.sentAt > 2 * tickMs) return false
    return listing.sentAt >= q.since + unloadMs
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
    if (!sub.mayBeSubscribed || sub.isInUse || sub.interrupt !== null) return Promise.resolve()
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
  // A refused or unanswered interrupt leaves the turn waiting on an approval nobody answers: it is asked again on each tick while
  // that turn still runs (route() clears it when the turn ends), and reported once the tries are used up.
  const retryInterrupt = thread => {
    const sub = subs.get(thread), asked = sub?.interrupt ?? null
    if (asked === null || asked.isAsking) return
    asked.tries += 1
    asked.isAsking = true
    void ask('turn/interrupt', { threadId: thread, turnId: asked.turn }).then(() => { if (sub.interrupt === asked) sub.interrupt = null }, () => {
      asked.isAsking = false
      if (sub.interrupt !== asked || asked.tries < INTERRUPT_TRIES) return
      sub.interrupt = null
      onError(new Error('INTERRUPT_FAILED'))
    })
  }

  const route = value => {
    const p = value.params
    if (typeof p?.threadId !== 'string') return
    const thread = p.threadId, sub = subs.get(thread), one = attached.get(thread)
    if (value.method === 'thread/closed') {
      listing.set.delete(thread)
      restart(thread)
      // An unloaded thread has no turn left to stop. Whether this connection is still subscribed is asked, not assumed (the tick's leave).
      if (sub) sub.interrupt = null
      // The daemon unloaded the thread: it is dropped at once, not on the next tick.
      if (one) void drop(thread)
      return
    }
    // A turn, or a status that is not idle, heard of a thread: it was not quiet.
    if (value.method === 'turn/started' || value.method === 'turn/completed' || value.method === 'thread/status/changed' && p.status?.type !== 'idle') restart(thread)
    if (value.method === 'turn/completed' && sub && sub.interrupt !== null && sub.interrupt.turn === p.turn?.id) sub.interrupt = null
    if (!one) return
    const state = one.state
    // Whatever the thread reports can end a held claim's wait.
    one.wake()
    if (value.method === 'thread/status/changed' && typeof p.status?.type === 'string') {
      state.status = p.status.type; state.statusEvents += 1
      if (Array.isArray(p.status.activeFlags) && p.status.activeFlags.includes('waitingOnApproval')) one.waitOnApproval()
      else one.stopWaiting()
    }
    else if (typeof value.method === 'string' && value.method.endsWith('/requestApproval')) one.waitOnApproval()
    else if (value.method === 'serverRequest/resolved') one.stopWaiting()
    else if (value.method === 'turn/started' && p.turn?.id) { state.turn = p.turn.id; state.pending?.begun.add(p.turn.id) }
    else if (value.method === 'turn/completed' && p.turn?.id) {
      one.stopWaiting()
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
  const lost = () => {
    daemon = null
    listing = { set: new Set(), sentAt: 0 }
    quiet.clear()
    for (const sub of subs.values()) { sub.mayBeSubscribed = false; sub.hasLeaveFailed = false; sub.leaveFails = 0; sub.interrupt = null }
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
    const one = { state, receiver: null, isLost: false, deliveries: 0, settle: () => undefined, wake: () => { for (const done of [...waiters]) done() }, waitOnApproval: () => undefined, stopWaiting: () => undefined }
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
    // A delivered turn that waits on an approval may have nobody to answer it (the person quit within the last 60 s). After the limit
    // the turn is interrupted and the message settles as uncertain: it was delivered, and what became of it is not known.
    let approvalTimer = null
    one.stopWaiting = () => { clearTimeout(approvalTimer); approvalTimer = null }
    one.waitOnApproval = () => {
      const pending = state.pending
      if (approvalTimer !== null || !pending) return
      approvalTimer = setTimeout(() => {
        approvalTimer = null
        if (state.pending !== pending) return
        // The message settles first: the interrupt makes the turn end as interrupted, which would otherwise be what the card reads.
        const turn = pending.turn ?? state.turn
        pending.reject(new Error('APPROVAL_TIMEOUT'))
        // The receiver stays in the thread until the interrupt is done, so it hears whether the turn is still running.
        if (turn) { sub.interrupt = { turn, tries: 0, isAsking: false }; retryInterrupt(thread) }
      }, approvalMs)
      approvalTimer.unref?.()
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
        agent: 'codex', session: thread, scope: 'session', turn: 'session', surface: SURFACE, unclaimed: true, verify, onError,
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
          let timer, isMine = false
          const release = () => { if (isMine) { isMine = false; sub.isInUse = false } }
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
            })
            void answer.catch(() => undefined)
            const prompt = deliveryPrompt(message)
            // The daemon's own error answer (a refused request) is a refusal before anything was done: the message is rejected,
            // not uncertain. Anything else that goes wrong after the request left (no answer, a closed connection, an odd
            // answer) may have been delivered. The claim nonce is the message id Codex records.
            let result, begunBefore = new Set()
            const pending = state.pending
            try { result = await ask('turn/start', { threadId: thread, input: input(prompt), clientUserMessageId: message.nonce }, 10_000, () => { begunBefore = new Set(pending.begun) }) } catch (error) { if (error?.message !== 'OWNER_REJECTED') begin(); throw error }
            begin()
            if (!result?.turn?.id) throw new Error('INVALID_TURN_RESPONSE')
            // turn/start has no idle-only form: on a running turn it adds the text to that turn and answers with its id. A turn
            // whose start was heard before this answer arrived, or whose first user message is someone else's, was already
            // running, so the text joined it: uncertain, never an ordinary acceptance (#1370). A turn that began before the
            // answer but whose first user message is this delivery's is our own turn, not a joined one. When someone else's
            // message is heard only after the answer, settle() turns the acceptance into the same uncertain receipt.
            if (pending.firstInput.get(result.turn.id) === false || (begunBefore.has(result.turn.id) && pending.firstInput.get(result.turn.id) !== true)) throw new Error('TURN_JOINED')
            state.pending.turn = result.turn.id
            if (!state.pending.ended.has(result.turn.id)) state.turn = result.turn.id
            await accepted()
            one.settle()
            return await answer
          } finally {
            clearTimeout(timer); one.stopWaiting(); state.pending = null
            release()
            one.deliveries -= 1
            // On every way out (the turn ended, a refused start, a lost connection). A leave that must wait, for another delivery in
            // the thread or for an interrupt still asked of its turn, is the tick's.
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
      // every tick for its whole limit.
      if (daemon !== null && daemon.isOpen()) for (const thread of [...subs.keys()]) { retryInterrupt(thread); void leave(thread) }
      let wanted = []
      // A board that cannot be read for a moment (a writer replacing the file) keeps every receiver as it is: this tick does nothing more.
      try { wanted = [...new Set(threads())].filter(id => THREAD.test(id)) } catch (error) { onError(error); return }
      // The Codex program is not kept running for a board that knows no Codex session. Ending it leaves every thread.
      if (wanted.length === 0 && attached.size === 0) {
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
      for (const [thread, sub] of [...subs]) if (!wanted.includes(thread) && !attached.has(thread) && !sub.mayBeSubscribed && !sub.isInUse && sub.leaving === null && sub.interrupt === null) subs.delete(thread)
      for (const thread of wanted) {
        if (isClosed || attached.has(thread) || !loaded.has(thread)) continue
        // A thread this connection may still be in is not attached again until it is out: the card would offer a thread that only
        // the receiver's own subscription keeps loaded.
        const sub = subs.get(thread)
        if (sub && (sub.mayBeSubscribed || sub.isInUse)) continue
        // A session someone else holds (TARGET_CLAIMED) is tried again on a later tick: this receiver never contests it.
        try { await attach(thread) } catch (error) { if (error.message !== 'OWNER_REJECTED' && error.message !== 'TARGET_CLAIMED') onError(error) }
      }
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

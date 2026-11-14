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
// The daemon's unload delay (60 s) plus a margin for the time a request and its answer take.
const UNLOAD_MS = 65_000
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
// thread reads idle. The daemon keeps a thread loaded while any client is subscribed to it and unloads it 60 s after the later of
// "the last one left" and "the last turn ended", so a thread that is listed while this receiver is not subscribed has a person's
// client on it (isPersonAttached). This receiver's own leave and each turn end restart those 60 s too, so once it has been in a
// thread a listing counts only when it was asked for unloadMs after both: a second message to the same thread waits out that
// delay. The receiver stays out of the thread while it waits: it joins to deliver one message and leaves when the turn ends. A
// claim that meets a busy thread or nobody attached is held here, never given back (the board's claim is the only change of
// owner), and the board's own 30-minute limit on an unanswered message covers it. `threads()` gives the Codex session ids the
// board knows, and throws when it cannot tell. Nothing is started for a thread the daemon has not loaded, nothing goes
// through Codex's queue, and a running turn is never steered (#1409).
export const startCodexReceiver = ({
  boardUrl, threads, executable, socket, env = process.env,
  tickMs = TICK_MS, ackMs = ACK_LIMIT_MS, approvalMs = APPROVAL_LIMIT_MS, unloadMs = UNLOAD_MS, onError = () => undefined,
}) => {
  if (typeof threads !== 'function' || !isAbsolute(executable ?? '')) throw new Error('EXPLICIT_EXECUTABLE_REQUIRED')
  const client = boardClient(boardUrl)
  const attached = new Map()
  let daemon = null, isTicking = false, isClosed = false, failures = 0, retryAt = 0
  // The newest list of loaded threads, with the time its request was sent: a thread it shows was still loaded after that time.
  let listing = { set: new Set(), sentAt: 0 }, canTell = false
  // For each thread this receiver has been in, the later of its last confirmed leave and the last turn end it heard there. The
  // daemon keeps the thread loaded for 60 s after that whoever else is on it, so a listing sent sooner shows nothing about a
  // person. Kept when a thread is dropped and attached again, and when the connection is lost: the daemon's delay outlives both.
  const lastOut = new Map()
  const markOut = thread => lastOut.set(thread, Date.now())

  const ask = (method, params, limit, onAnswer) => daemon === null ? Promise.reject(new Error('OWNER_DISCONNECTED')) : daemon.request(method, params, limit, onAnswer)
  const list = async () => {
    const sentAt = Date.now()
    const set = await loadedThreads(daemon)
    if (sentAt >= listing.sentAt) listing = { set, sentAt }
    return set
  }
  // Loaded now, and not because of this receiver: some other client of the daemon is subscribed (or quit less than 60 s ago).
  // Before the receiver has been in the thread, any listing counts.
  const isPersonAttached = thread => {
    const one = attached.get(thread)
    if (!canTell || one === undefined || one.isJoined || !listing.set.has(thread)) return false
    const out = lastOut.get(thread)
    return out === undefined || listing.sentAt >= out + unloadMs
  }

  const route = value => {
    const p = value.params
    const one = typeof p?.threadId === 'string' ? attached.get(p.threadId) : undefined
    if (!one) return
    // The daemon unloaded the thread: it is dropped at once, not on the next tick.
    if (value.method === 'thread/closed') { listing.set.delete(p.threadId); void drop(p.threadId); return }
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
      // A turn that ends restarts the daemon's unload delay for the thread (the receiver hears it only while it is in the thread).
      if (one.isJoined) markOut(p.threadId)
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

  // A lost connection has left every thread it was in (the daemon drops its subscriptions), and the unload delay starts then.
  const lost = () => {
    daemon = null
    for (const [thread, one] of attached) if (one.isJoined) { one.isJoined = false; markOut(thread) }
  }
  const connect = async () => {
    daemon = await connectDaemon({ executable, socket, env, onMessage: route, onClose: lost })
    canTell = hasUnloadDelay(daemon.info)
    failures = 0
  }

  // ended: the board read the session as ended. Any other loss (the daemon went, a contest) is no sign of that, so the
  // board keeps what was queued for this connection and hands it to the next one (#318).
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
    // isJoined: this receiver is subscribed to the thread (only while it delivers), or may be: until a leave is confirmed.
    // isJoining: a delivery is joining and has not started its turn yet, so nothing else may leave. joins: counts the joins, so
    // the answer to a leave asked before a join changes nothing. leaving: the leave in flight. deliveries: claims being handled
    // now. interrupt: the turn an approval left waiting, still being asked to stop.
    const one = { state, receiver: null, isLost: false, isJoined: false, isJoining: false, joins: 0, leaving: null, hasLeaveFailed: false, interrupt: null, deliveries: 0, settle: () => undefined, wake: () => { for (const done of [...waiters]) done() }, waitOnApproval: () => undefined, stopWaiting: () => undefined, leave: async () => undefined, retryInterrupt: () => undefined }
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
        if (turn) { one.interrupt = { turn, tries: 0, isAsking: false }; one.retryInterrupt() }
      }, approvalMs)
      approvalTimer.unref?.()
    }
    // A refused or unanswered interrupt leaves the turn waiting on an approval nobody answers: it is asked again on each tick while
    // that turn still runs, and reported once the tries are used up.
    one.retryInterrupt = () => {
      const asked = one.interrupt
      if (asked === null || asked.isAsking) return
      if (state.turn !== asked.turn) { one.interrupt = null; return }
      asked.tries += 1
      asked.isAsking = true
      void ask('turn/interrupt', { threadId: thread, turnId: asked.turn }).then(() => { if (one.interrupt === asked) one.interrupt = null }, () => {
        asked.isAsking = false
        if (one.interrupt !== asked || asked.tries < INTERRUPT_TRIES) return
        one.interrupt = null
        if (state.turn === asked.turn) onError(new Error('INTERRUPT_FAILED'))
      })
    }
    // Reads the thread's status without joining it. A status notice that came while the answer was on its way is at least as new
    // as the answer, which can reach this code after notices that followed it in the same read. Otherwise the read is newer than
    // anything heard before it: an idle thread with no delivery of its own has no running turn, even one that ended while this
    // receiver was out of the thread and could not hear it end.
    const readStatus = async () => {
      const statusEvents = state.statusEvents
      const status = (await ask('thread/read', { threadId: thread, includeTurns: false }))?.thread?.status?.type
      if (typeof status !== 'string') throw new Error('INVALID_OWNER_RESPONSE')
      if (state.statusEvents === statusEvents && !state.pending) {
        state.status = status
        if (status === 'idle') state.turn = null
      }
      return status
    }
    // Leaves the thread so the daemon can unload it once nobody else is on it. One leave at a time: a second caller gets the one in
    // flight. Only a confirmed leave, or a lost connection (the daemon drops its subscriptions), marks the thread left. A refused,
    // odd or missing answer keeps it marked joined, so no claim reads this receiver's own subscription as a person; it is reported
    // once and asked again. The answer to a leave asked before a later join is about the old subscription and changes nothing.
    one.leave = () => {
      if (one.leaving !== null) return one.leaving
      if (!one.isJoined) return Promise.resolve()
      const joins = one.joins
      const markLeft = () => {
        if (one.joins !== joins) return
        one.isJoined = false
        one.hasLeaveFailed = false
        markOut(thread)
      }
      one.leaving = (async () => {
        try {
          const answer = await ask('thread/unsubscribe', { threadId: thread })
          if (!LEFT.has(answer?.status)) throw new Error('INVALID_OWNER_RESPONSE')
          markLeft()
        } catch (error) {
          if (error?.message === 'OWNER_DISCONNECTED') markLeft()
          else if (!one.hasLeaveFailed) { one.hasLeaveFailed = true; onError(error) }
        } finally { one.leaving = null }
      })()
      return one.leaving
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
      await readStatus()
      const verify = async () => {
        let isLoaded = false
        try { isLoaded = daemon !== null && daemon.isOpen() && (await list()).has(thread) } catch { isLoaded = false }
        if (!isLoaded) one.isLost = true
        return isLoaded
      }
      one.receiver = await client.attach({
        agent: 'codex', session: thread, scope: 'session', turn: 'session', surface: SURFACE, unclaimed: true, verify, onError,
        // Nobody attached, or busy, is not a refusal: the lease stays alive and the message waits in the board, unclaimed.
        // The status is read now: this receiver hears no notices from a thread it has not joined, and the read clears a turn it
        // last heard of while it was in the thread.
        canReceive: async () => !state.pending && one.deliveries === 0 && isPersonAttached(thread) && await readStatus() === 'idle' && state.turn === null,
        deliver: async (message, accepted, begin) => {
          // The claim is held until a person has the thread open and it reads idle: a turn that began after the board's poll, or
          // one this connection has not heard of yet (the thread is read fresh right before the start), keeps the message waiting
          // here. Nothing is given back. A connection that is lost meanwhile, or a wait past the board's limit, ends this with no
          // receipt: the board settles a claim it lost the connection of (`uncertain`, `DISCONNECTED`) or expired itself.
          // Measured from the board's own claim time, which is what it expires from, so nothing starts for a claim the card already shows as expired.
          const waitsSince = Number.isFinite(message.claimed) && message.claimed > 0 ? message.claimed : Date.now()
          const isDone = () => !isHeld() || Date.now() - waitsSince >= ackMs
          one.deliveries += 1
          let timer
          try {
            for (;;) {
              while (!isDone() && !isPersonAttached(thread)) {
                // A leave that was refused or got no answer is asked again while this claim waits: the receiver is still in the
                // thread for all it knows, and stays out of it until it can tell a person from its own subscription.
                if (one.isJoined && !state.pending) await one.leave()
                await nextEvent()
              }
              if (isDone()) return undefined
              // Joining a loaded thread subscribes this connection to its events without starting a turn. A thread the daemon
              // refuses (it has no saved history yet, or was just unloaded) is tried again once it can be.
              one.isJoining = true
              if (one.leaving !== null) await one.leaving
              const statusEvents = state.statusEvents
              one.joins += 1
              one.isJoined = true
              try {
                const resumed = await ask('thread/resume', { threadId: thread, excludeTurns: true })
                if (state.statusEvents === statusEvents) state.status = typeof resumed?.thread?.status?.type === 'string' ? resumed.thread.status.type : 'unknown'
              } catch (error) {
                one.isJoining = false
                // Refused: the daemon did not subscribe this connection, so there is nothing to leave.
                if (error?.message === 'OWNER_REJECTED') { one.isJoined = false; await nextEvent(); continue }
                if (error?.message === 'OWNER_DISCONNECTED') return undefined
                if (error?.message !== 'OWNER_TIMEOUT') throw error
                await one.leave(); await nextEvent()
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
              one.isJoining = false
              await one.leave()
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
            clearTimeout(timer); one.stopWaiting(); state.pending = null; one.isJoining = false
            one.deliveries -= 1
            // On every way out (the turn ended, a refused start, a lost connection), unless another claim is still being handled or
            // an interrupt still waits on the turn (the tick leaves once it is done).
            if (one.deliveries === 0 && one.interrupt === null) await one.leave()
          }
        },
      })
    } catch (error) { attached.delete(thread); throw error }
  }

  const tick = async () => {
    if (isTicking || isClosed) return
    isTicking = true
    try {
      let wanted = []
      // A board that cannot be read for a moment (a writer replacing the file) keeps every receiver as it is: this tick does nothing.
      try { wanted = [...new Set(threads())].filter(id => THREAD.test(id)) } catch (error) { onError(error); return }
      // The Codex program is not kept running for a board that knows no Codex session.
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
      // An interrupt that was refused or got no answer is asked again while its turn still runs.
      for (const one of attached.values()) one.retryInterrupt()
      // A leave that was refused or got no answer is asked again while no delivery is joining or running its turn, a held claim
      // included, and no interrupt still waits on a turn. Not awaited: one with no answer would hold every tick for its whole limit.
      for (const one of attached.values()) if (one.isJoined && !one.state.pending && !one.isJoining && one.interrupt === null) void one.leave()
      for (const thread of wanted) {
        if (isClosed || attached.has(thread) || !loaded.has(thread)) continue
        // A session someone else holds (TARGET_CLAIMED) is tried again on a later tick: this receiver never contests it.
        try { await attach(thread) } catch (error) { if (error.message !== 'OWNER_REJECTED' && error.message !== 'TARGET_CLAIMED') onError(error) }
      }
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

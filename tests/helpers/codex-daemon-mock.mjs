// A stand-in for `codex app-server proxy` in front of the shared daemon. It speaks WebSocket over stdio like the
// real proxy, answers the requests the Codex receiver makes, and writes everything it receives to a log.
// The script is read from CODEX_MOCK_CONFIG (a JSON file), because the receiver must run the proxy with exactly
// `app-server proxy`:
//   log        file that gets one JSON line per received message, and a first line for argv and environment
//   loaded     thread ids the daemon has loaded
//   status     'idle' | 'active': the thread's status when it is resumed
//   turn       the running turn's id when the thread is active
//   start      what turn/start does on an idle thread: 'ack' (answers, ACKs, completes), 'silent' (answers, nothing else),
//              'error' (an error answer), 'empty' (an answer with no turn), 'mute' (no answer at all), 'die' (the proxy exits once
//              the request is in), 'endFirst' (the turn's ACK and end go out before the answer, which comes last), 'ownFirst' (the turn starts, takes the delivery's own user message, ACKs and completes, all before the answer). On a running turn it answers with that turn's id
//              and starts nothing, as the real daemon does (the text joins the turn).
//   joinOnStart when true, the person's own turn starts just before the first turn/start is handled, so the call joins it
//   joinLate   like joinOnStart, but that turn's notices (its start, its first user message) go out only after the answer
//   readDelay  ms the answer to thread/read is held back (the thread's status is read when it is sent)
//   readFaults  a file: while it is there, thread/read gets an error answer, or no answer at all when the file holds 'mute'
//   resumeRace  when true, a turn begins as the first thread/resume arrives and ends right behind its answer, in the same write
//   readActive  when true, the person's own turn starts as thread/read is first asked by a connection that has joined the thread
//              (after a claim, the read right before turn/start): the answer says active, the notices follow
//   endStatus  the status the delivery turn ends with: 'completed' (default), 'failed', 'interrupted', 'none' (no status field) or any other word
//   approval   when true, the daemon asks its client for an approval during the turn
//   beginFlag  a file whose appearance starts the person's own turn ('turn-person') on an idle thread
//   endFlag    a file whose appearance ends the running turn
//   userAgent  what initialize says the daemon is (default: a version that unloads a thread 60 s after its last subscriber left)
//   person     file whose presence stands for a person's own client being open on the thread: without it, the thread is listed only
//              while this connection is subscribed to it (thread/resume until thread/unsubscribe) or a turn runs, and for unloadDelay
//              after the later of the last subscriber (this connection or the person) leaving and the last turn ending, as the real
//              daemon does; then thread/status/changed (notLoaded) and thread/closed go to the connection, subscribed or not.
//              A person who quits does not end their turn: it runs on until endFlag
//   state      file that carries the daemon's side over to the next proxy process (default: the log's name with '.state' added),
//              since the real daemon outlives a proxy: the running turn, the unload delay, and whether the connection was
//              subscribed. A proxy that ends leaves its thread at that moment; one that was killed outright is read as having
//              left when the next one starts
//   unloadDelay  ms the thread stays listed after that (the real daemon's 60 s; default 150)
//   closeFlag  a file whose appearance sends thread/closed for the loaded thread (the list still shows it)
//   ackDelay   ms before a delivery turn ends (default 50)
//   ackFlag    a file whose appearance lets the delivery turn ACK and end (in place of ackDelay)
//   approval   'hold': the delivery turn waits on an approval for ever, until turn/interrupt (turn/completed 'interrupted')
//   interrupt  'error': every turn/interrupt gets an error answer and the turn keeps waiting
//   interruptFlag  a file whose appearance answers the turn/interrupt requests held back until then and ends the turn interrupted
//   unsubscribeFaults  what the first thread/unsubscribe requests get, in order: 'error' (an error answer, still subscribed),
//              'mute' (no answer, still subscribed), 'odd' (an answer with no status, left), or a number of ms the answer is held
//              back (left when it is sent); the requests after them are answered at once
//   pidFile    file that gets this process's id
// thread/read tells the thread's true status to any connection, and its `updatedAt` moves with each turn's start and end (read in
// the daemon's source, where it is the saved thread's last update; not run live).
// Notices about a thread go only to a connection subscribed to it, as the real daemon sends them; thread/closed goes to every one.
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { serveWebSocketProxy, serverFrame } from './ws-proxy-mock.mjs'

const config = JSON.parse(readFileSync(process.env.CODEX_MOCK_CONFIG, 'utf8'))
const log = value => appendFileSync(config.log, JSON.stringify(value) + '\n')
if (config.pidFile) writeFileSync(config.pidFile, String(process.pid))
log({ argv: process.argv.slice(2), env: process.env })
const stateFile = config.state ?? config.log + '.state'
const carried = (() => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null } })()
let running = carried ? carried.running : config.status === 'active' ? config.turn : null
let emitNow, hasRaced = false, isSubscribed = false, hadPerson = carried?.hadPerson ?? false, unloadAt = carried?.unloadAt ?? 0, isUnloaded = carried?.isUnloaded ?? false
// Stands for the time of the saved thread's last update.
let stamp = carried?.stamp ?? 1
let written = ''
const save = () => {
  const text = JSON.stringify({ running, hadPerson, unloadAt, isUnloaded, isSubscribed, stamp })
  if (text === written) return
  written = text
  writeFileSync(stateFile, text)
}
// The turn/interrupt requests held back until interruptFlag appears.
const interrupts = []
const unsubscribeFaults = [...(config.unsubscribeFaults ?? [])]
const unloadDelay = config.unloadDelay ?? 150
// The daemon's unload delay starts again whenever a subscriber leaves or a turn ends.
const restartUnload = () => { unloadAt = Math.max(unloadAt, Date.now() + unloadDelay) }
// The proxy before this one was killed while its connection was subscribed: the daemon dropped that subscription with it.
if (carried?.isSubscribed) restartUnload()
// A proxy that ends takes its connection's subscription with it, at that moment.
process.on('exit', () => {
  if (isSubscribed) { isSubscribed = false; restartUnload() }
  save()
})
// An unloaded thread stays unloaded until someone joins it or the person opens it again: a turn that ends later does not bring it back.
// A running turn keeps it loaded whoever is on it, and its end restarts the delay (ended()).
const isListed = () => {
  if (!config.person) return true
  const hasPerson = existsSync(config.person)
  if (hadPerson && !hasPerson) restartUnload()
  hadPerson = hasPerson
  if (hasPerson || isSubscribed) { isUnloaded = false; return true }
  if (isUnloaded) return false
  if (running || Date.now() < unloadAt) return true
  isUnloaded = true
  // The real daemon tells every connection of an unload, subscribed or not.
  for (const threadId of config.loaded) {
    emitNow?.({ method: 'thread/status/changed', params: { threadId, status: { type: 'notLoaded' } } })
    emitNow?.({ method: 'thread/closed', params: { threadId } })
  }
  return false
}
const notice = frame => { if (isSubscribed) emitNow(frame) }
const ended = () => { running = null; stamp += 1; restartUnload(); save() }
const thread = id => ({ id, updatedAt: stamp, status: { type: running ? 'active' : 'idle' } })
const ackOf = text => 'ACK ' + text.match(/ACK ([0-9a-f]{6})/)[1]
// A user message item, as the daemon reports one: the claim nonce a client gave comes back as `clientId`.
const userMessage = (threadId, turnId, content, clientId) => ({ method: 'item/completed', params: { threadId, turnId, item: { type: 'userMessage', ...(clientId ? { clientId } : {}), content } } })
// The person's own turn, started in their own client, with what they typed as its first user message.
const begin = threadId => {
  running = 'turn-person'
  stamp += 1
  notice({ method: 'turn/started', params: { threadId, turn: { id: running } } })
  notice({ method: 'thread/status/changed', params: { threadId, status: { type: 'active' } } })
  notice(userMessage(threadId, running, [{ type: 'text', text: 'A message the person typed', text_elements: [] }]))
}
const finish = (id, threadId, text) => {
  if (config.approval) notice({ id: 999, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: id } })
  if (text) notice({ method: 'item/completed', params: { threadId, turnId: id, item: { type: 'agentMessage', text } } })
  notice({ method: 'turn/completed', params: { threadId, turn: { id, status: config.endStatus === 'none' ? undefined : config.endStatus ?? 'completed' } } })
  notice({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } })
  ended()
}
let acking = null
const handle = (value, emit) => {
  emitNow = emit
  log(value)
  const threadId = value.params?.threadId
  if (value.method === 'initialize') emit({ id: value.id, result: { userAgent: config.userAgent ?? 'codex_cli_rs/0.169.0 (synthetic)' } })
  if (value.method === 'thread/loaded/list') emit({ id: value.id, result: { data: isListed() ? config.loaded : [], nextCursor: null } })
  if (value.method === 'thread/unsubscribe') {
    const fault = unsubscribeFaults.shift()
    if (fault === 'error') { emit({ id: value.id, error: { code: -32600, message: 'synthetic' } }); return }
    if (fault === 'mute') return
    const leave = () => {
      emit({ id: value.id, result: fault === 'odd' ? {} : { status: isSubscribed ? 'unsubscribed' : 'notSubscribed' } })
      if (isSubscribed) restartUnload()
      isSubscribed = false
    }
    if (typeof fault === 'number') setTimeout(leave, fault)
    else leave()
  }
  if (value.method === 'turn/interrupt') {
    if (config.interrupt === 'error') { emit({ id: value.id, error: { code: -32600, message: 'synthetic' } }); return }
    const stop = () => {
      emit({ id: value.id, result: {} })
      // Held requests answered together end the one turn once.
      if (config.interruptFlag && !running) return
      notice({ method: 'turn/completed', params: { threadId, turn: { id: running, status: 'interrupted' } } })
      notice({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } })
      ended()
    }
    if (config.interruptFlag && !existsSync(config.interruptFlag)) { interrupts.push(stop); return }
    stop()
  }
  if (value.method === 'thread/resume') {
    isSubscribed = true
    if (config.resumeRace && !running && !hasRaced) {
      // A turn begins as the join arrives. The answer says active, and the turn's end and the idle notice follow in the same
      // write, so the client handles them before the code that awaited the answer continues.
      hasRaced = true
      running = config.turn
      stamp += 1
      const frames = [
        { id: value.id, result: { thread: thread(threadId) } },
        { method: 'turn/completed', params: { threadId, turn: { id: running, status: 'completed' } } },
        { method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } },
      ]
      process.stdout.write(Buffer.concat(frames.map(frame => serverFrame(JSON.stringify(frame)))))
      ended()
      return
    }
    emit({ id: value.id, result: { thread: thread(threadId) } })
    if (running) notice({ method: 'turn/started', params: { threadId, turn: { id: running } } })
  }
  if (value.method === 'thread/read') {
    if (config.readFaults && existsSync(config.readFaults)) {
      if (readFileSync(config.readFaults, 'utf8') !== 'mute') emit({ id: value.id, error: { code: -32600, message: 'synthetic' } })
      return
    }
    // The person's turn begins after the claim and the join: an unjoined read (the receiver checking whether to take a message) does not start it.
    if (config.readActive && !running && !hasRaced && isSubscribed) {
      hasRaced = true
      emit({ id: value.id, result: { thread: { ...thread(threadId), status: { type: 'active' } } } })
      begin(threadId)
      return
    }
    if (config.readDelay) { setTimeout(() => emit({ id: value.id, result: { thread: thread(threadId) } }), config.readDelay); return }
    emit({ id: value.id, result: { thread: thread(threadId) } })
  }
  if (value.method === 'turn/start') {
    // One extra line per start: whether the text lands in a turn that is running (or that the person's own turn races into).
    log({ startedInRunningTurn: Boolean(running) || Boolean((config.joinOnStart || config.joinLate) && !hasRaced) })
    if (config.start === 'mute') return
    if (config.start === 'die') process.exit(0)
    if (config.start === 'endFirst' && !running) {
      const id = 'turn-delivery'
      notice({ method: 'item/completed', params: { threadId, turnId: id, item: { type: 'agentMessage', text: ackOf(value.params.input[0].text) } } })
      notice({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } })
      notice({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } })
      stamp += 2
      restartUnload()
      emit({ id: value.id, result: { turn: { id } } })
      return
    }
    if (config.start === 'ownFirst' && !running) {
      const id = 'turn-delivery'
      notice({ method: 'turn/started', params: { threadId, turn: { id } } })
      notice({ ...userMessage(threadId, id, value.params.input, value.params.clientUserMessageId) })
      notice({ method: 'item/completed', params: { threadId, turnId: id, item: { type: 'agentMessage', text: ackOf(value.params.input[0].text) } } })
      notice({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } })
      notice({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } })
      stamp += 2
      restartUnload()
      emit({ id: value.id, result: { turn: { id } } })
      return
    }
    const own = userMessage(threadId, null, value.params.input, value.params.clientUserMessageId)
    if (config.joinOnStart && !running && !hasRaced) { hasRaced = true; begin(threadId) }
    if (config.joinLate && !running && !hasRaced) {
      // The person's turn had begun when this call arrived, but the daemon tells this connection only later.
      hasRaced = true
      running = 'turn-person'
      stamp += 1
      emit({ id: value.id, result: { turn: { id: running } } })
      setTimeout(() => { begin(threadId); notice({ ...own, params: { ...own.params, turnId: running } }) }, 100)
      return
    }
    // On a running turn the text joins it, as a later user message of that turn.
    if (running) { emit({ id: value.id, result: { turn: { id: running } } }); notice({ ...own, params: { ...own.params, turnId: running } }); return }
    if (config.start === 'error') { emit({ id: value.id, error: { code: -32600, message: 'synthetic' } }); return }
    if (config.start === 'empty') { emit({ id: value.id, result: {} }); return }
    running = 'turn-delivery'
    stamp += 1
    emit({ id: value.id, result: { turn: { id: running } } })
    notice({ method: 'turn/started', params: { threadId, turn: { id: running } } })
    notice({ method: 'thread/status/changed', params: { threadId, status: { type: 'active' } } })
    notice({ ...own, params: { ...own.params, turnId: running } })
    if (config.approval === 'hold') {
      notice({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } })
      notice({ id: 998, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: running } })
      return
    }
    if (config.start === 'ack' && config.ackFlag) acking = { threadId, text: ackOf(value.params.input[0].text) }
    else if (config.start === 'ack') setTimeout(() => finish('turn-delivery', threadId, ackOf(value.params.input[0].text)), config.ackDelay ?? 50)
  }
}
// The daemon's side is saved as soon as a request has changed it: a proxy can be killed at any moment.
serveWebSocketProxy({ onHandshake: request => log({ handshake: request }), onMessage: (value, emit) => { handle(value, emit); save() } })
const watcher = setInterval(() => {
  if (!emitNow) return
  // Notes a person who quit, so the unload delay starts when they did and not at the next listing.
  isListed()
  save()
  if (acking && config.ackFlag && existsSync(config.ackFlag)) { unlinkSync(config.ackFlag); finish('turn-delivery', acking.threadId, acking.text); acking = null }
  if (config.closeFlag && existsSync(config.closeFlag)) { unlinkSync(config.closeFlag); emitNow({ method: 'thread/closed', params: { threadId: config.loaded[0] } }) }
  if (config.interruptFlag && existsSync(config.interruptFlag)) for (const stop of interrupts.splice(0)) stop()
  if (!running && config.beginFlag && existsSync(config.beginFlag)) { unlinkSync(config.beginFlag); begin(config.loaded[0]) }
  if (!running || !config.endFlag || !existsSync(config.endFlag)) return
  unlinkSync(config.endFlag)
  finish(running, config.loaded[0], '')
}, 50)
// The proxy goes with its stdin, as the real one does: a receiver that is gone leaves no proxy behind.
watcher.unref()

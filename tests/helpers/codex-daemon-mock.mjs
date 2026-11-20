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
//              'lost' starts the turn in the daemon and ends the proxy before it has said anything of it, answer or notice: the
//              delivery's own turn, or with lostTurn 'person' the person's own, begun at that moment, which the text only joins
//              (with lostTurn 'bare' a turn that thread/turns/list shows with no user message)
//              'heard' is 'lost' with the turn's start, and nothing else, told to the connection before the proxy ends;
//              'heardWaiting' tells its wait on an approval too
//   answerOnLookup  when true, the approval the turn waits on is answered as thread/turns/list arrives, before its answer goes
//              out: the turn runs on and no longer waits
//   answerFlag a file whose appearance answers the approval the turn waits on: the turn runs on and no longer waits
//   away       a file: while it is there the daemon cannot be reached, and a proxy that starts ends at once, before its log line
//   startDelay ms the answer to turn/start is held back on an idle thread, while the turn has begun and its notices (its start, its
//              first user message, an approval it waits on) have gone out
//   joinOnStart when true, the person's own turn starts just before the first turn/start is handled, so the call joins it
//   joinLate   like joinOnStart, but that turn's notices (its start, its first user message) go out only after the answer
//   readDelay  ms the answer to thread/read is held back (the thread's status is read when it is sent)
//   readFaults  a file: while it is there, thread/read gets an error answer, or no answer at all when the file holds 'mute'
//   readHold   a file: while it is there, the answers to thread/read are held back; they go out, with the status the thread has
//              then, once it is gone
//   resumeRace  when true, a turn begins as the first thread/resume arrives and ends right behind its answer, in the same write
//   readActive  when true, the person's own turn starts as thread/read is first asked by a connection that has joined the thread
//              (after a claim, the read right before turn/start): the answer says active, the notices follow
//   endStatus  the status the delivery turn ends with: 'completed' (default), 'failed', 'interrupted', 'none' (no status field) or any other word
//   approval   when true, the daemon asks its client for an approval during the turn
//   beginFlag  a file whose appearance starts the person's own turn ('turn-person') on an idle thread
//   beginLate  ms the notices of the person's own turn reach this connection after that turn has begun (thread/read shows it at
//              once), as when they arrive behind the receiver's other answers; none are sent if the turn has ended by then
//   endFlag    a file whose appearance ends the running turn
//   userAgent  what initialize says the daemon is (default: a version that unloads a thread 60 s after its last subscriber left)
//   person     file whose presence stands for a person's own client being open on the thread: without it, the thread is listed only
//              while this connection is subscribed to it (thread/resume until thread/unsubscribe) or a turn runs, and for unloadDelay
//              after the later of the last subscriber (this connection or the person) leaving and the last turn ending, as the real
//              daemon does; then thread/status/changed (notLoaded) and thread/closed go to the connection, subscribed or not.
//              A person who quits does not end their turn: it runs on until endFlag
//   state      file that carries the daemon's side over to the next proxy process (default: the log's name with '.state' added),
//              since the real daemon outlives a proxy: the running turn, the unload delay, and whether the connection was
//              subscribed. A proxy that ends leaves its thread at that moment. One that was killed outright runs no code of its
//              own then (on Windows a kill never does), so the file also carries the time the proxy was last alive, written
//              every 50 ms: the daemon dropped its subscription at that time, and the unload delay runs from there, not from the
//              start of the next proxy. A person found gone by the next proxy is read as gone since that time too
//   unloadDelay  ms the thread stays listed after that (the real daemon's 60 s; default 150)
//   unloadSecs  what config/read reports as `thread_unload_delay_secs` (default 0: the stand-in's own delay is well under a
//              second); 'none' leaves the key out, as a config that names no delay does
//   configFaults  a file: while it is there, config/read gets an error answer, or a delay that is not a number when it holds 'odd'
//   cwd        the folder thread/read reports for the thread (default '/synthetic/project')
//   noMarker   when true, thread/read reports no `updatedAt`
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
// thread/turns/list answers with the running turn alone, newest first as the real one lists them, with its first user message
// (the summary view of the source's `TurnItemsView`; not run live), and with no turn when none runs.
// thread/read tells the thread's true status to any connection (with `waitingOnApproval` among its `activeFlags` while a held
// approval waits), and its `updatedAt` moves with each turn's start and end (read in the daemon's source, where it is the saved
// thread's last update; not run live). config/read answers with the config the daemon would give a thread in the folder asked
// about, as the source has it (`config.thread_unload_delay_secs`; not run live).
// Notices about a thread go only to a connection subscribed to it, as the real daemon sends them; thread/closed goes to every one.
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { serveWebSocketProxy, serverFrame } from './ws-proxy-mock.mjs'

const config = JSON.parse(readFileSync(process.env.CODEX_MOCK_CONFIG, 'utf8'))
if (config.away && existsSync(config.away)) process.exit(1)
const log = value => appendFileSync(config.log, JSON.stringify(value) + '\n')
if (config.pidFile) writeFileSync(config.pidFile, String(process.pid))
log({ argv: process.argv.slice(2), env: process.env })
const stateFile = config.state ?? config.log + '.state'
const carried = (() => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null } })()
let running = carried ? carried.running : config.status === 'active' ? config.turn : null
let emitNow, hasRaced = false, isSubscribed = false, hadPerson = carried?.hadPerson ?? false, unloadAt = carried?.unloadAt ?? 0, isUnloaded = carried?.isUnloaded ?? false
// A delivery turn held on an approval nobody has answered.
let isWaiting = carried?.isWaiting ?? false
// Stands for the time of the saved thread's last update.
let stamp = carried?.stamp ?? 1
// The running turn's first user message, as thread/turns/list shows it.
let first = carried?.first ?? null
// The thread/read answers held back while readHold is there.
const reads = []
// Written whole and then renamed into place: a proxy killed in the middle of a write leaves the file before it.
const save = () => {
  try {
    writeFileSync(stateFile + '.' + process.pid, JSON.stringify({ running, hadPerson, unloadAt, isUnloaded, isSubscribed, isWaiting, stamp, first, seen: Date.now() }))
    renameSync(stateFile + '.' + process.pid, stateFile)
  } catch { /* The next write, 50 ms on, carries the same state. */ }
}
// The turn/interrupt requests held back until interruptFlag appears.
const interrupts = []
const unsubscribeFaults = [...(config.unsubscribeFaults ?? [])]
const unloadDelay = config.unloadDelay ?? 150
// The daemon's unload delay starts again whenever a subscriber leaves or a turn ends.
const restartUnload = () => { unloadAt = Math.max(unloadAt, Date.now() + unloadDelay) }
// The proxy before this one was killed while its connection was subscribed: the daemon dropped that subscription when it died,
// which is when it was last seen alive. A person who is gone now is read as gone since then as well, the earliest it can have been.
if (carried?.isSubscribed) unloadAt = Math.max(unloadAt, carried.seen + unloadDelay)
if (carried?.hadPerson && config.person && !existsSync(config.person)) { hadPerson = false; unloadAt = Math.max(unloadAt, carried.seen + unloadDelay) }
if (carried) log({ carried: carried.isSubscribed ? 'killed' : 'left', unloadsIn: unloadAt - Date.now() })
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
const ended = () => { running = null; first = null; isWaiting = false; stamp += 1; restartUnload(); save() }
const thread = id => ({ id, cwd: config.cwd ?? '/synthetic/project', ...(config.noMarker ? {} : { updatedAt: stamp }), status: running ? { type: 'active', activeFlags: isWaiting ? ['waitingOnApproval'] : [] } : { type: 'idle' } })
const ackOf = text => 'ACK ' + text.match(/ACK ([0-9a-f]{6})/)[1]
// A user message item, as the daemon reports one: the claim nonce a client gave comes back as `clientId`.
const userMessage = (threadId, turnId, content, clientId) => ({ method: 'item/completed', params: { threadId, turnId, item: { type: 'userMessage', ...(clientId ? { clientId } : {}), content } } })
// The person's own turn, started in their own client, with what they typed as its first user message.
const typedBy = threadId => userMessage(threadId, 'turn-person', [{ type: 'text', text: 'A message the person typed', text_elements: [] }])
const begin = threadId => {
  running = 'turn-person'
  stamp += 1
  const typed = typedBy(threadId)
  first = typed.params.item
  const tell = () => {
    if (running !== 'turn-person') return
    notice({ method: 'turn/started', params: { threadId, turn: { id: running } } })
    notice({ method: 'thread/status/changed', params: { threadId, status: { type: 'active' } } })
    notice(typed)
  }
  if (config.beginLate) setTimeout(tell, config.beginLate)
  else tell()
}
const finish = (id, threadId, text) => {
  if (config.approval) notice({ id: 999, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: id } })
  if (text) notice({ method: 'item/completed', params: { threadId, turnId: id, item: { type: 'agentMessage', text } } })
  notice({ method: 'turn/completed', params: { threadId, turn: { id, status: config.endStatus === 'none' ? undefined : config.endStatus ?? 'completed' } } })
  notice({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } })
  ended()
}
const answerApproval = () => {
  if (!isWaiting || !config.answerFlag || !existsSync(config.answerFlag)) return
  unlinkSync(config.answerFlag)
  isWaiting = false
  notice({ method: 'serverRequest/resolved', params: { threadId: config.loaded[0], requestId: 998 } })
  notice({ method: 'thread/status/changed', params: { threadId: config.loaded[0], status: { type: 'active', activeFlags: [] } } })
  save()
}
let acking = null
const handle = (value, emit) => {
  emitNow = emit
  answerApproval()
  log(value)
  const threadId = value.params?.threadId
  if (value.method === 'initialize') emit({ id: value.id, result: { userAgent: config.userAgent ?? 'codex_cli_rs/0.169.0 (synthetic)' } })
  if (value.method === 'config/read') {
    const fault = config.configFaults && existsSync(config.configFaults) ? readFileSync(config.configFaults, 'utf8') : null
    if (fault !== null && fault !== 'odd') { emit({ id: value.id, error: { code: -32600, message: 'synthetic' } }); return }
    const seconds = fault === 'odd' ? 'sixty' : config.unloadSecs ?? 0
    emit({ id: value.id, result: { config: seconds === 'none' ? {} : { thread_unload_delay_secs: seconds }, origins: {} } })
  }
  if (value.method === 'thread/turns/list' && config.answerOnLookup) isWaiting = false
  if (value.method === 'thread/turns/list') emit({ id: value.id, result: { data: running ? [{ id: running, status: 'inProgress', items: first ? [first] : [] }] : [], nextCursor: null } })
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
    if (config.readHold && existsSync(config.readHold)) { reads.push(() => emit({ id: value.id, result: { thread: thread(threadId) } })); return }
    if (config.readDelay) { setTimeout(() => emit({ id: value.id, result: { thread: thread(threadId) } }), config.readDelay); return }
    emit({ id: value.id, result: { thread: thread(threadId) } })
  }
  if (value.method === 'turn/start') {
    // One extra line per start: whether the text lands in a turn that is running (or that the person's own turn races into).
    log({ startedInRunningTurn: Boolean(running) || Boolean((config.joinOnStart || config.joinLate) && !hasRaced) })
    if (config.start === 'mute') return
    if (config.start === 'die') process.exit(0)
    if ((config.start === 'lost' || config.start === 'heard' || config.start === 'heardWaiting') && !running) {
      // The connection is told nothing ('lost'), or the turn's start and no more ('heard'), or its start and its wait on an
      // approval ('heardWaiting'): never the answer or the first user message. The exit handler saves the daemon's side: the
      // turn runs on there, and the next proxy finds it.
      running = config.lostTurn === 'person' ? 'turn-person' : config.lostTurn === 'bare' ? 'turn-bare' : 'turn-delivery'
      first = config.lostTurn === 'bare' ? null : (config.lostTurn === 'person' ? typedBy(threadId) : userMessage(threadId, running, value.params.input, value.params.clientUserMessageId)).params.item
      stamp += 1
      isWaiting = config.approval === 'hold'
      if (config.start === 'lost') process.exit(0)
      notice({ method: 'turn/started', params: { threadId, turn: { id: running } } })
      if (config.start === 'heardWaiting') notice({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } })
      setTimeout(() => process.exit(0), 150)
      return
    }
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
    first = own.params.item
    const answer = () => emit({ id: value.id, result: { turn: { id: 'turn-delivery' } } })
    if (config.startDelay) setTimeout(answer, config.startDelay)
    else answer()
    notice({ method: 'turn/started', params: { threadId, turn: { id: running } } })
    notice({ method: 'thread/status/changed', params: { threadId, status: { type: 'active' } } })
    notice({ ...own, params: { ...own.params, turnId: running } })
    if (config.approval === 'hold') {
      isWaiting = true
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
  // Notes a person who quit, so the unload delay starts when they did and not at the next listing; and that this proxy is alive.
  isListed()
  save()
  if (!emitNow) return
  answerApproval()
  if (acking && config.ackFlag && existsSync(config.ackFlag)) { unlinkSync(config.ackFlag); finish('turn-delivery', acking.threadId, acking.text); acking = null }
  if (config.closeFlag && existsSync(config.closeFlag)) { unlinkSync(config.closeFlag); emitNow({ method: 'thread/closed', params: { threadId: config.loaded[0] } }) }
  if (config.interruptFlag && existsSync(config.interruptFlag)) for (const stop of interrupts.splice(0)) stop()
  if (reads.length > 0 && !existsSync(config.readHold)) for (const answer of reads.splice(0)) answer()
  if (!running && config.beginFlag && existsSync(config.beginFlag)) { unlinkSync(config.beginFlag); begin(config.loaded[0]) }
  if (!running || !config.endFlag || !existsSync(config.endFlag)) return
  unlinkSync(config.endFlag)
  finish(running, config.loaded[0], '')
}, 50)
// The proxy goes with its stdin, as the real one does: a receiver that is gone leaves no proxy behind.
watcher.unref()

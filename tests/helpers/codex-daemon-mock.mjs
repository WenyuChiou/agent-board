// A stand-in for `codex app-server proxy` in front of the shared daemon. It speaks WebSocket over stdio like the
// real proxy, answers the requests the Codex receiver makes, and writes everything it receives to a log.
// The script is read from CODEX_MOCK_CONFIG (a JSON file), because the receiver must run the proxy with exactly
// `app-server proxy`:
//   log        file that gets one JSON line per received message, and a first line for argv and environment
//   loaded     thread ids the daemon has loaded
//   status     'idle' | 'active': the thread's status when it is resumed
//   turn       the running turn's id when the thread is active
//   start      what turn/start does on an idle thread: 'ack' (answers, ACKs, completes), 'silent' (answers, nothing else),
//              'error' (an error answer), 'empty' (an answer with no turn). On a running turn it answers with that turn's id
//              and starts nothing, as the real daemon does (the text joins the turn).
//   joinOnStart when true, the person's own turn starts just before the first turn/start is handled, so the call joins it
//   joinLate   like joinOnStart, but that turn's notices (its start, its first user message) go out only after the answer
//   readActive  when true, the person's own turn starts as thread/read is first asked: the answer says active, the notices follow
//   endStatus  the status the delivery turn ends with: 'completed' (default), 'failed', 'interrupted', 'none' (no status field) or any other word
//   approval   when true, the daemon asks its client for an approval during the turn
//   beginFlag  a file whose appearance starts the person's own turn ('turn-person') on an idle thread
//   endFlag    a file whose appearance ends the running turn
//   pidFile    file that gets this process's id
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { serveWebSocketProxy, serverFrame } from './ws-proxy-mock.mjs'

const config = JSON.parse(readFileSync(process.env.CODEX_MOCK_CONFIG, 'utf8'))
const log = value => appendFileSync(config.log, JSON.stringify(value) + '\n')
if (config.pidFile) writeFileSync(config.pidFile, String(process.pid))
log({ argv: process.argv.slice(2), env: process.env })
let running = config.status === 'active' ? config.turn : null
let emitNow, hasRaced = false
const thread = id => ({ id, status: { type: running ? 'active' : 'idle' } })
const ackOf = text => 'ACK ' + text.match(/ACK ([0-9a-f]{6})/)[1]
// A user message item, as the daemon reports one: the claim nonce a client gave comes back as `clientId`.
const userMessage = (threadId, turnId, content, clientId) => ({ method: 'item/completed', params: { threadId, turnId, item: { type: 'userMessage', ...(clientId ? { clientId } : {}), content } } })
// The person's own turn, started in their own client, with what they typed as its first user message.
const begin = threadId => {
  running = 'turn-person'
  emitNow({ method: 'turn/started', params: { threadId, turn: { id: running } } })
  emitNow({ method: 'thread/status/changed', params: { threadId, status: { type: 'active' } } })
  emitNow(userMessage(threadId, running, [{ type: 'text', text: 'A message the person typed', text_elements: [] }]))
}
const finish = (id, threadId, text) => {
  if (config.approval) emitNow({ id: 999, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: id } })
  if (text) emitNow({ method: 'item/completed', params: { threadId, turnId: id, item: { type: 'agentMessage', text } } })
  emitNow({ method: 'turn/completed', params: { threadId, turn: { id, status: config.endStatus === 'none' ? undefined : config.endStatus ?? 'completed' } } })
  emitNow({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } })
  running = null
}
serveWebSocketProxy({
  onHandshake: request => log({ handshake: request }),
  onMessage: (value, emit) => {
    emitNow = emit
    log(value)
    const threadId = value.params?.threadId
    if (value.method === 'initialize') emit({ id: value.id, result: {} })
    if (value.method === 'thread/loaded/list') emit({ id: value.id, result: { data: config.loaded, nextCursor: null } })
    if (value.method === 'thread/resume') {
      if (config.resumeRace && running) {
        // The answer says active, and the turn's end and the idle notice follow in the same write, so the client handles
        // them before the code that awaited the answer continues.
        const frames = [
          { id: value.id, result: { thread: thread(threadId) } },
          { method: 'turn/completed', params: { threadId, turn: { id: running, status: 'completed' } } },
          { method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } },
        ]
        process.stdout.write(Buffer.concat(frames.map(frame => serverFrame(JSON.stringify(frame)))))
        running = null
        return
      }
      emit({ id: value.id, result: { thread: thread(threadId) } })
      if (running) emit({ method: 'turn/started', params: { threadId, turn: { id: running } } })
    }
    if (value.method === 'thread/read') {
      if (config.readActive && !running && !hasRaced) {
        hasRaced = true
        running = 'turn-person'
        emit({ id: value.id, result: { thread: thread(threadId) } })
        begin(threadId)
        return
      }
      emit({ id: value.id, result: { thread: thread(threadId) } })
    }
    if (value.method === 'turn/start') {
      const own = userMessage(threadId, null, value.params.input, value.params.clientUserMessageId)
      if (config.joinOnStart && !running && !hasRaced) { hasRaced = true; begin(threadId) }
      if (config.joinLate && !running && !hasRaced) {
        // The person's turn had begun when this call arrived, but the daemon tells this connection only later.
        hasRaced = true
        running = 'turn-person'
        emit({ id: value.id, result: { turn: { id: running } } })
        setTimeout(() => { begin(threadId); emitNow({ ...own, params: { ...own.params, turnId: running } }) }, 100)
        return
      }
      // On a running turn the text joins it, as a later user message of that turn.
      if (running) { emit({ id: value.id, result: { turn: { id: running } } }); emit({ ...own, params: { ...own.params, turnId: running } }); return }
      if (config.start === 'error') { emit({ id: value.id, error: { code: -32600, message: 'synthetic' } }); return }
      if (config.start === 'empty') { emit({ id: value.id, result: {} }); return }
      running = 'turn-delivery'
      emit({ id: value.id, result: { turn: { id: running } } })
      emit({ method: 'turn/started', params: { threadId, turn: { id: running } } })
      emit({ method: 'thread/status/changed', params: { threadId, status: { type: 'active' } } })
      emit({ ...own, params: { ...own.params, turnId: running } })
      if (config.start === 'ack') setTimeout(() => finish('turn-delivery', threadId, ackOf(value.params.input[0].text)), 50)
    }
  },
})
const watcher = setInterval(() => {
  if (!emitNow) return
  if (!running && config.beginFlag && existsSync(config.beginFlag)) { unlinkSync(config.beginFlag); begin(config.loaded[0]) }
  if (!running || !config.endFlag || !existsSync(config.endFlag)) return
  unlinkSync(config.endFlag)
  finish(running, config.loaded[0], '')
}, 50)
// The proxy goes with its stdin, as the real one does: a receiver that is gone leaves no proxy behind.
watcher.unref()

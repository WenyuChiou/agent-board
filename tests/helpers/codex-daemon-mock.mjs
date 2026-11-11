// A stand-in for `codex app-server proxy` in front of the shared daemon. It speaks WebSocket over stdio like the
// real proxy, answers the requests the Codex receiver makes, and writes everything it receives to a log.
// The script is read from CODEX_MOCK_CONFIG (a JSON file), because the receiver must run the proxy with exactly
// `app-server proxy`:
//   log        file that gets one JSON line per received message, and a first line for argv and environment
//   loaded     thread ids the daemon has loaded
//   status     'idle' | 'active': the thread's status when it is resumed
//   turn       the running turn's id when the thread is active
//   start      what turn/start does: 'ack' (answers, ACKs, completes), 'silent' (answers, nothing else),
//              'error' (an error answer), 'empty' (an answer with no turn)
//   steer      what turn/steer does: 'ack' (answers with the turn id, ACKs, completes), 'silent', or 'error' (an error answer)
//   endStatus  the status the delivery turn ends with: 'completed' (default), 'failed', 'interrupted', 'none' (no status field) or any other word
//   replay     false: resuming a thread with a running turn does not replay that turn's start to the new connection
//   listed     'none': thread/turns/list names no turn in progress
//   approval   when true, the daemon asks its client for an approval during the turn
//   endFlag    a file whose appearance ends the running turn
//   pidFile    file that gets this process's id
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { serveWebSocketProxy } from './ws-proxy-mock.mjs'

const config = JSON.parse(readFileSync(process.env.CODEX_MOCK_CONFIG, 'utf8'))
const log = value => appendFileSync(config.log, JSON.stringify(value) + '\n')
if (config.pidFile) writeFileSync(config.pidFile, String(process.pid))
log({ argv: process.argv.slice(2), env: process.env })
let running = config.status === 'active' ? config.turn : null
let emitNow
const thread = id => ({ id, status: { type: running ? 'active' : 'idle' } })
const ackOf = text => 'ACK ' + text.match(/ACK ([0-9a-f]{6})/)[1]
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
      emit({ id: value.id, result: { thread: thread(threadId) } })
      if (running && config.replay !== false) emit({ method: 'turn/started', params: { threadId, turn: { id: running } } })
    }
    if (value.method === 'thread/turns/list') emit({ id: value.id, result: { data: running && config.listed !== 'none' ? [{ id: running, status: 'inProgress' }] : [], nextCursor: null } })
    if (value.method === 'turn/start') {
      if (config.start === 'error') { emit({ id: value.id, error: { code: -32600, message: 'synthetic' } }); return }
      if (config.start === 'empty') { emit({ id: value.id, result: {} }); return }
      running = 'turn-delivery'
      emit({ id: value.id, result: { turn: { id: running } } })
      emit({ method: 'turn/started', params: { threadId, turn: { id: running } } })
      emit({ method: 'thread/status/changed', params: { threadId, status: { type: 'active' } } })
      if (config.start === 'ack') setTimeout(() => finish('turn-delivery', threadId, ackOf(value.params.input[0].text)), 50)
    }
    if (value.method === 'turn/steer') {
      if (config.steer === 'error') { emit({ id: value.id, error: { code: -32600, message: 'expected turn is not running' } }); return }
      emit({ id: value.id, result: { turnId: value.params.expectedTurnId } })
      if (config.steer === 'ack') setTimeout(() => finish(value.params.expectedTurnId, threadId, ackOf(value.params.input[0].text)), 50)
    }
  },
})
const watcher = setInterval(() => {
  if (!running || !config.endFlag || !existsSync(config.endFlag)) return
  unlinkSync(config.endFlag)
  finish(running, config.loaded[0], '')
}, 50)
// The proxy goes with its stdin, as the real one does: a receiver that is gone leaves no proxy behind.
watcher.unref()

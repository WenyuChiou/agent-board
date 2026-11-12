import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, posix, win32 } from 'node:path'
import { ackLine, boardClient, deliveryPrompt } from './message-client.mjs'
import { openWebSocketStdio } from './ws-stdio.mjs'

/** @type {import('./message-client.mjs').MessagingReceiverRecord} */
export const messagingReceiver = {
  host: 'Codex',
  // No `<date>-codex-live.md` yet: the synthetic tests only establish Implemented (docs/validation/2026-11-06-send-to-codex.md).
  surfaces: [{ name: 'Daemon', evidence: null }],
  tier: 1,
  primitive: '[P1]',
  isImplemented: true,
}

const THREAD = /^[a-f0-9-]{36}$/i
// A turn that never ends cannot hold a message for ever; the board's own limit on an unanswered message is 30 minutes.
const ACK_LIMIT_MS = 30 * 60_000
// A steered turn that says nothing for this long is uncertain (L2: a steer once stalled a turn for over 3 minutes).
const STEER_SILENCE_MS = 60_000
const TICK_MS = 3000
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
        else one.done(value.result)
        return
      }
      // A request the daemon makes of its clients (an approval) is left unanswered: it is the person's own client that answers it.
      if (typeof value.method === 'string') onMessage(value)
    },
  })
  const request = (method, params, limit = 5000) => new Promise((done, reject) => {
    if (!isOpen) { reject(new Error('OWNER_DISCONNECTED')); return }
    const id = ++sequence
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('OWNER_TIMEOUT')) }, limit)
    requests.set(id, { done, reject, timer })
    try { websocket.send(JSON.stringify({ id, method, params })) } catch (error) { clearTimeout(timer); requests.delete(id); reject(error) }
  })
  // Sync, so a process that is exiting can still end the Codex program.
  const kill = () => { lost(); websocket.close(); child.kill() }
  try {
    await websocket.ready
    await request('initialize', { clientInfo: { name: 'agent-board-codex-receiver', version: '1' } })
    websocket.send(JSON.stringify({ method: 'initialized', params: {} }))
  } catch (error) { kill(); await exited; throw error }
  return { request, isOpen: () => isOpen, kill, close: async () => { kill(); await exited } }
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

const input = prompt => [{ type: 'text', text: prompt, text_elements: [] }]

// Takes a board message for each Codex thread that the shared daemon has loaded and the board knows, and
// starts one turn with it. `threads()` gives the Codex session ids the board knows. Nothing is started
// for a thread the daemon has not loaded, and nothing goes through Codex's queue.
export const startCodexReceiver = ({
  boardUrl, threads, executable, socket, env = process.env, isSteerOn = false,
  tickMs = TICK_MS, ackMs = ACK_LIMIT_MS, steerSilenceMs = STEER_SILENCE_MS, onError = () => undefined,
}) => {
  if (typeof threads !== 'function' || !isAbsolute(executable ?? '')) throw new Error('EXPLICIT_EXECUTABLE_REQUIRED')
  const client = boardClient(boardUrl)
  const attached = new Map()
  let daemon = null, isTicking = false, isClosed = false, failures = 0, retryAt = 0

  const route = value => {
    const p = value.params
    const one = typeof p?.threadId === 'string' ? attached.get(p.threadId) : undefined
    if (!one) return
    const state = one.state
    state.heard = Date.now()
    state.seen += 1
    if (value.method === 'thread/status/changed' && typeof p.status?.type === 'string') state.status = p.status.type
    else if (value.method === 'turn/started' && p.turn?.id) state.turn = p.turn.id
    else if (value.method === 'turn/completed' && p.turn?.id) {
      if (state.turn === p.turn.id) state.turn = null
      if (state.pending) { state.pending.ended.set(p.turn.id, typeof p.turn.status === 'string' ? p.turn.status : ''); one.settle() }
    } else if (value.method === 'item/completed' && p.item?.type === 'agentMessage' && state.pending) {
      const line = ackLine(String(p.item.text ?? ''), state.pending.nonce)
      if (line !== null) { state.pending.acked.set(p.turnId, line); one.settle() }
    }
  }

  const connect = async () => {
    daemon = await connectDaemon({ executable, socket, env, onMessage: route, onClose: () => { daemon = null } })
    failures = 0
  }

  const drop = async thread => {
    const one = attached.get(thread)
    if (!one) return
    attached.delete(thread)
    one.state.pending?.reject(new Error('OWNER_DISCONNECTED'))
    await one.receiver?.close().catch(() => undefined)
  }

  const attach = async thread => {
    const state = { status: 'unknown', turn: null, pending: null, heard: 0, seen: 0 }
    const one = { state, receiver: null, isLost: false, settle: () => undefined }
    attached.set(thread, one)
    // The delivery turn settles when its own turn has ended: an ACK seen in another turn, or none, or a
    // turn that failed after its ACK never reads as a receipt. A turn may end before turn/start answers,
    // so ended turns are kept by id.
    one.settle = () => {
      const pending = state.pending
      if (!pending?.turn || !pending.ended.has(pending.turn)) return
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
    // The running turn, when the daemon did not replay its start to this connection (a turn that began before the
    // connection joined): the newest turn of the thread, if it is still in progress.
    const activeTurn = async () => {
      try {
        const listed = await daemon.request('thread/turns/list', { threadId: thread, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
        const newest = Array.isArray(listed?.data) ? listed.data[0] : undefined
        return newest?.status === 'inProgress' && typeof newest.id === 'string' && newest.id ? newest.id : null
      } catch { return null }
    }
    // The answer is used only if the thread said nothing meanwhile: a completion or idle notice that arrived first is newer.
    const learnTurn = async () => {
      const seen = state.seen
      const id = await activeTurn()
      if (id !== null && state.seen === seen && state.turn === null && state.status === 'active') state.turn = id
    }
    try {
      // Resuming a loaded thread subscribes this connection to its events without starting a turn.
      const resumed = await daemon.request('thread/resume', { threadId: thread, excludeTurns: true })
      state.status = typeof resumed?.thread?.status?.type === 'string' ? resumed.thread.status.type : 'unknown'
      if (isSteerOn && state.status === 'active' && state.turn === null) await learnTurn()
      const verify = async () => {
        let isLoaded = false
        try { isLoaded = daemon !== null && daemon.isOpen() && (await loadedThreads(daemon)).has(thread) } catch { isLoaded = false }
        if (!isLoaded) one.isLost = true
        return isLoaded
      }
      one.receiver = await client.attach({
        agent: 'codex', session: thread, scope: 'session', turn: 'session', surface: 'Codex CLI', unclaimed: true, verify, onError,
        // Busy is not a refusal: the lease stays alive and the message waits in the board until the turn ends.
        canReceive: async () => {
          if (isSteerOn && !state.pending && state.status === 'active' && state.turn === null) await learnTurn()
          return !state.pending && (state.turn === null && state.status === 'idle' || isSteerOn && state.turn !== null && state.status === 'active')
        },
        deliver: async (message, accepted, begin) => {
          if (state.pending) throw new Error('SESSION_BUSY')
          const isSteer = state.turn !== null || state.status !== 'idle'
          if (isSteer ? !(isSteerOn && state.turn !== null && state.status === 'active') : false) throw new Error('SESSION_BUSY')
          let timer
          const answer = new Promise((done, reject) => {
            state.pending = { nonce: message.nonce, turn: isSteer ? state.turn : null, acked: new Map(), ended: new Map(), done, reject }
            timer = setTimeout(() => reject(new Error('ACK_TIMEOUT')), ackMs)
          })
          void answer.catch(() => undefined)
          let silence
          try {
            const prompt = deliveryPrompt(message)
            // The daemon's own error answer (a turn that is no longer the running one, a refused request) is a refusal
            // before anything was done: the message is rejected, not uncertain. Anything else that goes wrong after the
            // request left (no answer, a closed connection, an odd answer) may have been delivered.
            const send = async (method, params, limit) => {
              try { return await daemon.request(method, params, limit) } catch (error) { if (error?.message !== 'OWNER_REJECTED') begin(); throw error }
            }
            if (isSteer) {
              const result = await send('turn/steer', { threadId: thread, expectedTurnId: state.pending.turn, input: input(prompt) })
              begin()
              if (result?.turnId !== state.pending.turn) throw new Error('TURN_MISMATCH')
              state.heard = Date.now()
              silence = setInterval(() => { if (Date.now() - state.heard > steerSilenceMs) state.pending?.reject(new Error('STEER_SILENT')) }, Math.max(10, Math.min(1000, steerSilenceMs)))
              silence.unref?.()
            } else {
              // The claim nonce is the message id Codex records, so a repeated request names the same message.
              const result = await send('turn/start', { threadId: thread, input: input(prompt), clientUserMessageId: message.nonce }, 10_000)
              begin()
              if (!result?.turn?.id) throw new Error('INVALID_TURN_RESPONSE')
              state.pending.turn = result.turn.id
              if (!state.pending.ended.has(result.turn.id)) state.turn = result.turn.id
            }
            await accepted()
            one.settle()
            return await answer
          } finally { clearTimeout(timer); clearInterval(silence); state.pending = null }
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
        // Not `try { await connect() } catch`: tests/page-reader-fixture.mjs cuts the first `await x();` before a catch out of the bundle to
        // drop the CLI's entry call, and must not find this one first.
        const error = await connect().then(() => null, one => one)
        if (error !== null) {
          failures += 1
          retryAt = Date.now() + Math.min(RETRY_MAX_MS, tickMs * 2 ** Math.min(failures, 5))
          onError(error)
          return
        }
      }
      let loaded
      try { loaded = await loadedThreads(daemon) } catch (error) { onError(error); return }
      for (const [thread, one] of [...attached]) if (one.isLost || one.receiver?.isClosed() || one.receiver?.isContested() || !loaded.has(thread) || !wanted.includes(thread)) await drop(thread)
      for (const thread of wanted) {
        if (isClosed || attached.has(thread) || !loaded.has(thread)) continue
        // A thread with no turn yet has no saved history, and the daemon refuses to resume it (live check, 0.164.0): it is joined
        // on a later tick, after its first turn, and until then the message waits for the session's next step.
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

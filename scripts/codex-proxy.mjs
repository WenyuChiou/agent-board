import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { boardClient, deliveryPrompt } from './message-client.mjs'

// Both existing-owner transports deliver JSON-RPC objects to the same dispatcher.
// The WebSocket protocol uses one whole object per message, including pretty JSON.
const openTransport = ({ executable, socket, endpoint }, dispatch, onLost) => {
  const receive = text => {
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) { onLost(); return }
    let value; try { value = JSON.parse(text) } catch { return }
    if (value && typeof value === 'object' && !Array.isArray(value)) dispatch(value)
  }
  if (endpoint !== undefined) {
    if (typeof globalThis.WebSocket !== 'function') throw new Error('WEBSOCKET_UNAVAILABLE')
    const connection = new globalThis.WebSocket(endpoint)
    let finishReady, didSettle = false, connectTimer
    const ready = new Promise((done, reject) => {
      finishReady = error => {
        if (didSettle) return
        didSettle = true
        clearTimeout(connectTimer)
        if (error) reject(error)
        else done()
      }
    })
    const failed = () => { finishReady(new Error('OWNER_DISCONNECTED')); onLost() }
    connection.addEventListener('open', () => finishReady())
    connection.addEventListener('error', failed)
    connection.addEventListener('close', failed)
    connection.addEventListener('message', event => {
      if (typeof event.data !== 'string') { onLost(); return }
      receive(event.data)
    })
    connectTimer = setTimeout(() => { finishReady(new Error('OWNER_TIMEOUT')); onLost() }, 5000)
    return {
      kind: 'existing-codex-websocket', ready,
      write: value => {
        if (connection.readyState !== 1) throw new Error('OWNER_DISCONNECTED')
        connection.send(JSON.stringify(value))
      },
      close: () => { finishReady(new Error('OWNER_DISCONNECTED')); connection.close() },
    }
  }
  const args = ['app-server', 'proxy', ...(socket ? ['--sock', socket] : [])]
  const child = /\.m?js$/i.test(executable) ? spawn(process.execPath, [executable, ...args], { windowsHide: true }) : spawn(executable, args, { windowsHide: true })
  const ready = new Promise((done, reject) => {
    child.once('spawn', done)
    child.once('error', () => reject(new Error('OWNER_DISCONNECTED')))
  })
  child.on('error', onLost); child.on('exit', onLost)
  child.stderr.on('data', () => undefined)
  child.stdin.on('error', onLost)
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (buffer.length > 1024 * 1024) { onLost(); return }
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      receive(line)
    }
  })
  return {
    kind: 'existing-codex-proxy', ready,
    write: value => child.stdin.write(JSON.stringify(value) + '\n'),
    // This child is only our proxy; the owning Codex server is never terminated.
    close: () => { child.kill() },
  }
}

// Connects only to an already-running Codex control socket or explicit loopback
// WebSocket endpoint. Importing never starts a proxy, discovers a thread, resumes
// a session or reads saved history.
export const connectCodexProxy = async ({ boardUrl, executable, thread, turn, surface = 'Codex local proxy', socket, endpoint, joinLoaded = false, onError }) => {
  const absolute = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && isAbsolute(value)
  if (typeof joinLoaded !== 'boolean') throw new Error('EXPLICIT_BINDING_REQUIRED')
  if (endpoint === undefined ? !absolute(executable) : executable !== undefined && !absolute(executable)) throw new Error('EXPLICIT_BINDING_REQUIRED')
  if (typeof thread !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(thread) || typeof turn !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(turn) || socket !== undefined && (!absolute(socket) || endpoint !== undefined) || typeof surface !== 'string' || !surface.trim() || surface.length > 100 || surface.includes('\0')) throw new Error('EXPLICIT_BINDING_REQUIRED')
  if (endpoint !== undefined) {
    const matched = typeof endpoint === 'string' && endpoint.length <= 4096 && !endpoint.includes('\0') && /^ws:\/\/127\.0\.0\.1:([0-9]{1,5})(\/[^?#\s\\]*)?$/.exec(endpoint)
    if (!matched || Number(matched[1]) < 1 || Number(matched[1]) > 65535) throw new Error('LOCAL_CODEX_ENDPOINT_REQUIRED')
    try { new URL(endpoint) } catch { throw new Error('LOCAL_CODEX_ENDPOINT_REQUIRED') }
  }
  let client
  try {
    if (typeof boardUrl !== 'string' || boardUrl.length > 4096) throw new Error('LOCAL_BOARD_URL_REQUIRED')
    client = boardClient(boardUrl)
  } catch { throw new Error('LOCAL_BOARD_URL_REQUIRED') }
  const requests = new Map(), acknowledgements = new Map()
  let sequence = 0, isConnected = true, deliveryFailed = false, session, transport, closePromise, finishClosed, endTimer
  const closed = new Promise(resolve => { finishClosed = resolve })
  const lost = () => {
    if (closePromise) return closePromise
    isConnected = false
    // Set the shared promise before closing a transport: its close callback may
    // run immediately, and receiver.closed also routes back through this function.
    closePromise = Promise.resolve().then(() => {
      // Close only this adapter's proxy or socket, never the owning Codex server.
      try { transport?.close() } catch { /* Already disconnected. */ }
      return session?.close()
    }).catch(() => undefined).finally(() => finishClosed())
    clearTimeout(endTimer)
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('OWNER_DISCONNECTED')) }
    requests.clear()
    for (const ack of acknowledgements.values()) { clearTimeout(ack.timer); ack.reject(new Error('OWNER_DISCONNECTED')) }
    acknowledgements.clear()
    return closePromise
  }
  const request = (method, params) => new Promise((done, reject) => {
    if (!isConnected) { reject(new Error('OWNER_DISCONNECTED')); return }
    const id = ++sequence
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('OWNER_TIMEOUT')) }, 5000)
    requests.set(id, { done, reject, timer })
    try { transport.write({ id, method, params }) }
    catch { void lost() }
  })
  const dispatch = value => {
    // Approval requests are never answered by this connector.
    if (value.id !== undefined && !value.method) {
      const pending = requests.get(value.id)
      if (pending) {
        requests.delete(value.id); clearTimeout(pending.timer)
        if (value.error) pending.reject(new Error('OWNER_REJECTED'))
        else pending.done(value.result)
      }
    }
    const p = value.params
    if (p?.threadId !== thread || (p.turnId ?? p.turn?.id) !== turn) return
    if (value.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
      for (const [id, ack] of acknowledgements) {
        const line = p.item.text.split(/\r?\n/).find(line => line === 'ACK ' + id || line.startsWith('ACK ' + id + ' '))
        if (line) ack.reply = line.slice(0, 500)
      }
    }
    if (value.method === 'turn/completed') {
      // An ACK in a failed turn is not successful delivery. The native terminal
      // event must agree with the matching agent message before a receipt wins.
      for (const [id, ack] of acknowledgements) {
        clearTimeout(ack.timer); acknowledgements.delete(id)
        if (p.turn?.status !== 'completed') ack.reject(new Error('TURN_NOT_COMPLETED'))
        else if (!ack.reply) ack.reject(new Error('ACK_REQUIRED'))
        else ack.done(ack.reply)
      }
      // Let an ACK already received in this batch finish its HTTP receipt.
      isConnected = false
      endTimer ??= setTimeout(() => { void lost() }, 1000)
    }
  }
  const verify = async () => {
    if (!isConnected) return false
    let cursor = null
    const seen = new Set()
    do {
      const listed = await request('thread/loaded/list', { cursor, limit: 100 })
      if (!Array.isArray(listed.data)) return false
      if (listed.data.includes(thread)) return true
      cursor = listed.nextCursor ?? null
      if (cursor && (seen.has(cursor) || seen.size > 100)) return false
      seen.add(cursor)
    } while (cursor)
    return false
  }
  try {
    transport = openTransport({ executable, socket, endpoint }, dispatch, () => { void lost() })
    await transport.ready
    await request('initialize', { clientInfo: { name: 'agent-board-message-connector', version: '1' }, capabilities: { experimentalApi: true } })
    transport.write({ method: 'initialized', params: {} })
    if (joinLoaded) {
      if (!await verify()) throw new Error('HOST_NOT_CONNECTED')
      // Native lookup and join are not atomic. An unload race can reload metadata;
      // require active status here and retain expectedTurnId on every delivery.
      const joined = await request('thread/resume', { threadId: thread, excludeTurns: true })
      if (joined?.thread?.id !== thread || !Array.isArray(joined.thread.turns) || joined.thread.turns.length !== 0 || joined.thread.status?.type !== 'active') throw new Error('ACTIVE_THREAD_REQUIRED')
    }
    session = await client.attach({
      agent: 'codex', session: thread, turn, surface, verify,
      canReceive: () => !deliveryFailed,
      onError: error => {
        // processMessage attempts its durable uncertainty receipt before onError.
        // Block further claims meanwhile; transient poll failures keep their lease.
        try { onError?.(error) } finally { if (deliveryFailed) void lost() }
      },
      deliver: async (message, accepted) => {
        let ackEntry
        try {
          if (deliveryFailed || message.turn !== turn || !await verify()) throw new Error('TARGET_MISMATCH')
          const answer = new Promise((done, reject) => {
            const timer = setTimeout(() => { acknowledgements.delete(message.id); reject(new Error('ACK_TIMEOUT')) }, 60_000)
            ackEntry = { done, reject, timer }
            acknowledgements.set(message.id, ackEntry)
          })
          // Install a rejection handler while the steer response is still in flight.
          void answer.catch(() => undefined)
          const result = await request('turn/steer', { threadId: thread, expectedTurnId: turn, input: [{ type: 'text', text: deliveryPrompt(message), text_elements: [] }] })
          if (result.turnId !== turn) throw new Error('TURN_MISMATCH')
          await accepted()
          return await answer
        } catch (error) {
          clearTimeout(ackEntry?.timer); acknowledgements.delete(message.id)
          deliveryFailed = true
          throw error
        }
      },
    })
    // Owner loss can race the board registration response. Never strand its lease.
    if (!isConnected) { await session.close(); throw new Error('OWNER_DISCONNECTED') }
    if (session.closed) void session.closed.then(lost)
    return { ...session, transport: transport.kind, closed, close: lost }
  } catch (error) { await lost(); throw error }
}

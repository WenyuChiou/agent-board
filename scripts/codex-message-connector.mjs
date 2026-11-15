import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ackLine, boardClient, deliveryPrompt } from './message-client.mjs'
import { openWebSocketStdio } from './ws-stdio.mjs'
import { SURFACE_IDS } from '../hooks/messaging.ts'

/** @type {import('./message-client.mjs').MessagingReceiverRecord} */
export const messagingReceiver = {
  host: 'Codex',
  surfaces: [{ name: 'Existing-owner proxy (active turn only)', id: SURFACE_IDS.codexProxy, evidence: 'docs/validation/2026-11-04-codex-cli-proxy-live.md' }],
  tier: 2,
  primitive: 'unknown',
  isImplemented: true,
  agent: 'codex',
  kind: 'turn',
  // It steers a running turn only: an idle session has no route (the run steered a 420 s command's turn).
  routes: {
    idle: { line: 'none', record: null, surfaces: [] },
    working: { line: 'now', record: 'docs/validation/2026-11-04-codex-cli-proxy-live.md', surfaces: [SURFACE_IDS.codexProxy] },
    ended: { line: 'none', record: null, surfaces: [] },
  },
}

// Connects only to an already-running Codex control socket. `proxy` does not start,
// resume or search saved threads. No credential file or transcript is opened here.
export const connectCodexProxy = async ({ boardUrl, executable, thread, turn, surface = SURFACE_IDS.codexProxy, socket, reclaimMs = 10_000, onError }) => {
  if (!isAbsolute(executable) || !/^[a-f0-9-]{36}$/i.test(thread) || !/^[A-Za-z0-9_-]{1,128}$/.test(turn)) throw new Error('EXPLICIT_BINDING_REQUIRED')
  const args = ['app-server', 'proxy', ...(socket ? ['--sock', socket] : [])]
  const child = /\.m?js$/i.test(executable) ? spawn(process.execPath, [executable, ...args], { windowsHide: true }) : spawn(executable, args, { windowsHide: true })
  // A proxy that ignores the kill, or a grandchild holding its stdio, must not hang close().
  const closed = new Promise(done => child.once('close', done))
  const exited = Promise.race([closed, new Promise(done => setTimeout(done, 3000).unref())])
  const requests = new Map(), acknowledgements = new Map()
  let sequence = 0, isConnected = true, session
  const lost = () => {
    isConnected = false
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('OWNER_DISCONNECTED')) }
    requests.clear()
    for (const ack of acknowledgements.values()) { clearTimeout(ack.timer); ack.reject(new Error('OWNER_DISCONNECTED')) }
    acknowledgements.clear()
    void session?.close()
  }
  child.on('error', lost); child.on('exit', lost)
  child.stderr.on('data', () => undefined)
  child.stdin.on('error', lost)
  const request = (method, params) => new Promise((done, reject) => {
    if (!isConnected) { reject(new Error('OWNER_DISCONNECTED')); return }
    const id = ++sequence
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('OWNER_TIMEOUT')) }, 5000)
    requests.set(id, { done, reject, timer })
    try { websocket.send(JSON.stringify({ id, method, params })) }
    catch (error) { clearTimeout(timer); requests.delete(id); reject(error) }
  })
  const websocket = openWebSocketStdio({
    input: child.stdout, output: child.stdin,
    onClose: () => { lost(); child.kill() },
    onMessage: message => {
      let value; try { value = JSON.parse(message) } catch { return }
      if (!value || typeof value !== 'object') return
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
          const line = ackLine(p.item.text, id)
          if (line) { clearTimeout(ack.timer); acknowledgements.delete(id); ack.done(line) }
        }
      }
      if (value.method === 'turn/completed') {
        // Stop advertising availability immediately, but let an ACK already received
        // in this batch finish its HTTP receipt before releasing the lease.
        isConnected = false
        setTimeout(() => { lost(); child.kill() }, 1000)
      }
    },
  })
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
    await websocket.ready
    await request('initialize', { clientInfo: { name: 'agent-board-message-connector', version: '1' } })
    websocket.send(JSON.stringify({ method: 'initialized', params: {} }))
    // The daemon streams a thread's events only to connections subscribed to it, and
    // resuming an already-loaded thread subscribes without starting a turn. Without it
    // the steer lands but the ACK never reaches this connection. Resume only a thread
    // that is already loaded, so a saved thread is never opened from disk.
    if (!await verify()) throw new Error('TARGET_MISMATCH')
    await request('thread/resume', { threadId: thread, excludeTurns: true })
    session = await boardClient(boardUrl).attach({
      agent: 'codex', session: thread, turn, surface, verify, onError, reclaim: reclaimMs,
      deliver: async (message, accepted, begin) => {
        if (message.turn !== turn || !await verify()) throw new Error('TARGET_MISMATCH')
        let ackEntry
        const answer = new Promise((done, reject) => {
          const timer = setTimeout(() => { acknowledgements.delete(message.nonce); reject(new Error('ACK_TIMEOUT')) }, 60_000)
          ackEntry = { done, reject, timer }
          acknowledgements.set(message.nonce, ackEntry)
        })
        // Install a rejection handler while the steer response is still in flight.
        void answer.catch(() => undefined)
        try {
          const prompt = deliveryPrompt(message)
          begin()
          const result = await request('turn/steer', { threadId: thread, expectedTurnId: turn, input: [{ type: 'text', text: prompt, text_elements: [] }] })
          if (result.turnId !== turn) throw new Error('TURN_MISMATCH')
          await accepted()
          clearTimeout(ackEntry.timer)
          return await answer
        } catch (error) {
          clearTimeout(ackEntry.timer); acknowledgements.delete(message.nonce)
          throw error
        }
      },
    })
    // id is read through the session: a reclaimed connection has a new one.
    return { ...session, get id() { return session.id }, close: async () => {
      try { await session.close() }
      finally { websocket.close(); lost(); child.kill(); await exited }
    } }
  } catch (error) { websocket.close(); lost(); child.kill(); await exited; throw error }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let body = ''
    for await (const chunk of process.stdin) { body += chunk; if (body.length > 16000) throw new Error('INPUT_TOO_LARGE') }
    const connection = await connectCodexProxy(JSON.parse(body))
    console.log(JSON.stringify({ connection: connection.id, session: connection.session, turn: connection.turn, transport: 'existing-codex-proxy', ack: 'not-yet-observed' }))
    process.once('SIGINT', () => { void connection.close() })
    process.once('SIGTERM', () => { void connection.close() })
  } catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1 }
}

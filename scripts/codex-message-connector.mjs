import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boardClient, deliveryPrompt } from './message-client.mjs'

// Connects only to an already-running Codex control socket. `proxy` does not start,
// resume or search saved threads. No credential file or transcript is opened here.
export const connectCodexProxy = async ({ boardUrl, executable, thread, turn, surface = 'Codex local proxy', socket, onError }) => {
  if (!isAbsolute(executable) || !/^[a-f0-9-]{36}$/i.test(thread) || !/^[A-Za-z0-9_-]{1,128}$/.test(turn)) throw new Error('EXPLICIT_BINDING_REQUIRED')
  const args = ['app-server', 'proxy', ...(socket ? ['--sock', socket] : [])]
  const child = /\.m?js$/i.test(executable) ? spawn(process.execPath, [executable, ...args], { windowsHide: true }) : spawn(executable, args, { windowsHide: true })
  const requests = new Map(), acknowledgements = new Map()
  let sequence = 0, buffer = '', isConnected = true, session
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
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (buffer.length > 1024 * 1024) { lost(); child.kill(); return }
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      let value; try { value = JSON.parse(line) } catch { continue }
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
      if (p?.threadId !== thread || (p.turnId ?? p.turn?.id) !== turn) continue
      if (value.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
        for (const [id, ack] of acknowledgements) {
          const line = p.item.text.split(/\r?\n/).find(line => line === 'ACK ' + id || line.startsWith('ACK ' + id + ' '))
          if (line) { clearTimeout(ack.timer); acknowledgements.delete(id); ack.done(line.length > 200 ? 'ACK ' + id : line) }
        }
      }
      if (value.method === 'turn/completed') {
        // Stop advertising availability immediately, but let an ACK already received
        // in this batch finish its HTTP receipt before releasing the lease.
        isConnected = false
        setTimeout(() => { lost(); child.kill() }, 1000)
      }
    }
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
    await request('initialize', { clientInfo: { name: 'agent-board-message-connector', version: '1' } })
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
    session = await boardClient(boardUrl).attach({
      agent: 'codex', session: thread, turn, surface, verify, onError,
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
          return await answer
        } catch (error) {
          clearTimeout(ackEntry.timer); acknowledgements.delete(message.nonce)
          throw error
        }
      },
    })
    return { ...session, close: async () => { await session.close(); lost(); child.kill() } }
  } catch (error) { lost(); child.kill(); throw error }
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

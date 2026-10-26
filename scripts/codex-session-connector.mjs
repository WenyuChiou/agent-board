import { boardClient, deliveryPrompt } from './message-client.mjs'

// For an application that already owns a loaded Codex session and its notifications.
// No socket, thread or model is created by attaching this adapter. `session` scope
// means the host can queue a new turn on its own idle session, not a fabricated turn id.
export const attachCodexSession = async ({ boardUrl, transport, thread, state, verifyOwner, surface = 'Codex owned session', onError }) => {
  if (!transport || typeof transport.request !== 'function' || typeof transport.listen !== 'function' || typeof verifyOwner !== 'function' || !await verifyOwner(transport) || typeof state !== 'function' || !/^[a-f0-9-]{36}$/i.test(thread)) throw new Error('VERIFIED_OWNER_REQUIRED')
  let pending = null, isClosed = false
  const verify = async () => {
    if (isClosed || !await verifyOwner(transport)) return false
    const current = state()
    if (current.thread !== thread) return false
    if (!['idle', 'active'].includes(current.status) || current.status === 'idle' && current.turn !== null || current.status === 'active' && (typeof current.turn !== 'string' || !current.turn)) return false
    if (pending?.turn && current.turn !== null && current.turn !== pending.turn) return false
    let cursor = null
    const seen = new Set()
    do {
      const loaded = await transport.request('thread/loaded/list', { cursor, limit: 100 })
      if (!Array.isArray(loaded.data)) return false
      if (loaded.data.includes(thread)) return true
      cursor = loaded.nextCursor ?? null
      if (cursor && (seen.has(cursor) || seen.size >= 100)) return false
      seen.add(cursor)
    } while (cursor)
    return false
  }
  const settle = () => {
    if (!pending?.turn || pending.observed?.turn !== pending.turn || pending.finished?.id !== pending.turn) return
    if (pending.finished.status === 'completed') pending.done(pending.observed.line)
    else pending.reject(new Error('TURN_NOT_COMPLETED'))
  }
  const listen = transport.listen(value => {
    const p = value.params
    if (!pending || p?.threadId !== thread) return
    if (value.method === 'turn/completed' && p.turn?.id) {
      pending.finished = { id: p.turn.id, status: p.turn.status }
      settle()
      return
    }
    if (value.method !== 'item/completed' || p.item?.type !== 'agentMessage') return
    const line = String(p.item.text ?? '').split(/\r?\n/).find(line => line === 'ACK ' + pending.nonce || line.startsWith('ACK ' + pending.nonce + ' '))
    if (!line) return
    pending.observed = { turn: p.turnId, line: line.length > 200 ? 'ACK ' + pending.nonce : line }
    // Keep the owned turn pending through Stop hooks. ACK text may precede native
    // turn/completed; releasing early lets a poll mistake our own turn for a foreign one.
    settle()
  })
  let receiver
  try { receiver = await boardClient(boardUrl).attach({
    agent: 'codex', session: thread, scope: 'session', turn: 'session', surface, verify, onError,
    canReceive: () => !pending && state().status === 'idle' && state().turn === null,
    deliver: async (message, accepted, begin) => {
      if (!await verify() || state().status !== 'idle' || state().turn !== null) throw new Error('SESSION_BUSY')
      let timer
      const answer = new Promise((done, reject) => {
        timer = setTimeout(() => reject(new Error('ACK_TIMEOUT')), 60000)
        pending = { nonce: message.nonce, turn: null, done, reject, observed: null, finished: null }
      })
      void answer.catch(() => undefined)
      try {
        const prompt = deliveryPrompt(message)
        begin()
        const result = await transport.request('turn/start', { threadId: thread, input: [{ type: 'text', text: prompt, text_elements: [] }] })
        if (!result.turn?.id) throw new Error('INVALID_TURN_RESPONSE')
        pending.turn = result.turn.id
        settle()
        await accepted()
        return await answer
      } finally { clearTimeout(timer); pending = null }
    },
  }) } catch (error) { listen?.(); throw error }
  return { ...receiver, close: async () => { isClosed = true; pending?.reject(new Error('OWNER_DISCONNECTED')); await receiver.close(); listen?.() } }
}

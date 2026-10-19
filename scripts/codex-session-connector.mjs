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
    if (!pending && (current.status !== 'idle' || current.turn !== null)) return false
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
  const listen = transport.listen(value => {
    const p = value.params
    if (!pending || value.method !== 'item/completed' || p?.threadId !== thread || p.item?.type !== 'agentMessage') return
    const line = String(p.item.text ?? '').split(/\r?\n/).find(line => line === 'ACK ' + pending.id || line.startsWith('ACK ' + pending.id + ' '))
    if (!line) return
    pending.observed = { turn: p.turnId, line: line.slice(0, 500) }
    if (pending.turn === p.turnId) pending.done(pending.observed.line)
  })
  let receiver
  try { receiver = await boardClient(boardUrl).attach({
    agent: 'codex', session: thread, scope: 'session', turn: 'session', surface, verify, onError,
    deliver: async (message, accepted) => {
      if (!await verify() || state().status !== 'idle' || state().turn !== null) throw new Error('SESSION_BUSY')
      let timer
      const answer = new Promise((done, reject) => {
        timer = setTimeout(() => reject(new Error('ACK_TIMEOUT')), 60000)
        pending = { id: message.id, turn: null, done, reject, observed: null }
      })
      void answer.catch(() => undefined)
      try {
        const result = await transport.request('turn/start', { threadId: thread, input: [{ type: 'text', text: deliveryPrompt(message), text_elements: [] }] })
        if (!result.turn?.id) throw new Error('INVALID_TURN_RESPONSE')
        pending.turn = result.turn.id
        if (pending.observed?.turn === pending.turn) pending.done(pending.observed.line)
        await accepted()
        return await answer
      } finally { clearTimeout(timer); pending = null }
    },
  }) } catch (error) { listen?.(); throw error }
  return { ...receiver, close: async () => { isClosed = true; pending?.reject(new Error('OWNER_DISCONNECTED')); await receiver.close(); listen?.() } }
}

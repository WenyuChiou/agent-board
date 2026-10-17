import { codexRequest } from './exchange-contract.ts'
import { exchange } from './exchange.mjs'

// The application supplies an existing authenticated owner transport and its verifier.
// This module never opens a socket, resumes a session or discovers user credentials.
const bindCodexOwner = async (transport, thread, verifyOwner) => {
  if (typeof verifyOwner !== 'function' || !await verifyOwner(transport)) throw new Error('UNSUPPORTED_OWNER')
  if (!transport.methods?.includes('thread/loaded/list') || !transport.methods?.includes('turn/steer')) throw new Error('UNSUPPORTED_METHOD')
  const request = async (method, params) => {
    let timer
    try {
      return await Promise.race([
        transport.request(method, params),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OWNER_TIMEOUT')), 5000) }),
      ])
    } finally { clearTimeout(timer) }
  }
  const loaded = async () => {
    let cursor = null
    const seen = new Set()
    do {
      const result = await request('thread/loaded/list', { cursor, limit: 100 })
      if (!Array.isArray(result?.data)) throw new Error('INVALID_OWNER_RESPONSE')
      if (result.data.includes(thread)) return true
      cursor = result.nextCursor ?? null
      if (cursor !== null && (typeof cursor !== 'string' || seen.has(cursor))) throw new Error('INVALID_OWNER_RESPONSE')
      seen.add(cursor)
      if (seen.size > 100) throw new Error('OWNER_PAGE_LIMIT')
    } while (cursor !== null)
    return false
  }
  if (!await loaded()) throw new Error('THREAD_NOT_LOADED')
  return {
    // `sending` is called just before the steer request goes out. Up to then nothing
    // has reached Codex, so a failure is a clean refusal, not an uncertain delivery.
    deliver: async (command, sending) => {
      const planned = codexRequest(command, { agent: 'codex', thread, loaded: true, verified: true, canSteer: true })
      if (!await verifyOwner(transport) || !await loaded()) throw new Error('OWNER_UNAVAILABLE')
      sending()
      const result = await request(planned.method, planned.params)
      if (result?.turnId !== command.turn) throw new Error('UNCERTAIN_DELIVERY')
      return { status: 'delivered', turnId: result.turnId }
    },
  }
}

// Bind and check the owner before reserving anything: a thread that is not loaded yet,
// or a verifier that says no, leaves the command queued for a later attempt. After the
// claim, a failure before the steer request is a terminal `rejected`. Only the request
// itself, or the receipt write after it, leaves `uncertain`, and that is never retried.
export const dispatchCodex = async (directory, target, transport, verifyOwner) => {
  if (target?.agent !== 'codex') return { status: 'not-sent', error: 'TARGET_MISMATCH' }
  let owner
  try { owner = await bindCodexOwner(transport, target?.session, verifyOwner) } catch (error) {
    return { status: 'not-sent', error: error.message }
  }
  const claimed = await exchange('take', directory, target)
  if (claimed.status !== 'claimed') return claimed
  const { command } = claimed
  let isSent = false
  try {
    const delivered = await owner.deliver(command, () => { isSent = true })
    const receipt = await exchange('ack', directory, { version: 1, id: command.id, binding: command.binding, status: 'delivered' })
    return { ...delivered, receipt }
  } catch (error) {
    if (isSent) return { status: 'uncertain', error: error.message, receipt: claimed.receipt }
    try {
      const receipt = await exchange('ack', directory, { version: 1, id: command.id, binding: command.binding, status: 'rejected' })
      return { status: 'rejected', error: error.message, receipt }
    } catch (ackError) {
      return { status: 'uncertain', error: error.message + '; ' + ackError.message, receipt: claimed.receipt }
    }
  }
}

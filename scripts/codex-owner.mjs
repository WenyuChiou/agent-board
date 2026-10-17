import { codexRequest } from '../hooks/exchange.ts'
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
    deliver: async command => {
      const planned = codexRequest(command, { agent: 'codex', thread, loaded: true, verified: true, canSteer: true })
      if (!await verifyOwner(transport) || !await loaded()) throw new Error('OWNER_UNAVAILABLE')
      const result = await request(planned.method, planned.params)
      if (result?.turnId !== command.turn) throw new Error('UNCERTAIN_DELIVERY')
      return { status: 'delivered', turnId: result.turnId }
    },
  }
}

// A file receipt reserves the command across reconnects and process restarts. A timeout,
// lost acknowledgement or receipt-write failure never triggers another attempt.
export const dispatchCodex = async (directory, target, transport, verifyOwner) => {
  const claimed = await exchange('take', directory, target)
  if (claimed.status !== 'claimed') return claimed
  try {
    const owner = await bindCodexOwner(transport, claimed.command.session, verifyOwner)
    const delivered = await owner.deliver(claimed.command)
    const receipt = await exchange('ack', directory, { version: 1, id: claimed.command.id, binding: claimed.command.binding, status: 'delivered' })
    return { ...delivered, receipt }
  } catch (error) {
    return { status: 'uncertain', error: error.message, receipt: claimed.receipt }
  }
}

import { boardClient, deliveryPrompt } from './message-client.mjs'

// The host already owns one initialized CLI stream. No process, login, saved
// conversation, editor connection or model call is created by attaching.
export const attachAntigravitySession = async ({ boardUrl, transport, session, state, verifyOwner, surface = 'Antigravity owned CLI stream', onError }) => {
  if (!transport || typeof transport.write !== 'function' || typeof transport.listen !== 'function' || typeof state !== 'function' || typeof verifyOwner !== 'function' || !await verifyOwner(transport) || !/^[a-f0-9-]{36}$/i.test(session)) throw new Error('VERIFIED_OWNER_REQUIRED')
  let pending = null, isClosed = false, receiver
  const verify = async () => {
    const current = state()
    const isOwned = !isClosed && await verifyOwner(transport) && current.session === session && ['idle', 'active'].includes(current.status) && Number.isSafeInteger(current.turns) && current.turns >= 0 && Number.isSafeInteger(current.step) && current.step >= -1
    if (!isOwned) { pending?.reject(new Error('OWNER_DISCONNECTED')); return false }
    return pending ? current.turns >= pending.before && current.turns <= pending.before + 1 : current.status === 'idle'
  }
  const unlisten = transport.listen(value => {
    if (value.event === 'init') { isClosed = true; pending?.reject(new Error('OWNER_REINITIALIZED')); void receiver?.close(); return }
    if (!pending) return
    const step = value.step_update
    if (value.event === 'step_update' && step?.conversation_id === session && step.step_type === 'user_input' && step.state === 'DONE' && Number.isSafeInteger(step.step_index) && step.step_index > pending.step && !pending.acceptance) {
      pending.acceptance = pending.accepted()
      void pending.acceptance.catch(pending.reject)
    }
    const result = value.result
    if (value.event !== 'result' || result?.conversation_id !== session || result.num_turns !== pending.before + 1 || !pending.acceptance) return
    if (result.status !== 'SUCCESS') { pending.reject(new Error('NATIVE_TURN_FAILED')); return }
    const response = String(result.response ?? '')
    const ack = response.split(/\r?\n/).find(line => line === 'ACK ' + pending.id || line.startsWith('ACK ' + pending.id + ' '))
    if (ack) pending.done(ack.slice(0, 500) + '\n' + response.replace(ack, '').trim().slice(0, 3000))
    else pending.reject(new Error('ACK_REQUIRED'))
    // Permission events and ordinary model text never answer native tool approvals.
  })
  try { receiver = await boardClient(boardUrl).attach({
    agent: 'antigravity', session, scope: 'session', turn: 'session', surface, verify, onError,
    deliver: async (message, accepted) => {
      if (!await verify()) throw new Error('HOST_NOT_CONNECTED')
      const current = state()
      if (pending || current.status !== 'idle') throw new Error('SESSION_BUSY')
      let timer
      const answer = new Promise((done, reject) => {
        timer = setTimeout(() => reject(new Error('ACK_TIMEOUT')), 60000)
        pending = { id: message.id, before: current.turns, step: current.step, done, reject, accepted, acceptance: null }
      })
      void answer.catch(() => undefined)
      const attempt = pending
      try {
        await transport.write({ event: 'user', message: { content: deliveryPrompt(message) } })
        const reply = await answer
        await attempt.acceptance
        return reply.trim()
      } finally { clearTimeout(timer); pending = null }
    },
  }) } catch (error) { unlisten?.(); throw error }
  return { ...receiver, close: async () => { isClosed = true; pending?.reject(new Error('OWNER_DISCONNECTED')); await receiver.close(); unlisten?.() } }
}

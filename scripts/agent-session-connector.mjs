import { boardClient, deliveryPrompt } from './message-client.mjs'
import { attachCodexSession } from './codex-session-connector.mjs'
import { attachAntigravitySession } from './antigravity-session-connector.mjs'

export const SUPPORTED_SESSION_AGENTS = Object.freeze([
  'claude', 'codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse',
  'hermes', 'openclaw', 'antigravity', 'deepseek', 'dot', 'duet', 'bot',
])

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/

export const extractAckReply = (response, id) => {
  const text = String(response ?? '')
  const ack = text.split(/\r?\n/).find(line => line === 'ACK ' + id || line.startsWith('ACK ' + id + ' '))
  if (!ack) throw new Error('ACK_REQUIRED')
  const body = text.replace(ack, '').trim().slice(0, 3000)
  return (ack.slice(0, 500) + (body ? '\n' + body : '')).trim()
}

// Universal session connector for any supported AI agent brand that already owns
// a verified live session. No process, login, saved conversation or model call is
// created by attaching this adapter. Ordinary text never approves tool execution or merges.
export const attachAgentSession = async ({
  boardUrl,
  agent,
  session,
  thread,
  transport,
  state,
  verifyOwner,
  surface,
  onError,
  timeoutMs = 60000,
}) => {
  if (!SUPPORTED_SESSION_AGENTS.includes(agent)) throw new Error('UNSUPPORTED_AGENT')
  const targetSession = session ?? thread
  if (agent === 'codex' && transport && typeof transport.request === 'function' && typeof transport.listen === 'function' && typeof transport.sendPrompt !== 'function') {
    return attachCodexSession({ boardUrl, transport, thread: targetSession, state, verifyOwner, surface: surface || 'Codex owned session', onError })
  }
  if (agent === 'antigravity' && transport && typeof transport.write === 'function' && typeof transport.listen === 'function' && typeof transport.sendPrompt !== 'function') {
    return attachAntigravitySession({ boardUrl, transport, session: targetSession, state, verifyOwner, surface: surface || 'Antigravity owned CLI stream', onError })
  }
  if (
    !transport ||
    typeof transport.sendPrompt !== 'function' ||
    typeof state !== 'function' ||
    typeof verifyOwner !== 'function' ||
    !await verifyOwner(transport) ||
    typeof targetSession !== 'string' ||
    !SESSION_ID.test(targetSession)
  ) {
    throw new Error('VERIFIED_OWNER_REQUIRED')
  }

  let pending = null, isClosed = false, receiver
  const verify = async () => {
    const current = state()
    const currentSession = current?.session ?? current?.thread
    const turns = current?.turns ?? 0
    const isOwned =
      !isClosed &&
      await verifyOwner(transport) &&
      currentSession === targetSession &&
      ['idle', 'active'].includes(current?.status) &&
      Number.isSafeInteger(turns) &&
      turns >= 0
    if (!isOwned) {
      pending?.reject(new Error('OWNER_DISCONNECTED'))
      return false
    }
    return pending ? turns >= pending.before && turns <= pending.before + 1 : true
  }

  const unlisten = typeof transport.listen === 'function'
    ? transport.listen(value => {
        if (value?.event === 'init' || value?.event === 'disconnect') {
          isClosed = true
          pending?.reject(new Error('OWNER_DISCONNECTED'))
          void receiver?.close()
        }
      })
    : undefined

  try {
    receiver = await boardClient(boardUrl).attach({
      agent,
      session: targetSession,
      scope: 'session',
      turn: 'session',
      surface: surface || `${agent} owned session`,
      verify,
      onError,
      canReceive: () => !pending && state()?.status === 'idle',
      deliver: async (message, accepted) => {
        if (!await verify()) throw new Error('HOST_NOT_CONNECTED')
        const current = state()
        if (pending || current?.status !== 'idle') throw new Error('SESSION_BUSY')
        const before = current?.turns ?? 0
        let timer
        const attempt = {
          id: message.id,
          before,
          acceptance: null,
          reject: null,
        }
        const markAccepted = () => {
          if (!attempt.acceptance) {
            attempt.acceptance = Promise.resolve().then(() => accepted())
          }
          return attempt.acceptance
        }
        const answer = new Promise((done, reject) => {
          attempt.reject = reject
          timer = setTimeout(() => reject(new Error('ACK_TIMEOUT')), timeoutMs)
          pending = attempt
          Promise.resolve()
            .then(() => transport.sendPrompt(deliveryPrompt(message), {
              id: message.id,
              agent,
              session: targetSession,
              turn: before + 1,
              accepted: markAccepted,
            }))
            .then(async result => {
              await markAccepted()
              const after = state()
              if ((after?.session ?? after?.thread) !== targetSession) throw new Error('SESSION_MISMATCH')
              if (typeof after?.turns === 'number' && after.turns !== before + 1) throw new Error('TURN_MISMATCH')
              const text = typeof result === 'string' ? result : result?.response ?? result?.text ?? ''
              if (result && typeof result === 'object' && result.status && !['completed', 'SUCCESS', 'ok'].includes(result.status)) {
                throw new Error('NATIVE_TURN_FAILED')
              }
              done(extractAckReply(text, message.id))
            })
            .catch(reject)
        })
        void answer.catch(() => undefined)
        try {
          const reply = await answer
          await attempt.acceptance
          return reply
        } finally {
          clearTimeout(timer)
          pending = null
        }
      },
    })
  } catch (error) {
    unlisten?.()
    throw error
  }

  return {
    ...receiver,
    close: async () => {
      isClosed = true
      pending?.reject?.(new Error('OWNER_DISCONNECTED'))
      await receiver.close()
      unlisten?.()
    },
  }
}

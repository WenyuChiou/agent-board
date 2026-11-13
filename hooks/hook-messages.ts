import { address, claimMessages, disconnectMessages, messageReceipt } from './messaging'
import type { Connection, Message, MessageState } from './messaging'
import { sha256 } from './sha256'

export const MAILBOX_CAP = 200
export const mailboxId = (agent: string, session: string): string => `mailbox_${sha256(address(agent, session)).slice(0, 24)}`
export const expireMailboxes = (state: MessageState, now: number): MessageState => {
  const expired = state.mailboxes?.filter(one => one.expires <= now) ?? []
  if (expired.length === 0) return state
  return { ...expired.reduce((next, one) => disconnectMessages(next, one.id, now), state), mailboxes: state.mailboxes!.filter(one => one.expires > now) }
}
export const enrollMailbox = (state: MessageState, agent: string, session: string, surface: string, now: number, ttlMs: number): MessageState => {
  const next = expireMailboxes(state, now)
  const id = mailboxId(agent, session)
  const mailboxes = next.mailboxes ?? []
  if (!mailboxes.some(one => one.id === id) && mailboxes.length >= MAILBOX_CAP) throw new Error('MAILBOX_LIMIT')
  const prior = mailboxes.find(one => one.id === id)
  // A lease that ran out takes its owner and any contest with it: otherwise two owners that ever met block this mailbox for good.
  const { mcpOwner: _owner, mcpLeaseUntil: _until, contested: _contested, ...kept } = prior ?? {}
  const entry: Connection = { ...((prior?.mcpLeaseUntil ?? 0) > now ? prior : kept), id, agent, session, surface, turn: 'session', scope: 'mailbox', expires: now + ttlMs, origin: 'local' }
  return { ...next, mailboxes: [...mailboxes.filter(one => one.id !== id), entry] }
}
export const enrollMcp = (state: MessageState, agent: string, session: string, surface: string, owner: string, folderDigest: string, until: number, now: number, ttlMs: number): MessageState => {
  const next = enrollMailbox(state, agent, session, surface, now, ttlMs)
  return { ...next, mailboxes: next.mailboxes!.map(one => one.id !== mailboxId(agent, session) ? one
    : (one.mcpLeaseUntil ?? 0) > now && (one.contested || one.mcpOwner !== undefined && one.mcpOwner !== owner)
      ? { ...one, contested: true }
      : { ...one, mcpOwner: owner, folderDigest, mcpLeaseUntil: until, contested: false }) }
}
export const takeMailboxMessage = (state: MessageState, agent: string, session: string, surface: string, now: number, ttlMs: number, nonce: string, ref?: string): { state: MessageState; message: Message | null } => {
  const next = enrollMailbox(state, agent, session, surface, now, ttlMs)
  const claimed = claimMessages(next, next.mailboxes!.find(one => one.id === mailboxId(agent, session))!, now, nonce, ref)
  return { state: claimed.state, message: claimed.messages[0] ?? null }
}
// A hook that stopped waiting never showed what the board claimed for it, so it hands the claim back
// and the message is queued again for a later hook (#990). The ACK code stays, for a message shown before.
export const releaseMailboxMessage = (state: MessageState, agent: string, session: string, ref: string, now: number): MessageState => {
  const one = state.messages.find(message => message.target === mailboxId(agent, session) && message.ref === ref && message.status === 'uncertain' && message.error === '')
  if (one === undefined) return state
  const { ref: _ref, ...kept } = one
  return { ...state, messages: state.messages.map(message => message === one ? { ...kept, status: 'queued' as const, claimed: 0, updated: now } : message) }
}
export const acceptMailboxMessage = (state: MessageState, agent: string, session: string, id: string, nonce: string, now: number): MessageState => {
  const target = state.mailboxes?.find(one => one.id === mailboxId(agent, session))
  if (!target) throw new Error('OFFLINE')
  return messageReceipt(state, target, { id, nonce, status: 'accepted' }, now)
}
export const endMailbox = (state: MessageState, agent: string, session: string, now: number): MessageState => ({
  ...disconnectMessages(state, mailboxId(agent, session), now), mailboxes: state.mailboxes?.filter(one => one.id !== mailboxId(agent, session)),
})
export const deliveryTargets = (connections: readonly Connection[], mailboxes: readonly Connection[] = []): Connection[] => [
  ...connections, ...mailboxes.filter(one => !connections.some(live => address(live.agent, live.session) === address(one.agent, one.session))),
]
export const isTurnStart = (agent: string, event: string): boolean => ({
  codex: ['SessionStart', 'UserPromptSubmit'], antigravity: ['SessionStart', 'PreInvocation'],
  gemini: ['SessionStart', 'BeforeAgent'], muse: ['UserPromptSubmit'], cursor: ['sessionStart'],
} as Record<string, string[]>)[agent]?.includes(event) ?? false
export const isSessionEnd = (agent: string, event: string): boolean => agent === 'cursor' ? event === 'sessionEnd' : ['codex', 'gemini', 'muse'].includes(agent) && event === 'SessionEnd'
export const turnStartEnvelope = (agent: string, event: string, text: string, base: string | null = null, session = ''): object => {
  const context = (agent === 'antigravity' || agent === 'codex' && event === 'SessionStart' ? [base, text] : [text]).filter(Boolean).join('\n\n')
  if (agent === 'cursor') return { env: { AGENT_BOARD_SESSION_ID: session, AGENT_BOARD_AGENT: 'cursor' }, additional_context: context }
  if (agent === 'antigravity') return { injectSteps: [event === 'SessionStart' ? { systemMessage: { systemMessage: context } } : { ephemeralMessage: context }] }
  return { ...(agent === 'gemini' ? { decision: 'allow' } : {}), hookSpecificOutput: { hookEventName: event, additionalContext: context } }
}

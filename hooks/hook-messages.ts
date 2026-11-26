import { address, claimMessages, disconnectMessages, isAcceptedOnce, isLeaseOver, MAILBOX_LEASE_MS, messageReceipt } from './messaging'
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
// The turn a hook names (`hostTurn`, Codex's `turn_id`) and whether its take is at a step end (Codex's Stop hook, #319).
export type TakeTurn = { hostTurn?: string; isStepEnd?: boolean }
export const takeMailboxMessage = (state: MessageState, agent: string, session: string, surface: string, now: number, ttlMs: number, nonce: string, ref?: string, turn: TakeTurn = {}): { state: MessageState; message: Message | null } => {
  const enrolled = enrollMailbox(state, agent, session, surface, now, ttlMs)
  const id = mailboxId(agent, session)
  // The mailbox keeps the turn its hook last named, so the board binds an answer queued while that turn runs to it.
  const next = turn.hostTurn === undefined ? enrolled : { ...enrolled, mailboxes: enrolled.mailboxes!.map(one => one.id === id ? { ...one, hostTurn: turn.hostTurn } : one) }
  const claimed = claimMessages(next, next.mailboxes!.find(one => one.id === id)!, now, nonce, ref, false, turn.isStepEnd === true ? turn.hostTurn : undefined)
  return { state: claimed.state, message: claimed.messages[0] ?? null }
}
// A hook that stopped waiting never showed what the board claimed for it, so it hands the claim back
// and the message is queued again for a later hook (#990). The ACK code stays, for a message shown before. Past its lease the
// claim is no longer its to give back: a store a hook writes itself is pruned after the hand-back, not before (#1843).
// A started OpenCode wake (marked by attemptMailboxMessage) is handed back only with isUnsent, which the plugin sets
// when it knows the host was never called (#724); a plain release leaves it as it is. Only an active started wake goes back:
// once it reads "sent, not confirmed" (after 30 minutes) it is the person's to copy, and the board never hands it out again,
// so a hand resend cannot run twice (#1366 review). A message its host accepted is never queued again (#1407).
export const releaseMailboxMessage = (state: MessageState, agent: string, session: string, ref: string, now: number, isUnsent = false): MessageState => {
  const one = state.messages.find(message => message.target === mailboxId(agent, session) && message.ref === ref && message.status === 'uncertain' && message.error === '')
  if (one === undefined || one.attempted !== undefined && !isUnsent || isAcceptedOnce(one) || isLeaseOver(one, now)) return state
  const { ref: _ref, attempted: _attempted, ...kept } = one
  return { ...state, messages: state.messages.map(message => message === one ? { ...kept, status: 'queued' as const, error: '', claimed: 0, updated: now } : message) }
}
// The OpenCode plugin tells the board it is about to wake the session with the message it holds under ref. Only the
// current claim can be marked; asking again with the same ref answers the same, and any other ref has lost the claim. A
// message its host accepted, even one a later receipt made uncertain, has lost it too: waking for it again would run it twice (#1407).
export const attemptMailboxMessage = (state: MessageState, agent: string, session: string, ref: string, now: number): MessageState => {
  const one = state.messages.find(message => message.target === mailboxId(agent, session) && message.ref === ref)
  if (one === undefined || isAcceptedOnce(one)) throw new Error('CLAIM_LOST')
  // Answered again only while it is still an active started wake; a message dismissed or read "sent, not confirmed"
  // since is offered to the person to copy, so a receiver that repeats its attempt must not wake it.
  if (one.attempted !== undefined) {
    if (one.status === 'uncertain' && one.error === '') return state
    throw new Error('CLAIM_LOST')
  }
  if (one.status !== 'uncertain' || one.error !== '' || now - one.claimed >= MAILBOX_LEASE_MS) throw new Error('CLAIM_LOST')
  return { ...state, messages: state.messages.map(message => message === one ? { ...one, attempted: now, updated: now } : message) }
}
export const acceptMailboxMessage = (state: MessageState, agent: string, session: string, id: string, nonce: string, now: number): MessageState => {
  const target = state.mailboxes?.find(one => one.id === mailboxId(agent, session))
  if (!target) throw new Error('OFFLINE')
  return messageReceipt(state, target, { id, nonce, status: 'accepted' }, now)
}
export const endMailbox = (state: MessageState, agent: string, session: string, now: number): MessageState => ({
  ...disconnectMessages(state, mailboxId(agent, session), now), mailboxes: state.mailboxes?.filter(one => one.id !== mailboxId(agent, session)),
})
// `shadows`: whether a live connection takes the place of its session's mailbox (only on a route its record shows, #318).
// One that does not is left out while the mailbox is there, so the card keeps the mailbox's own route.
export const deliveryTargets = (connections: readonly Connection[], mailboxes: readonly Connection[] = [], shadows: (live: Connection) => boolean = () => true): Connection[] => {
  const isSame = (a: Connection, b: Connection): boolean => address(a.agent, a.session) === address(b.agent, b.session)
  return [
    ...connections.filter(live => shadows(live) || !mailboxes.some(one => isSame(one, live))),
    ...mailboxes.filter(one => !connections.some(live => isSame(live, one) && shadows(live))),
  ]
}
export const isTurnStart = (agent: string, event: string): boolean => ({
  codex: ['SessionStart', 'UserPromptSubmit'], antigravity: ['SessionStart', 'PreInvocation'],
  gemini: ['SessionStart', 'BeforeAgent'], muse: ['UserPromptSubmit'], cursor: ['sessionStart'],
} as Record<string, string[]>)[agent]?.includes(event) ?? false
// Codex runs its Stop hook when a step ends, and `decision: block` continues the turn with `reason` as its next input (#319).
// A Stop that a hook already continued says so (`stop_hook_active` true); only one where the field is exactly false hands a
// message over, so no turn is continued without end.
export const isStepEnd = (agent: string, event: string, raw: Record<string, unknown>): boolean => agent === 'codex' && event === 'Stop' && raw.stop_hook_active === false
export const stepEndEnvelope = (text: string): { decision: 'block'; reason: string } => ({ decision: 'block', reason: text })
// The least time a Stop hook needs left to take, print and accept one message; with less it takes nothing.
export const STEP_END_MIN_MS = 1300
export const isSessionEnd = (agent: string, event: string): boolean => agent === 'cursor' ? event === 'sessionEnd' : ['codex', 'gemini', 'muse'].includes(agent) && event === 'SessionEnd'
export const turnStartEnvelope = (agent: string, event: string, text: string, base: string | null = null, session = ''): object => {
  const context = (agent === 'antigravity' || agent === 'codex' && event === 'SessionStart' ? [base, text] : [text]).filter(Boolean).join('\n\n')
  if (agent === 'cursor') return { env: { AGENT_BOARD_SESSION_ID: session, AGENT_BOARD_AGENT: 'cursor' }, additional_context: context }
  if (agent === 'antigravity') return { injectSteps: [event === 'SessionStart' ? { systemMessage: { systemMessage: context } } : { ephemeralMessage: context }] }
  return { ...(agent === 'gemini' ? { decision: 'allow' } : {}), hookSpecificOutput: { hookEventName: event, additionalContext: context } }
}

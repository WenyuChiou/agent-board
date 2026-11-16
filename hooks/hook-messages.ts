import { ANTIGRAVITY_POLL_MS } from './antigravity-sidecar'
import { address, claimMessages, disconnectMessages, MAILBOX_LEASE_MS, messageFields, messageId, messageReceipt, SURFACE_IDS } from './messaging'
import type { Connection, Message, MessageState, RowState } from './messaging'
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
// A started OpenCode wake (marked by attemptMailboxMessage) is handed back only with isUnsent, which the plugin sets
// when it knows the host was never called (#724); a plain release leaves it as it is. Only an active started wake goes back:
// once it reads "sent, not confirmed" (after 30 minutes) it is the person's to copy, and the board never hands it out again,
// so a hand resend cannot run twice (#1366 review).
export const releaseMailboxMessage = (state: MessageState, agent: string, session: string, ref: string, now: number, isUnsent = false): MessageState => {
  const one = state.messages.find(message => message.target === mailboxId(agent, session) && message.ref === ref && message.status === 'uncertain' && message.error === '')
  if (one === undefined || one.attempted !== undefined && !isUnsent) return state
  const { ref: _ref, attempted: _attempted, ...kept } = one
  return { ...state, messages: state.messages.map(message => message === one ? { ...kept, status: 'queued' as const, error: '', claimed: 0, updated: now } : message) }
}
// The OpenCode plugin tells the board it is about to wake the session with the message it holds under ref. Only the
// current claim can be marked; asking again with the same ref answers the same, and any other ref has lost the claim.
export const attemptMailboxMessage = (state: MessageState, agent: string, session: string, ref: string, now: number): MessageState => {
  const one = state.messages.find(message => message.target === mailboxId(agent, session) && message.ref === ref)
  if (one === undefined) throw new Error('CLAIM_LOST')
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
export const isSessionEnd = (agent: string, event: string): boolean => agent === 'cursor' ? event === 'sessionEnd' : ['codex', 'gemini', 'muse'].includes(agent) && event === 'SessionEnd'
export const turnStartEnvelope = (agent: string, event: string, text: string, base: string | null = null, session = ''): object => {
  const context = (agent === 'antigravity' || agent === 'codex' && event === 'SessionStart' ? [base, text] : [text]).filter(Boolean).join('\n\n')
  if (agent === 'cursor') return { env: { AGENT_BOARD_SESSION_ID: session, AGENT_BOARD_AGENT: 'cursor' }, additional_context: context }
  if (agent === 'antigravity') return { injectSteps: [event === 'SessionStart' ? { systemMessage: { systemMessage: context } } : { ephemeralMessage: context }] }
  return { ...(agent === 'gemini' ? { decision: 'allow' } : {}), hookSpecificOutput: { hookEventName: event, additionalContext: context } }
}

// The Antigravity sidecar's wake (#1396; the contract is in hooks/antigravity-sidecar.ts). Each poll is the sidecar's sign that
// it is alive. After a poll that gets no answer it waits its slow interval, so it counts as on for one slow wait and two fast
// polls: one lost answer does not take Send away, and a sidecar that stopped is no longer offered within about half a minute.
export const SIDECAR_ALIVE_MS = ANTIGRAVITY_POLL_MS.slow + 2 * ANTIGRAVITY_POLL_MS.fast
// The owner's plan: a conversation is woken only once it has been idle this long after its turn's end.
export const WAKE_IDLE_MS = 10_000
// Antigravity's own hooks say when a turn runs: its turn-start hook's take marks the mailbox busy, its Stop hook marks it idle.
// A progress report says nothing of this, since a model may report waiting before its turn ends. Only a mailbox is marked.
export const markMailbox = (state: MessageState, agent: string, session: string, field: 'busyAt' | 'idleAt', now: number): MessageState => {
  const id = mailboxId(agent, session), mailboxes = state.mailboxes ?? []
  const mark: Pick<Connection, 'busyAt' | 'idleAt'> = field === 'busyAt' ? { busyAt: now } : { idleAt: now }
  return mailboxes.some(one => one.id === id) ? { ...state, mailboxes: mailboxes.map(one => one.id === id ? { ...one, ...mark } : one) } : state
}
// A message the board sent on the app's route that goes in at once; agy TUI runs no sidecar.
const isWakeMessage = (one: Message): boolean => one.to.startsWith('antigravity:') && one.line === 'now' && one.surface === SURFACE_IDS.antigravityIde
// Worked out from the message, so the board keeps no nonce of its own; the hash never leaves the board.
const wakeNonce = (one: Message): string => sha256(`wake:${one.id}:${one.hash}`).slice(0, 16)
// The nonce of the claim the wake looks ahead to; that claim is never saved.
const PROBE_NONCE = '000000'
// The board's own view of the conversation (its progress rows) must read idle too: the turn-start hook writes its row as
// working, so a turn whose take never reached the board (a busy store, a lost answer) still starts no wake.
export type StateOfSession = (agent: string, session: string) => RowState | undefined
// When the conversation's progress rows were last written, by the writer's clock (undefined: no row, or a row with no
// time). Every hook event and every model report restamps its row, so a row written after the Stop means the
// conversation moved on, whatever its state reads: a waiting report from a turn whose take never reached the board.
export type WrittenOfSession = (agent: string, session: string) => number | undefined
const isWakeDue = (state: MessageState, one: Message, now: number, stateOfSession: StateOfSession, writtenOfSession: WrittenOfSession): boolean => {
  if (one.status !== 'queued' || one.woke !== undefined || !isWakeMessage(one)) return false
  const box = state.mailboxes?.find(mailbox => mailbox.id === one.target && mailbox.surface === one.surface && mailbox.expires > now)
  const idleAt = box?.idleAt
  // Idle only from a Stop later than the last turn start, and for 10 s; a wake started since then has its turn to run.
  if (box === undefined || idleAt === undefined || idleAt <= (box.busyAt ?? 0) || now - idleAt < WAKE_IDLE_MS) return false
  if (stateOfSession(box.agent, box.session) !== 'idle') return false
  // Rows keep whole seconds and the Stop's own row write comes before its call, so that write never holds the wake; a
  // row written later in the Stop's second is not seen.
  const written = writtenOfSession(box.agent, box.session)
  if (written === undefined || written > idleAt) return false
  if (state.messages.some(other => other.to === one.to && other.woke !== undefined && other.woke >= idleAt)) return false
  // Only the message the next turn's hook takes: a wake for any other would start a turn that hands that one over instead.
  return claimMessages(state, box, now, PROBE_NONCE).messages[0]?.id === one.id
}
// What a card says of a queued message's wake: the sidecar's report, a start with no report yet, or, while no sidecar
// polls, that the message waits for the next turn.
export const shownWake = (one: Message, isOn?: boolean): 'sent' | 'failed' | 'started' | 'off' | undefined =>
  one.status !== 'queued' || !isWakeMessage(one) ? undefined : one.wake ?? (one.woke !== undefined ? 'started' : isOn === false ? 'off' : undefined)
// The sidecar's three calls. A refusal is an ok answer with a code, since the sidecar reads any other answer as a board error.
export const wakeAction = (state: MessageState, action: string, body: Record<string, unknown>, now: number, stateOfSession: StateOfSession, writtenOfSession: WrittenOfSession): { state: MessageState; result: object } => {
  if (action === 'wake-poll') {
    messageFields(body, ['agent'])
    if (body.agent !== 'antigravity') throw new Error('INVALID_MAILBOX_CALL')
    // One wake per poll; one handed out whose start never came is handed out again.
    const one = state.messages.find(message => isWakeDue(state, message, now, stateOfSession, writtenOfSession))
    const session = one && state.mailboxes?.find(box => box.id === one.target)?.session
    return { state, result: { wakes: one === undefined ? [] : [{ id: one.id, conversation: session, nonce: wakeNonce(one) }] } }
  }
  messageFields(body, action === 'wake-attempt' ? ['id', 'nonce'] : ['id', 'nonce', 'status', 'error'])
  const id = messageId(body.id), nonce = messageId(body.nonce)
  if (action === 'wake-report' && body.status !== 'sent' && body.status !== 'failed') throw new Error('INVALID_REPORT')
  if (body.error !== undefined) messageId(body.error)
  const one = state.messages.find(message => message.id === id && isWakeMessage(message) && wakeNonce(message) === nonce)
  const marked = (target: Message, change: Partial<Message>) => ({ state: { ...state, messages: state.messages.map(message => message === target ? { ...target, ...change } : message) }, result: { ok: true } })
  if (action === 'wake-attempt') {
    // The board, not the sidecar, keeps a message to one wake: the start is saved before the one answer ok.
    if (one?.woke !== undefined) return { state, result: { ok: false, code: 'WAKE_STARTED' } }
    return one !== undefined && isWakeDue(state, one, now, stateOfSession, writtenOfSession) ? marked(one, { woke: now, updated: now }) : { state, result: { ok: false, code: 'NOT_HELD' } }
  }
  if (one?.woke === undefined) return { state, result: { ok: false, code: 'NOT_STARTED' } }
  // A repeated report is the same report, and a later one never changes the first. Its time stays: the hook may have claimed it since.
  return one.wake !== undefined ? { state, result: { ok: true } } : marked(one, { wake: body.status as 'sent' | 'failed' })
}

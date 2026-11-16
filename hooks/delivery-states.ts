import { address, agentOf, claimMessages, disconnectMessages, dismissMessage, FINISHED_KEEP_MS, isEndedUncertain, isMailboxTarget, MAILBOX_LEASE_MS, MAILBOX_REDELIVERIES, messageReceipt, OPEN_LIMIT_MS, pruneMessages, queueMessage, rebindMessages, textHash, UNCONFIRMED } from './messaging.ts'
import type { Connection, Message, MessageState } from './messaging.ts'
import { sha256 } from './sha256.ts'

// One table of the delivery states a message can be in and the events hooks/messaging.ts handles today, with the state
// each event leads to and the card's line (#1543). It describes the code as it is: tests/delivery-states.test.mjs walks
// every cell against messaging.ts, so a pull request that changes a predicate there changes the cell here, and its
// `## Cases` rows name the cells it changes.

// A state is a status, an error and the flags that change what happens next (`stateOf` reads them).
export const DELIVERY_STATES = [
  // Waiting for its receiver; nothing handed out.
  'queued',
  // Handed to a live receiver, or to a pull that named no claim (board_inbox), with no receipt yet.
  'claimed',
  // Handed to a hook under a name; handed out again once the lease passes, MAILBOX_REDELIVERIES times at most (#990).
  'leased',
  // The same after its last repeat: never handed out again.
  'leaseSpent',
  // An OpenCode claim its plugin has not marked as a wake (#724).
  'wakeClaimed',
  // An OpenCode wake its plugin marked as started: never handed out again.
  'wakeStarted',
  // A live receiver accepted it: its turn runs.
  'accepted',
  // A hook put it into the session's next turn; no ACK is expected.
  'handed',
  // A mailbox caller that can ACK took it (roadmap invariant 4).
  'acceptedAwaitsAck',
  // The OpenCode host took the wake (a 204 answer); no ACK yet.
  'wakeAccepted',
  // Accepted by a live receiver or a caller that can ACK, then its connection went (DISCONNECTED) or it sent an error.
  'acceptedLost',
  // Put into a turn by a hook, then its mailbox ended: it still counts as delivered and holds nothing.
  'handedLost',
  // Uncertain with an error that says the delivery turn ended (ENDED_UNCERTAIN_ERRORS).
  'turnEnded',
  // Uncertain with any other receiver error, such as a transport timeout: the delivery may still run.
  'inDoubt',
  // Handed out, then its connection went before any receipt.
  'disconnected',
  // An OpenCode wake with no receipt 30 minutes on: "sent, not confirmed" (#1366).
  'unconfirmed',
  'acknowledged',
  'rejected',
  // Taken back by the person while queued.
  'takenBack',
  // Dismissed by the person after it was handed out.
  'dismissed',
  // The board gave up on it at the open limit.
  'expired',
] as const
export type DeliveryState = typeof DELIVERY_STATES[number]

export const DELIVERY_EVENTS = [
  // Its own binding takes messages (claimMessages) a second after the message last changed; a mailbox claim is named, as a hook's is.
  'claim',
  // The same once the mailbox lease has passed.
  'claimLate',
  // Receipts (messageReceipt) with the message's ACK code: accepted, acknowledged, rejected, uncertain with TURN_ABORTED,
  // uncertain with TIMEOUT, and uncertain with no error.
  'accept', 'ack', 'reject', 'fail', 'timeout', 'unsure',
  // The person takes it back or dismisses it (dismissMessage).
  'dismiss',
  // Its connection goes (disconnectMessages), or an automatic receiver leaves and keeps its queue (keepQueued).
  'disconnect', 'leave',
  // A new live connection of the same session takes over what a gone one left queued (rebindMessages).
  'rebind',
  // pruneMessages a second past the open limit, and a second past a day.
  'openLimit', 'dayLimit',
] as const
export type DeliveryEvent = typeof DELIVERY_EVENTS[number]

// What an event does: the next state, with `sent:` when the event hands the message to a receiver; `gone` when it
// leaves the store; or the error the board answers, the message unchanged.
export type Refusal = 'CLAIM_REQUIRED' | 'MESSAGE_DISMISSED' | 'MESSAGE_EXPIRED' | 'MESSAGE_FINISHED' | 'RECEIPT_CONFLICT'
export type Outcome = DeliveryState | `sent:${DeliveryState}` | 'gone' | Refusal
export type DeliveryRow = {
  // A new message from the board to the same session is refused (PAIR_BUSY) while this one is in this state.
  holdsSend: boolean
  // No other queued message of the session is handed out while this one is in this state: its turn may still run.
  holdsStart: boolean
  // The card's line, a key of the strings tables: on a card of any agent but Claude (default route, after the
  // 15-second handoff window), and on a Claude card (null: no line).
  card: string
  claudeCard: string | null
  on: Record<DeliveryEvent, Outcome>
}

const isOpenCode = (one: Pick<Message, 'to'>): boolean => one.to.startsWith('opencode:')
export const stateOf = (one: Message): DeliveryState => {
  if (one.status === 'queued' || one.status === 'acknowledged') return one.status
  if (one.status === 'rejected') return one.error === 'DISMISSED' ? 'takenBack' : 'rejected'
  if (one.status === 'accepted') {
    if (one.error !== '') return isMailboxTarget(one.target) && one.awaitsAck !== true ? 'handedLost' : 'acceptedLost'
    if (!isMailboxTarget(one.target)) return 'accepted'
    return one.awaitsAck !== true ? 'handed' : isOpenCode(one) ? 'wakeAccepted' : 'acceptedAwaitsAck'
  }
  if (one.error === 'EXPIRED') return 'expired'
  if (one.error === 'DISMISSED') return 'dismissed'
  if (one.error === UNCONFIRMED) return 'unconfirmed'
  if (one.error === 'DISCONNECTED') return 'disconnected'
  if (isEndedUncertain(one)) return 'turnEnded'
  if (one.error !== '') return 'inDoubt'
  if (one.ref === undefined || !isMailboxTarget(one.target)) return 'claimed'
  if (isOpenCode(one)) return one.attempted === undefined ? 'wakeClaimed' : 'wakeStarted'
  return (one.redelivered ?? 0) < MAILBOX_REDELIVERIES ? 'leased' : 'leaseSpent'
}

// One synthetic message for each state, with the binding that holds it.
export const SAMPLE_NOW = Date.UTC(2026, 10, 15, 12)
const SECOND = 1000
const FAR = SAMPLE_NOW + 400 * 24 * 60 * 60 * SECOND
type Via = 'live' | 'mailbox'
export const sampleBinding = (agent: string, via: Via): Connection => via === 'live'
  ? { id: 'c1', agent, session: 's1', surface: 'CLI', turn: 't1', scope: 'session', expires: FAR }
  : { id: `mailbox_${sha256(address(agent, 's1')).slice(0, 24)}`, agent, session: 's1', surface: 'CLI', turn: 'session', scope: 'mailbox', expires: FAR }
type Sample = Partial<Message> & { agent?: 'opencode'; via: Via }
const out = { claimed: SAMPLE_NOW, nonce: 'n1' } as const
const SAMPLES: Record<DeliveryState, Sample> = {
  queued: { via: 'live' },
  claimed: { via: 'live', status: 'uncertain', ...out },
  leased: { via: 'mailbox', status: 'uncertain', ref: 'r1', ...out },
  leaseSpent: { via: 'mailbox', status: 'uncertain', ref: 'r1', redelivered: MAILBOX_REDELIVERIES, ...out },
  wakeClaimed: { agent: 'opencode', via: 'mailbox', status: 'uncertain', ref: 'r1', ...out },
  wakeStarted: { agent: 'opencode', via: 'mailbox', status: 'uncertain', ref: 'r1', attempted: SAMPLE_NOW, ...out },
  accepted: { via: 'live', status: 'accepted', ...out },
  handed: { via: 'mailbox', status: 'accepted', ref: 'r1', ...out },
  acceptedAwaitsAck: { via: 'mailbox', status: 'accepted', awaitsAck: true, ...out },
  wakeAccepted: { agent: 'opencode', via: 'mailbox', status: 'accepted', awaitsAck: true, ref: 'r1', attempted: SAMPLE_NOW, ...out },
  acceptedLost: { via: 'live', status: 'accepted', error: 'DISCONNECTED', ...out },
  handedLost: { via: 'mailbox', status: 'accepted', error: 'DISCONNECTED', ref: 'r1', ...out },
  turnEnded: { via: 'live', status: 'uncertain', error: 'TURN_ABORTED', ...out },
  inDoubt: { via: 'live', status: 'uncertain', error: 'TIMEOUT', ...out },
  disconnected: { via: 'live', status: 'uncertain', error: 'DISCONNECTED', ...out },
  unconfirmed: { agent: 'opencode', via: 'mailbox', status: 'uncertain', error: UNCONFIRMED, ref: 'r1', attempted: SAMPLE_NOW, ...out },
  acknowledged: { via: 'live', status: 'acknowledged', reply: 'ACK n1', text: '', ...out },
  rejected: { via: 'live', status: 'rejected', text: '', ...out },
  takenBack: { via: 'live', status: 'rejected', error: 'DISMISSED', text: '' },
  dismissed: { via: 'live', status: 'uncertain', error: 'DISMISSED', text: '', ...out },
  expired: { via: 'live', status: 'uncertain', error: 'EXPIRED', text: '', ...out },
}
const messageOf = (binding: Connection, fields: Partial<Message>): Message => ({
  id: 'm1', target: binding.id, turn: binding.turn, from: 'board', to: address(binding.agent, binding.session), text: 'hello', hash: textHash('hello'),
  origin: 'local', status: 'queued', updated: SAMPLE_NOW, reply: '', error: '', hops: 1, claimed: 0, nonce: '', ...fields,
})
export const sampleOf = (name: DeliveryState): { message: Message; binding: Connection; state: MessageState } => {
  const { agent = 'codex', via, ...fields } = SAMPLES[name]
  const binding = sampleBinding(agent, via)
  const message = messageOf(binding, fields)
  return { message, binding, state: { messages: [message], mailboxes: via === 'mailbox' ? [binding] : [] } }
}

export type Step = { state: MessageState; sent: readonly Message[] }
// Applies one event to a store as the board does. Throws the board's own error when it refuses the event.
export const applyEvent = (state: MessageState, one: Message, binding: Connection, event: DeliveryEvent, nonce = 'n2', ref = 'r2'): Step => {
  const at = one.updated + SECOND
  const claim = (now: number): Step => {
    const result = claimMessages(state, binding, now, nonce, binding.scope === 'mailbox' ? ref : undefined)
    return { state: result.state, sent: result.messages }
  }
  const receipt = (status: Message['status'], error?: string): Step => ({ state: messageReceipt(state, binding, {
    id: one.id, nonce: one.nonce, status, ...(status === 'acknowledged' ? { reply: `ACK ${one.nonce}` } : {}), ...(error === undefined ? {} : { error }),
  }, at), sent: [] })
  const kept = (next: MessageState): Step => ({ state: next, sent: [] })
  switch (event) {
    case 'claim': return claim(at)
    case 'claimLate': return claim(one.claimed + MAILBOX_LEASE_MS)
    case 'accept': return receipt('accepted')
    case 'ack': return receipt('acknowledged')
    case 'reject': return receipt('rejected')
    case 'fail': return receipt('uncertain', 'TURN_ABORTED')
    case 'timeout': return receipt('uncertain', 'TIMEOUT')
    case 'unsure': return receipt('uncertain')
    case 'dismiss': return kept(dismissMessage(state, one.id, at))
    case 'disconnect': return kept(disconnectMessages(state, one.target, at))
    case 'leave': return kept(disconnectMessages(state, one.target, at, true))
    case 'rebind': return kept(rebindMessages(state, { ...sampleBinding(agentOf(one.to), 'live'), id: 'c2', turn: 't2' }, id => id === 'c2'))
    case 'openLimit': return kept(pruneMessages(state, one.updated + OPEN_LIMIT_MS + SECOND))
    case 'dayLimit': return kept(pruneMessages(state, one.updated + FINISHED_KEEP_MS + SECOND))
  }
}
export const observe = (name: DeliveryState, event: DeliveryEvent): Outcome => {
  const { message, binding, state } = sampleOf(name)
  let step: Step
  try {
    step = applyEvent(state, message, binding, event)
  } catch (error) {
    return (error as Error).message as Refusal
  }
  const after = step.state.messages.find(one => one.id === message.id)
  if (after === undefined) return 'gone'
  return step.sent.some(one => one.id === message.id) ? `sent:${stateOf(after)}` : stateOf(after)
}
// Whether a message in this state holds its session: a second send from the board, and a second queued message's start.
export const observeHolds = (name: DeliveryState): Pick<DeliveryRow, 'holdsSend' | 'holdsStart'> => {
  const { message, binding, state } = sampleOf(name)
  const at = message.updated + SECOND
  let holdsSend = false
  try {
    queueMessage(state, { id: 'm2', target: binding.id, turn: binding.turn, text: 'next' }, 'board', binding, at)
  } catch (error) {
    if ((error as Error).message !== 'PAIR_BUSY') throw error
    holdsSend = true
  }
  const next = messageOf(binding, { id: 'm2', text: 'next', hash: textHash('next'), updated: at })
  const claimed = claimMessages({ ...state, messages: [next, message] }, binding, at, 'n2', binding.scope === 'mailbox' ? 'r2' : undefined)
  return { holdsSend, holdsStart: !claimed.messages.some(one => one.id === 'm2') }
}

// Today's behaviour, cell by cell. A cell where the code looks wrong stays as the code does it and is named in
// SUSPECT_CELLS below.
export const DELIVERY_TABLE: Record<DeliveryState, DeliveryRow> = {
  queued: { holdsSend: true, holdsStart: false, card: 'messagesQueued', claudeCard: 'claudeSendWorking', on: {
    claim: 'sent:claimed', claimLate: 'sent:claimed', accept: 'CLAIM_REQUIRED', ack: 'CLAIM_REQUIRED', reject: 'CLAIM_REQUIRED', fail: 'CLAIM_REQUIRED', timeout: 'CLAIM_REQUIRED', unsure: 'CLAIM_REQUIRED',
    dismiss: 'takenBack', disconnect: 'rejected', leave: 'queued', rebind: 'queued', openLimit: 'queued', dayLimit: 'queued' } },
  claimed: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'claimed', claimLate: 'claimed', accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    dismiss: 'dismissed', disconnect: 'disconnected', leave: 'disconnected', rebind: 'claimed', openLimit: 'expired', dayLimit: 'expired' } },
  leased: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'leased', claimLate: 'sent:leased', accept: 'handed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'leased',
    dismiss: 'dismissed', disconnect: 'disconnected', leave: 'disconnected', rebind: 'leased', openLimit: 'expired', dayLimit: 'expired' } },
  leaseSpent: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'leaseSpent', claimLate: 'leaseSpent', accept: 'handed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'leaseSpent',
    dismiss: 'dismissed', disconnect: 'disconnected', leave: 'disconnected', rebind: 'leaseSpent', openLimit: 'expired', dayLimit: 'expired' } },
  wakeClaimed: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'sent:wakeClaimed', claimLate: 'sent:wakeClaimed', accept: 'handed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'wakeClaimed',
    dismiss: 'dismissed', disconnect: 'disconnected', leave: 'disconnected', rebind: 'wakeClaimed', openLimit: 'queued', dayLimit: 'queued' } },
  wakeStarted: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'wakeStarted', claimLate: 'wakeStarted', accept: 'handed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'wakeStarted',
    dismiss: 'dismissed', disconnect: 'wakeStarted', leave: 'wakeStarted', rebind: 'wakeStarted', openLimit: 'unconfirmed', dayLimit: 'unconfirmed' } },
  accepted: { holdsSend: true, holdsStart: true, card: 'messagesAccepted', claudeCard: 'claudeDelivered', on: {
    claim: 'accepted', claimLate: 'accepted', accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    dismiss: 'dismissed', disconnect: 'acceptedLost', leave: 'acceptedLost', rebind: 'accepted', openLimit: 'accepted', dayLimit: 'accepted' } },
  handed: { holdsSend: false, holdsStart: false, card: 'messagesHandedNow', claudeCard: 'claudeDelivered', on: {
    claim: 'handed', claimLate: 'handed', accept: 'handed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'leased',
    dismiss: 'dismissed', disconnect: 'handedLost', leave: 'handedLost', rebind: 'handed', openLimit: 'expired', dayLimit: 'expired' } },
  acceptedAwaitsAck: { holdsSend: true, holdsStart: true, card: 'messagesHandedNow', claudeCard: 'claudeDelivered', on: {
    claim: 'acceptedAwaitsAck', claimLate: 'acceptedAwaitsAck', accept: 'acceptedAwaitsAck', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    dismiss: 'dismissed', disconnect: 'acceptedLost', leave: 'acceptedLost', rebind: 'acceptedAwaitsAck', openLimit: 'expired', dayLimit: 'expired' } },
  wakeAccepted: { holdsSend: true, holdsStart: true, card: 'messagesHandedNow', claudeCard: 'claudeDelivered', on: {
    claim: 'wakeAccepted', claimLate: 'wakeAccepted', accept: 'wakeAccepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'wakeStarted',
    dismiss: 'dismissed', disconnect: 'wakeAccepted', leave: 'wakeAccepted', rebind: 'wakeAccepted', openLimit: 'unconfirmed', dayLimit: 'unconfirmed' } },
  acceptedLost: { holdsSend: true, holdsStart: true, card: 'messagesAcceptedDisconnected', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'acceptedLost', claimLate: 'acceptedLost', accept: 'acceptedLost', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    dismiss: 'dismissed', disconnect: 'acceptedLost', leave: 'acceptedLost', rebind: 'acceptedLost', openLimit: 'expired', dayLimit: 'expired' } },
  handedLost: { holdsSend: false, holdsStart: false, card: 'messagesHandedNow', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'handedLost', claimLate: 'handedLost', accept: 'handedLost', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'leased',
    dismiss: 'dismissed', disconnect: 'handedLost', leave: 'handedLost', rebind: 'handedLost', openLimit: 'expired', dayLimit: 'expired' } },
  turnEnded: { holdsSend: false, holdsStart: false, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'turnEnded', claimLate: 'turnEnded', accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    dismiss: 'dismissed', disconnect: 'turnEnded', leave: 'turnEnded', rebind: 'turnEnded', openLimit: 'expired', dayLimit: 'expired' } },
  inDoubt: { holdsSend: true, holdsStart: true, card: 'messagesTimeout', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'inDoubt', claimLate: 'inDoubt', accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    dismiss: 'dismissed', disconnect: 'inDoubt', leave: 'inDoubt', rebind: 'inDoubt', openLimit: 'expired', dayLimit: 'expired' } },
  disconnected: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'disconnected', claimLate: 'disconnected', accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    dismiss: 'dismissed', disconnect: 'disconnected', leave: 'disconnected', rebind: 'disconnected', openLimit: 'expired', dayLimit: 'expired' } },
  unconfirmed: { holdsSend: false, holdsStart: false, card: 'messagesSentUnconfirmed', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'unconfirmed', claimLate: 'unconfirmed', accept: 'unconfirmed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'wakeStarted',
    dismiss: 'dismissed', disconnect: 'unconfirmed', leave: 'unconfirmed', rebind: 'unconfirmed', openLimit: 'unconfirmed', dayLimit: 'expired' } },
  acknowledged: { holdsSend: false, holdsStart: false, card: 'messagesAcknowledged', claudeCard: 'claudeGotIt', on: {
    claim: 'acknowledged', claimLate: 'acknowledged', accept: 'RECEIPT_CONFLICT', ack: 'acknowledged', reject: 'RECEIPT_CONFLICT', fail: 'RECEIPT_CONFLICT', timeout: 'RECEIPT_CONFLICT', unsure: 'RECEIPT_CONFLICT',
    dismiss: 'MESSAGE_FINISHED', disconnect: 'acknowledged', leave: 'acknowledged', rebind: 'acknowledged', openLimit: 'acknowledged', dayLimit: 'gone' } },
  rejected: { holdsSend: false, holdsStart: false, card: 'messagesRejected', claudeCard: 'messagesRejected', on: {
    claim: 'rejected', claimLate: 'rejected', accept: 'RECEIPT_CONFLICT', ack: 'RECEIPT_CONFLICT', reject: 'rejected', fail: 'RECEIPT_CONFLICT', timeout: 'RECEIPT_CONFLICT', unsure: 'RECEIPT_CONFLICT',
    dismiss: 'MESSAGE_FINISHED', disconnect: 'rejected', leave: 'rejected', rebind: 'rejected', openLimit: 'rejected', dayLimit: 'gone' } },
  takenBack: { holdsSend: false, holdsStart: false, card: 'messagesRejected', claudeCard: null, on: {
    claim: 'takenBack', claimLate: 'takenBack', accept: 'MESSAGE_DISMISSED', ack: 'MESSAGE_DISMISSED', reject: 'MESSAGE_DISMISSED', fail: 'MESSAGE_DISMISSED', timeout: 'MESSAGE_DISMISSED', unsure: 'MESSAGE_DISMISSED',
    dismiss: 'MESSAGE_FINISHED', disconnect: 'takenBack', leave: 'takenBack', rebind: 'takenBack', openLimit: 'takenBack', dayLimit: 'gone' } },
  dismissed: { holdsSend: false, holdsStart: false, card: 'messagesUncertain', claudeCard: null, on: {
    claim: 'dismissed', claimLate: 'dismissed', accept: 'MESSAGE_DISMISSED', ack: 'MESSAGE_DISMISSED', reject: 'MESSAGE_DISMISSED', fail: 'MESSAGE_DISMISSED', timeout: 'MESSAGE_DISMISSED', unsure: 'MESSAGE_DISMISSED',
    dismiss: 'MESSAGE_FINISHED', disconnect: 'dismissed', leave: 'dismissed', rebind: 'dismissed', openLimit: 'dismissed', dayLimit: 'gone' } },
  expired: { holdsSend: false, holdsStart: false, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'expired', claimLate: 'expired', accept: 'MESSAGE_EXPIRED', ack: 'MESSAGE_EXPIRED', reject: 'MESSAGE_EXPIRED', fail: 'MESSAGE_EXPIRED', timeout: 'MESSAGE_EXPIRED', unsure: 'MESSAGE_EXPIRED',
    dismiss: 'MESSAGE_FINISHED', disconnect: 'expired', leave: 'expired', rebind: 'expired', openLimit: 'expired', dayLimit: 'gone' } },
}

// Cells where today's code looks wrong (#1543, Not covered). The table states what the code does; the test's random
// orders do not pass through them, so it keeps checking the three rules on every other order, until an issue settles each.
export const SUSPECT_CELLS: readonly (readonly [DeliveryState, DeliveryEvent])[] = [
  // An uncertain receipt with no error takes an accept back: a mailbox message a receiver accepted is a named claim again,
  // and once its lease passes it is handed out again (sent twice). The random orders found it from handedLost: an
  // OpenCode message accepted, its mailbox ended, an uncertain receipt, the lease, a new take.
  ['accepted', 'unsure'], ['handed', 'unsure'], ['acceptedAwaitsAck', 'unsure'], ['wakeAccepted', 'unsure'], ['acceptedLost', 'unsure'], ['handedLost', 'unsure'],
  // A wake that reads "sent, not confirmed" holds its session again on an uncertain receipt, while a late accept is kept
  // from doing so (#1366 review).
  ['unconfirmed', 'unsure'], ['unconfirmed', 'timeout'],
]
// A suspect cell, or the same receipt on any message accepted before (`hasAccepted`), which the states do not tell apart.
export const isSuspect = (one: Message, event: DeliveryEvent): boolean =>
  SUSPECT_CELLS.some(([state, cell]) => state === stateOf(one) && cell === event) || event === 'unsure' && one.hasAccepted === true

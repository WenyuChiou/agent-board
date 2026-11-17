import { attemptMailboxMessage, releaseMailboxMessage } from './hook-messages.ts'
import { address, claimMessages, disconnectMessages, dismissMessage, FINISHED_KEEP_MS, isEndedUncertain, isMailboxTarget, isOpen, MAILBOX_LEASE_MS, MAILBOX_REDELIVERIES, MCP_SURFACE, messageReceipt, OPEN_LIMIT_MS, pruneMessages, queueMessage, rebindMessages, textHash, UNCONFIRMED } from './messaging.ts'
import type { Connection, Message, MessageState } from './messaging.ts'
import { sha256 } from './sha256.ts'

// One table of the delivery states a message can be in and the events hooks/messaging.ts and hooks/hook-messages.ts handle
// today, with the state each event leads to and the card's line (#1543). It describes the code as it is:
// tests/delivery-states.test.mjs walks every cell against the code and every card line against the page's own selector, so a
// pull request that changes a predicate changes the cell here, and its `## Cases` rows name the cells it changes.

// A state is a status, an error and the flags that decide what happens next (`stateOf` reads them). A flag that changes
// only some cells or the card is a shape of the state (`shapesOf`), with its own cells in the row.
export const DELIVERY_STATES = [
  // Waiting: for a live receiver, for a hook's mailbox, for an OpenCode plugin's mailbox.
  'queued', 'queuedForHook', 'queuedForWake',
  // Handed to a live receiver with no receipt yet; handed to an unnamed pull of its mailbox (board_inbox).
  'claimed', 'pulled',
  // Handed to a hook under a name; handed out again once the lease passes, MAILBOX_REDELIVERIES times at most (#990).
  'leased',
  // The same after its last repeat: never handed out again.
  'leaseSpent',
  // An OpenCode claim its plugin has not marked as a wake, and one it marked as started (never handed out again, #724).
  'wakeClaimed', 'wakeStarted',
  // A live receiver accepted it: its turn runs.
  'accepted',
  // A hook put it into the session's next turn; no ACK is expected.
  'handed',
  // A mailbox caller that can ACK took it (roadmap invariant 4), and the OpenCode host took a wake (a 204 answer).
  'acceptedAwaitsAck', 'wakeAccepted',
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
  'acknowledged', 'rejected',
  // Taken back by the person while queued; dismissed after it was handed out.
  'takenBack', 'dismissed',
  // The board gave up on it at the open limit; an OpenCode message the host had accepted, which still takes a late ACK.
  'expired', 'wakeExpired',
] as const
export type DeliveryState = typeof DELIVERY_STATES[number]

export const DELIVERY_EVENTS = [
  // Its own binding takes messages (claimMessages) a second after the message last changed, and once the mailbox lease has
  // passed; a mailbox claim is named, as a hook's is. Then the agent's own MCP pull: an unnamed claim on its mailbox.
  'claim', 'claimLate', 'pull',
  // Receipts (messageReceipt) with the message's ACK code: accepted, acknowledged, rejected, uncertain with TURN_ABORTED,
  // uncertain with TIMEOUT, and uncertain with no error.
  'accept', 'ack', 'reject', 'fail', 'timeout', 'unsure',
  // OpenCode's plugin marks the wake it starts (attemptMailboxMessage); a hook hands its claim back (releaseMailboxMessage),
  // and OpenCode's plugin hands back a wake it never sent (isUnsent).
  'attempt', 'release', 'releaseUnsent',
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
export type Refusal = 'CLAIM_REQUIRED' | 'CLAIM_LOST' | 'INVALID_MAILBOX_CALL' | 'MESSAGE_DISMISSED' | 'MESSAGE_EXPIRED' | 'MESSAGE_FINISHED' | 'RECEIPT_CONFLICT'
export type Outcome = DeliveryState | `sent:${DeliveryState}` | 'gone' | Refusal
type Cells = Record<DeliveryEvent, Outcome>
// A shape lists only what differs from its row.
export type DeliveryShape = { holdsSend?: boolean; holdsStart?: boolean; card?: string; claudeCard?: string | null; on?: Partial<Cells> }
export type DeliveryRow = {
  // A new message from the board to the same session is refused (PAIR_BUSY) while this one is in this state.
  holdsSend: boolean
  // No other queued message of the session is handed out while this one is in this state: its turn may still run.
  holdsStart: boolean
  // The card's line, a key of the strings tables, as the page picks it (receiptLine and claudeReceipt in hooks/serve.ts):
  // on a card of any agent but Claude (default route, after the 15-second handoff window), and on a Claude card (null: no line).
  card: string
  claudeCard: string | null
  on: Cells
  shapes?: Readonly<Record<string, DeliveryShape>>
}

const isOpenCode = (one: Pick<Message, 'to'>): boolean => one.to.startsWith('opencode:')
export const stateOf = (one: Message): DeliveryState => {
  const isMailbox = isMailboxTarget(one.target)
  if (one.status === 'queued') return !isMailbox ? 'queued' : isOpenCode(one) ? 'queuedForWake' : 'queuedForHook'
  if (one.status === 'acknowledged') return 'acknowledged'
  if (one.status === 'rejected') return one.error === 'DISMISSED' ? 'takenBack' : 'rejected'
  if (one.status === 'accepted') {
    if (one.error !== '') return isMailbox && one.awaitsAck !== true ? 'handedLost' : 'acceptedLost'
    if (!isMailbox) return 'accepted'
    return one.awaitsAck !== true ? 'handed' : isOpenCode(one) ? 'wakeAccepted' : 'acceptedAwaitsAck'
  }
  // messageReceipt takes a late ACK for an expired OpenCode message the host had accepted.
  if (one.error === 'EXPIRED') return isOpenCode(one) && one.hasAccepted === true ? 'wakeExpired' : 'expired'
  if (one.error === 'DISMISSED') return 'dismissed'
  if (one.error === UNCONFIRMED) return 'unconfirmed'
  if (one.error === 'DISCONNECTED') return 'disconnected'
  if (isEndedUncertain(one)) return 'turnEnded'
  if (one.error !== '') return 'inDoubt'
  if (!isMailbox) return 'claimed'
  if (one.ref === undefined) return 'pulled'
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
type Shape = Partial<Message> & { agent?: 'opencode'; via?: Via }
const REF = '0123456789ab'
const out = { claimed: SAMPLE_NOW, nonce: 'a1b2c3' } as const
const wake = { agent: 'opencode', via: 'mailbox', ref: REF, attempted: SAMPLE_NOW, ...out } as const
const SAMPLES: Record<DeliveryState, Sample> = {
  queued: { via: 'live' },
  queuedForHook: { via: 'mailbox' },
  queuedForWake: { agent: 'opencode', via: 'mailbox' },
  claimed: { via: 'live', status: 'uncertain', ...out },
  pulled: { via: 'mailbox', status: 'uncertain', ...out },
  leased: { via: 'mailbox', status: 'uncertain', ref: REF, ...out },
  leaseSpent: { via: 'mailbox', status: 'uncertain', ref: REF, redelivered: MAILBOX_REDELIVERIES, ...out },
  wakeClaimed: { agent: 'opencode', via: 'mailbox', status: 'uncertain', ref: REF, ...out },
  wakeStarted: { ...wake, status: 'uncertain' },
  accepted: { via: 'live', status: 'accepted', ...out },
  handed: { via: 'mailbox', status: 'accepted', ref: REF, ...out },
  acceptedAwaitsAck: { via: 'mailbox', status: 'accepted', awaitsAck: true, ref: REF, ...out },
  wakeAccepted: { ...wake, status: 'accepted', awaitsAck: true },
  acceptedLost: { via: 'live', status: 'accepted', error: 'DISCONNECTED', ...out },
  handedLost: { via: 'mailbox', status: 'accepted', error: 'DISCONNECTED', ref: REF, ...out },
  turnEnded: { via: 'live', status: 'uncertain', error: 'TURN_ABORTED', ...out },
  inDoubt: { via: 'live', status: 'uncertain', error: 'TIMEOUT', ...out },
  disconnected: { via: 'live', status: 'uncertain', error: 'DISCONNECTED', ...out },
  unconfirmed: { ...wake, status: 'uncertain', error: UNCONFIRMED },
  acknowledged: { via: 'live', status: 'acknowledged', reply: 'ACK a1b2c3', text: '', ...out },
  rejected: { via: 'live', status: 'rejected', text: '', ...out },
  takenBack: { via: 'live', status: 'rejected', error: 'DISMISSED', text: '' },
  dismissed: { via: 'live', status: 'uncertain', error: 'DISMISSED', text: '', ...out },
  expired: { via: 'live', status: 'uncertain', error: 'EXPIRED', text: '', ...out },
  wakeExpired: { ...wake, status: 'uncertain', error: 'EXPIRED', hasAccepted: true, text: '' },
}
// Every state is walked in two more shapes: accepted before (an accept then another receipt, or the open limit, keeps
// `hasAccepted`), and bound to another surface than its receiver's. A state `stateOf` reads the same on every receiver
// is also walked on a hook's mailbox, there for a caller that can ACK, after an unnamed pull, and as an OpenCode wake. A few
// have shapes of their own.
const COMMON_SHAPES: Record<string, Shape> = { acceptedBefore: { hasAccepted: true }, otherSurface: { surface: 'IDE' } }
const ON_HOOK = { via: 'mailbox', ref: REF } as const
const RECEIVER_SHAPES: Record<string, Shape> = { onHook: ON_HOOK, awaitsAck: { ...ON_HOOK, awaitsAck: true }, onPull: { via: 'mailbox' }, onWake: wake }
const ANY_RECEIVER: readonly DeliveryState[] = ['turnEnded', 'inDoubt', 'disconnected', 'acknowledged', 'rejected', 'dismissed', 'expired']
const OWN_SHAPES: Partial<Record<DeliveryState, Record<string, Shape>>> = {
  takenBack: { onHook: { via: 'mailbox' } },
  pulled: { onWake: { agent: 'opencode' } },
  handed: { onPull: { ref: undefined }, onWake: wake },
  handedLost: { onPull: { ref: undefined }, onWake: wake },
  acceptedAwaitsAck: { onPull: { ref: undefined } },
  leased: { lastRepeat: { redelivered: MAILBOX_REDELIVERIES - 1 } },
  inDoubt: { otherError: { error: 'CONNECTION_LOST' } },
  acceptedLost: { awaitsAck: { ...ON_HOOK, awaitsAck: true }, onWake: { ...wake, awaitsAck: true }, otherError: { error: 'RECEIVER_ERROR' } },
  rejected: { stopped: { error: 'STOPPED' } },
  acknowledged: { withReply: { reply: 'ACK a1b2c3 on it' } },
}
export const shapesOf = (name: DeliveryState): Record<string, Shape> => {
  const base = { ...COMMON_SHAPES, ...(ANY_RECEIVER.includes(name) ? RECEIVER_SHAPES : {}), ...OWN_SHAPES[name] }
  const receiverKeys = ['onHook', 'awaitsAck', 'onPull', 'onWake'].filter(key => key in base)
  const extraKeys = Object.keys(base).filter(key => key !== 'acceptedBefore' && key !== 'otherSurface' && !receiverKeys.includes(key))
  const axes: (string | undefined)[][] = [
    'acceptedBefore' in base ? [undefined, 'acceptedBefore'] : [undefined],
    'otherSurface' in base ? [undefined, 'otherSurface'] : [undefined],
    [undefined, ...receiverKeys],
    [undefined, ...extraKeys],
  ]
  const out: Record<string, Shape> = {}
  for (const acc of axes[0]) {
    for (const surf of axes[1]) {
      for (const rec of axes[2]) {
        for (const ext of axes[3]) {
          const parts = [acc, surf, rec, ext].filter((part): part is string => part !== undefined)
          if (parts.length === 0) continue
          // OpenCode's expired message with acceptedBefore is its own row, wakeExpired.
          if (name === 'expired' && acc === 'acceptedBefore' && rec === 'onWake') continue
          out[parts.join('+')] = Object.assign({}, ...parts.map(part => base[part]))
        }
      }
    }
  }
  return out
}
const messageOf = (binding: Connection, fields: Partial<Message>): Message => ({
  id: 'm1', target: binding.id, turn: binding.turn, from: 'board', to: address(binding.agent, binding.session), text: 'hello', hash: textHash('hello'),
  origin: 'local', status: 'queued', updated: SAMPLE_NOW, reply: '', error: '', hops: 1, claimed: 0, nonce: '', ...fields,
})
export const sampleOf = (name: DeliveryState, shape?: string): { message: Message; binding: Connection; state: MessageState } => {
  const { agent = 'codex', via, ...fields } = { ...SAMPLES[name], ...(shape === undefined ? {} : shapesOf(name)[shape]) }
  const binding = sampleBinding(agent, via)
  const message = messageOf(binding, fields)
  return { message, binding, state: { messages: [message], mailboxes: via === 'mailbox' ? [binding] : [] } }
}

export type Step = { state: MessageState; sent: readonly Message[] }
// Applies one event to a store as the board does, through the binding that holds the message. Throws the board's own
// error when it refuses the event.
export const applyEvent = (state: MessageState, one: Message, binding: Connection, event: DeliveryEvent, nonce = 'd4e5f6', ref = 'ba9876543210'): Step => {
  const at = one.updated + SECOND
  const claim = (by: Connection, now: number, name?: string): Step => {
    const result = claimMessages(state, by, now, nonce, name)
    return { state: result.state, sent: result.messages }
  }
  const receipt = (status: Message['status'], error?: string): Step => ({ state: messageReceipt(state, binding, {
    id: one.id, nonce: one.nonce, status, ...(status === 'acknowledged' ? { reply: `ACK ${one.nonce}` } : {}), ...(error === undefined ? {} : { error }),
  }, at), sent: [] })
  const kept = (next: MessageState): Step => ({ state: next, sent: [] })
  const name = binding.scope === 'mailbox' ? ref : undefined
  switch (event) {
    case 'claim': return claim(binding, at, name)
    case 'claimLate': return claim(binding, one.claimed + MAILBOX_LEASE_MS, name)
    case 'pull': return claim({ ...sampleBinding(binding.agent, 'mailbox'), surface: MCP_SURFACE }, at)
    case 'accept': return receipt('accepted')
    case 'ack': return receipt('acknowledged')
    case 'reject': return receipt('rejected')
    case 'fail': return receipt('uncertain', 'TURN_ABORTED')
    case 'timeout': return receipt('uncertain', 'TIMEOUT')
    case 'unsure': return receipt('uncertain')
    case 'attempt':
      // The board takes an attempt only from OpenCode's plugin (mailbox-attempt in scripts/board-messaging.ts).
      if (!isOpenCode(one)) throw new Error('INVALID_MAILBOX_CALL')
      return kept(attemptMailboxMessage(state, binding.agent, binding.session, one.ref ?? REF, at))
    case 'release': return kept(releaseMailboxMessage(state, binding.agent, binding.session, one.ref ?? REF, at))
    case 'releaseUnsent': return kept(releaseMailboxMessage(state, binding.agent, binding.session, one.ref ?? REF, at, true))
    case 'dismiss': return kept(dismissMessage(state, one.id, at))
    case 'disconnect': return kept(disconnectMessages(state, one.target, at))
    case 'leave': return kept(disconnectMessages(state, one.target, at, true))
    case 'rebind': return kept(rebindMessages(state, { ...sampleBinding(binding.agent, 'live'), id: 'c2', turn: 't2' }, id => id === 'c2'))
    case 'openLimit': return kept(pruneMessages(state, one.updated + OPEN_LIMIT_MS + SECOND))
    case 'dayLimit': return kept(pruneMessages(state, one.updated + FINISHED_KEEP_MS + SECOND))
  }
}
export const observe = (name: DeliveryState, event: DeliveryEvent, shape?: string): Outcome => {
  const { message, binding, state } = sampleOf(name, shape)
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
export const observeHolds = (name: DeliveryState, shape?: string): Pick<DeliveryRow, 'holdsSend' | 'holdsStart'> => {
  const { message, binding, state } = sampleOf(name, shape)
  const at = message.updated + SECOND
  let holdsSend = false
  try {
    queueMessage(state, { id: 'm2', target: binding.id, turn: binding.turn, text: 'next' }, 'board', binding, at)
  } catch (error) {
    if ((error as Error).message !== 'PAIR_BUSY') throw error
    holdsSend = true
  }
  const next = messageOf(binding, { id: 'm2', text: 'next', hash: textHash('next'), updated: at })
  const claimed = claimMessages({ ...state, messages: [next, message] }, binding, at, 'd4e5f6', binding.scope === 'mailbox' ? 'ba9876543210' : undefined)
  return { holdsSend, holdsStart: !claimed.messages.some(one => one.id === 'm2') }
}
// The row's cells and card for one shape (single or `+`-combined flags) of a state.
export const rowOf = (name: DeliveryState, shape?: string): Omit<DeliveryRow, 'shapes'> => {
  const { shapes, ...row } = DELIVERY_TABLE[name]
  if (shape === undefined) return row
  const parts = shape.split('+')
  const matching = Object.keys(shapes ?? {})
    .filter(key => key.split('+').every(part => parts.includes(part)))
    .sort((a, b) => a.split('+').length - b.split('+').length)
  let merged: Omit<DeliveryRow, 'shapes'> = { ...row, on: { ...row.on } }
  for (const key of matching) {
    const own = shapes?.[key]
    if (own === undefined) continue
    merged = { ...merged, ...own, on: { ...merged.on, ...own.on } }
  }
  return merged
}

// The receipt that sends a message twice today (#1553): an uncertain receipt with no error on an open mailbox message
// accepted before, under a hook's name, makes it a named claim again. It is then handed out again once its lease passes,
// at once to a new OpenCode take, or after its hook hands it back. The test's random orders skip only this.
export const isDoubleSend = (one: Message, event: DeliveryEvent): boolean =>
  event === 'unsure' && isOpen(one) && (one.status === 'accepted' || one.hasAccepted === true) && isMailboxTarget(one.target) && one.ref !== undefined

// Today's behaviour, cell by cell. A cell where the code looks wrong stays as the code does it and is named in
// SUSPECT_CELLS below.
export const DELIVERY_TABLE: Record<DeliveryState, DeliveryRow> = {
  queued: { holdsSend: true, holdsStart: false, card: 'messagesQueued', claudeCard: 'claudeSendWorking', on: {
    claim: 'sent:claimed', claimLate: 'sent:claimed', pull: 'queued', accept: 'CLAIM_REQUIRED', ack: 'CLAIM_REQUIRED', reject: 'CLAIM_REQUIRED', fail: 'CLAIM_REQUIRED', timeout: 'CLAIM_REQUIRED', unsure: 'CLAIM_REQUIRED',
    attempt: 'INVALID_MAILBOX_CALL', release: 'queued', releaseUnsent: 'queued', dismiss: 'takenBack', disconnect: 'rejected', leave: 'queued', rebind: 'queued', openLimit: 'queued', dayLimit: 'queued' },
    shapes: {
      otherSurface: { on: { claim: 'queued', claimLate: 'queued' } },
    } },
  queuedForHook: { holdsSend: true, holdsStart: false, card: 'messagesQueued', claudeCard: 'claudeSendWorking', on: {
    claim: 'sent:leased', claimLate: 'sent:leased', pull: 'sent:pulled', accept: 'CLAIM_REQUIRED', ack: 'CLAIM_REQUIRED', reject: 'CLAIM_REQUIRED', fail: 'CLAIM_REQUIRED', timeout: 'CLAIM_REQUIRED', unsure: 'CLAIM_REQUIRED',
    attempt: 'INVALID_MAILBOX_CALL', release: 'queuedForHook', releaseUnsent: 'queuedForHook', dismiss: 'takenBack', disconnect: 'rejected', leave: 'queuedForHook', rebind: 'queuedForHook', openLimit: 'queuedForHook', dayLimit: 'queuedForHook' },
    shapes: {
      otherSurface: { card: 'messagesSurfaceLost', on: { claim: 'queuedForHook', claimLate: 'queuedForHook' } },
    } },
  queuedForWake: { holdsSend: true, holdsStart: false, card: 'messagesQueued', claudeCard: 'claudeSendWorking', on: {
    claim: 'sent:wakeClaimed', claimLate: 'sent:wakeClaimed', pull: 'sent:pulled', accept: 'CLAIM_REQUIRED', ack: 'CLAIM_REQUIRED', reject: 'CLAIM_REQUIRED', fail: 'CLAIM_REQUIRED', timeout: 'CLAIM_REQUIRED', unsure: 'CLAIM_REQUIRED',
    attempt: 'CLAIM_LOST', release: 'queuedForWake', releaseUnsent: 'queuedForWake', dismiss: 'takenBack', disconnect: 'rejected', leave: 'queuedForWake', rebind: 'queuedForWake', openLimit: 'queuedForWake', dayLimit: 'queuedForWake' },
    shapes: {
      otherSurface: { card: 'messagesSurfaceLost', on: { claim: 'queuedForWake', claimLate: 'queuedForWake' } },
    } },
  claimed: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'claimed', claimLate: 'claimed', pull: 'claimed', accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    attempt: 'INVALID_MAILBOX_CALL', release: 'claimed', releaseUnsent: 'claimed', dismiss: 'dismissed', disconnect: 'disconnected', leave: 'disconnected', rebind: 'claimed', openLimit: 'expired', dayLimit: 'expired' },
    shapes: {
      acceptedBefore: { card: 'messagesAcceptedUnconfirmed' },
    } },
  pulled: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'pulled', claimLate: 'pulled', pull: 'pulled', accept: 'handed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'pulled',
    attempt: 'INVALID_MAILBOX_CALL', release: 'pulled', releaseUnsent: 'pulled', dismiss: 'dismissed', disconnect: 'disconnected', leave: 'disconnected', rebind: 'pulled', openLimit: 'expired', dayLimit: 'expired' },
    shapes: {
      acceptedBefore: { card: 'messagesAcceptedUnconfirmed' },
      onWake: { on: { attempt: 'CLAIM_LOST' } },
      'acceptedBefore+onWake': { on: { openLimit: 'wakeExpired', dayLimit: 'wakeExpired' } },
    } },
  leased: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'leased', claimLate: 'sent:leased', pull: 'leased', accept: 'handed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'leased',
    attempt: 'INVALID_MAILBOX_CALL', release: 'queuedForHook', releaseUnsent: 'queuedForHook', dismiss: 'dismissed', disconnect: 'disconnected', leave: 'disconnected', rebind: 'leased', openLimit: 'expired', dayLimit: 'expired' },
    shapes: {
      acceptedBefore: { card: 'messagesAcceptedUnconfirmed' },
      otherSurface: { on: { claimLate: 'leased' } },
      lastRepeat: { on: { claimLate: 'sent:leaseSpent' } },
      'otherSurface+lastRepeat': { on: { claimLate: 'leased' } },
    } },
  leaseSpent: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'leaseSpent', claimLate: 'leaseSpent', pull: 'leaseSpent', accept: 'handed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'leaseSpent',
    attempt: 'INVALID_MAILBOX_CALL', release: 'queuedForHook', releaseUnsent: 'queuedForHook', dismiss: 'dismissed', disconnect: 'disconnected', leave: 'disconnected', rebind: 'leaseSpent', openLimit: 'expired', dayLimit: 'expired' },
    shapes: {
      acceptedBefore: { card: 'messagesAcceptedUnconfirmed' },
    } },
  wakeClaimed: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'sent:wakeClaimed', claimLate: 'sent:wakeClaimed', pull: 'sent:pulled', accept: 'handed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'wakeClaimed',
    attempt: 'wakeStarted', release: 'queuedForWake', releaseUnsent: 'queuedForWake', dismiss: 'dismissed', disconnect: 'disconnected', leave: 'disconnected', rebind: 'wakeClaimed', openLimit: 'queuedForWake', dayLimit: 'queuedForWake' },
    shapes: {
      acceptedBefore: { card: 'messagesAcceptedUnconfirmed' },
      otherSurface: { on: { claim: 'wakeClaimed', claimLate: 'wakeClaimed' } },
    } },
  wakeStarted: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'wakeStarted', claimLate: 'wakeStarted', pull: 'wakeStarted', accept: 'handed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'wakeStarted',
    attempt: 'wakeStarted', release: 'wakeStarted', releaseUnsent: 'queuedForWake', dismiss: 'dismissed', disconnect: 'wakeStarted', leave: 'wakeStarted', rebind: 'wakeStarted', openLimit: 'unconfirmed', dayLimit: 'unconfirmed' },
    shapes: {
      acceptedBefore: { card: 'messagesAcceptedUnconfirmed' },
    } },
  accepted: { holdsSend: true, holdsStart: true, card: 'messagesAccepted', claudeCard: 'claudeDelivered', on: {
    claim: 'accepted', claimLate: 'accepted', pull: 'accepted', accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    attempt: 'INVALID_MAILBOX_CALL', release: 'accepted', releaseUnsent: 'accepted', dismiss: 'dismissed', disconnect: 'acceptedLost', leave: 'acceptedLost', rebind: 'accepted', openLimit: 'accepted', dayLimit: 'accepted' } },
  handed: { holdsSend: false, holdsStart: false, card: 'messagesHandedNow', claudeCard: 'claudeDelivered', on: {
    claim: 'handed', claimLate: 'handed', pull: 'handed', accept: 'handed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'leased',
    attempt: 'INVALID_MAILBOX_CALL', release: 'handed', releaseUnsent: 'handed', dismiss: 'dismissed', disconnect: 'handedLost', leave: 'handedLost', rebind: 'handed', openLimit: 'expired', dayLimit: 'expired' },
    shapes: {
      onPull: { on: { unsure: 'pulled' } },
      onWake: { on: { unsure: 'wakeStarted', attempt: 'CLAIM_LOST', openLimit: 'wakeExpired', dayLimit: 'wakeExpired' } },
    } },
  acceptedAwaitsAck: { holdsSend: true, holdsStart: true, card: 'messagesHandedNow', claudeCard: 'claudeDelivered', on: {
    claim: 'acceptedAwaitsAck', claimLate: 'acceptedAwaitsAck', pull: 'acceptedAwaitsAck', accept: 'acceptedAwaitsAck', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'leased',
    attempt: 'INVALID_MAILBOX_CALL', release: 'acceptedAwaitsAck', releaseUnsent: 'acceptedAwaitsAck', dismiss: 'dismissed', disconnect: 'acceptedLost', leave: 'acceptedLost', rebind: 'acceptedAwaitsAck', openLimit: 'expired', dayLimit: 'expired' },
    shapes: {
      onPull: { on: { unsure: 'pulled' } },
    } },
  wakeAccepted: { holdsSend: true, holdsStart: true, card: 'messagesHandedNow', claudeCard: 'claudeDelivered', on: {
    claim: 'wakeAccepted', claimLate: 'wakeAccepted', pull: 'wakeAccepted', accept: 'wakeAccepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'wakeStarted',
    attempt: 'CLAIM_LOST', release: 'wakeAccepted', releaseUnsent: 'wakeAccepted', dismiss: 'dismissed', disconnect: 'wakeAccepted', leave: 'wakeAccepted', rebind: 'wakeAccepted', openLimit: 'unconfirmed', dayLimit: 'unconfirmed' } },
  acceptedLost: { holdsSend: true, holdsStart: true, card: 'messagesAcceptedDisconnected', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'acceptedLost', claimLate: 'acceptedLost', pull: 'acceptedLost', accept: 'acceptedLost', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    attempt: 'INVALID_MAILBOX_CALL', release: 'acceptedLost', releaseUnsent: 'acceptedLost', dismiss: 'dismissed', disconnect: 'acceptedLost', leave: 'acceptedLost', rebind: 'acceptedLost', openLimit: 'expired', dayLimit: 'expired' },
    shapes: {
      awaitsAck: { card: 'messagesHandedNow', on: { unsure: 'leased' } },
      onWake: { card: 'messagesHandedNow', on: { unsure: 'wakeStarted', attempt: 'CLAIM_LOST', openLimit: 'unconfirmed', dayLimit: 'unconfirmed' } },
      otherError: { card: 'messagesAccepted', claudeCard: 'claudeDelivered' },
      'awaitsAck+otherError': { card: 'messagesHandedNow' },
      'onWake+otherError': { card: 'messagesHandedNow' },
    } },
  handedLost: { holdsSend: false, holdsStart: false, card: 'messagesHandedNow', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'handedLost', claimLate: 'handedLost', pull: 'handedLost', accept: 'handedLost', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'leased',
    attempt: 'INVALID_MAILBOX_CALL', release: 'handedLost', releaseUnsent: 'handedLost', dismiss: 'dismissed', disconnect: 'handedLost', leave: 'handedLost', rebind: 'handedLost', openLimit: 'expired', dayLimit: 'expired' },
    shapes: {
      onPull: { on: { unsure: 'pulled' } },
      onWake: { on: { unsure: 'wakeStarted', attempt: 'CLAIM_LOST', openLimit: 'wakeExpired', dayLimit: 'wakeExpired' } },
    } },
  turnEnded: { holdsSend: false, holdsStart: false, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'turnEnded', claimLate: 'turnEnded', pull: 'turnEnded', accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    attempt: 'INVALID_MAILBOX_CALL', release: 'turnEnded', releaseUnsent: 'turnEnded', dismiss: 'dismissed', disconnect: 'turnEnded', leave: 'turnEnded', rebind: 'turnEnded', openLimit: 'expired', dayLimit: 'expired' },
    shapes: {
      acceptedBefore: { card: 'messagesAcceptedUnconfirmed' },
      onHook: { on: { accept: 'handed', unsure: 'leased' } },
      awaitsAck: { on: { accept: 'acceptedAwaitsAck', unsure: 'leased' } },
      onPull: { on: { accept: 'handed', unsure: 'pulled' } },
      onWake: { on: { accept: 'handed', unsure: 'wakeStarted', attempt: 'CLAIM_LOST' } },
      'acceptedBefore+onWake': { on: { openLimit: 'wakeExpired', dayLimit: 'wakeExpired' } },
    } },
  inDoubt: { holdsSend: true, holdsStart: true, card: 'messagesTimeout', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'inDoubt', claimLate: 'inDoubt', pull: 'inDoubt', accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    attempt: 'INVALID_MAILBOX_CALL', release: 'inDoubt', releaseUnsent: 'inDoubt', dismiss: 'dismissed', disconnect: 'inDoubt', leave: 'inDoubt', rebind: 'inDoubt', openLimit: 'expired', dayLimit: 'expired' },
    shapes: {
      acceptedBefore: { card: 'messagesAcceptedUnconfirmed' },
      onHook: { on: { accept: 'handed', unsure: 'leased' } },
      awaitsAck: { on: { accept: 'acceptedAwaitsAck', unsure: 'leased' } },
      onPull: { on: { accept: 'handed', unsure: 'pulled' } },
      onWake: { on: { accept: 'handed', unsure: 'wakeStarted', attempt: 'CLAIM_LOST' } },
      otherError: { card: 'messagesUncertain' },
      'acceptedBefore+onWake': { on: { openLimit: 'wakeExpired', dayLimit: 'wakeExpired' } },
      'acceptedBefore+otherError': { card: 'messagesAcceptedUnconfirmed' },
    } },
  disconnected: { holdsSend: true, holdsStart: true, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'disconnected', claimLate: 'disconnected', pull: 'disconnected', accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'claimed',
    attempt: 'INVALID_MAILBOX_CALL', release: 'disconnected', releaseUnsent: 'disconnected', dismiss: 'dismissed', disconnect: 'disconnected', leave: 'disconnected', rebind: 'disconnected', openLimit: 'expired', dayLimit: 'expired' },
    shapes: {
      acceptedBefore: { card: 'messagesAcceptedUnconfirmed' },
      onHook: { on: { accept: 'handed', unsure: 'leased' } },
      awaitsAck: { on: { accept: 'acceptedAwaitsAck', unsure: 'leased' } },
      onPull: { on: { accept: 'handed', unsure: 'pulled' } },
      onWake: { on: { accept: 'handed', unsure: 'wakeStarted', attempt: 'CLAIM_LOST' } },
      'acceptedBefore+onWake': { on: { openLimit: 'wakeExpired', dayLimit: 'wakeExpired' } },
    } },
  unconfirmed: { holdsSend: false, holdsStart: false, card: 'messagesSentUnconfirmed', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'unconfirmed', claimLate: 'unconfirmed', pull: 'unconfirmed', accept: 'unconfirmed', ack: 'acknowledged', reject: 'rejected', fail: 'turnEnded', timeout: 'inDoubt', unsure: 'wakeStarted',
    attempt: 'CLAIM_LOST', release: 'unconfirmed', releaseUnsent: 'unconfirmed', dismiss: 'dismissed', disconnect: 'unconfirmed', leave: 'unconfirmed', rebind: 'unconfirmed', openLimit: 'unconfirmed', dayLimit: 'expired' },
    shapes: {
      acceptedBefore: { on: { dayLimit: 'wakeExpired' } },
    } },
  acknowledged: { holdsSend: false, holdsStart: false, card: 'messagesAcknowledged', claudeCard: 'claudeGotIt', on: {
    claim: 'acknowledged', claimLate: 'acknowledged', pull: 'acknowledged', accept: 'RECEIPT_CONFLICT', ack: 'acknowledged', reject: 'RECEIPT_CONFLICT', fail: 'RECEIPT_CONFLICT', timeout: 'RECEIPT_CONFLICT', unsure: 'RECEIPT_CONFLICT',
    attempt: 'INVALID_MAILBOX_CALL', release: 'acknowledged', releaseUnsent: 'acknowledged', dismiss: 'MESSAGE_FINISHED', disconnect: 'acknowledged', leave: 'acknowledged', rebind: 'acknowledged', openLimit: 'acknowledged', dayLimit: 'gone' },
    shapes: {
      onWake: { on: { attempt: 'CLAIM_LOST' } },
      withReply: { claudeCard: 'claudeReplied', on: { ack: 'RECEIPT_CONFLICT' } },
    } },
  rejected: { holdsSend: false, holdsStart: false, card: 'messagesRejected', claudeCard: 'messagesRejected', on: {
    claim: 'rejected', claimLate: 'rejected', pull: 'rejected', accept: 'RECEIPT_CONFLICT', ack: 'RECEIPT_CONFLICT', reject: 'rejected', fail: 'RECEIPT_CONFLICT', timeout: 'RECEIPT_CONFLICT', unsure: 'RECEIPT_CONFLICT',
    attempt: 'INVALID_MAILBOX_CALL', release: 'rejected', releaseUnsent: 'rejected', dismiss: 'MESSAGE_FINISHED', disconnect: 'rejected', leave: 'rejected', rebind: 'rejected', openLimit: 'rejected', dayLimit: 'gone' },
    shapes: {
      onWake: { on: { attempt: 'CLAIM_LOST' } },
      stopped: { claudeCard: 'claudeStopped' },
    } },
  takenBack: { holdsSend: false, holdsStart: false, card: 'messagesRejected', claudeCard: null, on: {
    claim: 'takenBack', claimLate: 'takenBack', pull: 'takenBack', accept: 'MESSAGE_DISMISSED', ack: 'MESSAGE_DISMISSED', reject: 'MESSAGE_DISMISSED', fail: 'MESSAGE_DISMISSED', timeout: 'MESSAGE_DISMISSED', unsure: 'MESSAGE_DISMISSED',
    attempt: 'INVALID_MAILBOX_CALL', release: 'takenBack', releaseUnsent: 'takenBack', dismiss: 'MESSAGE_FINISHED', disconnect: 'takenBack', leave: 'takenBack', rebind: 'takenBack', openLimit: 'takenBack', dayLimit: 'gone' } },
  dismissed: { holdsSend: false, holdsStart: false, card: 'messagesUncertain', claudeCard: null, on: {
    claim: 'dismissed', claimLate: 'dismissed', pull: 'dismissed', accept: 'MESSAGE_DISMISSED', ack: 'MESSAGE_DISMISSED', reject: 'MESSAGE_DISMISSED', fail: 'MESSAGE_DISMISSED', timeout: 'MESSAGE_DISMISSED', unsure: 'MESSAGE_DISMISSED',
    attempt: 'INVALID_MAILBOX_CALL', release: 'dismissed', releaseUnsent: 'dismissed', dismiss: 'MESSAGE_FINISHED', disconnect: 'dismissed', leave: 'dismissed', rebind: 'dismissed', openLimit: 'dismissed', dayLimit: 'gone' },
    shapes: {
      acceptedBefore: { card: 'messagesAcceptedUnconfirmed' },
      onWake: { on: { attempt: 'CLAIM_LOST' } },
    } },
  expired: { holdsSend: false, holdsStart: false, card: 'messagesUncertain', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'expired', claimLate: 'expired', pull: 'expired', accept: 'MESSAGE_EXPIRED', ack: 'MESSAGE_EXPIRED', reject: 'MESSAGE_EXPIRED', fail: 'MESSAGE_EXPIRED', timeout: 'MESSAGE_EXPIRED', unsure: 'MESSAGE_EXPIRED',
    attempt: 'INVALID_MAILBOX_CALL', release: 'expired', releaseUnsent: 'expired', dismiss: 'MESSAGE_FINISHED', disconnect: 'expired', leave: 'expired', rebind: 'expired', openLimit: 'expired', dayLimit: 'gone' },
    shapes: {
      acceptedBefore: { card: 'messagesAcceptedUnconfirmed' },
      onWake: { on: { attempt: 'CLAIM_LOST' } },
    } },
  wakeExpired: { holdsSend: false, holdsStart: false, card: 'messagesAcceptedUnconfirmed', claudeCard: 'claudeUnconfirmed', on: {
    claim: 'wakeExpired', claimLate: 'wakeExpired', pull: 'wakeExpired', accept: 'MESSAGE_EXPIRED', ack: 'acknowledged', reject: 'MESSAGE_EXPIRED', fail: 'MESSAGE_EXPIRED', timeout: 'MESSAGE_EXPIRED', unsure: 'MESSAGE_EXPIRED',
    attempt: 'CLAIM_LOST', release: 'wakeExpired', releaseUnsent: 'wakeExpired', dismiss: 'MESSAGE_FINISHED', disconnect: 'wakeExpired', leave: 'wakeExpired', rebind: 'wakeExpired', openLimit: 'wakeExpired', dayLimit: 'gone' } },
}

// Cells where today's code looks wrong; the table states what the code does.
export const SUSPECT_CELLS: readonly (readonly [DeliveryState, DeliveryEvent])[] = [
  // #1553: an uncertain receipt with no error takes an accept back, and the message is handed out again (`isDoubleSend`).
  ['handed', 'unsure'], ['handedLost', 'unsure'], ['acceptedAwaitsAck', 'unsure'], ['wakeAccepted', 'unsure'],
  // A wake that reads "sent, not confirmed" holds its session again on an uncertain receipt, while a late accept is kept
  // from doing so (#1366 review). It breaks none of the three rules the test checks.
  ['unconfirmed', 'unsure'], ['unconfirmed', 'timeout'],
]

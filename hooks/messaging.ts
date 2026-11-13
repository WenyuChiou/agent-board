import { type Strings, ZH_TW } from './i18n.ts'
import { sha256 } from './sha256.ts'

// Where a connection or a message comes from. Only this computer for now; the field is kept so
// a later bridge can add its own value without a new store version.
export type Origin = 'local'
// A connected session is a live lease from a host adapter, never a name in progress.md.
export type Connection = { id: string; agent: string; session: string; surface: string; turn: string; scope?: 'turn' | 'session' | 'mailbox'; expires: number; contested?: boolean; origin?: Origin; folderDigest?: string; mcpOwner?: string; mcpLeaseUntil?: number }
export type Message = {
  id: string
  target: string
  turn: string
  from: string
  to: string
  // Empty once the message is finished; the hash stays, so a retry is still told from a reused id.
  text: string
  hash: string
  origin: Origin
  status: 'queued' | 'uncertain' | 'accepted' | 'acknowledged' | 'rejected'
  updated: number
  reply: string
  error: string
  // Preserves acceptance when a later receipt changes the delivery to uncertain.
  hasAccepted?: boolean
  hops: number
  claimed: number
  nonce: string
  framingNonce?: string
  // Handed over to a caller that can acknowledge it, so it holds its target until it does (roadmap invariant 4).
  awaitsAck?: boolean
  // The name a hook gave its claim, and how many times a claim nobody accepted was handed out again (#990).
  ref?: string
  redelivered?: number
  // The id of the question this message answers, set only by the board: a kept question finds its own receipt by it.
  answers?: string
  // The route line the board showed when it sent this message (set only by the board), so a receipt is worded
  // for the route the message took, not for whatever the card shows after its mailbox has expired.
  line?: RouteLine
  // The surface the board checked the route for (set only by the board). Another surface of the same session
  // cannot claim the message, since the record shown for the first says nothing of it.
  surface?: string
}
export type MessageState = { messages: Message[]; mailboxes?: Connection[]; pausePeerMessages?: boolean }
// When a message from the board reaches an agent, as the receiver's own record states it (#1351). `line`:
// now (goes in at once), stepEnd (when its current step ends), nextTurn (at its next turn; it does not
// wake it), chatOpen (when this chat is opened again), reopen (the board reopens the session and sends),
// none (cannot receive yet). `record` is the docs/validation note that showed the route live, or null.
export type RouteLine = 'now' | 'stepEnd' | 'nextTurn' | 'chatOpen' | 'reopen' | 'none'
export const ROUTE_LINES: readonly RouteLine[] = ['now', 'stepEnd', 'nextTurn', 'chatOpen', 'reopen', 'none']
export type RowState = 'idle' | 'working' | 'ended'
export type RouteKind = 'live' | 'mailbox' | 'turn'
export const SURFACE_IDS = {
  claude: 'Claude Code', codexProxy: 'Codex local proxy', codexSession: 'Codex owned session',
  antigravityStream: 'Antigravity owned CLI stream', antigravityTui: 'agy TUI', antigravityIde: 'IDE',
  cursor: 'IDE (Composer)', cli: 'CLI', web: 'Web', tui: 'TUI', unknown: 'unknown',
} as const
// The surface of an agent's own MCP pull (board_inbox); it is not a route surface a note can cover.
export const MCP_SURFACE = 'mcp'
// A note covers only the surfaces on which its route was recorded.
export type Route = { line: RouteLine; record: string | null; surfaces: readonly string[] }
export type ReceiverRoutes = { agent: string; kind: RouteKind; routes: Record<RowState, Route> }
type SendRefusal = 'NO_TARGET' | 'SHADOWED' | 'CONTESTED' | 'OFFLINE' | 'STATE_UNKNOWN' | 'SURFACE_UNKNOWN' | 'NO_RECORD' | 'TURN_RUNNING'
export type SendDecision =
  | { canSend: true; line: RouteLine; target: Connection; state: RowState }
  | { canSend: false; line: RouteLine; reason: SendRefusal }

const routeOf = (records: readonly ReceiverRoutes[], agent: string, kind: RouteKind, state: RowState): Route | undefined =>
  records.find(one => one.agent === (agent === '' ? 'claude' : agent) && one.kind === kind)?.routes[state]

export const sendDecision = (
  targetId: string, connections: readonly Connection[], mailboxes: readonly Connection[],
  stateOfSession: (agent: string, session: string) => RowState | undefined,
  routes: readonly ReceiverRoutes[], now: number,
): SendDecision => {
  const target = connections.find(one => one.id === targetId) ?? mailboxes.find(one => one.id === targetId)
  if (target === undefined) return { canSend: false, line: 'none', reason: 'NO_TARGET' }
  const live = connections.filter(one => address(one.agent, one.session) === address(target.agent, target.session) && one.expires > now)
  if (mailboxes.includes(target) && live.length > 0) return { canSend: false, line: 'none', reason: 'SHADOWED' }
  if (target.contested || live.length > 1) return { canSend: false, line: 'none', reason: 'CONTESTED' }
  if (target.expires <= now) return { canSend: false, line: 'none', reason: 'OFFLINE' }
  const state = stateOfSession(target.agent, target.session)
  if (state === undefined) return { canSend: false, line: 'none', reason: 'STATE_UNKNOWN' }
  const route = routeOf(routes, target.agent, routeKind(target.scope), state)
  if (route === undefined) return { canSend: false, line: 'none', reason: 'NO_RECORD' }
  // Background resume cannot run while a turn is already active in that conversation.
  if (route.line === 'reopen' && state === 'working') return { canSend: false, line: 'none', reason: 'TURN_RUNNING' }
  if (route.line === 'none' || typeof route.record !== 'string' || route.record === '') return { canSend: false, line: route.line, reason: 'NO_RECORD' }
  if (target.surface === SURFACE_IDS.unknown || !Object.values(SURFACE_IDS).some(surface => surface === target.surface) || !Array.isArray(route.surfaces) || !route.surfaces.includes(target.surface)) return { canSend: false, line: route.line, reason: 'SURFACE_UNKNOWN' }
  return { canSend: true, line: route.line, target, state }
}
// Whether a list read from outside (the tests' stand-in file) holds well-formed receiver routes: every entry
// names an agent and a kind, and every state has a known line and a record that is a string or null. Anything
// else is refused whole, so a missing key cannot read as a record.
export const isReceiverRoutes = (value: unknown): value is ReceiverRoutes[] => Array.isArray(value) && value.every(one => {
  if (one === null || typeof one !== 'object') return false
  const { agent, kind, routes } = one as Record<string, unknown>
  if (typeof agent !== 'string' || agent === '' || kind !== 'live' && kind !== 'mailbox' && kind !== 'turn' || routes === null || typeof routes !== 'object') return false
  return (['idle', 'working', 'ended'] as const).every(state => {
    const route = (routes as Record<string, unknown>)[state]
    if (route === null || typeof route !== 'object') return false
    const { line, record, surfaces } = route as Record<string, unknown>
    return ROUTE_LINES.includes(line as RouteLine) && (record === null || typeof record === 'string')
      && Array.isArray(surfaces) && surfaces.every(name => typeof name === 'string')
      && (!(typeof record === 'string' && record !== '') || surfaces.length > 0)
  })
})
// A connection's scope names its kind of receiver: a session the host owns, a hook mailbox, or one turn.
export const routeKind = (scope: Connection['scope']): RouteKind => scope === 'mailbox' ? 'mailbox' : scope === 'session' ? 'live' : 'turn'
export const isMailboxTarget = (id: string): boolean => /^mailbox_[0-9a-f]{24}$/.test(id)
const isHookDelivered = (one: Message): boolean => one.status === 'accepted' && isMailboxTarget(one.target) && !one.awaitsAck
// A hook can stop waiting after the board has claimed a message for it, and then nobody accepts it. A
// claim a hook named is handed out again once the lease has passed, a few times at most, with the same
// ACK code and a line saying it may be a repeat (#990). A claim with no name (board_inbox, a live
// receiver) is handed over once.
export const MAILBOX_LEASE_MS = 30_000
export const MAILBOX_REDELIVERIES = 3
const isLapsed = (one: Message, now: number): boolean => one.status === 'uncertain' && one.error === '' && one.ref !== undefined && isMailboxTarget(one.target)
  && now - one.claimed >= MAILBOX_LEASE_MS && (one.redelivered ?? 0) < MAILBOX_REDELIVERIES

export const FINISHED_KEEP_MS = 24 * 60 * 60 * 1000
export const OPEN_LIMIT_MS = 30 * 60 * 1000
export const HOP_LIMIT = 2
export const PEER_PAIR_BUDGET = 6
export const TARGET_OPEN_CAP = 3
export const PAIR_OPEN_CAP = 1
export const ACK_MAX = 200
// Open messages still need storing; finished ones are kept only to answer retries, so they have a
// cap of their own and never make the store refuse a new message.
export const OPEN_CAP = 1000
export const FINISHED_KEEP_COUNT = 1000

// One place joins and splits a session's address, so a later bridge changes its shape once.
export const address = (agent: string, session: string): string => `${agent}:${session}`
export const agentOf = (from: string): string => from.split(':')[0] ?? from
export const senderLabel = (from: string): string => {
  if (from === 'board' || from === 'unverified') return from
  const split = from.indexOf(':')
  return split < 1 ? 'unverified' : `agent:${from.slice(0, split)}#${sha256(from.slice(split + 1)).slice(0, 8)}`
}
// Hashed as JSON, which keeps a lone surrogate as an escape: as UTF-8 it would become U+FFFD and
// two different texts would hash the same.
export const textHash = (text: string): string => sha256(JSON.stringify(text))
// What anyone but the receiver is shown of a message: no nonce or hash, and a reply without the
// nonce its ACK line carries.
export const shownMessage = ({ nonce, hash: _hash, framingNonce: _framingNonce, ref: _ref, surface: _surface, ...one }: Message): Omit<Message, 'nonce' | 'hash' | 'framingNonce' | 'ref' | 'surface'> => ({
  ...one,
  reply: nonce !== '' && (one.reply === `ACK ${nonce}` || one.reply.startsWith(`ACK ${nonce} `)) ? one.reply.slice(`ACK ${nonce}`.length).trimStart() : one.reply,
})
// A queued mailbox message bound to one surface cannot be claimed when that mailbox later reads another.
export const isMailboxSurfaceLost = (
  one: Pick<Message, 'status' | 'target' | 'surface'> & { isSurfaceLost?: boolean },
  mailboxes: readonly Connection[] = [],
): boolean => {
  if (one.isSurfaceLost === true) return true
  if (one.status !== 'queued' || !isMailboxTarget(one.target) || one.surface === undefined) return false
  const mailbox = mailboxes.find(box => box.id === one.target)
  return mailbox !== undefined && mailbox.surface !== one.surface
}
export const originOf = (value: unknown): Origin => {
  if (value === undefined || value === 'local') return 'local'
  throw new Error('ORIGIN_UNSUPPORTED')
}

export const isFinished = (one: Pick<Message, 'status' | 'error'>): boolean => ['acknowledged', 'rejected'].includes(one.status) || one.status === 'uncertain' && ['EXPIRED', 'DISMISSED'].includes(one.error)
export const isOpen = (one: Pick<Message, 'status' | 'error'>): boolean => !isFinished(one)
// A finished message keeps its hash, not its text, and no more of its reply than an ACK line holds.
const settled = (one: Message): Message => isFinished(one) && (one.text !== '' || one.reply.length > ACK_MAX) ? { ...one, text: '', reply: one.reply.slice(0, ACK_MAX) } : one
export const pruneMessages = (state: MessageState, now: number): MessageState => {
  const kept = state.messages.filter(one => !isFinished(one) || now - one.updated <= FINISHED_KEEP_MS).map(one => settled(
    (one.status === 'uncertain' || one.status === 'accepted' && (one.error !== '' || isMailboxTarget(one.target))) && !isFinished(one) && now - one.updated > OPEN_LIMIT_MS
      ? { ...one, status: 'uncertain' as const, error: 'EXPIRED', updated: now, ...(one.status === 'accepted' ? { hasAccepted: true } : {}) } : one))
  // Past the count, the oldest finished go first; their ids can then be used again. Two kinds wait for
  // the age limit instead: a message handed out and then expired or dismissed, since the page sends its
  // id again and it may have arrived, and each session's latest delivery, which its next send reads its
  // hop count from.
  const latest = new Map<string, Message>()
  for (const one of kept) if (one.claimed > 0 && one.claimed >= (latest.get(one.to)?.claimed ?? 0)) latest.set(one.to, one)
  const isInDoubt = (one: Message): boolean => one.status === 'uncertain' && one.claimed > 0
  const finished = kept.filter(isFinished)
  const spare = finished.filter(one => !isInDoubt(one) && latest.get(one.to) !== one).sort((a, b) => a.updated - b.updated)
  const dropped = new Set(spare.slice(0, Math.max(0, finished.length - FINISHED_KEEP_COUNT)))
  // Those two kinds can still fill the file. Then the ones older than the open limit go, each
  // session's latest delivery before a message in doubt, so that a send finds room again.
  const rest = kept.filter(one => !dropped.has(one))
  const over = rest.length - (OPEN_CAP + FINISHED_KEEP_COUNT - 1)
  if (over > 0 && rest.filter(isOpen).length < OPEN_CAP) {
    const old = rest.filter(one => isFinished(one) && now - one.updated > OPEN_LIMIT_MS)
    for (const one of old.sort((a, b) => Number(isInDoubt(a)) - Number(isInDoubt(b)) || a.updated - b.updated).slice(0, over)) dropped.add(one)
  }
  const messages = dropped.size === 0 ? kept : kept.filter(one => !dropped.has(one))
  return messages.length === state.messages.length && messages.every((one, i) => one === state.messages[i]) ? state : { ...state, messages }
}

export const deliveryText = (message: Message, s: Strings = ZH_TW): string => [
  message.from === 'board'
    ? s.messagesDeliveryBoard
    : s.messagesDeliveryAgent(message.framingNonce ? senderLabel(message.from) : agentOf(message.from)),
  s.messagesDeliveryWarning,
  ...(message.redelivered ? [s.messagesDeliveryRepeat] : []),
  s.messagesDeliveryAck(message.nonce),
  `<<<AB-${message.framingNonce ?? message.nonce}`,
  message.text,
  `AB-${message.framingNonce ?? message.nonce}>>>`,
].join('\n')

// Observation is not an authorization token. Only an exact, newer progress report
// satisfies a handoff; a transport acceptance or even an ACK cannot do so.
export type ProgressBinding = { agent: string; session: string; updated: number }
export type SessionExpectation = {
  id: string; agent: string; session: string; surface: string
  created: number; deadline: number; baseline: number; observed: number | null
}
export const observeSession = (one: SessionExpectation, reports: readonly ProgressBinding[], now: number): SessionExpectation => {
  const matches = reports.filter(report => report.agent === one.agent && report.session === one.session)
  if (one.observed !== null || matches.length !== 1) return one
  const updated = matches[0]!.updated
  return Number.isFinite(updated) && updated > one.baseline && updated >= Math.floor(one.created / 1000) * 1000 && updated <= now
    ? { ...one, observed: updated } : one
}

export const messageText = (value: unknown, max = 8000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error('INVALID_TEXT')
  return value
}
export const isAnswersId = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 200 && !/[\r\n\0]/.test(value)
export const messageId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error('INVALID_ID')
  return value
}
export const messageFields = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('UNKNOWN_FIELD')
}

export const dismissMessage = (state: MessageState, id: string, now: number): MessageState => {
  const key = messageId(id)
  const one = state.messages.find(message => message.id === key)
  if (!one) throw new Error('NOT_FOUND')
  if (isFinished(one)) throw new Error('MESSAGE_FINISHED')
  return { ...state, messages: state.messages.map(message => message === one ? settled({
    ...one, status: one.status === 'queued' ? 'rejected' : 'uncertain', error: 'DISMISSED', updated: now,
  }) : message) }
}

export const queueMessage = (state: MessageState, input: Record<string, unknown>, from: string, target: Connection | undefined, now: number, origin: Origin = 'local', framingNonce?: string, line?: RouteLine, surface?: string): { state: MessageState; message: Message } => {
  messageFields(input, ['id', 'target', 'turn', 'text', 'answers'])
  if (input.answers !== undefined && !isAnswersId(input.answers)) throw new Error('INVALID_ID')
  const answers = from === 'board' ? input.answers : undefined
  const request = { id: messageId(input.id), target: messageId(input.target), turn: messageId(input.turn), from, text: messageText(input.text) }
  if (/^\s*agent board message(?:,| from )/im.test(request.text) || /reply first with this line alone|<<<\s*AB-|AB-[0-9a-f]{6,32}\s*>>>/i.test(request.text)) throw new Error('TEXT_REFUSED')
  const existing = state.messages.find(one => one.id === request.id)
  if (existing) {
    const isMovedMailbox = request.target === `mailbox_${sha256(existing.to).slice(0, 24)}` && request.turn === 'session'
    if ((!isMovedMailbox && (existing.target !== request.target || existing.turn !== request.turn)) || existing.from !== request.from || existing.hash !== textHash(request.text)) throw new Error('ID_CONFLICT')
    return { state, message: existing }
  }
  if (from !== 'board') {
    if (state.pausePeerMessages) throw new Error('PEER_PAUSED')
    const to = target && address(target.agent, target.session)
    let count = 0
    for (const one of [...state.messages].reverse()) {
      if (one.from === 'board' && (one.to === from || one.to === to)) break
      if (one.status !== 'rejected' && (one.from === from && one.to === to || one.from === to && one.to === from)) count++
    }
    if (count >= PEER_PAIR_BUDGET) throw new Error('PAIR_BUDGET_EXHAUSTED')
  }
  if (!target || target.expires <= now) throw new Error('OFFLINE')
  if (target.contested) throw new Error('CONTESTED')
  if (target.turn !== request.turn) throw new Error('STALE_TURN')
  const previous = from === 'board' ? undefined : state.messages.filter(one => one.to === from && one.claimed > 0).reduce<Message | undefined>((latest, one) => !latest || one.claimed >= latest.claimed ? one : latest, undefined)
  // Nothing tells whose turn an unverified sender is in, so its message starts at the limit and cannot be passed on.
  const hops = from === 'unverified' ? HOP_LIMIT : 1 + (previous?.hops ?? 0)
  if (hops > HOP_LIMIT) throw new Error('HOP_LIMIT')
  const to = address(target.agent, target.session)
  const open = state.messages.filter(one => one.to === to && isOpen(one) && !isHookDelivered(one))
  if (open.length >= TARGET_OPEN_CAP) throw new Error('TARGET_BUSY')
  if (open.filter(one => one.from === from).length >= PAIR_OPEN_CAP) throw new Error('PAIR_BUSY')
  // Finished messages the count cannot drop still fill the file, so the file has a ceiling of its own.
  if (state.messages.filter(isOpen).length >= OPEN_CAP || state.messages.length >= OPEN_CAP + FINISHED_KEEP_COUNT) throw new Error('MESSAGE_LIMIT')
  const message: Message = { ...request, ...(answers === undefined ? {} : { answers }), ...(line === undefined ? {} : { line }), ...(surface === undefined ? {} : { surface }), ...(framingNonce === undefined ? {} : { framingNonce }), hash: textHash(request.text), origin, to, hops, claimed: 0, nonce: '', status: 'queued', updated: now, reply: '', error: '' }
  return { state: { ...state, messages: [...state.messages, message] }, message }
}
export const claimMessages = (state: MessageState, target: Connection, now: number, nonce: string, ref?: string): { state: MessageState; messages: Message[] } => {
  if (target.contested || target.expires <= now) return { state, messages: [] }
  const to = address(target.agent, target.session)
  // A message the board checked a route for goes only to a claimant on that same surface; on any other it stays queued.
  // The agent's own MCP pull is exempt: it asks for its messages itself, so nothing starts a turn on an unchecked surface.
  const canReach = (one: Message): boolean => one.surface === undefined || one.surface === target.surface || target.surface === MCP_SURFACE
  const isOwn = (one: Message): boolean => one.target === target.id && one.turn === target.turn
  // While a message of the session is in doubt, no queued message goes out. A claim can take one in doubt again
  // only when every one is this binding's and has lapsed, and only on a surface that message allows.
  const held = state.messages.filter(one => one.to === to && ['uncertain', 'accepted'].includes(one.status) && isOpen(one) && !isHookDelivered(one))
  const canTake = (one: Message): boolean => one.status === 'queued' && canReach(one) && (isOwn(one) || !isMailboxTarget(target.id) && isMailboxTarget(one.target) && one.to === to)
  const pick = held.length === 0 ? state.messages.find(canTake) : held.every(one => isOwn(one) && isLapsed(one, now)) ? held.find(canReach) : undefined
  const messages = pick === undefined ? [] : [pick]
  if (messages.length === 0) return { state, messages }
  // A message handed out before keeps its ACK code, so a host that saw it can tell the repeat.
  const claimed = messages.map(({ ref: _ref, ...one }) => ({
    ...one, target: target.id, turn: target.turn, status: 'uncertain' as const, claimed: now, nonce: one.nonce || nonce, updated: now,
    ...(one.status === 'uncertain' ? { redelivered: (one.redelivered ?? 0) + 1 } : {}), ...(ref === undefined ? {} : { ref }),
  }))
  return { state: { ...state, messages: state.messages.map(one => claimed.find(message => message.id === one.id) ?? one) }, messages: claimed }
}
export const messageReceipt = (state: MessageState, target: Connection, input: Record<string, unknown>, now: number): MessageState => {
  if (target.contested) throw new Error('CONTESTED')
  messageFields(input, ['id', 'nonce', 'status', 'reply', 'error'])
  const id = messageId(input.id)
  const one = state.messages.find(message => message.id === id)
  if (!one || one.to !== address(target.agent, target.session)) throw new Error('TARGET_MISMATCH')
  if (one.error === 'DISMISSED') throw new Error('MESSAGE_DISMISSED')
  if (one.status === 'queued') throw new Error('CLAIM_REQUIRED')
  if (!one.nonce || input.nonce !== one.nonce) throw new Error('TARGET_MISMATCH')
  if (one.status === 'uncertain' && one.error === 'EXPIRED') throw new Error('MESSAGE_EXPIRED')
  if (!['uncertain', 'accepted', 'acknowledged', 'rejected'].includes(String(input.status))) throw new Error('INVALID_RECEIPT')
  const status = input.status as Message['status']
  const reply = input.reply === undefined ? '' : input.reply
  const error = input.error === undefined ? '' : messageId(input.error)
  if (error === 'EXPIRED' || error === 'DISMISSED') throw new Error('INVALID_RECEIPT')
  if (status === 'acknowledged' && (typeof reply !== 'string' || reply.length > ACK_MAX || /[\r\n]/.test(reply) || reply !== `ACK ${one.nonce}` && !reply.startsWith(`ACK ${one.nonce} `))) throw new Error('ACK_REQUIRED')
  if (typeof reply !== 'string' || reply && messageText(reply) !== reply) throw new Error('INVALID_TEXT')
  if (one.status === 'acknowledged' || one.status === 'rejected') {
    // The finished message kept only the start of its reply, so a repeated receipt is compared with that.
    if (one.status !== status || one.reply !== reply.slice(0, ACK_MAX)) throw new Error('RECEIPT_CONFLICT')
    return state
  }
  if (one.status === 'accepted' && status === 'accepted' && one.reply === reply) return state
  return { ...state, messages: state.messages.map(message => message === one ? settled({ ...one, status, reply, error, updated: now, ...(one.status === 'accepted' && status === 'uncertain' ? { hasAccepted: true } : {}) }) : message) }
}
export const disconnectMessages = (state: MessageState, target: string, now: number): MessageState => ({
  ...state,
  messages: state.messages.map(one => one.target !== target || isFinished(one) ? one : settled({
    ...one, status: one.status === 'queued' ? 'rejected' : one.status === 'accepted' ? 'accepted' : 'uncertain', error: 'DISCONNECTED', updated: one.error === 'DISCONNECTED' || one.status === 'uncertain' ? one.updated : now,
  })),
})

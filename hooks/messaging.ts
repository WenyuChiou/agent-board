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
  // When an OpenCode plugin told the board it was about to wake the session with this message (#724). From then on
  // nothing hands the message out again; only the plugin's own release --unsent takes it back.
  attempted?: number
  // The id of the question this message answers, set only by the board: a kept question finds its own receipt by it.
  answers?: string
  // The route line the board showed when it sent this message (set only by the board), so a receipt is worded
  // for the route the message took, not for whatever the card shows after its mailbox has expired.
  line?: RouteLine
  // The surface the board checked the route for (set only by the board). Another surface of the same session
  // cannot claim the message, since the record shown for the first says nothing of it.
  surface?: string
  // A claim handed to a receiver that says `starting` right before it asks its host for anything (the Codex receiver), until it
  // says so. A connection that ends while this is set never asked for the message to be sent, so the claim goes back as if it
  // were still queued (#1507).
  awaitsStart?: true
  // When an automatic receiver left with this message still queued. The board refuses the message a fixed time after
  // this, working from the store alone; the next receiver of the session takes it over and clears the stamp (#318).
  leftAt?: number
  // When the Codex desktop app first refused this message, with nothing sent, because it held the conversation (#557).
  // Later refusals keep it: from the open limit after it, the message is never handed out or begun, and is refused as not sent.
  heldSince?: number
}
export type MessageState = { messages: Message[]; mailboxes?: Connection[]; pausePeerMessages?: boolean }
// When a message from the board reaches an agent, as the receiver's own record states it (#1351). `line`:
// now (goes in at once), afterWait (goes in after a wait, such as the Codex daemon's ~10-minute watch, #1814),
// stepEnd (when its current step ends), nextTurn (at its next turn; it does not wake it), chatOpen (when this
// chat is opened again), reopen (the board reopens the session and sends), none (cannot receive yet). `record`
// is the docs/validation note that showed the route live, or null.
export type RouteLine = 'now' | 'afterWait' | 'stepEnd' | 'nextTurn' | 'chatOpen' | 'reopen' | 'none'
export const ROUTE_LINES: readonly RouteLine[] = ['now', 'afterWait', 'stepEnd', 'nextTurn', 'chatOpen', 'reopen', 'none']
export type RowState = 'idle' | 'working' | 'ended'
export type RouteKind = 'live' | 'mailbox' | 'turn'
export const SURFACE_IDS = {
  claude: 'Claude Code', codexProxy: 'Codex local proxy', codexSession: 'Codex owned session', codexDaemon: 'Codex daemon', codexApp: 'Codex desktop app',
  antigravityStream: 'Antigravity owned CLI stream', antigravityTui: 'agy TUI', antigravityIde: 'IDE',
  cursor: 'IDE (Composer)', cli: 'CLI', web: 'Web', tui: 'TUI', unknown: 'unknown',
} as const
// The surface of an agent's own MCP pull (board_inbox); it is not a route surface a note can cover.
export const MCP_SURFACE = 'mcp'
// A note covers only the surfaces on which its route was recorded. One route can be recorded by a different
// note on each surface it covers: `surfaceRecords` names a surface's own note, and `record` covers the rest.
// Likewise a surface can have its own line (`surfaceLines`), when two receivers of one agent and kind reach a session
// differently: the Codex daemon starts a turn after a wait, the Codex desktop app receiver reopens the conversation (#557, #1814).
export type Route = { line: RouteLine; record: string | null; surfaces: readonly string[]; surfaceRecords?: Readonly<Record<string, string>>; surfaceLines?: Readonly<Record<string, RouteLine>> }
// A note names a file: text on one line that is not only spaces, the same test the matrix applies.
export const isNote = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value)
// The note that covers a route on one surface. Only the route's own keys count, so a surface named like a
// property every object inherits reads the route's note.
export const routeRecord = (route: Route, surface: string): string | null =>
  route.surfaceRecords !== undefined && Object.hasOwn(route.surfaceRecords, surface) ? route.surfaceRecords[surface] ?? null : route.record
// The line of a route on one surface, read the same way: only the route's own keys count.
export const routeLine = (route: Route, surface: string): RouteLine =>
  route.surfaceLines !== undefined && Object.hasOwn(route.surfaceLines, surface) ? route.surfaceLines[surface] ?? route.line : route.line
export type ReceiverRoutes = { agent: string; kind: RouteKind; routes: Record<RowState, Route> }
type SendRefusal = 'NO_TARGET' | 'SHADOWED' | 'CONTESTED' | 'OFFLINE' | 'STATE_UNKNOWN' | 'SURFACE_UNKNOWN' | 'NO_RECORD' | 'TURN_RUNNING'
export type SendDecision =
  | { canSend: true; line: RouteLine; target: Connection; state: RowState }
  | { canSend: false; line: RouteLine; reason: SendRefusal }

const routeOf = (records: readonly ReceiverRoutes[], agent: string, kind: RouteKind, state: RowState): Route | undefined =>
  records.find(one => one.agent === (agent === '' ? 'claude' : agent) && one.kind === kind)?.routes[state]
// Whether a connection's own route, for its session's state now, has a live note that covers its surface. Only such a
// live connection takes the place of the session's mailbox: an unrecorded route never stands in for a recorded one (#318).
export const isRecordedRoute = (one: Connection, stateOfSession: (agent: string, session: string) => RowState | undefined, routes: readonly ReceiverRoutes[]): boolean => {
  const state = stateOfSession(one.agent, one.session)
  const route = state === undefined ? undefined : routeOf(routes, one.agent, routeKind(one.scope), state)
  return route !== undefined && routeLine(route, one.surface) !== 'none' && isNote(routeRecord(route, one.surface)) && Array.isArray(route.surfaces) && route.surfaces.includes(one.surface)
}

export const sendDecision = (
  targetId: string, connections: readonly Connection[], mailboxes: readonly Connection[],
  stateOfSession: (agent: string, session: string) => RowState | undefined,
  routes: readonly ReceiverRoutes[], now: number,
): SendDecision => {
  const target = connections.find(one => one.id === targetId) ?? mailboxes.find(one => one.id === targetId)
  if (target === undefined) return { canSend: false, line: 'none', reason: 'NO_TARGET' }
  const live = connections.filter(one => address(one.agent, one.session) === address(target.agent, target.session) && one.expires > now)
  const isMailbox = mailboxes.includes(target)
  if (isMailbox && live.some(one => isRecordedRoute(one, stateOfSession, routes))) return { canSend: false, line: 'none', reason: 'SHADOWED' }
  if (target.contested || !isMailbox && live.length > 1) return { canSend: false, line: 'none', reason: 'CONTESTED' }
  if (target.expires <= now) return { canSend: false, line: 'none', reason: 'OFFLINE' }
  const state = stateOfSession(target.agent, target.session)
  if (state === undefined) return { canSend: false, line: 'none', reason: 'STATE_UNKNOWN' }
  const route = routeOf(routes, target.agent, routeKind(target.scope), state)
  if (route === undefined) return { canSend: false, line: 'none', reason: 'NO_RECORD' }
  const line = routeLine(route, target.surface)
  // Background resume cannot run while a turn is already active in that conversation.
  if (line === 'reopen' && state === 'working') return { canSend: false, line: 'none', reason: 'TURN_RUNNING' }
  const record = routeRecord(route, target.surface)
  if (line === 'none' || !isNote(record)) return { canSend: false, line, reason: 'NO_RECORD' }
  if (target.surface === SURFACE_IDS.unknown || !Object.values(SURFACE_IDS).some(surface => surface === target.surface) || !Array.isArray(route.surfaces) || !route.surfaces.includes(target.surface)) return { canSend: false, line, reason: 'SURFACE_UNKNOWN' }
  return { canSend: true, line, target, state }
}
// A well-formed route: a known line; a record that is a note (`isNote`) or null; surfaces that are notes, at least
// one when there is a record; and a surface's own notes, if any, in a plain object whose keys are surfaces the
// route covers and whose values are notes; and a surface's own lines, if any, the same way with known lines for values. The board's routes file and the matrix's receiver records
// (scripts/messaging-matrix.mjs) are checked by this one function, so the two cannot accept different routes.
// A plain object: what routeRecord reads a surface's note from (a Map or a class instance would pass `typeof` and be ignored).
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
export const isRoute = (value: unknown): value is Route => {
  if (value === null || typeof value !== 'object') return false
  const { line, record, surfaces, surfaceRecords, surfaceLines } = value as Record<string, unknown>
  return ROUTE_LINES.includes(line as RouteLine) && (record === null || isNote(record))
    && Array.isArray(surfaces) && surfaces.every(isNote) && (record === null || surfaces.length > 0)
    && (surfaceRecords === undefined || isPlainObject(surfaceRecords)
      && Object.entries(surfaceRecords).every(([name, note]) => surfaces.includes(name) && isNote(note)))
    && (surfaceLines === undefined || isPlainObject(surfaceLines)
      && Object.entries(surfaceLines).every(([name, own]) => surfaces.includes(name) && ROUTE_LINES.includes(own as RouteLine)))
}
// Whether a list read from outside (the tests' stand-in file) holds well-formed receiver routes: every entry
// names an agent (a note) and a kind, and every state has a route `isRoute` takes. Anything else is refused
// whole, so a missing key cannot read as a record.
export const isReceiverRoutes = (value: unknown): value is ReceiverRoutes[] => Array.isArray(value) && value.every(one => {
  if (one === null || typeof one !== 'object') return false
  const { agent, kind, routes } = one as Record<string, unknown>
  if (!isNote(agent) || kind !== 'live' && kind !== 'mailbox' && kind !== 'turn' || routes === null || typeof routes !== 'object') return false
  return (['idle', 'working', 'ended'] as const).every(state => isRoute((routes as Record<string, unknown>)[state]))
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
// The error a started wake carries once 30 minutes passed with no receipt: the card says "sent, not confirmed".
export const UNCONFIRMED = 'UNCONFIRMED'
// OpenCode's plugin wakes the session itself, which costs a model turn and may not be repeated, so its named claims
// follow other rules (#724): a claim nobody marked as a wake goes back to queued at its lease, any number of times, with
// no repeat count and no repeat line, or sooner to a new take from the same mailbox; a marked one is never handed out
// again. Every other hook keeps the rule above.
const isAtMostOnce = (one: Pick<Message, 'to' | 'ref'>): boolean => one.ref !== undefined && one.to.startsWith('opencode:')
// A message its host accepted, now or before a later receipt, reached it: nothing hands it out or queues it again, whatever
// receipt comes after, and dismissing it keeps the mark (#1407).
export const isAcceptedOnce = (one: Pick<Message, 'status' | 'hasAccepted'>): boolean => one.status === 'accepted' || one.status === 'acknowledged' || one.hasAccepted === true
// The error the board writes at its start on a message a hook was handed before it: nothing handed out before a board start is
// handed out after it (#1407). Only the board writes it; a receiver cannot send it.
export const BOARD_RESTARTED = 'BOARD_RESTARTED'
const isLeasePassed = (one: Message, now: number): boolean => one.status === 'uncertain' && one.error === '' && one.ref !== undefined && isMailboxTarget(one.target) && now - one.claimed >= MAILBOX_LEASE_MS
const isLapsed = (one: Message, now: number): boolean => isLeasePassed(one, now) && !isAcceptedOnce(one) && (isAtMostOnce(one) ? one.attempted === undefined : (one.redelivered ?? 0) < MAILBOX_REDELIVERIES)
// An OpenCode claim nobody marked: its plugin lost the answer to the take, or gave up before the attempt. The plugin's next take
// from the same mailbox gets it at once instead of waiting out the lease; the old ref then answers CLAIM_LOST to an attempt.
const isUnmarked = (one: Message): boolean => isAtMostOnce(one) && one.status === 'uncertain' && one.error === '' && one.attempted === undefined && !isAcceptedOnce(one) && isMailboxTarget(one.target)
// What the pruning does to an OpenCode claim: the lapsed one returns to queued; a started wake, and one the host took with
// a 204 answer that the model never acknowledged, become "sent, not confirmed" at the open limit and keep their text. Undefined
// for any other message.
const settleWake = (one: Message, now: number): Message | undefined => {
  if (!isAtMostOnce(one)) return undefined
  if (isLapsed(one, now)) {
    const { ref: _ref, ...rest } = one
    return { ...rest, status: 'queued', claimed: 0, updated: now }
  }
  if (one.status === 'accepted' && one.awaitsAck === true) return now - one.updated > OPEN_LIMIT_MS ? { ...one, status: 'uncertain', error: UNCONFIRMED, updated: now, hasAccepted: true } : undefined
  if (one.attempted === undefined || one.status !== 'uncertain' || one.error !== '' && one.error !== UNCONFIRMED) return undefined
  // A day after it read "sent, not confirmed" it expires like any other open message, and its text goes (#1366 review).
  if (one.error === UNCONFIRMED) return now - one.updated >= FINISHED_KEEP_MS ? settled({ ...one, error: 'EXPIRED', updated: now }) : one
  return one.error === '' && now - one.attempted >= OPEN_LIMIT_MS ? { ...one, error: UNCONFIRMED, updated: now } : one
}

export const FINISHED_KEEP_MS = 24 * 60 * 60 * 1000
export const OPEN_LIMIT_MS = 30 * 60 * 1000
// The receivers that may say `held`, which keeps the message's clock instead of starting a fresh claim's 30 minutes (#1578):
// the Codex desktop app refuses a second writer for as long as it is open, so each refusal is the same wait, counted by the
// board from the first one, whatever its receiver remembers (#557). Any other give-back is `unsent` and starts no clock.
const HELD_CLOCK_SURFACES: readonly string[] = [SURFACE_IDS.codexApp]
export const isHeldTooLong = (one: Pick<Message, 'heldSince'>, now: number): boolean => one.heldSince !== undefined && now - one.heldSince >= OPEN_LIMIT_MS
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
// A queued mailbox message bound to one surface cannot be claimed when that mailbox later reads another
// non-MCP surface (MCP pulls claim across surfaces in claimMessages, so mcp-enroll never drops a queued message).
export const isMailboxSurfaceLost = (
  one: Pick<Message, 'status' | 'target' | 'surface'> & { isSurfaceLost?: boolean },
  mailboxes: readonly Connection[] = [],
): boolean => {
  if (one.isSurfaceLost === true) return true
  if (one.status !== 'queued' || !isMailboxTarget(one.target) || one.surface === undefined) return false
  const mailbox = mailboxes.find(box => box.id === one.target)
  return mailbox !== undefined && mailbox.surface !== one.surface && mailbox.surface !== MCP_SURFACE
}
export const originOf = (value: unknown): Origin => {
  if (value === undefined || value === 'local') return 'local'
  throw new Error('ORIGIN_UNSUPPORTED')
}

// Uncertain receipts whose error confirms the delivery turn itself ended (not a transport timeout,
// disconnect, or unconfirmed join where delivery may still be active): nothing runs on the session
// now, so the next message may go out and re-sending the same words begins a fresh delivery.
export const ENDED_UNCERTAIN_ERRORS = [
  'TURN_NOT_COMPLETED',
  'TURN_STATUS_UNKNOWN',
  'ACK_MISSING',
  'ACK_REQUIRED',
  'TURN_ABORTED',
  'NATIVE_TURN_FAILED',
] as const
export const isEndedUncertain = (one: Pick<Message, 'status' | 'error'>): boolean =>
  one.status === 'uncertain' && (ENDED_UNCERTAIN_ERRORS as readonly string[]).includes(one.error)

export const isFinished = (one: Pick<Message, 'status' | 'error'>): boolean => ['acknowledged', 'rejected'].includes(one.status) || one.status === 'uncertain' && ['EXPIRED', 'DISMISSED'].includes(one.error)
export const isOpen = (one: Pick<Message, 'status' | 'error'>): boolean => !isFinished(one)
// An open message that still holds its target: a confirmed turn-ended uncertain delivery or an OpenCode wake that reads
// "sent, not confirmed" keeps its record/text for history, but no longer holds the session's next message (#1486, #1366).
// Only the board writes UNCONFIRMED, and only for an OpenCode wake, so any other message in it still counts.
const isHolding = (one: Pick<Message, 'status' | 'error' | 'to' | 'ref'>): boolean => isOpen(one) && !isEndedUncertain(one) && !(one.error === UNCONFIRMED && isAtMostOnce(one))
// A finished message keeps its hash, not its text, and no more of its reply than an ACK line holds.
const settled = (one: Message): Message => isFinished(one) && (one.text !== '' || one.reply.length > ACK_MAX) ? { ...one, text: '', reply: one.reply.slice(0, ACK_MAX) } : one
export const pruneMessages = (state: MessageState, now: number): MessageState => {
  // A claim an OpenCode plugin made is never expired while it is unsent (it returns to queued) or a wake that was started or
  // accepted (it reads "sent, not confirmed" and keeps its text); every other message follows the open limit.
  // A queued message that carries an acceptance mark, as an earlier board saved a hand-back of an accepted message, is never
  // handed out (#1407): it reads Unsure with no claim time, so it ages and expires as one does.
  const kept = state.messages.filter(one => !isFinished(one) || now - one.updated <= FINISHED_KEEP_MS).map(saved => {
    const one = saved.status === 'queued' && saved.hasAccepted === true ? { ...saved, status: 'uncertain' as const, error: '', claimed: 0 } : saved
    const wake = settleWake(one, now)
    if (wake !== undefined) return wake
    // A reply the Codex desktop app held for the whole open limit is refused as not sent, with no receiver to ask (#557).
    if (one.status === 'queued' && isHeldTooLong(one, now)) return settled({ ...one, status: 'rejected' as const, error: 'APP_STILL_OPEN', updated: now })
    return settled((one.status === 'uncertain' || one.status === 'accepted' && (one.error !== '' || isMailboxTarget(one.target))) && !isFinished(one) && now - one.updated > OPEN_LIMIT_MS
      ? { ...one, status: 'uncertain' as const, error: 'EXPIRED', updated: now, ...(one.status === 'accepted' ? { hasAccepted: true } : {}) } : one)
  })
  // Past the count, the oldest finished go first; their ids can then be used again. Two kinds wait for
  // the age limit instead: a message handed out and then expired or dismissed, since the page sends its
  // id again and it may have arrived, and each session's latest delivery, which its next send reads its
  // hop count from.
  const latest = new Map<string, Message>()
  for (const one of kept) if (one.claimed > 0 && one.claimed >= (latest.get(one.to)?.claimed ?? 0)) latest.set(one.to, one)
  // A message a board start made Unsure may have no claim time; its ACK code says it was handed out (#1407).
  const isInDoubt = (one: Message): boolean => one.status === 'uncertain' && (one.claimed > 0 || one.nonce !== '')
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
  // A Codex thread has run one message twice (L2), so it is told what to do when it has answered already; a message
  // sent again says that in its own line.
  ...(message.redelivered ? [s.messagesDeliveryRepeat] : agentOf(message.to) === 'codex' ? [s.messagesDeliveryAnswered(message.nonce)] : []),
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
  // A message its host accepted keeps the mark, so a question it answers still counts as answered (#1407).
  const isAccepted = isAcceptedOnce(one)
  return { ...state, messages: state.messages.map(message => message === one ? settled({
    ...one, status: one.status === 'queued' && !isAccepted ? 'rejected' : 'uncertain', error: 'DISMISSED', updated: now, ...(isAccepted ? { hasAccepted: true } : {}),
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
  const open = state.messages.filter(one => one.to === to && isHolding(one) && !isHookDelivered(one))
  if (open.length >= TARGET_OPEN_CAP) throw new Error('TARGET_BUSY')
  if (open.filter(one => one.from === from).length >= PAIR_OPEN_CAP) throw new Error('PAIR_BUSY')
  // Finished messages the count cannot drop still fill the file, so the file has a ceiling of its own.
  if (state.messages.filter(isOpen).length >= OPEN_CAP || state.messages.length >= OPEN_CAP + FINISHED_KEEP_COUNT) throw new Error('MESSAGE_LIMIT')
  const message: Message = { ...request, ...(answers === undefined ? {} : { answers }), ...(line === undefined ? {} : { line }), ...(surface === undefined ? {} : { surface }), ...(framingNonce === undefined ? {} : { framingNonce }), hash: textHash(request.text), origin, to, hops, claimed: 0, nonce: '', status: 'queued', updated: now, reply: '', error: '' }
  return { state: { ...state, messages: [...state.messages, message] }, message }
}
export const claimMessages = (state: MessageState, target: Connection, now: number, nonce: string, ref?: string, marksStart = false): { state: MessageState; messages: Message[] } => {
  if (target.contested || target.expires <= now) return { state, messages: [] }
  const to = address(target.agent, target.session)
  // A message the board checked a route for goes only to a claimant on that same surface; on any other it stays queued.
  // The agent's own MCP pull is exempt: it asks for its messages itself, so nothing starts a turn on an unchecked surface.
  const canReach = (one: Message): boolean => one.surface === undefined || one.surface === target.surface || target.surface === MCP_SURFACE
  const isOwn = (one: Message): boolean => one.target === target.id && one.turn === target.turn
  // A lapsed claim, or an OpenCode claim nobody marked, can be taken again only by the binding that holds it.
  const isRetaken = (one: Message): boolean => isOwn(one) && (isLapsed(one, now) || isUnmarked(one))
  // While a message of the session is in doubt, no queued message goes out. A claim can take one in doubt again
  // only when every one is this binding's and can be taken again, and only on a surface that message allows. A wake
  // that reads "sent, not confirmed" or a confirmed turn-ended uncertain delivery no longer holds the session (`isHolding`).
  const held = state.messages.filter(one => one.to === to && ['uncertain', 'accepted'].includes(one.status) && isHolding(one) && !isHookDelivered(one))
  const canTake = (one: Message): boolean => one.status === 'queued' && !isAcceptedOnce(one) && !isHeldTooLong(one, now) && canReach(one) && (isOwn(one) || !isMailboxTarget(target.id) && isMailboxTarget(one.target) && one.to === to)
  const pick = held.length === 0 ? state.messages.find(canTake) : held.every(isRetaken) ? held.find(canReach) : undefined
  const messages = pick === undefined ? [] : [pick]
  if (messages.length === 0) return { state, messages }
  // A message handed out before keeps its ACK code, so a host that saw it can tell the repeat.
  const claimed = messages.map(({ ref: previous, ...one }) => ({
    ...one, target: target.id, turn: target.turn, status: 'uncertain' as const, claimed: now, nonce: one.nonce || nonce, updated: now,
    ...(one.status === 'uncertain' && !isAtMostOnce({ to: one.to, ref: previous }) ? { redelivered: (one.redelivered ?? 0) + 1 } : {}), ...(ref === undefined ? {} : { ref }),
    ...(marksStart ? { awaitsStart: true as const } : {}),
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
  // OpenCode's 204 answer means the model works in the background and may ack after the open limit: that ack is still taken.
  const isLateAck = input.status === 'acknowledged' && one.status === 'uncertain' && one.hasAccepted === true && one.to.startsWith('opencode:')
  if (one.status === 'uncertain' && one.error === 'EXPIRED' && !isLateAck) throw new Error('MESSAGE_EXPIRED')
  // unsent: the connection that holds a claim says it never asked for any of it to be sent, so the message goes back to the
  // queue with its text and the next claim gets its own 30 minutes (#1578). Only a claim nothing else was said of (no accept,
  // no error) and only from the connection the board handed it to; a receiver that cannot tell whether it was sent says uncertain.
  if (input.status === 'unsent' || input.status === 'starting' || input.status === 'held') {
    if (one.status !== 'uncertain' || one.error !== '' || one.hasAccepted === true || one.target !== target.id || isMailboxTarget(one.target) || input.reply !== undefined || input.error !== undefined) throw new Error('INVALID_RECEIPT')
    // held: an unsent the Codex desktop app's receiver says when Codex refused the writer, and the only receipt that starts the
    // message's clock; later ones keep the first time, and a plain unsent neither starts nor clears it (#557).
    if (input.status === 'held' && !HELD_CLOCK_SURFACES.includes(target.surface)) throw new Error('INVALID_RECEIPT')
    const { awaitsStart: _awaitsStart, ...rest } = one
    // starting: the receiver is about to ask its host for the message, so from now on a connection that ends leaves it in doubt.
    // Said twice it changes nothing. It changes nothing else either: the claim still waits for its accept. A reply the Codex
    // desktop app has held for the open limit is not begun: its receiver runs nothing when this is refused (#557).
    if (input.status === 'starting') {
      if (isHeldTooLong(one, now)) throw new Error('APP_STILL_OPEN')
      return one.awaitsStart === true ? { ...state, messages: state.messages.map(message => message === one ? rest : message) } : state
    }
    const heldSince = input.status === 'held' ? { heldSince: one.heldSince ?? now } : {}
    return { ...state, messages: state.messages.map(message => message === one ? { ...rest, status: 'queued' as const, claimed: 0, updated: now, ...heldSince } : message) }
  }
  if (!['uncertain', 'accepted', 'acknowledged', 'rejected'].includes(String(input.status))) throw new Error('INVALID_RECEIPT')
  const status = input.status as Message['status']
  const reply = input.reply === undefined ? '' : input.reply
  const error = input.error === undefined ? '' : messageId(input.error)
  // These are the board's own states: EXPIRED and DISMISSED it writes at the limit or for the person, "sent, not
  // confirmed" only for an OpenCode wake it started, and BOARD_RESTARTED at its start; a receiver cannot claim them (#1366 review).
  if (error === 'EXPIRED' || error === 'DISMISSED' || error === UNCONFIRMED || error === BOARD_RESTARTED) throw new Error('INVALID_RECEIPT')
  if (status === 'acknowledged' && (typeof reply !== 'string' || reply.length > ACK_MAX || /[\r\n]/.test(reply) || reply !== `ACK ${one.nonce}` && !reply.startsWith(`ACK ${one.nonce} `))) throw new Error('ACK_REQUIRED')
  if (typeof reply !== 'string' || reply && messageText(reply) !== reply) throw new Error('INVALID_TEXT')
  if (one.status === 'acknowledged' || one.status === 'rejected') {
    // The finished message kept only the start of its reply, so a repeated receipt is compared with that.
    if (one.status !== status || one.reply !== reply.slice(0, ACK_MAX)) throw new Error('RECEIPT_CONFLICT')
    return state
  }
  if (one.status === 'accepted' && status === 'accepted' && one.reply === reply) return state
  // An accept that reaches the board after the wake read "sent, not confirmed" is recorded, and the message stays as it is:
  // it must not hold the session's next message for another 30 minutes (#1366 review). Its day-long retention does not restart.
  if (one.status === 'uncertain' && one.error === UNCONFIRMED && status === 'accepted' && one.to.startsWith('opencode:')) return one.hasAccepted === true ? state : { ...state, messages: state.messages.map(message => message === one ? { ...one, hasAccepted: true } : message) }
  const { awaitsStart: _awaitsStart, ...rest } = one
  // An uncertain receipt with no error says nothing new of a message a board start made Unsure, and must not make it a hook's
  // claim again (#1407).
  const kept = status === 'uncertain' && error === '' && one.status === 'uncertain' && one.error === BOARD_RESTARTED ? BOARD_RESTARTED : error
  return { ...state, messages: state.messages.map(message => message === one ? settled({ ...rest, status, reply, error: kept, updated: now, ...(one.status === 'accepted' && status === 'uncertain' ? { hasAccepted: true } : {}) }) : message) }
}
// A wake the plugin started (marked by an attempt) whose reply may still be on its way, accepted by the host or not: a
// disconnection does not change it, so it reads "sent, not confirmed" at the open limit, counted from its attempt or its
// accept, and keeps its text for the day, as it would without the disconnection (#1366 review).
const isMarkedWake = (one: Message): boolean => isAtMostOnce(one) && one.attempted !== undefined && (one.status === 'uncertain' && (one.error === '' || one.error === UNCONFIRMED) || one.status === 'accepted' && one.awaitsAck === true && one.error === '')
// keepQueued: the connection that went is an automatic receiver whose leaving is no sign that its session ended (a
// restarted daemon, a contest). A message it was never handed stays queued, text and all, for its next connection, and
// carries the time it was left, which is the clock for refusing it (#318).
export const disconnectMessages = (state: MessageState, target: string, now: number, keepQueued = false): MessageState => ({
  ...state,
  messages: state.messages.map(one => {
    if (one.target !== target || isFinished(one) || isMarkedWake(one) || one.status === 'uncertain' && one.error !== '') return one
    // A claim its receiver never said `starting` for was never asked of the host: it ends as a queued message does (#1507).
    // One past the open limit is left to expire as before: its claim's time is up, whatever ended the connection.
    const { awaitsStart, leftAt: _leftAt, ...rest } = one
    const isUnstarted = awaitsStart === true && one.status === 'uncertain' && now - one.updated <= OPEN_LIMIT_MS
    if (keepQueued && isUnstarted) return { ...rest, status: 'queued', claimed: 0, updated: now, leftAt: now }
    if (keepQueued && one.status === 'queued') return one.leftAt === undefined ? { ...one, leftAt: now } : one
    return settled({
      ...rest, status: one.status === 'queued' || isUnstarted ? 'rejected' : one.status === 'accepted' ? 'accepted' : 'uncertain', error: 'DISCONNECTED', updated: one.error === 'DISCONNECTED' || one.status === 'uncertain' && !isUnstarted ? one.updated : now,
    })
  }),
})
// At a board start, nothing a hook was handed before it is handed out after it (#1407): a claim a hook named, and a message a
// hook handed back with its ACK code, read Unsure with an error only the board writes, text and all. A named claim also loses
// its name, with or without an error: only a named claim lapses or is handed back, so no receipt its session sends later, one
// that clears an error included, makes it a claim to hand out again. A claim keeps its times, so its age limit is not extended;
// a handed-back message, which had no claim time, is stamped with the start, so its text is kept for the open limit.
// OpenCode's messages keep their own rules (#724, #1366), and the start's disconnect settles a live receiver's (#318, #557,
// #1507, #1578). A second start finds nothing to change.
export const restartMessages = (state: MessageState, now: number): MessageState => {
  const isHook = (one: Message): boolean => isMailboxTarget(one.target) && !one.to.startsWith('opencode:')
  const isNamed = (one: Message): boolean => isHook(one) && one.status === 'uncertain' && one.ref !== undefined
  const isHandedBack = (one: Message): boolean => isHook(one) && one.status === 'queued' && one.nonce !== '' && one.error === ''
  if (!state.messages.some(one => isNamed(one) || isHandedBack(one))) return state
  return { ...state, messages: state.messages.map(one => {
    if (isHandedBack(one)) return { ...one, status: 'uncertain' as const, error: BOARD_RESTARTED, claimed: 0, updated: now }
    if (!isNamed(one)) return one
    const { ref: _ref, ...rest } = one
    return one.error === '' ? { ...rest, error: BOARD_RESTARTED } : rest
  }) }
}
// The next automatic receiver of the same session takes over what an earlier one left queued: a message for a
// connection that is gone (`isLive` false), on this connection's surface or on none. The takeover clears the leave stamp.
export const rebindMessages = (state: MessageState, target: Connection, isLive: (id: string) => boolean): MessageState => {
  const to = address(target.agent, target.session)
  const isLeft = (one: Message): boolean => one.status === 'queued' && one.to === to && !isMailboxTarget(one.target) && !isLive(one.target)
    && (one.surface === undefined || one.surface === target.surface)
  // The app's clock goes with the app: a receiver of another surface that takes the message over starts none (#557, #1578).
  const isClockKept = HELD_CLOCK_SURFACES.includes(target.surface)
  return state.messages.some(isLeft) ? { ...state, messages: state.messages.map(one => { if (!isLeft(one)) return one; const { leftAt: _leftAt, heldSince, ...rest } = one; return { ...rest, ...(isClockKept && heldSince !== undefined ? { heldSince } : {}), target: target.id, turn: target.turn } }) } : state
}

// A connected session is a live lease from a host adapter, never a name in progress.md.
export type Connection = { id: string; agent: string; session: string; surface: string; turn: string; scope?: 'turn' | 'session'; expires: number }
export type Message = {
  id: string
  target: string
  turn: string
  from: string
  to: string
  text: string
  status: 'queued' | 'uncertain' | 'accepted' | 'acknowledged' | 'rejected'
  updated: number
  reply: string
  error: string
}
export type MessageState = { messages: Message[] }

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
export const messageId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error('INVALID_ID')
  return value
}
export const messageFields = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('UNKNOWN_FIELD')
}
export const queueMessage = (state: MessageState, input: Record<string, unknown>, from: string, target: Connection | undefined, now: number): { state: MessageState; message: Message } => {
  messageFields(input, ['id', 'target', 'turn', 'text'])
  const request = { id: messageId(input.id), target: messageId(input.target), turn: messageId(input.turn), from, text: messageText(input.text) }
  const existing = state.messages.find(one => one.id === request.id)
  if (existing) {
    if (Object.entries(request).some(([key, value]) => existing[key as keyof Message] !== value)) throw new Error('ID_CONFLICT')
    return { state, message: existing }
  }
  if (!target || target.expires <= now) throw new Error('OFFLINE')
  if (target.turn !== request.turn) throw new Error('STALE_TURN')
  if (state.messages.length >= 1000) throw new Error('MESSAGE_LIMIT')
  const message: Message = { ...request, to: `${target.agent}:${target.session}`, status: 'queued', updated: now, reply: '', error: '' }
  return { state: { messages: [...state.messages, message] }, message }
}
export const claimMessages = (state: MessageState, target: Connection, now: number): { state: MessageState; messages: Message[] } => {
  const busy = state.messages.some(one => one.target === target.id && ['uncertain', 'accepted'].includes(one.status))
  const messages = busy ? [] : state.messages.filter(one => one.target === target.id && one.turn === target.turn && one.status === 'queued').slice(0, 1)
  if (messages.length === 0) return { state, messages }
  return { state: { messages: state.messages.map(one => messages.includes(one) ? { ...one, status: 'uncertain', updated: now } : one) }, messages }
}
export const messageReceipt = (state: MessageState, target: Connection, input: Record<string, unknown>, now: number): MessageState => {
  messageFields(input, ['id', 'status', 'reply', 'error'])
  const id = messageId(input.id)
  const one = state.messages.find(message => message.id === id)
  if (!one || one.target !== target.id || one.turn !== target.turn) throw new Error('TARGET_MISMATCH')
  if (!['uncertain', 'accepted', 'acknowledged', 'rejected'].includes(String(input.status))) throw new Error('INVALID_RECEIPT')
  const status = input.status as Message['status']
  const reply = input.reply === undefined ? '' : messageText(input.reply)
  const error = input.error === undefined ? '' : messageId(input.error)
  if (status === 'acknowledged' && !reply) throw new Error('REPLY_REQUIRED')
  if (status === 'acknowledged' && reply !== `ACK ${id}` && !reply.startsWith(`ACK ${id} `) && !reply.startsWith(`ACK ${id}\n`)) throw new Error('ACK_REQUIRED')
  if (one.status === 'acknowledged' || one.status === 'rejected') {
    if (one.status !== status || one.reply !== reply) throw new Error('RECEIPT_CONFLICT')
    return state
  }
  if (one.status === 'queued') throw new Error('CLAIM_REQUIRED')
  if (one.status === 'accepted' && status === 'accepted' && one.reply === reply) return state
  return { messages: state.messages.map(message => message === one ? { ...one, status, reply, error, updated: now } : message) }
}
export const disconnectMessages = (state: MessageState, target: string, now: number): MessageState => ({
  messages: state.messages.map(one => one.target !== target || ['rejected', 'acknowledged'].includes(one.status) ? one : {
    // Keep the delivery failure that was durably recorded before cleanup.
    ...one, status: one.status === 'queued' ? 'rejected' : 'uncertain', error: one.error || 'DISCONNECTED', updated: now,
  }),
})

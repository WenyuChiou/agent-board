// This optional contract carries only text a person or agent explicitly submits.
// It is separate from turn reporting, which may contain a whole conversation.
import type { Strings } from '../hooks/i18n'
export type Binding = { version: 1; agent: 'codex' | 'dot'; session: string; id: string }
export type Command = { version: 1; id: string; binding: string; agent: string; session: string; text: string; turn: string }
export type Receipt = { version: 1; id: string; binding: string; status: 'uncertain' | 'delivered' | 'rejected' }

const fail = (code: string): never => { throw new Error(code) }
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('INVALID_OBJECT')
const keys = (value: Record<string, unknown>, allowed: string[]): void => {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('UNKNOWN_FIELD')
}
// Angle brackets are ordinary text (`a < b`). Only a comment opener or closer could
// end or fake the auto markers around a block, so those and control characters go.
const line = (value: unknown, limit = 240): string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= limit &&
  !/[\u0000-\u001f\u007f]/.test(value) && !value.includes('<!--') && !value.includes('-->')
    ? value.trim()
    : fail('INVALID_TEXT')
// Ids become file names, and Windows refuses these names whatever the extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const token = (value: unknown): string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value) && !RESERVED.test(value) ? value : fail('INVALID_ID')

export const bindingOf = (value: unknown): Binding => {
  const one = record(value)
  keys(one, ['version', 'agent', 'session', 'id'])
  if (one.version !== 1 || (one.agent !== 'codex' && one.agent !== 'dot')) fail('UNSUPPORTED_BINDING')
  return { version: 1, agent: one.agent as Binding['agent'], session: token(one.session), id: token(one.id) }
}

export const commandOf = (value: unknown, binding: Binding): Command => {
  const one = record(value)
  keys(one, ['version', 'id', 'binding', 'agent', 'session', 'text', 'turn'])
  if (one.version !== 1 || one.binding !== binding.id || one.agent !== binding.agent || one.session !== binding.session) fail('TARGET_MISMATCH')
  const text = typeof one.text === 'string' ? one.text : fail('INVALID_MESSAGE')
  if (text.trim() === '' || text.length > 4000 || text.includes('\0')) fail('INVALID_MESSAGE')
  return { version: 1, id: token(one.id), binding: binding.id, agent: binding.agent, session: binding.session, text, turn: one.turn === '' ? '' : token(one.turn) }
}

export const receiptOf = (value: unknown, command: Command): Receipt => {
  const one = record(value)
  keys(one, ['version', 'id', 'binding', 'status'])
  if (one.version !== 1 || one.id !== command.id || one.binding !== command.binding) fail('RECEIPT_MISMATCH')
  const status = typeof one.status === 'string' ? one.status : fail('INVALID_RECEIPT')
  if (!['uncertain', 'delivered', 'rejected'].includes(status)) fail('INVALID_RECEIPT')
  return { version: 1, id: command.id, binding: command.binding, status: status as Receipt['status'] }
}

// No resume attribute: a cooperative file binding does not own a live app session.
export const progressBlock = (value: unknown, binding: Binding, now: number, s: Pick<Strings, 'contextNote'>): string => {
  const one = record(value)
  keys(one, ['project', 'title', 'context', 'state', 'steps'])
  const project = line(one.project, 100)
  const title = line(one.title, 160)
  const context = one.context === undefined || one.context === '' ? '' : line(one.context)
  const state = typeof one.state === 'string' ? one.state : fail('INVALID_STATE')
  if (!['working', 'waiting', 'done', 'ended'].includes(state)) fail('INVALID_STATE')
  const stepValues: unknown[] = Array.isArray(one.steps) ? one.steps : fail('INVALID_STEPS')
  if (stepValues.length === 0 || stepValues.length > 24) fail('INVALID_STEPS')
  const marks = { done: 'x', doing: '~', todo: ' ', waiting: '?', running: '>', blocked: '!', cancelled: '-' }
  const steps = stepValues.map(value => {
    const step = record(value)
    keys(step, ['status', 'text'])
    const status = typeof step.status === 'string' ? step.status : fail('INVALID_STEP')
    const mark = marks[status as keyof typeof marks]
    if (typeof mark !== 'string') fail('INVALID_STEP')
    return `- [${mark}] ${line(step.text)}`
  })
  const id = binding.id.slice(0, 8)
  return [
    `## ${project}`, '',
    `<!-- auto session=${id} agent=${binding.agent} state=${state} updated=${new Date(now).toISOString()} -->`,
    `### ${title}`, ...(context === '' ? [] : [s.contextNote(context)]), ...steps,
    `<!-- /auto session=${id} -->`, '',
  ].join('\n')
}

// The host must establish and verify the owner connection, then enumerate its loaded
// threads on that same connection. A thread id or a saved transcript is insufficient.
export const codexRequest = (command: Command, owner: { agent: string; thread: string; loaded: boolean; verified: boolean; canSteer: boolean }): { method: 'turn/steer'; params: Record<string, unknown> } => {
  if (command.agent !== 'codex' || owner.agent !== 'codex' || command.session !== owner.thread) fail('TARGET_MISMATCH')
  if (!owner.verified || !owner.loaded || !owner.canSteer) fail('UNSUPPORTED_OWNER')
  // turn/start can steer after a race. Only the steer method has a turn precondition.
  if (command.turn === '') fail('ACTIVE_TURN_REQUIRED')
  return {
    method: 'turn/steer',
    params: { threadId: command.session, expectedTurnId: command.turn, input: [{ type: 'text', text: command.text, text_elements: [] }] },
  }
}

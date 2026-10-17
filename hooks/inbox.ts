import { baseName } from './parse'

// What another agent's hook handed over at the end of a turn or a session, saved by the
// reporter script as one file in the inbox (`<agent>-<turn|end>-<time>-<pid>.json`). Every
// agent names its fields its own way; this reads the ones they use.

export type AgentTurn = {
  agent: string
  event: 'turn' | 'end'
  // The agent's own session id, and the 8-hex id its block goes by.
  session: string
  id: string
  cwd: string
  project: string
  prompt: string
  answer: string
  transcript: string
}

// Inbox file names: agent, event, then anything. Lower-case letters, digits and dashes only.
const NAME = /^([a-z][a-z0-9]*)-(turn|end)-[\w.-]+\.json$/

export const isInboxFile = (name: string): boolean => NAME.test(name)

// Oldest first by the time in the name; in the same second a turn comes before its session's
// end (Codex writes both within one second when `codex exec` finishes).
export const inboxOrder = (a: string, b: string): number => {
  const parts = (name: string): [number, number] => {
    const found = /^[a-z0-9]+-(turn|end)-(\d+)/.exec(name)
    return [Number(found?.[2] ?? 0), found?.[1] === 'end' ? 1 : 0]
  }
  const [timeA, endA] = parts(a)
  const [timeB, endB] = parts(b)

  return timeA - timeB || endA - endB || a.localeCompare(b)
}

const text = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = text(value[index])
      if (found.trim() !== '') return found
    }
    return ''
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['text', 'content', 'message']) {
      const found = text(record[key])
      if (found.trim() !== '') return found
    }
  }

  return ''
}

const first = (record: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const found = text(record[key])
    if (found.trim() !== '') return found.trim()
  }

  return ''
}

// FNV-1a, so one agent session always maps to the same block id.
export const blockId = (agent: string, session: string): string => {
  let hash = 0x811c9dc5
  for (const char of `${agent}:${session}`) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, '0')
}

const END_EVENTS = /^(?:session[-_]?end|sessionend|session\.deleted)$/i

// One inbox file read; null when it is not JSON or names no session.
export const readTurn = (fileName: string, body: string): AgentTurn | null => {
  const name = NAME.exec(fileName)
  if (name === null) return null
  let parsed: unknown
  try {
    // Cursor on Windows starts its JSON with a byte-order mark.
    parsed = JSON.parse(body.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  // Grok Build also runs Cursor's hooks; its camelCase fields say whose turn it really is.
  const agent = typeof record.hookEventName === 'string' && 'workspaceRoot' in record ? 'grok' : (name[1] ?? 'agent')
  const session = first(record, ['session_id', 'sessionId', 'sessionID', 'thread-id', 'thread_id', 'conversation_id', 'conversationId'])
  if (session === '') return null
  const roots = record.workspace_roots
  const cwd = first(record, ['cwd', 'workspaceRoot', 'workspace', 'project_dir', 'directory']) || (Array.isArray(roots) ? text(roots[0]) : '')
  const hookEvent = first(record, ['hook_event_name', 'hookEventName', 'event', 'type'])
  // Grok Build sends one more Stop as a session closes; it ends the session, it is no turn.
  const closing = typeof record.reason === 'string' && /^(?:channel_closed|shutdown)$/.test(record.reason)
  const event = name[2] === 'end' || END_EVENTS.test(hookEvent) || closing ? 'end' : 'turn'
  const answer = first(record, ['last_assistant_message', 'lastAssistantMessage', 'last-assistant-message', 'prompt_response', 'response', 'text'])

  return {
    agent,
    event,
    session,
    id: blockId(agent, session),
    cwd,
    project: baseName(cwd),
    prompt: first(record, ['prompt', 'user_prompt', 'input-messages', 'input_messages', 'last_user_message']),
    // Gemini CLI says this when the turn had no text.
    answer: answer === '[no response text]' ? '' : answer,
    transcript: first(record, ['transcript_path', 'transcriptPath']),
  }
}

// The end of a session log, as text the model can read: the last assistant and user words
// it can find in JSON lines, else the raw tail.
export const transcriptTail = (log: string, limit = 3000): { prompt: string; answer: string } => {
  const lines = log.split(/\r?\n/).filter(line => line.trim() !== '')
  let prompt = ''
  let answer = ''
  for (let index = lines.length - 1; index >= 0 && (prompt === '' || answer === ''); index -= 1) {
    let entry: unknown
    try {
      entry = JSON.parse(lines[index] ?? '')
    } catch {
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const inner = (record.message ?? record.payload ?? record) as Record<string, unknown>
    const role = String(inner.role ?? record.role ?? record.type ?? '')
    const words = text(inner.content ?? inner.text ?? record.content ?? record.text).trim()
    if (words === '') continue
    if (answer === '' && /assistant|model|agent/i.test(role)) answer = words
    else if (prompt === '' && /user|human/i.test(role) && answer !== '') prompt = words
  }
  if (answer === '') answer = lines.slice(-20).join('\n')

  return { prompt: prompt.slice(-1200), answer: answer.slice(-limit) }
}

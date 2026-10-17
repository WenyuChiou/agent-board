import { baseName } from './parse'
import { STRINGS } from './strings'

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

// Hermes Agent's on_session_end comes after every turn; its on_session_finalize is the end.
const END_EVENTS = /^(?:session[-_]?end|sessionend|session\.deleted|on_session_finalize)$/i

const OPENCLAW_WORKSPACE = /[\\/]\.openclaw[\\/]workspace(?:-[^\\/]*)?[\\/]*$/

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
  // Hermes Agent puts each event's own fields under `extra`.
  const extra = (parsed as Record<string, unknown>).extra
  const record = { ...(extra !== null && typeof extra === 'object' && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {}), ...(parsed as Record<string, unknown>) }
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
  const answer = first(record, ['last_assistant_message', 'lastAssistantMessage', 'last-assistant-message', 'prompt_response', 'assistant_response', 'response', 'text'])

  return {
    agent,
    event,
    session,
    id: blockId(agent, session),
    cwd,
    // OpenClaw's turns run in its own workspace folder, whose name says nothing. The name
    // becomes a `##` heading, so a folder name with a line break or a comment opening in it
    // cannot start a line or hide the lines after it.
    project: OPENCLAW_WORKSPACE.test(cwd) ? 'OpenClaw' : baseName(cwd).replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim(),
    prompt: first(record, ['prompt', 'user_prompt', 'user_message', 'input-messages', 'input_messages', 'last_user_message']),
    // Gemini CLI says this when the turn had no text.
    answer: answer === '[no response text]' ? '' : answer,
    transcript: first(record, ['transcript_path', 'transcriptPath']),
  }
}

// One line of a session log as a speaker and their words. Grok Build's log is ACP updates,
// which stream a message in chunks.
type LogEntry = { role: string; words: string; isChunk: boolean }

const logEntry = (line: string): LogEntry | null => {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if (entry === null || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  const params = record.params as Record<string, unknown> | undefined
  const update = params?.update as Record<string, unknown> | undefined
  if (update !== undefined && typeof update.sessionUpdate === 'string') {
    const kind = /^(user|agent)_message_chunk$/.exec(update.sessionUpdate)
    const content = update.content as Record<string, unknown> | undefined
    return kind === null ? null : { role: kind[1] === 'user' ? 'user' : 'assistant', words: text(content?.text), isChunk: true }
  }
  const inner = (record.message ?? record.payload ?? record) as Record<string, unknown>
  const role = String(inner.role ?? record.role ?? record.type ?? '')

  return { role, words: text(inner.content ?? inner.text ?? record.content ?? record.text), isChunk: false }
}

// The end of a session log, as text the model can read: the last assistant and user words
// it can find in JSON lines, else, for a log written as plain text, the raw tail. A JSON
// file with no words in it is no log (a key file, a config), so none of it goes to the model.
// Only the end of a log is read: a long Codex rollout runs to tens of megabytes, and the last
// exchange is all that is wanted.
export const LOG_TAIL = 256 * 1024

export const transcriptTail = (log: string, limit = 3000, isText = false): { prompt: string; answer: string } => {
  const tail = log.length > LOG_TAIL ? log.slice(log.indexOf('\n', log.length - LOG_TAIL) + 1) : log
  const lines = tail.split(/\r?\n/).filter(line => line.trim() !== '')
  // Chunks of one message, one after another, read as the whole message.
  const entries: LogEntry[] = []
  for (const line of lines) {
    const entry = logEntry(line)
    if (entry === null) continue
    const last = entries.at(-1)
    if (entry.isChunk && last !== undefined && last.isChunk && last.role === entry.role) entries[entries.length - 1] = { ...last, words: last.words + entry.words }
    else entries.push(entry)
  }
  let prompt = ''
  let answer = ''
  for (let index = entries.length - 1; index >= 0 && (prompt === '' || answer === ''); index -= 1) {
    const { role, words: raw } = entries[index] ?? { role: '', words: '' }
    const words = raw.trim()
    if (words === '') continue
    if (answer === '' && /assistant|model|agent/i.test(role)) answer = words
    else if (prompt === '' && /user|human/i.test(role) && answer !== '') prompt = words
  }
  if (answer === '' && isText) answer = lines.slice(-20).join('\n')

  return { prompt: prompt.slice(-1200), answer: answer.slice(-limit) }
}

// Cursor writes its session logs as plain text, in its agent-transcripts folder; every other
// agent's are JSON. Any other text file an inbox file names (a list of recovery codes) is
// not read out raw.
export const isTextLog = (path: string): boolean => /[\\/]agent-transcripts[\\/][^\\/]+\.txt$/i.test(path)

// A session log the pane may open: the path comes from a file anyone on the machine can drop
// into the inbox, so only the kinds agents write their logs in (JSON lines; Cursor's are
// text; older Gemini CLI writes chats/session-*.json), never a key, an env file or another
// JSON file such as ~/.claude/.credentials.json or ~/.gemini/oauth_creds.json, and no
// climbing out of a folder. A JSON file that holds no conversation gives the model nothing,
// and only Cursor's own transcripts are read out as raw text (transcriptTail, isTextLog).
export const isTranscriptPath = (path: string): boolean =>
  (/\.(?:jsonl|txt)$/i.test(path) || /[\\/]chats[\\/][^\\/]+\.json$/i.test(path)) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)

// How much of a turn a stored mirror keeps: the end of the last reply (what the next turn is
// compared with) and the start of the first request (what the model names the work from).
export const ANSWER_KEEP = 3000
export const PROMPT_KEEP = 1200

export const answerKey = (answer: string): string => answer.trim().slice(-ANSWER_KEEP)

export const promptKey = (prompt: string): string => prompt.trim().slice(0, PROMPT_KEEP)

// Of one agent session's files in a drain, the turns worth a model call: the last `keep`
// turns. A burst of older ones (a pane closed for a day) only moves the bookkeeping on, so
// one drain never makes dozens of calls.
export const turnsToDigest = (turns: readonly AgentTurn[], keep = 2): Set<number> => {
  const indexes = turns.flatMap((turn, index) => (turn.event === 'turn' ? [index] : []))

  return new Set(indexes.slice(-keep))
}

// The inbox files already taken, by name, each stamped `<session>:<time>`: three days of
// them, at most the newest `max`, so the record stays small however busy the agents are.
export const keepInboxDone = (done: Readonly<Record<string, string>>, now: number, max = 2000): Record<string, string> => {
  const at = (stamp: string): number => Number(stamp.split(':')[1] ?? 0)
  const recent = Object.entries(done).filter(([, stamp]) => now - at(stamp) < 3 * 24 * 60 * 60 * 1000)

  return Object.fromEntries(recent.sort((a, b) => at(b[1]) - at(a[1])).slice(0, max))
}

// A file one session took for itself by renaming it: `<inbox name>.<session>.taking`.
// Another session's rename of the same file fails, so each file is read by one session only.
export const takenName = (name: string, session: string): string => `${name}.${session.replace(/[^\w-]/g, '') || 'x'}.taking`

export const isTakenFile = (name: string): boolean => /^[a-z][a-z0-9]*-(?:turn|end)-[\w.-]+\.json\.[\w-]+\.taking$/.test(name)

// A turn that only showed the person the board (Gemini CLI's and OpenCode's /board, the
// agent-board skill): looking at the board is not work, so it gets no block of its own.
const BOARD_ASKS = /^\s*(?:\/board|[$/]agent-board)\s*$/

// The words of each language's board command and skill, around the command they name; a
// request that only mentions the script (someone working on this repository) is real work.
const BOARD_WORDS = Object.values(STRINGS).flatMap(s => [s.boardCommandPrompt, s.boardSkillPrompt('\u0000').split('\u0000')[1] ?? ''].filter(words => words.trim() !== ''))

// An agent can pick the board skill from plain words ("where do things stand?"), and then only
// the reply tells. The skill asks for the board first and one sentence on what needs the
// person after it; work done in the same turn is told before the board, or as more than a
// sentence after it.
const BOARD_COUNTS = /●\s*\d+[^\n]*▸\s*\d+[^\n]*⚑\s*\d+[^\n]*✓\s*\d+/
// What boardText prints below its count line: blank or indented lines, a section or project
// under its mark, and the line for nothing waiting or nothing open.
const BOARD_PLAIN = new Set(Object.values(STRINGS).flatMap(s => [s.nothingForYou, s.empty]))
const isBoardLine = (line: string): boolean => /^(?:\s|[●▸⚑◐] |$)/.test(line) || BOARD_PLAIN.has(line.trim())
const BOARD_LEAD = 40
const BOARD_ASIDE = 160
// A CJK character says about as much as two Latin ones.
const weight = (text: string): number => [...text.trim()].reduce((sum, char) => sum + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1), 0)

export const isBoardAnswer = (answer: string): boolean => {
  const lines = answer.replace(/\r\n/g, '\n').split('\n')
  const at = lines.findIndex(line => BOARD_COUNTS.test(line))
  if (at < 0) return false
  let end = at + 1
  while (end < lines.length && isBoardLine(lines[end] ?? '')) end += 1
  let from = at
  // A fence goes with the board only when it holds the board and nothing else.
  if (/^\s*```/.test(lines[at - 1] ?? '')) {
    if (!/^\s*```\s*$/.test(lines[end] ?? '')) return false
    from = at - 1
    end += 1
  }
  const before = lines.slice(0, from).join('\n')
  const after = lines.slice(end).join('\n')
  // A code block or a list beside the board (a test log, a diff, what was done) is work.
  const isAside = (text: string): boolean => !/```|^\s*(?:[-*+]|\d+[.)])\s/m.test(text)

  return weight(before) <= BOARD_LEAD && weight(after) <= BOARD_ASIDE && isAside(before) && isAside(after)
}

export const isBoardTurn = (turn: AgentTurn): boolean =>
  turn.event === 'turn' &&
  (BOARD_ASKS.test(turn.prompt) || /<name>agent-board<\/name>/.test(turn.prompt) || BOARD_WORDS.some(words => turn.prompt.includes(words)) || isBoardAnswer(turn.answer))

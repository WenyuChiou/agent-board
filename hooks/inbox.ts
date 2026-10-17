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
  // The time in the file's name, which the reporter writes: when the turn ended, by that
  // agent's clock (seconds from the sh reporter, milliseconds from the PowerShell one).
  at?: number
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

// Words sit a few levels down in every agent's payload. Another program writes the file, and
// one nested a hundred thousand deep would overflow the stack and leave the files taken with
// it unread, so the search stops well short of that.
const DEPTH_MAX = 32

const text = (value: unknown, depth = 0): string => {
  if (typeof value === 'string') return value
  if (depth >= DEPTH_MAX) return ''
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = text(value[index], depth + 1)
      if (found.trim() !== '') return found
    }
    return ''
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['text', 'content', 'message']) {
      const found = text(record[key], depth + 1)
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
    at: inboxTime(fileName),
  }
}

// The time in an inbox file's name, or undefined when it holds none.
export const inboxTime = (fileName: string): number | undefined => {
  const found = /^[a-z0-9]+-(?:turn|end)-(\d+)/.exec(fileName)

  return found === null ? undefined : Number(found[1])
}

// Where a turn falls in its session, as inboxOrder sorts files: by time, and in the same
// second a turn before its session's end (Codex writes both within one second).
export const turnOrder = (turn: Pick<AgentTurn, 'at' | 'event'>): number | undefined =>
  turn.at === undefined ? undefined : turn.at * 2 + (turn.event === 'end' ? 1 : 0)

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

// A file one session took for itself by renaming it:
// `<inbox name>.<session>-<when, base 36>-<attempt>.taking`. Another session's rename of the
// same file fails, so one session at a time reads it. It stays taken until what it reports is
// on the board: a file whose session closed half-way, or whose turn the board or the model
// could not take, is taken again once CLAIM_MS have passed, and set aside as
// `<inbox name>.failed` after MAX_TRIES attempts, kept rather than deleted.
export const CLAIM_MS = 15 * 60 * 1000
export const MAX_TRIES = 8

export const takenName = (name: string, session: string, at: number, attempt = 1): string =>
  `${name}.${session.replace(/\W/g, '') || 'x'}-${Math.max(0, Math.floor(at)).toString(36)}-${attempt}.taking`

export type Claim = { name: string; at: number | null; attempt: number }

// What a taken file's name says. A name from before claims carried their time
// (`<inbox name>.<session>.taking`) has none.
export const readClaim = (file: string): Claim | null => {
  const found = /^(.+\.json)\.([\w-]+?)(?:-([0-9a-z]+)-(\d+))?\.taking$/.exec(file)
  if (found === null || !isInboxFile(found[1] ?? '')) return null
  const at = found[3] === undefined ? null : parseInt(found[3], 36)

  return { name: found[1] ?? '', at, attempt: found[4] === undefined ? 1 : Math.max(1, Number(found[4])) }
}

export const isTakenFile = (name: string): boolean => readClaim(name) !== null

export const failedName = (name: string): string => `${name}.failed`

// What a session does with a file another look left taken: leave it to the session that may
// still be on it, take it again, or set it aside. A claim without a time goes by the file's
// own time and a day, the wait the older sweep gave it.
export const claimAction = (claim: Claim, mtimeMs: number, now: number): 'leave' | 'retake' | 'setAside' => {
  const isLeft = claim.at === null ? now - mtimeMs > 24 * 60 * 60 * 1000 : now - claim.at > CLAIM_MS
  if (!isLeft) return 'leave'

  return claim.attempt >= MAX_TRIES ? 'setAside' : 'retake'
}

// Why the files the board could not take are still in the inbox, by inbox name: `<attempt>:<time>:<why>`.
// The newest `max` are kept.
export const keepInboxFailed = (failed: Readonly<Record<string, string>>, max = 200): Record<string, string> => {
  const at = (note: string): number => Number(note.split(':')[1] ?? 0)

  return Object.fromEntries(Object.entries(failed).sort((a, b) => at(b[1]) - at(a[1])).slice(0, max))
}

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
// Each count takes all its digits and each gap stops at the next mark, and only a short line is
// tried: another agent writes the reply, and a long line of marks or digits with no ✓ at the
// end must not keep the inbox busy.
const BOARD_COUNTS = /●\s*\d+(?!\d)[^\n▸]*▸\s*\d+(?!\d)[^\n⚑]*⚑\s*\d+(?!\d)[^\n✓]*✓\s*\d+/
const COUNTS_MAX = 400
// What boardText prints below its count line: blank or indented lines, a section or project
// under its mark, and the line for nothing waiting or nothing open.
const BOARD_PLAIN = new Set(Object.values(STRINGS).flatMap(s => [s.nothingForYou, s.empty]))
const isBoardLine = (line: string): boolean => /^(?:\s|[●▸⚑◐] |$)/.test(line) || BOARD_PLAIN.has(line.trim())
const BOARD_LEAD = 40
const BOARD_ASIDE = 160
const BOARD_LINK = /https?:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/\?t=[\w-]{1,64}/
// A CJK character says about as much as two Latin ones.
const weight = (text: string): number => [...text.trim()].reduce((sum, char) => sum + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1), 0)

// Before the board, only a short line that leads into it: words that point at the board, then
// a colon ("Here is where things stand:", 「目前所有專案的進度：」). Anything else told there,
// however short, is work: a look taken for work leaves a block the person sees and archives,
// while work taken for a look is dropped without a word. 目前 and 現在 also open a report
// told with no comma (「目前已修好 429 看板如下：」), so a lead holding a word for work done is
// work. 了 stays whole there: after any verb it says something was done (改了, 跑了), and
// narrowing it to 好了 and 完成了 would drop that turn's work to spare a block. An English lead
// can say so too (`Status: fixed 429:`); `updated` is left out, since it names a board
// (`Here's the updated board:`) as often as it reports work.
const LEAD_WORDS = /^(?:here\b|below\b|this is\b|where\b|current\b|progress\b|status\b|summary\b|(?:the )?(?:agent )?board\b|以下|下面|目前|這是|这是|現在|现在|進度|进度|看板)/i
const DONE_WORDS = /[已了]|完成|修好|加好|改好|做好|\b(?:fixed|added|changed|merged|removed|wrote|ran)\b/i

const isLeadIn = (text: string): boolean => {
  const lead = text.replace(/[*_]/g, '').trim()

  return lead === '' || (weight(lead) <= BOARD_LEAD && LEAD_WORDS.test(lead) && /^[^\n,，、;；.。!！?？—–]*[:：]$/.test(lead) && !/\s-\s/.test(lead) && !DONE_WORDS.test(lead))
}

export const isBoardAnswer = (answer: string): boolean => {
  // The line with the board page's address (`--serve`) goes with the board, after it or inside
  // the code block the board is shown in.
  const lines = answer.replace(/\r\n/g, '\n').split('\n').filter(line => !BOARD_LINK.test(line))
  const at = lines.findIndex(line => line.length <= COUNTS_MAX && BOARD_COUNTS.test(line))
  if (at < 0) return false
  let end = at + 1
  while (end < lines.length && isBoardLine(lines[end] ?? '')) end += 1
  let from = at
  let open = at - 1
  while (open >= 0 && (lines[open] ?? '').trim() === '') open -= 1
  // A fence goes with the board only when it holds the board and nothing else; blank lines
  // inside it are the board's.
  if (/^\s*```/.test(lines[open] ?? '')) {
    if (!/^\s*```\s*$/.test(lines[end] ?? '')) return false
    from = open
    end += 1
  }
  const before = lines.slice(0, from).join('\n')
  const after = lines.slice(end).join('\n')
  // A code block or a list beside the board (a test log, a diff, what was done) is work.
  // The indent stays on its line, so a run of blank lines is not crossed again from each one.
  const isAside = (text: string): boolean => !/```|^[ \t]*(?:[-*+]|\d+[.)])\s/m.test(text)

  return isLeadIn(before) && weight(after) <= BOARD_ASIDE && isAside(before) && isAside(after)
}

export const isBoardTurn = (turn: AgentTurn): boolean =>
  turn.event === 'turn' &&
  (BOARD_ASKS.test(turn.prompt) || /<name>agent-board<\/name>/.test(turn.prompt) || BOARD_WORDS.some(words => turn.prompt.includes(words)) || isBoardAnswer(turn.answer))

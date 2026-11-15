// Approvals on the board (D3, #1318): a host that is about to ask the person to run a tool asks
// the local page instead, through a hook that waits. Each pending request is its own item; a press
// carries the item's id, its turn and the state the page drew, and the server refuses any
// difference. Only Allow once and Deny exist: never "always", never "for this session".
// Pure: board-serve.ts keeps the items and the waiting hooks, and passes the clock in.
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { redact } from './board'
import { sha256 } from './sha256'
import { agentLabel } from './strings'
import type { View } from './view'

// The hosts whose approval route the board answers, and whether a denial takes a message to the
// agent. Codex and OpenCode join here once their routes pass their checks.
export const APPROVAL_HOSTS: Readonly<Record<string, { canMessage: boolean }>> = { claude: { canMessage: true } }

// The hook waits at most this long for a press, counted from its request.
export const APPROVAL_PRESS_MS = 30_000
// A page that has not confirmed it drew the request within this long is taken as not looking.
export const APPROVAL_DRAW_MS = 5_000
// A page that unlocked approvals and asked for the board within this long counts as open.
export const APPROVAL_PAGE_MS = 8_000
// How long "asked in its window" stays on the row after the host's own prompt took over.
export const APPROVAL_WINDOW_MS = 60_000
// A pairing key opens one page within this long, once; a used key stays known this long, so a
// second use of it is caught.
export const APPROVAL_KEY_MS = 120_000
// A page secret no page asked for the board with in this long is dropped. A hidden tab may ask
// only once a minute (Chrome slows a background tab's timers that far), so this is longer.
export const APPROVAL_SECRET_MS = 90_000
// A newly paired page cannot press for this long, longer than a page takes to load: if a program
// read the key from the browser's command line and paired first, the real page presents the key
// again within it, and both are refused before anything can be pressed.
export const APPROVAL_GRACE_MS = 10_000
// At most this many requests are kept; past it the host asks in its own window.
export const APPROVAL_MAX = 64
// The command is shown in full; only a tool input far past any command is cut, and says so.
const COMMAND_MAX = 16_000
const REASON_MAX = 2_000
// The journal keeps the command's first words and its hash, never the command.
const JOURNAL_WORDS = 3

// asking: the hook waits and the page has not confirmed it drew the request yet.
// shown: a page that holds the approval secret drew it; only now can it be pressed.
// window: the hook returned with no decision, so the host's own prompt asks.
export type ApprovalState = 'asking' | 'shown' | 'window'

export type ApprovalAsk = {
  agent: string
  session: string
  // The host's turn; '' when the host gives none, and then the request is shown with no button.
  turn: string
  tool: string
  input: unknown
  isSubagent: boolean
  mode: string
  // The hook cut the tool input to send it: the person would not see what runs.
  isCut: boolean
}

export type Approval = {
  // The board names each request; a host's own request id, where it gives one, would go here too.
  id: string
  agent: string
  session: string
  turn: string
  tool: string
  // In full, after redact.
  command: string
  // The journal's record of it: a hash and the first words.
  hash: string
  words: string
  isSubagent: boolean
  canMessage: boolean
  // Shown cut, by the hook or here: never pressed on the board, as the person cannot see all of it.
  isCut: boolean
  state: ApprovalState
  at: number
}

export type ApprovalPress = { id: string; turn: string; state: string; behavior: 'allow' | 'deny'; reason: string; isConfirmed: boolean }

export type ApprovalDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string }

export type ApprovalCard = {
  id: string
  turn: string
  state: ApprovalState
  agent: string
  title: string
  tool: string
  command: string
  isSubagent: boolean
  canMessage: boolean
  // Allow once and Deny show only on a drawn request, with a turn, on a page that holds the secret.
  canPress: boolean
  note: string
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const SESSION = /^[\w-]{1,128}$/
const TURN = /^[\w.:-]{0,128}$/
const TOOL = /^[\w.:-]{1,128}$/

// Never in a mode where the host does not ask (bypassPermissions) or never asks the person
// (dontAsk): there is no prompt to stand in for, so the board must not decide.
export const isAskingMode = (mode: string): boolean => mode !== 'bypassPermissions' && mode !== 'dontAsk'

// What the hook sent, checked: anything malformed is no request.
export const readAsk = (body: Record<string, unknown>): ApprovalAsk | null => {
  const agent = text(body.agent)
  const session = text(body.session)
  const turn = text(body.turn)
  const tool = text(body.tool)
  if (!Object.hasOwn(APPROVAL_HOSTS, agent) || !SESSION.test(session) || !TURN.test(turn) || !TOOL.test(tool)) return null

  return { agent, session, turn, tool, input: body.input, isSubagent: body.isSubagent === true, mode: text(body.mode), isCut: body.isCut === true }
}

// The words a person approves: a command as it is, then every other field of the tool's input as a
// `name: value` line (Bash's dangerouslyDisableSandbox, an MCP tool's args), as these change what
// runs; only the agent's own description is left out. Without a command, the input as JSON. And
// whether it had to be cut to be shown.
const commandParts = (tool: string, input: unknown, s: Strings): { words: string; isCut: boolean } => {
  const record = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
  const command = record !== null && typeof record.command === 'string' ? record.command : null
  let whole: string
  try {
    if (record !== null && command !== null) {
      const fields = Object.entries(record).filter(([name]) => name !== 'command' && name !== 'description')
      // Each value as JSON, so a string cannot break onto a line of its own that looks like a field.
      whole = [command, ...fields.map(([name, value]) => `${name}: ${JSON.stringify(value) ?? String(value)}`)].join('\n')
    } else whole = JSON.stringify(input ?? null, null, 1) ?? ''
  } catch {
    whole = command ?? ''
  }
  const words = whole === '' ? tool : whole

  return words.length > COMMAND_MAX ? { words: `${words.slice(0, COMMAND_MAX)}${s.approvalCut(words.length - COMMAND_MAX)}`, isCut: true } : { words, isCut: false }
}

export const commandOf = (tool: string, input: unknown, s: Strings = ZH_TW): string => commandParts(tool, input, s).words

export const approvalOf = (ask: ApprovalAsk, id: string, now: number, home: string, isWindows: boolean, s: Strings = ZH_TW): Approval => {
  const { words: raw, isCut: isCutHere } = commandParts(ask.tool, ask.input, s)
  const command = redact(raw, home, isWindows)
  const isCut = ask.isCut || isCutHere

  return {
    id,
    agent: ask.agent,
    session: ask.session,
    turn: ask.turn,
    tool: ask.tool,
    command,
    hash: sha256(raw).slice(0, 12),
    // From the redacted words, so a secret in the first words never reaches the journal.
    words: command.split(/\s+/).filter(Boolean).slice(0, JOURNAL_WORDS).join(' '),
    isSubagent: ask.isSubagent,
    canMessage: APPROVAL_HOSTS[ask.agent]?.canMessage === true,
    isCut,
    // No turn to bind a press to, or a command the person cannot see whole: the host asks.
    state: ask.turn === '' || isCut ? 'window' : 'asking',
    at: now,
  }
}

export const readPress = (body: Record<string, unknown>): ApprovalPress | null => {
  const behavior = body.behavior
  if (behavior !== 'allow' && behavior !== 'deny') return null
  const id = text(body.id)
  if (id === '') return null

  return { id, turn: text(body.turn), state: text(body.state), behavior, reason: text(body.reason).trim().slice(0, REASON_MAX), isConfirmed: body.confirmed === true }
}

// gone: no such request (answered, ended, or never). changed: the page drew another turn or
// state than the server holds. Either way nothing is sent and the page redraws.
export const pressProblem = (item: Approval | undefined, press: ApprovalPress): 'gone' | 'changed' | null => {
  if (item === undefined) return 'gone'
  if (item.turn === '' || item.isCut || item.state !== 'shown') return 'changed'
  if (press.turn !== item.turn || press.state !== item.state) return 'changed'

  return null
}

// What the agent reads with a denial: the person's own reason where the host takes one.
export const decisionOf = (item: Approval, press: ApprovalPress, s: Strings = ZH_TW): ApprovalDecision => {
  if (press.behavior === 'allow') return { behavior: 'allow' }
  const reason = item.canMessage ? press.reason : ''

  return { behavior: 'deny', message: reason === '' ? s.approvalDeniedMessage : s.approvalDeniedWhy(reason) }
}

// The journal line's step: the outcome, the tool, the first words and the hash.
export const journalStep = (item: Approval, behavior: 'allow' | 'deny', s: Strings = ZH_TW): string =>
  s.approvalJournal(behavior === 'allow' ? s.approvalAllowed : s.approvalDenied, item.tool, item.words, item.hash)

// The row a request belongs to: its session's project and task. A sub-agent's request carries its
// parent's session id, so it lands on the parent's row.
export const approvalPlace = (view: View, agent: string, session: string): { project: string; task: string } | null => {
  const rows = [...view.active, ...view.idle, ...view.stopped, ...view.due, ...view.groups.flatMap(group => group.rows)]
  const row = rows.find(one => one.nativeSession === session && (one.agent || 'claude') === agent)
  if (row !== undefined) return { project: row.project, task: row.title }
  const waiting = view.waiting.find(one => one.nativeSession === session)

  return waiting === undefined ? null : { project: waiting.project, task: waiting.task }
}

export const approvalTitle = (view: View, agent: string, session: string, s: Strings = ZH_TW): string => {
  const place = approvalPlace(view, agent, session)

  return place?.task || place?.project || agentLabel(agent, s)
}

// What /api/board carries: nothing when nothing waits; on the page on the network only how many
// wait and the line that says so, never the command and never a button. With approvals turned off
// (a pairing key was used twice), the computer's page says so, and every request goes to its window.
export const approvalsPayload = (items: readonly Approval[], view: View, isLan: boolean, isPaired: boolean, s: Strings = ZH_TW, isOff = false): { waiting: number; note: string } | { cards: ApprovalCard[]; note?: string } | undefined => {
  if (isLan) {
    const waiting = items.filter(one => one.state !== 'window').length
    return waiting === 0 ? undefined : { waiting, note: s.approvalLanWaiting(waiting) }
  }
  if (isOff) return { cards: approvalCards(items, view, false, s), note: s.approvalOff }

  return items.length === 0 ? undefined : { cards: approvalCards(items, view, isPaired, s) }
}

export const approvalCards = (items: readonly Approval[], view: View, isPaired: boolean, s: Strings = ZH_TW): ApprovalCard[] =>
  items.map(item => {
    const canPress = isPaired && item.turn !== '' && !item.isCut && item.state === 'shown'
    const note = item.turn === '' ? s.approvalAnswerInWindow : item.isCut ? s.approvalTooLong : item.state === 'window' ? s.approvalAskedInWindow : !isPaired ? s.approvalNoSecret : item.state === 'asking' ? s.approvalShowing : ''

    return { id: item.id, turn: item.turn, state: item.state, agent: item.agent, title: approvalTitle(view, item.agent, item.session, s), tool: item.tool, command: item.command, isSubagent: item.isSubagent, canMessage: item.canMessage, canPress, note }
  })

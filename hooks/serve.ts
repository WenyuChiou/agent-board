import type { AskKind } from './ask'
import { answersOf, boardItems, fingerprint } from './board'
import type { BoardItem, PendingTurn } from './board'
import { htmlLang, vars } from './dashboard'
import { RELAY, ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { DARK, LIGHT } from './palette'
import type { Tone } from './palette'
import { RESUME } from './parse'
import { replyHint, wayBackText } from './view'
import type { AgentTarget, StepRef, TaskRef, View } from './view'
import type { Connection, Message } from './messaging'

// The board's page: what `agent-board.mjs --serve` shows in a browser for agents other than
// Claude Code, and what a press on it does. It does what the pane does: tick a hand-kept step,
// archive, copy an answer, answer another agent, and take in a block pasted from a web chat.
// Pure: scripts/board-serve.ts runs the server, writes the files and starts the agents.

// How a reply reaches the session a line belongs to. send: into the session, from the page (a
// Grok Build or Codex session that has closed, so the page is its only writer); open: in its
// own window, since it is still open and two writers on one session would mix up; claude: in
// that Claude Code session; none: copied, then pasted into the agent's chat.
export type SendMode = 'send' | 'connected' | 'open' | 'claude' | 'none'
type Delivery = { id: string; turn: string; agent: string }
type Receipt = Pick<Message, 'id' | 'status' | 'reply' | 'error'>
type Messaging = { connections: readonly Connection[]; messages: readonly Message[] }

const liveTarget = (agent: string, session: string | undefined, connections: readonly Connection[]): Connection | undefined => {
  const matches = connections.filter(one => one.agent === (agent || 'claude') && one.session === session)
  return matches.length === 1 ? matches[0] : undefined
}
const rowReceipt = (agent: string, session: string | undefined, messages: readonly Message[]): { receipt?: Receipt } => {
  const one = session === undefined ? undefined : messages.filter(message => message.to === `${agent || 'claude'}:${session}`).at(-1)
  return one === undefined ? {} : { receipt: { id: one.id, status: one.status, reply: one.reply, error: one.error } }
}

// One argument list per agent that takes a reply from outside. Every argument is a constant, a
// session id the parser checked (RESUME) or, for Grok, the reply as one argument with no shell
// in between, so nothing in the reply can start another command. Codex on Windows is a .cmd,
// which only runs through the shell, so its reply goes on stdin instead.
export type SendPlan = { agent: string; command: string; args: string[]; stdin: string | null; cwd: string | null; isShell: boolean }

// Both agents name a session by a UUID, and take anything else as a session's title, which can
// match another session.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const sendPlan = (target: AgentTarget, text: string, isWindows: boolean): SendPlan | null => {
  // Only by the session's own id: Grok's `-c` and Codex's `--last` take the newest session of
  // the folder or of the computer, which may be another one, even one still open.
  const resume = target.resume !== null && RESUME.test(target.resume) && UUID.test(target.resume) ? target.resume : null
  if (resume === null) return null
  if (target.agent === 'grok' && target.dir !== null) {
    // Grok keeps its sessions by folder, so a resume by id runs in the session's own folder
    // too. `--single=` keeps a reply that starts with a dash from reading as a flag.
    return { agent: 'grok', command: 'grok', args: ['-r', resume, `--single=${text}`], stdin: null, cwd: target.dir, isShell: false }
  }
  if (target.agent === 'codex' && target.dir !== null) {
    return { agent: 'codex', command: 'codex', args: ['exec', 'resume', '--skip-git-repo-check', resume, '-'], stdin: text, cwd: target.dir, isShell: isWindows }
  }

  return null
}

const SENDERS = new Set(['grok', 'codex'])

export const sendMode = (agent: string, target: AgentTarget | null): SendMode => {
  if (agent === '') return 'claude'
  if (target === null || sendPlan(target, '', false) === null) return SENDERS.has(agent) && target === null ? 'open' : 'none'

  return target.isClosed ? 'send' : 'open'
}

// One send at a time per session: the key the server holds while a reply is on its way.
export const sendKey = (target: AgentTarget): string => `${target.agent}:${target.session}`

export type ServeStep = { text: string; note: string; status: string; isCurrent: boolean }

export type ServeAsk = {
  delivery?: Delivery
  receipt?: Receipt
  key: string
  project: string
  agent: string
  task: string
  text: string
  note: string
  context: string
  kind: AskKind
  chip: string
  answers: string[]
  command: string | null
  link: string | null
  canTick: boolean
  // Another session's question can be marked answered: kept off the board until it changes.
  canHide: boolean
  send: SendMode
  // The session a reply goes to: the page sends it back with the reply, so a line that now
  // belongs to another session is refused.
  session: string
  // The line's fingerprint (hooks/board.ts): the page sends it back with every press.
  fp: string
  // The folder a reply runs in, shown beside the box before it is sent.
  where: string
  // Why a reply cannot be sent from here, when it cannot.
  info: string
  // How to get back to the session that asked: its own id and, where known, the command that
  // reopens it; '' for a hand-kept question.
  back: string
  // That session's own id, to copy; null when it left none.
  sessionId: string | null
  // The command that reopens that session once it is closed, in its folder; never to a phone.
  reopen: string | null
  isSending: boolean
}

export type ServeRow = {
  delivery?: Delivery
  receipt?: Receipt
  key: string
  project: string
  title: string
  context: string
  status: string
  tone: Tone
  when: string
  agent: string
  done: number
  total: number
  due: string | null
  pr: string
  steps: ServeStep[]
  next: string | null
  canArchive: boolean
  resume: string | null
  handoff: string
  // Its session still asks the person something (not marked answered): the card opens by itself.
  isAsking: boolean
  // That question, as a reply from the page names it; '' when none.
  question: string
  send: SendMode
  session: string
  fp: string
  where: string
  info: string
  isSending: boolean
  // On the local network, where a reply that would be sent here is written and copied instead.
  hasCopyBox: boolean
}

// A question marked answered, listed so it can be shown again.
export type ServeHidden = { key: string; project: string; agent: string; task: string; text: string }

export type ServeTurn = { key: string; project: string; agent: string; text: string; isQuestion: boolean; info: string }

export type ServeModel = {
  counts: { waiting: number; active: number; due: number; today: number }
  asks: ServeAsk[]
  hidden: ServeHidden[]
  idle: ServeRow[]
  groups: Array<{ project: string; rows: ServeRow[] }>
  turns: ServeTurn[]
  // Finished in the last day, until it goes to the archive.
  recent: Array<{ project: string; title: string; when: string }>
}

// `task` and `session` name the Claude Code session to answer in, the way the pane does.
const infoOf = (mode: SendMode, agent: string, task: string, session: string, s: Strings): string => {
  if (mode === 'open') return s.serveSendOpen(agent)
  if (mode === 'claude') return s.replyElsewhere(task, session, '')
  if (mode === 'none') return s.serveSendNone(agent)

  return ''
}

// The keys are the terminal board's (`boardItems`), so a press names the line it was on.
// `isLan`: the page as a phone sees it on the local network, where a reply that would run an
// agent on the computer is offered as a copy instead.
export const serveModel = (view: View, pending: readonly PendingTurn[], s: Strings = ZH_TW, sending: ReadonlySet<string> = new Set(), isLan = false, messaging?: Messaging): ServeModel => {
  const isSending = (target: AgentTarget | null): boolean => target !== null && sending.has(sendKey(target))
  const onLan = (mode: SendMode): SendMode => (isLan && mode === 'send' ? 'open' : mode)
  const lanInfo = (mode: SendMode, agent: string): string | null => (isLan && mode === 'send' ? s.serveLanSend(agent) : null)
  const asks: ServeAsk[] = []
  const groups = new Map<string, ServeRow[]>()
  const idle: ServeRow[] = []
  const idleKeys = new Set(view.idle.map(row => row.key))
  const turns: ServeTurn[] = []
  const items = boardItems(view, pending)
  for (const item of items) {
    if (item.type === 'ask') {
      const { ask } = item
      const isManual = ask.where === 'manual'
      const connection = isManual || isLan ? undefined : liveTarget(ask.agent, ask.nativeSession, messaging?.connections ?? [])
      const baseMode = isManual ? 'none' : sendMode(ask.agent, ask.target)
      const mode = connection ? 'connected' : messaging && baseMode === 'send' ? 'open' : baseMode
      const send = onLan(mode)
      // A phone on the local network gets the id, but neither the command nor its folder.
      const hint = replyHint(ask, s, !isLan)
      asks.push({
        ...(connection === undefined ? {} : { delivery: { id: connection.id, turn: connection.turn, agent: connection.agent } }),
        ...(isLan ? {} : rowReceipt(ask.agent, ask.nativeSession, messaging?.messages ?? [])),
        key: item.key,
        project: ask.project,
        agent: ask.agent,
        task: ask.task,
        text: ask.text,
        note: ask.note,
        context: ask.context,
        kind: ask.kind,
        chip: s.chip(s.ask[ask.kind]),
        // A hand-kept question is the person's own: ticking it is the answer.
        answers: isManual ? [] : answersOf(ask, s),
        command: ask.command,
        link: ask.link,
        canTick: ask.step !== null,
        canHide: ask.hideKey !== '',
        send,
        session: connection?.session ?? ask.target?.session ?? '',
        fp: fingerprint(item, items),
        where: send === 'send' ? (ask.target?.dir ?? '') : '',
        info: connection ? s.messagesConnectedVia(connection.surface, connection.session) : isManual ? '' : (lanInfo(mode, ask.agent) ?? infoOf(send, ask.agent, ask.task, ask.session, s)),
        back: wayBackText(hint),
        sessionId: ask.where === 'other' ? ask.sessionId : null,
        reopen: hint.reopen,
        isSending: isSending(ask.target) || connection !== undefined && (messaging?.messages.some(one => one.target === connection.id && ['queued', 'uncertain', 'accepted'].includes(one.status)) ?? false),
      })
      continue
    }
    if (item.type === 'row') {
      const { row } = item
      const connection = isLan ? undefined : liveTarget(row.agent, row.nativeSession, messaging?.connections ?? [])
      const baseMode = row.target === null ? (row.auto === null ? 'none' : 'claude') : sendMode(row.agent, row.target)
      const mode = connection ? 'connected' : messaging && baseMode === 'send' ? 'open' : baseMode
      const send = onLan(mode)
      const rows = idleKeys.has(row.key) ? idle : (groups.get(row.project) ?? [])
      if (!idleKeys.has(row.key)) groups.set(row.project, rows)
      rows.push({
        ...(connection === undefined ? {} : { delivery: { id: connection.id, turn: connection.turn, agent: connection.agent } }),
        ...(isLan ? {} : rowReceipt(row.agent, row.nativeSession, messaging?.messages ?? [])),
        key: item.key,
        project: row.project,
        title: row.title,
        context: row.context,
        status: row.status,
        tone: row.tone,
        when: row.when,
        agent: row.agent,
        done: row.done,
        total: row.total,
        due: row.due?.left ?? null,
        pr: row.pr,
        steps: row.steps.map(step => ({ text: step.text, note: step.note, status: step.status, isCurrent: step.isCurrent })),
        next: row.next?.step ?? null,
        canArchive: row.archive !== null,
        // The command to resume a session names its folder, and the account with it: the computer's only.
        resume: isLan ? null : row.resume,
        handoff: row.handoff,
        isAsking: row.question !== null,
        question: row.question ?? '',
        send,
        session: connection?.session ?? row.target?.session ?? '',
        fp: fingerprint(item, items),
        where: send === 'send' ? (row.target?.dir ?? '') : '',
        // A row says why only when a reply could otherwise be expected here.
        info: connection ? s.messagesConnectedVia(connection.surface, connection.session) : lanInfo(mode, row.agent) ?? (send === 'open' ? infoOf(send, row.agent, row.title, '', s) : ''),
        isSending: isSending(row.target) || connection !== undefined && (messaging?.messages.some(one => one.target === connection.id && ['queued', 'uncertain', 'accepted'].includes(one.status)) ?? false),
        hasCopyBox: lanInfo(mode, row.agent) !== null || messaging !== undefined && row.auto !== null && connection === undefined,
      })
      continue
    }
    const { turn } = item
    turns.push({
      key: item.key,
      project: turn.project,
      agent: turn.agent,
      text: turn.text,
      isQuestion: turn.isQuestion,
      // A turn still in the inbox is from a session that has not closed (its end drops it).
      info: turn.isQuestion ? infoOf(SENDERS.has(turn.agent) ? 'open' : 'none', turn.agent, '', '', s) : '',
    })
  }

  return {
    counts: { ...view.overview, waiting: view.overview.waiting + pending.filter(turn => turn.isQuestion).length },
    asks,
    idle,
    hidden: view.hidden.map(item => ({ key: `hidden:${item.hideKey}`, project: item.project, agent: item.agent, task: item.task, text: item.text })),
    groups: [...groups].map(([project, rows]) => ({ project, rows })),
    turns,
    recent: view.recent.map(item => ({ project: item.project, title: item.title, when: item.when })),
  }
}

// `asked`: with a reply, the question the page showed it under ('' for none). `fp`: the line's
// fingerprint as the page drew it; a tick, an archive and a reply need it, hide and unhide do not.
export type ServeRequest = { key: string; type: string; text: string; session: string; asked?: string; fp?: string; connection?: string; turn?: string }

export type ServeAction =
  | { type: 'tick'; ref: StepRef }
  | { type: 'archive'; ref: TaskRef; title: string }
  | { type: 'hide'; key: string; text: string }
  | { type: 'unhide'; key: string | null }
  | { type: 'send'; target: AgentTarget; text: string; title: string }
  | { type: 'message'; connection: Delivery; text: string; title: string }
  | { type: 'refuse'; note: string }

const MAX_REPLY = 4000

// A reply as it goes to the agent: one paragraph or more, no control characters, and short
// enough for one command line on Windows.
export const replyText = (raw: string): string =>
  raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_REPLY)

// What a press on the page does, worked out again from the file as it is now: a line that is
// gone or changed since the page drew it is refused, never taken for the one now in its place.
// From the local network (`isLan`) a reply to an agent is refused: it would run a program on
// the computer, and the network's page is plain HTTP that others on the network could read.
export const serveAction = (items: readonly BoardItem[], request: ServeRequest, s: Strings = ZH_TW, isLan = false, connections: readonly Connection[] = [], isMessaging = false): ServeAction => {
  const action = actionOf(items, request, s, isLan, connections, isMessaging)
  if (action.type !== 'tick' && action.type !== 'archive' && action.type !== 'send' && action.type !== 'message') return action
  // The key is a project and a title, which another session's block can take over, and a step
  // can be reworded under it: the press goes through only on the block and words the page drew.
  const item = items.find(one => one.key === request.key)

  return item !== undefined && request.fp === fingerprint(item, items) ? action : { type: 'refuse', note: s.boardLineChanged }
}

const actionOf = (items: readonly BoardItem[], request: ServeRequest, s: Strings, isLan: boolean, connections: readonly Connection[], isMessaging: boolean): ServeAction => {
  // A hidden question is off the board: it is named by the key it was hidden under.
  if (request.type === 'unhide') return request.key.startsWith('hidden:') ? { type: 'unhide', key: request.key.slice('hidden:'.length) } : { type: 'refuse', note: '' }
  const item = items.find(one => one.key === request.key)
  if (item === undefined) return { type: 'refuse', note: s.boardLineChanged }
  if (request.type === 'tick') {
    const ref = item.type === 'ask' ? item.ask.step : item.type === 'row' ? item.row.next : null
    // A task keeps its key while its next step moves on: only the step the page showed is ticked.
    if (ref !== null && item.type === 'row' && request.text !== ref.step) return { type: 'refuse', note: s.boardLineChanged }
    return ref === null ? { type: 'refuse', note: s.boardTickGone } : { type: 'tick', ref }
  }
  // Marked answered sends nothing: only the hidden list is written.
  if (request.type === 'hide') return item.type === 'ask' && item.ask.hideKey !== '' ? { type: 'hide', key: item.ask.hideKey, text: item.ask.text } : { type: 'refuse', note: '' }
  if (request.type === 'archive') {
    return item.type === 'row' && item.row.archive !== null ? { type: 'archive', ref: item.row.archive, title: item.row.title } : { type: 'refuse', note: s.archiveGone }
  }
  if (request.type !== 'send' && request.type !== 'message') return { type: 'refuse', note: '' }
  const text = replyText(request.text)
  if (item.type === 'turn') return { type: 'refuse', note: infoOf(SENDERS.has(item.turn.agent) ? 'open' : 'none', item.turn.agent, '', '', s) }
  const { agent, target } = item.type === 'ask' ? item.ask : item.row
  // A hand-kept question is answered by ticking it: there is no one to send to.
  if (item.type === 'ask' && item.ask.where === 'manual') return { type: 'refuse', note: '' }
  const mode = target === null ? (agent === '' ? 'claude' : 'none') : sendMode(agent, target)
  const title = item.type === 'ask' ? item.ask.task : item.row.title
  if (request.type === 'message') {
    const native = item.type === 'ask' ? item.ask.nativeSession : item.row.nativeSession
    const connected = liveTarget(agent, native, connections)
    const question = item.type === 'ask' ? item.ask.text : item.row.question ?? ''
    if (isLan || !connected || connected.id !== request.connection || connected.turn !== request.turn || connected.session !== request.session || (request.asked ?? '') !== question || !text) return { type: 'refuse', note: s.messagesFailed }
    return { type: 'message', connection: { id: connected.id, turn: connected.turn, agent: connected.agent }, text, title }
  }
  if (isMessaging) return { type: 'refuse', note: s.messagesFailed }
  if (mode !== 'send' || target === null) return { type: 'refuse', note: infoOf(mode, agent, title, item.type === 'ask' ? item.ask.session : '', s) }
  if (isLan) return { type: 'refuse', note: s.serveLanSend(agent) }
  // Keys are a project and a title, which another session's block can take over between the
  // page's redraw and the press.
  if (request.session !== target.session) return { type: 'refuse', note: s.boardLineChanged }
  // An answer goes with the question it answers, the way the pane words one for Claude, and
  // only while that question is still the one asked: a task keeps its key while its question
  // is answered, reworded, replaced by another or marked answered here.
  const question = item.type === 'ask' ? item.ask.text : (item.row.question ?? undefined)
  if ((request.asked ?? '') !== (question ?? '')) return { type: 'refuse', note: s.boardLineChanged }
  if (text === '') return { type: 'refuse', note: '' }

  return { type: 'send', target, text: question === undefined ? text : s.answerText(question, text), title }
}

export type PageRequest = { method: string; host: string; origin: string; contentType: string; token: string }

// One of the computer's network addresses, as Node lists them (`family` was a number in Node 18.0
// to 18.3).
export type NetAddress = { address: string; family: string | number; internal: boolean }

// Adapters a phone is not on: virtual machines, containers, WSL.
const VIRTUAL = /virtual|vmware|vmnet|vbox|vethernet|hyper-v|wsl|docker|^br-|^veth|virbr|bridge|vpn|^tun|^tap|^wg|^utun|tailscale|zerotier|wireguard/i

const privateRank = (address: string): number => {
  const [a, b] = address.split('.').map(Number)
  if (a === 192 && b === 168) return 0
  if (a === 10) return 1
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return 2
  return -1
}

// The address a phone on the same network reaches the page at: a private IPv4 address of this
// computer (192.168.x.x first, as home networks use, then 10.x.x.x, then 172.16-31.x.x), a real
// adapter's before a virtual one's. Never a public, link-local or loopback address, so `--lan`
// cannot put the page on the internet. `wanted` (`--lan <address>`) picks one of them by hand.
export const lanAddress = (interfaces: Record<string, readonly NetAddress[] | undefined>, wanted: string | null = null): string | null => {
  const found = Object.entries(interfaces)
    .flatMap(([name, list]) => (list ?? []).map(one => ({ ...one, name })))
    .filter(one => !one.internal && (one.family === 'IPv4' || one.family === 4) && privateRank(one.address) >= 0)
    .map(one => ({ address: one.address, rank: privateRank(one.address) + (VIRTUAL.test(one.name) ? 10 : 0) }))
    .sort((a, b) => a.rank - b.rank)
  if (wanted !== null) return found.some(one => one.address === wanted) ? wanted : null
  return found[0]?.address ?? null
}

const isSame = (a: string, b: string): boolean => {
  if (b === '' || a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)

  return diff === 0
}

// The names the page answers to on the computer.
export const localHosts = (port: number): string[] => [`127.0.0.1:${port}`, `localhost:${port}`]

// What a request to the page's server is refused with, or null to serve it. The server listens
// on 127.0.0.1 (`localHosts`), and with `--lan` on one network address too, which takes only its
// own `address:port` and its own token. Any web page the person has open can still send it
// requests: the token stops one that does not know it, the Host check stops a name rebound to
// the address (DNS rebinding) from reading the answers, and a write must come from the page
// itself as JSON, which a form on another site cannot send.
export const requestProblem = (request: PageRequest, hosts: readonly string[], token: string): 403 | 405 | 415 | 421 | null => {
  if (!hosts.includes(request.host.toLowerCase())) return 421
  if (!isSame(request.token, token)) return 403
  if (request.method === 'GET') return null
  if (request.method !== 'POST') return 405
  if (request.origin !== '' && !hosts.some(host => request.origin.toLowerCase() === `http://${host}`)) return 403
  if (!/^application\/json\b/i.test(request.contentType)) return 415

  return null
}

// The words the page's script fills in itself, each with its blanks as \u0001 and \u0002.
const PAGE_WORDS = [
  'messagesTitle', 'messagesHint', 'messagesDisabled', 'messagesNone', 'messagesChoose', 'messagesSessionScope',
  'messagesPlaceholder', 'messagesSend', 'messagesQueued', 'messagesUncertain',
  'messagesAccepted', 'messagesAcknowledged', 'messagesRejected', 'messagesFailed', 'messagesConflict', 'messagesTimeout',
  'sessionsTitle', 'sessionsHint', 'sessionsWaiting', 'sessionsReported', 'sessionsTimedOut',
  'sessionsReceiving', 'sessionsNotReceiving', 'sessionsProgress', 'sessionsNoProgress',
  'countWaiting',
  'countActive',
  'countDue',
  'countToday',
  'sectionWaiting',
  'nothingForYou',
  'empty',
  'boardInbox',
  'sectionRecent',
  'archiveNow',
  'serveClosed',
  'serveOffline',
  'serveTickNext',
  'serveArchive',
  'serveCopy',
  'serveCopyResume',
  'serveCopyCommand',
  'serveOpenLink',
  'answeredHide',
  'showAgain',
  'hiddenCount',
  'idleCount',
  'serveReplyPlaceholder',
  'serveMessagePlaceholder',
  'serveSend',
  'serveSending',
  'serveRelay',
  'boardCopied',
  'boardCopyFailed',
] as const satisfies ReadonlyArray<keyof Strings>

// The chat prompt goes as it is in every language: the chat reads it, not the person.
export const pageWords = (s: Strings): Record<string, string> => ({
  ...Object.fromEntries(
    PAGE_WORDS.map(key => {
      const value = s[key] as unknown
      return [key, typeof value === 'function' ? String((value as (...blanks: string[]) => unknown)('\u0001', '\u0002')) : String(value)]
    }),
  ),
  relayPrompt: RELAY,
})

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The headers the page goes out with: its script and style run only with this page's nonce,
// it talks to its own server only, never sends the address (with its token) on to a link it
// opens, and cannot be framed by another page.
export const pagePolicy = (nonce: string): string =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

// `isLan`: the page a phone opens on the local network, which closes sooner.
export const servePage = (s: Strings, nonce: string, isLan = false): string => `<!doctype html>
<html lang="${htmlLang(s)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(s.paneTitle)} · Agent Board</title>
<link rel="icon" href="data:,">
<style nonce="${nonce}">
:root{${vars(LIGHT)};--ground:#fbfaf5;--ink:#2b2b2b;--line:#e3e1d7;--card:#ffffff;color-scheme:light}
@media (prefers-color-scheme:dark){:root{${vars(DARK)};--ground:#1e2022;--ink:#e6e4dc;--line:#34373a;--card:#25282b;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.6 "Hiragino Sans","Noto Sans TC","Noto Sans SC","Microsoft JhengHei","Microsoft YaHei",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px max(16px,env(safe-area-inset-right)) 32px max(16px,env(safe-area-inset-left));display:grid;gap:12px}
header{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px}
h1{font-size:1.35rem;margin:0;flex:1;letter-spacing:.04em}
h2{font-size:1rem;margin:10px 0 0;display:flex;gap:8px;align-items:baseline}
.counts{display:flex;flex-wrap:wrap;gap:4px 16px;font-variant-numeric:tabular-nums}
#board{display:grid;gap:10px;min-width:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:grid;gap:8px;min-width:0}
.where{color:var(--project);font-size:.9rem;overflow-wrap:anywhere}
.q{overflow-wrap:anywhere}
.chip{margin-right:4px}
.quiet{color:var(--muted)}
.small{font-size:.85rem;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:8px}
button,.btn{font:inherit;min-height:40px;padding:6px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;max-width:100%;overflow-wrap:anywhere;text-align:left}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--ground)}
button:disabled{opacity:.5;cursor:default}
button:focus-visible,.btn:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (pointer:coarse){button,.btn{min-height:44px}}
.reply{display:flex;gap:8px;align-items:flex-end}
textarea{width:100%;min-width:0;font-family:inherit;font-size:16px;line-height:1.5;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--ground);color:var(--ink);resize:vertical}
.reply textarea{flex:1}
code{display:block;overflow-x:auto;white-space:pre;font:13px/1.5 ui-monospace,"JetBrains Mono",Consolas,monospace;padding:6px 8px;border:1px solid var(--line);border-radius:6px;color:var(--accent)}
details>summary{cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline}
summary::-webkit-details-marker{display:none}
details>summary::before{content:"▸";color:var(--muted)}
details[open]>summary::before{content:"▾"}
.row .title{font-weight:700;flex:1 1 12em;min-width:0;overflow-wrap:anywhere}
.row .meta{flex-basis:100%;font-size:.9rem;padding-left:1.1em}
.row .body{display:grid;gap:8px;margin-top:6px}
.due{color:var(--soon);font-size:.9rem}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.steps li{display:grid;grid-template-columns:1.4em 1fr;column-gap:4px;overflow-wrap:anywhere}
.steps .now .t{font-weight:700}
.steps .sn{grid-column:2;font-size:.9rem}
.t-accent,.s-doing,.k-input,.k-reply,.n-active{color:var(--accent)}
.t-warn,.s-waiting,.k-confirm,.k-choose,.n-waiting{color:var(--waiting)}
.t-alert,.s-blocked{color:var(--alert)}
.t-done,.s-done,.n-today{color:var(--done)}
.t-running,.s-running,.k-review{color:var(--running)}
.t-soon,.k-do,.n-due{color:var(--soon)}
.t-quiet,.s-todo,.s-cancelled,.k-wait{color:var(--muted)}
#note{position:sticky;bottom:0;padding:10px 0;background:var(--ground);border-top:1px solid var(--line);overflow-wrap:anywhere}
#note:empty{display:none}
#note.done{color:var(--done)}
#note.alert{color:var(--alert)}
.paste textarea{min-height:7em;font-family:ui-monospace,Consolas,monospace;font-size:14px}
</style>
</head>
<body>
<main>
<header><h1>${esc(s.paneTitle)}</h1><button type="button" id="close">${esc(s.serveClose)}</button></header>
<section class="counts" id="counts"></section>
<div id="board"></div>
<details class="card paste"><summary>${esc(s.servePasteTitle)}</summary>
<p class="quiet small">${esc(s.servePasteHint)}</p>
<textarea id="paste" spellcheck="false"></textarea>
<div class="actions"><button type="button" class="primary" id="paste-go">${esc(s.servePaste)}</button><button type="button" id="relay">${esc(s.serveRelay)}</button></div>
<p class="quiet small">${esc(s.serveRelayHint)}</p>
</details>
<p class="quiet small">${esc(isLan ? s.serveLanIdle : s.serveIdle)}</p>
<div id="note" role="status" aria-live="polite"></div>
</main>
<script type="application/json" id="words">${JSON.stringify(pageWords(s)).replace(/</g, '\\u003c')}</script>
<script nonce="${nonce}">${PAGE_SCRIPT}</script>
</body>
</html>
`

// The page's own script: it reads the board from its server every 3 seconds and redraws when
// it changed, keeping what is typed in a box. Text from the file is set as text, never as HTML.
const PAGE_SCRIPT = String.raw`
(function () {
  'use strict';
  var W = JSON.parse(document.getElementById('words').textContent);
  var token = new URLSearchParams(location.search).get('t') || '';
  var board = document.getElementById('board');
  var counts = document.getElementById('counts');
  var note = document.getElementById('note');
  var presence = null;
  var GLYPH = { done: '✓', doing: '▸', todo: '○', waiting: '●', running: '◐', blocked: '!', cancelled: '–' };
  var last = '';
  var opened = {};
  var timer = null;
  var isClosed = false;
  var since = null;
  var messageAttempts = {};

  function w(key, a, b) {
    return String(W[key]).split('\u0001').join(a === undefined ? '' : String(a)).split('\u0002').join(b === undefined ? '' : String(b));
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i += 1) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  function say(text, tone) {
    note.textContent = text || '';
    note.className = tone || '';
  }
  function call(path, body) {
    var headers = { 'x-board-token': token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { data.ok = res.ok; return data; });
    });
  }
  function copy(text, shown) {
    var told = shown === undefined ? text : shown;
    function fallback() {
      var area = el('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var isCopied = false;
      try { isCopied = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(area);
      say(isCopied ? w('boardCopied', told) : w('boardCopyFailed', text), isCopied ? 'done' : 'alert');
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { say(w('boardCopied', told), 'done'); }, fallback);
    else fallback();
  }
  function button(label, onPress, cls) {
    var node = el('button', cls || '', label);
    node.type = 'button';
    node.addEventListener('click', onPress);
    return node;
  }
  // fp: the fingerprint the line was drawn with, which the server checks before it writes.
  function act(key, type, text, waiting, session, asked, fp) {
    say(waiting || '…');
    return call('/api/act', { key: key, type: type, text: text || '', session: session || '', asked: asked || '', fp: fp || '' }).then(function (data) {
      say(data.note || '', data.ok ? 'done' : 'alert');
    }, function () {
      say(w('serveOffline'), 'alert');
    }).then(function () { refresh(); });
  }
  function nativeAct(key, text, delivery, session, asked, fp, go) {
    var slot = JSON.stringify([key, delivery.id, delivery.turn, session, asked, fp]);
    var attempt = messageAttempts[slot];
    if (!attempt || attempt.text !== text) attempt = messageAttempts[slot] = { id: 'AB-' + crypto.randomUUID(), text: text };
    go.disabled = true;
    say(w('serveSending', agentName(delivery.agent)));
    return call('/api/act', { key: key, type: 'message', id: attempt.id, text: text, connection: delivery.id, turn: delivery.turn, session: session, asked: asked || '', fp: fp }).then(function (data) {
      say(data.ok ? '' : data.note || '', data.ok ? 'done' : 'alert');
      if (!data.ok) go.disabled = false;
      return data.ok;
    }, function () { say(w('messagesFailed'), 'alert'); go.disabled = false; return false; }).then(function (ok) { refresh(); return ok; });
  }
  function agentName(agent) { return agent || 'claude'; }
  function receiptLine(receipt) {
    if (!receipt) return null;
    var labels = { queued: 'messagesQueued', uncertain: 'messagesUncertain', accepted: 'messagesAccepted', acknowledged: 'messagesAcknowledged', rejected: 'messagesRejected' };
    if (receipt.status === 'acknowledged' || receipt.status === 'rejected') Object.keys(messageAttempts).forEach(function (slot) { if (messageAttempts[slot].id === receipt.id) delete messageAttempts[slot]; });
    return el('p', 'quiet small', receipt.id + ' · ' + w(receipt.status === 'uncertain' && /TIMEOUT/.test(receipt.error) ? 'messagesTimeout' : labels[receipt.status]) + (receipt.reply ? ' · ' + receipt.reply : ''));
  }
  function replyBox(key, placeholder, mode, agent, where, isSending, session, asked, fp, delivery) {
    var box = el('div', 'reply');
    var input = el('textarea');
    input.rows = 2;
    input.placeholder = placeholder;
    // A draft belongs to its session and its question: a redraw that puts another session's
    // line under the same key starts an empty box, so the text is never sent to that session.
    input.setAttribute('data-key', [key, session || '', asked || '', delivery ? delivery.id + ':' + delivery.turn : ''].join('\u0001'));
    var go = mode === 'send' || mode === 'connected'
      ? button(w('serveSend', agentName(agent)), function () {
        var text = input.value.trim();
        if (!text) return;
        if (mode === 'connected') {
          nativeAct(key, text, delivery, session, asked, fp, go).then(function (ok) { if (ok) input.value = ''; });
          return;
        }
        input.value = '';
        act(key, 'send', text, w('serveSending', agent), session, asked, fp);
      }, 'primary')
      : button(w('serveCopy'), function () {
        var text = input.value.trim();
        if (text) copy(text);
      });
    go.disabled = isSending === true;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click(); }
    });
    var wrap = el('div');
    add(wrap, add(box, input, go));
    if (where) add(wrap, el('div', 'quiet small', where));
    return wrap;
  }
  function stepsList(steps) {
    var list = el('ol', 'steps');
    steps.forEach(function (step) {
      var item = el('li', step.isCurrent ? 'now' : '');
      add(item, el('span', 's-' + step.status, GLYPH[step.status] || '○'), el('span', 't' + (step.status === 'done' || step.status === 'cancelled' ? ' t-quiet' : ''), step.text));
      if (step.note) add(item, el('span', 'sn s-' + step.status, step.note));
      list.appendChild(item);
    });
    return list;
  }
  function askCard(ask) {
    var card = el('article', 'card ask');
    add(card, el('div', 'where', [ask.project, ask.agent].filter(Boolean).join(' · ') + (ask.task ? ' › ' + ask.task : '')));
    add(card, add(el('div', 'q'), el('span', 'chip k-' + ask.kind, ask.chip), el('b', '', ask.text)));
    if (ask.note) add(card, el('div', '', ask.note));
    else if (ask.context) add(card, el('div', 'quiet', ask.context));
    if (ask.command) add(card, el('code', '', '$ ' + ask.command));
    var actions = el('div', 'actions');
    if (ask.canTick) actions.appendChild(button(w('serveTickNext', ask.text), function () { act(ask.key, 'tick', '', '', '', '', ask.fp); }, 'primary'));
    ask.answers.forEach(function (answer, index) {
      var send = ask.send === 'send' || ask.send === 'connected';
      var node = button(answer, function () {
        if (ask.send === 'connected') nativeAct(ask.key, answer, ask.delivery, ask.session, ask.text, ask.fp, node);
        else if (send) act(ask.key, 'send', answer, w('serveSending', ask.agent), ask.session, ask.text, ask.fp);
        else copy(answer);
      }, index === 0 ? 'primary' : '');
      node.disabled = send && ask.isSending;
      actions.appendChild(node);
    });
    if (ask.command) actions.appendChild(button(w('serveCopyCommand'), function () { copy(ask.command); }));
    if (ask.reopen) actions.appendChild(button(w('serveCopyResume'), function () { copy(ask.reopen); }));
    if (ask.canHide) actions.appendChild(button(w('answeredHide'), function () { act(ask.key, 'hide'); }));
    if (ask.link && /^https:\/\//i.test(ask.link)) {
      var link = el('a', 'btn', w('serveOpenLink'));
      link.href = ask.link;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      actions.appendChild(link);
    }
    if (actions.childNodes.length) add(card, actions);
    if (!ask.canTick) add(card, replyBox(ask.key, w('serveReplyPlaceholder'), ask.send, ask.agent, ask.where, ask.isSending, ask.session, ask.text, ask.fp, ask.delivery));
    if (ask.receipt) add(card, receiptLine(ask.receipt));
    if (ask.info) add(card, el('div', 'quiet small', ask.info));
    if (ask.back) add(card, el('div', 'quiet small', ask.back));
    if (ask.reopen) add(card, el('code', '', '$ ' + ask.reopen));
    return card;
  }
  function rowCard(row) {
    var card = el('details', 'card row');
    var isWaiting = row.isAsking;
    // A reply goes with the question it was written under, and only while it is still asked.
    var asked = row.question;
    card.open = row.key in opened ? opened[row.key] : row.send === 'send' || isWaiting;
    card.addEventListener('toggle', function () { opened[row.key] = card.open; });
    var summary = el('summary');
    add(summary, el('span', 'title', row.title));
    if (row.due) add(summary, el('span', 'due', '⚑ ' + row.due));
    add(summary, el('span', 'meta t-' + row.tone, (row.total > 0 ? row.done + '/' + row.total + ' ' : '') + row.status + (row.agent ? ' · ' + row.agent : '') + (row.when ? ' · ' + row.when : '')));
    card.appendChild(summary);
    var body = el('div', 'body');
    if (row.context) add(body, el('div', 'quiet', row.context));
    if (row.pr) add(body, el('div', 'quiet', row.pr));
    if (row.steps.length) add(body, stepsList(row.steps));
    if (row.handoff) add(body, el('div', 'quiet small', row.handoff));
    var actions = el('div', 'actions');
    if (row.next) actions.appendChild(button(w('serveTickNext', row.next), function () { act(row.key, 'tick', row.next, '', '', '', row.fp); }, 'primary'));
    if (row.canArchive) actions.appendChild(button(w('serveArchive'), function () { act(row.key, 'archive', '', '', '', '', row.fp); }));
    if (row.resume) actions.appendChild(button(w('serveCopyResume'), function () { copy(row.resume); }));
    if (actions.childNodes.length) add(body, actions);
    if (row.resume) add(body, el('code', '', row.resume));
    if (row.send === 'send' || row.send === 'connected') add(body, replyBox(row.key, w('serveMessagePlaceholder', agentName(row.agent)), row.send, row.agent, row.where, row.isSending, row.session, asked, row.fp, row.delivery));
    else if (row.hasCopyBox) add(body, replyBox(row.key, w('serveReplyPlaceholder'), 'copy', row.agent, '', false, row.session, asked));
    if (row.receipt) add(body, receiptLine(row.receipt));
    if (row.info) add(body, el('div', 'quiet small', row.info));
    card.appendChild(body);
    return card;
  }
  function turnCard(turn) {
    var card = el('article', 'card turn');
    add(card, el('div', 'where', [turn.project, turn.agent].filter(Boolean).join(' · ')));
    add(card, el('div', turn.isQuestion ? 'q' : '', turn.text));
    if (turn.isQuestion) add(card, replyBox(turn.key, w('serveReplyPlaceholder'), 'copy', turn.agent, '', false));
    if (turn.info) add(card, el('div', 'quiet small', turn.info));
    return card;
  }
  function render(model) {
    // What is typed, and where the cursor is, outlast a redraw.
    var kept = {};
    board.querySelectorAll('textarea[data-key]').forEach(function (box) { kept[box.getAttribute('data-key')] = box.value; });
    var active = document.activeElement;
    var focus = active && active.getAttribute ? active.getAttribute('data-key') : null;
    var caret = focus ? [active.selectionStart, active.selectionEnd] : null;
    counts.textContent = '';
    [['●', model.counts.waiting, 'countWaiting', 'n-waiting'], ['▸', model.counts.active, 'countActive', 'n-active'], ['⚑', model.counts.due, 'countDue', 'n-due'], ['✓', model.counts.today, 'countToday', 'n-today']].forEach(function (one) {
      add(counts, add(el('span'), el('span', one[1] > 0 ? one[3] : 'quiet', one[0] + ' ' + one[1]), document.createTextNode(' ' + w(one[2]))));
    });
    board.textContent = '';
    add(board, el('h2', 'n-waiting', '● ' + w('sectionWaiting')));
    if (model.asks.length === 0) add(board, el('div', 'n-today', w('nothingForYou')));
    model.asks.forEach(function (ask) { board.appendChild(askCard(ask)); });
    if (model.hidden.length) {
      var shelf = el('details', 'card');
      shelf.open = opened['hidden:'] === true;
      shelf.addEventListener('toggle', function () { opened['hidden:'] = shelf.open; });
      add(shelf, add(el('summary'), el('span', 'quiet', w('hiddenCount', model.hidden.length))));
      model.hidden.forEach(function (one) {
        add(shelf, add(el('div'), el('div', 'where', [one.project, one.agent].filter(Boolean).join(' · ') + (one.task ? ' › ' + one.task : '')), el('div', 'q', one.text), add(el('div', 'actions'), button(w('showAgain'), function () { act(one.key, 'unhide'); }))));
      });
      board.appendChild(shelf);
    }
    if (model.idle.length) {
      var idleShelf = el('details', 'card');
      idleShelf.open = opened['idle:'] === true;
      idleShelf.addEventListener('toggle', function () { opened['idle:'] = idleShelf.open; });
      add(idleShelf, add(el('summary'), el('span', 'quiet', w('idleCount', model.idle.length))));
      model.idle.forEach(function (row) {
        add(idleShelf, el('div', 'where', row.project), rowCard(row));
      });
      board.appendChild(idleShelf);
    }
    model.groups.forEach(function (group) {
      add(board, el('h2', 'where', '▸ ' + group.project));
      group.rows.forEach(function (row) { board.appendChild(rowCard(row)); });
    });
    if (model.turns.length) {
      add(board, el('h2', 'n-active', '◐ ' + w('boardInbox')));
      model.turns.forEach(function (turn) { board.appendChild(turnCard(turn)); });
    }
    if (model.recent.length) {
      add(board, el('h2', 'n-today', '✓ ' + w('sectionRecent')));
      var done = el('ul', 'steps');
      model.recent.forEach(function (item) {
        add(done, add(el('li'), el('span', 's-done', '✓'), el('span', 't-quiet', [item.project, item.title, item.when].filter(Boolean).join(' · '))));
      });
      add(board, add(el('div', 'card'), done, add(el('div', 'actions'), button(w('archiveNow'), function () {
        say('…');
        call('/api/tidy', {}).then(function (data) { say(data.note || '', data.ok ? 'done' : 'alert'); refresh(); }, function () { say(w('serveOffline'), 'alert'); });
      }))));
    }
    if (model.groups.length === 0 && model.asks.length === 0 && model.hidden.length === 0 && model.idle.length === 0 && model.turns.length === 0 && model.recent.length === 0) add(board, el('div', 'quiet', w('empty')));
    board.querySelectorAll('textarea[data-key]').forEach(function (box) {
      var key = box.getAttribute('data-key');
      if (key in kept) box.value = kept[key];
      if (key === focus) {
        box.focus();
        if (caret) box.setSelectionRange(caret[0], caret[1]);
      }
    });
  }
  function refresh() {
    if (isClosed) return;
    clearTimeout(timer);
    call('/api/board').then(function (data) {
      if (!data.ok || !data.model) { say(data.note || w('serveOffline'), 'alert'); return; }
      var text = JSON.stringify([data.model, data.messaging && data.messaging.sessions]);
      if (text !== last) {
        last = text; render(data.model);
        if (presence) { presence.remove(); presence = null; }
        var sessions = data.messaging && data.messaging.sessions || [];
        if (sessions.length) {
          presence = el('section', 'card');
          add(presence, el('h2', '', w('sessionsTitle')), el('p', 'quiet small', w('sessionsHint')));
          sessions.forEach(function (one) {
            var state = one.status === 'reported' ? w('sessionsReported') : one.status === 'timed_out' ? w('sessionsTimedOut') : one.status === 'waiting' ? w('sessionsWaiting') : '';
            add(presence, add(el('div'), el('div', 'where', [one.agent, one.surface, one.session.slice(0, 8)].join(' · ')), el('div', one.status === 'timed_out' ? 's-blocked small' : 'small', state), el('div', 'quiet small', [w(one.progress ? 'sessionsProgress' : 'sessionsNoProgress'), w(one.receiving ? 'sessionsReceiving' : 'sessionsNotReceiving')].join(' · '))));
          });
          board.insertAdjacentElement('afterend', presence);
        }
      }
      // A reply runs in the background; its answer comes with the board once the agent is done.
      if (since === null) since = data.now;
      (data.replies || []).forEach(function (reply) {
        if (reply.at > since) { since = reply.at; say(reply.note, reply.ok ? 'done' : 'alert'); }
      });
    }, function () {
      say(w('serveOffline'), 'alert');
    }).then(function () {
      if (!isClosed) timer = setTimeout(refresh, 3000);
    });
  }
  document.getElementById('close').addEventListener('click', function () {
    var shut = function () {
      isClosed = true;
      clearTimeout(timer);
      var main = document.querySelector('main');
      main.textContent = '';
      add(main, el('p', '', w('serveClosed')));
    };
    call('/api/close', {}).then(function (data) {
      if (data.ok) shut();
      else say(data.note || '', 'alert');
    }, shut);
  });
  document.getElementById('paste-go').addEventListener('click', function () {
    var box = document.getElementById('paste');
    if (!box.value.trim()) return;
    call('/api/paste', { text: box.value }).then(function (data) {
      say(data.note || '', data.ok ? 'done' : 'alert');
      if (data.ok) box.value = '';
      refresh();
    }, function () { say(w('serveOffline'), 'alert'); });
  });
  document.getElementById('relay').addEventListener('click', function () { copy(W.relayPrompt, w('serveRelay')); });
  refresh();
})();
`

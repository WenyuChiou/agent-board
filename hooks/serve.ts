import type { AskKind } from './ask'
import { answersOf, boardItems, fingerprint, remainingInbox } from './board'
import type { BoardItem, PendingTurn } from './board'
import { htmlLang } from './dashboard'
import { AGENT_ALIASES, agentMarkCss, boardMark, pageBaseCss, pageTokens, themeHead, themeSwitch } from './page-look'
import { RELAY, ZH_TW } from './i18n'
import type { Strings } from './i18n'
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

export const idleTimeout = (value: string | undefined): number => {
  if (value === undefined) return 0
  if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > 525600) throw new Error('INVALID_IDLE_MINUTES')
  return Number(value) * 60_000
}

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
  // A hand-kept question, the person's own (its agent is '', as Claude Code's is); absent otherwise.
  isOwn?: true
  canTick: boolean
  // Another session's question can be marked answered: kept off the board until it changes.
  canHide: boolean
  archiveNote: string
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
  // A hand-kept task, the person's own (its agent is '', as Claude Code's is); absent otherwise.
  isOwn?: true
  canArchive: boolean
  canConfirm: boolean
  archiveNote: string
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
export type ServeHidden = { key: string; project: string; agent: string; isOwn?: true; task: string; text: string }
export type ServeRetained = { project: string; agent: string; isOwn?: true; task: string; text: string; note: string; context: string; when: string }

export type ServeTurn = { key: string; project: string; agent: string; text: string; isQuestion: boolean; info: string }

export type ServeModel = {
  warning?: string
  counts: { waiting: number; active: number; due: number; today: number }
  asks: ServeAsk[]
  hidden: ServeHidden[]
  reminder: ServeRetained[]
  older: ServeRetained[]
  idle: ServeRow[]
  stopped: ServeRow[]
  groups: Array<{ project: string; rows: ServeRow[] }>
  turns: ServeTurn[]
  // Finished in the last day, until it goes to the archive.
  recent: Array<{ project: string; title: string; when: string; questions?: string[] }>
}

// `task` and `session` name the Claude Code session to answer in, the way the pane does.
const infoOf = (mode: SendMode, agent: string, task: string, session: string, s: Strings): string => {
  if (mode === 'open') return s.serveSendOpen(agent)
  if (mode === 'claude') return s.replyElsewhere(task, '', '')
  if (mode === 'none') return s.serveSendNone(agent)

  return ''
}

// The keys are the terminal board's (`boardItems`), so a press names the line it was on.
// `isLan`: the page as a phone sees it on the local network, where a reply that would run an
// agent on the computer is offered as a copy instead.
export const serveModel = (view: View, pending: readonly PendingTurn[], s: Strings = ZH_TW, sending: ReadonlySet<string> = new Set(), isLan = false, messaging?: Messaging, allowResume = false): ServeModel => {
  const isSending = (target: AgentTarget | null): boolean => target !== null && sending.has(sendKey(target))
  const onLan = (mode: SendMode): SendMode => (isLan && mode === 'send' ? 'open' : mode)
  const lanInfo = (mode: SendMode, agent: string): string | null => (isLan && mode === 'send' ? s.serveLanSend(agent) : null)
  const asks: ServeAsk[] = []
  const groups = new Map<string, ServeRow[]>()
  const idle: ServeRow[] = []
  const idleKeys = new Set(view.idle.map(row => row.key))
  const stopped: ServeRow[] = []
  const stoppedKeys = new Set(view.stopped.map(row => row.key))
  const turns: ServeTurn[] = []
  const items = boardItems(view, pending)
  for (const item of items) {
    if (item.type === 'ask') {
      const { ask } = item
      const isManual = ask.where === 'manual'
      const connection = isManual || isLan ? undefined : liveTarget(ask.agent, ask.nativeSession, messaging?.connections ?? [])
      const baseMode = isManual ? 'none' : sendMode(ask.agent, ask.target)
      const mode = connection ? 'connected' : (messaging || !allowResume) && baseMode === 'send' ? 'open' : baseMode
      const send = onLan(mode)
      // A phone on the local network gets the id, but neither the command nor its folder.
      const hint = replyHint(ask, s, !isLan)
      asks.push({
        ...(connection === undefined ? {} : { delivery: { id: connection.id, turn: connection.turn, agent: connection.agent } }),
        ...(isLan ? {} : rowReceipt(ask.agent, ask.nativeSession, messaging?.messages ?? [])),
        key: item.key,
        project: ask.project,
        agent: ask.agent,
        ...(isManual ? { isOwn: true as const } : {}),
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
        canHide: ask.hideKey !== '' && ask.canHide !== false,
        send,
        session: connection?.session ?? ask.target?.session ?? '',
        fp: fingerprint(item, items),
        where: send === 'send' ? (ask.target?.dir ?? '') : '',
        archiveNote: isManual ? '' : s.archiveLive,
        info: connection || isManual ? '' : (lanInfo(baseMode, ask.agent) ?? infoOf(send, ask.agent, ask.task, '', s)),
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
      const mode = connection ? 'connected' : (messaging || !allowResume) && baseMode === 'send' ? 'open' : baseMode
      const send = onLan(mode)
      const rows = idleKeys.has(row.key) ? idle : stoppedKeys.has(row.key) ? stopped : (groups.get(row.project) ?? [])
      if (!idleKeys.has(row.key) && !stoppedKeys.has(row.key)) groups.set(row.project, rows)
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
        ...(row.auto === null ? { isOwn: true as const } : {}),
        done: row.done,
        total: row.total,
        due: row.due?.left ?? null,
        pr: row.pr,
        steps: row.steps.map(step => ({ text: step.text, note: step.note, status: step.status, isCurrent: step.isCurrent })),
        next: row.next?.step ?? null,
        canArchive: row.archive !== null,
        canConfirm: row.confirm != null,
        archiveNote: row.auto === 'working' || row.auto === 'waiting' ? s.archiveLive : '',
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
        info: connection ? '' : lanInfo(baseMode, row.agent) ?? (send === 'open' ? infoOf(send, row.agent, row.title, '', s) : ''),
        isSending: isSending(row.target) || connection !== undefined && (messaging?.messages.some(one => one.target === connection.id && ['queued', 'uncertain', 'accepted'].includes(one.status)) ?? false),
        hasCopyBox: lanInfo(baseMode, row.agent) !== null || (messaging !== undefined || !allowResume) && row.auto !== null && connection === undefined,
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
      // Connection closure does not answer an unresolved inbox question.
      info: turn.isQuestion ? infoOf(SENDERS.has(turn.agent) ? 'open' : 'none', turn.agent, '', '', s) : '',
    })
  }

  return {
    counts: { ...view.overview, waiting: view.overview.waiting + remainingInbox(view, pending).filter(turn => turn.isQuestion).length },
    warning: view.warning,
    asks,
    idle,
    stopped,
    hidden: view.hidden.map(item => ({ key: `hidden:${item.hideKey}`, project: item.project, agent: item.agent, ...(item.where === 'manual' ? { isOwn: true as const } : {}), task: item.task, text: item.text })),
    reminder: (view.reminder ?? []).map(({ project, agent, where, task, text, note, context, when }) => ({ project, agent, ...(where === 'manual' ? { isOwn: true as const } : {}), task, text, note, context, when })),
    older: (view.older ?? []).map(({ project, agent, where, task, text, note, context, when }) => ({ project, agent, ...(where === 'manual' ? { isOwn: true as const } : {}), task, text, note, context, when })),
    groups: [...groups].map(([project, rows]) => ({ project, rows })),
    turns,
    recent: view.recent.map(item => ({ project: item.project, title: item.title, when: item.when, questions: item.questions?.map(question => [question.text, question.note].filter(Boolean).join(' — ')) })),
  }
}

// `asked`: with a reply, the question the page showed it under ('' for none). `fp`: the line's
// fingerprint as the page drew it; a tick, an archive and a reply need it, hide and unhide do not.
export type ServeRequest = { key: string; type: string; text: string; session: string; asked?: string; fp?: string; connection?: string; turn?: string }

export type ServeAction =
  | { type: 'tick'; ref: StepRef }
  | { type: 'archive'; ref: TaskRef; title: string }
  | { type: 'done'; ref: import('./blocks').ConfirmRef; title: string }
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
export const serveAction = (items: readonly BoardItem[], request: ServeRequest, s: Strings = ZH_TW, isLan = false, connections: readonly Connection[] = [], isMessaging = false, allowResume = false): ServeAction => {
  const action = actionOf(items, request, s, isLan, connections, isMessaging, allowResume)
  if (action.type === 'refuse' && action.note === '') return { type: 'refuse', note: s.pressNothing }
  if (action.type !== 'tick' && action.type !== 'archive' && action.type !== 'done' && action.type !== 'send' && action.type !== 'message') return action
  // The key is a project and a title, which another session's block can take over, and a step
  // can be reworded under it: the press goes through only on the block and words the page drew.
  const item = items.find(one => one.key === request.key)

  return item !== undefined && request.fp === fingerprint(item, items) ? action : { type: 'refuse', note: s.boardLineChanged }
}

const actionOf = (items: readonly BoardItem[], request: ServeRequest, s: Strings, isLan: boolean, connections: readonly Connection[], isMessaging: boolean, allowResume: boolean): ServeAction => {
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
  if (request.type === 'hide') return item.type === 'ask' && item.ask.hideKey !== '' && item.ask.canHide !== false ? { type: 'hide', key: item.ask.hideKey, text: item.ask.text } : { type: 'refuse', note: '' }
  if (request.type === 'archive') {
    if (item.type === 'row' && item.row.archive !== null) return { type: 'archive', ref: item.row.archive, title: item.row.title }
    const isLive = item.type === 'row' && (item.row.auto === 'working' || item.row.auto === 'waiting') || item.type === 'ask' && item.ask.where !== 'manual'
    return { type: 'refuse', note: isLive ? s.archiveLive : s.archiveGone }
  }
  if (request.type === 'done') {
    return item.type === 'row' && item.row.confirm != null ? { type: 'done', ref: item.row.confirm, title: item.row.title } : { type: 'refuse', note: s.boardLineChanged }
  }
  if (request.type !== 'send' && request.type !== 'message') return { type: 'refuse', note: '' }
  const text = replyText(request.text)
  if (text === '') return { type: 'refuse', note: s.pressEmpty }
  if (item.type === 'turn') return { type: 'refuse', note: infoOf(SENDERS.has(item.turn.agent) ? 'open' : 'none', item.turn.agent, '', '', s) }
  const { agent, target } = item.type === 'ask' ? item.ask : item.row
  // A hand-kept question is answered by ticking it: there is no one to send to.
  if (item.type === 'ask' && item.ask.where === 'manual') return { type: 'refuse', note: s.serveManualReply }
  const mode = target === null ? (agent === '' ? 'claude' : 'none') : sendMode(agent, target)
  const title = item.type === 'ask' ? item.ask.task : item.row.title
  if (request.type === 'message') {
    const native = item.type === 'ask' ? item.ask.nativeSession : item.row.nativeSession
    const connected = liveTarget(agent, native, connections)
    const question = item.type === 'ask' ? item.ask.text : item.row.question ?? ''
    if (isLan || !connected || connected.id !== request.connection || connected.turn !== request.turn || connected.session !== request.session || (request.asked ?? '') !== question || !text) return { type: 'refuse', note: s.messagesFailed }
    return { type: 'message', connection: { id: connected.id, turn: connected.turn, agent: connected.agent }, text, title }
  }
  if (mode !== 'send' || target === null) return { type: 'refuse', note: infoOf(mode, agent, title, item.type === 'ask' ? item.ask.session : '', s) }
  if (isLan) return { type: 'refuse', note: s.serveLanSend(agent) }
  // A closed progress record is not a live receiver. Resuming a saved session is a
  // separate, explicitly enabled action, never a fallback for a disconnected adapter.
  if (isMessaging || !allowResume) return { type: 'refuse', note: s.messagesFailed }
  // Keys are a project and a title, which another session's block can take over between the
  // page's redraw and the press.
  if (request.session !== target.session) return { type: 'refuse', note: s.boardLineChanged }
  // An answer goes with the question it answers, the way the pane words one for Claude, and
  // only while that question is still the one asked: a task keeps its key while its question
  // is answered, reworded, replaced by another or marked answered here.
  const question = item.type === 'ask' ? item.ask.text : (item.row.question ?? undefined)
  if ((request.asked ?? '') !== (question ?? '')) return { type: 'refuse', note: s.boardLineChanged }
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
  'viewAll', 'viewStopped', 'viewCount', 'viewCountOne', 'sideViews', 'sideProjects', 'sideAgents', 'sideOwnTasks',
  'viewEmptyDue', 'viewEmptyStopped', 'viewEmptyRecent', 'viewEmptyFiltered', 'clearFilters', 'removeFilter',
  'sectionActive', 'sectionDue',
  'messagesQueued', 'messagesUncertain',
  'messagesAccepted', 'messagesAcknowledged', 'messagesRejected', 'messagesFailed', 'messagesTimeout',
  'sessionsTitle', 'sessionsWaiting', 'sessionsTimedOut',
  'sectionWaiting',
  'sectionQuestionReminders',
  'sectionOlderQuestions',
  'questionAgingHint',
  'questionReviewOnly',
  'nothingForYou',
  'empty',
  'boardInbox',
  'sectionRecent',
  'archiveNow',
  'serveClosed',
  'serveClose',
  'serveOffline',
  'serveTickNext',
  'serveArchive',
  'confirmDone',
  'serveCopy',
  'serveCopyResume',
  'serveCopyCommand',
  'serveOpenLink',
  'answeredHide',
  'showAgain',
  'hiddenCount',
  'idleCount',
  'stoppedCount',
  'serveReplyPlaceholder',
  'serveMessagePlaceholder',
  'serveSend',
  'serveSending',
  'servePasteTitle',
  'pasteReview',
  'copied',
  'pressDone',
  'pressFailed',
  'pressEmpty',
  'pressPending',
  'boardCopyFailedBelow',
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
export const servePage = (s: Strings, nonce: string, isLan = false, idleMs = 0): string => `<!doctype html>
<html lang="${htmlLang(s)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(s.paneTitle)} · Agent Board</title>
<link rel="icon" href="data:,">
<script nonce="${nonce}">${themeHead}</script>
<style nonce="${nonce}">
${pageTokens()}
${pageBaseCss}
${agentMarkCss()}
:root{--shadow:0 1px 2px rgba(0,0,0,.05),0 2px 8px -4px rgba(0,0,0,.08);--card:var(--surface)}
.shell{display:grid;grid-template-columns:236px minmax(0,1fr);column-gap:36px;align-items:start}
body:not(:has(#board)) :is(#side,#side-open,#side-scrim,.live){display:none}.shell:not(:has(#board)){grid-template-columns:minmax(0,1fr)}
main{min-width:0;max-width:780px;display:grid;gap:22px;padding-block:18px 40px}
#board{display:grid;gap:10px;min-width:0}
#board>h2{position:sticky;top:var(--head-h,54px);z-index:3;background:var(--ground);font-size:1rem;margin:8px 0 0;padding:8px 0;display:flex;gap:8px;align-items:baseline}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:grid;gap:10px;min-width:0;box-shadow:var(--shadow)}
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
#offline{position:sticky;top:0;background:var(--ground);color:var(--alert);overflow-wrap:anywhere;padding:8px 0;border-bottom:1px solid var(--line)}
#offline:empty{display:none}
#note{position:sticky;bottom:0;padding:10px 0;background:var(--ground);border-top:1px solid var(--line);overflow-wrap:anywhere}
#note:empty{display:none}
#note.done{color:var(--done)}
#note.alert{color:var(--alert)}
.press-result.done{color:var(--done)}
.press-result.alert{color:var(--alert)}
.press-result:empty{display:none}
.paste textarea{min-height:7em;font-family:ui-monospace,Consolas,monospace;font-size:14px}

button.primary{color:var(--on-accent)}
button:hover,.btn:hover{background:var(--inset);border-color:var(--line-strong)}
button.primary:hover{background:var(--accent);filter:brightness(.94)}
.live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);padding:2px 9px;border:1px solid var(--line);border-radius:999px;background:var(--surface)}
.live i{width:7px;height:7px;border-radius:50%;background:var(--done)}
body:has(#offline:not(:empty)) .live{display:none}
#offline:not(:empty){top:var(--head-h,54px);z-index:5;padding:10px max(16px,calc((100vw - 1148px)/2));border-color:color-mix(in srgb,var(--alert) 35%,var(--line));background:color-mix(in srgb,var(--alert) 9%,var(--ground))}
#offline:not(:empty)::before{content:'!';display:inline-grid;place-items:center;width:18px;height:18px;border:1px solid currentColor;border-radius:50%;margin-right:10px;font-weight:700}
#side{position:sticky;top:var(--head-h,54px);max-height:calc(100dvh - var(--head-h,54px));overflow:auto;padding:20px 0 28px;display:grid;gap:22px;align-content:start}
.side-head,#side-open,.scrim{display:none}
.grp{display:grid;gap:2px}.grp h3{margin:0 0 6px;padding:0 10px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
#side-groups{display:grid;gap:22px}
button.nav{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:10px;width:100%;min-height:34px;padding:6px 10px;border:1px solid transparent;border-radius:9px;background:transparent;font-size:14px}
button.nav:hover{background:var(--surface);border-color:var(--line)}
button.nav[aria-pressed="true"]{background:var(--surface);border-color:var(--line-strong);font-weight:600;box-shadow:var(--shadow)}
.nav .ct{font-size:12px;font-variant-numeric:tabular-nums;color:var(--muted)}
.pd{width:8px;height:8px;justify-self:center;border-radius:50%;background:var(--accent)}.pd.waiting{background:var(--waiting)}.pd.soon{background:var(--soon)}.pd.muted{background:var(--muted)}.pd.done{background:var(--done)}.pd.ink{background:var(--ink)}
#counts{display:none;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--surface)}
#counts>button{border:0;border-radius:0;border-left:1px solid var(--line);display:grid;gap:2px;min-width:0;padding:12px;font-size:13px}#counts>button:first-child{border-left:0}#counts>button>span:first-child{font-size:24px;font-weight:650}
.scope{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px}.scope h2{margin:0;font-size:1.25rem}.scope .n{font-size:13.5px;color:var(--muted)}
button.fchip{min-height:28px;padding:0 10px;border-radius:999px;background:var(--surface);border-color:var(--line-strong);font-size:12.5px}
.empty{padding:28px 20px;justify-items:center;text-align:center}.empty p{margin:0;color:var(--muted)}
.composer{border:1px solid var(--line-strong);border-radius:12px;background:var(--inset);overflow:hidden}.composer:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
.composer textarea{display:block;border:0;background:transparent;min-height:52px;padding:10px 12px 2px;outline:none}.composer .cf{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px}.composer .where{flex:1;padding-left:6px;color:var(--muted);font-size:12.5px}.composer button{margin-left:auto;min-height:32px;font-size:13px}
.ask .where,.turn .where{display:flex;align-items:flex-start;gap:7px}.ask .where>span:last-child,.turn .where>span:last-child{min-width:0}.where .ag{margin-top:1px}.q{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px}.q b{font-size:1.08rem;font-weight:600}.chip{font-size:12px;border:1px solid currentColor;padding:3px 8px;border-radius:999px}
.meta .ag{width:22px;height:22px;margin-right:6px;vertical-align:middle}.archive-note{font-size:12px}
.steps li{grid-template-columns:22px minmax(0,1fr);gap:5px 10px;padding:5px 8px;border-radius:8px}.steps li.now{background:var(--inset)}.steps .mk{width:22px;height:22px;display:grid;place-items:center;font-size:14px;cursor:default;user-select:none}
.history>div{padding:10px 0;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pfoot{display:flex;align-items:center;gap:10px 16px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:14px;font-size:12.5px;color:var(--muted)}.pfoot p{margin:0;flex:1 1 22em}.pfoot button{font-size:13px;min-height:32px}.pfoot .press-result{flex-basis:100%}
@media (max-width:760px){.shell{grid-template-columns:minmax(0,1fr)}#counts{display:grid}#side-open{display:inline-flex;min-height:32px;padding:0 8px}.side-head{display:flex;justify-content:space-between;align-items:center;padding:0 10px;font-weight:600}#side{position:fixed;z-index:30;inset:0 auto 0 0;width:min(304px,86vw);max-height:100dvh;padding:14px 12px 28px;background:var(--surface);border-right:1px solid var(--line);transform:translateX(-105%);visibility:hidden;transition:transform .2s,visibility 0s linear .2s}body.drawer-open #side{transform:none;visibility:visible;transition:transform .2s}body.drawer-open .scrim{display:block;position:fixed;inset:0;z-index:25;background:rgba(10,12,13,.38);border:0;border-radius:0;width:100%;height:100%}}
@media (max-width:600px){#counts{grid-template-columns:repeat(2,1fr)}#counts>button:nth-child(3){border-left:0}#counts>button:nth-child(n+3){border-top:1px solid var(--line)}.live{font-size:11px}.card{padding:14px}.scope h2{font-size:1.1rem}}
</style>
</head>
<body>
<header class="head" id="head"><div class="wide topbar"><button type="button" id="side-open" data-local aria-controls="side" aria-expanded="false" aria-label="${esc(s.sideTitle)}">☰</button><div class="brand">${boardMark}<h1>${esc(s.paneTitle)}</h1><span class="live" title="${esc(s.serveLiveHint)}"><i></i>${esc(s.serveLive)}</span></div>${themeSwitch(s)}</div></header>
<div id="offline" role="status" aria-live="polite"></div>
<button type="button" class="scrim" id="side-scrim" data-local aria-label="${esc(s.sideClose)}" tabindex="-1"></button>
<div class="wide shell"><aside id="side" aria-label="${esc(s.sideTitle)}"><div class="side-head">${esc(s.sideTitle)}<button type="button" id="side-close" data-local>${esc(s.sideClose)}</button></div><div id="side-groups"></div></aside>
<main>
<section class="counts" id="counts"></section>
<div id="scope" class="scope"></div>
<div id="board"></div>
<details class="card paste"><summary>${esc(s.servePasteTitle)}</summary>
<p class="quiet small">${esc(s.servePasteHint)}</p>
<textarea id="paste" spellcheck="false"></textarea>
<div class="actions"><button type="button" class="primary" id="paste-go" data-static>${esc(s.servePaste)}</button><button type="button" id="relay" data-local>${esc(s.serveRelay)}</button></div>
<p class="quiet small">${esc(s.serveRelayHint)}</p>
</details>
<footer class="pfoot"><p>${esc(isLan ? s.serveLanIdle : idleMs > 0 ? s.serveIdleTimed(idleMs / 60_000) : s.serveIdle)}</p><button type="button" id="close" data-static>${esc(s.serveClose)}</button></footer>
<div id="note" role="status" aria-live="polite"></div>
</main></div>
<script type="application/json" id="words">${JSON.stringify(pageWords(isLan ? { ...s, serveOffline: s.serveOfflineLan } : s)).replace(/</g, '\\u003c')}</script>
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
  var offline = document.getElementById('offline');
  var presence = null;
  var GLYPH = { done: '✓', doing: '▸', todo: '•', waiting: '●', running: '◐', blocked: '!', cancelled: '–' };
  var last = '';
  var opened = {};
  var timer = null;
  var isClosed = false;
  var isUnreachable = false;
  var offlineButtons = [];
  var since = null;
  var messageAttempts = {};

  function w(key, a, b) {
    var template = String(W[key === 'viewCount' && a === 1 ? 'viewCountOne' : key]);
    return template.split('\u0001').join(a === undefined ? '' : String(a)).split('\u0002').join(b === undefined ? '' : String(b));
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
  var results = {};
  var resultSlots = {};
  var lostResults = [];
  resultSlot(document.querySelector('.pfoot'), 'close', '', w('serveClose'));
  function resultSlot(card, key, revision, label) {
    card.setAttribute('data-card-key', key);
    var previous = results[key];
    if (previous && previous.awaitingRefresh) { previous.revision = revision; previous.awaitingRefresh = false; }
    else if (previous && !previous.pending && previous.tone !== 'alert' && previous.revision && revision && previous.revision !== revision) delete results[key];
    var slot = el('div', 'small press-result');
    slot.setAttribute('role', 'status');
    resultSlots[key] = { node: slot, revision: revision, label: label };
    card.appendChild(slot);
    if (results[key]) paintResult(key);
  }
  function paintResult(key) {
    var slot = resultSlots[key];
    var result = results[key];
    if (!slot || !result) return;
    slot.node.textContent = result.text;
    slot.node.className = 'small press-result ' + result.tone;
    if (result.copyText) {
      var area = el('textarea');
      area.value = result.copyText;
      area.setAttribute('readonly', '');
      slot.node.appendChild(area);
      result.area = area;
      if (!result.focused) {
        area.focus({ preventScroll: true });
        area.select();
        if (area.scrollIntoView) area.scrollIntoView({ block: 'nearest' });
        result.focused = true;
      }
    }
  }
  function beginPress() {
    note.textContent = '';
    note.className = '';
    lostResults.forEach(function (card) { card.remove(); });
    lostResults = [];
    Object.keys(results).forEach(function (key) {
      if (results[key].pending) return;
      delete results[key];
      var slot = resultSlots[key];
      if (slot) slot.node.textContent = '';
    });
  }
  function say(text, tone, key, copyText) {
    if (key) {
      var slot = resultSlots[key];
      var previous = results[key];
      results[key] = { text: text || w('pressFailed'), tone: tone || '', copyText: copyText, pending: tone !== 'done' && tone !== 'alert', awaitingRefresh: tone === 'done', revision: previous ? previous.revision : slot ? slot.revision : '', label: previous ? previous.label : slot ? slot.label : '' };
      paintResult(key);
      if (!slot) keepCopyFocus(drawLostResults);
      return;
    }
    note.textContent = text || '';
    note.className = tone || '';
  }
  function unreachable() {
    if (!isUnreachable) offlineButtons = Array.from(document.querySelectorAll('button:not([data-local])')).filter(function (node) { return !node.disabled; });
    isUnreachable = true;
    if (offline.textContent !== w('serveOffline')) offline.textContent = w('serveOffline');
    document.querySelectorAll('button:not([data-local])').forEach(function (node) { node.disabled = true; });
  }
  function reachable() {
    if (!isUnreachable) return;
    isUnreachable = false;
    offline.textContent = '';
    document.querySelectorAll('button[data-static]').forEach(function (node) { node.disabled = false; });
    offlineButtons.forEach(function (node) { node.disabled = false; });
    offlineButtons = [];
    // A press that met the offline server keeps its failure, no longer the offline advice.
    Object.keys(results).forEach(function (key) { if (results[key].text === w('serveOffline')) { results[key].text = w('pressFailed'); paintResult(key); } });
    // Redraw even an unchanged model to restore each action's own sending state.
    last = '';
  }
  function call(path, body) {
    if (isUnreachable && body !== undefined) return Promise.reject();
    var headers = { 'x-board-token': token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { data.ok = res.ok && data.ok !== false; return data; });
    }).catch(function (error) { unreachable(); throw error; });
  }
  function copy(text, key) {
    say(w('pressPending'), '', key);
    function fallback() {
      var area = el('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.focus({ preventScroll: true });
      area.select();
      var isCopied = false;
      try { isCopied = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(area);
      say(isCopied ? w('copied') : w('boardCopyFailedBelow'), isCopied ? 'done' : 'alert', key, isCopied ? undefined : text);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { say(w('copied'), 'done', key); }, fallback);
    else fallback();
  }
  // isView: a filter or view button changes only what is shown, so finished results stay.
  function button(label, onPress, cls, isLocal, isView) {
    var node = el('button', cls || '', label);
    node.type = 'button';
    if (isLocal) node.setAttribute('data-local', '');
    node.addEventListener('click', function () { if (!isLocal && isUnreachable) return; if (!isView) beginPress(); onPress(); });
    return node;
  }
  // fp: the fingerprint the line was drawn with, which the server checks before it writes.
  function act(key, type, text, waiting, session, asked, fp) {
    if (isUnreachable) return Promise.resolve();
    say(waiting || w('pressPending'), '', key);
    return call('/api/act', { key: key, type: type, text: text || '', session: session || '', asked: asked || '', fp: fp || '' }).then(function (data) {
      say(data.note || w(data.ok ? 'pressDone' : 'pressFailed'), data.ok ? 'done' : 'alert', key);
      return data.ok;
    }, function () {
      say(w('serveOffline'), 'alert', key);
      unreachable();
      return false;
    }).then(function (ok) { refresh(); return ok; });
  }
  function nativeAct(key, text, delivery, session, asked, fp, go) {
    if (isUnreachable) return Promise.resolve(false);
    var slot = JSON.stringify([key, delivery.id, delivery.turn, session, asked, fp]);
    var attempt = messageAttempts[slot];
    if (!attempt || attempt.text !== text) attempt = messageAttempts[slot] = { id: 'AB-' + crypto.randomUUID(), text: text };
    go.disabled = true;
    say(w('serveSending', agentName(delivery.agent)), '', key);
    return call('/api/act', { key: key, type: 'message', id: attempt.id, text: text, connection: delivery.id, turn: delivery.turn, session: session, asked: asked || '', fp: fp }).then(function (data) {
      say(data.note || w(data.ok ? 'messagesQueued' : 'messagesFailed'), data.ok ? 'done' : 'alert', key);
      if (!data.ok) go.disabled = isUnreachable;
      return data.ok;
    }, function () { say(w('messagesFailed'), 'alert', key); unreachable(); return false; }).then(function (ok) { refresh(); return ok; });
  }
  function agentName(agent) { return agent || 'claude'; }
  function receiptLine(receipt) {
    if (!receipt) return null;
    var labels = { queued: 'messagesQueued', uncertain: 'messagesUncertain', accepted: 'messagesAccepted', acknowledged: 'messagesAcknowledged', rejected: 'messagesRejected' };
    if (receipt.status === 'acknowledged' || receipt.status === 'rejected') Object.keys(messageAttempts).forEach(function (slot) { if (messageAttempts[slot].id === receipt.id) delete messageAttempts[slot]; });
    var reply = receipt.reply || '';
    var ack = 'ACK ' + receipt.id;
    if (reply.indexOf(ack) === 0 && (reply.length === ack.length || /\s/.test(reply.charAt(ack.length)))) reply = reply.slice(ack.length).trim();
    return el('p', 'quiet small', w(receipt.status === 'uncertain' && /TIMEOUT/.test(receipt.error) ? 'messagesTimeout' : labels[receipt.status]) + (reply ? ' · ' + reply : ''));
  }
  function replyBox(key, placeholder, mode, agent, where, isSending, session, asked, fp, delivery) {
    var box = el('div', 'composer');
    var input = el('textarea');
    input.rows = 2;
    input.placeholder = placeholder;
    // A draft belongs to its session and its question: a redraw that puts another session's
    // line under the same key starts an empty box, so the text is never sent to that session.
    input.setAttribute('data-key', [key, session || '', asked || '', delivery ? delivery.id + ':' + delivery.turn : ''].join('\u0001'));
    var go = mode === 'send' || mode === 'connected'
      ? button(w('serveSend', agentName(agent)), function () {
        var text = input.value.trim();
        if (!text) { say(w('pressEmpty'), 'alert', key); return; }
        if (mode === 'connected') {
          nativeAct(key, text, delivery, session, asked, fp, go).then(function (ok) { if (ok) input.value = ''; });
          return;
        }
        act(key, 'send', text, w('serveSending', agent), session, asked, fp).then(function (ok) { if (ok) input.value = ''; });
      }, 'primary')
      : button(w('serveCopy'), function () {
        var text = input.value.trim();
        if (text) copy(text, key);
        else say(w('pressEmpty'), 'alert', key);
      }, '', true);
    go.disabled = isSending === true;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click(); }
    });
    var footer = el('div', 'cf');
    if (where) add(footer, el('div', 'where', where));
    add(box, input, add(footer, go));
    return box;
  }
  function stepsList(steps) {
    var list = el('ol', 'steps');
    steps.forEach(function (step) {
      var item = el('li', step.isCurrent ? 'now' : '');
      add(item, el('span', 'mk s-' + step.status, GLYPH[step.status] || '•'), el('span', 't' + (step.status === 'done' || step.status === 'cancelled' ? ' t-quiet' : ''), step.text));
      if (step.note) add(item, el('span', 'sn s-' + step.status, step.note));
      list.appendChild(item);
    });
    return list;
  }
  function askCard(ask) {
    var card = el('article', 'card ask');
    add(card, add(el('div', 'where'), agentMark(who(ask)), el('span', '', [ask.project, ask.agent].filter(Boolean).join(' · ') + (ask.task ? ' › ' + ask.task : ''))));
    // The chip is a pill on the page, so the brackets the terminal needs are left off.
    add(card, add(el('div', 'q'), el('span', 'chip k-' + ask.kind, String(ask.chip).replace(/^\s*[\[〔]\s*|\s*[\]〕]\s*$/g, '')), el('b', '', ask.text)));
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
        else copy(answer, ask.key);
      }, index === 0 ? 'primary' : '', !send);
      node.disabled = send && ask.isSending;
      actions.appendChild(node);
    });
    if (ask.command) actions.appendChild(button(w('serveCopyCommand'), function () { copy(ask.command, ask.key); }, '', true));
    if (ask.reopen) actions.appendChild(button(w('serveCopyResume'), function () { copy(ask.reopen, ask.key); }, '', true));
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
    if (ask.archiveNote) add(card, el('div', 'quiet small archive-note', ask.archiveNote));
    if (ask.info) add(card, el('div', 'quiet small', ask.info));
    resultSlot(card, ask.key, ask.fp, ask.task);
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
    add(summary, add(el('span', 'meta t-' + row.tone), agentMark(who(row)), el('span', '', (row.total > 0 ? row.done + '/' + row.total + ' ' : '') + row.status + (row.agent ? ' · ' + row.agent : '') + (row.when ? ' · ' + row.when : ''))));
    card.appendChild(summary);
    var body = el('div', 'body');
    if (row.archiveNote) add(body, el('div', 'quiet small archive-note', row.archiveNote));
    if (row.context) add(body, el('div', 'quiet', row.context));
    if (row.pr) add(body, el('div', 'quiet', row.pr));
    if (row.steps.length) add(body, stepsList(row.steps));
    if (row.handoff) add(body, el('div', 'quiet small', row.handoff));
    var actions = el('div', 'actions');
    if (row.next) actions.appendChild(button(w('serveTickNext', row.next), function () { act(row.key, 'tick', row.next, '', '', '', row.fp); }, 'primary'));
    if (row.canArchive) actions.appendChild(button(w('serveArchive'), function () { act(row.key, 'archive', '', '', '', '', row.fp); }));
    if (row.canConfirm) actions.appendChild(button(w('confirmDone'), function () { act(row.key, 'done', '', '', '', '', row.fp); }));
    if (row.resume) actions.appendChild(button(w('serveCopyResume'), function () { copy(row.resume, row.key); }, '', true));
    if (actions.childNodes.length) add(body, actions);
    if (row.send === 'send' || row.send === 'connected') add(body, replyBox(row.key, w('serveMessagePlaceholder', agentName(row.agent)), row.send, row.agent, row.where, row.isSending, row.session, asked, row.fp, row.delivery));
    else if (row.hasCopyBox) add(body, replyBox(row.key, w('serveReplyPlaceholder'), 'copy', row.agent, '', false, row.session, asked));
    if (row.receipt) add(body, receiptLine(row.receipt));
    if (row.info) add(body, el('div', 'quiet small', row.info));
    resultSlot(body, row.key, row.fp, row.title);
    card.appendChild(body);
    return card;
  }
  function turnCard(turn) {
    var card = el('article', 'card turn');
    add(card, add(el('div', 'where'), agentMark(who(turn)), el('span', '', [turn.project, turn.agent].filter(Boolean).join(' · '))));
    add(card, el('div', turn.isQuestion ? 'q' : '', turn.text));
    if (turn.isQuestion) add(card, replyBox(turn.key, w('serveReplyPlaceholder'), 'copy', turn.agent, '', false));
    if (turn.info) add(card, el('div', 'quiet small', turn.info));
    resultSlot(card, turn.key, turn.text, turn.project);
    return card;
  }
  var pick = { view: 'all', project: '', agent: null };
  var filterNodes = [];
  var filterGroups = [];
  var navNodes = [];
  var emptyCard;
  var waitingHead;
  var nothing = null;
  var side = document.getElementById('side-groups');
  var scope = document.getElementById('scope');
  var viewKeys = [['all', 'viewAll'], ['waiting', 'sectionWaiting'], ['progress', 'sectionActive'], ['due', 'sectionDue'], ['stopped', 'viewStopped'], ['recent', 'sectionRecent']];
  // The model gives Claude Code's blocks and hand-kept tasks the agent ''; isOwn marks the
  // hand-kept ones, the person's own.
  function who(item) {
    return item.isOwn ? '' : item.agent || 'claude';
  }
  function agentMark(agent) {
    var first = String(agent || '').toLowerCase().split(/\s+/)[0];
    var aliases = ${JSON.stringify(AGENT_ALIASES)};
    var hasIcon = Object.prototype.hasOwnProperty.call(aliases, first);
    var key = hasIcon ? aliases[first] : first ? 'other' : 'own';
    var node = el('span', 'ag ag-' + key, !hasIcon && first ? Array.from(first)[0].toUpperCase() : '');
    node.setAttribute('aria-hidden', 'true');
    return node;
  }
  // isShelf: an entry on a closed shelf (reminders, older and hidden questions, idle tasks). It
  // filters like the rest but is left out of the counts, as the counts above the board leave it out.
  function tracked(node, views, item, project, isShelf) {
    // A finished item carries no agent in the model: it is left out of the agent filters.
    filterNodes.push({ node: node, views: views, project: project || item.project || '', agent: item.agent === undefined ? null : who(item), isShelf: !!isShelf });
    return node;
  }
  function groupVisibility(node, from) {
    filterGroups.push({ node: node, entries: filterNodes.slice(from) });
  }
  function drawer(isOpen) {
    var isExpanded = document.getElementById('side-open').getAttribute('aria-expanded') === 'true';
    if (document.body) document.body.className = isOpen ? 'drawer-open' : '';
    document.getElementById('side-open').setAttribute('aria-expanded', String(isOpen));
    var target = document.getElementById(isOpen ? 'side-close' : 'side-open');
    if ((isOpen || isExpanded) && target && typeof target.focus === 'function') target.focus();
  }
  document.getElementById('side-open').addEventListener('click', function () { drawer(document.getElementById('side-open').getAttribute('aria-expanded') !== 'true'); });
  document.getElementById('side-close').addEventListener('click', function () { drawer(false); });
  document.getElementById('side-scrim').addEventListener('click', function () { drawer(false); });
  if (typeof document.addEventListener === 'function') document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && document.getElementById('side-open').getAttribute('aria-expanded') === 'true') drawer(false); });
  if (typeof ResizeObserver === 'function' && document.documentElement) {
    var head = document.getElementById('head');
    new ResizeObserver(function () { document.documentElement.style.setProperty('--head-h', head.offsetHeight + 'px'); }).observe(head);
  }
  function applyPick() {
    var visible = 0;
    var counted = 0;
    filterNodes.forEach(function (one) {
      one.node.hidden = !(pick.view === 'all' || one.views.indexOf(pick.view) !== -1) || !!pick.project && one.project !== pick.project || pick.agent !== null && one.agent !== pick.agent;
      if (!one.node.hidden) visible += 1;
      if (!one.node.hidden && !one.isShelf) counted += 1;
    });
    filterGroups.forEach(function (one) { one.node.hidden = !one.entries.some(function (entry) { return !entry.node.hidden; }); });
    // With no questions the waiting heading says so, as it always has, unless a filter is on.
    if (nothing) {
      nothing.hidden = !(pick.view === 'all' || pick.view === 'waiting') || !!pick.project || pick.agent !== null;
      if (!nothing.hidden) waitingHead.hidden = false;
    }
    navNodes.forEach(function (one) { one.node.setAttribute('aria-pressed', String(pick[one.kind] === one.value)); });
    scope.textContent = '';
    var view = viewKeys.filter(function (one) { return one[0] === pick.view; })[0];
    add(scope, el('h2', '', w(view[1])), el('span', 'n', w('viewCount', counted)));
    ['project', 'agent'].forEach(function (kind) {
      if (kind === 'project' ? !pick.project : pick.agent === null) return;
      var label = pick[kind] || w('sideOwnTasks');
      var chip = button(label + ' ×', function () { pick[kind] = kind === 'agent' ? null : ''; applyPick(); }, 'fchip', true, true);
      chip.setAttribute('aria-label', w('removeFilter', label));
      add(scope, chip);
    });
    emptyCard.textContent = '';
    emptyCard.hidden = visible !== 0 || !!nothing && !nothing.hidden;
    var name = [pick.project, pick.agent === null ? '' : pick.agent || w('sideOwnTasks')].filter(Boolean).join(' · ');
    var key = { all: 'empty', waiting: 'nothingForYou', progress: 'empty', due: 'viewEmptyDue', stopped: 'viewEmptyStopped', recent: 'viewEmptyRecent' }[pick.view];
    add(emptyCard, el('p', '', name ? w('viewEmptyFiltered', name) : w(key)));
    if (name) add(emptyCard, button(w('clearFilters'), function () { pick.project = ''; pick.agent = null; applyPick(); }, '', true, true));
  }
  function drawSide() {
    // The board redraws as it changes; a sidebar button that had focus keeps it.
    var active = document.activeElement;
    var had = navNodes.filter(function (one) { return one.node === active; })[0];
    side.textContent = '';
    navNodes = [];
    function group(title, entries, kind) {
      if (!entries.length) return;
      var box = add(el('section', 'grp'), el('h3', '', w(title)));
      entries.forEach(function (one) {
        var node = button('', function () { pick[kind] = one.value; applyPick(); drawer(false); }, 'nav', true, true);
        node.setAttribute('aria-label', one.label + ' ' + one.count);
        add(node, kind === 'agent' ? agentMark(one.value) : el('span', 'pd ' + (one.tone || '')), el('span', 'nm', one.label), el('span', 'ct', one.count));
        navNodes.push({ node: node, kind: kind, value: one.value });
        add(box, node);
      });
      add(side, box);
    }
    var views = viewKeys.map(function (view) { return { value: view[0], label: w(view[1]), tone: { all: 'ink', waiting: 'waiting', due: 'soon', stopped: 'muted', recent: 'done' }[view[0]] || '', count: filterNodes.filter(function (one) { return !one.isShelf && (view[0] === 'all' || one.views.indexOf(view[0]) !== -1); }).length }; });
    group('sideViews', views, 'view');
    counts.textContent = '';
    [['●', 'n-waiting', 'waiting'], ['▸', 'n-active', 'progress'], ['⚑', 'n-due', 'due'], ['✓', 'n-today', 'recent']].forEach(function (one) {
      var view = views.filter(function (entry) { return entry.value === one[2]; })[0];
      add(counts, add(button('', function () { pick.view = view.value; applyPick(); }, '', true, true), el('span', view.count > 0 ? one[1] : 'quiet', one[0] + ' ' + view.count), el('span', '', view.label)));
    });
    ['project', 'agent'].forEach(function (kind) {
      var values = [];
      filterNodes.forEach(function (one) { if ((kind === 'project' ? !!one.project : one.agent !== null) && values.indexOf(one[kind]) === -1) values.push(one[kind]); });
      group(kind === 'project' ? 'sideProjects' : 'sideAgents', values.map(function (value) {
        var items = filterNodes.filter(function (one) { return one[kind] === value; });
        var tone = items.some(function (one) { return one.views.indexOf('waiting') !== -1; }) ? 'waiting' : items.some(function (one) { return one.views.indexOf('due') !== -1; }) ? 'soon' : items.every(function (one) { return one.views.indexOf('stopped') !== -1 || one.views.indexOf('recent') !== -1; }) ? 'muted' : '';
        return { value: value, label: value || w('sideOwnTasks'), count: items.filter(function (one) { return !one.isShelf; }).length, tone: tone };
      }), kind);
    });
    if (had) navNodes.forEach(function (one) { if (one.kind === had.kind && one.value === had.value && typeof one.node.focus === 'function') one.node.focus(); });
  }
  function keepCopyFocus(redraw) {
    var active = document.activeElement;
    var copyFocus = null;
    var copyCaret = null;
    Object.keys(results).forEach(function (key) {
      if (results[key].area === active) {
        copyFocus = key;
        copyCaret = [active.selectionStart, active.selectionEnd];
      }
    });
    redraw();
    if (copyFocus !== null && results[copyFocus] && results[copyFocus].area) {
      var copyArea = results[copyFocus].area;
      copyArea.setSelectionRange(copyCaret[0], copyCaret[1]);
      copyArea.focus({ preventScroll: true });
    }
  }
  function render(model) {
    keepCopyFocus(function () { renderBoard(model); });
  }
  function renderBoard(model) {
    // What is typed, and where the cursor is, outlast a redraw.
    var kept = {};
    board.querySelectorAll('textarea[data-key]').forEach(function (box) { kept[box.getAttribute('data-key')] = box.value; });
    var active = document.activeElement;
    var focus = active && active.getAttribute ? active.getAttribute('data-key') : null;
    var caret = focus ? [active.selectionStart, active.selectionEnd] : null;
    board.textContent = '';
    filterNodes = [];
    filterGroups = [];
    // Footer and paste controls keep their slots across board redraws.
    var pasteSlot = resultSlots.paste;
    var closeSlot = resultSlots.close;
    resultSlots = pasteSlot ? { paste: pasteSlot } : {};
    if (closeSlot) resultSlots.close = closeSlot;
    if (model.warning) add(board, el('p', 't-alert', model.warning));
    waitingHead = el('h2', 'n-waiting', '● ' + w('sectionWaiting'));
    nothing = model.asks.length === 0 ? el('div', 'n-today', w('nothingForYou')) : null;
    add(board, waitingHead, nothing);
    model.asks.forEach(function (ask) { add(board, tracked(askCard(ask), ['waiting'], ask)); });
    [['reminder', 'sectionQuestionReminders'], ['older', 'sectionOlderQuestions']].forEach(function (pair) {
      var questions = model[pair[0]] || [];
      if (!questions.length) return;
      var from = filterNodes.length;
      var retained = el('details', 'card shelf');
      retained.open = opened[pair[0] + ':'] === true;
      retained.addEventListener('toggle', function () { opened[pair[0] + ':'] = retained.open; });
      add(retained, add(el('summary'), el('span', 'quiet', w(pair[1]) + ' (' + questions.length + ')')), el('p', 'quiet', w('questionAgingHint')), el('p', 'quiet', w('questionReviewOnly')));
      questions.forEach(function (one) {
        add(retained, tracked(add(el('div'), add(el('div', 'where'), agentMark(who(one)), el('span', '', [one.project, one.agent, one.task, one.when].filter(Boolean).join(' · '))), el('div', 'q', one.text), el('div', '', one.note), el('div', 'quiet', one.context)), ['waiting'], one, '', true));
      });
      groupVisibility(retained, from);
      add(board, retained);
    });
    if (model.hidden.length) {
      var from = filterNodes.length;
      var shelf = el('details', 'card shelf');
      shelf.open = opened['hidden:'] === true;
      shelf.addEventListener('toggle', function () { opened['hidden:'] = shelf.open; });
      add(shelf, add(el('summary'), el('span', 'quiet', w('hiddenCount', model.hidden.length))));
      model.hidden.forEach(function (one) {
        var hiddenCard = add(el('div'), add(el('div', 'where'), agentMark(who(one)), el('span', '', [one.project, one.agent].filter(Boolean).join(' · ') + (one.task ? ' › ' + one.task : ''))), el('div', 'q', one.text), add(el('div', 'actions'), button(w('showAgain'), function () { act(one.key, 'unhide'); })));
        resultSlot(hiddenCard, one.key, one.text, one.task);
        add(shelf, tracked(hiddenCard, ['waiting'], one, '', true));
      });
      groupVisibility(shelf, from);
      add(board, shelf);
    }
    // The heading stands over the questions and their shelves.
    groupVisibility(waitingHead, 0);
    if (model.idle.length) {
      var from = filterNodes.length;
      var idleShelf = el('details', 'card shelf');
      idleShelf.open = opened['idle:'] === true;
      idleShelf.addEventListener('toggle', function () { opened['idle:'] = idleShelf.open; });
      add(idleShelf, add(el('summary'), el('span', 'quiet', w('idleCount', model.idle.length))));
      model.idle.forEach(function (row) { add(idleShelf, tracked(add(el('div'), el('div', 'where', row.project), rowCard(row)), ['progress'], row, '', true)); });
      groupVisibility(idleShelf, from);
      add(board, idleShelf);
    }
    if (model.stopped.length) {
      var from = filterNodes.length;
      var stoppedShelf = el('details', 'card shelf');
      stoppedShelf.open = opened['stopped:'] === true;
      stoppedShelf.addEventListener('toggle', function () { opened['stopped:'] = stoppedShelf.open; });
      add(stoppedShelf, add(el('summary'), el('span', 'quiet', w('stoppedCount', model.stopped.length))));
      model.stopped.forEach(function (row) { add(stoppedShelf, tracked(add(el('div'), el('div', 'where', row.project), rowCard(row)), ['stopped'], row)); });
      groupVisibility(stoppedShelf, from);
      add(board, stoppedShelf);
    }
    model.groups.forEach(function (group) {
      var from = filterNodes.length;
      var heading = el('h2', 'where', '▸ ' + group.project);
      add(board, heading);
      group.rows.forEach(function (row) { add(board, tracked(rowCard(row), row.due ? ['progress', 'due'] : ['progress'], row, group.project)); });
      groupVisibility(heading, from);
    });
    if (model.turns.length) {
      var from = filterNodes.length;
      var heading = el('h2', 'n-active', '◐ ' + w('boardInbox'));
      add(board, heading);
      model.turns.forEach(function (turn) { add(board, tracked(turnCard(turn), turn.isQuestion ? ['progress', 'waiting'] : ['progress'], turn)); });
      groupVisibility(heading, from);
    }
    if (model.recent.length) {
      var from = filterNodes.length;
      var heading = el('h2', 'n-today', '✓ ' + w('sectionRecent'));
      add(board, heading);
      var done = el('div', 'history');
      model.recent.forEach(function (item) {
        var line = add(el('div'), el('span', 's-done', '✓'), el('span', 't-quiet', [item.project, item.title, item.when].filter(Boolean).join(' · ')));
        (item.questions || []).forEach(function (question) { add(line, el('p', 't-quiet', question)); });
        add(done, tracked(line, ['recent'], item));
      });
      var recent = add(el('div', 'card'), done, add(el('div', 'actions'), button(w('archiveNow'), function () {
        say(w('pressPending'), '', 'recent');
        call('/api/tidy', {}).then(function (data) { say(data.note || w(data.ok ? 'pressDone' : 'pressFailed'), data.ok ? 'done' : 'alert', 'recent'); refresh(); }, function () { say(w('serveOffline'), 'alert', 'recent'); unreachable(); });
      })));
      resultSlot(recent, 'recent', '', w('sectionRecent'));
      groupVisibility(heading, from);
      groupVisibility(recent, from);
      add(board, recent);
    }
    emptyCard = el('div', 'card empty');
    add(board, emptyCard);
    drawSide();
    applyPick();
    drawLostResults();
    board.querySelectorAll('textarea[data-key]').forEach(function (box) {
      var key = box.getAttribute('data-key');
      if (key in kept) box.value = kept[key];
      if (key === focus && !filterNodes.some(function (one) { return one.node.hidden && Array.from(one.node.querySelectorAll('textarea[data-key]')).indexOf(box) !== -1; })) {
        box.focus();
        if (caret) box.setSelectionRange(caret[0], caret[1]);
      }
    });
  }
  function drawLostResults() {
    lostResults.forEach(function (card) { card.remove(); });
    lostResults = [];
    Object.keys(results).reverse().forEach(function (key) {
      if (resultSlots[key]) return;
      var result = results[key];
      if (!result.pending && result.tone !== 'alert' && result.tone !== 'done') { delete results[key]; return; }
      var card = add(el('article', 'card'), el('div', 'where', result.label));
      var slot = el('div', 'small press-result');
      slot.setAttribute('role', 'status');
      slot.textContent = result.text;
      slot.className += ' ' + result.tone;
      add(card, slot);
      if (result.copyText) {
        var area = el('textarea');
        area.value = result.copyText;
        area.setAttribute('readonly', '');
        add(slot, area);
        result.area = area;
      }
      board.insertBefore(card, board.firstChild);
      lostResults.push(card);
    });
  }
  function refresh() {
    if (isClosed) return;
    clearTimeout(timer);
    call('/api/board').then(function (data) {
      if (!data.ok || !data.model) {
        if (data.note) { reachable(); say(data.note, 'alert'); }
        else unreachable();
        return;
      }
      reachable();
      var text = JSON.stringify([data.model, data.messaging && data.messaging.sessions]);
      if (text !== last) {
        last = text; render(data.model);
        if (presence) { presence.remove(); presence = null; }
        // Show actionable progress delays, never transport inventory or native identifiers.
        var sessions = (data.messaging && data.messaging.sessions || []).filter(function (one) { return one.status === 'waiting' || one.status === 'timed_out'; });
        if (sessions.length) {
          presence = el('section', 'card');
          add(presence, el('h2', '', w('sessionsTitle')));
          sessions.forEach(function (one) {
            var state = one.status === 'timed_out' ? w('sessionsTimedOut') : w('sessionsWaiting');
            add(presence, add(el('div'), el('div', 'where', agentName(one.agent)), el('div', one.status === 'timed_out' ? 's-blocked small' : 'small', state)));
          });
          board.insertAdjacentElement('afterend', presence);
        }
      }
      // A reply runs in the background; its answer comes with the board once the agent is done.
      if (since === null) since = data.now;
      var seenAt = since;
      (data.replies || []).forEach(function (reply) {
        if (reply.at > seenAt) { since = Math.max(since, reply.at); say(reply.note, reply.ok ? 'done' : 'alert', reply.key); }
      });
    }, function () {
      unreachable();
    }).then(function () {
      if (!isClosed) timer = setTimeout(refresh, 3000);
    });
  }
  document.getElementById('close').addEventListener('click', function () {
    if (isUnreachable) return;
    beginPress();
    say(w('pressPending'), '', 'close');
    var shut = function () {
      isClosed = true;
      clearTimeout(timer);
      var main = document.querySelector('main');
      main.textContent = '';
      add(main, el('p', '', w('serveClosed')));
    };
    call('/api/close', {}).then(function (data) {
      if (data.ok) shut();
      else {
        say(data.note || w('serveOffline'), 'alert', 'close');
        if (!data.note) unreachable();
        refresh();
      }
    }, function () { say(w('serveOffline'), 'alert', 'close'); unreachable(); });
  });
  document.getElementById('paste-go').addEventListener('click', function () {
    if (isUnreachable) return;
    beginPress();
    var box = document.getElementById('paste');
    if (!box.value.trim()) { say(w('pressEmpty'), 'alert', 'paste'); return; }
    var pasted = box.value;
    say(w('pressPending'), '', 'paste');
    call('/api/paste', { text: pasted }).then(function (data) {
      if (data.review && window.confirm(w('pasteReview', data.review.current, data.review.incoming))) {
        return call('/api/paste', { text: pasted, reviewToken: data.review.token });
      }
      return data;
    }).then(function (data) {
      say(data.note || w(data.ok ? 'pressDone' : 'pressFailed'), data.ok ? 'done' : 'alert', 'paste');
      if (data.ok && box.value === pasted) box.value = '';
      refresh();
    }, function () { say(w('serveOffline'), 'alert', 'paste'); unreachable(); });
  });
  document.getElementById('relay').addEventListener('click', function () { beginPress(); copy(W.relayPrompt, 'paste'); });
  resultSlot(document.querySelector('.paste'), 'paste', '', w('servePasteTitle'));
  refresh();
})();
`

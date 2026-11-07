import type { AskKind } from './ask'
import { answersOf, boardItems, fingerprint, olderKey, remainingInbox } from './board'
import type { BoardItem, PendingTurn } from './board'
import { clipLine, LABEL_ROOM, LINE_ROOM } from './clip'
import { groupBoard } from './grouping'
import type { Bucket, Card, GroupedQuestion, GroupedTask, Quiet, RepoOf } from './grouping'
import { AGENT_ALIASES, agentFade, agentMarkCss, agentRowCss, boardMark, faviconLink, filterStore, htmlLang, motionCss, pageBaseCss, pageTokens, sheetCss, themeHead, themeToggle } from './page-look'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { agentLabel } from './strings'
import type { Tone } from './palette'
import { cellCode } from './progress-bar'
import { RESUME } from './parse'
import { OLDER_SHOWN, relativeTime, replyHint, rowNeedsYou, wayBackText } from './view'
import type { AgentTarget, StepRef, TaskRef, View, WaitingItem } from './view'
import type { Connection, Message } from './messaging'
import { deliveryTargets } from './hook-messages'
import { address, isMailboxTarget, isOpen } from './messaging'

// The board's page: what `agent-board` shows in a browser for agents other than
// Claude Code, and what a press on it does. It does what the pane does: tick a hand-kept step,
// archive, copy an answer, answer another agent, and tidy the board.
// Pure: scripts/board-serve.ts runs the server, writes the files and starts the agents.

// How a reply reaches the session a line belongs to. send: into the session, from the page (a
// Grok Build or Codex session that has closed, so the page is its only writer); open: in its
// own window, since it is still open and two writers on one session would mix up; claude: in
// that Claude Code session; none: copied, then pasted into the agent's chat.
export type SendMode = 'send' | 'connected' | 'mailbox' | 'open' | 'claude' | 'none'
type Delivery = { id: string; turn: string; agent: string }
type Receipt = Pick<Message, 'id' | 'status' | 'reply' | 'error' | 'text'> & { when: string; isMailbox: boolean }
type Messaging = { connections: readonly Connection[]; mailboxes?: readonly Connection[]; messages: readonly Omit<Message, 'nonce' | 'hash'>[] }

const liveTarget = (agent: string, session: string | undefined, connections: readonly Connection[]): Connection | undefined => {
  const matches = session === undefined ? [] : connections.filter(one => address(one.agent, one.session) === address(agent || 'claude', session))
  return matches.length === 1 && !matches[0]?.contested ? matches[0] : undefined
}
// A mailbox waits for a next turn, and a session that has ended has none.
const reachable = (agent: string, session: string | undefined, target: AgentTarget | null, targets: readonly Connection[]): Connection | undefined => {
  const found = liveTarget(agent, session, targets)
  return found?.scope === 'mailbox' && target?.isClosed === true ? undefined : found
}
const rowReceipt = (agent: string, session: string | undefined, messages: readonly Omit<Message, 'nonce' | 'hash'>[], now: number, s: Strings): { receipt?: Receipt } => {
  const one = session === undefined ? undefined : messages.filter(message => message.to === address(agent || 'claude', session)).at(-1)
  return one === undefined ? {} : { receipt: { id: one.id, status: one.status, reply: one.reply, error: one.error, text: one.text, isMailbox: isMailboxTarget(one.target), when: relativeTime(one.updated, now, s) } }
}
const isClaudeAgent = (agent: string): boolean => agent === '' || agent.toLowerCase() === 'claude'
// What pressing Send does right now, for a Claude session that is receiving (#316).
const claudeHint = (agent: string, isWorking: boolean, s: Strings): string => !isClaudeAgent(agent) ? '' : isWorking ? s.claudeSendWorking : s.claudeSendNow

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

// `line`, here and on the other texts below, is the text folded to one line (hooks/clip.ts) and
// capped; it is absent when that is the text itself. The browser cuts the line to its width with an
// ellipsis.
export type ServeStep = {
  text: string
  note: string
  status: string
  isCurrent: boolean
  line?: string
  // The file line the step came from, so a press can tick exactly the line it showed; absent
  // on a folded summary line, which is no step. `line` above is the clipped text it shows.
  fileLine?: number
}

export type ServeAsk = {
  at?: number
  dir?: string | null
  when?: string
  questionId?: string
  delivery?: Delivery
  receipt?: Receipt
  key: string
  project: string
  agent: string
  task: string
  text: string
  // The words of a Done button that ticks this question, clipped.
  label?: string
  note: string
  noteLine?: string
  context: string
  contextLine?: string
  kind: AskKind
  chip: string
  answers: string[]
  command: string | null
  link: string | null
  // Answered in the agent's own window: its options as plain text and the line that says where; the page draws no reply for it.
  native?: { options: string[]; line: string }
  // A hand-kept question, the person's own (its agent is '', as Claude Code's is); absent otherwise.
  isOwn?: true
  canTick: boolean
  // Another session's question can be marked answered: kept off the board until it changes.
  canHide: boolean
  unhideKey?: string
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
  // That session has ended, as its progress record says: the page shows its agent as offline when no other
  // session of it is open.
  isClosed?: true
}

export type ServeRow = {
  at?: number
  dir?: string | null
  sessionId?: string
  stuck?: { reason: string }
  delivery?: Delivery
  receipt?: Receipt
  key: string
  project: string
  title: string
  context: string
  contextLine?: string
  status: string
  tone: Tone
  when: string
  agent: string
  done: number
  total: number
  // One character per step for the progress bar (#1085, `hooks/progress-bar.ts` cellCode); '' with no steps.
  cells: string
  due: string | null
  dueTone: Tone | null
  pr: string
  steps: ServeStep[]
  next: string | null
  // The words of the Done button for `next`, clipped; `next` itself is what a press must send back.
  nextLabel?: string
  // The file line `next` came from, so a press can tick exactly the line it showed.
  nextFileLine?: number
  // A hand-kept task, the person's own (its agent is '', as Claude Code's is); absent otherwise.
  isOwn?: true
  canArchive: boolean
  canConfirm: boolean
  archiveNote: string
  resume: string | null
  handoff: string
  // The runs this session started for itself, as one line; '' when none (#399).
  runs: string
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
  isClosed?: true
}

// A question marked answered, listed so it can be shown again.
export type ServeHidden = { key: string; project: string; agent: string; isOwn?: true; task: string; text: string; questionId?: string }
// key names the line in the action route; canHide is false for a retained source that is only for review.
export type ServeRetained = { key: string; canHide: boolean; unhideKey?: string; project: string; agent: string; isOwn?: true; task: string; text: string; note: string; context: string; contextLine?: string; when: string; questionId?: string; at?: number; dir?: string | null }

export type ServeTurn = { key: string; project: string; agent: string; text: string; isQuestion: boolean; info: string; at?: number }

export type GroupOptions = { now: number; repoOf: RepoOf; versions: { board: string; package: string | null }; unreadable: readonly string[] }
type ServeDone = { project: string; title: string; line?: string; when: string; questions?: string[]; key?: string; agent?: string; isOwn?: true; dir?: string | null; at?: number; canArchive?: boolean; fp?: string }
type PageRef = { key: string; kind: 'question' | 'stuck' | 'task'; agent: string; project: string; repo: string; at: number; sourceKey?: string }
type PageBucket = { counts: Bucket['counts']; cards: PageRef[]; open: PageRef[]; stopped: PageRef[]; done: PageRef[]; older: PageRef[] }
type PageView = {
  now: number
  n: number
  questions: number
  stuck: number
  versions: GroupOptions['versions']
  agents: Array<PageBucket & { agent: string; name: string; icon: string; last: number; isUnreadable: boolean }>
  needs: { n: number; questions: number; stuck: number; cards: PageRef[]; older: PageRef[] }
  working: PageRef[]
  quiet: Quiet
  all: PageBucket & { isHidden: boolean }
  own: PageBucket
  projects: Array<{ name: string; open: number }>
}

// Worktree metadata uses the writer's path syntax, even when the reader runs on another OS.
// The server checks that this repository still exists before using the returned name.
export const worktreeRepoName = (dir: string, gitFile: string, commonDir: string): string | null => {
  const git = /^gitdir:\s*(.+?)\s*$/.exec(gitFile.split(/\r?\n/)[0] ?? '')?.[1]
  const common = commonDir.split(/\r?\n/)[0]?.trim()
  if (!git || !common) return null
  const resolvePath = (base: string, path: string): string => {
    const normalized = path.replace(/\\/g, '/')
    const absolute = /^(?:[a-z]:\/|\/)/i.test(normalized) ? normalized : `${base.replace(/\\/g, '/')}/${normalized}`
    const parts: string[] = []
    for (const part of absolute.split('/')) {
      if (part === '..') parts.pop()
      else if (part !== '.' && part !== '') parts.push(part)
    }
    return parts.join('/')
  }
  const parts = resolvePath(resolvePath(dir, git), common).split('/')
  parts.pop()
  const name = parts.pop()
  return name && !/^[a-z]:$/i.test(name) ? name : null
}

export type ServeModel = {
  warning?: string
  details?: string
  pruned?: string
  health?: string[]
  isLarge?: true
  isCleanable?: true
  // Runs agents started for themselves that no session is known for, as one folded line (#399).
  background?: string
  counts: { waiting: number; active: number; due: number; today: number }
  asks: ServeAsk[]
  hidden: ServeHidden[]
  reminder: ServeRetained[]
  older: ServeRetained[]
  stoppedAsking?: number
  idle: ServeRow[]
  stopped: ServeRow[]
  groups: Array<{ project: string; rows: ServeRow[] }>
  turns: ServeTurn[]
  // Finished in the last day, until it goes to the archive.
  recent: ServeDone[]
  finished?: ServeDone[]
  agents?: Array<{ agent: string; unreadable?: true }>
  view?: PageView
}

// `task` and `session` name the Claude Code session to answer in, the way the pane does.
const infoOf = (mode: SendMode, agent: string, task: string, session: string, s: Strings): string => {
  const name = isClaudeAgent(agent) ? 'Claude' : agentLabel(agent, s)
  if (mode === 'open') return s.serveSendOpen(name)
  if (mode === 'claude') return s.serveSendOpen(name)
  if (mode === 'none') return s.serveSendNone(name)

  return ''
}

// The text folded to one line and capped at `room` characters, or undefined when that is the text itself.
const clipped = (text: string | undefined, room: number): string | undefined => {
  if (!text) return undefined
  const { line } = clipLine(text, room)
  return line === text ? undefined : line
}
const lined = (text?: string): { line?: string } => {
  if (!text) return {}
  const line = clipped(text, LINE_ROOM)

  return line === undefined ? {} : { line }
}
const contextLined = (text?: string): { contextLine?: string } => {
  if (!text) return {}
  const line = clipped(text, LINE_ROOM)

  return line === undefined ? {} : { contextLine: line }
}
const noteLined = (text?: string): { noteLine?: string } => {
  if (!text) return {}
  const line = clipped(text, LINE_ROOM)

  return line === undefined ? {} : { noteLine: line }
}

// The keys are the terminal board's (`boardItems`), so a press names the line it was on.
// `isLan`: the page as a phone sees it on the local network, where a reply that would run an
// agent on the computer is offered as a copy instead.
// A question on the reminder or Older shelf. The page may hide it under the key the action route names,
// unless it is a retained source kept for review only.
const retainedOf = (item: WaitingItem): ServeRetained => ({
  key: olderKey(item),
  canHide: item.hideKey !== '' && item.canHide !== false,
  ...(item.hideKey !== '' && item.canHide !== false ? { unhideKey: `hidden:${item.hideKey}` } : {}),
  project: item.project ?? '',
  agent: item.agent ?? '',
  ...(item.where === 'manual' ? { isOwn: true as const } : {}),
  task: item.task ?? '',
  text: item.text ?? '',
  note: item.note,
  context: item.context,
  ...contextLined(item.context),
  when: item.when ?? '',
  ...(item.questionId === undefined ? {} : { questionId: item.questionId }),
})

export const serveModel = (view: View, pending: readonly PendingTurn[], s: Strings = ZH_TW, sending: ReadonlySet<string> = new Set(), isLan = false, messaging?: Messaging, allowResume = false, group?: GroupOptions): ServeModel => {
  const isSending = (target: AgentTarget | null): boolean => target !== null && sending.has(sendKey(target))
  const targets = deliveryTargets(messaging?.connections ?? [], messaging?.mailboxes)
  const onLan = (mode: SendMode): SendMode => (isLan && mode === 'send' ? 'open' : mode)
  const lanInfo = (mode: SendMode, agent: string): string | null => (isLan && mode === 'send' ? s.serveLanSend(agentLabel(agent || 'claude', s)) : null)
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
      const connection = isManual || isLan ? undefined : reachable(ask.agent, ask.nativeSession, ask.target, targets)
      const isContested = !isManual && !isLan && connection === undefined && (messaging?.connections.some(one => one.agent === (ask.agent || 'claude') && one.session === ask.nativeSession) ?? false)
      const baseMode = isManual ? 'none' : sendMode(ask.agent, ask.target)
      const mode = connection ? (connection.scope === 'mailbox' ? 'mailbox' : 'connected') : isContested || !allowResume && baseMode === 'send' ? 'open' : baseMode
      const send = onLan(mode)
      // A phone on the local network gets the id, but neither the command nor its folder.
      const hint = replyHint(ask, s, !isLan, true)
      const label = ask.step === null ? undefined : clipped(ask.text, LABEL_ROOM)
      asks.push({
        ...(group === undefined ? {} : { ...(ask.at === undefined ? {} : { at: ask.at }), dir: ask.dir ?? null, when: ask.when }),
        ...(connection === undefined ? {} : { delivery: { id: connection.id, turn: connection.turn, agent: connection.agent } }),
        ...(isLan ? {} : rowReceipt(ask.agent, ask.nativeSession, messaging?.messages ?? [], group?.now ?? 0, s)),
        key: item.key,
        ...(ask.questionId === undefined ? {} : { questionId: ask.questionId }),
        project: ask.project,
        agent: ask.agent,
        ...(isManual ? { isOwn: true as const } : {}),
        task: ask.task,
        text: ask.text,
        ...(label === undefined ? {} : { label }),
        note: ask.note,
        ...noteLined(ask.note),
        context: ask.context,
        ...contextLined(ask.context),
        kind: ask.kind,
        chip: s.chip(s.ask[ask.kind]),
        // A hand-kept question is the person's own: ticking it is the answer.
        answers: isManual ? [] : answersOf(ask, s),
        command: ask.command,
        link: ask.link,
        ...(ask.native === undefined ? {} : { native: { options: ask.native.options, line: s.nativeAnswerIn(agentLabel(ask.native.agent, s)) } }),
        canTick: ask.step !== null,
        canHide: ask.hideKey !== '' && ask.canHide !== false,
        ...(ask.hideKey !== '' && ask.canHide !== false ? { unhideKey: `hidden:${ask.hideKey}` } : {}),
        send,
        session: connection?.session ?? ask.target?.session ?? '',
        fp: fingerprint(item, items),
        where: send === 'send' ? (ask.target?.dir ?? '') : send === 'connected' ? claudeHint(ask.agent, false, s) : '',
        archiveNote: isManual ? '' : s.archiveLive,
        info: connection || isManual ? '' : (lanInfo(baseMode, ask.agent) ?? infoOf(send, ask.agent, ask.task, '', s)),
        back: wayBackText(hint),
        sessionId: ask.where === 'other' ? ask.sessionId : null,
        reopen: hint.reopen,
        isSending: isSending(ask.target) || connection !== undefined && (messaging?.messages.some(one => one.to === address(connection.agent, connection.session) && isOpen(one) && !(one.status === 'accepted' && isMailboxTarget(one.target))) ?? false),
        ...(ask.target?.isClosed === true ? { isClosed: true as const } : {}),
      })
      continue
    }
    if (item.type === 'row') {
      const { row } = item
      if (view.recentAsking?.some(one => one.key === row.key)) continue
      const needs = rowNeedsYou(row, idleKeys.has(row.key) || stoppedKeys.has(row.key))
      const connection = isLan ? undefined : reachable(row.agent, row.nativeSession, row.target, targets)
      const isContested = !isLan && connection === undefined && (messaging?.connections.some(one => one.agent === (row.agent || 'claude') && one.session === row.nativeSession) ?? false)
      const baseMode = row.target === null ? (row.auto === null ? 'none' : 'claude') : sendMode(row.agent, row.target)
      const mode = connection ? (connection.scope === 'mailbox' ? 'mailbox' : 'connected') : isContested || !allowResume && baseMode === 'send' ? 'open' : baseMode
      const send = onLan(mode)
      // A Claude session still at work that this board cannot reach: its card says so and copies.
      const isOpenClaude = !isLan && send === 'claude' && row.auto !== 'ended'
      const nextLabel = row.next === null ? undefined : clipped(row.next.step, LABEL_ROOM)
      const rows = idleKeys.has(row.key) ? idle : stoppedKeys.has(row.key) ? stopped : (groups.get(row.project) ?? [])
      if (!idleKeys.has(row.key) && !stoppedKeys.has(row.key)) groups.set(row.project, rows)
      rows.push({
        ...(group === undefined ? {} : {
          ...(row.at === undefined ? {} : { at: row.at }),
          dir: row.dir ?? null,
          ...(row.nativeSession === undefined ? {} : { sessionId: row.nativeSession }),
          // Run ownership is not reported by the current producer (#399).
          ...(needs?.kind === 'stuck'
            ? { stuck: { reason: needs.reason } }
            : {}),
        }),
        ...(connection === undefined ? {} : { delivery: { id: connection.id, turn: connection.turn, agent: connection.agent } }),
        ...(isLan ? {} : rowReceipt(row.agent, row.nativeSession, messaging?.messages ?? [], group?.now ?? 0, s)),
        key: item.key,
        project: row.project,
        title: row.title,
        context: row.context,
        ...contextLined(row.context),
        status: row.status,
        tone: row.tone,
        when: row.when,
        agent: row.agent,
        ...(row.auto === null ? { isOwn: true as const } : {}),
        done: row.done,
        total: row.total,
        cells: cellCode(row.cells ?? []),
        due: row.due?.left ?? null,
        dueTone: row.due?.tone ?? null,
        pr: row.pr,
        steps: row.steps.map(step => ({ text: step.text, note: step.note, status: step.status, isCurrent: step.isCurrent, ...lined(step.note ? `${step.text} — ${step.note}` : step.text), ...(step.line === null ? {} : { fileLine: step.line }) })),
        next: row.next?.step ?? null,
        ...(nextLabel === undefined ? {} : { nextLabel }),
        ...(row.next === null ? {} : { nextFileLine: row.next.line }),
        canArchive: row.archive !== null,
        canConfirm: row.confirm != null,
        archiveNote: row.archive === null && (row.auto === 'working' || row.auto === 'waiting') ? s.archiveLive : '',
        // The command to resume a session names its folder, and the account with it: the computer's only.
        resume: isLan ? null : row.resume,
        handoff: row.handoff,
        runs: row.runs ?? '',
        isAsking: row.question !== null,
        question: row.question ?? '',
        send,
        session: connection?.session ?? row.target?.session ?? '',
        fp: fingerprint(item, items),
        where: send === 'send' ? (row.target?.dir ?? '') : send === 'connected' ? claudeHint(row.agent, row.auto === 'working', s) : '',
        // A row says why only when a reply could otherwise be expected here.
        info: connection ? '' : lanInfo(baseMode, row.agent) ?? (send === 'open' || isOpenClaude ? infoOf(send, row.agent, row.title, '', s) : ''),
        isSending: isSending(row.target) || connection !== undefined && (messaging?.messages.some(one => one.to === address(connection.agent, connection.session) && isOpen(one) && !(one.status === 'accepted' && isMailboxTarget(one.target))) ?? false),
        // A stopped task with no question and no way to reach it has nothing to answer and nobody to take a reply (#260).
        hasCopyBox: !(row.auto === 'ended' && row.question === null && send === 'none') && (isContested || lanInfo(baseMode, row.agent) !== null || isOpenClaude || !allowResume && row.auto !== null && connection === undefined),
        // A Claude row has no target, so its closed session is the block's own state=ended.
        ...(row.target?.isClosed === true || row.target === null && row.isRecordedEnded === true ? { isClosed: true as const } : {}),
      })
      continue
    }
    const { turn } = item
    turns.push({
      ...(group === undefined ? {} : { at: turn.at }),
      key: item.key,
      project: turn.project,
      agent: turn.agent,
      text: turn.isQuestion ? turn.text : '',
      isQuestion: turn.isQuestion,
      // Connection closure does not answer an unresolved inbox question.
      info: turn.isQuestion ? infoOf(SENDERS.has(turn.agent) ? 'open' : 'none', turn.agent, '', '', s) : '',
    })
  }

  const askingByKey = new Map((view.recentAsking ?? []).map(one => [one.key, one]))
  const askingFp = (itemKey: string): { canArchive?: boolean; fp?: string } => {
    const asking = askingByKey.get(itemKey)
    if (asking === undefined) return {}
    const askingItem = items.find(one => one.type === 'row' && one.row.key === asking.key)
    return {
      canArchive: asking.archive !== null,
      ...(askingItem === undefined ? {} : { fp: fingerprint(askingItem, items) }),
    }
  }

  const model: ServeModel = {
    counts: { ...view.overview, waiting: view.overview.waiting + remainingInbox(view, pending).filter(turn => turn.isQuestion).length },
    warning: view.warning,
    ...(view.details === undefined ? {} : { details: view.details }),
    ...(view.pruned === undefined ? {} : { pruned: view.pruned }),
    ...(view.health === undefined ? {} : { health: [...view.health] }),
    ...(view.isLarge ? { isLarge: true } : {}),
    ...(view.isCleanable ? { isCleanable: true } : {}),
    ...(view.background === undefined ? {} : { background: view.background }),
    asks,
    ...((view.stoppedAsking ?? 0) > 0 ? { stoppedAsking: view.stoppedAsking } : {}),
    idle,
    stopped,
    hidden: view.hidden.map(item => ({ key: `hidden:${item.hideKey}`, project: item.project, agent: item.agent, ...(item.where === 'manual' ? { isOwn: true as const } : {}), task: item.task, text: item.text, ...(item.questionId === undefined ? {} : { questionId: item.questionId }) })),
    reminder: (view.reminder ?? []).map(retainedOf),
    older: (view.older ?? []).map(retainedOf),
    groups: [...groups].map(([project, rows]) => ({ project, rows })),
    turns,
    recent: view.recent.map(item => ({ project: item.project, title: item.title, ...lined(item.title), when: item.when, questions: item.questions?.map(question => [question.text, question.note].filter(Boolean).join(' — ')), ...askingFp(item.key) })),
  }
  if (group === undefined) return model
  const extra = (item: WaitingItem): ServeRetained => ({ ...retainedOf(item), ...(item.at === undefined ? {} : { at: item.at }), dir: item.dir ?? null })
  model.reminder = (view.reminder ?? []).map(extra)
  model.older = (view.older ?? []).map(extra)
  model.finished = (view.finished ?? []).map(item => ({ ...item, key: `row:${item.key}`, questions: item.questions?.map(question => [question.text, question.note].filter(Boolean).join(' — ')), ...askingFp(item.key) }))
  const finishedByKey = new Map((model.finished ?? []).map(one => [one.key, one]))
  model.recent = view.recent.map((item, index) => {
    const finished = finishedByKey.get(`row:${item.key}`)
    return { ...model.recent[index]!, key: `row:${item.key}`, ...(finished === undefined ? {} : { agent: finished.agent, ...(finished.isOwn ? { isOwn: true as const } : {}), dir: finished.dir, at: finished.at }), ...askingFp(item.key) }
  })
  model.agents = [...new Set(group.unreadable)].map(agent => ({ agent, unreadable: true }))
  const grouped = groupBoard(model, group.now, group.repoOf, s)
  const ref = (one: Card | GroupedTask | GroupedQuestion): PageRef => ({
    key: one.key,
    kind: 'type' in one ? one.type : 'stage' in one ? 'question' : 'task',
    agent: one.agent,
    project: one.project,
    repo: one.repo,
    at: one.at,
    ...('shelf' in one && one.source.key !== one.key ? { sourceKey: one.source.key } : {}),
  })
  const bucket = (one: Bucket): PageBucket => ({ counts: one.counts, cards: one.cards.map(ref), open: one.open.map(ref), stopped: one.stopped.map(ref), done: one.done.map(ref), older: one.older.map(ref) })
  model.view = {
    now: group.now,
    n: grouped.needs.n,
    questions: grouped.needs.questions,
    stuck: grouped.needs.stuck,
    versions: group.versions,
    agents: grouped.agents.map(one => ({ ...bucket(one), agent: one.agent, name: one.name, icon: one.icon, last: one.last, isUnreadable: one.isUnreadable })),
    needs: { ...grouped.needs, cards: grouped.needs.cards.map(ref), older: grouped.needs.older.map(ref) },
    working: grouped.working.map(ref),
    quiet: grouped.quiet,
    all: { ...bucket(grouped.all), isHidden: grouped.all.isHidden },
    own: bucket(grouped.own),
    projects: grouped.projects,
  }
  // Repository names are computed locally before folder paths are removed for a phone.
  if (isLan) {
    for (const item of [...model.asks, ...model.reminder, ...model.older, ...model.idle, ...model.stopped, ...model.groups.flatMap(one => one.rows), ...model.finished, ...model.recent]) delete item.dir
    for (const row of [...model.idle, ...model.stopped, ...model.groups.flatMap(one => one.rows)]) delete row.sessionId
  }
  return model
}

// `asked`: with a reply, the question the page showed it under ('' for none). `fp`: the line's
// fingerprint as the page drew it; a tick, an archive and a reply need it, hide and unhide do not.
// `line` is the file line the pressed step came from, so a tick can name the exact step
// when two open steps share a text; absent on a press that names the next step by text.
export type ServeRequest = { key: string; type: string; text: string; session: string; asked?: string; fp?: string; line?: number; connection?: string; turn?: string }

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
    if (item.type === 'ask') {
      const ref = item.ask.step
      return ref === null ? { type: 'refuse', note: s.boardTickGone } : { type: 'tick', ref }
    }
    if (item.type !== 'row') return { type: 'refuse', note: s.boardTickGone }
    // A press names the step it showed by its file line, so two open steps with the same
    // text are told apart; a press without a line ticks the next step, as before.
    if (request.line !== undefined) {
      const step = item.row.steps.find(one => one.line === request.line)
      if (step !== undefined && step.line !== null && request.text === step.text) {
        return { type: 'tick', ref: { project: item.row.project, title: item.row.title, step: step.text, line: step.line, raw: step.raw } }
      }
      // The primary Done button still names the next step when the step list folded it
      // out of view: the page then sends the next step's line and its full text, which
      // the folded list does not hold, so the next step's own ref answers the press.
      const next = item.row.next
      if (next !== null && next.line === request.line && request.text === next.step) return { type: 'tick', ref: next }
      return { type: 'refuse', note: s.boardLineChanged }
    }
    const ref = item.row.next
    // A task keeps its key while its next step moves on: only the step the page showed is ticked.
    if (ref !== null && request.text !== ref.step) return { type: 'refuse', note: s.boardLineChanged }
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
  const native = item.type === 'ask' ? item.ask.nativeSession : item.row.nativeSession
  const connected = reachable(agent, native, target, connections)
  if (!isLan && !connected && connections.some(one => one.scope !== 'mailbox' && one.agent === (agent || 'claude') && one.session === native)) return { type: 'refuse', note: s.messagesContested }
  if (request.type === 'message') {
    const question = item.type === 'ask' ? item.ask.text : item.row.question ?? ''
    if (isLan || !connected || connected.id !== request.connection || connected.turn !== request.turn || connected.session !== request.session || (request.asked ?? '') !== question || !text) return { type: 'refuse', note: s.messagesFailed }
    return { type: 'message', connection: { id: connected.id, turn: connected.turn, agent: connected.agent }, text, title }
  }
  if (connected) return { type: 'refuse', note: s.boardLineChanged }
  if (mode !== 'send' || target === null) return { type: 'refuse', note: infoOf(mode, agent, title, item.type === 'ask' ? item.ask.session : '', s) }
  if (isLan) return { type: 'refuse', note: s.serveLanSend(agentLabel(agent || 'claude', s)) }
  // A closed progress record is not a live receiver. Resuming a saved session is a
  // separate, explicitly enabled action, never a fallback for a disconnected adapter.
  if (!allowResume) return { type: 'refuse', note: s.messagesFailed }
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

// The chat prompt goes as it is in every language: the chat reads it, not the person.
const RELAY_PROMPT = `Report your progress on this work as one Agent Board block. After each step, and
whenever you stop to wait for me, end your reply with the whole block again, inside
a code block, written exactly like this:

## <project>
<!-- auto session=<ID> agent=<name> state=<working|waiting|done|ended> updated=<UTC time, like 2026-10-17T08:10:52Z> -->
### <the outcome, in plain words>
> Context: <one line on why this work exists>
- [x] <a finished step>
- [~] <the step you are on>
- [?] <a step that needs me> — <one line saying what you need>
- [ ] <the next step>
<!-- /auto session=<ID> -->

Rules:
- <ID> is 8 random lower-case hex characters (0-9, a-f). Pick it once and keep it
  for the whole conversation.
- <name> is your own name in lower case, for example muse or dot.
- If you are Claude, write claude-web. The name claude alone is refused.
- <project> is the project's name; keep it the same every time.
- Write the two marker lines exactly as shown, starting at the beginning of the line.
  No other marker names.
- The line after the start marker is the ### title. No other # headings, code
  fences or HTML comments inside the block.
- Marks: [x] done, [~] doing, [ ] to do, [?] needs me, [>] waiting on someone else,
  [!] blocked, [-] cancelled. End a yes/no question in a [?] step with "OK?".
- state=waiting when you hand back to me with steps left, working when you start
  again, done when every step is [x] or [-], ended if you stop for good with steps
  left. updated= is the time of this update in UTC, ending in Z.`

// The words the page's script fills in itself, each with its blanks as \u0001 and \u0002.
const PAGE_WORDS = [
  'webChatConnect', 'webChatCopied', 'importClipboard', 'importNoBlock', 'importUseKeys', 'pasteReview',
  'claudeSendNow', 'claudeSendWorking', 'claudeDelivered', 'claudeReplied', 'claudeGotIt', 'claudeUnconfirmed', 'claudeStopped', 'messageTakeBack', 'messageDismiss',
  'serveQueueNextTurn', 'serveNextTurnHint', 'serveQueueNextOpen', 'serveNextOpenHint', 'messagesHandedNextTurn', 'pressFailed', 'messagesQueued', 'messagesUncertain', 'messagesAccepted', 'messagesAcceptedDisconnected', 'messagesAcknowledged', 'messagesRejected', 'messagesFailed', 'messagesTimeout',
  'sessionsTitle', 'sessionsWaiting', 'sessionsTimedOut',
  'questionReviewOnly', 'hiddenCount', 'showAgain', 'answeredHide',
  'archiveNow', 'cleanUp', 'stoppedCount',
  'tidyBulk', 'tidyStopped', 'tidyAgent', 'tidyOlder', 'tidyValue', 'tidyPreviewButton', 'tidyConfirmButton', 'tidyCancelButton', 'tidyCancelled', 'tidyExpired', 'tidyInvalid', 'tidyNeedsTerminal', 'tidyConfirmPrompt', 'tidyConfirmKey', 'tidyPreviewCount', 'tidyResult', 'tidyPartial',
  'serveClosed', 'serveMoved', 'serveClose', 'serveOffline', 'serveTickNext', 'serveArchive', 'confirmDone', 'serveCopyResume', 'serveCopyCommand',
  'serveOpenLink', 'serveMore', 'serveReplyPlaceholder', 'serveMessagePlaceholder', 'serveSend', 'serveSending',
  'copied', 'pressDone', 'pressFailed', 'pressEmpty', 'pressPending', 'boardCopyFailedBelow',
  'pgNeeds', 'pgAgents', 'pgOwn', 'pgDone', 'pgTabTitle', 'pgWorking', 'pgNoWorking', 'pgQuietAsking', 'pgQuietStopped', 'pgNothing', 'pgNothingHint',
  'pgOlder', 'pgOlderOne', 'pgSeeAll', 'pgMore', 'pgOwnTodo', 'pgWriteOwn', 'pgCopyAnswer', 'pgStuck', 'pgTodo', 'pgLast', 'pgStoppedAt', 'pgBarLabel', 'barStyleInk', 'barStyleBlue', 'barStyleGreen', 'barStyleHead', 'themeLight', 'themeDark', 'themeSystem', 'themeMenu',
  'awayForMinutes', 'awayForHours', 'awayAskedNamedOne', 'awayAskedNamed', 'awayAskedGenericOne', 'awayAskedGenericOneAgent', 'awayAskedGeneric',
  'awayFinished', 'awayFinishedOne', 'awayOfflineNamed', 'awayOffline', 'awayOfflineOne', 'awayUnreadableNamed', 'awayUnreadable', 'awayUnreadableOne', 'awayDismiss',
  'pgDoneSteps', 'pgDoneStepsOne', 'pgMoreSteps', 'pgMoreStepsOne', 'pgVersion', 'pgVersions', 'pgUnreadable', 'pgHowFix', 'pgFixAdvice',
  'pgReady', 'pgUnreadableReply', 'pgUnknownAge', 'pgCopyReply', 'pgPasteIn', 'pgSentTo', 'pgAnswered', 'pgCopyAgain', 'pgCancel',
  'showAllQuestions', 'pgSendReply', 'pgCopyFailed', 'pgOffline', 'pgNotSeen', 'pgNoOthers', 'pgNoOthersFor', 'clearFilters', 'pgStateOpen', 'pgWorkingHint', 'pgPasteLater', 'serveRetry', 'serveCopyMessage', 'serveSendBusy', 'pgNoQuestions', 'pgOthers', 'pgStopped', 'pgDoneWeek', 'pgChipEmpty', 'pgStartIn', 'pgStartAny', 'pgConnected', 'pgTipNeeds', 'pgTipNeedsOne', 'pgTipWorking', 'pgTipOpen', 'pgTipOpenOne', 'pgTipCantRead', 'pgSideFold', 'pgSideOpen',
] as const satisfies ReadonlyArray<keyof Strings>

export const pageWords = (s: Strings): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(s.agentNames).map(([agent, name]) => [`agent:${agent}`, name])),
  ...Object.fromEntries(
    PAGE_WORDS.map(key => {
      const value = s[key] as unknown
      return [key, typeof value === 'function' ? String((value as (...blanks: string[]) => unknown)('\u0001', '\u0002')) : String(value)]
    }),
  ),
})

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The headers the page goes out with: its script and style run only with this page's nonce,
// it talks to its own server only, never sends the address (with its token) on to a link it
// opens, and cannot be framed by another page.
export const pagePolicy = (nonce: string): string =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

const CLIP_CSS = `.clip{flex:1 1 0;min-width:0}.clip>summary,.clip[open]>summary{display:block;cursor:pointer}.clip>summary::before,.clip[open]>summary::before{content:none}.clip .short{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.clip .whole{display:none;white-space:pre-wrap;overflow-wrap:anywhere}.clip[open] .short{display:none}.clip[open] .whole{display:block}`

// The page: one column, a header, a row of agent icons, then what needs the person, what is moving,
// the rest by project and two closed shelves. Only the Needs you sheet is raised; everything else sits on
// the ground with hairlines. Sizes, spacing, motion and the derived states are tokens (page-look.ts); a
// phone (640px and narrower) lets the answers wrap two or three to a line at 48px and only the agent row stays pinned.
const PAGE_CSS = `
html{scrollbar-gutter:stable}
body{overflow-wrap:anywhere}
.col{width:100%;max-width:808px;margin:0 auto;padding-left:max(var(--s5),env(safe-area-inset-left,0px));padding-right:max(var(--s5),env(safe-area-inset-right,0px))}
.head .topbar{flex-wrap:nowrap;min-height:56px;padding-block:0;gap:var(--s3)}
.brand h1{white-space:nowrap}
.live{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:var(--text-xs);color:var(--muted);border:1px solid var(--line);border-radius:var(--radius-round);padding:1px 8px 1px 7px;white-space:nowrap}
.live i{width:7px;height:7px;border-radius:var(--radius-round);background:var(--done)}
body:has(#offline:not(:empty)) .live{display:none}
#offline{position:sticky;top:0;color:var(--alert);overflow-wrap:anywhere;padding:var(--s2) 0;border-bottom:1px solid var(--line)}
#offline:empty{display:none}
#offline:not(:empty){top:var(--head-h,56px);z-index:5;padding:var(--s3) max(var(--s4),calc((100vw - 808px)/2));border-color:color-mix(in srgb,var(--alert) 35%,var(--line));background:color-mix(in srgb,var(--alert) 9%,var(--ground))}
/* The away line: one line at the top of the content column, above the can't-read line. Each part stays whole when the line wraps, and the " · " separator ends a line, never starts one. It folds away on its own row track when the × is pressed. */
#away-line[hidden]{display:none}
#away-line .away-seg{white-space:nowrap}
#away-line .away-lead{color:var(--muted)}
#away-line .away-bold{font-weight:600;color:var(--ink)}
#away-line .away-x{flex:none;width:28px;height:28px;display:inline-grid;place-items:center;vertical-align:middle;padding:0;border:0;border-radius:var(--radius-m);background:transparent;color:var(--muted);cursor:pointer}
#away-line .away-x::before{content:"×";font-size:var(--text-md);line-height:1}
#offline:not(:empty)::before{content:'!';display:inline-grid;place-items:center;width:20px;height:20px;border:1px solid currentColor;border-radius:var(--radius-round);margin-right:var(--s3);font-weight:600}
button,.btn{font:inherit;color:inherit}
button:hover,.btn:hover,summary:hover{background-color:var(--hover)}
button:active,.btn:active{background-color:var(--press)}
button:disabled,button[aria-disabled="true"]{color:var(--muted);border-color:var(--line);cursor:not-allowed}
${agentRowCss}
.link{border:0;background:none;padding:0;min-height:var(--hit);color:var(--ink);font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.link:hover{background:none}
.page{flex:1;display:flex;flex-direction:column;gap:var(--s6);padding-top:var(--s5);padding-bottom:var(--s6)}
#board{display:flex;flex-direction:column;gap:var(--s6);min-width:0}
.t-alert{color:var(--alert)}.t-quiet{color:var(--muted)}
${sheetCss}
.sheet-foot{display:grid;gap:var(--s2);padding:0 var(--s4) var(--s3)}
.sheet-foot:empty{display:none}
.sheet-foot p{margin:0;color:var(--muted)}
.cards,.rows{list-style:none;margin:0;padding:0}
.cards>li+li .card{border-top:1px solid var(--line)}
.card{display:grid;grid-template-columns:24px minmax(0,1fr);gap:var(--s3);padding:var(--s4);min-width:0}
.arrived>.fx>.fx-in{animation:glow var(--dur-glow) var(--ease-out)}
.c-body{min-width:0;display:flex;flex-direction:column;gap:var(--s2)}
.c-meta,.r-meta,.note,.context{overflow-wrap:anywhere}
.c-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s1) var(--s3);font-size:var(--text-xs);line-height:1.5;color:var(--muted)}
.c-meta .who{color:var(--ink);font-weight:600}
.q{margin:0;font-size:var(--text-lg);line-height:1.4;font-weight:600;overflow-wrap:anywhere}
.note,.context{margin:0;color:var(--muted)}
.native-options{margin:0;padding-left:var(--s5);color:var(--muted)}
.answers{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;padding-top:var(--s1)}
.btn,.answers button,.acts button,.state button,.composer button,.shelf-head,.pfoot .btn,.pfoot #close{font:inherit;font-size:var(--text-sm);display:inline-flex;align-items:center;max-width:100%;min-height:var(--hit);padding:0 14px;border:1px solid var(--btn-line);border-radius:var(--radius-m);background:var(--surface);color:var(--ink);cursor:pointer;text-align:left;overflow-wrap:anywhere;text-decoration:none;transition:background-color var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out)}
button.primary{background:var(--act);border-color:var(--act);color:var(--on-act)}
button.primary:hover{background:color-mix(in srgb,var(--ink) 84%,var(--surface));border-color:color-mix(in srgb,var(--ink) 84%,var(--surface))}
button.quiet{border-color:transparent;background:transparent;color:var(--ink);text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.btn:hover,.answers button:hover,.acts button:hover,.state button:hover,.composer button:hover,.pfoot #close:hover{background-color:color-mix(in srgb,var(--ink) 6%,var(--surface))}
button.quiet:hover,.side .pfoot #close:hover,.side .pfoot .btn:hover{background-color:var(--hover)}
.chev{display:inline-block;transition:transform var(--dur-base) var(--ease-out)}.chev::before{content:"▸"}
.open>.shelf-head .chev{transform:rotate(90deg)}
code{display:block;max-width:100%;overflow-x:auto;white-space:pre;font:var(--text-xs)/1.5 var(--font-mono);padding:6px var(--s2);border:1px solid var(--line);border-radius:var(--radius-s);background:var(--inset);color:var(--ink)}
.state{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s3)}
.state .msg{display:inline-flex;align-items:center;gap:var(--s2);min-width:0;line-break:strict}
.ok{color:var(--done)}.go{color:var(--ink)}
.dots{display:inline-flex;gap:3px;margin-left:var(--s2)}.dots i{width:4px;height:4px;border-radius:var(--radius-round);background:currentColor;animation:dot var(--dur-dots) infinite ease-in-out}
.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}
.composer{display:grid;gap:var(--s2)}
textarea{display:block;width:100%;min-width:0;font:inherit;font-size:var(--text-sm);line-height:1.5;padding:10px var(--s3);border:1px solid var(--line-strong);border-radius:var(--radius-m);background:var(--surface);color:var(--ink);resize:vertical;min-height:76px;transition:border-color var(--dur-fast) var(--ease-out)}
textarea:focus{outline:none;border-color:var(--ink);box-shadow:var(--ring)}
.cf{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;justify-content:flex-end}
.cf .where{margin-right:auto;font-size:var(--text-xs);color:var(--muted)}
.receipt,.said-line{margin:0;font-size:var(--text-sm);color:var(--muted)}
.receipt.t-alert{color:var(--alert)}.receipt-box{display:grid;gap:var(--s2)}
.press-result{font-size:var(--text-sm)}.press-result .acts{margin-top:var(--s2)}.press-result:empty{display:none}.press-result.done{color:var(--done)}.press-result.alert{color:var(--alert)}
.press-result textarea{margin-top:var(--s2);font-size:var(--text-sm)}
.empty{display:grid;gap:var(--s1);padding:var(--s4)}
.empty p{margin:0}.empty .sub{font-size:var(--text-xs);color:var(--muted)}.empty .btn{justify-self:start}
.sec{display:flex;flex-direction:column;gap:var(--s2)}
.sec-head{display:flex;align-items:baseline;gap:var(--s3);flex-wrap:wrap}
.sec-head h2{margin:0;font-size:var(--text-lg);line-height:1.4;font-weight:600}
.sec-head .count{font-size:var(--text-xs);color:var(--muted);font-variant-numeric:tabular-nums}
.sec>p{margin:0;color:var(--muted)}
.proj{margin:var(--s3) 0 var(--s2);font-size:var(--text-xs);font-weight:600;color:var(--muted)}
.rows{border-top:1px solid var(--line-strong)}
.rows.bare{border-width:0}
.row-btn:focus-visible{outline-offset:-2px}
div.row-btn{cursor:default}
.rows>li+li>.fx>.fx-in{border-top:1px solid var(--line)}
.row-btn{width:100%;display:grid;grid-template-columns:24px minmax(0,1fr) auto 16px;gap:var(--s3);align-items:center;text-align:left;border:0;background:transparent;padding:var(--s3) var(--s2);min-height:56px;cursor:pointer;border-radius:var(--radius-m);color:inherit;transition:background-color var(--dur-fast) var(--ease-out)}
.row.open .row-btn{background:var(--current);border-radius:var(--radius-m) var(--radius-m) 0 0}
.r-text{min-width:0;display:flex;flex-direction:column;gap:2px}
.r-title{font-size:var(--text-md);line-height:1.4;font-weight:600;overflow-wrap:anywhere}
.r-meta{font-size:var(--text-sm);line-height:1.5;color:var(--muted);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.r-meta span+span{margin-left:var(--s3)}
.r-chev{width:16px;height:16px;color:var(--muted);transition:transform var(--dur-base) var(--ease-out)}
.r-chev::before{content:'';display:block;width:7px;height:7px;margin:4px 0 0 2px;border-top:2px solid currentColor;border-right:2px solid currentColor;transform:rotate(45deg)}
.row-btn[aria-expanded="true"] .r-chev{transform:rotate(90deg)}
div.row-btn .r-chev{visibility:hidden}
.r-meta .st{color:var(--ink)}
.r-meta .prog{display:inline-flex;align-items:center;gap:var(--s2);vertical-align:-1px}
.r-meta .prog span{margin-left:0}
.pbar{display:inline-flex;align-items:center;gap:2px;width:96px;height:8px;flex:none}
.pbar i,.sw i{flex:1 1 0;min-width:5px;height:6px;border-radius:var(--radius-round);background:var(--bar-done);transition:background-color var(--dur-layout) var(--ease-out),height var(--dur-layout) var(--ease-out)}
.pbar .c-c,.sw .c-c{height:8px;background:var(--bar-now)}
.pbar .c-w{background:var(--waiting)}
.pbar .c-b{background:var(--alert)}
.pbar .c-r{background:var(--alive)}
.pbar .c-t,.sw .c-t{background:transparent;border:1px solid var(--line-strong)}
.pbar .c-n{background:transparent;border:1px solid var(--line)}
.pbar.cont{position:relative;display:block;height:6px;border-radius:var(--radius-round);border:1px solid var(--line-strong)}
.pbar.cont b{position:absolute;left:0;top:0;bottom:0;border-radius:var(--radius-round);background:var(--bar-done);transition:width var(--dur-layout) var(--ease-out)}
.pbar.cont u{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--bar-now)}
.pbar.cont u.c-w{background:var(--waiting)}
.pbar.cont u.c-b{background:var(--alert)}
.pbar.cont u.c-r{background:var(--alive)}
[data-bar="blue"] .pbar .c-x,[data-bar="blue"] .pbar .c-c,[data-bar="blue"] .pbar.cont b,[data-bar="blue"] .pbar.cont u.c-c,[data-sw="blue"] .sw .c-x,[data-sw="blue"] .sw .c-c{background:var(--accent)}
[data-bar="green"] .pbar .c-x,[data-bar="green"] .pbar .c-c,[data-bar="green"] .pbar.cont b,[data-bar="green"] .pbar.cont u.c-c,[data-sw="green"] .sw .c-x,[data-sw="green"] .sw .c-c{background:var(--done)}
.pcount{font-variant-numeric:tabular-nums;color:var(--ink)}
.sw{display:inline-flex;align-items:center;gap:2px;width:36px;height:8px;flex:none}
@media (max-width:560px){.pbar{width:72px}}
.r-right.t-alert{color:var(--alert)}
.r-right{font-size:var(--text-xs);color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;max-width:9em;overflow:hidden;text-overflow:ellipsis}
.row-open{background:var(--current);border-radius:0 0 var(--radius-m) var(--radius-m);padding:var(--s1) var(--s2) var(--s3) calc(var(--s2) + 36px);display:grid;gap:var(--s3);min-width:0;opacity:0;transition:opacity var(--dur-base) var(--ease-out)}
.row.open .row-open{opacity:1}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:var(--s1)}
.steps li{display:grid;grid-template-columns:22px minmax(0,1fr);gap:var(--s2);align-items:baseline}
/* A step's Done button sits under its text, one line wide at most; the whole step is its title. */
.steps li>button{grid-column:2;justify-self:start;max-width:100%;min-width:0}
.steps li>button>span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.steps .now .t{font-weight:600}
.steps .mk{text-align:center}
.t-quiet .short,.t-quiet .whole{color:var(--muted)}
.row-open details:not(.clip)>summary{cursor:pointer;color:var(--muted);list-style:none}
.row-open details:not(.clip)>summary::before{content:"▸ ";color:var(--muted)}.row-open details[open]:not(.clip)>summary::before{content:"▾ "}
.row-open details:not(.clip)>summary::-webkit-details-marker{display:none}
.acts{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center}
.s-doing,.k-input,.k-reply,.n-active{color:var(--ink)}
.s-waiting,.k-confirm,.k-choose,.n-waiting{color:var(--waiting-text)}
.s-blocked{color:var(--alert)}.n-today{color:var(--done)}.s-running{color:var(--alive)}.s-done,.s-todo,.s-cancelled{color:var(--muted)}
.shelf{display:block}
.shelf-head{display:flex;gap:var(--s2);width:100%;border-width:1px 0;border-radius:0;min-height:48px;padding:var(--s3) var(--s2);font-size:var(--text-md);line-height:1.4;font-weight:600}
.shelf-head .count{font-size:var(--text-xs);font-weight:400;color:var(--muted);font-variant-numeric:tabular-nums}
.shelf .rows{border-top:0}
.shelf-body{display:grid;gap:var(--s2);padding:var(--s3) var(--s2);min-width:0}
.shelf-body .quiet{margin:0;color:var(--muted)}
.shelf-body textarea{font-family:var(--font-mono);min-height:72px}
.hid{display:grid;gap:var(--s2);padding:var(--s2) 0;min-width:0}
.hid+.hid{border-top:1px solid var(--line)}
.hid p{margin:0}
.fresh{display:grid;gap:var(--s4);padding:var(--s6) 0;max-width:560px}
.fresh h2{margin:0;font-size:var(--text-lg);line-height:1.4}.fresh p{margin:0;color:var(--muted)}
.fresh .mark{width:44px;height:44px}
.fresh ul{list-style:none;margin:0;padding:0;display:grid;gap:var(--s3)}
.fresh li{display:grid;grid-template-columns:24px minmax(0,1fr);gap:var(--s3);align-items:center}
.fresh li b{font-weight:600}
.fresh .ok{color:var(--done)}
.pfoot{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);align-items:center;border-top:1px solid var(--line);padding-top:var(--s4);font-size:var(--text-xs);color:var(--muted)}
.pfoot p{margin:0}.pfoot .press-result{flex-basis:100%}
#note{position:sticky;bottom:0;padding:var(--s3) 0;background:var(--ground);border-top:1px solid var(--line);overflow-wrap:anywhere}
#note:empty{display:none}#note.done{color:var(--done)}#note.alert{color:var(--alert)}
.lost{display:grid;gap:var(--s2);padding:var(--s3) var(--s4);border:1px solid var(--line-strong);border-radius:var(--radius-m)}
.lost .where{font-weight:600}
.notices{display:grid;gap:var(--s2)}.notices p{margin:0}
${CLIP_CSS}
/* The sidebar, the rail and the work beside them. */
.shell{display:block}
.side{display:none}
.stage{min-width:0}
.s-brand{display:flex;align-items:center;gap:10px;min-height:40px;padding:0 var(--s2)}
.s-brand .b-name{flex:1 1 auto;font-size:var(--text-md);font-weight:600;line-height:1.4;white-space:nowrap}
.s-toggle{flex:none;width:32px;height:32px;display:inline-grid;place-items:center;padding:0;border:0;border-radius:var(--radius-m);background:transparent;color:var(--muted);cursor:pointer;transition:background-color var(--dur-fast) var(--ease-out),color var(--dur-fast) var(--ease-out)}
.s-toggle:hover{background:var(--hover);color:var(--ink)}
.s-toggle:active{background:var(--press)}
.s-group{display:flex;flex-direction:column;gap:2px}
.s-label{margin:0 0 var(--s1);padding:0 var(--s2);font-size:var(--text-xs);font-weight:600;color:var(--muted)}
.s-item{position:relative;display:flex;align-items:center;gap:var(--s3);width:100%;max-width:none;min-height:36px;padding:4px var(--s2);border:0;border-radius:var(--radius-m);background:transparent;color:var(--ink);font-size:var(--text-sm);line-height:1.3;text-align:left;cursor:pointer;transition:background-color var(--dur-fast) var(--ease-out)}
.s-item:hover{background:var(--hover)}
.s-item:active{background:var(--press)}
.s-item[aria-pressed="true"]{background:var(--current);font-weight:600}
.s-item>svg.i{width:18px;height:18px;margin-inline:3px}
.s-item .ag{position:relative;width:24px;height:24px;border-radius:var(--radius-s);flex:none}
.v-needs>svg.i{color:var(--waiting-text)}.v-working>svg.i{color:var(--alive)}.v-others>svg.i,.v-done>svg.i{color:var(--muted)}
.s-project::before{content:"";flex:none;width:18px;height:18px;margin-inline:3px;background:var(--muted);-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6' stroke-linejoin='round'%3E%3Cpath d='M2 4.5h4l1.5 1.5H14v6.5H2z'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6' stroke-linejoin='round'%3E%3Cpath d='M2 4.5h4l1.5 1.5H14v6.5H2z'/%3E%3C/svg%3E") center/contain no-repeat}
.s-txt{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.s-n{flex:none;font-size:var(--text-xs);color:var(--muted);font-variant-numeric:tabular-nums}
.s-n:empty{display:none}
.s-n.hot,.side .badge{position:static;flex:none;min-width:22px;height:22px;padding:0 6px;border:0;border-radius:var(--radius-round);background:var(--waiting-fill);color:var(--on-accent);font-size:var(--text-xs);font-weight:600;line-height:22px;text-align:center;font-variant-numeric:tabular-nums}
.side .badge.bad{background:var(--alert)}
.s-agent[data-presence] .ag::after,.s-agent.working .ag::after{content:"";position:absolute;right:-5px;bottom:-5px;width:9px;height:9px;border:2px solid var(--ground);border-radius:var(--radius-round)}
.s-agent[data-presence="open"] .ag::after,.s-agent[data-presence="connected"] .ag::after{border-color:var(--alive);background:var(--ground)}
.s-agent[data-presence="offline"] .ag::after{border-radius:var(--radius-s);background:var(--muted)}
.s-agent[data-presence="notseen"] .ag::after{background:linear-gradient(var(--muted),var(--muted)) center/6px 2px no-repeat var(--ground)}
.s-agent.working .ag::after{border-color:var(--ground);border-radius:var(--radius-round);background:var(--alive)}
.s-agent[aria-pressed="true"].working .ag::after,.s-agent[aria-pressed="true"][data-presence="offline"] .ag::after,.s-agent[aria-pressed="true"][data-presence="notseen"] .ag::after{border-color:var(--current)}
.shell[data-empty="1"] :is(.s-views,.s-projects){display:none}
/* the settings at the foot of the sidebar: the language spot (reserved, in a row with the theme button), the project link, then Close the board */
.s-foot{margin-top:auto;padding-top:var(--s3);border-top:1px solid var(--line)}
.side .pfoot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--s1) var(--s2);border-top:0;padding:0 0 0 var(--s2)}
.side .pfoot .set-row{order:-1;flex-basis:100%;margin-left:calc(var(--s2) * -1)}
.side .pfoot .grow{display:none}
.side .pfoot #close,.side .pfoot .btn{min-height:24px;padding-inline:var(--s2);font-size:var(--text-xs);color:var(--muted)}
.side .pfoot #close:hover,.side .pfoot .btn:hover{color:var(--ink)}
.side .pfoot p{order:3;flex-basis:100%}
.ver-link{display:inline-flex;align-items:center;gap:var(--s1);color:color-mix(in srgb,var(--muted) 75%,var(--surface));font-size:var(--text-xs);line-height:1.2;text-decoration:none;border-radius:var(--radius-s);white-space:nowrap}
.ver-link:hover{color:var(--ink);text-decoration:underline;text-underline-offset:3px}
.ver-link svg.i{width:12px;height:12px}
.set-row{display:inline-flex;align-items:center;gap:var(--s1)}
.pfoot .grow{flex:1 1 auto}

@media (min-width:560px){
  .shell{display:grid;grid-template-columns:232px minmax(0,1fr);align-items:start;transition:grid-template-columns var(--dur-layout) var(--ease-out)}
  .shell[data-rail="1"]{grid-template-columns:64px minmax(0,1fr)}
  .side{display:flex;flex-direction:column;gap:var(--s4);position:sticky;top:0;height:100dvh;overflow-x:hidden;overflow-y:auto;scrollbar-width:thin;padding:var(--s4) var(--s3);border-right:1px solid var(--line);background:var(--ground)}
  .head,.agents-in{display:none}
  .agents{position:static;border-bottom:0}
  #offline:not(:empty){top:0;padding:var(--s3) var(--s5)}
  /* the can't-read line and the work share one width, so their edges line up */
  .col{max-width:1040px}
  /* one view at a time; Overview shows them all */
  .shell[data-view="needs"] #board>[data-sec]:not([data-sec="needs"]),
  .shell[data-view="working"] #board>[data-sec]:not([data-sec="working"]),
  .shell[data-view="others"] #board>[data-sec]:not([data-sec="others"]),
  .shell[data-view="done"] #board>[data-sec]:not([data-sec="done"]){display:none}
  /* the rail: the views and the agents as 44px icons with their badges; names in the tooltip; the project link, the theme and Close the board in the footer */
  .shell[data-rail="1"] .side{padding:var(--s3) 10px;align-items:center}
  .shell[data-rail="1"] :is(.s-label,.s-projects,.s-foot,.s-brand .b-name){display:none}
  .shell[data-rail="1"] .s-brand{flex-direction:column;gap:var(--s2);padding:0}
  .shell[data-rail="1"] .s-group{align-items:center;width:100%}
  .shell[data-rail="1"] :is(.s-views,.s-views+.s-group){border-top:1px solid var(--line);padding-top:var(--s3)}
  .shell[data-rail="1"] .s-item{width:44px;height:44px;min-height:44px;padding:0;justify-content:center}
  .shell[data-rail="1"] .s-item>svg.i{margin:0}
  .shell[data-rail="1"] .s-txt{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
  .shell[data-rail="1"] .s-n:not(.hot){display:none}
  .shell[data-rail="1"] :is(.s-n.hot,.side .badge){position:absolute;top:-3px;right:-5px;border:2px solid var(--ground);line-height:18px}
}
@media (min-width:1280px){
  .shell:is([data-view="all"],[data-view="needs"]) .col{max-width:1440px}
  /* Overview in two columns: Needs you on the left, the rest stacked on the right; the last row takes the slack */
  .shell[data-view="all"] #board{display:grid;grid-template-columns:minmax(460px,5fr) minmax(0,6fr);column-gap:var(--s6);row-gap:0;grid-template-rows:repeat(12,auto) 1fr;align-items:start}
  .shell[data-view="all"] #board>*{grid-column:2;margin-bottom:var(--s6)}
  .shell[data-view="all"] #board>#needs{grid-column:1;grid-row:1 / -1;margin-bottom:0}
  .shell[data-view="all"] #board>.fresh{grid-column:1 / -1}
  /* Needs you on its own: the questions sit side by side, each its own sheet */
  .shell[data-view="needs"] .sheet{background:none;border:0}
  .shell[data-view="needs"] .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:var(--s4);align-items:start}
  .shell[data-view="needs"] .cards>li{background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-m)}
  .shell[data-view="needs"] .cards>li:first-child{border-top-left-radius:0}
  .shell[data-view="needs"] .cards>li+li .card{border-top:0}
}
@media (min-width:1760px){
  .shell[data-view="all"] .col{max-width:1840px}
  .shell[data-view="all"] #board{grid-template-columns:repeat(3,minmax(0,1fr))}
  .shell[data-view="all"] #board>*{grid-column:3}
  .shell[data-view="all"] #board>#needs{grid-column:1}
  .shell[data-view="all"] #board>[data-sec="working"]{grid-column:2;grid-row:1 / -1;margin-bottom:0}
  .shell[data-view="all"] #board>.fresh{grid-column:1 / -1}
}
@media (max-width:640px){
  .col{padding-left:max(var(--s3),env(safe-area-inset-left,0px));padding-right:max(var(--s3),env(safe-area-inset-right,0px))}
  .head{position:static}
  .agents{top:0}
  #offline:not(:empty){top:0}
  .live .lbl{display:none}.live{padding:var(--s1)}
  .page,#board{gap:var(--s5)}
  .page{padding-top:var(--s4)}
  .card{padding:var(--s3)}
  .row-open{padding-left:var(--s2)}
  .pfoot{gap:var(--s2)}
}
/* A finger, not the width, decides target size: a narrow window with a mouse keeps the desktop sizes. */
@media (pointer:coarse){
  .btn,.acts button,.state button,.composer button,.shelf-head,.row-btn,.pfoot #close,.s-item{min-height:44px}
  .link{min-height:44px}
  .answers button,.answers .btn{flex:1 1 auto;min-height:48px;justify-content:flex-start}
  .answers button.quiet{flex:0 0 auto;min-height:44px}
  .s-toggle{width:44px;height:44px}
  #away-line .away-x{width:44px;height:44px}
  textarea{min-height:96px}
}
${motionCss}
`

const VIEW_ICONS = {
  all: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  needs: '<path d="M4 14V2.5M4 3h8l-2 2.75L12 8.5H4"/>',
  working: '<path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none"/>',
  others: '<path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5M2.75 4.5h.01M2.75 8h.01M2.75 11.5h.01"/>',
  done: '<path d="M3 8.5 6.5 12 13 4.5"/>',
} as const

// One view in the sidebar: pressing it shows that section alone (Overview shows all of them). It works without the server.
const sideView = (id: keyof typeof VIEW_ICONS, label: string, hasCount: boolean): string =>
  `<button type="button" class="s-item v-${id}" id="view-${id}" data-view="${id}" data-local data-nav title="${esc(label)}" aria-pressed="${id === 'all'}"><svg class="i" viewBox="0 0 16 16" aria-hidden="true">${VIEW_ICONS[id]}</svg><span class="s-txt">${esc(label)}</span>${hasCount ? `<span class="s-n${id === 'needs' ? ' hot' : ''}" id="count-${id}"></span>` : ''}</button>`

// `isLan`: the page a phone opens on the local network, which closes sooner.
export const servePage = (s: Strings, nonce: string, isLan = false, idleMs = 0): string => `<!doctype html>
<html lang="${htmlLang(s)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Agent Board</title>
${faviconLink}
<script nonce="${nonce}">${themeHead}</script>
<style nonce="${nonce}">
${pageTokens('56px')}
${pageBaseCss}
${agentMarkCss()}
${PAGE_CSS}
</style>
</head>
<body>
<div class="shell" id="shell" data-view="all">
<aside class="side" id="side" aria-label="Agent Board">
<div class="s-brand">${boardMark}<span class="b-name">Agent Board</span><span class="live" title="${esc(s.serveLiveHint)}"><i></i></span><button type="button" class="s-toggle" id="side-toggle" data-local aria-expanded="true" aria-label="${esc(s.pgSideFold)}" title="${esc(s.pgSideFold)}"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6.5 2.5v11"/></svg></button></div>
<nav class="s-group s-views" id="side-views" aria-label="${esc(s.pgViews)}">${sideView('all', s.pgOverview, false)}${sideView('needs', s.pgNeeds, true)}${sideView('working', s.pgWorking, true)}${sideView('others', s.pgOthers, true)}${sideView('done', s.pgDone, true)}</nav>
<div class="s-group s-agents" id="side-agent-group" role="group" aria-labelledby="side-agents-label" hidden><p class="s-label" id="side-agents-label">${esc(s.pgAgents)}</p><div class="s-group" id="side-agents"></div></div>
<div class="s-group s-projects" id="side-project-group" role="group" aria-labelledby="side-projects-label" hidden><p class="s-label" id="side-projects-label">${esc(s.pgProjects)}</p><div class="s-group" id="side-projects"></div></div>
<div class="s-foot" id="side-foot"></div>
</aside>
<div class="stage">
<header class="head" id="head"><div class="col topbar"><div class="brand">${boardMark}<h1>Agent Board</h1><span class="live" title="${esc(s.serveLiveHint)}"><i></i><span class="lbl">${esc(s.serveLive)}</span></span></div></div></header>
<div id="offline" role="status" aria-live="polite"></div>
<nav class="agents" id="agents" aria-label="${esc(s.pgAgents)}" hidden><div class="col agents-in" id="chips"></div><div class="col agent-note fx gone" id="away-line" role="status" hidden><div class="fx-in" id="away-line-in"></div></div><div class="col agent-note" id="agent-note"></div></nav>
<main class="col page">
<div id="board"></div>
<details id="tidy-bulk"><summary>${esc(s.tidyBulk)}</summary><div class="fold-in"><p><label>${esc(s.tidyBulk)} <select id="tidy-kind"><option value="stopped">${esc(s.tidyStopped)}</option><option value="agent">${esc(s.tidyAgent)}</option><option value="older">${esc(s.tidyOlder)}</option></select> <input id="tidy-value" type="text" inputmode="text" placeholder="${esc(s.tidyValue)}" aria-label="${esc(s.tidyValue)}"></label></p><div class="acts"><button type="button" id="tidy-preview" data-local>${esc(s.tidyPreviewButton)}</button><button type="button" id="tidy-confirm" data-local disabled>${esc(s.tidyConfirmButton)}</button><button type="button" id="tidy-cancel" data-local disabled>${esc(s.tidyCancelButton)}</button></div></div></details><footer class="pfoot" id="pfoot"><a class="ver-link" href="https://github.com/WenyuChiou/agent-board" target="_blank" rel="noopener" title="${esc(s.pgGithub)}"><span id="versions"></span><span aria-hidden="true">·</span>GitHub<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.5H3.5v9h9v-3M9 3h4v4M13 3 7.5 8.5"/></svg></a><span class="grow"></span>${isLan ? `<p>${esc(s.serveLanIdle)}</p>` : idleMs > 0 ? `<p>${esc(s.serveIdleTimed(idleMs / 60_000))}</p>` : ''}<span class="set-row">${themeToggle(s)}</span>${isLan ? '' : `<button type="button" class="btn" id="connect-web-chat" data-static>${esc(s.webChatConnect)}</button><button type="button" class="btn" id="import-clipboard" data-static>${esc(s.importClipboard)}</button>`}<button type="button" id="close" data-static>${esc(s.serveClose)}</button></footer>
<div id="note" role="status" aria-live="polite"></div>
</main>
</div>
</div>
${isLan ? '' : `<script type="application/json" id="relay-prompt">${JSON.stringify(RELAY_PROMPT).replace(/</g, '\\u003c')}</script>`}
<script type="application/json" id="words">${JSON.stringify(pageWords(isLan ? { ...s, serveOffline: s.serveOfflineLan } : s)).replace(/</g, '\\u003c')}</script>
<script nonce="${nonce}">${PAGE_SCRIPT}</script>
</body>
</html>
`

const PAGE_SCRIPT = String.raw`
(function () {
  'use strict';
  var W = JSON.parse(document.getElementById('words').textContent);
  var token = new URLSearchParams(location.search).get('t') || '';
  var board = document.getElementById('board');
  var note = document.getElementById('note');
  var offline = document.getElementById('offline');
  var presence = null;
  var GLYPH = { done: '✓', doing: '▸', todo: '•', waiting: '●', running: '◐', blocked: '!', cancelled: '–' };
  var last = '';
  var boardEtag = '';
  var opened = {};
  var timer = null;
  var isClosed = false;
  var isUnreachable = false;
  var offlineButtons = [];
  var since = null;
  var messageAttempts = {};
  var latest = null;
  var awaySnap = null;
  var connections = [];
  ${filterStore}
  ${agentFade}
  var fadeChips = agentFade(document.getElementById('chips'));
  function w(key, a, b) {
    var template = String(W[key]);
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
  function hasClass(node, name) { return (' ' + (node.className || '') + ' ').indexOf(' ' + name + ' ') !== -1; }
  function toggleClass(node, name, on) {
    var names = String(node.className || '').split(' ').filter(function (one) { return one && one !== name; });
    if (on) names.push(name);
    node.className = names.join(' ');
  }
  // Motion: the page moves things only after its first draw, and never when the person asked for less.
  var reduce = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var hasDrawn = false;
  function moving() { return hasDrawn && !!reduce && !reduce.matches && typeof requestAnimationFrame === 'function'; }
  // A block opens and closes by its row track, so what is next to it follows. done runs once it has finished.
  function reveal(block, isShown, done) {
    if (!block) return;
    var was = !hasClass(block, 'gone');
    toggleClass(block, 'gone', !isShown);
    block.inert = !isShown;
    if (!done) return;
    if (was === isShown || !moving()) { done(); return; }
    var finished = false;
    var end = function () { if (!finished) { finished = true; done(); } };
    block.addEventListener('transitionend', function (event) { if (event.target === block) end(); });
    setTimeout(end, 420);
  }
  function fx(content, isShown) {
    var wrap = el('div', 'fx gone');
    wrap.inert = true;
    add(wrap, add(el('div', 'fx-in'), content));
    reveal(wrap, isShown !== false);
    return wrap;
  }
  var results = {};
  // The last message sent from each card or row, so a failed one can go again or be copied.
  var sentLast = {};
  var agentPresence = {};
  var resultSlots = {};
  var lostResults = [];
  resultSlot(document.querySelector('.pfoot'), 'close', '', w('serveClose'));
  resultSlot(document.getElementById('tidy-bulk'), 'tidy', '', w('tidyBulk'));
  function resultSlot(card, key, revision, label) {
    card.setAttribute('data-card-key', key);
    var previous = results[key];
    // A result whose card was gone for a whole update belongs to the showing that went
    // away: when the card comes back, its line is drawn fresh, without the old notice (#815).
    if (previous && previous.orphaned && !previous.pending) delete results[key];
    else if (previous && previous.awaitingRefresh) { previous.revision = revision; previous.awaitingRefresh = false; }
    else if (previous && !previous.pending && previous.tone !== 'alert' && previous.revision && revision && previous.revision !== revision) delete results[key];
    var slot = el('div', 'press-result');
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
    slot.node.className = 'press-result ' + result.tone;
    slot.node.setAttribute('role', result.tone === 'alert' ? 'alert' : 'status');
    restoreNotice(slot.node, result);
    if (result.tone === 'alert' && result.canRetry && sentLast[key]) {
      var again = sentLast[key];
      slot.node.appendChild(add(el('div', 'acts'), button(w('serveRetry'), function () { again.again(); }), button(w('serveCopyMessage'), function () { copy(again.text, key); }, '', true)));
    }
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
  function restoreNotice(node, result) {
    if (typeof result.unhideKey !== 'string' || result.unhideKey.indexOf('hidden:') !== 0) return;
    add(node, add(el('div', 'acts'), button(w('showAgain'), function () { act(result.unhideKey, 'unhide'); })));
  }
  function hideQuestion(key, unhideKey) {
    return act(key, 'hide', '', '', '', '', '', null, undefined, unhideKey);
  }
  function beginPress() {
    resetTidy(false);
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
  function say(text, tone, key, copyText, canRetry) {
    if (key) {
      var slot = resultSlots[key];
      var previous = results[key];
      results[key] = { text: text || w('pressFailed'), tone: tone || '', copyText: copyText, canRetry: canRetry === true, pending: tone !== 'done' && tone !== 'alert', awaitingRefresh: tone === 'done', revision: previous ? previous.revision : slot ? slot.revision : '', label: previous ? previous.label : slot ? slot.label : '' };
      paintResult(key);
      if (!slot) keepCopyFocus(drawLostResults);
      return;
    }
    note.textContent = text || '';
    note.className = tone || '';
  }
  function unreachable() {
    boardEtag = '';
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
  // Names this page to the board, so it can tell one open page from another (#265).
  function newPageId() { try { return 'p' + crypto.randomUUID(); } catch (error) { return 'p' + String(Math.random()).slice(2, 14); } }
  var pageId = newPageId();
  function call(path, body) {
    if (isUnreachable && body !== undefined) return Promise.reject();
    var headers = { 'x-board-token': token, 'x-board-page': pageId, 'x-board-visible': document.hidden ? '0' : '1' };
    if (path === '/api/board' && body === undefined && boardEtag) headers['if-none-match'] = boardEtag;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }).then(function (res) {
      if (path === '/api/board' && res.status === 304) return { ok: true, unchanged: true };
      return res.json().catch(function () { return {}; }).then(function (data) {
        data.ok = res.ok && data.ok !== false;
        if (path === '/api/board') boardEtag = data.ok && data.model && res.headers ? res.headers.get('etag') || '' : '';
        return data;
      });
    }).catch(function (error) { unreachable(); throw error; });
  }
  // The progress bar's style (#1085): the root's data-bar picks the colours, so a pick shows on every
  // bar at once. A pick in the theme menu goes to the board, which keeps it for the pane and the
  // terminal board too; one that does not land goes back to what it was.
  function barStyleShown(style) {
    var root = document.documentElement;
    if (!root || (style !== 'ink' && style !== 'blue' && style !== 'green')) return;
    if (root.getAttribute('data-bar') !== style) root.setAttribute('data-bar', style);
    document.querySelectorAll('[data-bar-set]').forEach(function (item) { item.setAttribute('aria-checked', String(item.getAttribute('data-bar-set') === style)); });
  }
  document.querySelectorAll('[data-bar-set]').forEach(function (node) {
    node.addEventListener('click', function () {
      var before = document.documentElement && document.documentElement.getAttribute('data-bar') || 'ink';
      var style = node.getAttribute('data-bar-set');
      barStyleShown(style);
      call('/api/style', { style: style }).then(function (data) { if (!data.ok) barStyleShown(before); }, function () { barStyleShown(before); });
    });
  });
  // A page that is going away tells the board, so opening the board again opens a window instead of pointing at this one (#265).
  if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', function () {
    try { fetch('/api/page-gone', { method: 'POST', keepalive: true, headers: { 'x-board-token': token, 'x-board-page': pageId, 'content-type': 'application/json' }, body: '{}' }).catch(function () {}); } catch (error) {}
  });
  // A page the browser kept in its back/forward cache and shows again is the same document, but the board forgot its id when it left: it names itself anew and asks at once (#1028).
  if (typeof window.addEventListener === 'function') window.addEventListener('pageshow', function (event) {
    if (!event || !event.persisted || isClosed) return;
    pageId = newPageId();
    refresh();
  });
  // onCopied: what to do once the text is on the clipboard; the card then says where to paste it. Without it the
  // result line says Copied. That line, and the card's after-copy line, show only after a copy was confirmed
  // (the clipboard promise resolved, or the older copy command on a page the clipboard is closed to, such as
  // one opened over plain http on the network). If neither worked, the answer stays unanswered and one line in
  // the alert colour says so; a copy that carries no card (a command) shows its text to select instead.
  function copy(text, key, onCopied) {
    say(w('pressPending'), '', key);
    function landed() {
      if (!onCopied) { say(w('copied'), 'done', key); return; }
      // The card's own line says where to paste, so the line that said the press was under way goes.
      delete results[key];
      var slot = resultSlots[key];
      if (slot) { slot.node.textContent = ''; slot.node.className = 'press-result'; }
      onCopied();
    }
    function failed() { if (onCopied) say(w('pgCopyFailed'), 'alert', key); else say(w('boardCopyFailedBelow'), 'alert', key, text); }
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
      if (isCopied) landed();
      else failed();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(landed, fallback);
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
  // A button that only opens or reveals something already on the page: it works without the server and is no action on a card.
  function navButton(label, onPress) {
    var node = button(label, onPress, '', true, true);
    node.setAttribute('data-nav', '');
    return node;
  }
  // The pressed button shows the dots and is off while its message is on its way.
  function busyOn(node) {
    if (!node) return;
    node.disabled = true;
    if (!node.dotsNode) { node.dotsNode = add(el('span', 'dots'), el('i'), el('i'), el('i')); node.appendChild(node.dotsNode); }
  }
  function busyOff(node, stillOff) {
    if (!node) return;
    node.disabled = stillOff === true;
    if (node.dotsNode) { node.dotsNode.remove(); node.dotsNode = null; }
  }
  // fp: the fingerprint the line was drawn with, which the server checks before it writes. go: the button
  // that sent it. A failed send keeps the message for Send again and Copy message.
  function act(key, type, text, waiting, session, asked, fp, go, line, unhideKey) {
    if (isUnreachable) return Promise.resolve();
    busyOn(go);
    say(waiting || w('pressPending'), '', key);
    return call('/api/act', { key: key, type: type, text: text || '', session: session || '', asked: asked || '', fp: fp || '', ...(line === undefined ? {} : { line: line }) }).then(function (data) {
      say(data.note || w(data.ok ? 'pressDone' : 'pressFailed'), data.ok ? 'done' : 'alert', key, undefined, type === 'send' && !data.ok);
      if (data.ok && type === 'hide' && unhideKey && results[key]) {
        results[key].unhideKey = unhideKey;
        paintResult(key);
      }
      busyOff(go, data.ok);
      return data.ok;
    }, function () {
      say(w('serveOffline'), 'alert', key);
      busyOff(go, false);
      unreachable();
      return false;
    }).then(function (ok) { refresh(); return ok; });
  }
  // Reconcile both a fresh render and an enqueue response that arrives after its receipt.
  function clearEnqueueResult(key, receipt) {
    var result = key && results[key];
    if (!result || !receipt || result.messageId !== receipt.id) return;
    delete results[key];
    var slot = resultSlots[key];
    if (slot) { slot.node.textContent = ''; slot.node.className = 'press-result'; }
  }
  function nativeAct(key, text, delivery, session, asked, fp, go) {
    if (isUnreachable) return Promise.resolve(false);
    var slot = JSON.stringify([key, delivery.id, delivery.turn, session, asked, fp]);
    var attempt = messageAttempts[slot];
    if (!attempt || attempt.text !== text) attempt = messageAttempts[slot] = { id: 'AB-' + crypto.randomUUID(), text: text };
    busyOn(go);
    say(w('serveSending', agentName(delivery.agent)), '', key);
    return call('/api/act', { key: key, type: 'message', id: attempt.id, text: text, connection: delivery.id, turn: delivery.turn, session: session, asked: asked || '', fp: fp }).then(function (data) {
      say(data.note || w(data.ok ? 'messagesQueued' : 'messagesFailed'), data.ok ? 'done' : 'alert', key, undefined, !data.ok);
      if (data.ok && results[key]) {
        results[key].messageId = attempt.id;
        clearEnqueueResult(key, pg.sources[key] && pg.sources[key].receipt);
      }
      busyOff(go, data.ok || isUnreachable);
      return data.ok;
    }, function () { say(w('messagesFailed'), 'alert', key, undefined, true); busyOff(go, false); unreachable(); return false; }).then(function (ok) { refresh(); return ok; });
  }
  // A draft that was sent is gone from the box on the page now, whatever redraw happened since it was pressed.
  function clearDraft(draftKey) {
    pg.drafts[draftKey] = '';
    board.querySelectorAll('textarea[data-key]').forEach(function (box) { if (box.getAttribute('data-key') === draftKey) box.value = ''; });
  }
  function brand(agent) {
    if (!agent) return '';
    var key = 'agent:' + agent.toLowerCase();
    return Object.prototype.hasOwnProperty.call(W, key) ? W[key] : agent;
  }
  function agentName(agent) { return brand(agent || 'claude'); }
  // Take back and Dismiss both end a message on the hub, and free the session for the next one.
  // Take back is offered only while the message waits, when it does keep it from Claude. Once
  // delivered, Dismiss clears the card and stops nothing in Claude's window.
  function dismissButton(label, receipt, key) {
    return button(label, function () {
      call('/api/messages/dismiss', { id: receipt.id }).then(function (data) {
        if (!data.ok) say(w('pressFailed'), 'alert', key, undefined, true);
        refresh();
      }, function () { say(w('pressFailed'), 'alert', key, undefined, true); });
    });
  }
  // The card's line for a message to a Claude session, by what its receipt says (#316).
  function claudeReceipt(receipt, key, canSend) {
    var error = receipt.error || '';
    var isStopped = receipt.status === 'rejected';
    var isReplied = receipt.status === 'acknowledged';
    // Whatever went nowhere can be sent again, under an id of its own.
    if (isStopped || isReplied || error === 'DISMISSED' || error === 'EXPIRED') Object.keys(messageAttempts).forEach(function (slot) { if (messageAttempts[slot].id === receipt.id) delete messageAttempts[slot]; });
    if (error === 'DISMISSED') return null;
    var isUnconfirmed = receipt.status === 'uncertain' || receipt.status === 'accepted' && error === 'DISCONNECTED';
    var line = el('p', 'receipt' + (isStopped ? ' t-alert' : ''), isStopped ? (error === 'STOPPED' ? w('claudeStopped') : w('messagesRejected'))
      : isReplied ? (receipt.reply ? w('claudeReplied', receipt.reply) : w('claudeGotIt'))
      : isUnconfirmed ? w('claudeUnconfirmed')
      : receipt.status === 'queued' ? w('claudeSendWorking')
      : w('claudeDelivered') + (receipt.when ? ' · ' + receipt.when : ''));
    line.setAttribute('role', isStopped ? 'alert' : 'status');
    var last = key && sentLast[key];
    // The hub lets go of a finished message's words; this page may still hold them.
    var words = receipt.text || (last ? last.text : '');
    var copyIt = words ? button(w('serveCopyMessage'), function () { copy(words, key); }, '', true) : null;
    var acts = isStopped ? add(el('div', 'acts'), last && canSend ? button(w('serveRetry'), function () { last.again(); }) : null, copyIt)
      // The hub has already let go of an expired message: nothing is left to dismiss.
      : isUnconfirmed ? add(el('div', 'acts'), copyIt, error === 'EXPIRED' ? null : dismissButton(w('messageDismiss'), receipt, key))
      : isReplied ? null
      : add(el('div', 'acts'), dismissButton(w(receipt.status === 'queued' ? 'messageTakeBack' : 'messageDismiss'), receipt, key));
    return acts ? add(el('div', 'receipt-box'), line, acts) : line;
  }
  function receiptLine(receipt, key, agent, canSend) {
    if (!receipt) return null;
    clearEnqueueResult(key, receipt);
    if (!agent || String(agent).toLowerCase() === 'claude') return claudeReceipt(receipt, key, canSend);
    var labels = { queued: 'messagesQueued', uncertain: 'messagesUncertain', accepted: receipt.isMailbox ? 'messagesHandedNextTurn' : 'messagesAccepted', acknowledged: 'messagesAcknowledged', rejected: 'messagesRejected' };
    // A mailbox message that was handed over gets no ACK, so its id is done with here: the next send is a new message.
    if (receipt.status === 'acknowledged' || receipt.status === 'rejected' || receipt.status === 'accepted' && receipt.isMailbox) Object.keys(messageAttempts).forEach(function (slot) { if (messageAttempts[slot].id === receipt.id) delete messageAttempts[slot]; });
    // The server already took a nonce ACK off; a receipt kept from a version 1 store was
    // acknowledged with the message id instead.
    var reply = receipt.reply || '';
    var ack = 'ACK ' + receipt.id;
    if (reply.indexOf(ack) === 0 && (reply.length === ack.length || /\s/.test(reply.charAt(ack.length)))) reply = reply.slice(ack.length).trim();
    var isFailed = receipt.status === 'rejected' || receipt.status === 'uncertain' && /TIMEOUT/.test(receipt.error);
    var labelKey = receipt.status === 'uncertain' && /TIMEOUT/.test(receipt.error)
      ? 'messagesTimeout'
      : receipt.status === 'accepted' && !receipt.isMailbox && receipt.error === 'DISCONNECTED'
        ? 'messagesAcceptedDisconnected'
        : labels[receipt.status];
    var line = el('p', 'receipt' + (isFailed ? ' t-alert' : ''), w(labelKey) + (reply ? ' · ' + reply : ''));
    line.setAttribute('role', isFailed ? 'alert' : 'status');
    var last = key && sentLast[key];
    if (!isFailed || !last) return line;
    return add(el('div', 'receipt-box'), line, add(el('div', 'acts'), button(w('serveRetry'), function () { last.again(); }), button(w('serveCopyMessage'), function () { copy(last.text, key); }, '', true)));
  }
  // The one reply box, on a card and in an open task: send modes go to the session (nativeAct or act), the rest copy.
  // extras.onCancel adds a Cancel button; extras.onDone(text) runs once the text was sent or copied.
  function replyBox(key, placeholder, mode, agent, where, isSending, session, asked, fp, delivery, extras) {
    var done = extras && extras.onDone;
    var box = el('div', 'composer');
    var input = el('textarea');
    input.rows = 2;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    // A draft belongs to its session and its question: a redraw that puts another session's
    // line under the same key starts an empty box, so the text is never sent to that session.
    input.setAttribute('data-key', [key, session || '', asked || '', delivery ? delivery.id + ':' + delivery.turn : ''].join('\u0001'));
    var draftKey = input.getAttribute('data-key');
    // Cursor ignores what a hook gives it at a prompt, so its mailbox waits for the chat to open.
    var isOpenOnly = String(agent).toLowerCase() === 'cursor';
    var go = mode === 'send' || mode === 'connected' || mode === 'mailbox'
      ? button(w(mode === 'mailbox' ? (isOpenOnly ? 'serveQueueNextOpen' : 'serveQueueNextTurn') : 'serveSend', mode === 'connected' && (!agent || String(agent).toLowerCase() === 'claude') ? 'Claude' : agentName(agent)), function () {
        var text = input.value.trim();
        if (!text) { say(w('pressEmpty'), 'alert', key); return; }
        // The same text goes again through the same path; the box keeps it until it was sent.
        var run = function () {
          var sent = mode === 'connected' || mode === 'mailbox' ? nativeAct(key, text, delivery, session, asked, fp, go) : act(key, 'send', text, w('serveSending', agentName(agent)), session, asked, fp, go);
          return sent.then(function (ok) { if (ok) { clearDraft(draftKey); if (done) done(text); } return ok; });
        };
        sentLast[key] = { text: text, again: run };
        run();
      }, 'primary')
      : button(w('pgCopyAnswer'), function () {
        var text = input.value.trim();
        if (text) copy(text, key, done ? function () { done(text); } : undefined);
        else say(w('pressEmpty'), 'alert', key);
      }, 'primary', true);
    go.disabled = isSending === true;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click(); }
    });
    var footer = el('div', 'cf');
    if (isSending === true && mode !== 'mailbox' && !results[key] && !(mode === 'connected' && (!agent || String(agent).toLowerCase() === 'claude'))) add(box, el('p', 'receipt', w('serveSendBusy', agentName(agent))));
    if (where) add(footer, el('div', 'where', where));
    if (extras && extras.onCancel) add(footer, navButton(w('pgCancel'), extras.onCancel));
    add(box, input, add(footer, go));
    if (mode === 'mailbox') {
      add(footer, button(w('pgCopyAnswer'), function () {
        var text = input.value.trim();
        if (text) copy(text, key); else say(w('pressEmpty'), 'alert', key);
      }, '', true));
      add(box, el('p', 'where', w(isOpenOnly ? 'serveNextOpenHint' : 'serveNextTurnHint')));
    }
    return box;
  }
  // A text shows as one line, cut to the width it has with an ellipsis (the style does that);
  // pressing it, or Enter on it, opens the whole text in its place. An open one stays open across
  // a redraw (opened[ref]). The short text is the folded, capped copy when the model sent one.
  function clipped(short, whole, cls, ref) {
    var box = el('details', 'clip ' + cls);
    box.open = opened[ref] === true;
    box.addEventListener('toggle', function () { opened[ref] = box.open; });
    add(box, add(el('summary'), el('span', 'short', short || whole), el('span', 'whole', whole)));
    return box;
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
  var pg = { filter: '', project: '', view: 'all', chips: Object.create(null), sideChips: Object.create(null), projectNodes: Object.create(null), openShelf: {}, sentBy: Object.create(null), sentTotal: 0, ids: [], model: null, sources: {}, order: {}, lis: [], groups: [], drafts: {}, shown: {}, nodes: {}, items: {}, hasOlder: false, mores: [], cardNodes: {}, cardList: null, rowKeys: {} };
  var cardState = {};
  var cardParts = {};
  // The first screen describes work, so diagnostic identifiers and logs stay out of its labels.
  function clean(value) {
    var text = String(value || '').trim();
    if (/^[{[]/.test(text)) {
      try {
        var data = JSON.parse(text);
        text = typeof data === 'string' ? data : ['text', 'message', 'summary', 'content', 'reply'].map(function (key) { return data && data[key]; }).find(function (one) { return typeof one === 'string'; }) || w('pgUnreadableReply');
      } catch (e) {}
    }
    return Array.from(text.replace(/\{\s*"[^"\n]*"\s*:[\s\S]*/g, '…')
      .replace(/\b[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{0,12}/gi, '…')
      .replace(/\bsession\s*[=:]\s*[\da-f]{8,}/gi, '…')
      .replace(/\b[\da-f]{7,}\b/gi, function (one) { return one.length === 40 || /\d/.test(one) && /[a-f]/i.test(one) ? '…' : one; })
      .replace(/(?:[A-Z]:[\\/]|\/(?:Users|home)\/)[^\s<>"'\x60|]*/gi, '…')
      .replace(/#\d+\b/g, '').replace(/\s+/g, ' ').trim()).slice(0, 220).join('');
  }
  function source(ref) { return pg.sources[ref.sourceKey || ref.key] || pg.sources[ref.key.replace(/^stuck:/, '')] || {}; }
  function fullTitle(ref) { var one = source(ref); return String(one.title || one.task || one.text || ''); }
  // A row with a due date and no age (a hand-kept task) shows the date where the age would be; an
  // agent's row keeps its age, so how fresh its status is stays on the row.
  function dueOf(ref) { var one = source(ref); return one.when ? '' : clean(one.due || ''); }
  function ageOf(ref) { return clean(source(ref).when || w('pgUnknownAge')); }
  // 'own' for the person's hand-kept tasks, '?' for a finished task whose agent the model did not say.
  function agentOf(ref) { return source(ref).isOwn || ref.isOwn ? 'own' : ref.agent || '?'; }
  function markOf(ref) {
    var id = agentOf(ref);
    return agentMark(id === 'own' ? '' : id === '?' ? '?' : ref.agent);
  }
  // isSameName in view.ts: a row whose title is its project's name names it once (#612).
  function sameName(project, title) {
    var key = function (name) { return String(name || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); };
    return key(project) !== '' && key(project) === key(title);
  }
  // An agent that waits on the person, or stopped a moment ago, is not "nothing" (#612).
  function quietLine(quiet, now) {
    if (quiet && quiet.kind === 'asking') return w('pgQuietAsking', quiet.n);
    if (quiet && quiet.kind === 'stopped') return w('pgQuietStopped', agentName(quiet.agent), Math.max(1, Math.round((now - quiet.at) / 60000)));
    return w('pgNoWorking');
  }
  function nameOf(id) { return id === 'own' ? w('pgOwn') : agentName(id); }
  // The project a card or a row belongs to, as the page names it.
  function projectOf(ref) { return clean(ref.repo || source(ref).project || ''); }
  // The agent filter (icon row or sidebar) and the project filter (sidebar) both apply; either may be empty.
  function matchesAgent(id) { return !pg.filter || pg.filter === id; }
  function matches(id, project) { return matchesAgent(id) && (!pg.project || pg.project === project); }
  // A sent answer is on its way: its card stays on the sheet with its line, but it no longer waits for the person.
  // A message that timed out or was refused waits for the person again.
  function isSent(ref) {
    var one = source(ref);
    var receipt = one.receipt;
    var isFailed = !!receipt && (receipt.status === 'rejected' || receipt.status === 'uncertain' && /TIMEOUT/.test(receipt.error || ''));
    return one.isSending === true && !isFailed;
  }
  function byTime(a, b) { return (b.at || 0) - (a.at || 0); }
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
  // A card answers in place: its question and answers (ask), the box for its own words (write), then one line
  // saying what happened (copied or sent). The mode outlives a redraw; the parts slide when it changes.
  function paintMode(key) {
    var parts = cardParts[key];
    var state = cardState[key] || { mode: 'ask', text: '' };
    if (!parts) return;
    reveal(parts.ask, state.mode === 'ask');
    reveal(parts.reply, state.mode === 'write');
    var isAfter = state.mode === 'copied' || state.mode === 'sent' || state.mode === 'queued';
    reveal(parts.after, isAfter);
    if (!isAfter) return;
    parts.msg.textContent = state.mode === 'queued' ? w('messagesQueued') : state.mode === 'sent' ? w('pgSentTo', agentName(parts.agent), state.text) : parts.canHide ? w(parts.late ? 'pgPasteLater' : 'pgPasteIn', state.text, agentName(parts.agent)) : w('copied');
    parts.answered.hidden = !parts.canHide;
    parts.answered.textContent = w(state.mode === 'copied' ? 'pgAnswered' : 'answeredHide');
    parts.again.hidden = state.mode !== 'copied';
  }
  function setMode(key, mode, text) {
    var previous = cardState[key];
    cardState[key] = { mode: mode, text: text === undefined ? previous ? previous.text : '' : text };
    paintMode(key);
    if (mode === 'write') {
      var parts = cardParts[key];
      var box = parts && parts.reply.querySelector('textarea');
      if (box) { if (moving()) setTimeout(function () { box.focus({ preventScroll: true }); }, 120); else box.focus({ preventScroll: true }); }
    }
  }
  function stepList(steps, row) {
    var list = el('ol', 'steps');
    steps.forEach(function (step) {
      var line = el('li', step.isCurrent ? 'now' : '');
      var whole = step.note ? step.text + ' — ' + step.note : step.text;
      var cls = 't' + (step.status === 'done' || step.status === 'cancelled' ? ' t-quiet' : '');
      add(line, el('span', 'mk s-' + step.status, GLYPH[step.status] || '•'), clipped(clean(step.line || whole), whole, cls, 'step:' + row.key + ':' + row.steps.indexOf(step)));
      // The next step's Done button is the primary one in the actions row, so the step list
      // does not tick it again: each step has exactly one Done button. Steps are told apart
      // by the file line they came from, so two open steps with the same text each keep one;
      // a step with no line (a folded summary) falls back to its text.
      var isNext = step.fileLine !== undefined ? step.fileLine === row.nextFileLine : step.text === row.next;
      if (row.isOwn && step.status !== 'done' && step.status !== 'cancelled' && !isNext) {
        // The page's button, as Confirm done and Copy; the label sits in a span so one line can end in an ellipsis.
        var tick = button('', function () { act(row.key, 'tick', step.text, '', '', '', row.fp, undefined, step.fileLine); }, 'btn');
        add(tick, el('span', '', w('serveTickNext', clean(step.text))));
        tick.title = step.text;
        add(line, tick);
      }
      add(list, line);
    });
    return list;
  }
  function plural(key, n) { return w(n === 1 ? key + 'One' : key, n); }
  function folded(label, list) {
    var box = el('details');
    return add(box, el('summary', '', label), list);
  }
  function sends(mode) { return mode === 'send' || mode === 'connected' || mode === 'mailbox'; }
  // One question or stuck task on the Needs you sheet, answerable where it is.
  // isOlder: a question kept for review (its chat has stopped): nothing to answer here, only to hide once answered.
  function buildCard(ref, isOlder) {
    var ask = source(ref);
    var isStuck = ref.kind === 'stuck';
    var key = ask.key || ref.key;
    var id = agentOf(ref);
    var agent = ref.agent;
    var card = el('article', 'card');
    card.setAttribute('data-ref-key', ref.key);
    add(card, markOf(ref));
    var body = el('div', 'c-body');
    var project = clean(ref.repo || ask.project);
    add(body, add(el('div', 'c-meta'), el('span', 'who', id === 'own' ? w('pgOwnTodo') : agentName(agent)), project ? el('span', '', project) : null, el('span', '', ageOf(ref))));
    var text = clean(isStuck ? ask.title : ask.text);
    var question = el('p', 'q', text);
    question.setAttribute('title', text);
    add(body, question);
    if (isStuck) add(body, el('p', 'note', clean(ask.stuck && ask.stuck.reason)));
    else if (ask.note) add(body, clipped(clean(ask.noteLine || ask.note), ask.note, 'note', 'note:' + key));
    else if (ask.context) add(body, clipped(clean(ask.contextLine || ask.context), ask.context, 'context', 'context:' + key));
    if (!isStuck && !isOlder && ask.command) add(body, el('code', '', '$ ' + ask.command));
    var mode = ask.send;
    var answers = el('div', 'answers');
    var others = [];
    var canWrite = false;
    if (isStuck) {
      if (ask.resume) add(answers, button(w('serveCopyResume'), function () { copy(ask.resume, key); }, '', true));
    } else if (isOlder) {
      if (ask.canHide) add(answers, button(w('answeredHide'), function () { hideQuestion(key, ask.unhideKey); }));
      else add(body, el('p', 'note', w('questionReviewOnly')));
    } else if (ask.native) {
      // Answered in the agent's own window: the options are only listed, so no button, reply box or copy is offered.
      if (ask.native.options.length) {
        var choices = el('ul', 'native-options');
        ask.native.options.forEach(function (option) { add(choices, el('li', '', clean(option))); });
        add(body, choices);
      }
      add(body, el('p', 'note', ask.native.line));
      if (ask.canHide) add(answers, button(w('answeredHide'), function () { hideQuestion(key, ask.unhideKey); }));
    } else if (ask.isOwn) {
      if (ask.canTick) add(answers, button(w('pgDone'), function () { act(key, 'tick', '', '', '', '', ask.fp); }, 'primary'));
    } else {
      var options = ask.answers || [];
      canWrite = true;
      options.slice(0, 3).forEach(function (answer, index) {
        var node = button(w(sends(mode) ? 'pgSendReply' : 'pgCopyReply', clean(answer)), function () { pressAnswer(ask, key, answer, node); }, '', !sends(mode));
        node.disabled = sends(mode) && ask.isSending === true;
        add(answers, node);
      });
      options.slice(3).forEach(function (answer) { others.push(button(w(sends(mode) ? 'pgSendReply' : 'pgCopyReply', clean(answer)), function () { pressAnswer(ask, key, answer, null); }, '', !sends(mode))); });
      if (ask.command) others.push(button(w('serveCopyCommand'), function () { copy(ask.command, key); }, '', true));
      if (ask.link && /^https:\/\//i.test(ask.link)) {
        var link = el('a', 'btn', w('serveOpenLink'));
        link.href = ask.link;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        others.push(link);
      }
      if (ask.reopen) others.push(button(w('serveCopyResume'), function () { copy(ask.reopen, key); }, '', true));
      if (ask.canHide) others.push(button(w('answeredHide'), function () { hideQuestion(key, ask.unhideKey); }));
    }
    var parts = { agent: agent, canHide: ask.canHide === true, late: lateWord(agentPresence[id]) !== '' };
    cardParts[key] = parts;
    var askBlock = el('div');
    add(askBlock, answers);
    if (others.length) {
      var more = el('div', 'more' + (opened['more:' + key] ? ' open' : ''));
      var fold = el('div', 'fold');
      fold.inert = !opened['more:' + key];
      add(more, add(fold, add(el('div', 'fold-in'), add.apply(null, [el('div', 'acts')].concat(others)))));
      var toggle = navButton(w('serveMore'), function () {
        var isOpen = !hasClass(more, 'open');
        toggleClass(more, 'open', isOpen);
        fold.inert = !isOpen;
        toggle.setAttribute('aria-expanded', String(isOpen));
        opened['more:' + key] = isOpen;
      });
      toggle.className = 'quiet';
      pg.mores.push({ key: key, box: more, fold: fold, toggle: toggle });
      toggle.setAttribute('aria-expanded', String(opened['more:' + key] === true));
      add(answers, toggle);
      add(askBlock, more);
    }
    if (canWrite) {
      var write = navButton(w('pgWriteOwn'), function () { setMode(key, 'write'); });
      write.className = 'quiet';
      add(answers, write);
    }
    parts.ask = fx(askBlock);
    if (canWrite) {
      parts.reply = fx(replyBox(key, w('serveReplyPlaceholder'), sends(mode) ? mode : 'copy', agent, sends(mode) ? ask.where : '', ask.isSending, ask.session, ask.text, ask.fp, ask.delivery, {
        onCancel: function () { setMode(key, 'ask'); },
        onDone: function (value) { setMode(key, mode === 'mailbox' ? 'queued' : sends(mode) ? 'sent' : 'copied', value); },
      }), false);
    } else parts.reply = fx(el('div'), false);
    var after = el('div', 'state');
    after.setAttribute('role', 'status');
    parts.msg = el('span', 'msg ok');
    parts.answered = button(w('pgAnswered'), function () { hideQuestion(key, ask.unhideKey); }, 'primary');
    parts.again = button(w('pgCopyAgain'), function () {
      var state = cardState[key];
      if (state) copy(state.text, key);
    }, 'quiet', true);
    add(after, add(el('span', 'mk ok', '✓')), parts.msg, parts.answered, parts.again);
    parts.after = fx(after, false);
    add(body, parts.ask, parts.reply, parts.after);
    paintMode(key);
    if (ask.receipt) add(body, receiptLine(ask.receipt, key, ask.agent, !!ask.delivery));
    resultSlot(body, key, ask.fp || ask.text, ask.task || ask.title || ref.repo);
    add(card, body);
    return card;
  }
  function pressAnswer(ask, key, answer, node) {
    var mode = ask.send;
    if (mode !== 'connected' && mode !== 'mailbox' && mode !== 'send') { copy(answer, key, function () { setMode(key, 'copied', answer); }); return; }
    var run = function () {
      var sent = mode === 'connected' || mode === 'mailbox' ? nativeAct(key, answer, ask.delivery, ask.session, ask.text, ask.fp, node || el('button')) : act(key, 'send', answer, w('serveSending', agentName(ask.agent)), ask.session, ask.text, ask.fp, node);
      return sent.then(function (ok) { if (ok) setMode(key, mode === 'mailbox' ? 'queued' : 'sent', answer); return ok; });
    };
    sentLast[key] = { text: answer, again: run };
    run();
  }
  // A task as one row: its mark, title, one line (the step, with the project where no heading stands above it,
  // and a status word only when the section does not already say it) and its age. Pressing it opens its steps and
  // actions in place; the message box for a connected or sendable session is inside the open row.
  // The progress bar (#1085): one cell per step up to 12, above that one fill with a mark at the
  // current step, "n/m" beside it. One step: the text alone. The bar is aria-hidden; the label says it.
  var BAR_CELLS = { x: 'c-x', '~': 'c-c', '?': 'c-w', '!': 'c-b', '>': 'c-r', ' ': 'c-t', '-': 'c-n' };
  function progressNode(code, done, total, step) {
    var node = el('span', 'prog');
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', step ? w('pgBarLabel', done + '/' + total, step) : done + '/' + total);
    var cells = String(code).split('');
    if (cells.length > 1 && cells.length <= 12) {
      var bar = el('span', 'pbar');
      cells.forEach(function (one) { add(bar, el('i', BAR_CELLS[one] || 'c-t')); });
      bar.setAttribute('aria-hidden', 'true');
      add(node, bar);
    } else if (cells.length > 12) {
      var counted = cells.filter(function (one) { return one !== '-'; });
      var open = -1;
      counted.some(function (one, index) { if (one !== 'x') { open = index; return true; } return false; });
      var finished = counted.filter(function (one) { return one === 'x'; }).length;
      var track = el('span', 'pbar cont');
      var fill = el('b');
      fill.style.width = (counted.length ? Math.round(finished / counted.length * 1000) / 10 : 0) + '%';
      add(track, fill);
      if (open >= 0) {
        var mark = el('u', BAR_CELLS[counted[open]] === 'c-t' ? 'c-c' : BAR_CELLS[counted[open]] || 'c-c');
        mark.style.left = 'calc(' + Math.round(open / counted.length * 1000) / 10 + '% - 1px)';
        add(track, mark);
      }
      track.setAttribute('aria-hidden', 'true');
      add(node, track);
    }
    var count = el('span', 'pcount', done + '/' + total);
    count.setAttribute('aria-hidden', 'true');
    add(node, count);
    return node;
  }
  function buildRow(ref, section, showProject) {
    var row = source(ref);
    var key = row.key || ref.key;
    var isTask = Array.isArray(row.steps);
    var steps = row.steps || [];
    var inner = el('div', 'row-open');
    var isOpen = opened[ref.key] === true;
    var acts = el('div', 'acts');
    if (isTask) {
      if (row.context) add(inner, clipped(clean(row.contextLine || row.context), row.context, 'context', 'context:' + key));
      if (row.pr) add(inner, el('p', 'context', row.pr));
      var completed = steps.filter(function (one) { return one.status === 'done' || one.status === 'cancelled'; });
      if (completed.length) add(inner, folded(plural('pgDoneSteps', completed.length), stepList(completed, row)));
      var left = steps.filter(function (one) { return one.status !== 'done' && one.status !== 'cancelled' && one.status !== 'waiting'; });
      var primary = left.find(function (one) { return one.isCurrent; }) || left[0];
      if (primary) add(inner, stepList([primary], row));
      var rest = left.filter(function (one) { return one !== primary; });
      if (rest.length) add(inner, folded(plural('pgMoreSteps', rest.length), stepList(rest, row)));
      if (row.handoff) add(inner, el('p', 'context', row.handoff));
      if (row.runs) add(inner, el('p', 'context', row.runs));
      if (sends(row.send)) add(inner, replyBox(row.key, w('serveMessagePlaceholder', agentName(row.agent)), row.send, row.agent, row.where, row.isSending, row.session, row.question, row.fp, row.delivery));
      else if (row.hasCopyBox) add(inner, replyBox(row.key, w('serveReplyPlaceholder'), 'copy', row.agent, '', false, row.session, row.question));
      if (row.isOwn && section !== 'done' && row.next) {
        // The press names the next step by its file line and its shown text, the same way
        // the step list names a step, so the server can tell it from a twin with the same text.
        var nextStep = null;
        for (var index = 0; index < row.steps.length; index += 1) if (row.nextFileLine !== undefined && row.steps[index].fileLine === row.nextFileLine) { nextStep = row.steps[index]; break; }
        var tickNext = button(w('serveTickNext', clean(row.nextLabel || row.next)), function () { act(key, 'tick', nextStep ? nextStep.text : row.next, '', '', '', row.fp, undefined, row.nextFileLine); }, 'primary');
        // A long step is named by its first words; the whole step is its title (#463).
        if (row.nextLabel) tickNext.title = row.next;
        add(acts, tickNext);
      }
      if (row.resume && !row.isOwn) add(acts, button(w('serveCopyResume'), function () { copy(row.resume, key); }, '', true));
      // A task still running keeps its Archive button; the board refuses and the line says why only after it is pressed.
      if (row.canArchive || row.archiveNote) add(acts, button(w('serveArchive'), function () { act(key, 'archive', '', '', '', '', row.fp); }));
      if (row.canConfirm && section !== 'done') add(acts, button(w('confirmDone'), function () { act(key, 'done', '', '', '', '', row.fp); }));
      if (acts.firstChild) add(inner, acts);
      if (row.receipt) add(inner, receiptLine(row.receipt, key, row.agent, !!row.delivery));
      if (row.info) add(inner, el('p', 'context', row.info));
    } else {
      (row.questions || []).forEach(function (question) { add(inner, el('p', 'context', clean(question))); });
      if (row.canArchive || row.archiveNote) add(acts, button(w('serveArchive'), function () { act(key, 'archive', '', '', '', '', row.fp); }));
      if (acts.firstChild) add(inner, acts);
    }
    var isExpandable = inner.childNodes.length > 0;
    if (isExpandable) resultSlot(inner, key, row.fp, row.title || row.task);
    var current = steps.filter(function (one) { return one.isCurrent; })[0] || steps.filter(function (one) { return one.status !== 'done' && one.status !== 'cancelled'; })[0];
    var step = current ? clean(current.text) : '';
    // "Last:" names the last finished step, not the next one: a task with nothing finished yet shows no Last: line.
    var lastDone = steps.filter(function (one) { return one.status === 'done' || one.status === 'cancelled'; });
    var lastFinished = lastDone.length ? clean(lastDone[lastDone.length - 1].text) : '';
    // A plan-tool block with no title takes its current step as the title; the step is then said once.
    if (sameName(step, clean(fullTitle(ref)))) step = '';
    var detail = section === 'others' ? (lastFinished ? w('pgLast', lastFinished) : '') : !step ? '' : section === 'working' ? step : section === 'stopped' ? w('pgStoppedAt', step) : '';
    var status = ref.kind === 'stuck' || row.stuck ? w('pgStuck') : row.isOwn && section !== 'done' && section !== 'stopped' ? w('pgTodo') : '';
    var title = clean(fullTitle(ref));
    var project = showProject ? clean(ref.repo || row.project) : '';
    if (sameName(project, title)) project = '';
    var progress = isTask && row.total > 0 && (section === 'working' || section === 'stopped' || section === 'others') ? progressNode(row.cells || '', row.done, row.total, current ? clean(current.text) : '') : null;
    var meta = add(el('span', 'r-meta'), progress, status ? el('span', 'st', status) : null, project ? el('span', '', project) : null, detail ? el('span', '', detail) : null);
    var titleNode = el('span', 'r-title', title);
    titleNode.setAttribute('title', title);
    var li = el('li', 'row' + (isOpen && isExpandable ? ' open' : ''));
    li.setAttribute('data-k', ref.key);
    var fold = el('div', 'fold');
    fold.inert = !isOpen;
    add(fold, add(el('div', 'fold-in'), inner));
    var head = isExpandable ? navButton('', function () {
      var now = !hasClass(li, 'open');
      toggleClass(li, 'open', now);
      head.setAttribute('aria-expanded', String(now));
      fold.inert = !now;
      opened[ref.key] = now;
    }) : el('div');
    head.className = 'row-btn';
    if (isExpandable) head.setAttribute('aria-expanded', String(isOpen));
    add(head, markOf(ref), add(el('span', 'r-text'), titleNode, meta), el('span', 'r-right' + (dueOf(ref) && source(ref).dueTone === 'alert' ? ' t-alert' : ''), dueOf(ref) || ageOf(ref)), el('span', 'r-chev'));
    var block = el('div', 'fx');
    add(block, add(el('div', 'fx-in'), head, isExpandable ? fold : null));
    add(li, block);
    return { li: li, block: block };
  }
  function setText(node, text) { if (node && node.textContent !== String(text)) node.textContent = String(text); }
  // The pieces of the agent row: one icon button per agent on the board and one for the person's own to-dos.
  // Whether an agent can be reached from here, from what the model already holds. connected: a session of it has a
  // delivery connection. open: a session is open in its own window or in the pane, or it worked in the last 30
  // minutes without an ended session. offline: the board can tell its sessions are closed (a line whose session ended) and
  // none is open.
  // notseen: the board cannot tell (it has no line of that agent that says either). An agent that reported in the
  // last 30 minutes is open unless its newest line closed the session: a waiting turn next to an older ended session stays open (#587, #616).
  function presenceMap(view) {
    var map = {};
    pg.ids.forEach(function (id) {
      var group = view.agents.filter(function (one) { return one.agent === id; })[0];
      var isWorking = view.working.some(function (ref) { return agentOf(ref) === id; });
      var isRecent = !!group && group.last > 0 && view.now - group.last <= 30 * 60 * 1000;
      var isOpen = isWorking;
      var isClosed = false;
      var closedAt = 0;
      Object.keys(pg.sources).forEach(function (key) {
        var one = pg.sources[key];
        if (!one || one.isOwn || String(one.agent || 'claude').toLowerCase() !== id) return;
        var at = Number(one.at) || 0;
        if (one.isClosed === true || one.state === 'ended') {
          isClosed = true;
          if (at > closedAt) closedAt = at;
        } else if (one.send === 'open' || one.send === 'claude' || one.send === 'connected' || one.send === 'mailbox') {
          isOpen = true;
        }
      });
      var closedIsNewest = isClosed && (closedAt >= (group ? group.last : 0) || !isRecent);
      if (!isOpen && isRecent && !closedIsNewest) isOpen = true;
      var isConnected = connections.some(function (one) { return String(one.agent || '').toLowerCase() === id; });
      map[id] = isConnected ? 'connected' : isOpen ? 'open' : isClosed ? 'offline' : 'notseen';
    });
    return map;
  }
  // The word when the board cannot reach the agent: closed, or not heard from in the last 30 minutes.
  function lateWord(state) { return state === 'offline' ? w('pgOffline') : state === 'notseen' ? w('pgNotSeen') : ''; }
  // An agent's icon keeps its colours in every state, so the state is this word and the mark beside the icon (#870).
  function stateWord(entry) {
    if (entry.working > 0) return w('pgTipWorking');
    return entry.presence === 'open' || entry.presence === 'connected' ? w('pgStateOpen') : lateWord(entry.presence);
  }
  function chipLabel(entry) {
    var parts = [];
    if (entry.needs === 1) parts.push(w('pgTipNeedsOne'));
    else if (entry.needs > 1) parts.push(w('pgTipNeeds', entry.needs));
    if (entry.id === 'own' && entry.open > 0) {
      if (entry.open === 1) parts.push(w('pgTipOpenOne'));
      else parts.push(w('pgTipOpen', entry.open));
    }
    if (entry.unreadable) parts.push(w('pgTipCantRead'));
    var state = stateWord(entry);
    if (entry.working > 0 && !parts.length) return entry.name + ' · ' + state;
    return entry.name + (state ? ' · ' + state : '') + ': ' + (parts.length ? parts.join(', ') : w('pgChipEmpty'));
  }
  // One button per agent, twice: in the icon row (phones) and in the sidebar (the rail and wider). Same label, count, dot and filter.
  function newChip(entry, isSide) {
    var node = navButton('', function () { setFilter(pg.filter === entry.id ? '' : entry.id); });
    node.setAttribute('data-agent', entry.id);
    var chip = { node: node, name: el('span', isSide ? 's-txt' : 'c-name'), badge: null, isSide: isSide };
    add(node, agentMark(entry.agent), chip.name);
    return chip;
  }
  function paintChip(chip, entry, label) {
    chip.node.setAttribute('aria-label', label);
    chip.node.setAttribute('title', label);
    chip.node.className = (chip.isSide ? 's-item s-agent' : 'chip') + (entry.working > 0 ? ' working' : '');
    if (entry.presence) chip.node.setAttribute('data-presence', entry.presence);
    setText(chip.name, stateWord(entry) ? entry.name + ' · ' + stateWord(entry) : entry.name);
    var text = entry.unreadable ? '!' : entry.needs > 0 ? String(entry.needs) : '';
    if (text && !chip.badge) { chip.badge = el('span', 'badge'); chip.node.appendChild(chip.badge); }
    if (!text && chip.badge) { chip.node.removeChild(chip.badge); chip.badge = null; }
    if (chip.badge) { setText(chip.badge, text); chip.badge.className = 'badge' + (entry.unreadable ? ' bad' : ''); }
    chip.unreadable = entry.unreadable;
    chip.title = entry.name;
  }
  function drawChips(view) {
    var nav = document.getElementById('agents');
    var row = document.getElementById('chips');
    var sideList = document.getElementById('side-agents');
    var sideGroup = document.getElementById('side-agent-group');
    var entries = [];
    // A sent answer no longer waits for the person, so it leaves the count on its agent's badge.
    var waiting = function (count, id) { return Math.max(0, count - (pg.sentBy[id] || 0)); };
    // Your to-dos come first, before every agent; the agents follow in their usual order.
    if (Object.keys(view.own.counts).some(function (key) { return view.own.counts[key] > 0; })) entries.push({ id: 'own', name: w('pgOwn'), agent: '', needs: waiting(view.own.counts.needs, 'own'), open: view.own.open.length, working: 0, unreadable: false });
    pg.ids.forEach(function (id) {
      var group = view.agents.filter(function (one) { return one.agent === id; })[0];
      if (!group) return;
      entries.push({ id: id, name: agentName(id), agent: id, needs: waiting(group.counts.needs, id), working: view.working.filter(function (ref) { return agentOf(ref) === id; }).length, unreadable: group.isUnreadable, presence: agentPresence[id] });
    });
    if (pg.filter && !entries.some(function (one) { return one.id === pg.filter; })) pg.filter = '';
    nav.hidden = entries.length === 0;
    if (sideGroup) sideGroup.hidden = entries.length === 0;
    var ids = entries.map(function (one) { return one.id; });
    [pg.chips, pg.sideChips].forEach(function (set) {
      Object.keys(set).forEach(function (id) {
        if (ids.indexOf(id) === -1) { set[id].node.remove(); delete set[id]; }
      });
    });
    entries.forEach(function (entry) {
      var label = chipLabel(entry);
      [[pg.chips, row, false], [pg.sideChips, sideList, true]].forEach(function (pair) {
        var chip = pair[0][entry.id];
        if (!chip) {
          chip = pair[0][entry.id] = newChip(entry, pair[2]);
          if (entry.id === 'own' && pair[1].firstChild) pair[1].insertBefore(chip.node, pair[1].firstChild);
          else add(pair[1], chip.node);
        }
        paintChip(chip, entry, label);
      });
    });
    paintFilter();
    drawNote(entries);
    fadeChips();
  }
  function paintFilter() {
    [pg.chips, pg.sideChips].forEach(function (set) {
      Object.keys(set).forEach(function (id) { set[id].node.setAttribute('aria-pressed', String(pg.filter === id)); });
    });
  }
  // A pressed icon widens to show its name; once it has, the row brings it into view and the edge fade is worked out again.
  function peekChip() {
    var chip = pg.filter && pg.chips[pg.filter];
    var settle = function () {
      if (chip && chip.node.scrollIntoView) chip.node.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: moving() ? 'smooth' : 'auto' });
      fadeChips();
    };
    if (moving()) setTimeout(settle, 280);
    else settle();
  }
  // The line under the row for an agent the board cannot read: while that agent is pressed, or for all of them when nothing is.
  // The away line: when the tab is hidden, the page records a snapshot of the world it
  // shows (the open questions by agent, the tasks already done, each agent's presence and
  // whether it can be read). When the tab is visible again after 5 minutes or more, the
  // next refresh compares the world with the snapshot and shows one line with what
  // changed. Nothing is kept across reloads, and the line never shows on the first load.
  // It never hides by itself: only the × on the line folds it away.
  var AWAY_MS = 5 * 60 * 1000;
  // An officer is an agent the board knows by name (its guarded name); any other agent is
  // counted but never named on the line.
  function isOfficer(id) { return Object.prototype.hasOwnProperty.call(W, 'agent:' + String(id).toLowerCase()); }
  // The agents that are unreadable or offline now, by id: 'unreadable' when the board
  // cannot read the agent, 'offline' when its sessions are closed and none is open.
  function awayBadNow() {
    var bad = {};
    var unreadable = {};
    latest.view.agents.forEach(function (one) { if (one.isUnreadable) unreadable[String(one.agent).toLowerCase()] = true; });
    Object.keys(agentPresence).forEach(function (id) {
      if (unreadable[id]) bad[id] = 'unreadable';
      else if (agentPresence[id] === 'offline') bad[id] = 'offline';
    });
    return bad;
  }
  function awaySnapshot() {
    if (!latest || !latest.view) return null;
    var questions = {};
    latest.view.needs.cards.forEach(function (ref) {
      var id = agentOf(ref);
      if (!questions[id]) questions[id] = {};
      questions[id][ref.key] = true;
    });
    var done = {};
    latest.view.all.done.concat(latest.view.own.done).forEach(function (ref) { done[ref.key] = true; });
    return { at: Date.now(), questions: questions, done: done, bad: awayBadNow() };
  }
  function awayDiff(snap) {
    if (!latest || !latest.view) return null;
    var view = latest.view;
    var seen = {};
    Object.keys(snap.questions).forEach(function (id) { Object.keys(snap.questions[id]).forEach(function (key) { seen[key] = true; }); });
    var questions = {};
    var newKeys = [];
    view.needs.cards.forEach(function (ref) {
      if (seen[ref.key]) return;
      var id = agentOf(ref);
      questions[id] = (questions[id] || 0) + 1;
      newKeys.push(ref.key);
    });
    // Finished tasks count within the current filter, and never name the task. Their keys
    // are kept so the Done list can light up the rows that finished while away.
    var finished = 0;
    var finishedKeys = [];
    view.all.done.concat(view.own.done).forEach(function (ref) {
      if (snap.done[ref.key]) return;
      if (!matches(agentOf(ref), projectOf(ref))) return;
      finished += 1;
      finishedKeys.push(ref.key);
    });
    // The line reports the agents that are unreadable or offline now, and shows for
    // presence only when that set changed. An agent coming online leaves the set, and
    // with nothing to name the line stays away.
    var bad = awayBadNow();
    var badKeys = Object.keys(bad).sort();
    var snapKeys = Object.keys(snap.bad).sort();
    var badChanged = badKeys.length !== snapKeys.length || badKeys.some(function (id, index) { return id !== snapKeys[index] || bad[id] !== snap.bad[id]; });
    return { questions: questions, newKeys: newKeys, finished: finished, finishedKeys: finishedKeys, bad: bad, badChanged: badChanged };
  }
  function awayParts(diff, minutes) {
    var segs = [{ text: minutes < 60 ? w('awayForMinutes', minutes) : w('awayForHours', Math.floor(minutes / 60)), bold: false }];
    var agents = Object.keys(diff.questions);
    var total = 0;
    agents.forEach(function (id) { total += diff.questions[id]; });
    if (agents.length === 1) {
      var id = agents[0];
      var n = diff.questions[id];
      if (isOfficer(id)) segs.push({ text: n === 1 ? w('awayAskedNamedOne', agentName(id)) : w('awayAskedNamed', agentName(id), n), bold: true });
      else segs.push({ text: n === 1 ? w('awayAskedGenericOne') : w('awayAskedGenericOneAgent', n), bold: true });
    } else if (agents.length > 1) segs.push({ text: w('awayAskedGeneric', agents.length, total), bold: true });
    if (diff.finished > 0) segs.push({ text: plural('awayFinished', diff.finished), bold: true, done: true });
    // Agents that can't be read or are offline: officers by name, any others counted.
    var badIds = Object.keys(diff.bad);
    if (badIds.length) {
      var named = [];
      var unreadable = 0;
      var offline = 0;
      badIds.forEach(function (id) {
        if (isOfficer(id)) named.push(diff.bad[id] === 'unreadable' ? w('awayUnreadableNamed', agentName(id)) : w('awayOfflineNamed', agentName(id)));
        else if (diff.bad[id] === 'unreadable') unreadable += 1;
        else offline += 1;
      });
      if (unreadable > 0) named.push(plural('awayUnreadable', unreadable));
      if (offline > 0) named.push(plural('awayOffline', offline));
      segs.push({ text: named.join(', '), bold: true });
    }
    return segs;
  }
  function clearAwayLine() {
    var box = document.getElementById('away-line');
    var inner = document.getElementById('away-line-in');
    if (inner) inner.textContent = '';
    if (box) box.hidden = true;
  }
  // The × folds the line away with the page's fold motion; the next return replaces it.
  function dismissAwayLine() {
    var box = document.getElementById('away-line');
    if (!box) return;
    reveal(box, false, function () { clearAwayLine(); });
  }
  // The finished part opens the Done list: Overview first, then the list, scrolled into
  // view, with the rows that finished while away lit with the arrive glow.
  function openDoneFromAway(keys) {
    if (pg.view !== 'all') setView('all');
    if (pg.openShelf.done) pg.openShelf.done(true);
    if (moving()) (keys || []).forEach(function (key) {
      pg.lis.forEach(function (one) {
        if (one.list === 'done' && one.key === key) toggleClass(one.li, 'arrived', true);
      });
    });
    var done = pg.sections.filter(function (one) { return one.list === 'done'; })[0];
    if (done && done.block && typeof done.block.scrollIntoView === 'function') done.block.scrollIntoView();
  }
  function showAway(segs, diff) {
    var box = document.getElementById('away-line');
    var inner = document.getElementById('away-line-in');
    if (!box || !inner) return;
    inner.textContent = '';
    box.setAttribute('title', segs.map(function (seg) { return seg.text; }).join(' · '));
    segs.forEach(function (seg, index) {
      // The separator lives inside the part's own span, so it ends a line and never starts one.
      var wrap = el('span', 'away-seg' + (seg.bold ? ' away-bold' : ' away-lead'));
      if (seg.done) add(wrap, button(seg.text, function () { openDoneFromAway(diff.finishedKeys); }, 'link', true, true));
      else add(wrap, document.createTextNode(seg.text));
      if (index < segs.length - 1) add(wrap, document.createTextNode(' · '));
      add(inner, wrap);
    });
    var close = button('', dismissAwayLine, 'away-x', true, true);
    close.setAttribute('aria-label', w('awayDismiss'));
    close.setAttribute('title', w('awayDismiss'));
    add(inner, close);
    box.hidden = false;
    reveal(box, true);
  }
  function maybeShowAway() {
    if (!awaySnap) return;
    // A background poll can run while the tab is hidden; the snapshot is only for the return, so leave it alone until the tab is visible again.
    if (document.hidden) return;
    var snap = awaySnap;
    awaySnap = null;
    if (Date.now() - snap.at < AWAY_MS) { clearAwayLine(); return; }
    var minutes = Math.floor((Date.now() - snap.at) / 60000);
    var diff = awayDiff(snap);
    var hasChange = !!diff && (Object.keys(diff.questions).length > 0 || diff.finished > 0 || (Object.keys(diff.bad).length > 0 && diff.badChanged));
    if (!hasChange) { clearAwayLine(); return; }
    showAway(awayParts(diff, minutes), diff);
    // New question cards get the arrive glow once.
    if (moving()) diff.newKeys.forEach(function (key) {
      var li = pg.cardNodes[key];
      if (li) toggleClass(li, 'arrived', true);
    });
  }
  function drawNote(entries) {
    var box = document.getElementById('agent-note');
    var shown = entries.filter(function (one) { return one.unreadable && (!pg.filter || pg.filter === one.id); });
    var signature = JSON.stringify(shown.map(function (one) { return one.id; }));
    if (box.getAttribute('data-sig') === signature) return;
    box.setAttribute('data-sig', signature);
    box.textContent = '';
    shown.forEach(function (one) {
      var how = el('details');
      add(how, el('summary', '', w('pgHowFix')), el('p', '', w('pgFixAdvice')));
      add(box, add(el('div'), el('p', '', w('pgUnreadable', one.name)), how));
    });
  }
  function setFilter(id) {
    pg.filter = id;
    saveFilter(id);
    paintFilter();
    if (latest && latest.view) drawNote(chipEntries(latest.view));
    layout();
    peekChip();
  }
  function chipEntries(view) {
    var entries = [];
    pg.ids.forEach(function (id) {
      var group = view.agents.filter(function (one) { return one.agent === id; })[0];
      if (group) entries.push({ id: id, name: agentName(id), unreadable: group.isUnreadable });
    });
    return entries;
  }
  // What the filter shows: rows, cards and shelves of that agent only; the rest closes up. Counts, empty
  // lines and headings follow what is left, so every number on the page agrees with what is shown.
  function layout() {
    var count = { cards: 0, shown: 0, older: 0, working: 0, others: 0, stopped: 0, done: 0 };
    var projects = [];
    var byProject = Object.create(null);
    pg.lis.forEach(function (one) {
      one.show = matches(one.id, one.project);
      if (one.show) {
        // cards: the number that waits for the person leaves out an answer already sent; shown counts every card on the sheet
        if (one.list === 'cards') count.shown += 1;
        if (!(one.list === 'cards' && one.sent)) count[one.list] += 1;
      }
      reveal(one.block, one.show);
      // the sidebar lists every project with something open, and counts it for the agent that is pressed
      if (one.project && !one.sent && (one.list === 'cards' || one.list === 'working' || one.list === 'others')) {
        var held = byProject['p:' + one.project];
        if (!held) { held = byProject['p:' + one.project] = { name: one.project, n: 0 }; projects.push(held); }
        if (matchesAgent(one.id)) held.n += 1;
      }
    });
    pg.groups.forEach(function (group) {
      var any = group.entries.some(function (one) { return one.show; });
      reveal(group.block, any);
      if (group.ul) toggleClass(group.ul, 'bare', !any);
    });
    setText(pg.nodes.needsCount, count.cards);
    if (pg.nodes.needsCount) pg.nodes.needsFlag.setAttribute('data-needs-count', String(count.cards));
    setText(pg.nodes.needsText, pg.filter ? w('pgNoQuestions', nameOf(pg.filter)) : w('pgNothing'));
    setText(pg.nodes.needsSub, pg.filter ? '' : w('pgNothingHint'));
    reveal(pg.nodes.needsEmpty, count.shown === 0);
    var isFiltered = !!(pg.filter || pg.project);
    pg.nodes.needsClear = clearFilters(pg.nodes.needsEmpty, pg.nodes.needsClear, isFiltered);
    // The Other work view says so when it has nothing, here or on the Stopped shelf; Overview leaves the empty section out.
    setText(pg.nodes.othersText, isFiltered ? w('pgNoOthersFor', pg.filter ? nameOf(pg.filter) : pg.project) : w('pgNoOthers'));
    reveal(pg.nodes.othersEmpty, count.others === 0);
    pg.nodes.othersClear = clearFilters(pg.nodes.othersEmpty, pg.nodes.othersClear, isFiltered);
    // The tab title counts what the page shows, so a filter that hides questions is not a count the page lacks.
    var waitingShown = isFiltered ? count.cards : pg.waitingNow;
    document.title = waitingShown ? w('pgTabTitle', waitingShown) : 'Agent Board';
    if (pg.model && pg.model.view) setText(pg.nodes.workingEmpty, quietLine(pg.model.view.quiet, pg.model.view.now));
    reveal(pg.nodes.workingEmpty, count.working === 0 && !pg.filter && !pg.project);
    // The line counts every older question the filters allow, drawn or not.
    if (pg.olderRefs) count.older = pg.olderRefs.filter(function (ref) { return matches(agentOf(ref), projectOf(ref)); }).length;
    if (pg.nodes.olderLine) setText(pg.nodes.olderLine, plural('pgOlder', count.older));
    reveal(pg.nodes.olderBlock, count.older > 0);
    Object.keys(pg.nodes.counts).forEach(function (name) { setText(pg.nodes.counts[name], name === 'done' ? w('pgDoneWeek', count.done) : count[name]); });
    pg.sections.forEach(function (section) {
      var isOthersView = section.list === 'others' && pg.view === 'others' && count.stopped === 0;
      reveal(section.block, count[section.list] > 0 || section.list === 'working' && !pg.filter && !pg.project || isOthersView);
    });
    drawSide(count, projects);
  }
  // The sidebar's numbers come from the same counts as the headings, so every number on the page agrees.
  function drawSide(count, projects) {
    var shown = { needs: count.cards, working: count.working, others: count.others + count.stopped, done: count.done };
    Object.keys(shown).forEach(function (name) {
      var node = document.getElementById('count-' + name);
      if (node) setText(node, shown[name] > 0 ? shown[name] : '');
    });
    var group = document.getElementById('side-project-group');
    var list = document.getElementById('side-projects');
    if (!list) return;
    if (pg.project && !projects.some(function (one) { return one.name === pg.project; })) pg.project = '';
    projects.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    var wanted = projects.map(function (one) {
      var held = pg.projectNodes['p:' + one.name];
      if (!held) {
        var node = navButton('', function () { setProject(one.name); });
        node.className = 's-item s-project';
        node.setAttribute('data-project', one.name);
        node.setAttribute('title', one.name);
        held = pg.projectNodes['p:' + one.name] = { node: node, name: el('span', 's-txt', one.name), n: el('span', 's-n') };
        add(node, held.name, held.n);
      }
      setText(held.n, one.n > 0 ? one.n : '');
      held.node.setAttribute('aria-pressed', String(pg.project === one.name));
      return held.node;
    });
    Object.keys(pg.projectNodes).forEach(function (key) {
      if (wanted.indexOf(pg.projectNodes[key].node) === -1) { pg.projectNodes[key].node.remove(); delete pg.projectNodes[key]; }
    });
    wanted.forEach(function (node, index) { if (list.childNodes[index] !== node) list.insertBefore(node, list.childNodes[index] || null); });
    if (group) group.hidden = wanted.length === 0;
  }
  // Next to an empty list while a filter is on: a filter kept from an earlier visit is plain to see and one press clears it (#809).
  // It exists only while a filter is on, so an unfiltered page offers the same buttons as before.
  function clearFilters(holder, node, isFiltered) {
    if (!holder) return null;
    // The holder is fx's wrap: wrap > fx-in > the empty box the button goes in.
    var box = holder.firstChild && holder.firstChild.firstChild || holder;
    if (!isFiltered) {
      if (node) node.remove();
      return null;
    }
    if (node) return node;
    // Local, so it works without the server, but not a navigation button: those are the sheet's own See all and Show all.
    var made = button(w('clearFilters'), function () {
      pg.project = '';
      setFilter('');
    }, 'btn', true, true);
    add(box, made);
    return made;
  }
  function setProject(name) {
    pg.project = pg.project === name ? '' : name;
    layout();
  }
  // A view shows one section alone (the rail and the sidebar); Overview shows them all. Done opens its list.
  var VIEWS = ['all', 'needs', 'working', 'others', 'done'];
  function enter(node) {
    if (!node || !moving()) return;
    toggleClass(node, 'enter', false);
    node.offsetWidth;
    toggleClass(node, 'enter', true);
    node.addEventListener('animationend', function () { toggleClass(node, 'enter', false); }, { once: true });
  }
  function setView(name) {
    pg.view = name;
    var shell = document.getElementById('shell');
    shell.setAttribute('data-view', name);
    VIEWS.forEach(function (one) { document.getElementById('view-' + one).setAttribute('aria-pressed', String(one === name)); });
    if (name === 'done' && pg.openShelf.done) pg.openShelf.done(true);
    // A view picks a section; it leaves the agent and project filters as they were (#809). Before the first draw there is nothing to lay out.
    if (pg.sections) layout();
    enter(board);
    if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  }
  // The sidebar folds to a rail of icons at any width from 560px up; the pick is kept. Below 800px it starts folded.
  // The footer (version link, theme, Close the board) lives at the foot of the full sidebar, and under the work otherwise.
  function savedSide() {
    var kept = '';
    try { kept = localStorage.getItem('agent-board.side') || ''; } catch (e) {}
    return kept === 'rail' || kept === 'full' ? kept : '';
  }
  var sidePick = savedSide();
  function fitSide() {
    var width = window.innerWidth;
    var shell = document.getElementById('shell');
    if (typeof width !== 'number' || !shell) return;
    var hasSide = width >= 560;
    var isRail = hasSide && (sidePick === 'rail' || (sidePick !== 'full' && width < 800));
    shell.setAttribute('data-rail', isRail ? '1' : '');
    var toggle = document.getElementById('side-toggle');
    var label = w(isRail ? 'pgSideOpen' : 'pgSideFold');
    toggle.setAttribute('aria-expanded', String(!isRail));
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
    var foot = document.getElementById('pfoot');
    var home = hasSide && !isRail ? document.getElementById('side-foot') : document.querySelector('main');
    if (!foot || !home || foot.parentNode === home) return;
    if (hasSide && !isRail) home.appendChild(foot);
    else home.insertBefore(foot, document.getElementById('note'));
  }
  // While a row is open the list it is in keeps its order, so what is being read does not move; anything new comes first.
  function settle(name, refs) {
    var before = pg.order[name] || [];
    var ordered = refs;
    if (refs.some(function (ref) { return opened[ref.key] === true; })) {
      var place = {};
      before.forEach(function (key, index) { place[key] = index; });
      ordered = refs.map(function (ref, index) { return { ref: ref, index: index }; }).sort(function (a, b) {
        var left = a.ref.key in place ? place[a.ref.key] : -1;
        var right = b.ref.key in place ? place[b.ref.key] : -1;
        return left === right ? a.index - b.index : left - right;
      }).map(function (one) { return one.ref; });
    }
    pg.order[name] = ordered.map(function (ref) { return ref.key; });
    return ordered;
  }
  function entry(li, block, ref, list) {
    var one = { li: li, block: block, id: agentOf(ref), project: projectOf(ref), list: list, show: true, key: ref.key, sent: list === 'cards' && isSent(ref) };
    pg.lis.push(one);
    return one;
  }
  function rowItem(ref, list, section, showProject) {
    var built = buildRow(ref, section, showProject);
    return entry(built.li, built.block, ref, list);
  }
  function sectionHead(title, name) {
    var count = el('span', 'count');
    pg.nodes.counts[name] = count;
    var heading = el('h2', '', title);
    if (name === 'working') heading.setAttribute('title', w('pgWorkingHint'));
    return add(el('div', 'sec-head'), heading, count);
  }
  function needsSection(view) {
    var wrap = el('section', 'needs-wrap');
    wrap.id = 'needs';
    wrap.setAttribute('data-sec', 'needs');
    var flag = el('h2', 'flag', w('pgNeeds'));
    var total = el('b', '', String(Math.max(0, view.needs.n - pg.sentTotal)));
    add(flag, total);
    flag.setAttribute('data-needs-count', String(Math.max(0, view.needs.n - pg.sentTotal)));
    pg.nodes.needsCount = total;
    pg.nodes.needsFlag = flag;
    var sheet = el('div', 'sheet');
    var list = el('ul', 'cards');
    pg.cardList = list;
    pg.cardNodes = {};
    settle('cards', view.needs.cards).forEach(function (ref) {
      var li = el('li');
      li.setAttribute('data-k', ref.key);
      var block = el('div', 'fx');
      add(block, add(el('div', 'fx-in'), buildCard(ref)));
      add(li, block);
      add(list, li);
      pg.cardNodes[ref.key] = li;
      entry(li, block, ref, 'cards');
    });
    pg.nodes.needsText = el('p', '');
    pg.nodes.needsSub = el('p', 'sub');
    pg.nodes.needsEmpty = fx(add(el('div', 'empty'), pg.nodes.needsText, pg.nodes.needsSub));
    add(sheet, list, pg.nodes.needsEmpty);
    var foot = el('div', 'sheet-foot');
    var older = view.needs.older;
    pg.olderRefs = older;
    if (older.length) {
      var olderList = el('ul', 'cards');
      // Ten are drawn until Show all: a board with hundreds of old questions does not build hundreds of cards.
      var shownOlder = opened['older:all'] ? older.length : ${OLDER_SHOWN};
      var drawOlder = function (ref) {
        var li = el('li');
        var block = el('div', 'fx');
        add(block, add(el('div', 'fx-in'), buildCard(ref, true)));
        add(li, block);
        add(olderList, li);
        entry(li, block, ref, 'older');
      };
      older.slice(0, shownOlder).forEach(drawOlder);
      var showAll = null;
      if (shownOlder < older.length) {
        showAll = navButton(w('showAllQuestions', older.length), function () {
          opened['older:all'] = true;
          older.slice(shownOlder).forEach(drawOlder);
          showAll.remove();
          layout();
        });
        showAll.className = 'link';
      }
      var more = el('div', pg.hasOlder ? 'open' : '');
      var fold = el('div', 'fold');
      fold.inert = !pg.hasOlder;
      var line = el('p', '');
      pg.nodes.olderLine = line;
      var toggle = navButton(w('pgSeeAll'), function () {
        pg.hasOlder = !hasClass(more, 'open');
        toggleClass(more, 'open', pg.hasOlder);
        fold.inert = !pg.hasOlder;
        toggle.setAttribute('aria-expanded', String(pg.hasOlder));
      });
      toggle.className = 'link';
      toggle.setAttribute('aria-expanded', String(pg.hasOlder));
      add(more, add(el('div', 'older-line'), line, toggle), add(fold, add(el('div', 'fold-in'), olderList, showAll)));
      pg.nodes.olderBlock = fx(more);
      add(foot, pg.nodes.olderBlock);
    }
    add(sheet, foot);
    add(wrap, add(el('div', 'sheet-tab'), flag), sheet);
    return wrap;
  }
  function workingSection(view, workingKeys) {
    var refs = settle('working', view.working.slice());
    refs.forEach(function (ref) { workingKeys[ref.key] = true; });
    var sec = el('section', 'sec');
    sec.id = 'working-now';
    var list = el('ul', 'rows');
    var group = { ul: list, entries: [] };
    refs.forEach(function (ref) {
      var one = rowItem(ref, 'working', 'working', true);
      group.entries.push(one);
      add(list, one.li);
    });
    pg.groups.push(group);
    pg.nodes.workingEmpty = fx(el('p', '', w('pgNoWorking')));
    add(sec, sectionHead(w('pgWorking'), 'working'), list, pg.nodes.workingEmpty);
    return sec;
  }
  function othersSection(view, workingKeys) {
    var refs = settle('others', view.all.open.concat(view.own.open).filter(function (ref) { return !workingKeys[ref.key]; }).sort(byTime));
    var order = [];
    var by = {};
    refs.forEach(function (ref) {
      var name = clean(ref.repo || source(ref).project || '');
      if (!by[name]) { by[name] = []; order.push(name); }
      by[name].push(ref);
    });
    var sec = el('section', 'sec');
    add(sec, sectionHead(w('pgOthers'), 'others'));
    pg.nodes.othersText = el('p', '');
    pg.nodes.othersEmpty = fx(add(el('div', 'empty'), pg.nodes.othersText));
    order.forEach(function (name) {
      var list = el('ul', 'rows');
      var group = { ul: list, entries: [], block: null };
      by[name].forEach(function (ref) {
        var one = rowItem(ref, 'others', 'others', false);
        group.entries.push(one);
        add(list, one.li);
      });
      if (name) {
        group.block = fx(el('p', 'proj', name));
        add(sec, group.block);
      }
      pg.groups.push(group);
      add(sec, list);
    });
    add(sec, pg.nodes.othersEmpty);
    return sec;
  }
  // A closed shelf: Stopped and Done list their rows flat, so each row names its project.
  function shelf(name, title, refs, section, extra) {
    if (!refs.length && !extra) return null;
    var box = el('section', 'shelf' + (opened['shelf:' + name] ? ' open' : ''));
    var count = el('span', 'count');
    pg.nodes.counts[name] = count;
    var fold = el('div', 'fold');
    fold.inert = opened['shelf:' + name] !== true;
    var setOpen = function (now) {
      toggleClass(box, 'open', now);
      head.setAttribute('aria-expanded', String(now));
      fold.inert = !now;
      opened['shelf:' + name] = now;
    };
    var head = navButton('', function () { setOpen(!hasClass(box, 'open')); });
    pg.openShelf[name] = setOpen;
    head.className = 'shelf-head';
    head.setAttribute('aria-expanded', String(opened['shelf:' + name] === true));
    add(head, el('span', 'chev'), el('span', '', title), count);
    head.firstChild.setAttribute('aria-hidden', 'true');
    var list = el('ul', 'rows');
    var group = { ul: list, entries: [] };
    refs.forEach(function (ref) {
      var one = rowItem(ref, name, section, true);
      group.entries.push(one);
      add(list, one.li);
    });
    pg.groups.push(group);
    var body = add(el('div'), list);
    if (extra) add(body, extra);
    add(box, head, add(fold, add(el('div', 'fold-in'), body)));
    return box;
  }
  function doneExtra() {
    var wrap = el('div', 'acts');
    add(wrap, button(w('archiveNow'), function () { tidyBoard('recent', '/api/tidy'); }));
    resultSlot(wrap, 'recent', '', w('pgDone'));
    return wrap;
  }
  function hiddenShelf(model) {
    var items = model.hidden || [];
    if (!items.length) return null;
    var box = el('section', 'shelf' + (opened['shelf:hidden'] ? ' open' : ''));
    box.setAttribute('data-sec', 'needs');
    var fold = el('div', 'fold');
    fold.inert = opened['shelf:hidden'] !== true;
    var head = navButton('', function () {
      var now = !hasClass(box, 'open');
      toggleClass(box, 'open', now);
      head.setAttribute('aria-expanded', String(now));
      fold.inert = !now;
      opened['shelf:hidden'] = now;
    });
    head.className = 'shelf-head';
    head.setAttribute('aria-expanded', String(opened['shelf:hidden'] === true));
    add(head, el('span', 'chev'), el('span', '', w('hiddenCount', items.length)));
    head.firstChild.setAttribute('aria-hidden', 'true');
    var body = el('div', 'shelf-body');
    items.forEach(function (one) {
      var item = el('div', 'hid');
      var line = [one.project, one.isOwn ? w('pgOwn') : agentName(one.agent)].filter(Boolean).join(' · ') + (one.task ? ' › ' + one.task : '');
      add(item, el('p', 'c-meta', line), el('p', 'q', one.text), add(el('div', 'acts'), button(w('showAgain'), function () { act(one.key, 'unhide'); })));
      resultSlot(item, one.key, one.text, one.task);
      add(body, item);
    });
    add(box, head, add(fold, add(el('div', 'fold-in'), body)));
    return box;
  }
  // Archive now moves every finished task at once; Clean up runs the sweep --tidy runs.
  function tidyBoard(key, route) {
    say(w('pressPending'), '', key);
    call(route, {}).then(function (data) {
      say(data.note || w(data.ok ? 'pressDone' : 'pressFailed'), data.ok ? 'done' : 'alert', key);
      refresh();
    }, function () {
      say(w('serveOffline'), 'alert', key);
      unreachable();
    });
  }
  function connectedIds(view) {
    var ids = [];
    var push = function (id) { id = String(id || '').toLowerCase(); if (id && ids.indexOf(id) === -1) ids.push(id); };
    view.agents.forEach(function (one) { push(one.agent); });
    connections.forEach(function (one) { push(one.agent); });
    return ids;
  }
  // The empty board: the agents that can report here, and how their work shows up.
  // With nothing connected it names no agent, so none is marked connected (#546).
  function freshPage(view) {
    var ids = connectedIds(view);
    if (!ids.length) return add(el('section', 'fresh'), el('h2', '', w('pgReady')), el('p', '', w('pgStartAny')));
    var list = el('ul');
    ids.forEach(function (id) {
      add(list, add(el('li'), agentMark(id), add(el('span'), el('b', '', agentName(id)), el('span', 'ok', ' ✓ ' + w('pgConnected')))));
    });
    return add(el('section', 'fresh'), el('h2', '', w('pgReady')), list, el('p', '', w('pgStartIn', ids.map(agentName).join(' / '))));
  }
  function sectionBlock(section, list) {
    var block = fx(section);
    block.setAttribute('data-sec', list === 'stopped' ? 'others' : list);
    pg.sections.push({ block: block, list: list });
    return block;
  }
  function draw(model) {
    if (!model.view) return;
    var view = model.view;
    board.querySelectorAll('textarea[data-key]').forEach(function (box) { pg.drafts[box.getAttribute('data-key')] = box.value; });
    var active = document.activeElement;
    var focused = active && active.getAttribute && active.getAttribute('data-key');
    var caret = focused ? [active.selectionStart, active.selectionEnd] : null;
    pg.model = model;
    latest = model;
    view.agents.forEach(function (agent) { if (pg.ids.indexOf(agent.agent) === -1) pg.ids.push(agent.agent); });
    pg.sources = {};
    [].concat(model.asks || [], model.reminder || [], model.older || [], model.idle || [], model.stopped || [], (model.groups || []).flatMap(function (group) { return group.rows; }), model.turns || [], model.recent || [], model.finished || []).forEach(function (item) { if (item.key) pg.sources[item.key] = Object.assign({}, pg.sources[item.key], item); });
    if (!hasDrawn) pg.filter = savedFilter();
    // An answer that was sent stops counting as waiting for the person (tab title, flag, agent badges) until it comes back.
    pg.sentBy = Object.create(null);
    pg.sentTotal = 0;
    view.needs.cards.forEach(function (ref) {
      if (!isSent(ref)) return;
      var who = agentOf(ref);
      pg.sentTotal += 1;
      pg.sentBy[who] = (pg.sentBy[who] || 0) + 1;
    });
    var waitingNow = Math.max(0, view.needs.n - pg.sentTotal);
    pg.waitingNow = waitingNow;
    document.title = waitingNow ? w('pgTabTitle', waitingNow) : 'Agent Board';
    var version = view.versions;
    document.getElementById('versions').textContent = !version.package || version.package === version.board ? w('pgVersion', version.board) : w('pgVersions', version.board, version.package);
    var priorCards = pg.cardNodes;
    var priorOrder = pg.order.cards || [];
    var priorRows = pg.rowKeys;
    pg.lis = [];
    pg.groups = [];
    pg.sections = [];
    pg.openShelf = {};
    pg.mores = [];
    pg.nodes = { counts: {} };
    pg.cardNodes = {};
    cardParts = {};
    var closeSlot = resultSlots.close;
    var tidySlot = resultSlots.tidy;
    resultSlots = {};
    if (closeSlot) resultSlots.close = closeSlot;
    if (tidySlot) resultSlots.tidy = tidySlot;
    agentPresence = presenceMap(view);
    drawChips(view);
    var parts = [];
    if (model.warning) parts.push(el('p', 't-alert', model.warning));
    var hasOwn = Object.keys(view.own.counts).some(function (key) { return view.own.counts[key] > 0; });
    document.getElementById('shell').setAttribute('data-empty', !view.agents.length && !hasOwn ? '1' : '');
    if (!view.agents.length && !hasOwn) parts.push(freshPage(view));
    else {
      var workingKeys = {};
      parts.push(needsSection(view));
      parts.push(sectionBlock(workingSection(view, workingKeys), 'working'));
      parts.push(sectionBlock(othersSection(view, workingKeys), 'others'));
      var stopped = shelf('stopped', w('pgStopped'), view.all.stopped.concat(view.own.stopped).sort(byTime), 'stopped');
      if (stopped) parts.push(sectionBlock(stopped, 'stopped'));
      var finished = view.all.done.concat(view.own.done).sort(byTime);
      var done = shelf('done', w('pgDone'), finished, 'done', finished.length ? doneExtra() : null);
      if (done) parts.push(sectionBlock(done, 'done'));
      var hidden = hiddenShelf(model);
      if (hidden) parts.push(hidden);
      pg.rowKeys = workingKeys;
    }
    var notices = el('div', 'notices');
    if (model.details) add(notices, el('p', 't-quiet', model.details));
    if (model.pruned) add(notices, el('p', 't-quiet', model.pruned));
    (model.health || []).forEach(function (line) { add(notices, el('p', 't-alert', line)); });
    if (model.background) add(notices, el('p', 't-quiet', model.background));
    if (model.isCleanable) {
      var cleanup = add(el('div', 'acts'), button(w('cleanUp'), function () { tidyBoard('cleanup', '/api/clean'); }));
      add(notices, cleanup);
      resultSlot(cleanup, 'cleanup', '', w('cleanUp'));
    } else if (results.cleanup) resultSlot(notices, 'cleanup', '', w('cleanUp'));
    if (notices.firstChild) parts.push(notices);
    // The filter is applied before anything is on the page, so a redraw never plays it.
    layout();
    var arriving = moving() ? pg.lis.filter(function (one) { return one.list === 'working' && one.show && !priorRows[one.key]; }) : [];
    arriving.forEach(function (one) { reveal(one.block, false); });
    board.textContent = '';
    parts.forEach(function (part) { add(board, part); });
    if (moving()) {
      // A card that left the sheet folds away where it was; its task arrives lit in Working now.
      priorOrder.forEach(function (key, index) {
        var node = priorCards[key];
        if (!node || pg.cardNodes[key] || !pg.cardList || hasClass(node.firstChild, 'gone')) return;
        pg.cardList.insertBefore(node, pg.cardList.childNodes[index] || null);
        node.firstChild.offsetHeight;
        reveal(node.firstChild, false, function () { node.remove(); });
      });
      if (arriving.length) arriving[0].block.offsetHeight;
      arriving.forEach(function (one) { reveal(one.block, true); toggleClass(one.li, 'arrived', true); });
    }
    drawLostResults();
    // A result with no slot in this update was drawn apart from its card, if at all. It
    // stays for this update, and is dropped when a slot for its card is drawn again.
    Object.keys(results).forEach(function (key) { if (!resultSlots[key]) results[key].orphaned = true; });
    board.querySelectorAll('textarea[data-key]').forEach(function (box) {
      var key = box.getAttribute('data-key');
      if (Object.prototype.hasOwnProperty.call(pg.drafts, key)) box.value = pg.drafts[key];
      if (key === focused) {
        box.focus({ preventScroll: true });
        if (caret) box.setSelectionRange(caret[0], caret[1]);
      }
    });
    hasDrawn = true;
  }
  function render(model) {
    keepCopyFocus(function () { draw(model); });
  }
  function drawLostResults() {
    lostResults.forEach(function (card) { card.remove(); });
    lostResults = [];
    Object.keys(results).reverse().forEach(function (key) {
      if (resultSlots[key]) return;
      var result = results[key];
      if (!result.pending && result.tone !== 'alert' && result.tone !== 'done') { delete results[key]; return; }
      var card = add(el('article', 'lost'), el('div', 'where', result.label));
      var slot = el('div', 'press-result');
      slot.setAttribute('role', 'status');
      slot.textContent = result.text;
      slot.className += ' ' + result.tone;
      restoreNotice(slot, result);
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
      // A newer page took over: this one stops asking and says so, once (#265).
      if (data.moved) {
        isClosed = true;
        var movedMain = document.querySelector('main');
        movedMain.textContent = '';
        add(movedMain, el('p', '', w('serveMoved')));
        document.getElementById('side').hidden = true;
        return;
      }
      if (data.unchanged) { reachable(); maybeShowAway(); return; }
      if (!data.ok || !data.model) {
        if (data.note) { reachable(); say(data.note, 'alert'); }
        else unreachable();
        return;
      }
      reachable();
      if (data.barStyle) barStyleShown(data.barStyle);
      connections = data.messaging && data.messaging.connections || [];
      var text = JSON.stringify([data.model, data.messaging && data.messaging.sessions, connections.map(function (one) { return one.agent; })], function (key, value) { return key === 'now' ? Math.floor(value / 60000) : value; });
      if (text !== last) {
        last = text;
        render(data.model);
        if (presence) { presence.remove(); presence = null; }
        // Show actionable progress delays, never transport inventory or native identifiers.
        var sessions = (data.messaging && data.messaging.sessions || []).filter(function (one) { return one.status === 'waiting' || one.status === 'timed_out'; });
        if (sessions.length) {
          presence = el('section', 'notices');
          add(presence, el('h2', '', w('sessionsTitle')));
          sessions.forEach(function (one) {
            var state = one.status === 'timed_out' ? w('sessionsTimedOut') : w('sessionsWaiting');
            add(presence, add(el('div'), el('div', 'c-meta', agentName(one.agent)), el('div', one.status === 'timed_out' ? 't-alert' : 't-quiet', state)));
          });
          board.insertAdjacentElement('afterend', presence);
        }
      }
      // The world on this refresh is the one the return is compared with.
      maybeShowAway();
      // A reply runs in the background; its answer comes with the board once the agent is done.
      if (since === null) since = data.now;
      var seenAt = since;
      (data.replies || []).forEach(function (reply) {
        if (reply.at > seenAt) { since = Math.max(since, reply.at); say(reply.note, reply.ok ? 'done' : 'alert', reply.key, undefined, !reply.ok); }
      });
    }, function () {
      unreachable();
    }).then(function () {
      if (!isClosed) timer = setTimeout(refresh, 3000);
    });
  }
  // Wider than the parser's start marker, so a block it would take is never dropped here.
  var blockStart = /\x3c!--\s*auto\s/;
  // The report on its way comes first. One at a time, so a question about one is answered before the next is sent.
  var importQueue = [];
  // What the reports of one run said, so a later one's result does not hide an earlier refusal.
  var importLines = [];
  var isImportRefused = false;
  function importSaid(text, tone, key) {
    if (importLines.indexOf(text) < 0) importLines.push(text);
    if (tone === 'alert') isImportRefused = true;
    say(importLines.join(' '), isImportRefused ? 'alert' : tone, key);
    importQueue.shift();
    if (importQueue.length) {
      importNext();
      return;
    }
    importLines = [];
    isImportRefused = false;
  }
  function importNext() {
    var text = importQueue[0].text;
    var key = importQueue[0].key;
    call('/api/paste', { text: text }).then(function (data) {
      if (data.review && window.confirm(w('pasteReview', data.review.current, data.review.incoming))) {
        return call('/api/paste', { text: text, reviewToken: data.review.token });
      }
      return data;
    }).then(function (data) {
      importSaid(data.note || w(data.ok ? 'pressDone' : 'pressFailed'), data.ok ? 'done' : 'alert', key);
      refresh();
    }, function () { importSaid(w('pressFailed'), 'alert', key); unreachable(); });
  }
  // A paste may come with the footer off screen: its result goes in the sticky note line.
  function importBlock(text, isPaste) {
    var key = isPaste ? null : 'close';
    if (!blockStart.test(text)) {
      say(w('importNoBlock'), 'alert', key);
      return;
    }
    if (importQueue.some(function (report) { return report.text === text; })) return;
    importQueue.push({ text: text, key: key });
    if (importQueue.length === 1) importNext();
  }
  if (typeof document.addEventListener === 'function') document.addEventListener('paste', function (event) {
    if (isUnreachable || isClosed) return;
    var target = event.target;
    var tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || target && target.isContentEditable) return;
    var text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
    if (!blockStart.test(text)) return;
    event.preventDefault();
    beginPress();
    importBlock(text, true);
  });
  var connectWebChat = document.getElementById('connect-web-chat');
  if (connectWebChat) connectWebChat.addEventListener('click', function () {
    if (isUnreachable) return;
    beginPress();
    var prompt = JSON.parse(document.getElementById('relay-prompt').textContent);
    copy(prompt, 'close', function () { say(w('webChatCopied'), 'done', 'close'); });
  });
  var importClipboard = document.getElementById('import-clipboard');
  if (importClipboard) importClipboard.addEventListener('click', function () {
    if (isUnreachable) return;
    beginPress();
    function useKeys() { say(w('importUseKeys'), 'alert', 'close'); }
    if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) {
      navigator.clipboard.readText().then(function (text) { importBlock(text); }, useKeys);
    } else useKeys();
  });
  if (typeof document.addEventListener === 'function') document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    // Only the panel the focus is in (or its More button) closes; with no focus anywhere, every open one does.
    // A reply being typed elsewhere is left alone.
    var active = document.activeElement;
    var isIdle = !active || active === document.body;
    pg.mores.forEach(function (one) {
      if (!hasClass(one.box, 'open')) return;
      var isInside = false;
      for (var node = active; node; node = node.parentNode) if (node === one.box || node === one.toggle) isInside = true;
      if (!isInside && !isIdle) return;
      toggleClass(one.box, 'open', false);
      one.fold.inert = true;
      one.toggle.setAttribute('aria-expanded', 'false');
      opened['more:' + one.key] = false;
      if (isInside && active !== one.toggle) one.toggle.focus();
    });
  });
  // Going away starts a new away period: the line from before is gone, and the world as
  // it stands now is the snapshot the return is compared with.
  if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', function () {
    if (!document.hidden) return;
    clearAwayLine();
    var snap = awaySnapshot();
    if (snap) awaySnap = snap;
  });
  if (typeof ResizeObserver === 'function' && document.documentElement) {
    var head = document.getElementById('head');
    new ResizeObserver(function () { document.documentElement.style.setProperty('--head-h', head.offsetHeight + 'px'); }).observe(head);
  }
  VIEWS.forEach(function (name) { document.getElementById('view-' + name).addEventListener('click', function () { setView(name); }); });
  document.getElementById('side-toggle').addEventListener('click', function () {
    sidePick = document.getElementById('shell').getAttribute('data-rail') === '1' ? 'full' : 'rail';
    try { localStorage.setItem('agent-board.side', sidePick); } catch (e) {}
    fitSide();
  });
  if (typeof window.addEventListener === 'function') window.addEventListener('resize', fitSide);
  fitSide();
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
      document.getElementById('side').hidden = true;
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
  // A bulk archive previews first and archives only on a second, separate press. Any
  // other press drops the preview; the token on the server then simply expires.
  var tidyToken = '';
  var tidyPreview = null;
  var tidyBusy = false;
  var tidyCommitting = false;
  function resetTidy(cancel) {
    if (tidyCommitting) return;
    if (cancel && tidyToken) call('/api/tidy-bulk', { kind: 'cancel', token: tidyToken }).catch(function () {});
    tidyToken = '';
    tidyPreview = null;
    var confirm = document.getElementById('tidy-confirm');
    var cancelButton = document.getElementById('tidy-cancel');
    if (confirm) confirm.disabled = true;
    if (cancelButton) cancelButton.disabled = true;
  }
  function tidySelector() {
    var kind = document.getElementById('tidy-kind').value;
    if (kind === 'agent') return { kind: kind, value: document.getElementById('tidy-value').value.trim() };
    if (kind === 'older') return { kind: kind, days: Number(document.getElementById('tidy-value').value.trim()) };
    return { kind: 'stopped' };
  }
  document.getElementById('tidy-preview').addEventListener('click', function () {
    if (isUnreachable || tidyBusy) return;
    var selector = tidySelector();
    if (selector.kind === 'agent' && !/^[a-z][a-z0-9-]{0,63}$/.test(selector.value || '')) { say(w('tidyInvalid'), 'alert', 'tidy'); return; }
    if (selector.kind === 'older' && !(Number.isSafeInteger(selector.days) && selector.days >= 1 && selector.days <= 365000)) { say(w('tidyInvalid'), 'alert', 'tidy'); return; }
    tidyBusy = true;
    say(w('pressPending'), '', 'tidy');
    call('/api/tidy-bulk', { kind: 'preview', selector: selector }).then(function (data) {
      tidyBusy = false;
      if (!data.token || !data.preview) { say(data.note || w('pressFailed'), 'alert', 'tidy'); return; }
      tidyToken = data.token;
      tidyPreview = data.preview;
      document.getElementById('tidy-confirm').disabled = false;
      document.getElementById('tidy-cancel').disabled = false;
      say(data.note || '', 'quiet', 'tidy');
    }, function () { tidyBusy = false; say(w('serveOffline'), 'alert', 'tidy'); unreachable(); });
  });
  document.getElementById('tidy-confirm').addEventListener('click', function () {
    if (isUnreachable || tidyBusy || !tidyToken || !tidyPreview) return;
    tidyBusy = true;
    tidyCommitting = true;
    say(w('pressPending'), '', 'tidy');
    call('/api/tidy-bulk', { kind: 'confirm', token: tidyToken, preview: tidyPreview }).then(function (data) {
      tidyBusy = false;
      tidyCommitting = false;
      tidyToken = '';
      tidyPreview = null;
      document.getElementById('tidy-confirm').disabled = true;
      document.getElementById('tidy-cancel').disabled = true;
      say(data.note || w(data.ok ? 'pressDone' : 'pressFailed'), data.ok ? 'done' : 'alert', 'tidy');
      refresh();
    }, function () { tidyBusy = false; tidyCommitting = false; say(w('serveOffline'), 'alert', 'tidy'); unreachable(); });
  });
  document.getElementById('tidy-cancel').addEventListener('click', function () {
    if (tidyBusy) return;
    resetTidy(true);
    say(w('tidyCancelled'), '', 'tidy');
  });
  refresh();
})();
`

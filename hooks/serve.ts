import type { AskKind } from './ask'
import { answersOf, boardItems, fingerprint, olderKey, remainingInbox } from './board'
import type { BoardItem, PendingTurn } from './board'
import { clipLine, LABEL_ROOM, LINE_ROOM } from './clip'
import { groupBoard } from './grouping'
import type { Bucket, Card, GroupedQuestion, GroupedTask, RepoOf } from './grouping'
import { AGENT_ALIASES, agentMarkCss, agentRowCss, boardMark, faviconLink, filterStore, htmlLang, motionCss, pageBaseCss, pageTokens, sheetCss, themeHead, themeSwitch } from './page-look'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { agentLabel } from './strings'
import type { Tone } from './palette'
import { RESUME } from './parse'
import { OLDER_SHOWN, replyHint, wayBackText } from './view'
import type { AgentTarget, StepRef, TaskRef, View, WaitingItem } from './view'
import type { Connection, Message } from './messaging'

// The board's page: what `agent-board.mjs --serve` shows in a browser for agents other than
// Claude Code, and what a press on it does. It does what the pane does: tick a hand-kept step,
// archive, copy an answer, answer another agent, and tidy the board.
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

// `line`, here and on the other texts below, is the text folded to one line (hooks/clip.ts) and
// capped; it is absent when that is the text itself. The browser cuts the line to its width with an
// ellipsis.
export type ServeStep = { text: string; note: string; status: string; isCurrent: boolean; line?: string }

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
  due: string | null
  pr: string
  steps: ServeStep[]
  next: string | null
  // The words of the Done button for `next`, clipped; `next` itself is what a press must send back.
  nextLabel?: string
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
}

// A question marked answered, listed so it can be shown again.
export type ServeHidden = { key: string; project: string; agent: string; isOwn?: true; task: string; text: string; questionId?: string }
// key names the line in the action route; canHide is false for a retained source that is only for review.
export type ServeRetained = { key: string; canHide: boolean; project: string; agent: string; isOwn?: true; task: string; text: string; note: string; context: string; contextLine?: string; when: string; questionId?: string; at?: number; dir?: string | null }

export type ServeTurn = { key: string; project: string; agent: string; text: string; isQuestion: boolean; info: string; at?: number }

export type GroupOptions = { now: number; repoOf: RepoOf; versions: { board: string; package: string | null }; unreadable: readonly string[] }
type ServeDone = { project: string; title: string; line?: string; when: string; questions?: string[]; key?: string; agent?: string; isOwn?: true; dir?: string | null; at?: number }
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
  const name = agentLabel(agent || 'claude', s)
  if (mode === 'open') return s.serveSendOpen(name)
  if (mode === 'claude') return s.replyElsewhere(task, '', '')
  if (mode === 'none') return s.serveSendNone(name)

  return ''
}

// The text folded to one line and capped at `room` characters, or undefined when that is the text itself.
const clipped = (text: string, room: number): string | undefined => {
  const { line } = clipLine(text, room)
  return line === text ? undefined : line
}
const lined = (text: string): { line?: string } => {
  const line = clipped(text, LINE_ROOM)

  return line === undefined ? {} : { line }
}
const contextLined = (text: string): { contextLine?: string } => {
  const line = clipped(text, LINE_ROOM)

  return line === undefined ? {} : { contextLine: line }
}
const noteLined = (text: string): { noteLine?: string } => {
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
  project: item.project,
  agent: item.agent,
  ...(item.where === 'manual' ? { isOwn: true as const } : {}),
  task: item.task,
  text: item.text,
  note: item.note,
  context: item.context,
  ...contextLined(item.context),
  when: item.when,
  ...(item.questionId === undefined ? {} : { questionId: item.questionId }),
})

export const serveModel = (view: View, pending: readonly PendingTurn[], s: Strings = ZH_TW, sending: ReadonlySet<string> = new Set(), isLan = false, messaging?: Messaging, allowResume = false, group?: GroupOptions): ServeModel => {
  const isSending = (target: AgentTarget | null): boolean => target !== null && sending.has(sendKey(target))
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
      const connection = isManual || isLan ? undefined : liveTarget(ask.agent, ask.nativeSession, messaging?.connections ?? [])
      const baseMode = isManual ? 'none' : sendMode(ask.agent, ask.target)
      const mode = connection ? 'connected' : (messaging || !allowResume) && baseMode === 'send' ? 'open' : baseMode
      const send = onLan(mode)
      // A phone on the local network gets the id, but neither the command nor its folder.
      const hint = replyHint(ask, s, !isLan, true)
      const label = ask.step === null ? undefined : clipped(ask.text, LABEL_ROOM)
      asks.push({
        ...(group === undefined ? {} : { ...(ask.at === undefined ? {} : { at: ask.at }), dir: ask.dir ?? null, when: ask.when }),
        ...(connection === undefined ? {} : { delivery: { id: connection.id, turn: connection.turn, agent: connection.agent } }),
        ...(isLan ? {} : rowReceipt(ask.agent, ask.nativeSession, messaging?.messages ?? [])),
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
      const nextLabel = row.next === null ? undefined : clipped(row.next.step, LABEL_ROOM)
      const rows = idleKeys.has(row.key) ? idle : stoppedKeys.has(row.key) ? stopped : (groups.get(row.project) ?? [])
      if (!idleKeys.has(row.key) && !stoppedKeys.has(row.key)) groups.set(row.project, rows)
      rows.push({
        ...(group === undefined ? {} : {
          ...(row.at === undefined ? {} : { at: row.at }),
          dir: row.dir ?? null,
          ...(row.nativeSession === undefined ? {} : { sessionId: row.nativeSession }),
          // Run ownership is not reported by the current producer (#399).
          ...(!idleKeys.has(row.key) && !stoppedKeys.has(row.key) && row.auto !== null && row.auto !== 'ended' && row.steps.some(step => step.status === 'blocked')
            ? { stuck: { reason: (row.steps.find(step => step.status === 'blocked')?.note || row.steps.find(step => step.status === 'blocked')?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80) } }
            : {}),
        }),
        ...(connection === undefined ? {} : { delivery: { id: connection.id, turn: connection.turn, agent: connection.agent } }),
        ...(isLan ? {} : rowReceipt(row.agent, row.nativeSession, messaging?.messages ?? [])),
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
        due: row.due?.left ?? null,
        pr: row.pr,
        steps: row.steps.map(step => ({ text: step.text, note: step.note, status: step.status, isCurrent: step.isCurrent, ...lined(step.note ? `${step.text} — ${step.note}` : step.text) })),
        next: row.next?.step ?? null,
        ...(nextLabel === undefined ? {} : { nextLabel }),
        canArchive: row.archive !== null,
        canConfirm: row.confirm != null,
        archiveNote: row.auto === 'working' || row.auto === 'waiting' ? s.archiveLive : '',
        // The command to resume a session names its folder, and the account with it: the computer's only.
        resume: isLan ? null : row.resume,
        handoff: row.handoff,
        runs: row.runs ?? '',
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
      ...(group === undefined ? {} : { at: turn.at }),
      key: item.key,
      project: turn.project,
      agent: turn.agent,
      text: turn.text,
      isQuestion: turn.isQuestion,
      // Connection closure does not answer an unresolved inbox question.
      info: turn.isQuestion ? infoOf(SENDERS.has(turn.agent) ? 'open' : 'none', turn.agent, '', '', s) : '',
    })
  }

  const model: ServeModel = {
    counts: { ...view.overview, waiting: view.overview.waiting + remainingInbox(view, pending).filter(turn => turn.isQuestion).length },
    warning: view.warning,
    ...(view.details === undefined ? {} : { details: view.details }),
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
    recent: view.recent.map(item => ({ project: item.project, title: item.title, ...lined(item.title), when: item.when, questions: item.questions?.map(question => [question.text, question.note].filter(Boolean).join(' — ')) })),
  }
  if (group === undefined) return model
  const extra = (item: WaitingItem): ServeRetained => ({ ...retainedOf(item), ...(item.at === undefined ? {} : { at: item.at }), dir: item.dir ?? null })
  model.reminder = (view.reminder ?? []).map(extra)
  model.older = (view.older ?? []).map(extra)
  model.finished = (view.finished ?? []).map(item => ({ ...item, key: `row:${item.key}`, questions: item.questions?.map(question => [question.text, question.note].filter(Boolean).join(' — ')) }))
  model.recent = view.recent.map((item, index) => {
    const finished = model.finished?.find(one => one.key === `row:${item.key}`)
    return { ...model.recent[index]!, key: `row:${item.key}`, ...(finished === undefined ? {} : { agent: finished.agent, ...(finished.isOwn ? { isOwn: true as const } : {}), dir: finished.dir, at: finished.at }) }
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
  if (isLan) return { type: 'refuse', note: s.serveLanSend(agentLabel(agent || 'claude', s)) }
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
  'messagesQueued', 'messagesUncertain', 'messagesAccepted', 'messagesAcknowledged', 'messagesRejected', 'messagesFailed', 'messagesTimeout',
  'sessionsTitle', 'sessionsWaiting', 'sessionsTimedOut',
  'questionReviewOnly', 'hiddenCount', 'showAgain', 'answeredHide',
  'archiveNow', 'cleanUp', 'stoppedCount',
  'serveClosed', 'serveClose', 'serveOffline', 'serveTickNext', 'serveArchive', 'confirmDone', 'serveCopyResume', 'serveCopyCommand',
  'serveOpenLink', 'serveMore', 'serveReplyPlaceholder', 'serveMessagePlaceholder', 'serveSend', 'serveSending',
  'copied', 'pressDone', 'pressFailed', 'pressEmpty', 'pressPending', 'boardCopyFailedBelow',
  'pgNeeds', 'pgAgents', 'pgOwn', 'pgDone', 'pgTabTitle', 'pgWorking', 'pgNoWorking', 'pgNothing', 'pgNothingHint',
  'pgOlder', 'pgOlderOne', 'pgSeeAll', 'pgMore', 'pgOwnTodo', 'pgWriteOwn', 'pgCopyAnswer', 'pgStuck', 'pgTodo', 'pgLast', 'pgStoppedAt',
  'pgDoneSteps', 'pgDoneStepsOne', 'pgMoreSteps', 'pgMoreStepsOne', 'pgVersion', 'pgVersions', 'pgUnreadable', 'pgHowFix', 'pgFixAdvice',
  'pgReady', 'pgUnreadableReply', 'pgUnknownAge', 'pgCopyReply', 'pgPasteIn', 'pgSentTo', 'pgAnswered', 'pgCopyAgain', 'pgCancel',
  'showAllQuestions', 'pgSendReply', 'pgCopyFailed', 'pgOffline', 'pgPasteLater', 'serveRetry', 'serveCopyMessage', 'serveSendBusy', 'pgNoQuestions', 'pgOthers', 'pgStopped', 'pgDoneWeek', 'pgChipEmpty', 'pgStartIn', 'pgConnected', 'pgTipNeeds', 'pgTipWorking', 'pgTipCantRead',
] as const satisfies ReadonlyArray<keyof Strings>

// The chat prompt goes as it is in every language: the chat reads it, not the person.
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
#offline:not(:empty)::before{content:'!';display:inline-grid;place-items:center;width:20px;height:20px;border:1px solid currentColor;border-radius:var(--radius-round);margin-right:var(--s3);font-weight:600}
button,.btn{font:inherit;color:inherit}
button:hover,.btn:hover,summary:hover{background-color:var(--hover)}
button:active,.btn:active{background-color:var(--press)}
button:disabled,button[aria-disabled="true"]{color:var(--muted);border-color:var(--line);cursor:not-allowed}
${agentRowCss}
.link{border:0;background:none;padding:0;min-height:var(--hit);color:var(--accent);font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
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
.answers{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;padding-top:var(--s1)}
.btn,.answers button,.acts button,.state button,.composer button,.shelf-head,.pfoot button,.seg button{font:inherit;font-size:var(--text-sm);display:inline-flex;align-items:center;max-width:100%;min-height:var(--hit);padding:0 14px;border:1px solid var(--line-strong);border-radius:var(--radius-m);background:transparent;color:var(--ink);cursor:pointer;text-align:left;overflow-wrap:anywhere;text-decoration:none;transition:background-color var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out)}
.seg button{border-color:transparent;padding:0 8px;min-height:28px;font-size:var(--text-xs)}
.seg button[aria-pressed="true"]{border-color:var(--muted)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
button.primary:hover{background:var(--accent);border-color:var(--accent);filter:brightness(.94)}
button.quiet{border-color:transparent;color:var(--accent)}
.chev{display:inline-block;transition:transform var(--dur-base) var(--ease-out)}.chev::before{content:"▸"}
.open>.shelf-head .chev{transform:rotate(90deg)}
code{display:block;max-width:100%;overflow-x:auto;white-space:pre;font:var(--text-xs)/1.5 var(--font-mono);padding:6px var(--s2);border:1px solid var(--line);border-radius:var(--radius-s);background:var(--inset);color:var(--ink)}
.state{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s3)}
.state .msg{display:inline-flex;align-items:center;gap:var(--s2);min-width:0;line-break:strict}
.ok{color:var(--done)}.go{color:var(--accent)}
.dots{display:inline-flex;gap:3px;margin-left:var(--s2)}.dots i{width:4px;height:4px;border-radius:var(--radius-round);background:currentColor;animation:dot var(--dur-dots) infinite ease-in-out}
.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}
.composer{display:grid;gap:var(--s2)}
textarea{display:block;width:100%;min-width:0;font:inherit;font-size:var(--text-sm);line-height:1.5;padding:10px var(--s3);border:1px solid var(--line-strong);border-radius:var(--radius-m);background:var(--surface);color:var(--ink);resize:vertical;min-height:76px;transition:border-color var(--dur-fast) var(--ease-out)}
textarea:focus{outline:2px solid var(--accent);outline-offset:2px;border-color:var(--accent)}
.cf{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;justify-content:flex-end}
.cf .where{margin-right:auto;font-size:var(--text-xs);color:var(--muted)}
.receipt,.said-line{margin:0;font-size:var(--text-sm);color:var(--muted)}
.receipt.t-alert{color:var(--alert)}.receipt-box{display:grid;gap:var(--s2)}
.press-result{font-size:var(--text-sm)}.press-result .acts{margin-top:var(--s2)}.press-result:empty{display:none}.press-result.done{color:var(--done)}.press-result.alert{color:var(--alert)}
.press-result textarea{margin-top:var(--s2);font-size:var(--text-sm)}
.empty{display:grid;gap:var(--s1);padding:var(--s4)}
.empty p{margin:0}.empty .sub{font-size:var(--text-xs);color:var(--muted)}
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
.r-right{font-size:var(--text-xs);color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;max-width:9em;overflow:hidden;text-overflow:ellipsis}
.row-open{background:var(--current);border-radius:0 0 var(--radius-m) var(--radius-m);padding:var(--s1) var(--s2) var(--s3) calc(var(--s2) + 36px);display:grid;gap:var(--s3);min-width:0;opacity:0;transition:opacity var(--dur-base) var(--ease-out)}
.row.open .row-open{opacity:1}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:var(--s1)}
.steps li{display:grid;grid-template-columns:22px minmax(0,1fr);gap:var(--s2);align-items:baseline}
.steps .now .t{font-weight:600}
.steps .mk{text-align:center}
.t-quiet .short,.t-quiet .whole{color:var(--muted)}
.row-open details>summary{cursor:pointer;color:var(--muted);list-style:none}
.row-open details>summary::before{content:"▸ ";color:var(--muted)}.row-open details[open]>summary::before{content:"▾ "}
.row-open details>summary::-webkit-details-marker{display:none}
.acts{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center}
.s-doing,.k-input,.k-reply,.n-active{color:var(--accent)}
.s-waiting,.k-confirm,.k-choose,.n-waiting{color:var(--waiting-text)}
.s-blocked{color:var(--alert)}.s-done,.n-today{color:var(--done)}.s-running{color:var(--running)}.s-todo,.s-cancelled{color:var(--muted)}
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
#footer-theme{display:none}
#note{position:sticky;bottom:0;padding:var(--s3) 0;background:var(--ground);border-top:1px solid var(--line);overflow-wrap:anywhere}
#note:empty{display:none}#note.done{color:var(--done)}#note.alert{color:var(--alert)}
.lost{display:grid;gap:var(--s2);padding:var(--s3) var(--s4);border:1px solid var(--line-strong);border-radius:var(--radius-m)}
.lost .where{font-weight:600}
.notices{display:grid;gap:var(--s2)}.notices p{margin:0}
${CLIP_CSS}
@media (max-width:640px){
  .col{padding-left:max(var(--s3),env(safe-area-inset-left,0px));padding-right:max(var(--s3),env(safe-area-inset-right,0px))}
  .head{position:static}
  .agents{top:0}
  #offline:not(:empty){top:0}
  .live .lbl{display:none}.live{padding:var(--s1)}
  #header-theme{display:none}#footer-theme{display:block}
  .page,#board{gap:var(--s5)}
  .page{padding-top:var(--s4)}
  .card{padding:var(--s3)}
  .answers button,.answers .btn{flex:1 1 auto;min-height:48px;justify-content:flex-start}
  .answers button.quiet{flex:0 0 auto;min-height:44px}
  .btn,.acts button,.state button,.composer button,.shelf-head,.pfoot button,.seg button{min-height:44px}
  .link{min-height:44px}
  textarea{min-height:96px}
  .row-open{padding-left:var(--s2)}
}
${motionCss}
`

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
<header class="head" id="head"><div class="col topbar"><div class="brand">${boardMark}<h1>Agent Board</h1><span class="live" title="${esc(s.serveLiveHint)}"><i></i><span class="lbl">${esc(s.serveLive)}</span></span></div><div id="header-theme">${themeSwitch(s)}</div></div></header>
<div id="offline" role="status" aria-live="polite"></div>
<nav class="agents" id="agents" aria-label="${esc(s.pgAgents)}" hidden><div class="col agents-in" id="chips"></div><div class="col agent-note" id="agent-note"></div></nav>
<main class="col page">
<div id="board"></div>
<footer class="pfoot"><p id="versions"></p>${isLan ? `<p>${esc(s.serveLanIdle)}</p>` : idleMs > 0 ? `<p>${esc(s.serveIdleTimed(idleMs / 60_000))}</p>` : ''}<button type="button" id="close" data-static>${esc(s.serveClose)}</button><div id="footer-theme">${themeSwitch(s)}</div></footer>
<div id="note" role="status" aria-live="polite"></div>
</main>
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
  var opened = {};
  var timer = null;
  var isClosed = false;
  var isUnreachable = false;
  var offlineButtons = [];
  var since = null;
  var messageAttempts = {};
  var latest = null;
  var connections = [];
  ${filterStore}
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
  function resultSlot(card, key, revision, label) {
    card.setAttribute('data-card-key', key);
    var previous = results[key];
    if (previous && previous.awaitingRefresh) { previous.revision = revision; previous.awaitingRefresh = false; }
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
  // onCopied: what to do once the text is on the clipboard; the card then says where to paste it. Without it the
  // result line says Copied. That line, and the card's after-copy line, show only after a copy was confirmed
  // (the clipboard promise resolved, or the older copy command on a page the clipboard is closed to, such as
  // one opened over plain http on the network). If neither worked, the answer stays unanswered and one line in
  // the alert colour says so; a copy that carries no card (a command) shows its text to select instead.
  function copy(text, key, onCopied) {
    say(w('pressPending'), '', key);
    function landed() { if (onCopied) { delete results[key]; onCopied(); } else say(w('copied'), 'done', key); }
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
  function act(key, type, text, waiting, session, asked, fp, go) {
    if (isUnreachable) return Promise.resolve();
    busyOn(go);
    say(waiting || w('pressPending'), '', key);
    return call('/api/act', { key: key, type: type, text: text || '', session: session || '', asked: asked || '', fp: fp || '' }).then(function (data) {
      say(data.note || w(data.ok ? 'pressDone' : 'pressFailed'), data.ok ? 'done' : 'alert', key, undefined, type === 'send' && !data.ok);
      busyOff(go, data.ok);
      return data.ok;
    }, function () {
      say(w('serveOffline'), 'alert', key);
      busyOff(go, false);
      unreachable();
      return false;
    }).then(function (ok) { refresh(); return ok; });
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
  function receiptLine(receipt, key) {
    if (!receipt) return null;
    var labels = { queued: 'messagesQueued', uncertain: 'messagesUncertain', accepted: 'messagesAccepted', acknowledged: 'messagesAcknowledged', rejected: 'messagesRejected' };
    if (receipt.status === 'acknowledged' || receipt.status === 'rejected') Object.keys(messageAttempts).forEach(function (slot) { if (messageAttempts[slot].id === receipt.id) delete messageAttempts[slot]; });
    var reply = receipt.reply || '';
    var ack = 'ACK ' + receipt.id;
    if (reply.indexOf(ack) === 0 && (reply.length === ack.length || /\s/.test(reply.charAt(ack.length)))) reply = reply.slice(ack.length).trim();
    var isFailed = receipt.status === 'rejected' || receipt.status === 'uncertain' && /TIMEOUT/.test(receipt.error);
    var line = el('p', 'receipt' + (isFailed ? ' t-alert' : ''), w(receipt.status === 'uncertain' && /TIMEOUT/.test(receipt.error) ? 'messagesTimeout' : labels[receipt.status]) + (reply ? ' · ' + reply : ''));
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
    var go = mode === 'send' || mode === 'connected'
      ? button(w('serveSend', agentName(agent)), function () {
        var text = input.value.trim();
        if (!text) { say(w('pressEmpty'), 'alert', key); return; }
        // The same text goes again through the same path; the box keeps it until it was sent.
        var run = function () {
          var sent = mode === 'connected' ? nativeAct(key, text, delivery, session, asked, fp, go) : act(key, 'send', text, w('serveSending', agentName(agent)), session, asked, fp, go);
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
    if (isSending === true && !results[key]) add(box, el('p', 'receipt', w('serveSendBusy', agentName(agent))));
    if (where) add(footer, el('div', 'where', where));
    if (extras && extras.onCancel) add(footer, navButton(w('pgCancel'), extras.onCancel));
    add(box, input, add(footer, go));
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
  var pg = { filter: '', chips: {}, ids: [], model: null, sources: {}, order: {}, lis: [], groups: [], drafts: {}, shown: {}, nodes: {}, items: {}, hasOlder: false, mores: [], cardNodes: {}, cardList: null, rowKeys: {} };
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
  function ageOf(ref) { return clean(source(ref).when || w('pgUnknownAge')); }
  // 'own' for the person's hand-kept tasks, '?' for a finished task whose agent the model did not say.
  function agentOf(ref) { return source(ref).isOwn || ref.isOwn ? 'own' : ref.agent || '?'; }
  function markOf(ref) {
    var id = agentOf(ref);
    return agentMark(id === 'own' ? '' : id === '?' ? '?' : ref.agent);
  }
  function nameOf(id) { return id === 'own' ? w('pgOwn') : agentName(id); }
  function matches(id) { return !pg.filter || pg.filter === id; }
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
    var isAfter = state.mode === 'copied' || state.mode === 'sent';
    reveal(parts.after, isAfter);
    if (!isAfter) return;
    parts.msg.textContent = state.mode === 'sent' ? w('pgSentTo', agentName(parts.agent), state.text) : parts.canHide ? w(parts.offline ? 'pgPasteLater' : 'pgPasteIn', state.text, agentName(parts.agent)) : w('copied');
    parts.answered.hidden = state.mode !== 'copied' || !parts.canHide;
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
      add(line, el('span', 'mk s-' + step.status, GLYPH[step.status] || '○'), clipped(clean(step.line || whole), whole, cls, 'step:' + row.key + ':' + row.steps.indexOf(step)));
      if (row.isOwn && step.status !== 'done' && step.status !== 'cancelled') add(line, button(w('serveTickNext', clean(step.text)), function () { act(row.key, 'tick', step.text, '', '', '', row.fp); }));
      add(list, line);
    });
    return list;
  }
  function plural(key, n) { return w(n === 1 ? key + 'One' : key, n); }
  function folded(label, list) {
    var box = el('details');
    return add(box, el('summary', '', label), list);
  }
  function sends(mode) { return mode === 'send' || mode === 'connected'; }
  // One question or stuck task on the Needs you sheet, answerable where it is.
  function buildCard(ref) {
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
    if (!isStuck && ask.command) add(body, el('code', '', '$ ' + ask.command));
    var mode = ask.send;
    var answers = el('div', 'answers');
    var others = [];
    var canWrite = false;
    if (isStuck) {
      if (ask.resume) add(answers, button(w('serveCopyResume'), function () { copy(ask.resume, key); }, '', true));
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
      if (ask.canHide) others.push(button(w('answeredHide'), function () { act(key, 'hide'); }));
    }
    var parts = { agent: agent, canHide: ask.canHide === true, offline: agentPresence[id] === 'offline' };
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
        onDone: function (value) { setMode(key, sends(mode) ? 'sent' : 'copied', value); },
      }), false);
    } else parts.reply = fx(el('div'), false);
    var after = el('div', 'state');
    after.setAttribute('role', 'status');
    parts.msg = el('span', 'msg ok');
    parts.answered = button(w('pgAnswered'), function () { act(key, 'hide'); }, 'primary');
    parts.again = button(w('pgCopyAgain'), function () {
      var state = cardState[key];
      if (state) copy(state.text, key);
    }, 'quiet', true);
    add(after, add(el('span', 'mk ok', '✓')), parts.msg, parts.answered, parts.again);
    parts.after = fx(after, false);
    add(body, parts.ask, parts.reply, parts.after);
    paintMode(key);
    if (ask.receipt) add(body, receiptLine(ask.receipt, key));
    resultSlot(body, key, ask.fp || ask.text, ask.task || ask.title || ref.repo);
    add(card, body);
    return card;
  }
  function pressAnswer(ask, key, answer, node) {
    var mode = ask.send;
    if (mode !== 'connected' && mode !== 'send') { copy(answer, key, function () { setMode(key, 'copied', answer); }); return; }
    var run = function () {
      var sent = mode === 'connected' ? nativeAct(key, answer, ask.delivery, ask.session, ask.text, ask.fp, node || el('button')) : act(key, 'send', answer, w('serveSending', agentName(ask.agent)), ask.session, ask.text, ask.fp, node);
      return sent.then(function (ok) { if (ok) setMode(key, 'sent', answer); return ok; });
    };
    sentLast[key] = { text: answer, again: run };
    run();
  }
  // A task as one row: its mark, title, one line (the step, with the project where no heading stands above it,
  // and a status word only when the section does not already say it) and its age. Pressing it opens its steps and
  // actions in place; the message box for a connected or sendable session is inside the open row.
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
      if (row.isOwn && section !== 'done' && row.next) add(acts, button(w('serveTickNext', clean(row.nextLabel || row.next)), function () { act(key, 'tick', row.next, '', '', '', row.fp); }, 'primary'));
      if (row.resume && !row.isOwn) add(acts, button(w('serveCopyResume'), function () { copy(row.resume, key); }, '', true));
      if (row.canArchive) add(acts, button(w('serveArchive'), function () { act(key, 'archive', '', '', '', '', row.fp); }));
      if (row.canConfirm && section !== 'done') add(acts, button(w('confirmDone'), function () { act(key, 'done', '', '', '', '', row.fp); }));
      if (acts.firstChild) add(inner, acts);
      if (row.receipt) add(inner, receiptLine(row.receipt, key));
      if (row.info) add(inner, el('p', 'context', row.info));
    } else (row.questions || []).forEach(function (question) { add(inner, el('p', 'context', clean(question))); });
    var isExpandable = inner.childNodes.length > 0;
    if (isExpandable) resultSlot(inner, key, row.fp, row.title || row.task);
    var current = steps.filter(function (one) { return one.isCurrent; })[0] || steps.filter(function (one) { return one.status !== 'done' && one.status !== 'cancelled'; })[0];
    var step = current ? clean(current.text) : '';
    var detail = !step ? '' : section === 'working' ? step : section === 'others' ? w('pgLast', step) : section === 'stopped' ? w('pgStoppedAt', step) : '';
    var status = ref.kind === 'stuck' || row.stuck ? w('pgStuck') : row.isOwn && section !== 'done' && section !== 'stopped' ? w('pgTodo') : '';
    var project = showProject ? clean(ref.repo || row.project) : '';
    var meta = add(el('span', 'r-meta'), status ? el('span', 'st', status) : null, project ? el('span', '', project) : null, detail ? el('span', '', detail) : null);
    var title = clean(fullTitle(ref));
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
    add(head, markOf(ref), add(el('span', 'r-text'), titleNode, meta), el('span', 'r-right', ageOf(ref)), el('span', 'r-chev'));
    var block = el('div', 'fx');
    add(block, add(el('div', 'fx-in'), head, isExpandable ? fold : null));
    add(li, block);
    return { li: li, block: block };
  }
  function setText(node, text) { if (node && node.textContent !== String(text)) node.textContent = String(text); }
  // The pieces of the agent row: one icon button per agent on the board and one for the person's own to-dos.
  // Whether an agent can be reached from here: connected (a session of it has a delivery connection), open (a
  // session is open in its own window, or it worked in the last 30 minutes) or offline (neither).
  function presenceMap(view) {
    var map = {};
    pg.ids.forEach(function (id) {
      var state = 'offline';
      var hasSession = Object.keys(pg.sources).some(function (key) {
        var one = pg.sources[key];
        return one && String(one.agent || 'claude').toLowerCase() === id && (one.send === 'open' || one.send === 'claude');
      });
      if (connections.some(function (one) { return String(one.agent || '').toLowerCase() === id; })) state = 'connected';
      else if (hasSession || view.working.some(function (ref) { return agentOf(ref) === id; })) state = 'open';
      map[id] = state;
    });
    return map;
  }
  function chipLabel(entry) {
    var parts = [];
    if (entry.presence === 'offline') parts.push(w('pgOffline'));
    if (entry.needs > 0) parts.push(w('pgTipNeeds', entry.needs));
    if (entry.working > 0) parts.push(w('pgTipWorking', entry.working));
    if (entry.unreadable) parts.push(w('pgTipCantRead'));
    return entry.name + ': ' + (parts.length ? parts.join(', ') : w('pgChipEmpty'));
  }
  function drawChips(view) {
    var nav = document.getElementById('agents');
    var row = document.getElementById('chips');
    var entries = [];
    // Your to-dos come first, before every agent; the agents follow in their usual order.
    if (Object.keys(view.own.counts).some(function (key) { return view.own.counts[key] > 0; })) entries.push({ id: 'own', name: w('pgOwn'), agent: '', needs: view.own.counts.needs, working: 0, unreadable: false });
    pg.ids.forEach(function (id) {
      var group = view.agents.filter(function (one) { return one.agent === id; })[0];
      if (!group) return;
      entries.push({ id: id, name: agentName(id), agent: id, needs: group.counts.needs, working: view.working.filter(function (ref) { return agentOf(ref) === id; }).length, unreadable: group.isUnreadable, presence: agentPresence[id] });
    });
    if (pg.filter && !entries.some(function (one) { return one.id === pg.filter; })) pg.filter = '';
    nav.hidden = entries.length === 0;
    var ids = entries.map(function (one) { return one.id; });
    Object.keys(pg.chips).forEach(function (id) {
      if (ids.indexOf(id) === -1) { pg.chips[id].node.remove(); delete pg.chips[id]; }
    });
    entries.forEach(function (entry) {
      var chip = pg.chips[entry.id];
      if (!chip) {
        var node = navButton('', function () { setFilter(pg.filter === entry.id ? '' : entry.id); });
        node.className = 'chip';
        node.setAttribute('data-agent', entry.id);
        chip = pg.chips[entry.id] = { node: node, name: el('span', 'c-name'), badge: null };
        add(node, agentMark(entry.agent), chip.name);
        if (entry.id === 'own' && row.firstChild) row.insertBefore(node, row.firstChild);
        else add(row, node);
      }
      var label = chipLabel(entry);
      chip.node.setAttribute('aria-label', label);
      chip.node.setAttribute('title', label);
      chip.node.className = 'chip' + (entry.working > 0 ? ' working' : '') + (entry.presence === 'offline' ? ' offline' : '');
      setText(chip.name, entry.presence === 'offline' ? entry.name + ' · ' + w('pgOffline') : entry.name);
      var text = entry.unreadable ? '!' : entry.needs > 0 ? String(entry.needs) : '';
      if (text && !chip.badge) { chip.badge = el('span', 'badge'); chip.node.appendChild(chip.badge); }
      if (!text && chip.badge) { chip.node.removeChild(chip.badge); chip.badge = null; }
      if (chip.badge) { setText(chip.badge, text); chip.badge.className = 'badge' + (entry.unreadable ? ' bad' : ''); }
      chip.unreadable = entry.unreadable;
      chip.title = entry.name;
    });
    paintFilter();
    drawNote(entries);
  }
  function paintFilter() {
    Object.keys(pg.chips).forEach(function (id) { pg.chips[id].node.setAttribute('aria-pressed', String(pg.filter === id)); });
  }
  // The line under the row for an agent the board cannot read: while that agent is pressed, or for all of them when nothing is.
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
    var count = { cards: 0, older: 0, working: 0, others: 0, stopped: 0, done: 0 };
    pg.lis.forEach(function (one) {
      one.show = matches(one.id);
      if (one.show) count[one.list] += 1;
      reveal(one.block, one.show);
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
    reveal(pg.nodes.needsEmpty, count.cards === 0);
    reveal(pg.nodes.workingEmpty, count.working === 0 && !pg.filter);
    // The line counts every older question the filter allows, drawn or not.
    if (pg.olderRefs) count.older = pg.olderRefs.filter(function (ref) { return matches(agentOf(ref)); }).length;
    if (pg.nodes.olderLine) setText(pg.nodes.olderLine, plural('pgOlder', count.older));
    reveal(pg.nodes.olderBlock, count.older > 0);
    Object.keys(pg.nodes.counts).forEach(function (name) { setText(pg.nodes.counts[name], name === 'done' ? w('pgDoneWeek', count.done) : count[name]); });
    pg.sections.forEach(function (section) { reveal(section.block, count[section.list] > 0 || section.list === 'working' && !pg.filter); });
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
    var one = { li: li, block: block, id: agentOf(ref), list: list, show: true, key: ref.key };
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
    return add(el('div', 'sec-head'), el('h2', '', title), count);
  }
  function needsSection(view) {
    var wrap = el('section', 'needs-wrap');
    wrap.id = 'needs';
    var flag = el('h2', 'flag', w('pgNeeds'));
    var total = el('b', '', String(view.needs.n));
    add(flag, total);
    flag.setAttribute('data-needs-count', String(view.needs.n));
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
        add(block, add(el('div', 'fx-in'), buildCard(ref)));
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
    return refs.length ? sec : null;
  }
  // A closed shelf: Stopped and Done list their rows flat, so each row names its project.
  function shelf(name, title, refs, section, extra) {
    if (!refs.length && !extra) return null;
    var box = el('section', 'shelf' + (opened['shelf:' + name] ? ' open' : ''));
    var count = el('span', 'count');
    pg.nodes.counts[name] = count;
    var fold = el('div', 'fold');
    fold.inert = opened['shelf:' + name] !== true;
    var head = navButton('', function () {
      var now = !hasClass(box, 'open');
      toggleClass(box, 'open', now);
      head.setAttribute('aria-expanded', String(now));
      fold.inert = !now;
      opened['shelf:' + name] = now;
    });
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
    if (!ids.length) { push('claude'); push('codex'); }
    return ids;
  }
  // The empty board: the agents that can report here, and how their work shows up.
  function freshPage(view) {
    var ids = connectedIds(view);
    var list = el('ul');
    ids.forEach(function (id) {
      add(list, add(el('li'), agentMark(id), add(el('span'), el('b', '', agentName(id)), el('span', 'ok', ' ✓ ' + w('pgConnected')))));
    });
    return add(el('section', 'fresh'), el('h2', '', w('pgReady')), list, el('p', '', w('pgStartIn', ids.map(agentName).join(' / '))));
  }
  function sectionBlock(section, list) {
    var block = fx(section);
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
    document.title = view.needs.n ? w('pgTabTitle', view.needs.n) : 'Agent Board';
    var version = view.versions;
    document.getElementById('versions').textContent = !version.package || version.package === version.board ? w('pgVersion', version.board) : w('pgVersions', version.board, version.package);
    var priorCards = pg.cardNodes;
    var priorOrder = pg.order.cards || [];
    var priorRows = pg.rowKeys;
    pg.lis = [];
    pg.groups = [];
    pg.sections = [];
    pg.mores = [];
    pg.nodes = { counts: {} };
    pg.cardNodes = {};
    cardParts = {};
    var closeSlot = resultSlots.close;
    resultSlots = {};
    if (closeSlot) resultSlots.close = closeSlot;
    agentPresence = presenceMap(view);
    drawChips(view);
    var parts = [];
    if (model.warning) parts.push(el('p', 't-alert', model.warning));
    var hasOwn = Object.keys(view.own.counts).some(function (key) { return view.own.counts[key] > 0; });
    if (!view.agents.length && !hasOwn) parts.push(freshPage(view));
    else {
      var workingKeys = {};
      parts.push(needsSection(view));
      parts.push(sectionBlock(workingSection(view, workingKeys), 'working'));
      var others = othersSection(view, workingKeys);
      if (others) parts.push(sectionBlock(others, 'others'));
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
  if (typeof ResizeObserver === 'function' && document.documentElement) {
    var head = document.getElementById('head');
    new ResizeObserver(function () { document.documentElement.style.setProperty('--head-h', head.offsetHeight + 'px'); }).observe(head);
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
  refresh();
})();
`

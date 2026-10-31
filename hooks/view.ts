import type { ProgressAuto, ProgressMirror, ProgressProject, ProgressStep, ProgressStepStatus, ProgressTask, QuestionRecord } from '../types'
import { askOf, askRank } from './ask'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { agentLabel } from './strings'
import type { AskKind } from './ask'
import { confirmKey, shortId, stepWords, upsertAutoBlock } from './blocks'
import type { ConfirmRef } from './blocks'
import { ciWords, prWords } from './github'
import { doingTask, fallbackTitle, isAnswered, waitsOnYou } from './mirror'
import type { Tone } from './palette'
import { countSteps, currentStepIndex, doneKey, FUTURE_SKEW_MS, futureTimeKey, isHereProject, isMarksComplete, isStale, isTaskComplete, observedTime, parseProgress, RESUME } from './parse'
import { sha256 } from './sha256'
import { observeQuestions, pendingQuestionSlot, questionScope, questionSlot, questionWords, sourceSnapshot } from './questions'
import type { QuestionLedger, QuestionProofs } from './questions'
import { questionAge } from './question-aging'
import { closedCopies, mergeCopies, recordFolder } from './question-merge'
import { foldRuns, mergeGroups, sessionIdentity, startersOf } from './runs'
import type { RunGroup } from './runs'
import type { PendingTurn } from './board'

// What the pane shows, worked out from the file and this session's own list, so the
// drawing code only lays it out.

export type { Tone }

// `number` is the step's place in its list (1-based), null on a folded summary line; `note`
// is what follows ` — ` in the step: what it waits on, why it is stuck.
export type ViewStep = {
  text: string
  note: string
  status: ProgressStepStatus
  depth: number
  isCurrent: boolean
  number: number | null
}

export type CurrentView = {
  state: ProgressMirror['state']
  project: string
  branch: string
  title: string
  // One line of background, '' when there is none.
  context: string
  status: string
  tone: Tone
  done: number
  total: number
  steps: ViewStep[]
  // The runs this session started for itself, as one line; absent when it started none (#399).
  runs?: string
}

// A step of a hand-kept task, addressed so a press can tick exactly the line it showed.
export type StepRef = { project: string; title: string; step: string; line: number; raw: string }

// What a row's 封存 press takes out: a session's block by its id, or a hand-kept task by its
// heading line, checked against the title so a task that moved is still found once.
// `isDuplicate` marks the older block of two for one session (#399): its archive is allowed
// while it still looks live, once the file shows a newer block for the same agent and id.
export type TaskRef = { project: string; title: string; line: number; session: string | null; resume?: string | null; isDuplicate?: true }

// Another agent's session, as its block names it: its block id, the session id its hook gave
// (`resume=`), the folder it ran in (`dir=`), and whether it has closed (`state=ended`). The
// board's page can send a reply into a closed Grok Build or Codex session; the pane does not.
export type AgentTarget = { agent: string; session: string; resume: string | null; dir: string | null; isClosed: boolean }

const targetOf = (auto: ProgressAuto | null): AgentTarget | null =>
  auto === null || auto.agent === 'claude'
    ? null
    : { agent: auto.agent, session: auto.session, resume: auto.resume, dir: auto.dir, isClosed: auto.state === 'ended' }

export type WaitingItem = {
  questionId?: string
  ageStage?: 'pending' | 'reminder' | 'older'
  nativeSession?: string
  at?: number
  dir?: string | null
  key: string
  project: string
  // The task it belongs to, its background, and what it needs from the person.
  task: string
  context: string
  text: string
  note: string
  when: string
  // What kind of answer it wants, and what the pane can offer for it (see ask.ts).
  kind: AskKind
  options: string[]
  command: string | null
  link: string | null
  // here: this session's, answered from the pane · other: another live session's, answered
  // there · manual: a hand-kept step, ticked from the pane
  where: 'here' | 'other' | 'manual'
  // The agent of another session's block when it is not Claude, else ''.
  agent: string
  // The block id of the session that asked, named in the reply hint: several sessions often
  // share one folder, so the folder alone does not say where to answer. '' for a hand-kept step.
  session: string
  // The asking session's own id, for the person to copy and find that session in its agent: its
  // `resume=`, else for Claude Code its block id; null when the block left none, and for this
  // session's and hand-kept items. Anyone can write `session=`, so a block id that is not a plain
  // id is never offered for the clipboard.
  sessionId: string | null
  // How that agent reopens a session by this id (`codex resume`), when the id is the agent's own
  // and its command is known; null otherwise.
  resumeVia: string | null
  // That command whole, in the session's folder, ready to paste; null when there is none.
  reopen: string | null
  // What the person's Answered press keeps, to hide the question until the session asks
  // something else (`answeredKey`); '' for a hand-kept step, which is ticked instead.
  hideKey: string
  // A retained source without a current producer is available for review, not a new hide. One kept
  // from an archived block can be hidden (#400): hiding writes only the hidden list, never the source.
  canHide?: boolean
  // Kept for review after its session's block was archived: nothing is running that could be archived.
  isKept?: true
  // A hand-kept step can be ticked from the pane; another session's cannot.
  step: StepRef | null
  // Another agent's session the question came from; null for Claude's and hand-kept ones.
  target: AgentTarget | null
}

// The one thing the top of the pane puts in front of the person: the most pressing thing
// they can act on, chosen in this order: something to answer or do now, work due today or
// overdue, something stuck, then something that waits on someone else.
export type Focus =
  | { type: 'ask'; item: WaitingItem }
  | { type: 'due'; row: TaskRow }
  | { type: 'blocked'; row: TaskRow }

export type TaskRow = {
  nativeSession?: string
  at?: number
  dir?: string | null
  key: string
  project: string
  title: string
  context: string
  done: number
  total: number
  status: string
  tone: Tone
  when: string
  hasFutureTime?: boolean
  isHere: boolean
  auto: 'working' | 'waiting' | 'ended' | null
  steps: ViewStep[]
  // Every open step, unfolded: what a take-over hands on.
  left: string[]
  next: StepRef | null
  due: { date: string; left: string; tone: Tone } | null
  // Another session's pull request, in words (`PR #12 · CI 失敗`), or ''.
  pr: string
  // The agent whose block this is, when it is not Claude (`codex`), else ''.
  agent: string
  // For an ended session: the command that reopens it, ready to paste.
  resume: string | null
  // The question its session still asks the person, as Waiting on you words it; null when none
  // does or the person marked it answered. A reply to the session is framed as its answer.
  question: string | null
  questions?: WaitingItem[]
  // The line its session left at its last compaction for whoever takes over.
  handoff: string
  // Set when the person may take the row out now: a hand-kept task, or a block whose session
  // ended or stopped. A live session's block is that session's to change.
  archive: TaskRef | null
  confirm?: ConfirmRef | null
  // Another agent's session the row is; null for Claude's and hand-kept ones.
  target: AgentTarget | null
  // The runs this session started for itself, as one line (`+3 runs by Codex, last 20 min ago`);
  // absent when it started none (#399).
  runs?: string
}

// This session's pull request, for the card.
export type PrView = { text: string; url: string; tone: Tone }

export type DoneItem = { key: string; project: string; title: string; when: string; questions?: WaitingItem[] }

// Other work, one group per project, this session's project first; `summary` says it in a
// line (`3 件 · 1 等你 · 1 已停`) for while the list is folded.
export type RowGroup = { project: string; isHere: boolean; rows: TaskRow[]; summary: string }

// The line of counts at the top: what waits on you (here and elsewhere), what is open,
// what is due within two weeks (the 快到期 list), and the steps finished today.
export type Overview = { waiting: number; active: number; due: number; today: number; idle: number; stopped: number }

export type View = {
  warning?: string
  // The size warning's numbers and finished hand-kept tasks Clean up can archive (#464).
  details?: string
  // The size warning is up.
  isLarge?: true
  // A size warning or due finished tasks make Clean up available on the page and pane.
  isCleanable?: true
  // What the board cleared in the last 7 days (retention.ts); absent when it cleared nothing.
  pruned?: string
  current: CurrentView | null
  pr: PrView | null
  overview: Overview
  focus: Focus | null
  waiting: WaitingItem[]
  // Questions the person marked answered, until their session asks something else.
  hidden: WaitingItem[]
  reminder?: WaitingItem[]
  older?: WaitingItem[]
  // Unanswered questions of stopped sessions, each counted once; Waiting shows one line.
  stoppedAsking?: number
  hasPendingQuestions?: boolean
  // The runs agents started for themselves that no session is known for, as one folded line
  // (`Background runs: 4, last 20 min ago`); absent when there are none (#399).
  background?: string
  idle: TaskRow[]
  stopped: TaskRow[]
  due: TaskRow[]
  active: TaskRow[]
  groups: RowGroup[]
  recent: DoneItem[]
  finished?: Array<DoneItem & { at: number; agent: string; isOwn?: true; dir: string | null }>
  unreadable?: string[]
  health?: string[]
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
export const IDLE_MS = 7 * DAY
export const OLDER_SHOWN = 10

export const relativeTime = (then: number, now: number, s: Strings = ZH_TW): string => {
  if (then <= 0) return ''
  const gap = Math.max(0, now - then)
  if (gap < MINUTE) return s.justNow
  if (gap < HOUR) return s.minutesAgo(Math.floor(gap / MINUTE))
  if (gap < DAY) return s.hoursAgo(Math.floor(gap / HOUR))
  if (gap < 2 * DAY) return s.yesterday

  return s.daysAgo(Math.floor(gap / DAY))
}

// `10-31` or `2026-10-31`; a date with no year is the nearest one, at most two months back.
export const dueDays = (due: string, now: number): number | null => {
  const parts = due.split('-').map(Number)
  const today = new Date(now)
  const [year, month, day] =
    parts.length === 3 ? parts : [today.getUTCFullYear(), parts[0] ?? Number.NaN, parts[1] ?? Number.NaN]
  if (year === undefined || month === undefined || day === undefined) return null
  if ([year, month, day].some(Number.isNaN)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  let target = Date.UTC(year, month - 1, day)
  if (parts.length === 2 && target < midnight - 60 * DAY) target = Date.UTC(year + 1, month - 1, day)

  return Math.round((target - midnight) / DAY)
}

const dueLabel = (days: number, s: Strings): { left: string; tone: Tone } => {
  if (days < 0) return { left: s.overdue(-days), tone: 'alert' }
  if (days === 0) return { left: s.dueToday, tone: 'alert' }
  if (days <= 3) return { left: s.daysLeft(days), tone: 'alert' }

  return { left: s.daysLeft(days), tone: days <= 7 ? 'soon' : 'quiet' }
}

// `推薦信 — 等教授回覆` is the step 推薦信 with the note 等教授回覆.
export const splitNote = (text: string): { text: string; note: string } => {
  const at = text.indexOf(' — ')
  return at < 0 ? { text, note: '' } : { text: text.slice(0, at).trim(), note: text.slice(at + 3).trim() }
}

const DUE_WORDS = /(?:截止|\bdue)[:：\s]*(?:\d{4}[-/])?\d{1,2}[-/]\d{1,2}/gi
// A block's background note, in any language the pane writes: 背景： / Context: / Background:
const CONTEXT = /^(?:背景|Context|Background)\s*[:：]\s*/i

// A block's handoff note, written at its session's last compaction: 交接： / Handoff:
const HANDOFF = /^(?:交接|Handoff)\s*[:：]\s*/i

export const handoffOf = (task: ProgressTask): string => task.notes.find(note => HANDOFF.test(note))?.replace(HANDOFF, '') ?? ''

// A task's background: its `> 背景：` line; for a hand-kept task, its other notes.
export const contextOf = (task: ProgressTask): string => {
  const marked = task.notes.find(note => CONTEXT.test(note))
  if (marked !== undefined) return marked.replace(CONTEXT, '')
  if (task.auto !== null) return ''

  return task.notes
    .filter(note => !HANDOFF.test(note))
    .map(note => note.replace(DUE_WORDS, '').replace(/^[\s·・,，]+|[\s·・,，]+$/g, ''))
    .filter(note => note !== '')
    .join(' · ')
}

// A row cannot certify a different cached task, even when their clocks tie. Compare
// the owner's rendered meaning; translated lifecycle prose is not task content.
export const mirrorMatchesTask = (mirror: ProgressMirror, project: string, task: ProgressTask, s: Strings = ZH_TW): boolean => {
  const rendered = parseProgress(upsertAutoBlock('', mirror, s))[0]
  const source = rendered?.tasks[0]
  if (source === undefined || rendered?.name !== project || source.auto?.session !== task.auto?.session || source.auto?.agent !== task.auto?.agent) return false
  const steps = (one: ProgressTask): string => JSON.stringify(one.steps.filter(step => step.status !== 'cancelled').map(step => [step.text, step.status, step.depth]))
  return source.title === task.title && steps(source) === steps(task) && contextOf(source) === contextOf(task) && handoffOf(source) === handoffOf(task)
}

// `isAsked` leaves out a question the person marked answered.
const stepPhrase = (task: ProgressTask, s: Strings, isAsked: (index: number) => boolean = () => true): { status: string; tone: Tone } => {
  const blocked = task.steps.find(step => step.status === 'blocked')
  if (blocked !== undefined) return { status: s.stuck(splitNote(blocked.text).text), tone: 'alert' }
  const waiting = task.steps.find((step, index) => step.status === 'waiting' && isAsked(index))
  if (waiting !== undefined) return { status: s.waitsOnYou(splitNote(waiting.text).text), tone: 'warn' }
  const running = task.steps.find(step => step.status === 'running')
  if (running !== undefined) return { status: s.runningStep(splitNote(running.text).text), tone: 'running' }
  const current = task.steps[currentStepIndex(task)]
  if (current === undefined) return { status: s.noSteps, tone: 'quiet' }

  return { status: current.status === 'doing' ? s.doingStep(current.text) : s.nextStep(current.text), tone: 'quiet' }
}

// Every status a glyph carries is also said in words.
const suffixOf = (status: ProgressStepStatus, s: Strings): string => {
  if (status === 'cancelled') return s.suffixCancelled
  if (status === 'waiting') return s.suffixWaiting
  if (status === 'running') return s.suffixRunning
  if (status === 'blocked') return s.suffixBlocked

  return ''
}

// Long lists keep the open steps in view: finished ones fold into one line, and past
// `room` open steps the rest fold into a count.
export const foldSteps = (steps: readonly ViewStep[], room = 6, s: Strings = ZH_TW): ViewStep[] => {
  if (steps.length <= room + 1) return [...steps]
  const done = steps.filter(step => step.status === 'done' || step.status === 'cancelled')
  const open = steps.filter(step => step.status !== 'done' && step.status !== 'cancelled')
  const shown = open.slice(0, room)
  const rest = open.length - shown.length

  return [
    ...(done.length === 0
      ? []
      : [{ text: s.foldedDone(done.length), note: '', status: 'done' as const, depth: 0, isCurrent: false, number: null }]),
    ...shown,
    ...(rest === 0 ? [] : [{ text: s.foldedRest(rest), note: '', status: 'todo' as const, depth: 0, isCurrent: false, number: null }]),
  ]
}

const currentOf = (mirror: ProgressMirror, s: Strings): CurrentView | null => {
  if (mirror.tasks.length === 0) return null
  const doing = doingTask(mirror)
  const waitingYou = mirror.tasks.find(task => waitsOnYou(mirror, task))
  const blocked = mirror.tasks.find(task => task.status !== 'completed' && task.blocked !== null)
  const done = mirror.tasks.filter(task => task.status === 'completed' && !task.handoffTo).length
  let status = s.waitingReply
  let tone: Tone = 'warn'
  if (mirror.state === 'done') {
    status = s.allDone
    tone = 'quiet'
  } else if (waitingYou !== undefined) {
    status = s.waitsOnYou(waitingYou.subject)
  } else if (blocked !== undefined) {
    status = s.stuck(blocked.blocked || blocked.subject)
    tone = 'alert'
  } else if (mirror.state === 'working') {
    status = doing === undefined ? ((mirror.backgroundJobs ?? 0) > 0 && !mirror.isTurnRunning ? s.backgroundRunning : s.claudeWorking) : s.doingStep(doing.activeForm || doing.subject)
    tone = 'accent'
  }
  const steps = mirror.tasks.map((task, index) => {
    const hasAnswer = isAnswered(mirror, task)
    let stepStatus: ProgressStepStatus = task.handoffTo ? 'cancelled' : task.status === 'completed' ? 'done' : 'todo'
    if (task.status !== 'completed') {
      if (task.blocked !== null) stepStatus = 'blocked'
      else if (task.waiting === 'you' && !hasAnswer) stepStatus = 'waiting'
      else if (task.waiting === 'run') stepStatus = 'running'
      else if (task.status === 'in_progress') stepStatus = 'doing'
    }
    const note = task.handoffTo ? s.transferredTo(task.handoffTo) : stepStatus === 'blocked' ? (task.blocked ?? '') : stepStatus === 'done' ? '' : hasAnswer ? s.answeredNote : (task.why ?? '')
    return {
      text: `${task.subject}${suffixOf(stepStatus, s)}`,
      note,
      status: stepStatus,
      depth: 0,
      isCurrent: task === doing,
      number: index + 1,
    }
  })

  return {
    state: mirror.state,
    project: mirror.project,
    branch: mirror.branch,
    title: mirror.title || fallbackTitle(mirror),
    context: contextFor(mirror),
    status,
    tone,
    done,
    total: mirror.tasks.filter(task => !task.handoffTo).length,
    steps: foldSteps(steps, 6, s),
  }
}

// How each agent reopens one of its sessions by the id its hook reports: the words before the
// id. Only where that id is the one the command takes; other agents' ids are offered to find the
// session in their own list.
// A Map, so an agent named like an object's own property (`constructor`) finds nothing.
const RESUME_VIA: ReadonlyMap<string, string> = new Map([
  ['claude', 'claude --resume'],
  ['codex', 'codex resume'],
  ['grok', 'grok -r'],
  ['gemini', 'gemini --resume'],
  ['hermes', 'hermes --resume'],
  ['opencode', 'opencode -s'],
])

export const resumeVia = (agent: string): string | null => RESUME_VIA.get(agent === '' ? 'claude' : agent) ?? null

// How another agent's session is named at a glance: the start of its own id, or for an id in
// parts (Hermes Agent's date_time_code, OpenCode's ses_…) the start of its last part, since the
// first part is the same for many sessions.
const sessionName = (id: string): string => {
  const last = id.slice(id.lastIndexOf('_') + 1)
  return shortId(last === '' ? id : last)
}

// The agent as the person knows it, in the words that tell them where to look.
export const agentName = (agent: string): string => (agent === '' || agent === 'claude' ? 'Claude Code' : agent)

// User-facing hints name tasks and agents. Exact ids stay in internal bindings and in the
// resume command copied on demand. `withCommand` false omits it on the LAN page. `hasBrand`: the
// agent is named by its brand name (the pane and the page), else by its slug (the terminal board).
export type ReplyHint = { where: string; back: string; note: string; reopen: string | null }
export const replyHint = (item: WaitingItem, s: Strings, withCommand = true, hasBrand = false): ReplyHint => {
  if (item.where !== 'other') return { where: '', back: '', note: '', reopen: null }
  const reopen = withCommand && item.sessionId !== null ? item.reopen : null

  return {
    where: s.replyElsewhere(item.task, '', hasBrand ? agentLabel(item.agent, s) : item.agent),
    back: '',
    note: '',
    reopen,
  }
}

// The way back as one run of words, for a surface that wraps them; a Chinese sentence runs on
// after its full stop with no space.
export const wayBackText = (hint: ReplyHint): string =>
  hint.note === '' ? hint.back : `${hint.back}${hint.back.endsWith('。') ? '' : ' '}${hint.note}`

// Reopens an ended session where it ran: PowerShell for a Windows folder, a POSIX shell
// otherwise. Both quote the folder, so spaces and quotes in it survive; PowerShell takes the
// curly single quotes for quotes too, so those are doubled as well. A folder that is not a
// whole path is left out, so `cd` never reads it as a flag (`-`). Null for an agent whose
// resume by id is not known.
export const resumeCommand = (sessionId: string, dir: string | null, agent = 'claude'): string | null => {
  const via = resumeVia(agent)
  if (via === null) return null
  const resume = `${via} ${sessionId}`
  if (dir === null || dir === '') return resume
  if (/^[A-Za-z]:[\\/]|\\/.test(dir)) return `Set-Location -LiteralPath '${dir.replace(/['\u2018-\u201b]/g, '$&$&')}'; ${resume}`
  if (!dir.startsWith('/')) return resume

  return `cd '${dir.replace(/'/g, "'\\''")}' && ${resume}`
}

const autoPr = (auto: ProgressAuto | null, s: Strings): string => {
  if (auto === null || auto.pr === null) return ''
  return [`PR #${auto.pr}`, ciWords(auto.ci, 0, s)].filter(part => part !== '').join(' · ')
}

const prView = (mine: ProgressMirror | null, s: Strings): PrView | null => {
  const pr = mine?.pr ?? null
  if (pr === null) return null
  const tone: Tone =
    pr.state !== 'open'
      ? 'quiet'
      : pr.ci === 'fail'
        ? 'alert'
        : pr.review === 'changes'
          ? 'warn'
          : pr.ci === 'pending'
            ? 'accent'
            : 'quiet'

  return { text: prWords(pr, s), url: pr.url, tone }
}

// Until the model writes a background, the request itself stands in, cut to one line.
const firstLine = (text: string): string => {
  const line = text.split(/\r?\n/).find(one => one.trim() !== '')?.trim() ?? ''
  const chars = [...line]
  return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : line
}

// The model's background, else the request itself, unless that is what the title says.
const contextFor = (mirror: ProgressMirror): string => {
  if (mirror.context) return mirror.context
  const request = firstLine(mirror.firstPrompt)
  const title = mirror.title || fallbackTitle(mirror)
  if (title === '') return request

  return request === title || request.startsWith(title.replace(/…$/, '')) ? '' : request
}

const rowSteps = (task: ProgressTask, s: Strings): ViewStep[] => {
  const current = currentStepIndex(task)

  return foldSteps(
    task.steps.map((step, index) => ({
      ...splitNote(step.text),
      status: step.status,
      depth: step.depth,
      isCurrent: index === current,
      number: index + 1,
    })),
    5,
    s,
  )
}

// This session's own steps that wait on the person: answered right from the pane.
const ownWaiting = (mine: ProgressMirror, stable?: Readonly<Record<string, string>>): WaitingItem[] => {
  const title = mine.title || fallbackTitle(mine)
  const context = contextFor(mine)
  const ownId = shortId(mine.sessionId)
  // Keyed on the steps this session's block marks [?]: a blocked one is written [!], which no
  // other reader lists as a question, so it cannot be marked answered.
  const keys = askKeys(
    ownId,
    mine.tasks.map(task => (waitsOnYou(mine, task) && task.blocked === null ? stepWords(task).trim() : null)),
  )

  return mine.tasks
    .map((task, index) => ({ task, hideKey: stable?.[questionSlot(questionScope(mine.project, 'claude', ownId), index)] ?? keys[index] ?? '' }))
    .filter(({ task }) => waitsOnYou(mine, task))
    .map(({ task, hideKey }) => ({
      key: `mine::${task.id}`,
      project: mine.project,
      task: title,
      context,
      text: task.subject,
      note: task.why ?? '',
      when: '',
      ...askOf(task.subject, task.why ?? '', {
        ask: task.ask ?? undefined,
        options: (task.options ?? []).length > 0 ? task.options : undefined,
        command: task.command ?? undefined,
        link: task.link ?? undefined,
      }),
      where: 'here' as const,
      agent: '',
      session: shortId(mine.sessionId),
      sessionId: null,
      nativeSession: mine.sessionId,
      resumeVia: null,
      reopen: null,
      hideKey,
      step: null,
      target: null,
    }))
}

// Each step's key when it asks the person ('' when it does not): the session that asked, the
// step's place in that block (from 1) and its words as the block holds them. The same in the
// asking session's pane (from its Task list) and in every other reader (from its block); new as
// soon as the session words the step anew, and never another step's, even one worded alike.
export const askKeys = (session: string, texts: ReadonlyArray<string | null>): string[] =>
  texts.map((text, index) => (text === null ? '' : `${session} ${index + 1} ${text}`))

const blockKeys = (task: ProgressTask): string[] =>
  task.auto === null ? task.steps.map(() => '') : askKeys(task.auto.session, task.steps.map(step => (step.status === 'waiting' ? step.text : null)))

// The questions marked answered live beside progress.md (`progress-answered.json`), so every
// pane on this machine and the board script read the same list; nothing goes into the blocks,
// which stay their sessions' to change.
export const answeredPath = (path: string): string => `${path.replace(/\.md$/i, '')}-answered.json`

// How long a list that is not JSON is taken for another write caught half-way.
const HALF_WRITE_MS = 5000

// Null for text that is not JSON and was written less than HALF_WRITE_MS ago (`age`): read it
// again rather than write over it. Older, or dated well ahead of this clock, it is broken: it
// reads as none, so it only shows the questions again, and the next press writes over it. So
// does anything but a list of strings.
export const parseAnswered = (text: string, age = 0): string[] | null => {
  if (text.trim() === '') return []
  try {
    const data: unknown = JSON.parse(text)
    const list = data !== null && typeof data === 'object' && 'answered' in data ? data.answered : null
    return Array.isArray(list) ? list.filter((one): one is string => typeof one === 'string' && one !== '') : []
  } catch {
    return Math.abs(age) < HALF_WRITE_MS ? null : []
  }
}

// The marks still wanted: one whose session's block is in the file but no longer asks it goes,
// so the same words asked again later show. A session with no block in the file yet keeps its
// marks (the pane can show its own question before its block is written).
export const keptAnswered = (answered: readonly string[], projects: readonly ProgressProject[]): string[] => {
  const sessions = new Set<string>()
  const asked = new Set<string>()
  for (const project of projects) {
    for (const task of project.tasks) {
      if (task.auto === null) continue
      sessions.add(task.auto.session)
      for (const key of blockKeys(task)) if (key !== '') asked.add(key)
    }
  }

  return answered.filter(key => !sessions.has(key.slice(0, key.indexOf(' '))) || asked.has(key))
}

// The list after one press: only the pressed questions change. A press can come from a view a
// moment old, so marks whose question left the file are dropped by keptAnswered once the file
// holds still, not here.
export const withAnswered = (answered: readonly string[], keys: readonly string[], isHidden: boolean): string[] => {
  const kept = answered.filter(one => !keys.includes(one))

  return isHidden ? [...kept, ...keys] : kept
}

export const answeredJson = (answered: readonly string[]): string => `${JSON.stringify({ answered }, null, 2)}\n`

export const seenPath = (path: string): string => `${path.replace(/\.md$/i, '')}-seen.json`

const SEEN_MAX = 500
// One reserved entry in progress-seen.json (#464): when a reader that records first ran with the 3-day
// rule. A finished hand-kept task's 3 days count from the later of this and its own first observation,
// so tasks an earlier release saw done long ago get their 3 days from the upgrade. Absent = unknown.
export const SWEEP_ARMED_KEY = sha256('hand-kept-sweep-armed')
const hasTime = (time: unknown): time is number => typeof time === 'number' && Number.isFinite(time) && time > 0
const isFutureKey = (key: string): boolean => /^future:[0-9a-f]{64}$/.test(key)

// Notes and indentation do not mean the task's work changed.
export const taskFingerprint = (project: string, task: ProgressTask): string =>
  sha256(JSON.stringify([project, task.title, task.steps.map(step => [step.status, step.text.trim()])]))

// Whether the text is a seen file this reader understands: empty, or JSON holding a `seen` object. A
// sweep that must write nothing on a file it cannot read (the page's, #464) stops on anything else.
export const isSeenText = (text: string): boolean => {
  if (text.trim() === '') return true
  try {
    const data: unknown = JSON.parse(text)
    const list = data !== null && typeof data === 'object' && 'seen' in data ? data.seen : null
    return list !== null && typeof list === 'object' && !Array.isArray(list)
  } catch {
    return false
  }
}

export const parseSeen = (text: string, age = 0): Record<string, number> | null => {
  if (text.trim() === '') return {}
  try {
    const data: unknown = JSON.parse(text)
    const list = data !== null && typeof data === 'object' && 'seen' in data ? data.seen : null
    if (list === null || typeof list !== 'object' || Array.isArray(list)) return {}
    const entries = Object.entries(list).filter(([, time]) => hasTime(time))
    // The writer bounds absent clock entries. A present update's baseline must survive
    // decoding even when the board has more rows than the manual observation cache.
    return Object.fromEntries([
      ...entries.filter(([key]) => key === SWEEP_ARMED_KEY || isFutureKey(key)),
      ...entries.filter(([key]) => key !== SWEEP_ARMED_KEY && /^[0-9a-f]{64}$/.test(key)).slice(0, SEEN_MAX),
    ])
  } catch {
    return Math.abs(age) < HALF_WRITE_MS ? null : {}
  }
}

// Earliest wins when two readers merge: a lost race only makes a task look fresher,
// never hides it early. Keep this reader's observations across write retries.
// Tasks the file no longer holds are kept, after the ones it holds, unless `isSettled`: one
// read of a file caught empty or half-written must not reset every task's age, so they are
// dropped only once the file has held still.
export const withSeen = (
  seen: Readonly<Record<string, number>>,
  projects: readonly ProgressProject[],
  now: number,
  other: Readonly<Record<string, number>> = {},
  isSettled = false,
  isArming = false,
): Record<string, number> => {
  const entries = new Map<string, number>()
  const presentClocks = new Set<string>()
  const earliest = (key: string): number | undefined => {
    const times = [seen[key], other[key]].filter(hasTime)
    return times.length > 0 ? Math.min(...times) : undefined
  }
  // A time on a clock that ran ahead would keep every task from ever being due: it counts as unknown.
  const held = earliest(SWEEP_ARMED_KEY)
  const armedBefore = held !== undefined && held - now <= FUTURE_SKEW_MS ? held : undefined
  for (const project of projects) {
    for (const task of project.tasks) {
      if (task.auto !== null && hasTime(task.auto.updated)) {
        // The same update keeps its first local observation through clock catch-up.
        const key = futureTimeKey(task.auto)
        const first = earliest(key)
        if (first !== undefined || task.auto.updated - now > FUTURE_SKEW_MS) {
          entries.set(key, first ?? now)
          presentClocks.add(key)
        }
        continue
      }
      const key = taskFingerprint(project.name, task)
      const time = earliest(key) ?? now
      if (hasTime(time)) entries.set(key, time)
    }
  }
  if (!isSettled) {
    for (const key of [...Object.keys(seen), ...Object.keys(other)]) {
      const time = earliest(key)
      if (!entries.has(key) && time !== undefined) entries.set(key, time)
    }
  }
  const clocks = [...entries].filter(([key]) => isFutureKey(key))
  // An empty read proves no update disappeared and cannot add new clock observations.
  const keptClocks = projects.length === 0 && !isSettled ? clocks : [
    ...clocks.filter(([key]) => presentClocks.has(key)),
    ...clocks.filter(([key]) => !presentClocks.has(key)).slice(0, SEEN_MAX),
  ]
  const rest = [
    ...keptClocks,
    ...[...entries].filter(([key]) => key !== SWEEP_ARMED_KEY && !isFutureKey(key)).slice(0, SEEN_MAX),
  ]
  // The reserved entry is first written with an observation it belongs to, so a board with
  // nothing to observe leaves no file behind.
  const armed = armedBefore ?? (isArming && rest.length > 0 ? now : undefined)
  return Object.fromEntries([...(armed === undefined ? [] : [[SWEEP_ARMED_KEY, armed] as const]), ...rest])
}

// When a finished hand-kept task counts as seen done for the 3-day rule; undefined while either time
// is unknown or in the future, so nothing is counted or moved on a guess.
export const handKeptSeenAt = (seen: Readonly<Record<string, number>>, project: string, task: ProgressTask, now: number): number | undefined => {
  const armed = seen[SWEEP_ARMED_KEY]
  if (!hasTime(armed) || armed > now) return undefined
  const observed = seen[taskFingerprint(project, task)]
  return hasTime(observed) && observed <= now ? Math.max(observed, armed) : undefined
}

export const seenJson = (seen: Readonly<Record<string, number>>): string => `${JSON.stringify({ seen }, null, 2)}\n`

// The sidecar remembers task fingerprints; the completion view uses legacy title keys.
// Missing times stay unknown, and a shared title keeps the oldest possible observation.
export const manualDoneSeen = (projects: readonly ProgressProject[], seen: Readonly<Record<string, number>>, now: number, s: Strings = ZH_TW): Record<string, number | null> => {
  const done: Record<string, number | null> = {}
  for (const project of projects) for (const task of project.tasks) {
    if (task.auto !== null || !isTaskComplete(task)) continue
    const key = doneKey(project.name || s.uncategorized, task.title || s.unnamed)
    const held = seen[taskFingerprint(project.name, task)]
    const at = hasTime(held) && held <= now ? held : null
    const previous = done[key]
    done[key] = previous === null || at === null ? null : Math.min(previous ?? at, at)
  }
  return done
}

const whereRank = (item: WaitingItem): number => (item.where === 'here' ? 0 : 1)

// The agents of some runs as a person names them (`Codex / Claude Code`), the busiest first.
const runAgents = (group: RunGroup, s: Strings): string => group.agents.map(agent => s.agentNames[agent] ?? agentName(agent)).join(' / ')
const runsText = (group: RunGroup, now: number, s: Strings): string => s.runsLine(group.count, runAgents(group, s), relativeTime(group.last, now, s))

const isUniqueUnresumedTask = (task: ProgressTask, projects: readonly ProgressProject[], ownId: string, ownAgent = 'claude'): boolean => {
  let count = 0
  let unresumed = 0
  for (const p of projects) {
    for (const t of p.tasks) {
      if (t.auto !== null && (t.auto.agent ?? 'claude') === ownAgent && t.auto.session === ownId) {
        count += 1
        if (t.auto.resume === null || t.auto.resume === undefined) unresumed += 1
      }
    }
  }
  return count === 1 && unresumed === 1
}

export const buildView = (
  projects: readonly ProgressProject[],
  here: readonly string[],
  mine: ProgressMirror | null,
  now: number,
  today = 0,
  // When the pane first saw each hand-kept task done (by doneKey); one it has not seen counts
  // as done just now. An explicit null means its completion time is unknown.
  doneSeen: Readonly<Record<string, number | null>> = {},
  s: Strings = ZH_TW,
  // Questions the person marked answered on this machine (by answeredKey): kept out of Waiting
  // on you, its count and the focus, and listed under `hidden` instead.
  answered: readonly string[] = [],
  seen: Readonly<Record<string, number>> = {},
  questions?: QuestionLedger,
  proofs: QuestionProofs | null = { retired: [], consumed: [] },
  pending: readonly PendingTurn[] = [],
  frozen: ReadonlySet<string> = new Set(),
  observe: typeof observeQuestions = observeQuestions,
): View => {
  // A run an agent started for itself is no row and asks no one (#399); the older block of a twin
  // pair is no second row. What is left is what the rows, the questions and the counts read.
  const folded = foldRuns(projects)
  const observed = questions === undefined ? null : observe(questions, folded.projects, mine, answered, now, false, 'preview', proofs ?? { retired: [], consumed: [] }, pending, [], frozen)
  const marked = new Set(proofs === null ? [] : observed?.marked ?? answered)
  const recordsById = new Map((observed?.ledger.records ?? []).map(record => [record.id, record]))
  const ownId = mine === null ? '' : shortId(mine.sessionId)
  const waiting: WaitingItem[] = []
  const inactiveHidden: WaitingItem[] = []
  const due: Array<TaskRow & { days: number }> = []
  const active: Array<TaskRow & { rank: number; order: number }> = []
  const recent: Array<DoneItem & { at: number }> = []
  const finished: Array<DoneItem & { at: number; agent: string; isOwn?: true; dir: string | null }> = []
  const idle: TaskRow[] = []
  const stopped: Array<{ row: TaskRow; updated: number }> = []
  const completed: Array<{ row: TaskRow; updated: number; recent: DoneItem & { at: number } | null }> = []
  const inactiveScopes = new Map<string, number>()
  const liveScopes = new Set<string>()
  const unreadable = new Set<string>()
  for (const scope of frozen) {
    try {
      const parts: unknown = JSON.parse(scope)
      if (!Array.isArray(parts) || parts.length !== 3 || !parts.every(part => typeof part === 'string')) continue
      unreadable.add(parts[1] || 'claude')
    } catch {}
  }
  let order = 0
  // The parents whose rows carry their runs line; the runs of any other go to the background line.
  const placed = new Set<ProgressTask>()
  // The runs of the session this view belongs to: its row is the current card, not a listed row.
  let ownRuns: RunGroup | null = null
  // A run's own question is no question for anyone: its saved records stay in the ledger but are not asked again.
  const keptTasks = new Set(folded.projects.flatMap(project => project.tasks))
  const keptScopes = new Set(folded.projects.flatMap(project => project.tasks.flatMap(task => task.auto === null ? [] : [questionScope(project.name, task.auto.agent, task.auto.session)])))
  const foldedScopes = new Set(projects.flatMap(project => project.tasks.flatMap(task => task.auto === null || keptTasks.has(task) ? [] : [questionScope(project.name, task.auto.agent, task.auto.session)])).filter(scope => !keptScopes.has(scope)))
  const repeats = new Map<string, number>()
  // How many tasks share each project and title, counted once rather than for every row (#371).
  const twins = new Map<string, number>()
  for (const project of projects) {
    for (const task of project.tasks) {
      const twin = JSON.stringify([project.name || s.uncategorized, task.title])
      twins.set(twin, (twins.get(twin) ?? 0) + 1)
    }
  }

  for (const project of folded.projects) {
    const name = project.name || s.uncategorized
    const isHere = isHereProject(name, here)
    const ownAgent = (mine?.agent || 'claude').toLowerCase()
    for (const task of project.tasks) {
      const isMine = task.auto !== null && (
        task.auto.resume !== null && mine !== null && mine.sessionId
          ? task.auto.resume === mine.sessionId && (task.auto.agent ?? 'claude') === ownAgent
          : (mine !== null && mine.sessionId && task.auto.session === ownId && (task.auto.agent ?? 'claude') === ownAgent && mine.isRun !== true && isUniqueUnresumedTask(task, folded.projects, ownId, ownAgent))
      )
      if (isMine) {
        const own = folded.runs.get(task)
        if (own !== undefined) {
          ownRuns = own
          placed.add(task)
        }
        continue
      }
      order += 1
      const title = task.title || s.unnamed
      // A repeated title gets #2, #3, … so its row and buttons are its own.
      const base = `${name}::${title}`
      const repeat = (repeats.get(base) ?? 0) + 1
      repeats.set(base, repeat)
      const key = repeat === 1 ? base : `${base}#${repeat}`
      const clock = observedTime(task.auto, now, seen)
      const updated = clock.updated
      const when = clock.isFuture ? updated > now ? s.futureTimeUnknown : s.futureTime(relativeTime(updated, now, s)) : relativeTime(updated, now, s)
      const isComplete = isTaskComplete(task) || task.auto?.state === 'done'
      const isManual = task.auto === null
      const scope = questionScope(project.name, task.auto?.agent ?? 'manual', task.auto?.session ?? task.title)
      const isFrozen = frozen.has(scope)
      const lastActive = hasTime(updated) ? updated : seen[taskFingerprint(project.name, task)]
      const days = task.due === null ? null : dueDays(task.due, now)
      const isDue = task.due !== null && days !== null && days <= 14
      const isIdle = !isComplete && !isDue && hasTime(lastActive) && now - lastActive > IDLE_MS
      const context = contextOf(task)
      // Questions travel with an inactive session rather than asking for a live reply.
      const stale = isStale(task.auto, now, updated)
      const isInactive = !isManual && (isComplete || stale || task.auto?.state === 'ended')
      if (isInactive) inactiveScopes.set(scope, updated)
      else if (!isManual) liveScopes.add(scope)
      const taskQuestions: WaitingItem[] = []
      const keys = task.auto === null || observed === null
        ? blockKeys(task)
        : task.steps.map((step, index) => step.status === 'waiting' ? observed.keys[questionSlot(scope, index)] ?? '' : '')
      // A cut-off block's question records stay as they were, but its steps still show. A step a
      // saved question of its scope covers (the same words, or the start of them the cut left) is
      // shown by that saved question in the loop over the ledger below, or not at all once it is
      // answered or hidden. Any other [?] step asks as written, with no question id, as before the
      // ledger first sees it.
      const scopeRecords = isFrozen ? (observed?.ledger.records.filter(record => record.scope === scope) ?? []) : []
      // A question that should show but does not is worse than one shown twice. Only one saved
      // candidate covers a step, and an answer needs the same token or saved source revisions.
      const savedFor = (index: number) => {
        const step = task.steps[index]!
        const words = questionWords(step.text)
        const token = step.questionToken ?? ''
        const covering = scopeRecords.filter(record => {
          if (record.producer && token !== '' && record.producer !== token) return false
          if (record.isUnresolved) return record.source !== undefined
          return token !== '' && token === record.producer || pending.some(turn => turn.isQuestion && turn.id !== undefined && questionScope(turn.project, turn.agent, turn.id) === scope && questionWords(turn.text) === record.words && turn.sourceRevisions !== undefined && turn.sourceRevisions.length > 0 && turn.sourceRevisions.every(revision => record.producerRevisions?.includes(revision)))
        })
        const same = covering.filter(record => record.words === words)
        const candidates = same.length > 0 || words === '' || index !== task.steps.length - 1 ? same : covering.filter(record => record.words.startsWith(words))
        return candidates.length === 1 ? candidates[0] : undefined
      }
      const isAsked = (index: number): boolean => {
        if (isFrozen) {
          const saved = savedFor(index)
          return saved === undefined ? true : saved.isUnresolved === true && saved.source !== undefined && !marked.has(saved.id)
        }
        return !marked.has(keys[index] ?? '') && observed?.ledger.records.find(record => record.id === keys[index])?.isUnresolved !== false
      }
      const stageOf = (index: number) => {
        const id = observed?.keys[questionSlot(scope, index)]
        return questionAge(observed?.ledger.records.find(record => record.id === id)?.firstObserved ?? 0, now).stage
      }
      const isPrompt = (index: number): boolean => isFrozen ? savedFor(index) === undefined && isAsked(index) && stageOf(index) === 'pending' : isAsked(index) && stageOf(index) === 'pending'

      task.steps.forEach((step, index) => {
        if (step.status !== 'waiting') return
        if (isFrozen && savedFor(index) !== undefined) return
        const parts = splitNote(step.text)
        taskQuestions.push({
          key: `${key}::${index}`,
          project: name,
          task: title,
          context,
          ...parts,
          when,
          ...(lastActive === undefined ? {} : { at: lastActive }),
          dir: task.auto?.dir ?? null,
          ...askOf(parts.text, parts.note),
          where: isManual ? 'manual' : 'other',
          agent: task.auto === null || task.auto.agent === 'claude' ? '' : task.auto.agent,
          // Another agent's block id is a hash of its session; its own id is what its session
          // list shows.
          session: task.auto === null ? '' : task.auto.agent !== 'claude' && task.auto.resume !== null ? sessionName(task.auto.resume) : task.auto.session,
          sessionId:
            task.auto === null
              ? null
              : (task.auto.resume ?? (task.auto.agent === 'claude' && RESUME.test(task.auto.session) ? task.auto.session : null)),
          resumeVia: task.auto?.resume ? resumeVia(task.auto.agent) : null,
          reopen: task.auto?.resume ? resumeCommand(task.auto.resume, task.auto.dir, task.auto.agent) : null,
          hideKey: isFrozen ? '' : keys[index] ?? '',
          questionId: isFrozen ? undefined : observed?.keys[questionSlot(scope, index)],
          step: isManual ? { project: name, title, step: step.text, line: step.line, raw: step.raw } : null,
          target: targetOf(task.auto),
          ...(task.auto === null ? {} : { nativeSession: task.auto.resume ?? task.auto.session }),
        })
      })
      const unresolved = taskQuestions.filter(item => !marked.has(item.hideKey) && observed?.ledger.records.find(record => record.id === item.questionId)?.isUnresolved !== false)
      if (isInactive) inactiveHidden.push(...taskQuestions.filter(item => marked.has(item.hideKey) && observed?.ledger.records.find(record => record.id === item.questionId)?.isUnresolved !== false))
      if (!isInactive) waiting.push(...taskQuestions)

      let completion: DoneItem & { at: number } | null = null
      if (isComplete) {
        const doneAt = doneSeen[doneKey(name, title)]
        const seen = isManual ? doneAt === null ? null : doneAt ?? now : updated
        if (seen !== null && now - seen < 7 * DAY) {
          finished.push({
            key,
            project: name,
            title,
            when: clock.isFuture ? when : relativeTime(seen, now, s),
            at: seen,
            agent: task.auto === null || task.auto.agent === 'claude' ? '' : task.auto.agent,
            ...(isManual ? { isOwn: true as const } : {}),
            dir: task.auto?.dir ?? null,
            questions: isInactive ? unresolved : [],
          })
        }
        if (seen !== null && now - seen < DAY) {
          completion = { key, project: name, title, when: clock.isFuture ? when : relativeTime(seen, now, s), at: seen, questions: isInactive ? unresolved : [] }
          recent.push(completion)
        }
        if (!isInactive || (unresolved.length === 0 && !task.steps.some(step => step.status === 'waiting'))) continue
      }

      const auto = task.auto === null ? null : task.auto.state === 'done' || isComplete || stale ? 'ended' : task.auto.state
      // A session whose turn ended on a question is in 等你處理 by its [?] steps. One whose
      // turn simply ended (`state=waiting` is written at every turn's end), or that waits on
      // CI or another agent, asks the person nothing: it stays with the work in progress.
      // One whose questions were all marked answered is back with the work in progress.
      if (!isIdle && auto === 'waiting' && task.steps.some((step, index) => step.status === 'waiting' && isAsked(index))) continue

      const { done, total } = countSteps(task)
      const phrase =
        auto === 'working'
          ? { status: task.auto?.agent === 'claude' ? s.claudeWorking : s.agentWorking(agentLabel(task.auto?.agent ?? '', s)), tone: 'accent' as const }
          : auto === 'ended'
            ? { status: stale ? s.sessionStopped(when) : s.sessionEnded, tone: 'warn' as const }
            : task.steps.some((step, index) => step.status === 'waiting' && isAsked(index)) && !task.steps.some((step, index) => step.status === 'waiting' && isPrompt(index))
              ? { status: task.steps.some((step, index) => step.status === 'waiting' && stageOf(index) === 'reminder') ? s.sectionQuestionReminders : s.sectionOlderQuestions, tone: 'quiet' as const }
              : stepPhrase(task, s, isPrompt)
      const open = task.steps[currentStepIndex(task)]
      const group = folded.runs.get(task)
      const row: TaskRow = {
        key,
        project: name,
        title,
        context,
        done,
        total,
        ...phrase,
        when: isIdle && !clock.isFuture ? relativeTime(lastActive ?? 0, now, s) : when,
        ...(lastActive === undefined ? {} : { at: lastActive }),
        dir: task.auto?.dir ?? null,
        ...(clock.isFuture ? { hasFutureTime: true } : {}),
        isHere,
        auto,
        steps: rowSteps(task, s),
        left: task.steps.filter(step => step.status !== 'done' && step.status !== 'cancelled').map(step => step.text),
        questions: isInactive ? unresolved : [],
        question: isInactive ? unresolved.find(item => !marked.has(item.hideKey))?.text ?? null : ((asked: ProgressStep | undefined) => (asked === undefined ? null : splitNote(asked.text).text))(
          task.steps.find((step, index) => step.status === 'waiting' && isPrompt(index)),
        ),
        next:
          isManual && open !== undefined
            ? { project: name, title, step: open.text, line: open.line, raw: open.raw }
            : null,
        due: null,
        pr: autoPr(task.auto, s),
        agent: task.auto === null || task.auto.agent === 'claude' ? '' : task.auto.agent,
        // Only an agent whose resume by id is known gets a command.
        resume: auto === 'ended' && task.auto?.resume ? resumeCommand(task.auto.resume, task.auto.dir, task.auto.agent) : null,
        handoff: handoffOf(task),
        // A hand-kept task with no open step has nothing to confirm: confirmTask refuses it,
        // so the press could only say the line changed (#142).
        confirm: (isManual && task.line >= 0 && task.steps.some(step => step.status !== 'done' && step.status !== 'cancelled') || auto === 'ended')
          ? { project: name, title: task.title, line: task.line, session: task.auto?.session ?? null, resume: task.auto?.resume ?? null, expected: confirmKey(name, task, twins.get(JSON.stringify([name, task.title])) ?? 0) }
          : null,
        archive:
          isManual && task.line >= 0
            ? { project: name, title: task.title, line: task.line, session: null }
            : auto === 'ended' && task.auto !== null
              ? { project: name, title: task.title, line: task.line, session: task.auto.session, ...(task.auto.resume ? { resume: task.auto.resume } : {}) }
              : null,
        target: targetOf(task.auto),
        ...(task.auto === null ? {} : { nativeSession: task.auto.resume ?? task.auto.session }),
        ...(group === undefined ? {} : { runs: runsText(group, now, s) }),
      }

      if (isComplete) {
        completed.push({ row, updated, recent: completion })
        continue
      }
      // A finished session draws no row, so its runs are counted with the background runs instead.
      if (group !== undefined) placed.add(task)
      if (auto === 'ended' && unresolved.length > 0) {
        stopped.push({ row, updated })
        continue
      }
      // Work with a date close by is listed once, under 快到期.
      if (task.due !== null && days !== null && days <= 14) {
        due.push({ ...row, due: { date: task.due, ...dueLabel(days, s) }, days })
        continue
      }
      if (isIdle) {
        idle.push(row)
        continue
      }
      if (auto === 'ended') {
        stopped.push({ row, updated })
        continue
      }
      active.push({ ...row, rank: isHere ? 0 : 1, order })
    }
  }

  // The older block of two for one session: no row of its own, but the person may take it out.
  for (const { project, task } of folded.duplicates) {
    const auto = task.auto
    if (auto === null) continue
    const name = project.name || s.uncategorized
    const title = task.title || s.unnamed
    const base = `${name}::${title}`
    const repeat = (repeats.get(base) ?? 0) + 1
    repeats.set(base, repeat)
    const updated = observedTime(auto, now, seen).updated
    const { done, total } = countSteps(task)
    stopped.push({
      updated,
      row: {
        key: repeat === 1 ? base : `${base}#${repeat}`,
        project: name, title, context: '', done, total, status: s.duplicateSession, tone: 'quiet',
        when: relativeTime(updated, now, s), isHere: false, auto: 'ended', steps: [], left: [], next: null, due: null, pr: '',
        agent: auto.agent === 'claude' ? '' : auto.agent, resume: null, question: null, handoff: '',
        archive: { project: name, title: task.title, line: task.line, session: auto.session, ...(auto.resume ? { resume: auto.resume } : {}), isDuplicate: true }, target: null,
      },
    })
  }
  let background: RunGroup | null = folded.background
  for (const [task, group] of folded.runs) {
    if (!placed.has(task)) background = mergeGroups(background, group)
  }

  due.sort((a, b) => a.days - b.days)
  active.sort((a, b) => a.rank - b.rank || a.order - b.order)
  recent.sort((a, b) => b.at - a.at)
  finished.sort((a, b) => b.at - a.at)
  const shownRecent = recent.slice(0, 3)
  for (const item of completed) {
    if (item.recent === null || !shownRecent.includes(item.recent)) stopped.push({ row: item.row, updated: item.updated })
  }
  stopped.sort((a, b) => b.updated - a.updated)

  const rows = active.map(({ rank: _rank, order: _order, ...row }) => row)
  const groups: RowGroup[] = []
  for (const row of rows) {
    const group = groups.find(one => one.project === row.project)
    if (group === undefined) groups.push({ project: row.project, isHere: row.isHere, rows: [row], summary: '' })
    else group.rows.push(row)
  }
  for (const group of groups) {
    const count = (test: (row: TaskRow) => boolean, word: (n: number) => string): string => {
      const n = group.rows.filter(test).length
      return n === 0 ? '' : word(n)
    }
    group.summary = [
      s.groupCount(group.rows.length),
      count(row => row.tone === 'warn', s.groupWaiting),
      count(row => row.tone === 'alert', s.groupStuck),
      count(row => row.auto === 'working', s.groupWorking),
    ]
      .filter(part => part !== '')
      .join(' · ')
  }

  const inbox = pending.filter(turn => turn.isQuestion && turn.id !== undefined).flatMap(turn => {
    const updated = inactiveScopes.get(questionScope(turn.project, turn.agent, turn.id ?? ''))
    if (updated !== undefined && turn.at <= updated) return []
    const scope = questionScope(turn.project, turn.agent, turn.id ?? '')
    const id = observed?.keys[pendingQuestionSlot(scope, turn.text)] ?? observed?.ledger.records.find(record => record.scope === scope && record.isUnresolved && record.producerSources?.includes(JSON.stringify(turn)))?.id
    if (id === undefined || waiting.some(item => item.questionId === id)) return []
    const parts = splitNote(turn.text)
    return [{ key: `inbox::${id}`, questionId: id, dir: turn.dir ?? null, project: turn.project, task: '', context: '', ...parts, when: '', at: turn.at, ...askOf(parts.text, parts.note), where: 'other' as const, agent: turn.agent, session: turn.id ?? '', sessionId: null, resumeVia: null, reopen: null, hideKey: id, step: null, target: null }]
  })
  const own = mine === null || mine.isRun === true ? [] : ownWaiting(mine, observed?.keys).map(item => ({ ...item, questionId: item.hideKey }))
  // Each record by its id, once: a board holds hundreds of questions and thousands of records.
  const recordOf = new Map<string, QuestionRecord>()
  const rankOf = new Map<string, number>()
  for (const [index, record] of (observed?.ledger.records ?? []).entries()) {
    if (recordOf.has(record.id)) continue
    recordOf.set(record.id, record)
    rankOf.set(record.id, index)
  }
  const isResolved = (item: WaitingItem): boolean => recordOf.get(item.questionId ?? '')?.isUnresolved === false
  const firstSeen = (item: WaitingItem): number => recordOf.get(item.questionId ?? '')?.firstObserved ?? 0
  const scopeOf = (item: WaitingItem): string => recordOf.get(item.questionId ?? '')?.scope ?? ''
  const seenAs = (item: WaitingItem) => ({ at: firstSeen(item), rank: rankOf.get(item.questionId ?? '') ?? -1, scope: scopeOf(item) })
  const aged = (item: WaitingItem): WaitingItem => {
    const record = recordOf.get(item.questionId ?? '')
    const age = questionAge(firstSeen(item), now)
    return { ...item, ageStage: age.stage, when: age.age === null ? s.questionAgeUnknown : relativeTime(firstSeen(item), now, s), ...(item.at === undefined && record !== undefined ? { at: record.firstObserved } : {}), dir: item.dir ?? recordFolder(record) ?? null }
  }
  const all = [...own, ...waiting, ...inbox].filter(item => !isResolved(item)).map(aged).sort(
    (a, b) => whereRank(a) - whereRank(b) || askRank(a.kind) - askRank(b.kind),
  )
  const isMarked = (item: WaitingItem): boolean => item.hideKey !== '' && marked.has(item.hideKey)
  const hidden: WaitingItem[] = [...all.filter(isMarked), ...inactiveHidden]
  const liveQuestions = new Set(all.flatMap(item => item.questionId === undefined ? [] : [item.questionId]))
  for (const { row } of stopped) {
    row.questions = row.questions?.filter(item => item.questionId === undefined || !liveQuestions.has(item.questionId))
    row.question = row.questions?.[0]?.text ?? null
  }
  for (const item of shownRecent) item.questions = item.questions?.filter(question => question.questionId === undefined || !liveQuestions.has(question.questionId))
  const onShelf = new Set([...stopped.flatMap(({ row }) => row.questions ?? []), ...shownRecent.flatMap(item => item.questions ?? [])].flatMap(item => item.questionId === undefined ? [] : [item.questionId]))
  const shownQuestions = new Set([...all, ...hidden].flatMap(item => item.questionId === undefined ? [] : [item.questionId]))
  const retained: WaitingItem[] = []
  const stoppedQuestions = new Set<string>()
  const keptSessions = new Set([...keptTasks].flatMap(task => task.auto === null ? [] : [sessionIdentity(task.auto)]).filter(identity => identity !== null))
  const runSessions = new Set(projects.flatMap(project => project.tasks.flatMap(task => task.auto?.isRun === true ? [sessionIdentity(task.auto)] : [])).filter(identity => identity !== null))
  const starterOf = startersOf(projects)
  for (const record of observed?.ledger.records ?? []) {
    if (!record.isUnresolved || record.source === undefined || onShelf.has(record.id) || shownQuestions.has(record.id) || foldedScopes.has(record.scope)) continue
    const source = record.source
    const saved = source.kind === 'block' ? sourceSnapshot(source.data) : null
    let agent = source.agent
    // A kept question whose block is gone is folded by its saved copy, as the live block was (#399): a
    // copy of a session that is a row on the board today is that row's, which shows its own question;
    // a copy of a run is listed under the agent of the session that started it, when that one is on
    // the board.
    if (saved !== null && saved.auto !== null && !liveScopes.has(record.scope) && !keptScopes.has(record.scope)) {
      const identity = sessionIdentity(saved.auto)
      if (identity !== null && keptSessions.has(identity)) continue
      const isRun = saved.auto.isRun === true || identity !== null && runSessions.has(identity)
      const starter = isRun ? starterOf(saved.auto) : null
      if (starter !== null) agent = starter.agent
    }
    const parts = splitNote(source.text)
    const age = questionAge(record.firstObserved, now)
    // A source copy still knows a stopped session after its block was removed or replaced.
    // Keep that orphaned copy for review without offering it as a live question again.
    let isInactiveSource = false
    if (source.kind === 'block' && !liveScopes.has(record.scope)) {
      // Unknown historical source shapes retain the existing review behavior.
      isInactiveSource = saved !== null && saved.auto !== null && (saved.auto.state === 'ended' || saved.auto.state === 'done' || isStale(saved.auto, now, observedTime(saved.auto, now, seen).updated) || isMarksComplete(saved.steps))
    }
    const isStopped = record.isArchived || isInactiveSource || inactiveScopes.has(record.scope)
    const stage = isStopped ? 'older' : age.stage
    const item: WaitingItem = { key: `retained::${record.id}`, questionId: record.id, dir: recordFolder(record) ?? saved?.auto?.dir ?? null, ageStage: stage, project: source.project, task: source.task, context: source.context, ...parts, when: age.age === null ? s.questionAgeUnknown : relativeTime(record.firstObserved, now, s), at: record.firstObserved, ...askOf(parts.text, parts.note), where: 'other', agent: agent === 'claude' ? '' : agent, session: source.session, sessionId: null, resumeVia: null, reopen: null, hideKey: record.id, canHide: record.isArchived === true, ...(record.isArchived === true ? { isKept: true as const } : {}), step: null, target: null }
    if (marked.has(record.id)) hidden.push(item)
    else {
      retained.push(item)
      if (isStopped) stoppedQuestions.add(record.id)
    }
  }
  // A question that sits on a Stopped or recent row is also listed under Older, with the age it was
  // first asked, so the stopped-sessions line in Waiting has one list to open (#400). The row keeps its
  // own copy. A question the ledger loop already put there is not listed twice, and every stopped
  // question is counted once by its id. A board that first looks at a long-quiet block cannot have
  // seen the question before the block's last write, so the question is at least that old: the age
  // is taken from the earlier of the two, and never reads "just now" for a month-old block.
  const olderIds = new Set([...all.filter(item => !isMarked(item)), ...retained].flatMap(item => item.ageStage === 'older' && item.questionId !== undefined ? [item.questionId] : []))
  const askedOn = [...stopped.map(({ row, updated }) => ({ questions: row.questions ?? [], updated })), ...shownRecent.map(item => ({ questions: item.questions ?? [], updated: 0 }))]
  const onRows: WaitingItem[] = []
  for (const { questions, updated } of askedOn) {
    for (const question of questions) {
      const id = question.questionId
      if (id === undefined || marked.has(id)) continue
      const record = recordsById.get(id)
      if (record?.isUnresolved === false) continue
      stoppedQuestions.add(id)
      if (olderIds.has(id)) continue
      const first = record?.firstObserved ?? 0
      const askedAt = updated > 0 && updated < first ? updated : first
      onRows.push({ ...question, dir: question.dir ?? recordFolder(record), key: `older::${question.key}`, ageStage: 'older', when: questionAge(first, now).age === null ? s.questionAgeUnknown : relativeTime(askedAt, now, s) })
      olderIds.add(id)
    }
  }
  // The same question asked in several blocks or captures is one card (#463): the newest copy that
  // can be acted on, with the age of the oldest. The copies a stopped session's row lists under
  // Older are in the mix, so a live card does not repeat them; the other copies stay in the
  // question list, and the row keeps its own.
  const merged = mergeCopies([...all.filter(item => !isMarked(item)), ...retained, ...onRows].map(item => ({ item, ...seenAs(item), isStopped: item.questionId !== undefined && stoppedQuestions.has(item.questionId) })), closedCopies(observed?.ledger.records ?? [], marked))
  const asks: WaitingItem[] = merged.filter(item => item.ageStage === 'pending')
  const reminder: WaitingItem[] = merged.filter(item => item.ageStage === 'reminder')
  const older: WaitingItem[] = merged.filter(item => item.ageStage === 'older')
  const stoppedAsking = older.filter(item => item.questionId !== undefined && stoppedQuestions.has(item.questionId)).length
  const dueRows = due.map(({ days: _days, ...row }) => row)
  const now1 = asks.find(item => askRank(item.kind) < 2)
  const today1 = due.find(row => row.days <= 1)
  const stuck = rows.find(row => row.tone === 'alert' && row.auto === null)
  const later = asks[0]
  const focus: Focus | null =
    now1 !== undefined
      ? { type: 'ask', item: now1 }
      : today1 !== undefined
        ? { type: 'due', row: dueRows[due.indexOf(today1)] ?? today1 }
        : stuck !== undefined
          ? { type: 'blocked', row: stuck }
          : later !== undefined
            ? { type: 'ask', item: later }
            : null

  const current = mine === null ? null : currentOf(mine, s)
  if (ownRuns !== null) {
    if (current === null) background = mergeGroups(background, ownRuns)
    else current.runs = runsText(ownRuns, now, s)
  }
  if (current !== null && !asks.some(item => item.where === 'here') && all.some(item => item.where === 'here' && item.ageStage !== 'pending')) {
    current.status = reminder.some(item => item.where === 'here') ? s.sectionQuestionReminders : s.sectionOlderQuestions
    current.tone = 'quiet'
  } else if (current !== null && own.some(isResolved) && !all.some(item => item.where === 'here')) {
    current.status = s.answeredNote
    current.tone = 'quiet'
  }
  return {
    current,
    pr: prView(mine, s),
    overview: { waiting: asks.length, active: rows.length + due.length, due: due.length, today, idle: idle.length, stopped: stopped.length },
    focus,
    waiting: asks,
    hidden,
    reminder,
    older,
    ...(stoppedAsking > 0 ? { stoppedAsking } : {}),
    hasPendingQuestions: questions !== undefined,
    ...(background === null ? {} : { background: s.backgroundRuns(background.count, relativeTime(background.last, now, s)) }),
    idle,
    stopped: stopped.map(item => item.row),
    due: dueRows,
    active: rows,
    groups,
    recent: shownRecent.map(({ at: _at, ...item }) => item),
    finished,
    ...(unreadable.size === 0 ? {} : { unreadable: [...unreadable] }),
  }
}

const clip = (text: string, room: number): string => {
  const chars = [...text]
  return chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : text
}

// One line under the prompt for when the pane is not on screen: this session's task, what
// waits on you, what is due soon, and the pull request.
export const statusLine = (view: View, s: Strings = ZH_TW): string | undefined => {
  const current = view.current
  const urgent = view.overview.due
  const parts = [
    current === null || current.state === 'done'
      ? ''
      : `${clip(current.title, 14)} ${current.done}/${current.total} · ${clip(current.status, 18)}`,
    view.overview.waiting > 0 ? s.statusWaiting(view.overview.waiting) : '',
    urgent > 0 ? s.statusDue(urgent) : '',
    view.pr === null ? '' : view.pr.text,
  ].filter(part => part !== '')

  return parts.length === 0 ? undefined : `${s.statusPrefix} · ${parts.join(' · ')}`
}

export const progressBar = (done: number, total: number, width: number): { filled: string; rest: string } => {
  const cells = Math.max(4, width)
  const filled = total === 0 ? 0 : Math.round((done / total) * cells)

  return { filled: '━'.repeat(filled), rest: '─'.repeat(cells - filled) }
}

// The board's view, built once for the same inputs (#373). After each change of the file the pane,
// the line under the prompt and the reminders each asked for it, and on a big board each build took
// a third of a second. Inputs are compared by value, so a copy read again counts as the same; the
// strings table by its language. It keeps the last `size` views, so the dashboard's view (no
// session) does not push the session's out. A view it hands out is shared: callers copy, never
// change it.
export const viewCache = (size = 2): { view: (...args: Parameters<typeof buildView>) => View; built: () => number } => {
  let kept: Array<{ args: readonly unknown[]; key: string; view: View }> = []
  let built = 0
  const keyOf = (args: readonly unknown[]): string => JSON.stringify(args.map((arg, index) => (index === 6 ? (arg as Strings | undefined)?.lang ?? null : arg instanceof Set ? [...arg] : arg ?? null)))

  return {
    view: (...args) => {
      const same = kept.find(one => one.args.length === args.length && one.args.every((arg, index) => arg === args[index]))
      if (same !== undefined) return same.view
      const key = keyOf(args)
      const found = kept.find(one => one.key === key)
      if (found !== undefined) {
        kept = [{ ...found, args }, ...kept.filter(one => one !== found)]
        return found.view
      }
      built += 1
      const view = buildView(...args)
      kept = [{ args, key, view }, ...kept].slice(0, size)
      return view
    },
    built: () => built,
  }
}

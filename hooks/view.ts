import type { ProgressAuto, ProgressMirror, ProgressProject, ProgressStep, ProgressStepStatus, ProgressTask } from '../types'
import { askOf, askRank } from './ask'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import type { AskKind } from './ask'
import { confirmKey, shortId, stepWords, upsertAutoBlock } from './blocks'
import type { ConfirmRef } from './blocks'
import { ciWords, prWords } from './github'
import { doingTask, fallbackTitle, isAnswered, waitsOnYou } from './mirror'
import type { Tone } from './palette'
import { countSteps, currentStepIndex, doneKey, isHereProject, isStale, isTaskComplete, parseProgress, RESUME } from './parse'
import { sha256 } from './sha256'
import { observeQuestions, pendingQuestionSlot, questionScope, questionSlot } from './questions'
import type { QuestionLedger, QuestionProofs } from './questions'
import { questionAge } from './question-aging'
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
}

// A step of a hand-kept task, addressed so a press can tick exactly the line it showed.
export type StepRef = { project: string; title: string; step: string; line: number; raw: string }

// What a row's 封存 press takes out: a session's block by its id, or a hand-kept task by its
// heading line, checked against the title so a task that moved is still found once.
export type TaskRef = { project: string; title: string; line: number; session: string | null }

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
  // A retained source without a current producer is available for review, not a new hide.
  canHide?: boolean
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
  key: string
  project: string
  title: string
  context: string
  done: number
  total: number
  status: string
  tone: Tone
  when: string
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
  // The line its session left at its last compaction for whoever takes over.
  handoff: string
  // Set when the person may take the row out now: a hand-kept task, or a block whose session
  // ended or stopped. A live session's block is that session's to change.
  archive: TaskRef | null
  confirm?: ConfirmRef | null
  // Another agent's session the row is; null for Claude's and hand-kept ones.
  target: AgentTarget | null
}

// This session's pull request, for the card.
export type PrView = { text: string; url: string; tone: Tone }

export type DoneItem = { project: string; title: string; when: string }

// Other work, one group per project, this session's project first; `summary` says it in a
// line (`3 件 · 1 等你 · 1 已停`) for while the list is folded.
export type RowGroup = { project: string; isHere: boolean; rows: TaskRow[]; summary: string }

// The line of counts at the top: what waits on you (here and elsewhere), what is open,
// what is due within two weeks (the 快到期 list), and the steps finished today.
export type Overview = { waiting: number; active: number; due: number; today: number; idle: number; stopped: number }

export type View = {
  current: CurrentView | null
  pr: PrView | null
  overview: Overview
  focus: Focus | null
  waiting: WaitingItem[]
  // Questions the person marked answered, until their session asks something else.
  hidden: WaitingItem[]
  reminder?: WaitingItem[]
  older?: WaitingItem[]
  hasPendingQuestions?: boolean
  idle: TaskRow[]
  stopped: TaskRow[]
  due: TaskRow[]
  active: TaskRow[]
  groups: RowGroup[]
  recent: DoneItem[]
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
export const IDLE_MS = 7 * DAY

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
    status = doing === undefined ? s.claudeWorking : s.doingStep(doing.activeForm || doing.subject)
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
// resume command copied on demand. `withCommand` false omits it on the LAN page.
export type ReplyHint = { where: string; back: string; note: string; reopen: string | null }
export const replyHint = (item: WaitingItem, s: Strings, withCommand = true): ReplyHint => {
  if (item.where !== 'other') return { where: '', back: '', note: '', reopen: null }
  const reopen = withCommand && item.sessionId !== null ? item.reopen : null

  return {
    where: s.replyElsewhere(item.task, '', item.agent),
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
  // Keyed on the steps this session's block marks [?]: a blocked one is written [!], which no
  // other reader lists as a question, so it cannot be marked answered.
  const keys = askKeys(
    shortId(mine.sessionId),
    mine.tasks.map(task => (waitsOnYou(mine, task) && task.blocked === null ? stepWords(task).trim() : null)),
  )

  return mine.tasks
    .map((task, index) => ({ task, hideKey: stable?.[questionSlot(questionScope(mine.project, 'claude', shortId(mine.sessionId)), index)] ?? keys[index] ?? '' }))
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
const hasTime = (time: unknown): time is number => typeof time === 'number' && Number.isFinite(time) && time > 0

// Notes and indentation do not mean the task's work changed.
export const taskFingerprint = (project: string, task: ProgressTask): string =>
  sha256(JSON.stringify([project, task.title, task.steps.map(step => [step.status, step.text.trim()])]))

export const parseSeen = (text: string, age = 0): Record<string, number> | null => {
  if (text.trim() === '') return {}
  try {
    const data: unknown = JSON.parse(text)
    const list = data !== null && typeof data === 'object' && 'seen' in data ? data.seen : null
    if (list === null || typeof list !== 'object' || Array.isArray(list)) return {}
    return Object.fromEntries(Object.entries(list).filter(([key, time]) => /^[0-9a-f]{64}$/.test(key) && hasTime(time)).slice(0, SEEN_MAX))
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
): Record<string, number> => {
  const entries = new Map<string, number>()
  const earliest = (key: string): number | undefined => {
    const times = [seen[key], other[key]].filter(hasTime)
    return times.length > 0 ? Math.min(...times) : undefined
  }
  for (const project of projects) {
    for (const task of project.tasks) {
      if (hasTime(task.auto?.updated)) continue
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
  return Object.fromEntries([...entries].slice(0, SEEN_MAX))
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
): View => {
  const observed = questions === undefined ? null : observeQuestions(questions, projects, mine, answered, now, false, 'preview', proofs ?? { retired: [], consumed: [] }, pending)
  const marked = new Set(proofs === null ? [] : observed?.marked ?? answered)
  const ownId = mine === null ? '' : shortId(mine.sessionId)
  const waiting: WaitingItem[] = []
  const due: Array<TaskRow & { days: number }> = []
  const active: Array<TaskRow & { rank: number; order: number }> = []
  const recent: Array<DoneItem & { at: number }> = []
  const idle: TaskRow[] = []
  const stopped: Array<{ row: TaskRow; updated: number }> = []
  let order = 0
  const repeats = new Map<string, number>()

  for (const project of projects) {
    const name = project.name || s.uncategorized
    const isHere = isHereProject(name, here)
    for (const task of project.tasks) {
      if (task.auto !== null && task.auto.session === ownId) continue
      order += 1
      const title = task.title || s.unnamed
      // A repeated title gets #2, #3, … so its row and buttons are its own.
      const base = `${name}::${title}`
      const repeat = (repeats.get(base) ?? 0) + 1
      repeats.set(base, repeat)
      const key = repeat === 1 ? base : `${base}#${repeat}`
      const updated = task.auto?.updated ?? 0
      const when = relativeTime(updated, now, s)
      const isComplete = isTaskComplete(task) || task.auto?.state === 'done'
      const isManual = task.auto === null
      const lastActive = hasTime(updated) ? updated : seen[taskFingerprint(project.name, task)]
      const days = task.due === null ? null : dueDays(task.due, now)
      const isDue = task.due !== null && days !== null && days <= 14
      const isIdle = !isComplete && !isDue && hasTime(lastActive) && now - lastActive > IDLE_MS
      const context = contextOf(task)
      // A session that stopped writing is treated as ended: its row goes to the Stopped shelf,
      // and its questions stay in 等你處理.
      const stale = isStale(task.auto, now)
      const keys = task.auto === null || observed === null
        ? blockKeys(task)
        : task.steps.map((step, index) => step.status === 'waiting' ? observed.keys[questionSlot(questionScope(project.name, task.auto?.agent ?? '', task.auto?.session ?? ''), index)] ?? '' : '')
      const isAsked = (index: number): boolean => !marked.has(keys[index] ?? '') && observed?.ledger.records.find(record => record.id === keys[index])?.isUnresolved !== false
      const stageOf = (index: number) => {
        const id = observed?.keys[questionSlot(questionScope(project.name, task.auto?.agent ?? 'manual', task.auto?.session ?? task.title), index)]
        return questionAge(observed?.ledger.records.find(record => record.id === id)?.firstObserved ?? 0, now).stage
      }
      const isPrompt = (index: number): boolean => isAsked(index) && stageOf(index) === 'pending'

      task.steps.forEach((step, index) => {
        if (step.status !== 'waiting') return
        const parts = splitNote(step.text)
        waiting.push({
          key: `${key}::${index}`,
          project: name,
          task: title,
          context,
          ...parts,
          when,
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
          hideKey: keys[index] ?? '',
          questionId: observed?.keys[questionSlot(questionScope(project.name, task.auto?.agent ?? 'manual', task.auto?.session ?? task.title), index)],
          step: isManual ? { project: name, title, step: step.text, line: step.line, raw: step.raw } : null,
          target: targetOf(task.auto),
          ...(task.auto === null ? {} : { nativeSession: task.auto.resume ?? task.auto.session }),
        })
      })

      if (isComplete) {
        const doneAt = doneSeen[doneKey(name, title)]
        const seen = isManual ? doneAt === null ? null : doneAt ?? now : updated
        if (seen !== null && now - seen < DAY) recent.push({ project: name, title, when: relativeTime(seen, now, s), at: seen })
        continue
      }

      const auto = task.auto === null || task.auto.state === 'done' ? null : stale ? 'ended' : task.auto.state
      // A session whose turn ended on a question is in 等你處理 by its [?] steps. One whose
      // turn simply ended (`state=waiting` is written at every turn's end), or that waits on
      // CI or another agent, asks the person nothing: it stays with the work in progress.
      // One whose questions were all marked answered is back with the work in progress.
      if (!isIdle && auto === 'waiting' && task.steps.some((step, index) => step.status === 'waiting' && isAsked(index))) continue

      const { done, total } = countSteps(task)
      const phrase =
        auto === 'working'
          ? { status: task.auto?.agent === 'claude' ? s.claudeWorking : s.agentWorking(task.auto?.agent ?? ''), tone: 'accent' as const }
          : auto === 'ended'
            ? { status: stale ? s.sessionStopped(when) : s.sessionEnded, tone: 'warn' as const }
            : task.steps.some((step, index) => step.status === 'waiting' && isAsked(index)) && !task.steps.some((step, index) => step.status === 'waiting' && isPrompt(index))
              ? { status: task.steps.some((step, index) => step.status === 'waiting' && stageOf(index) === 'reminder') ? s.sectionQuestionReminders : s.sectionOlderQuestions, tone: 'quiet' as const }
              : stepPhrase(task, s, isPrompt)
      const open = task.steps[currentStepIndex(task)]
      const row: TaskRow = {
        key,
        project: name,
        title,
        context,
        done,
        total,
        ...phrase,
        when: isIdle ? relativeTime(lastActive ?? 0, now, s) : when,
        isHere,
        auto,
        steps: rowSteps(task, s),
        left: task.steps.filter(step => step.status !== 'done' && step.status !== 'cancelled').map(step => step.text),
        question: ((asked: ProgressStep | undefined) => (asked === undefined ? null : splitNote(asked.text).text))(
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
        confirm: (isManual && task.line >= 0 || auto === 'ended')
          ? { project: name, title: task.title, line: task.line, session: task.auto?.session ?? null, expected: confirmKey(name, task, projects.filter(one => (one.name || s.uncategorized) === name).flatMap(one => one.tasks).filter(one => one.title === task.title).length) }
          : null,
        archive:
          isManual && task.line >= 0
            ? { project: name, title: task.title, line: task.line, session: null }
            : auto === 'ended' && task.auto !== null
              ? { project: name, title: task.title, line: task.line, session: task.auto.session }
              : null,
        target: targetOf(task.auto),
        ...(task.auto === null ? {} : { nativeSession: task.auto.resume ?? task.auto.session }),
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

  due.sort((a, b) => a.days - b.days)
  active.sort((a, b) => a.rank - b.rank || a.order - b.order)
  recent.sort((a, b) => b.at - a.at)
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
    const id = observed?.keys[pendingQuestionSlot(questionScope(turn.project, turn.agent, turn.id ?? ''), turn.text)]
    if (id === undefined || waiting.some(item => item.questionId === id)) return []
    const parts = splitNote(turn.text)
    return [{ key: `inbox::${id}`, questionId: id, project: turn.project, task: '', context: '', ...parts, when: '', ...askOf(parts.text, parts.note), where: 'other' as const, agent: turn.agent, session: turn.id ?? '', sessionId: null, resumeVia: null, reopen: null, hideKey: id, step: null, target: null }]
  })
  const own = mine === null ? [] : ownWaiting(mine, observed?.keys).map(item => ({ ...item, questionId: item.hideKey }))
  const isResolved = (item: WaitingItem): boolean => observed?.ledger.records.find(record => record.id === item.questionId)?.isUnresolved === false
  const all = [...own, ...waiting, ...inbox].filter(item => !isResolved(item)).map(item => {
    const record = observed?.ledger.records.find(row => row.id === item.questionId)
    const age = questionAge(record?.firstObserved ?? 0, now)
    return { ...item, ageStage: age.stage, when: age.age === null ? s.questionAgeUnknown : relativeTime(record?.firstObserved ?? 0, now, s) }
  }).sort(
    (a, b) => whereRank(a) - whereRank(b) || askRank(a.kind) - askRank(b.kind),
  )
  const asks: WaitingItem[] = all.filter(item => item.ageStage === 'pending' && (item.hideKey === '' || !marked.has(item.hideKey)))
  const reminder: WaitingItem[] = all.filter(item => item.ageStage === 'reminder' && (item.hideKey === '' || !marked.has(item.hideKey)))
  const older: WaitingItem[] = all.filter(item => item.ageStage === 'older' && (item.hideKey === '' || !marked.has(item.hideKey)))
  const hidden: WaitingItem[] = all.filter(item => item.hideKey !== '' && marked.has(item.hideKey))
  for (const record of observed?.ledger.records ?? []) {
    if (!record.isUnresolved || record.source === undefined || all.some(item => item.questionId === record.id)) continue
    const source = record.source
    const parts = splitNote(source.text)
    const age = questionAge(record.firstObserved, now)
    const stage = record.isArchived ? 'older' : age.stage
    const item: WaitingItem = { key: `retained::${record.id}`, questionId: record.id, ageStage: stage, project: source.project, task: source.task, context: source.context, ...parts, when: age.age === null ? s.questionAgeUnknown : relativeTime(record.firstObserved, now, s), ...askOf(parts.text, parts.note), where: 'other', agent: source.agent === 'claude' ? '' : source.agent, session: source.session, sessionId: null, resumeVia: null, reopen: null, hideKey: record.id, canHide: false, step: null, target: null }
    if (marked.has(record.id)) hidden.push(item)
    else if (stage === 'pending') asks.push(item)
    else if (stage === 'reminder') reminder.push(item)
    else older.push(item)
  }
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
    hasPendingQuestions: questions !== undefined,
    idle,
    stopped: stopped.map(item => item.row),
    due: dueRows,
    active: rows,
    groups,
    recent: recent.slice(0, 3).map(({ at: _at, ...item }) => item),
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

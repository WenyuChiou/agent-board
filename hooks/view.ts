import type { ProgressAuto, ProgressMirror, ProgressProject, ProgressStepStatus, ProgressTask } from '../types'
import { askOf, askRank } from './ask'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import type { AskKind } from './ask'
import { shortId } from './blocks'
import { ciWords, prWords } from './github'
import { doingTask, fallbackTitle } from './mirror'
import type { Tone } from './palette'
import { countSteps, currentStepIndex, doneKey, isHereProject, isStale, isTaskComplete } from './parse'

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

export type WaitingItem = {
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
  // A hand-kept step can be ticked from the pane; another session's cannot.
  step: StepRef | null
}

// The one thing the top of the pane puts in front of the person: the most pressing thing
// they can act on, chosen in this order: something to answer or do now, work due today or
// overdue, something stuck, then something that waits on someone else.
export type Focus =
  | { type: 'ask'; item: WaitingItem }
  | { type: 'due'; row: TaskRow }
  | { type: 'blocked'; row: TaskRow }

export type TaskRow = {
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
  // Set when the person may take the row out now: a hand-kept task, or a block whose session
  // ended or stopped. A live session's block is that session's to change.
  archive: TaskRef | null
}

// This session's pull request, for the card.
export type PrView = { text: string; url: string; tone: Tone }

export type DoneItem = { project: string; title: string; when: string }

// Other work, one group per project, this session's project first; `summary` says it in a
// line (`3 件 · 1 等你 · 1 已停`) for while the list is folded.
export type RowGroup = { project: string; isHere: boolean; rows: TaskRow[]; summary: string }

// The line of counts at the top: what waits on you (here and elsewhere), what is open,
// what is due within two weeks (the 快到期 list), and the steps finished today.
export type Overview = { waiting: number; active: number; due: number; today: number }

export type View = {
  current: CurrentView | null
  pr: PrView | null
  overview: Overview
  focus: Focus | null
  waiting: WaitingItem[]
  due: TaskRow[]
  active: TaskRow[]
  groups: RowGroup[]
  recent: DoneItem[]
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

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

// A task's background: its `> 背景：` line; for a hand-kept task, its other notes.
export const contextOf = (task: ProgressTask): string => {
  const marked = task.notes.find(note => CONTEXT.test(note))
  if (marked !== undefined) return marked.replace(CONTEXT, '')
  if (task.auto !== null) return ''

  return task.notes
    .map(note => note.replace(DUE_WORDS, '').replace(/^[\s·・,，]+|[\s·・,，]+$/g, ''))
    .filter(note => note !== '')
    .join(' · ')
}

const stepPhrase = (task: ProgressTask, s: Strings): { status: string; tone: Tone } => {
  const blocked = task.steps.find(step => step.status === 'blocked')
  if (blocked !== undefined) return { status: s.stuck(splitNote(blocked.text).text), tone: 'alert' }
  const waiting = task.steps.find(step => step.status === 'waiting')
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
  const waitingYou = mirror.tasks.find(task => task.status !== 'completed' && task.waiting === 'you')
  const blocked = mirror.tasks.find(task => task.status !== 'completed' && task.blocked !== null)
  const done = mirror.tasks.filter(task => task.status === 'completed').length
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
    let stepStatus: ProgressStepStatus = task.status === 'completed' ? 'done' : 'todo'
    if (task.status !== 'completed') {
      if (task.blocked !== null) stepStatus = 'blocked'
      else if (task.waiting === 'you') stepStatus = 'waiting'
      else if (task.waiting === 'run') stepStatus = 'running'
      else if (task.status === 'in_progress') stepStatus = 'doing'
    }
    const note = stepStatus === 'blocked' ? (task.blocked ?? '') : stepStatus === 'done' ? '' : (task.why ?? '')
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
    total: mirror.tasks.length,
    steps: foldSteps(steps, 6, s),
  }
}

// Reopens an ended session where it ran: PowerShell for a Windows folder, a POSIX shell
// otherwise. Both quote the folder, so spaces and quotes in it survive.
export const resumeCommand = (sessionId: string, dir: string | null): string => {
  const resume = `claude --resume ${sessionId}`
  if (dir === null || dir === '') return resume
  if (/^[A-Za-z]:[\\/]|\\/.test(dir)) return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'; ${resume}`

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
const ownWaiting = (mine: ProgressMirror): WaitingItem[] => {
  const title = mine.title || fallbackTitle(mine)
  const context = contextFor(mine)

  return mine.tasks
    .filter(task => task.status !== 'completed' && task.waiting === 'you')
    .map(task => ({
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
      step: null,
    }))
}

const whereRank = (item: WaitingItem): number => (item.where === 'here' ? 0 : 1)

export const buildView = (
  projects: readonly ProgressProject[],
  here: readonly string[],
  mine: ProgressMirror | null,
  now: number,
  today = 0,
  // When the pane first saw each hand-kept task done (by doneKey); one it has not seen counts
  // as done just now.
  doneSeen: Readonly<Record<string, number>> = {},
  s: Strings = ZH_TW,
): View => {
  const ownId = mine === null ? '' : shortId(mine.sessionId)
  const waiting: WaitingItem[] = []
  const due: Array<TaskRow & { days: number }> = []
  const active: Array<TaskRow & { rank: number; order: number }> = []
  const recent: Array<DoneItem & { at: number }> = []
  let order = 0
  const seen = new Map<string, number>()

  for (const project of projects) {
    const name = project.name || s.uncategorized
    const isHere = isHereProject(name, here)
    for (const task of project.tasks) {
      if (task.auto !== null && task.auto.session === ownId) continue
      order += 1
      const title = task.title || s.unnamed
      // A repeated title gets #2, #3, … so its row and buttons are its own.
      const base = `${name}::${title}`
      const repeat = (seen.get(base) ?? 0) + 1
      seen.set(base, repeat)
      const key = repeat === 1 ? base : `${base}#${repeat}`
      const updated = task.auto?.updated ?? 0
      const when = relativeTime(updated, now, s)
      const isComplete = isTaskComplete(task) || task.auto?.state === 'done'
      const isManual = task.auto === null
      const context = contextOf(task)
      // A session that stopped writing is treated as ended: its questions wait in its row,
      // not in 等你處理, where nobody could answer them.
      const stale = isStale(task.auto, now)
      const isLive = task.auto !== null && task.auto.state !== 'ended' && !stale

      task.steps.forEach((step, index) => {
        if (step.status !== 'waiting' || (!isManual && !isLive)) return
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
          step: isManual ? { project: name, title, step: step.text, line: step.line, raw: step.raw } : null,
        })
      })

      if (isComplete) {
        const seen = isManual ? (doneSeen[doneKey(name, title)] ?? now) : updated
        if (now - seen < DAY) recent.push({ project: name, title, when: relativeTime(seen, now, s), at: seen })
        continue
      }

      const auto = task.auto === null || task.auto.state === 'done' ? null : stale ? 'ended' : task.auto.state
      if (auto === 'waiting') {
        if (!task.steps.some(step => step.status === 'waiting')) {
          waiting.push({
            key,
            project: name,
            task: title,
            context,
            text: s.waitingReply,
            note: '',
            when,
            kind: 'reply',
            options: [],
            command: null,
            link: null,
            where: 'other',
            agent: task.auto?.agent === 'claude' ? '' : (task.auto?.agent ?? ''),
            step: null,
          })
        }
        continue
      }

      const { done, total } = countSteps(task)
      const phrase =
        auto === 'working'
          ? { status: task.auto?.agent === 'claude' ? s.claudeWorking : s.agentWorking(task.auto?.agent ?? ''), tone: 'accent' as const }
          : auto === 'ended'
            ? { status: stale ? s.sessionStopped(when) : s.sessionEnded, tone: 'warn' as const }
            : stepPhrase(task, s)
      const open = task.steps[currentStepIndex(task)]
      const row: TaskRow = {
        key,
        project: name,
        title,
        context,
        done,
        total,
        ...phrase,
        when,
        isHere,
        auto,
        steps: rowSteps(task, s),
        left: task.steps.filter(step => step.status !== 'done' && step.status !== 'cancelled').map(step => step.text),
        next:
          isManual && open !== undefined
            ? { project: name, title, step: open.text, line: open.line, raw: open.raw }
            : null,
        due: null,
        pr: autoPr(task.auto, s),
        agent: task.auto === null || task.auto.agent === 'claude' ? '' : task.auto.agent,
        // Only Claude's sessions reopen with `claude --resume`.
        resume:
          auto === 'ended' && task.auto?.agent === 'claude' && task.auto.resume
            ? resumeCommand(task.auto.resume, task.auto.dir)
            : null,
        archive:
          isManual && task.line >= 0
            ? { project: name, title: task.title, line: task.line, session: null }
            : auto === 'ended' && task.auto !== null
              ? { project: name, title: task.title, line: task.line, session: task.auto.session }
              : null,
      }

      // Work with a date close by is listed once, under 快到期.
      const days = task.due === null ? null : dueDays(task.due, now)
      if (task.due !== null && days !== null && days <= 14) {
        due.push({ ...row, due: { date: task.due, ...dueLabel(days, s) }, days })
        continue
      }
      active.push({ ...row, rank: isHere ? 0 : 1, order })
    }
  }

  due.sort((a, b) => a.days - b.days)
  active.sort((a, b) => a.rank - b.rank || a.order - b.order)
  recent.sort((a, b) => b.at - a.at)

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
      count(row => row.tone === 'warn' && row.auto !== 'ended', s.groupWaiting),
      count(row => row.tone === 'alert', s.groupStuck),
      count(row => row.auto === 'ended', s.groupStopped),
      count(row => row.auto === 'working', s.groupWorking),
    ]
      .filter(part => part !== '')
      .join(' · ')
  }

  const asks = [...(mine === null ? [] : ownWaiting(mine)), ...waiting].sort(
    (a, b) => whereRank(a) - whereRank(b) || askRank(a.kind) - askRank(b.kind),
  )
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

  return {
    current: mine === null ? null : currentOf(mine, s),
    pr: prView(mine, s),
    overview: { waiting: asks.length, active: rows.length + due.length, due: due.length, today },
    focus,
    waiting: asks,
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

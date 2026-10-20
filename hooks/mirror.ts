import type { ProgressMirror, ProgressMirrorTask, ProgressSessionState, ProgressTask } from '../types'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { sha256 } from './sha256'
import { normalizeTurnOrder } from './inbox'
import { renewQuestion } from './step-words'
export { renewQuestion } from './step-words'

// Claude's own task list, mirrored from the calls it makes (TaskCreate, TaskUpdate,
// TodoWrite). The list is the source of truth; the file is a view of it.

type Status = ProgressMirrorTask['status']

export const confirmMirror = (mirror: ProgressMirror, now: number): ProgressMirror => ({
  ...mirror,
  state: 'done',
  updated: now,
  confirmedAt: now,
  autoAsk: null,
  tasks: mirror.tasks.map(task => ({ ...task, status: 'completed', waiting: null, blocked: null, blockedBy: [] })),
})

export type CompletionOverlay = {
  owner: string
  source: string
  sourceOrder?: number
  sourceMissing?: true
  updated: number
  completed: ProgressMirror
}

export const completionPrefix = (owner: string): string => `completion:${sha256(owner)}:`
export const completionOverlay = (owner: string, source: ProgressMirror, now: number): CompletionOverlay => ({
  owner,
  source: sha256(JSON.stringify(source)),
  ...(normalizeTurnOrder(source.turnOrder) === undefined ? {} : { sourceOrder: normalizeTurnOrder(source.turnOrder) }),
  updated: now,
  completed: confirmMirror(source, now),
})
export const completionKey = (overlay: CompletionOverlay): string => `${completionPrefix(overlay.owner)}${overlay.source}:${overlay.updated}`

const isRetainedCancelled = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 256 && Array.from(value).every(text => typeof text === 'string' && text.length <= 4096 && !/[\r\n]/.test(text))

export const retainedCancelledOf = (mirror: ProgressMirror): readonly string[] =>
  isRetainedCancelled(mirror.retainedCancelled) ? mirror.retainedCancelled : []

// An externally written block can predate its first inbox delivery. Keep its exact
// selected fingerprint and completed steps without creating a mutable owner record.
export const completionOfBlock = (owner: string, project: string, task: ProgressTask, fingerprint: string, now: number): CompletionOverlay | null => {
  const auto = task.auto
  if (auto === null || !/^[a-f0-9]{64}$/.test(fingerprint) || owner !== `agent:${auto.session}` && !(auto.agent === 'claude' && owner === `mirror:${auto.resume ?? auto.session}`)) return null
  const sessionId = owner.slice(owner.indexOf(':') + 1)
  const retainedCancelled = task.steps.filter(step => step.status === 'cancelled').map(step => step.text)
  if (!isRetainedCancelled(retainedCancelled)) return null
  const tasks: ProgressMirrorTask[] = task.steps.filter(step => step.status !== 'cancelled').map((step, index) => ({
    id: String(index + 1), subject: step.text, status: 'completed', activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [],
  }))
  const completed = confirmMirror({ ...emptyMirror(sessionId, project, auto.updated, auto.dir ?? '', auto.agent), title: task.title, isTitleFinal: true, source: owner.startsWith('agent:') ? 'turns' : 'tasks', tasks, ...(retainedCancelled.length === 0 ? {} : { retainedCancelled }), ...(auto.resume === null ? {} : { resume: auto.resume }) }, now)
  return { owner, source: fingerprint, sourceMissing: true, updated: now, completed }
}

export const isCompletionOverlay = (value: unknown, owner: string): value is CompletionOverlay => {
  if (value === null || typeof value !== 'object') return false
  const one = value as Partial<CompletionOverlay>
  if (one.completed?.retainedCancelled !== undefined && !isRetainedCancelled(one.completed.retainedCancelled)) return false
  return one.owner === owner && typeof one.source === 'string' && /^[a-f0-9]{64}$/.test(one.source) && typeof one.updated === 'number' && Number.isFinite(one.updated) && one.updated > 0 && (one.sourceMissing === undefined || one.sourceMissing === true) && (one.sourceOrder === undefined || Number.isSafeInteger(one.sourceOrder) && one.sourceOrder >= 0) && one.completed?.state === 'done' && one.completed.confirmedAt === one.updated && typeof one.completed.sessionId === 'string' && (owner === `agent:${one.completed.sessionId}` || owner === `mirror:${one.completed.sessionId}`) && typeof one.completed.agent === 'string' && Array.isArray(one.completed.tasks) && one.completed.tasks.every(task => task !== null && typeof task === 'object' && task.status === 'completed')
}

// Completion never writes the owner's mutable record. Exact source snapshots and
// provably older ordered events can be projected complete; fresh work keeps its record.
export const applyCompletionOverlay = (source: ProgressMirror, overlay: CompletionOverlay): ProgressMirror => {
  if (source.sessionId !== overlay.completed.sessionId || source.agent !== overlay.completed.agent) return source
  const order = normalizeTurnOrder(source.turnOrder)
  if (overlay.sourceMissing === true) return order !== undefined && order < overlay.updated * 2 ? overlay.completed : source
  const older = order !== undefined && overlay.sourceOrder !== undefined && order < overlay.sourceOrder && source.updated <= overlay.updated
  return sha256(JSON.stringify(source)) === overlay.source || older ? overlay.completed : source
}

export type TaskCreateInput = { subject: string; activeForm?: string | undefined; metadata?: object | undefined }

export type TaskUpdateInput = {
  taskId: string
  subject?: string | undefined
  activeForm?: string | undefined
  status?: Status | 'deleted' | undefined
  addBlockedBy?: readonly string[] | undefined
  metadata?: object | undefined
}

export type TodoInput = { content: string; status: Status; activeForm: string }

export const emptyMirror = (sessionId: string, project: string, now: number, cwd = '', agent = 'claude'): ProgressMirror => ({
  sessionId,
  agent,
  project,
  cwd,
  branch: '',
  pr: null,
  title: '',
  context: '',
  isTitleFinal: false,
  firstPrompt: '',
  state: 'working',
  tasks: [],
  updated: now,
  source: 'tasks',
  autoAsk: null,
  handoff: '',
  namedSteps: 0,
  lastAnswer: '',
  answered: {},
})

// A short key for a step's words (FNV-1a, 32 bits, in hex): an answer is kept for the words
// it answered, so the same step asking something new waits on the person again.
const stepKey = (text: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

// The words a step asks with, as the person saw them: its subject and its note.
const askedWords = (task: ProgressMirrorTask): string => `${task.subject}\n${task.why ?? ''}`

// An open step that asked the person, answered since, and still asking the same.
export const isAnswered = (mirror: ProgressMirror, task: ProgressMirrorTask): boolean =>
  task.status !== 'completed' && task.waiting === 'you' && mirror.answered?.[task.id] === stepKey(askedWords(task))

// A step that waits on the person: asked, open, and not answered since.
export const waitsOnYou = (mirror: ProgressMirror, task: ProgressMirrorTask): boolean =>
  task.status !== 'completed' && task.waiting === 'you' && !isAnswered(mirror, task)

// The person answered: the steps that wait on them (all, or the ones `only` names) are marked
// answered with the words they answered. What the steps asked stays, for Claude's next call.
export const markAnswered = (mirror: ProgressMirror, only?: readonly string[]): ProgressMirror => {
  const answered: Record<string, string> = {}
  for (const task of mirror.tasks) {
    if (task.status === 'completed' || task.waiting !== 'you') continue
    if (isAnswered(mirror, task) || (waitsOnYou(mirror, task) && (only === undefined || only.includes(task.id)))) {
      answered[task.id] = stepKey(askedWords(task))
    }
  }

  return { ...mirror, answered }
}

// Marks without the steps they name: a step asked again, gone, or renumbered.
export const withoutMarks = (mirror: ProgressMirror, ids: readonly string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(mirror.answered ?? {}).filter(([id]) => !ids.includes(id)))

const WAITING_YOU = new Set(['you', 'user', 'me', 'human', 'person', '使用者', '用户', '我'])

const waitingOf = (value: unknown, current: ProgressMirrorTask['waiting']): ProgressMirrorTask['waiting'] => {
  if (value === undefined) return current
  if (value === null || value === false || value === '') return null
  if (typeof value === 'string' && WAITING_YOU.has(value.toLowerCase())) return 'you'

  return 'run'
}

const blockedOf = (value: unknown, current: string | null): string | null => {
  if (value === undefined) return current
  if (value === null || value === false || value === '') return null

  return value === true ? '' : String(value)
}

// The one line that says what a waiting step needs: `why`, or the words Claude reaches for.
const WHY_KEYS = ['why', 'reason', 'question', 'note'] as const

const whyOf = (meta: Record<string, unknown>, waiting: ProgressMirrorTask['waiting'], current: string | null): string | null => {
  if (waiting === null) return null
  for (const key of WHY_KEYS) {
    const value = meta[key]
    if (value === null || value === '') return null
    if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim()
  }

  return current
}

const textOr = (value: unknown, current: string | null): string | null => {
  if (value === undefined) return current
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

// What the person is asked for, kept while the step waits and dropped when it stops.
const askFields = (
  meta: Record<string, unknown>,
  waiting: ProgressMirrorTask['waiting'],
  task: ProgressMirrorTask,
): Pick<ProgressMirrorTask, 'ask' | 'options' | 'command' | 'link'> => {
  if (waiting === null) return { ask: null, options: [], command: null, link: null }
  const options = Array.isArray(meta.options)
    ? meta.options.filter((one): one is string => typeof one === 'string' && one.trim() !== '').map(one => one.trim())
    : meta.options === null
      ? []
      : (task.options ?? [])

  return {
    ask: textOr(meta.ask, task.ask ?? null),
    options,
    command: textOr(meta.command, task.command ?? null),
    link: textOr(meta.link, task.link ?? null),
  }
}

// `metadata: { waiting: "you" | "run", why: "what it needs", ask: "confirm", options: [...],
// command: "...", link: "...", blocked: "why" }`; a key set to null clears it, and clearing
// `waiting` clears what it asked.
const withMetadata = (task: ProgressMirrorTask, metadata: object | undefined): ProgressMirrorTask => {
  if (metadata === undefined) return task
  const meta = metadata as Record<string, unknown>
  const waiting = waitingOf(meta.waiting, task.waiting)
  const handoffTo = textOr(meta.handoffTo, task.handoffTo ?? null)?.replace(/\s+/g, ' ').slice(0, 120)
  if (handoffTo) return { ...task, status: 'completed', waiting: null, why: null, ...NO_ASK, blocked: null, handoffTo }

  return {
    ...task,
    handoffTo: undefined,
    waiting,
    why: whyOf(meta, waiting, task.why ?? null),
    ...askFields(meta, waiting, task),
    blocked: blockedOf(meta.blocked, task.blocked),
  }
}

const NO_ASK = { ask: null, options: [], command: null, link: null }

export const questionToken = (task: ProgressMirrorTask): string =>
  /^[1-9]\d*$/.test(task.questionRevision ?? '') ? `${sha256(task.id)}:${task.questionRevision}` : ''

export const applyTaskCreate = (
  mirror: ProgressMirror,
  input: TaskCreateInput,
  id: string,
  now: number,
): ProgressMirror => {
  const previous = mirror.tasks.find(one => one.id === id)
  const given = withMetadata(
    {
      id,
      subject: input.subject,
      status: 'pending',
      activeForm: input.activeForm ?? '',
      waiting: null,
      why: null,
      ...NO_ASK,
      blocked: null,
      blockedBy: [],
      ...(previous?.questionRevision === undefined ? {} : { questionRevision: previous.questionRevision }),
    },
    input.metadata,
  )
  const task = given.waiting === 'you' ? renewQuestion(given, mirror.questionSequence) : given
  // Steps summed up from turns give way to the real list the moment Claude starts one.
  const kept = mirror.source === 'turns' ? [] : mirror.tasks
  const tasks = [...kept.filter(one => one.id !== id), task]

  return {
    ...mirror,
    tasks,
    ...(given.waiting === 'you' ? { questionSequence: task.questionRevision } : {}),
    source: 'tasks',
    autoAsk: mirror.source === 'turns' ? null : mirror.autoAsk,
    answered: mirror.source === 'turns' ? {} : withoutMarks(mirror, [id]),
    updated: now,
  }
}

// Whether a TaskUpdate's metadata asks the person (again).
const asksYou = (metadata: object | undefined): boolean =>
  metadata !== undefined && waitingOf((metadata as Record<string, unknown>).waiting, null) === 'you'

export const applyTaskUpdate = (mirror: ProgressMirror, input: TaskUpdateInput, now: number): ProgressMirror => {
  if (input.status === 'deleted') {
    return { ...mirror, tasks: mirror.tasks.filter(one => one.id !== input.taskId), answered: withoutMarks(mirror, [input.taskId]), updated: now }
  }
  const status = input.status
  const tasks = mirror.tasks.map(task => {
    if (task.id !== input.taskId) return task
    const next: ProgressMirrorTask = {
      ...task,
      // An explicit new owner update can reclaim the task. A passive TaskList cannot.
      handoffTo: input.status === 'pending' || input.status === 'in_progress' || (input.subject !== undefined && input.subject !== task.subject) ? undefined : task.handoffTo,
      subject: input.subject ?? task.subject,
      activeForm: input.activeForm ?? task.activeForm,
      status: status ?? task.status,
      blockedBy: [...new Set([...task.blockedBy, ...(input.addBlockedBy ?? [])])],
    }
    // Finishing a step clears what it was waiting on.
    const done = next.status === 'completed' ? { ...next, waiting: null, why: null, ...NO_ASK, blocked: null } : next

    const meta = input.metadata as Record<string, unknown> | undefined
    const completedMeta = meta !== undefined && Object.hasOwn(meta, 'handoffTo') ? { handoffTo: meta.handoffTo } : undefined
    const updated = withMetadata(done, next.status === 'completed' ? completedMeta : input.metadata)
    // Handoff metadata can close a task that was pending at the start of this
    // update. Only the final open question is a new producer ask.
    return updated.status !== 'completed' && updated.waiting === 'you' && asksYou(input.metadata) ? renewQuestion(updated, mirror.questionSequence) : updated
  })
  // Claude asking the person again brings the step back, even in the words they answered.
  const updated = tasks.find(task => task.id === input.taskId)
  const isAskedAgain = updated !== undefined && updated.status !== 'completed' && updated.waiting === 'you' && asksYou(input.metadata)

  return { ...mirror, tasks, ...(isAskedAgain ? { questionSequence: tasks.find(task => task.id === input.taskId)?.questionRevision ?? mirror.questionSequence } : {}), answered: isAskedAgain ? withoutMarks(mirror, [input.taskId]) : mirror.answered, updated: now }
}

export const applyTodoWrite = (mirror: ProgressMirror, todos: readonly TodoInput[], now: number): ProgressMirror => ({
  ...mirror,
  source: 'tasks',
  autoAsk: null,
  answered: {},
  tasks: todos.map((todo, index) => {
    const previous = mirror.tasks.find(one => one.id === String(index + 1))
    return {
      id: String(index + 1),
      subject: todo.content,
      status: todo.status,
      activeForm: todo.activeForm,
      waiting: null,
      why: null,
      ...NO_ASK,
      blocked: null,
      blockedBy: [],
      ...(previous?.questionRevision === undefined ? {} : { questionRevision: previous.questionRevision }),
    }
  }),
  updated: now,
})

export type ListedTask = { id: string; subject: string; status: Status; blockedBy: readonly string[] }

// TaskList after a reload or a resume: keeps what the mirror knew of each task.
export const fromTaskList = (mirror: ProgressMirror, listed: readonly ListedTask[], now: number): ProgressMirror =>
  mirror.source === 'turns' && listed.length === 0 ? mirror : readList(mirror, listed, now)

const readList = (mirror: ProgressMirror, listed: readonly ListedTask[], now: number): ProgressMirror => ({
  ...mirror,
  source: 'tasks',
  // Marks of steps no longer listed go, and the turns' steps had none of Claude's.
  answered: mirror.source === 'turns' ? {} : Object.fromEntries(Object.entries(mirror.answered ?? {}).filter(([id]) => listed.some(item => item.id === id))),
  tasks: listed.map(item => {
    const known = mirror.tasks.find(task => task.id === item.id)
    const handoffTo = known?.handoffTo && known.subject === item.subject ? known.handoffTo : undefined
    const status = handoffTo ? 'completed' : item.status

    return {
      id: item.id,
      subject: item.subject,
      status,
      ...(handoffTo ? { handoffTo } : {}),
      activeForm: known?.activeForm ?? '',
      waiting: status === 'completed' ? null : (known?.waiting ?? null),
      why: status === 'completed' ? null : (known?.why ?? null),
      ask: status === 'completed' ? null : (known?.ask ?? null),
      options: status === 'completed' ? [] : (known?.options ?? []),
      command: status === 'completed' ? null : (known?.command ?? null),
      link: status === 'completed' ? null : (known?.link ?? null),
      blocked: status === 'completed' ? null : (known?.blocked ?? null),
      blockedBy: [...item.blockedBy],
      ...(known?.questionRevision === undefined ? {} : { questionRevision: known.questionRevision }),
    }
  }),
  updated: now,
})

export const isAllDone = (mirror: ProgressMirror): boolean =>
  mirror.tasks.length > 0 && mirror.tasks.every(task => task.status === 'completed')

// Steps that finished between two states of the mirror, for the journal. Matched by
// subject, since TodoWrite numbers its list afresh on every call.
export const completedSince = (before: ProgressMirror, after: ProgressMirror): ProgressMirrorTask[] =>
  after.tasks.filter(
    task => task.status === 'completed' && !task.handoffTo && !before.tasks.some(old => old.status === 'completed' && old.subject === task.subject),
  )

// What deserves a desktop notification between two states of the mirror: a step that now
// needs the person, and the whole list finishing.
export const noticesOf = (before: ProgressMirror, after: ProgressMirror, s: Strings = ZH_TW): string[] => {
  const needs = after.tasks.filter(task => waitsOnYou(after, task) && !before.tasks.some(old => old.id === task.id && waitsOnYou(before, old)))
  const title = after.title || fallbackTitle(after)

  return [
    ...needs.map(task => s.noticeNeedsYou(task.subject)),
    ...(isAllDone(after) && !isAllDone(before) && completedSince(before, after).length > 0 ? [s.noticeDone(title, after.tasks.filter(task => !task.handoffTo).length)] : []),
  ]
}

export const stateOf = (mirror: ProgressMirror, isTurnRunning: boolean): ProgressSessionState => {
  if (isAllDone(mirror)) return 'done'

  return isTurnRunning ? 'working' : 'waiting'
}

export const doingTask = (mirror: ProgressMirror): ProgressMirrorTask | undefined =>
  mirror.tasks.find(task => task.status === 'in_progress' && (task.waiting === null || isAnswered(mirror, task)) && task.blocked === null) ??
  mirror.tasks.find(task => task.status === 'in_progress')

// A CJK or full-width character takes two terminal cells, anything else one.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u
const cells = (char: string): number => (WIDE.test(char) || char.length > 1 ? 2 : 1)

// Text cut to `width` cells with `…`, at a space when the text is words, so a limit sized
// for Chinese does not chop English mid-word ("Add README describing in").
export const clip = (text: string, width: number): string => {
  const chars = [...text]
  let used = 0
  let fits = 0
  for (const char of chars) {
    if (used + cells(char) > width) break
    used += cells(char)
    fits += 1
  }
  if (fits === chars.length) return text
  const room = chars.slice(0, Math.max(0, fits - 1))
  const space = room.lastIndexOf(' ')
  const kept = space > room.length / 2 ? room.slice(0, space) : room

  return `${kept.join('').replace(/[\s,.;:，、；：]+$/, '')}…`
}

// A title until the model names the task: the first line of the request, or the first step.
export const fallbackTitle = (mirror: ProgressMirror): string => {
  const prompt = mirror.firstPrompt.split(/\r?\n/).find(line => line.trim() !== '')?.trim() ?? ''
  const source = prompt !== '' ? prompt : (mirror.tasks[0]?.subject ?? '')

  return clip(source, 38)
}

// What the model answered, made into a title: one line, no quotes or end punctuation.
export const cleanTitle = (answer: string): string => {
  const line = answer.split(/\r?\n/).find(one => one.trim() !== '')?.trim() ?? ''
  const bare = line.replace(/^["'「『《【\s]+|["'」』》】。．.！!？?\s]+$/g, '').replace(/^(任務名稱|名稱|Title)[:：]\s*/i, '')

  return clip(bare, 48)
}

// The model's second line, made into one line of background.
export const cleanContext = (answer: string): string => {
  const line = answer
    .replace(/^["'「『\s]+|["'」』\s]+$/g, '')
    .replace(/^(背景|Background|Context)\s*[:：]\s*/i, '')
    .replace(/\s+/g, ' ')

  return clip(line.trim(), 120)
}

// Text from progress.md, which any program can write, made fit to show Claude as data: one
// line, no backtick to close the fence it sits in, no comment or marker opening, at most
// `limit` characters.
export const asData = (text: string, limit = 120): string => {
  const line = text
    .replace(/`/g, "'")
    .replace(/<!--|-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...line]

  return chars.length <= limit ? line : `${chars.slice(0, limit - 1).join('')}…`
}

// Lines of file text for Claude, inside a fence and after a sentence saying they are data,
// not instructions; each line should already have been through asData.
export const dataBlock = (lines: readonly string[], s: Strings = ZH_TW): string[] =>
  lines.length === 0 ? [] : [s.dataNote, '```text', ...lines, '```']

// The note the conversation gets after a compaction: where this session's task stands.
export const resumeNote = (mirror: ProgressMirror, s: Strings = ZH_TW): string | null => {
  const open = mirror.tasks.filter(task => task.status !== 'completed')
  if (open.length === 0) return null
  const total = mirror.tasks.filter(task => !task.handoffTo).length
  const done = total - open.length
  const doing = doingTask(mirror)
  const next = open.filter(task => task !== doing).slice(0, 4)
  const waiting = open.filter(task => waitsOnYou(mirror, task) || task.blocked !== null)
  const facts = [
    s.resumeGoal(asData(mirror.title || fallbackTitle(mirror)), asData(mirror.project)),
    mirror.context === '' || mirror.context === undefined ? '' : s.resumeContext(asData(mirror.context)),
    s.resumeDone(done, total),
    doing === undefined ? '' : s.resumeDoing(asData(doing.subject)),
    next.length === 0 ? '' : s.resumeNext(next.map(task => asData(task.subject)).join(s.stepSep)),
    waiting.length === 0
      ? ''
      : s.resumeWaiting(waiting.map(task => asData(task.blocked ? `${task.subject} (${task.blocked})` : task.subject)).join(s.stepSep)),
  ].filter(line => line !== '')

  return [s.resumeHead, ...dataBlock(facts, s), s.resumeTail].join('\n')
}

// Only the mod's own per-session records age out of the store; a setting the person made
// (closing the pane by hand) stays until they change it.
export const isStaleStoreKey = (key: string, value: unknown, now: number, maxAge: number): boolean => {
  // Prompt and completion fences outlive paused writers. Age alone cannot prove
  // that an old mirror will never return; new ordered work supersedes them on read.
  if (!['mirror:', 'hinted:', 'done:', 'agent:'].some(prefix => key.startsWith(prefix))) return false
  const stamp = typeof value === 'number' ? value : ((value as { updated?: number } | undefined)?.updated ?? 0)

  return now - stamp > maxAge
}

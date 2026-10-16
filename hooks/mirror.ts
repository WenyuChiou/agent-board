import type { ProgressMirror, ProgressMirrorTask, ProgressSessionState } from '../types'

// Claude's own task list, mirrored from the calls it makes (TaskCreate, TaskUpdate,
// TodoWrite). The list is the source of truth; the file is a view of it.

type Status = ProgressMirrorTask['status']

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

export const emptyMirror = (sessionId: string, project: string, now: number, cwd = ''): ProgressMirror => ({
  sessionId,
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
})

const WAITING_YOU = new Set(['you', 'user', 'me', 'human', '使用者', '我'])

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
const WHY_KEYS = ['why', 'reason', 'question', 'ask', 'note'] as const

const whyOf = (meta: Record<string, unknown>, waiting: ProgressMirrorTask['waiting'], current: string | null): string | null => {
  if (waiting === null) return null
  for (const key of WHY_KEYS) {
    const value = meta[key]
    if (value === null || value === '') return null
    if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim()
  }

  return current
}

// `metadata: { waiting: "you" | "run", why: "what it needs", blocked: "why" }`; a key set to
// null clears it, and clearing `waiting` clears its `why`.
const withMetadata = (task: ProgressMirrorTask, metadata: object | undefined): ProgressMirrorTask => {
  if (metadata === undefined) return task
  const meta = metadata as Record<string, unknown>
  const waiting = waitingOf(meta.waiting, task.waiting)

  return { ...task, waiting, why: whyOf(meta, waiting, task.why ?? null), blocked: blockedOf(meta.blocked, task.blocked) }
}

export const applyTaskCreate = (
  mirror: ProgressMirror,
  input: TaskCreateInput,
  id: string,
  now: number,
): ProgressMirror => {
  const task = withMetadata(
    {
      id,
      subject: input.subject,
      status: 'pending',
      activeForm: input.activeForm ?? '',
      waiting: null,
      why: null,
      blocked: null,
      blockedBy: [],
    },
    input.metadata,
  )
  const tasks = [...mirror.tasks.filter(one => one.id !== id), task]

  return { ...mirror, tasks, updated: now }
}

export const applyTaskUpdate = (mirror: ProgressMirror, input: TaskUpdateInput, now: number): ProgressMirror => {
  if (input.status === 'deleted') {
    return { ...mirror, tasks: mirror.tasks.filter(one => one.id !== input.taskId), updated: now }
  }
  const status = input.status
  const tasks = mirror.tasks.map(task => {
    if (task.id !== input.taskId) return task
    const next: ProgressMirrorTask = {
      ...task,
      subject: input.subject ?? task.subject,
      activeForm: input.activeForm ?? task.activeForm,
      status: status ?? task.status,
      blockedBy: [...new Set([...task.blockedBy, ...(input.addBlockedBy ?? [])])],
    }
    // Finishing a step clears what it was waiting on.
    const done = next.status === 'completed' ? { ...next, waiting: null, why: null, blocked: null } : next

    return withMetadata(done, next.status === 'completed' ? undefined : input.metadata)
  })

  return { ...mirror, tasks, updated: now }
}

export const applyTodoWrite = (mirror: ProgressMirror, todos: readonly TodoInput[], now: number): ProgressMirror => ({
  ...mirror,
  tasks: todos.map((todo, index) => ({
    id: String(index + 1),
    subject: todo.content,
    status: todo.status,
    activeForm: todo.activeForm,
    waiting: null,
    why: null,
    blocked: null,
    blockedBy: [],
  })),
  updated: now,
})

export type ListedTask = { id: string; subject: string; status: Status; blockedBy: readonly string[] }

// TaskList after a reload or a resume: keeps what the mirror knew of each task.
export const fromTaskList = (mirror: ProgressMirror, listed: readonly ListedTask[], now: number): ProgressMirror => ({
  ...mirror,
  tasks: listed.map(item => {
    const known = mirror.tasks.find(task => task.id === item.id)

    return {
      id: item.id,
      subject: item.subject,
      status: item.status,
      activeForm: known?.activeForm ?? '',
      waiting: item.status === 'completed' ? null : (known?.waiting ?? null),
      why: item.status === 'completed' ? null : (known?.why ?? null),
      blocked: item.status === 'completed' ? null : (known?.blocked ?? null),
      blockedBy: [...item.blockedBy],
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
    task => task.status === 'completed' && !before.tasks.some(old => old.status === 'completed' && old.subject === task.subject),
  )

// What deserves a desktop notification between two states of the mirror: a step that now
// needs the person, and the whole list finishing.
export const noticesOf = (before: ProgressMirror, after: ProgressMirror): string[] => {
  const needs = after.tasks.filter(
    task =>
      task.status !== 'completed' &&
      task.waiting === 'you' &&
      !before.tasks.some(old => old.id === task.id && old.status !== 'completed' && old.waiting === 'you'),
  )
  const title = after.title || fallbackTitle(after)

  return [
    ...needs.map(task => `需要你：${task.subject}`),
    ...(isAllDone(after) && !isAllDone(before) ? [`做完了：${title}（${after.tasks.length}/${after.tasks.length}）`] : []),
  ]
}

export const stateOf = (mirror: ProgressMirror, isTurnRunning: boolean): ProgressSessionState => {
  if (isAllDone(mirror)) return 'done'

  return isTurnRunning ? 'working' : 'waiting'
}

export const doingTask = (mirror: ProgressMirror): ProgressMirrorTask | undefined =>
  mirror.tasks.find(task => task.status === 'in_progress' && task.waiting === null && task.blocked === null) ??
  mirror.tasks.find(task => task.status === 'in_progress')

// A title until the model names the task: the first line of the request, or the first step.
export const fallbackTitle = (mirror: ProgressMirror): string => {
  const prompt = mirror.firstPrompt.split(/\r?\n/).find(line => line.trim() !== '')?.trim() ?? ''
  const source = prompt !== '' ? prompt : (mirror.tasks[0]?.subject ?? '')
  const chars = [...source]

  return chars.length > 18 ? `${chars.slice(0, 18).join('')}…` : source
}

// What the model answered, made into a title: one line, no quotes or end punctuation.
export const cleanTitle = (answer: string): string => {
  const line = answer.split(/\r?\n/).find(one => one.trim() !== '')?.trim() ?? ''
  const bare = line.replace(/^["'「『《【\s]+|["'」』》】。．.！!？?\s]+$/g, '').replace(/^(任務名稱|名稱|Title)[:：]\s*/i, '')
  const chars = [...bare]

  return chars.length > 24 ? chars.slice(0, 24).join('') : bare
}

// The model's second line, made into one line of background.
export const cleanContext = (answer: string): string => {
  const line = answer
    .replace(/^["'「『\s]+|["'」』\s]+$/g, '')
    .replace(/^(背景|Background)[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
  const chars = [...line.trim()]

  return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : chars.join('')
}

// The note the conversation gets after a compaction: where this session's task stands.
export const resumeNote = (mirror: ProgressMirror): string | null => {
  const open = mirror.tasks.filter(task => task.status !== 'completed')
  if (open.length === 0) return null
  const done = mirror.tasks.length - open.length
  const doing = doingTask(mirror)
  const next = open.filter(task => task !== doing).slice(0, 4)
  const waiting = open.filter(task => task.waiting === 'you' || task.blocked !== null)

  return [
    '[進度面板] 對話剛壓縮過。壓縮前的進度（同步自 Task 清單）：',
    `目標：${mirror.title || fallbackTitle(mirror)}（${mirror.project}）`,
    mirror.context === '' || mirror.context === undefined ? '' : `背景：${mirror.context}`,
    `完成 ${done}/${mirror.tasks.length}`,
    doing === undefined ? '' : `正在做：${doing.subject}`,
    next.length === 0 ? '' : `接下來：${next.map(task => task.subject).join('；')}`,
    waiting.length === 0
      ? ''
      : `等使用者或卡住：${waiting.map(task => (task.blocked ? `${task.subject}（${task.blocked}）` : task.subject)).join('；')}`,
    '先用 TaskList 確認最新狀態，再從「正在做」那步接著做；不要重建已經存在的任務。',
  ]
    .filter(line => line !== '')
    .join('\n')
}

// Only the mod's own per-session records age out of the store; a setting the person made
// (closing the pane by hand) stays until they change it.
export const isStaleStoreKey = (key: string, value: unknown, now: number, maxAge: number): boolean => {
  if (!key.startsWith('mirror:') && !key.startsWith('hinted:')) return false
  const stamp = typeof value === 'number' ? value : ((value as { updated?: number } | undefined)?.updated ?? 0)

  return now - stamp > maxAge
}

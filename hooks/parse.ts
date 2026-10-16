import type {
  ProgressAuto,
  ProgressCi,
  ProgressProject,
  ProgressSessionState,
  ProgressStep,
  ProgressStepStatus,
  ProgressTask,
} from '../types'

// `## project` / `### task` / `> note` / `- [x] step`, plus the auto markers a session's
// mod writes around its own block. Everything else is ignored, so free text never breaks
// the pane.
const PROJECT = /^##\s+(.+?)\s*#*\s*$/
const TASK = /^###\s+(.+?)\s*#*\s*$/
const NOTE = /^\s*>\s?(.*)$/
const STEP = /^([ \t]*)[-*+]\s+\[([ xX~?>!-])\]\s+(.*)$/
const FENCE = /^\s*(```|~~~)/
export const AUTO_START = /^<!--\s*auto\s+(.*?)\s*-->\s*$/
export const AUTO_END = /^<!--\s*\/auto\b.*?-->\s*$/
const DUE = /(?:截止|\bdue)[:：\s]*((?:\d{4}[-/])?\d{1,2}[-/]\d{1,2})/i

const STATUS: Record<string, ProgressStepStatus> = {
  ' ': 'todo',
  x: 'done',
  X: 'done',
  '~': 'doing',
  '?': 'waiting',
  '>': 'running',
  '!': 'blocked',
  '-': 'cancelled',
}

const SESSION_STATES: readonly ProgressSessionState[] = ['working', 'waiting', 'done', 'ended']
const CI_STATES: readonly ProgressCi[] = ['none', 'pending', 'pass', 'fail']

// `dir=` is written percent-encoded, so a folder with spaces stays one attribute.
const decoded = (value: string | undefined): string | null => {
  if (value === undefined || value === '') return null
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export const parseAttrs = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {}
  for (const match of raw.matchAll(/([\w-]+)=(\S+)/g)) {
    const [, key, value] = match
    if (key !== undefined && value !== undefined) attrs[key] = value
  }

  return attrs
}

export const autoOf = (raw: string): ProgressAuto | null => {
  const attrs = parseAttrs(raw)
  const session = attrs.session
  if (session === undefined) return null
  const state = SESSION_STATES.find(one => one === attrs.state) ?? 'waiting'
  const updated = Date.parse(attrs.updated ?? '')
  const pr = Number(attrs.pr)

  return {
    session,
    agent: (attrs.agent ?? 'claude').toLowerCase(),
    state,
    updated: Number.isNaN(updated) ? 0 : updated,
    resume: attrs.resume ?? null,
    dir: decoded(attrs.dir),
    pr: Number.isInteger(pr) && pr > 0 ? pr : null,
    ci: CI_STATES.find(one => one === attrs.ci) ?? null,
  }
}

const indentOf = (lead: string): number => {
  const width = [...lead].reduce((sum, ch) => sum + (ch === '\t' ? 4 : 1), 0)

  return Math.min(3, Math.floor(width / 2))
}

const dueOf = (task: ProgressTask): string | null => {
  for (const text of [task.title, ...task.notes]) {
    const match = DUE.exec(text)
    if (match?.[1] !== undefined) return match[1].replace(/\//g, '-')
  }

  return null
}

export const parseProgress = (markdown: string): ProgressProject[] => {
  const projects: ProgressProject[] = []
  let project: ProgressProject | undefined
  let task: ProgressTask | undefined
  let pendingAuto: ProgressAuto | null = null
  let openSession: string | null = null
  let isFenced = false
  let isComment = false

  const ensureProject = (): ProgressProject => {
    if (project === undefined) {
      project = { name: '', tasks: [] }
      projects.push(project)
    }

    return project
  }

  const ensureTask = (): ProgressTask => {
    if (task === undefined) {
      task = { title: '', line: -1, notes: [], steps: [], auto: pendingAuto, due: null }
      pendingAuto = null
      ensureProject().tasks.push(task)
    }

    return task
  }

  markdown.split(/\r?\n/).forEach((raw, lineIndex) => {
    if (FENCE.test(raw)) {
      isFenced = !isFenced
      return
    }
    if (isFenced) return

    const autoStart = AUTO_START.exec(raw)
    if (autoStart?.[1] !== undefined && !isComment) {
      pendingAuto = autoOf(autoStart[1])
      openSession = pendingAuto?.session ?? null
      task = undefined
      return
    }
    if (AUTO_END.test(raw) && !isComment) {
      // An end marker closes only its own block (or any, when it names none).
      const ends = parseAttrs(raw).session
      if (openSession !== null && (ends === undefined || ends === openSession)) {
        openSession = null
        pendingAuto = null
        task = undefined
      }
      return
    }

    let line = raw
    if (isComment) {
      const end = line.indexOf('-->')
      if (end < 0) return
      isComment = false
      line = line.slice(end + 3)
    }
    line = line.replace(/<!--.*?-->/g, '')
    const open = line.indexOf('<!--')
    if (open >= 0) {
      isComment = true
      line = line.slice(0, open)
    }
    if (line.trim() === '') return

    const projectMatch = PROJECT.exec(line)
    // A session's block never holds a `##`, so one always starts a project, and ends a block
    // whose end marker went missing.
    if (projectMatch?.[1] !== undefined) {
      openSession = null
      pendingAuto = null
      project = { name: projectMatch[1], tasks: [] }
      projects.push(project)
      task = undefined
      return
    }

    const taskMatch = TASK.exec(line)
    if (taskMatch?.[1] !== undefined) {
      task = { title: taskMatch[1], line: lineIndex, notes: [], steps: [], auto: pendingAuto, due: null }
      pendingAuto = null
      ensureProject().tasks.push(task)
      return
    }

    const stepMatch = STEP.exec(line)
    if (stepMatch !== null) {
      const [, lead = '', mark = ' ', text = ''] = stepMatch
      const step: ProgressStep = {
        text: text.trim(),
        status: STATUS[mark] ?? 'todo',
        depth: indentOf(lead),
        line: lineIndex,
        raw,
      }
      ensureTask().steps.push(step)
      return
    }

    const noteMatch = NOTE.exec(line)
    if (noteMatch?.[1] !== undefined && task !== undefined) {
      task.notes.push(noteMatch[1].trim())
    }
  })

  for (const one of projects) {
    for (const each of one.tasks) each.due = dueOf(each)
  }

  return projects.filter(one => one.name !== '' || one.tasks.length > 0)
}

export type TaskCount = { done: number; total: number }

// Cancelled steps count as neither done nor open.
export const countSteps = (task: ProgressTask): TaskCount => {
  const counted = task.steps.filter(step => step.status !== 'cancelled')

  return { done: counted.filter(step => step.status === 'done').length, total: counted.length }
}

export const isTaskComplete = (task: ProgressTask): boolean => {
  const { done, total } = countSteps(task)

  return total > 0 && done === total
}

// The step to highlight: the explicit `[~]`, else the first open one.
export const currentStepIndex = (task: ProgressTask): number => {
  const doing = task.steps.findIndex(step => step.status === 'doing')
  if (doing >= 0) return doing

  return task.steps.findIndex(step => step.status !== 'done' && step.status !== 'cancelled')
}

// A block whose session stopped writing to it (the terminal closed without the session
// ending, a crash) still says working or waiting; after half a day it is treated as ended.
export const STALE_MS = 12 * 60 * 60 * 1000

export const isStale = (auto: ProgressAuto | null, now: number): boolean =>
  auto !== null && (auto.state === 'working' || auto.state === 'waiting') && auto.updated > 0 && now - auto.updated > STALE_MS

// The key a finished hand-kept task is remembered by, to archive it a day later.
export const doneKey = (project: string, title: string): string => `done:${project}::${title}`

export const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

// `## persona_framework (PFC)` belongs to the session whose repo is persona_framework.
export const projectHead = (name: string): string => (name.trim().split(/[\s(（·—]/)[0] ?? '').toLowerCase()

export const isHereProject = (name: string, here: readonly string[]): boolean => {
  const head = projectHead(name)

  return head !== '' && here.some(one => one.toLowerCase() === head)
}

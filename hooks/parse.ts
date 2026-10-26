import type {
  ProgressAuto,
  ProgressCi,
  ProgressProject,
  ProgressSessionState,
  ProgressStep,
  ProgressStepStatus,
  ProgressTask,
  ProgressTail,
} from '../types'
import { sha256 } from './sha256.ts'

// `## project` / `### task` / `> note` / `- [x] step`, plus the auto markers a session's
// mod writes around its own block. Everything else is ignored, so free text never breaks
// the pane.
const PROJECT = /^##\s+(.+?)\s*#*\s*$/
const TASK = /^###\s+(.+?)\s*#*\s*$/
const NOTE = /^\s*>\s?(.*)$/
const STEP = /^([ \t]*)[-*+]\s+\[([ xX~?>!-])\]\s+(.*)$/
const FENCE = /^\s*(```|~~~)/
const MARKER_PREFIXES = ['auto session=', '/auto session=', 'question=']
export const isCutMarker = (line: string): boolean => {
  if (!line.startsWith('<!--') || line.includes('-->')) return false
  // A loop, not a trailing-whitespace regex: a long run of spaces would make the regex quadratic.
  let end = line.length
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t' || line[end - 1] === '\r')) end--
  const marker = line.slice(0, end).replace(/^<!--[ \t]*/, '')
  // A bare comment opening is still how people hide examples.
  return marker !== '' && MARKER_PREFIXES.some(prefix => prefix.startsWith(marker) || marker.startsWith(prefix))
}
export const AUTO_START = /^<!--\s*auto\s+(.*?)\s*-->\s*$/
export const AUTO_END = /^<!--\s*\/auto\b.*?-->\s*$/
export const QUESTION = /^<!--\s*question=([a-f0-9]{64}:[1-9]\d*)\s*-->\s*$/
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

// `resume=` ends up in a command the person pastes into a terminal, and anyone can write the
// file: only a plain session id is kept.
export const RESUME = /^[0-9a-zA-Z][0-9a-zA-Z_-]{5,63}$/

// A folder with a control character (a newline above all) would break the pasted command
// into two; the quote is escaped where the command is built.
const folderOf = (value: string | undefined): string | null => {
  const dir = decoded(value)

  return dir === null || /[\u0000-\u001f\u007f]/.test(dir) ? null : dir
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
    resume: attrs.resume !== undefined && RESUME.test(attrs.resume) ? attrs.resume : null,
    dir: folderOf(attrs.dir),
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

// What the format reads of each line, shared by the parser and the writer so neither sees a
// block or heading the other skips: null inside a code fence (the fence lines too) or a
// multi-line HTML comment; else the line with its comments taken out, an auto marker kept
// whole.
export const readable = (lines: readonly string[]): Array<string | null> => {
  let isFenced = false
  let isComment = false

  return lines.map((raw, index) => {
    if (FENCE.test(raw)) {
      isFenced = !isFenced
      return null
    }
    if (isFenced) return null
    let line = raw
    if (isComment) {
      const end = line.indexOf('-->')
      if (end < 0) return null
      isComment = false
      line = line.slice(end + 3)
    } else if (AUTO_START.test(raw) || AUTO_END.test(raw) || QUESTION.test(raw)) {
      return raw
    }
    if (isCutMarker(raw)) {
      // A later board boundary before the comment close belongs to the next writer.
      let hasBoundary = false
      let hasClose = false
      for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex++) {
        const next = lines[nextIndex] ?? ''
        if (AUTO_START.test(next) || AUTO_END.test(next) || PROJECT.test(next)) hasBoundary = true
        if (next.includes('-->')) {
          hasClose = true
          break
        }
      }
      if (hasBoundary || !hasClose) return raw
    }
    line = line.replace(/<!--.*?-->/g, '')
    const open = line.indexOf('<!--')
    if (open >= 0) {
      isComment = true
      line = line.slice(0, open)
    }

    return line
  })
}

// A cut marker is damage, not a comment around the next writer's complete blocks.
// Keep its boundary in the original string; writers must preserve the prefix exactly.
export const progressTail = (markdown: string): ProgressTail | null => {
  const raws = markdown.split('\n')
  const lines = readable(raws)
  let offset = 0
  let open: { session: string; tasks: number } | null = null
  let torn: ProgressTail | null = null
  lines.forEach((line, index) => {
    if (line !== null) {
      const start = AUTO_START.exec(line)
      const auto = start?.[1] === undefined ? null : autoOf(start[1])
      if (auto !== null) open = { session: auto.session, tasks: 0 }
      else if (AUTO_END.test(line)) {
        const ends = parseAttrs(line).session
        if (ends === undefined || ends === open?.session) open = null
      } else if (PROJECT.test(line)) open = null
      else if (TASK.test(line) && open !== null) open.tasks += 1
      else if (isCutMarker(line) && torn === null) {
        const close = open !== null && `<!-- /auto session=${open.session} -->`.startsWith(line.replace(/\r$/, '')) ? open.session : null
        torn = { offset, tasks: Math.max(1, open?.tasks ?? 0), close }
      }
    }
    offset += (raws[index]?.length ?? 0) + 1
  })
  return torn
}

export const parseProgress = (markdown: string): ProgressProject[] => {
  const projects: ProgressProject[] = []
  let project: ProgressProject | undefined
  let task: ProgressTask | undefined
  let pendingAuto: ProgressAuto | null = null
  let openSession: string | null = null

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

  const raws = markdown.split(/\r?\n/)
  readable(raws).forEach((line, lineIndex) => {
    if (line === null) return
    const raw = raws[lineIndex] ?? ''

    const autoStart = AUTO_START.exec(line)
    if (autoStart?.[1] !== undefined) {
      pendingAuto = autoOf(autoStart[1])
      openSession = pendingAuto?.session ?? null
      task = undefined
      return
    }
    if (AUTO_END.test(line)) {
      // An end marker closes only its own block (or any, when it names none).
      const ends = parseAttrs(line).session
      if (openSession !== null && (ends === undefined || ends === openSession)) {
        openSession = null
        pendingAuto = null
        task = undefined
      }
      return
    }
    if (line.trim() === '') return
    const question = QUESTION.exec(line)?.[1]
    if (question !== undefined) {
      const previous = task?.steps.at(-1)
      if (openSession !== null && task?.auto?.session === openSession && previous !== undefined) previous.questionToken = question
      return
    }

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

export const isMarksComplete = (statuses: readonly ProgressStepStatus[]): boolean => {
  const counted = statuses.filter(status => status !== 'cancelled')

  return counted.length > 0 ? counted.every(status => status === 'done') : statuses.length > 0 && statuses.every(status => status === 'cancelled')
}

export const isTaskComplete = (task: ProgressTask): boolean => isMarksComplete(task.steps.map(step => step.status))

// The step to highlight: the explicit `[~]`, else the first open one.
export const currentStepIndex = (task: ProgressTask): number => {
  const doing = task.steps.findIndex(step => step.status === 'doing')
  if (doing >= 0) return doing

  return task.steps.findIndex(step => step.status !== 'done' && step.status !== 'cancelled')
}

// A block whose session stopped writing to it (the terminal closed without the session
// ending, a crash) still says working or waiting; after half a day it is treated as ended.
export const STALE_MS = 12 * 60 * 60 * 1000
export const FUTURE_SKEW_MS = 5 * 60 * 1000

export const futureTimeKey = (auto: ProgressAuto): string =>
  `future:${sha256(JSON.stringify(['future-time', auto.agent, auto.session, auto.updated]))}`

// Keep the writer's stamp intact. The local observation belongs to that exact update,
// and remains authoritative when the local clock eventually catches up with it.
export const observedTime = (auto: ProgressAuto | null, now: number, seen: Readonly<Record<string, number>>): { updated: number; isFuture: boolean } => {
  const updated = auto?.updated ?? 0
  if (auto === null || !Number.isFinite(updated) || updated <= 0) return { updated, isFuture: false }
  const first = seen[futureTimeKey(auto)]
  const isObserved = typeof first === 'number' && Number.isFinite(first) && first > 0
  const isFuture = isObserved || updated - now > FUTURE_SKEW_MS
  return { updated: isObserved ? first : updated, isFuture }
}

export const isStale = (auto: ProgressAuto | null, now: number, updated = auto?.updated ?? 0): boolean =>
  auto !== null && (auto.state === 'working' || auto.state === 'waiting') && updated > 0 && now - updated > STALE_MS

// The key a finished hand-kept task is remembered by, to archive it a day later.
export const doneKey = (project: string, title: string): string => `done:${project}::${title}`

export const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

// `## persona_framework (PFC)` belongs to the session whose repo is persona_framework.
export const projectHead = (name: string): string => (name.trim().split(/[\s(（·—]/)[0] ?? '').toLowerCase()

export const isHereProject = (name: string, here: readonly string[]): boolean => {
  const head = projectHead(name)

  return head !== '' && here.some(one => one.toLowerCase() === head)
}

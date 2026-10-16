import type { ProgressMirror, ProgressMirrorTask, ProgressSessionState } from '../types'
import { prWords } from './github'
import { AUTO_END, AUTO_START, autoOf, parseAttrs, projectHead } from './parse'
import type { QuickEntry } from './quick'
import type { StepRef } from './view'

// Each session's mod owns one block of the file, between its own markers, and rewrites
// only that block: whatever people or other sessions wrote elsewhere stays byte for byte.

const PROJECT = /^##\s+(.+?)\s*#*\s*$/
const TASK = /^###\s+(.+?)\s*#*\s*$/
const STEP = /^([ \t]*[-*+]\s+\[)([ xX~?>!-])(\]\s+)(.*)$/
const DAY = 24 * 60 * 60 * 1000

export const shortId = (sessionId: string): string => sessionId.slice(0, 8)

export const STATE_WORDS: Record<ProgressSessionState, string> = {
  working: 'Claude 正在做',
  waiting: '等你回覆',
  done: '完成',
  ended: '對話已結束，可接手',
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim()

const markOf = (task: ProgressMirrorTask): string => {
  if (task.status === 'completed') return 'x'
  if (task.blocked !== null) return '!'
  if (task.waiting === 'you') return '?'
  if (task.waiting === 'run') return '>'

  return task.status === 'in_progress' ? '~' : ' '
}

// The marker carries what another session's pane needs: the full id and folder for a
// resume command, and how the pull request stands.
const markerOf = (mirror: ProgressMirror): string => {
  const pr = mirror.pr ?? null
  const attrs = [
    `session=${shortId(mirror.sessionId)}`,
    `state=${mirror.state}`,
    `updated=${new Date(mirror.updated).toISOString()}`,
    mirror.sessionId.length > 8 ? `resume=${mirror.sessionId}` : '',
    mirror.cwd ? `dir=${encodeURIComponent(mirror.cwd)}` : '',
    pr === null ? '' : `pr=${pr.number} ci=${pr.ci}`,
  ]

  return `<!-- auto ${attrs.filter(attr => attr !== '').join(' ')} -->`
}

export const renderAutoBlock = (mirror: ProgressMirror): string[] => {
  const id = shortId(mirror.sessionId)
  const pr = mirror.pr ?? null
  const meta = [STATE_WORDS[mirror.state], mirror.branch, pr === null ? '' : prWords(pr)].filter(part => part !== '').join(' · ')

  return [
    markerOf(mirror),
    `### ${oneLine(mirror.title) || '（未命名）'}`,
    `> ${meta}`,
    ...(mirror.context ? [`> 背景：${oneLine(mirror.context)}`] : []),
    ...mirror.tasks.map(task => {
      const note = task.blocked !== null && task.blocked !== '' ? task.blocked : task.status === 'completed' ? '' : (task.why ?? '')
      const reason = note === '' ? '' : ` — ${oneLine(note)}`

      return `- [${markOf(task)}] ${oneLine(task.subject)}${reason}`
    }),
    `<!-- /auto session=${id} -->`,
  ]
}

export type BlockSpan = {
  session: string
  state: ProgressSessionState
  updated: number
  project: string
  start: number
  end: number
  // Ended by its own end marker. A block whose marker went missing (a hand edit) ends at
  // its first blank line, a second `###`, the next block or the next `##`, and is never
  // archived: what follows it may be someone's hand-kept text.
  isClosed: boolean
}

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n')

const linesOf = (text: string): string[] => (text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/))

const endsBlock = (line: string, session: string): boolean => {
  if (!AUTO_END.test(line)) return false
  const named = parseAttrs(line).session

  return named === undefined || named === session
}

export const scanBlocks = (lines: readonly string[]): BlockSpan[] => {
  const spans: BlockSpan[] = []
  let project = ''

  lines.forEach((line, index) => {
    const heading = PROJECT.exec(line)
    if (heading?.[1] !== undefined) {
      project = heading[1]
      return
    }
    const start = AUTO_START.exec(line)
    const auto = start?.[1] === undefined ? null : autoOf(start[1])
    if (auto === null) return

    let end = -1
    for (let at = index + 1; at < lines.length; at += 1) {
      const next = lines[at] ?? ''
      if (AUTO_START.test(next) || PROJECT.test(next)) break
      if (endsBlock(next, auto.session)) {
        end = at
        break
      }
    }
    if (end >= 0) {
      spans.push({ ...auto, project, start: index, end, isClosed: true })
      return
    }

    let last = index
    let headings = 0
    for (let at = index + 1; at < lines.length; at += 1) {
      const next = lines[at] ?? ''
      if (next.trim() === '' || AUTO_START.test(next) || PROJECT.test(next) || AUTO_END.test(next)) break
      if (TASK.test(next)) {
        headings += 1
        if (headings > 1) break
      }
      last = at
    }
    spans.push({ ...auto, project, start: index, end: last, isClosed: false })
  })

  return spans
}

const trimBlankEdges = (lines: string[], at: number): void => {
  // Collapse the blank lines around `at` to one.
  let from = at
  while (from > 0 && lines[from - 1]?.trim() === '') from -= 1
  let to = at
  while (to < lines.length && lines[to]?.trim() === '') to += 1
  if (to - from > 1) lines.splice(from, to - from, '')
}

const sectionRange = (lines: readonly string[], project: string): { heading: number; end: number } | null => {
  const head = projectHead(project)
  const heading = lines.findIndex(line => {
    const match = PROJECT.exec(line)
    return match?.[1] !== undefined && projectHead(match[1]) === head
  })
  if (heading < 0) return null
  const next = lines.findIndex((line, index) => index > heading && PROJECT.test(line))

  return { heading, end: next < 0 ? lines.length : next }
}

export const upsertAutoBlock = (text: string, mirror: ProgressMirror): string => {
  const eol = eolOf(text)
  const lines = linesOf(text)
  const block = renderAutoBlock(mirror)
  const id = shortId(mirror.sessionId)
  const existing = scanBlocks(lines).find(span => span.session === id)

  if (existing !== undefined) {
    lines.splice(existing.start, existing.end - existing.start + 1, ...block)

    return lines.join(eol) + eol
  }

  if (lines.every(line => line.trim() === '')) {
    return ['# 專案進度', '', `## ${mirror.project}`, '', ...block].join(eol) + eol
  }

  const section = sectionRange(lines, mirror.project)
  if (section === null) {
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()

    return [...lines, '', `## ${mirror.project}`, '', ...block].join(eol) + eol
  }

  let at = section.end
  while (at > section.heading + 1 && lines[at - 1]?.trim() === '') at -= 1
  const isLast = section.end >= lines.length
  lines.splice(at, section.end - at, '', ...block, ...(isLast ? [] : ['']))

  return lines.join(eol) + eol
}

const dropEmptySections = (lines: string[]): void => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!PROJECT.test(lines[index] ?? '')) continue
    const next = lines.findIndex((line, at) => at > index && PROJECT.test(line))
    const end = next < 0 ? lines.length : next
    const body = lines.slice(index + 1, end)
    if (body.every(line => line.trim() === '')) lines.splice(index, end - index)
  }
}

const removeSpans = (text: string, spans: readonly BlockSpan[]): string => {
  const eol = eolOf(text)
  const lines = linesOf(text)
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    lines.splice(span.start, span.end - span.start + 1)
    trimBlankEdges(lines, Math.min(span.start, lines.length))
  }
  dropEmptySections(lines)
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()

  return lines.length === 0 ? '' : lines.join(eol) + eol
}

export const removeAutoBlock = (text: string, sessionId: string): string => {
  const id = shortId(sessionId)
  const spans = scanBlocks(linesOf(text)).filter(span => span.session === id)

  return spans.length === 0 ? text : removeSpans(text, spans)
}

export const extractAutoBlock = (text: string, sessionId: string): string | null => {
  const lines = linesOf(text)
  const span = scanBlocks(lines).find(one => one.session === shortId(sessionId))

  return span === undefined ? null : lines.slice(span.start, span.end + 1).join('\n')
}

// Done blocks leave after half a day, interrupted ones after a week, anything after two.
export const isArchivable = (span: BlockSpan, now: number): boolean => {
  const age = now - span.updated
  if (span.state === 'done') return age > DAY / 2
  if (span.state === 'ended') return age > 7 * DAY

  return age > 14 * DAY
}

export type Archived = { text: string; entries: string[] }

// Moves old blocks out; each entry is the block without its markers, under a dated heading,
// ready to append to progress-archive.md.
export const takeArchivable = (text: string, now: number, keep?: string): Archived => {
  const lines = linesOf(text)
  const spans = scanBlocks(lines).filter(span => span.isClosed && span.session !== keep && isArchivable(span, now))
  if (spans.length === 0) return { text, entries: [] }
  const entries = spans.map(span => {
    const body = lines.slice(span.start + 1, span.end)
    const day = new Date(span.updated || now).toISOString().slice(0, 10)

    return [`## ${span.project || '（未分類）'} · ${day}`, ...body].join('\n')
  })

  return { text: removeSpans(text, spans), entries }
}

// A quick add from the pane: a hand-kept task at the end of its project's section (made
// if missing), below whatever is there.
export const addManualTask = (text: string, entry: QuickEntry): string => {
  const eol = eolOf(text)
  const lines = linesOf(text)
  const task = [
    `### ${oneLine(entry.title)}`,
    ...(entry.due === null ? [] : [`> 截止 ${entry.due}`]),
    ...entry.steps.map(step => `- [ ] ${oneLine(step)}`),
  ]
  if (lines.every(line => line.trim() === '')) {
    return ['# 專案進度', '', `## ${entry.project}`, '', ...task].join(eol) + eol
  }
  const section = sectionRange(lines, entry.project)
  if (section === null) {
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()

    return [...lines, '', `## ${entry.project}`, '', ...task].join(eol) + eol
  }
  let at = section.end
  while (at > section.heading + 1 && lines[at - 1]?.trim() === '') at -= 1
  const isLast = section.end >= lines.length
  lines.splice(at, section.end - at, '', ...task, ...(isLast ? [] : ['']))

  return lines.join(eol) + eol
}

// Ticks one step of a hand-kept task (a press in the pane): the line the pane showed, if it
// still reads as it did; else the one line in the file that does, if there is exactly one.
// Anything else (the step changed, or has a twin) leaves the file alone.
export const setManualStep = (text: string, ref: StepRef, mark: string): string => {
  const eol = eolOf(text)
  const lines = linesOf(text)
  let at = lines[ref.line] === ref.raw ? ref.line : -1
  if (at < 0) {
    const same = lines.flatMap((line, index) => (line === ref.raw ? [index] : []))
    if (same.length === 1) at = same[0] ?? -1
  }
  const line = lines[at]
  if (at < 0 || line === undefined || !STEP.test(line)) return text
  lines[at] = line.replace(STEP, (_all, lead: string, _mark: string, close: string, rest: string) => `${lead}${mark}${close}${rest}`)

  return lines.join(eol) + eol
}

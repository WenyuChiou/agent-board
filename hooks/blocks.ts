import type { ProgressMirror, ProgressMirrorTask, ProgressSessionState } from '../types'
import { prWords } from './github'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { localDay } from './journal'
import { fallbackTitle } from './mirror'
import { AUTO_END, AUTO_START, autoOf, doneKey, isTaskComplete, parseAttrs, parseProgress, projectHead, readable } from './parse'
import type { QuickEntry } from './quick'
import type { StepRef, TaskRef } from './view'

// Each session's mod owns one block of the file, between its own markers, and rewrites
// only that block: whatever people or other sessions wrote elsewhere stays byte for byte.

const PROJECT = /^##\s+(.+?)\s*#*\s*$/
const TASK = /^###\s+(.+?)\s*#*\s*$/
const STEP = /^([ \t]*[-*+]\s+\[)([ xX~?>!-])(\]\s+)(.*)$/
const DAY = 24 * 60 * 60 * 1000

export const shortId = (sessionId: string): string => sessionId.slice(0, 8)

export const stateWords = (state: ProgressSessionState, s: Strings = ZH_TW): string => {
  if (state === 'working') return s.stateWorking
  if (state === 'waiting') return s.stateWaiting
  if (state === 'done') return s.stateDone

  return s.stateEnded
}

// Every line the mod writes into a block. A comment opening in a title or step (the model's
// summing up, a first request) would hide every line up to the next `-->`, the next block's
// markers with them, so it is left out; an arrow that would close one is written `->`.
const oneLine = (text: string): string =>
  text.replace(/<!--/g, ' ').replace(/--+>/g, '->').replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').trim()

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
    `agent=${mirror.agent || 'claude'}`,
    `state=${mirror.state}`,
    `updated=${new Date(mirror.updated).toISOString()}`,
    mirror.sessionId.length > 8 ? `resume=${mirror.sessionId}` : '',
    mirror.cwd ? `dir=${encodeURIComponent(mirror.cwd)}` : '',
    pr === null ? '' : `pr=${pr.number} ci=${pr.ci}`,
    mirror.source === 'turns' ? 'source=turns' : '',
  ]

  return `<!-- auto ${attrs.filter(attr => attr !== '').join(' ')} -->`
}

export const renderAutoBlock = (mirror: ProgressMirror, s: Strings = ZH_TW): string[] => {
  const id = shortId(mirror.sessionId)
  const pr = mirror.pr ?? null
  const meta = [stateWords(mirror.state, s), mirror.branch, pr === null ? '' : prWords(pr, s)].filter(part => part !== '').join(' · ')

  return [
    markerOf(mirror),
    `### ${oneLine(mirror.title) || oneLine(fallbackTitle(mirror)) || s.unnamed}`,
    `> ${oneLine(meta)}`,
    ...(mirror.context ? [s.contextNote(oneLine(mirror.context))] : []),
    ...(mirror.handoff ? [s.handoffNote(oneLine(mirror.handoff))] : []),
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

// The lines as the parser reads them: what sits in a code fence or a comment is never taken
// for a marker or a heading, so a block pasted there as an example is left alone.
const HIDDEN = '\u0000'

const seenOf = (lines: readonly string[]): string[] => readable(lines).map(line => line ?? HIDDEN)

const endsBlock = (line: string, session: string): boolean => {
  if (!AUTO_END.test(line)) return false
  const named = parseAttrs(line).session

  return named === undefined || named === session
}

export const scanBlocks = (raws: readonly string[]): BlockSpan[] => {
  const spans: BlockSpan[] = []
  const lines = seenOf(raws)
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
      if ((raws[at] ?? '').trim() === '' || next === HIDDEN || AUTO_START.test(next) || PROJECT.test(next) || AUTO_END.test(next)) break
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

const sectionRange = (raws: readonly string[], project: string): { heading: number; end: number } | null => {
  const lines = seenOf(raws)
  const head = projectHead(project)
  const heading = lines.findIndex(line => {
    const match = PROJECT.exec(line)
    return match?.[1] !== undefined && projectHead(match[1]) === head
  })
  if (heading < 0) return null
  const next = lines.findIndex((line, index) => index > heading && PROJECT.test(line))

  return { heading, end: next < 0 ? lines.length : next }
}

export const upsertAutoBlock = (text: string, mirror: ProgressMirror, s: Strings = ZH_TW): string => {
  const eol = eolOf(text)
  const lines = linesOf(text)
  const block = renderAutoBlock(mirror, s)
  const id = shortId(mirror.sessionId)
  const existing = scanBlocks(lines).find(span => span.session === id)

  if (existing !== undefined) {
    lines.splice(existing.start, existing.end - existing.start + 1, ...block)

    return lines.join(eol) + eol
  }

  if (lines.every(line => line.trim() === '')) {
    return [s.fileTitle, '', `## ${mirror.project}`, '', ...block].join(eol) + eol
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

// Drops `##` sections left with nothing in them, only among `touched` (the projects whose
// blocks or tasks were just removed): an empty section someone keeps on purpose stays.
const dropEmptySections = (lines: string[], touched: ReadonlySet<string>): void => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const seen = seenOf(lines)
    const heading = PROJECT.exec(seen[index] ?? '')
    if (heading?.[1] === undefined || !touched.has(heading[1])) continue
    const next = seen.findIndex((line, at) => at > index && PROJECT.test(line))
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
  dropEmptySections(lines, new Set(spans.map(span => span.project)))
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

// Done blocks leave after half a day; anything else (ended, or a session that stopped
// writing) after three days without a word, so the file never fills up with old work. A
// block that gives no time (another tool's, written by hand) is never aged out.
// `isNow` is the person asking (`/progress tidy`, the pane's archive button): finished work
// goes at once instead of after half a day; a stopped session still gets its three days.
export const isArchivable = (span: BlockSpan, now: number, isNow = false): boolean => {
  if (span.updated <= 0) return false
  const age = now - span.updated
  if (span.state === 'done') return isNow || age > DAY / 2

  return age > 3 * DAY
}

export type Archived = { text: string; entries: string[] }

// Moves old blocks out; each entry is the block without its markers, under a dated heading,
// ready to append to progress-archive.md.
export const takeArchivable = (text: string, now: number, keep?: string, s: Strings = ZH_TW, isNow = false): Archived => {
  const lines = linesOf(text)
  const spans = scanBlocks(lines).filter(span => span.isClosed && span.session !== keep && isArchivable(span, now, isNow))
  if (spans.length === 0) return { text, entries: [] }
  const entries = spans.map(span => {
    const body = lines.slice(span.start + 1, span.end)
    const day = localDay(span.updated || now)

    return [`## ${span.project || s.uncategorized} · ${day}`, ...body].join('\n')
  })

  return { text: removeSpans(text, spans), entries }
}

// Hand-kept tasks whose every step is done, a day after the pane first saw them done
// (`seen`, by doneKey): moved out whole, heading to last step, like a session's block.
export const takeManualDone = (
  text: string,
  now: number,
  seenAt: (key: string) => number | undefined,
  s: Strings = ZH_TW,
): Archived & { keys: string[] } => {
  const lines = linesOf(text)
  const seen = seenOf(lines)
  const spans: BlockSpan[] = []
  const entries: string[] = []
  const keys: string[] = []
  for (const project of parseProgress(text)) {
    for (const task of project.tasks) {
      if (task.auto !== null || task.line < 0 || !isTaskComplete(task)) continue
      const key = doneKey(project.name, task.title)
      const at = seenAt(key)
      if (at === undefined || now - at < DAY) continue
      let end = task.line
      for (let index = task.line + 1; index < lines.length; index += 1) {
        const line = seen[index] ?? ''
        if (PROJECT.test(line) || TASK.test(line) || AUTO_START.test(line)) break
        if ((lines[index] ?? '').trim() !== '') end = index
      }
      const last = end
      // The blank lines after it go too, so the next task moves up into its place.
      while (end + 1 < lines.length && lines[end + 1]?.trim() === '') end += 1
      spans.push({ session: '', state: 'done', updated: at, project: project.name, start: task.line, end, isClosed: true })
      const day = localDay(at)
      entries.push([`## ${project.name || s.uncategorized} · ${day}`, ...lines.slice(task.line, last + 1)].join('\n'))
      keys.push(key)
    }
  }
  if (spans.length === 0) return { text, entries: [], keys: [] }

  return { text: removeSpans(text, spans), entries, keys }
}

// One task out now, at the person's word (a row's 封存): an ended session's block, or a
// hand-kept task from its heading to its last line, in the entry form takeArchivable uses.
// null when it cannot be found for sure: a block without its end marker, a heading that is
// gone or has a twin, or a heading inside some session's block.
export const takeTask = (text: string, ref: TaskRef, now: number, s: Strings = ZH_TW): Archived | null => {
  const lines = linesOf(text)
  const seen = seenOf(lines)
  const spans = scanBlocks(lines)
  const heading = `## ${ref.project || s.uncategorized} · ${localDay(now)}`
  if (ref.session !== null) {
    const span = spans.find(one => one.session === ref.session)
    if (span === undefined || !span.isClosed) return null

    return { text: removeSpans(text, [span]), entries: [[heading, ...lines.slice(span.start + 1, span.end)].join('\n')] }
  }
  const isHeading = (line: string | undefined): boolean => TASK.exec(line ?? '')?.[1] === ref.title
  let at = isHeading(seen[ref.line]) ? ref.line : -1
  if (at < 0) {
    const same = seen.flatMap((line, index) => (isHeading(line) ? [index] : []))
    if (same.length === 1) at = same[0] ?? -1
  }
  if (at < 0 || spans.some(span => at >= span.start && at <= span.end)) return null
  let end = at
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = seen[index] ?? ''
    if (PROJECT.test(line) || TASK.test(line) || AUTO_START.test(line)) break
    if ((lines[index] ?? '').trim() !== '') end = index
  }
  const last = end
  while (end + 1 < lines.length && lines[end + 1]?.trim() === '') end += 1
  const span: BlockSpan = { session: '', state: 'done', updated: now, project: ref.project, start: at, end, isClosed: true }

  return { text: removeSpans(text, [span]), entries: [[heading, ...lines.slice(at, last + 1)].join('\n')] }
}

// A quick add from the pane: a hand-kept task at the end of its project's section (made
// if missing), below whatever is there.
export const addManualTask = (text: string, entry: QuickEntry, s: Strings = ZH_TW): string => {
  const eol = eolOf(text)
  const lines = linesOf(text)
  const task = [
    `### ${oneLine(entry.title)}`,
    ...(entry.due === null ? [] : [s.dueNote(entry.due)]),
    ...entry.steps.map(step => `- [ ] ${oneLine(step)}`),
  ]
  if (lines.every(line => line.trim() === '')) {
    return [s.fileTitle, '', `## ${entry.project}`, '', ...task].join(eol) + eol
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

// How many tasks in the file carry the heading a quick add of `entry` writes: one more than
// before means the add is already in.
export const manualTaskCount = (text: string, entry: QuickEntry): number => {
  const heading = `### ${oneLine(entry.title)}`

  return seenOf(linesOf(text)).filter(line => line.trimEnd() === heading).length
}

// Ticks one step of a hand-kept task (a press in the pane): the line the pane showed, if it
// still reads as it did; else the one line in the file that does, if there is exactly one.
// Anything else (the step changed, or has a twin) leaves the file alone.
export const setManualStep = (text: string, ref: StepRef, mark: string): string => {
  const eol = eolOf(text)
  const lines = linesOf(text)
  const seen = seenOf(lines)
  const isStep = (index: number): boolean => lines[index] === ref.raw && seen[index] !== HIDDEN
  let at = isStep(ref.line) ? ref.line : -1
  if (at < 0) {
    const same = lines.flatMap((_line, index) => (isStep(index) ? [index] : []))
    if (same.length === 1) at = same[0] ?? -1
  }
  const line = lines[at]
  if (at < 0 || line === undefined || !STEP.test(line)) return text
  lines[at] = line.replace(STEP, (_all, lead: string, _mark: string, close: string, rest: string) => `${lead}${mark}${close}${rest}`)

  return lines.join(eol) + eol
}

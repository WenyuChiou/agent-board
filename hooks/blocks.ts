import type { CutBlock, ProgressMirror, ProgressMirrorTask, ProgressSessionState, ProgressProject, ProgressTask } from '../types'
import { prWords } from './github'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { localDay } from './journal'
import { splitLines } from './lines'
import { fallbackTitle, isAnswered, questionToken, retainedCancelledOf } from './mirror'
import { AUTO_END, AUTO_START, autoOf, doneKey, isCutMarker, isTaskComplete, parseAttrs, parseProgress, projectHead, readable, RESUME, STALE_MS } from './parse'
import type { QuickEntry } from './quick'
import type { StepRef, TaskRef } from './view'
import { sha256 } from './sha256'
import { isOutranked, pickParent } from './runs'
import { oneLine, plain } from './step-words'
import { isStale, observedTime } from './parse'
import type { JournalEntry } from './journal'

// Each session's mod owns one block of the file, between its own markers, and rewrites
// only that block: whatever people or other sessions wrote elsewhere stays byte for byte.

const PROJECT = /^##\s+(.+?)\s*#*\s*$/
const TASK = /^###\s+(.+?)\s*#*\s*$/
const STEP = /^([ \t]*[-*+]\s+\[)([ xX~?>!-])(\]\s+)(.*)$/
const DAY = 24 * 60 * 60 * 1000
export const HAND_KEPT_DONE_MS = 3 * DAY
// In the first release (#464), pane start/hourly, --tidy and page hourly sweeps
// only count finished hand-kept tasks and move none.
// A person's Clean up moves the due tasks regardless; explicit tidies and row archives
// keep moving finished work at once. The next release enables unattended moves.
export const isHandKeptMoveOn: boolean = false
const STOPPED_ARCHIVE_MS = 3 * DAY
const SILENT_ASKING_ARCHIVE_MS = 7 * DAY

export const shortId = (sessionId: string): string => sessionId.slice(0, 8)

export const stateWords = (state: ProgressSessionState, agent: string, s: Strings = ZH_TW): string => {
  if (state === 'working') {
    if (agent === '' || agent === 'claude') return s.stateWorking
    const name = Object.hasOwn(s.agentNames, agent) ? s.agentNames[agent] ?? agent : agent
    return s.agentWorking(name)
  }
  if (state === 'waiting') return s.stateWaiting
  if (state === 'done') return s.stateDone

  return s.stateEnded
}

// A project name as a `##` heading: a comment opening or close in it would hide the lines
// after it, so each becomes a space. Another agent's turn (`readTurn` in inbox.ts) and a pasted
// block clean their project the same way, so a folder gets one heading whoever writes first.
const cleanProject = (project: string): string => project.replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim()

// A `##` heading the mod writes, for a folder name (Linux allows `<!--` in one) or a project
// typed into a quick add. A leading `#` stays (`## #work` reads back as `#work`), and a name
// left with nothing goes under the uncategorized heading rather than a `## ` the reader skips.
const headingOf = (project: string, s: Strings): string => cleanProject(project) || s.uncategorized

// The section a project's heading starts, by the cleaned name, else by the name as an earlier
// version wrote it (`## a-->b`), so a second heading is not added beside it.
const projectSection = (lines: readonly string[], project: string, heading: string): { heading: number; end: number } | null =>
  sectionRange(lines, heading) ?? (heading !== project.trim() ? sectionRange(lines, project) : null)

const markOf = (task: ProgressMirrorTask): string => {
  if (task.handoffTo) return '-'
  if (task.status === 'completed') return 'x'
  if (task.blocked !== null) return '!'
  if (task.waiting === 'you') return '?'
  if (task.waiting === 'run') return '>'

  return task.status === 'in_progress' ? '~' : ' '
}

// The marker carries what another session's pane needs: the full id and folder for a
// resume command, and how the pull request stands.
const markerOf = (mirror: ProgressMirror, parent?: string): string => {
  const pr = mirror.pr ?? null
  const attrs = [
    `session=${shortId(mirror.sessionId)}`,
    `agent=${mirror.agent || 'claude'}`,
    `state=${mirror.state}`,
    `updated=${new Date(mirror.updated).toISOString()}`,
    // Another agent's block carries that agent's own session id, for a reply from the board's page.
    mirror.resume !== undefined && RESUME.test(mirror.resume) ? `resume=${mirror.resume}` : mirror.sessionId.length > 8 ? `resume=${mirror.sessionId}` : '',
    mirror.cwd ? `dir=${encodeURIComponent(mirror.cwd)}` : '',
    pr === null ? '' : `pr=${pr.number} ci=${pr.ci}`,
    mirror.source === 'turns' ? 'source=turns' : '',
    // A session an agent started for itself (#399); a person's has no such mark.
    mirror.isRun === true ? 'origin=run' : '',
    mirror.isRun === true && parent !== undefined && RESUME.test(parent) ? `parent=${parent}` : '',
  ]

  return `<!-- auto ${attrs.filter(attr => attr !== '').join(' ')} -->`
}

// A task's step line after its mark: what the block holds, and what a reader of the file gets
// back (trimmed). The pane keys a question on it too, so its key is the one every other reader
// of the block works out.
export const stepWords = (task: ProgressMirrorTask, s: Strings = ZH_TW): string => {
  if (task.handoffTo) return `${oneLine(task.subject)} — ${s.transferredTo(oneLine(task.handoffTo))}`
  const note = task.blocked !== null && task.blocked !== '' ? task.blocked : task.status === 'completed' ? '' : (task.why ?? '')
  const reason = note === '' ? '' : ` — ${oneLine(note)}`

  return `${oneLine(task.subject)}${reason}`
}

export const renderAutoBlock = (mirror: ProgressMirror, s: Strings = ZH_TW, parent?: string): string[] => {
  const id = shortId(mirror.sessionId)
  const pr = mirror.pr ?? null
  const meta = [stateWords(mirror.state, mirror.agent, s), mirror.branch, pr === null ? '' : prWords(pr, s)].filter(part => part !== '').join(' · ')

  return [
    markerOf(mirror, parent),
    `### ${oneLine(mirror.title) || oneLine(fallbackTitle(mirror)) || s.unnamed}`,
    `> ${oneLine(meta)}`,
    ...(mirror.context ? [s.contextNote(oneLine(mirror.context))] : []),
    ...(mirror.handoff ? [s.handoffNote(oneLine(mirror.handoff))] : []),
    ...mirror.tasks.flatMap(asked => {
      // A step the person answered is written as Claude's to do again, not as waiting on them.
      const task = isAnswered(mirror, asked) ? { ...asked, waiting: null, why: s.answeredNote } : asked

      const token = questionToken(task)
      return [`- [${markOf(task)}] ${stepWords(task, s)}`, ...(token === '' ? [] : [`<!-- question=${token} -->`])]
    }),
    ...retainedCancelledOf(mirror).map(text => `- [-] ${text}`),
    `<!-- /auto session=${id} -->`,
  ]
}

export type BlockSpan = {
  session: string
  agent?: string
  resume?: string | null
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

const linesOf = (text: string): string[] => (text === '' ? [] : splitLines(text.replace(/\r?\n$/, '')))

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

export const CUT_SETTLE_MS = 10 * 1000

// A block with no end marker that a `##` heading, a block start or a block end follows was cut off
// by a write that never finished, not one still being written: a writer adds to the end of the file
// or rewrites it whole, never into the middle, and those lines come only after it is done with the
// block. Other text after it (a step after a blank line, a fence, a comment) may be the rest of a
// block a reader caught halfway. Once the file has stayed still for CUT_SETTLE_MS, a block with no
// end marker at the end of the file is cut off too. A cut-off block ends where scanBlocks ends it,
// so the question pass need not wait for it, and the board notes it in its health section.
export const cutOffTest = (lines: readonly string[], isSettled = false): ((span: BlockSpan) => boolean) => {
  if (isSettled) return span => !span.isClosed
  let last = -1
  seenOf(lines).forEach((line, index) => {
    if (PROJECT.test(line) || AUTO_START.test(line) || AUTO_END.test(line)) last = index
  })

  return span => !span.isClosed && span.end < last
}

const cutBlockOf = (span: BlockSpan, raw: string): CutBlock => {
  const attrs = parseAttrs(AUTO_START.exec(raw)?.[1] ?? '')
  const parsed = attrs.updated === undefined ? Number.NaN : Date.parse(attrs.updated)
  return {
    line: span.start + 1,
    project: span.project,
    session: span.session,
    agent: attrs.agent ?? '',
    updated: Number.isNaN(parsed) ? null : parsed,
  }
}

// Every block that ended without its marker, including one whose marker line was itself cut off,
// so the question ledger keeps the questions of both.
export const cutOffSpans = (text: string, isSettled = false): CutBlock[] => {
  const lines = linesOf(text)
  const isCutOff = cutOffTest(lines, isSettled)

  return scanBlocks(lines).filter(isCutOff).map(span => cutBlockOf(span, lines[span.start] ?? ''))
}

// A block whose end marker was itself cut has the cut-off line already (`progressTail`), so it is
// not named a second time.
export const cutOffBlocks = (text: string, isSettled = false): CutBlock[] => {
  const lines = linesOf(text)
  const isCutOff = cutOffTest(lines, isSettled)

  return scanBlocks(lines).filter(span => isCutOff(span) && !lines.slice(span.start + 1, span.end + 2).some(isCutMarker)).map(span => cutBlockOf(span, lines[span.start] ?? ''))
}

// The board names the first few; more than that is a file to look over as a whole anyway. The
// agent name comes from the file, so control characters are taken out before any surface shows it.
export const cutBlockLines = (cut: readonly CutBlock[], s: Strings = ZH_TW): string[] =>
  cut.slice(0, 3).map(one => {
    const name = one.agent.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    const key = name.toLowerCase()
    const agent = name === '' ? '' : Object.hasOwn(s.agentNames, key) ? (s.agentNames[key] ?? name) : name
    return s.blockCutOff(agent, one.updated === null ? null : localDay(one.updated).slice(5))
  })

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
  // A name that starts with a bracket (`（未分類）`, `(PFC) notes`) has no first word to match
  // by, so it is matched whole, or every such heading would be taken for one project.
  const heading = lines.findIndex(line => {
    const match = PROJECT.exec(line)
    if (match?.[1] === undefined) return false
    return head === '' ? match[1].trim() === project.trim() : projectHead(match[1]) === head
  })
  if (heading < 0) return null
  const next = lines.findIndex((line, index) => index > heading && PROJECT.test(line))

  return { heading, end: next < 0 ? lines.length : next }
}

// New lines (a block, a hand-kept task) at the end of their project's section, below whatever
// is there; the section is made at the end of the file when missing.
const placeUnder = (lines: string[], project: string, added: readonly string[], eol: string, s: Strings): string => {
  const heading = headingOf(project, s)
  if (lines.every(line => line.trim() === '')) {
    return [s.fileTitle, '', `## ${heading}`, '', ...added].join(eol) + eol
  }

  const section = projectSection(lines, project, heading)
  if (section === null) {
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()

    return [...lines, '', `## ${heading}`, '', ...added].join(eol) + eol
  }

  let at = section.end
  while (at > section.heading + 1 && lines[at - 1]?.trim() === '') at -= 1
  const isLast = section.end >= lines.length
  lines.splice(at, section.end - at, '', ...added, ...(isLast ? [] : ['']))

  return lines.join(eol) + eol
}

export const upsertAutoBlock = (text: string, mirror: ProgressMirror, s: Strings = ZH_TW): string => {
  const eol = eolOf(text)
  const lines = linesOf(text)
  const id = shortId(mirror.sessionId)
  const fullId = mirror.resume ?? (mirror.sessionId.length > 8 ? mirror.sessionId : null)
  const agent = (mirror.agent || 'claude').toLowerCase()
  const spans = scanBlocks(lines)
  const sameAgent = spans.filter(span => span.agent === undefined || span.agent === agent)
  let existing: BlockSpan | undefined
  if (fullId !== null) {
    const byResume = sameAgent.filter(span => span.resume !== null && span.resume !== undefined && span.resume === fullId)
    if (byResume.length >= 1) {
      existing = byResume[0]
    } else if (byResume.length === 0) {
      const sameShort = sameAgent.filter(span => span.session === id)
      const legacy = sameShort.filter(span => span.resume === null || span.resume === undefined)
      if (legacy.length === 1 && sameShort.length === 1 && mirror.isRun !== true) {
        existing = legacy[0]
      }
    }
  } else {
    const matching = sameAgent.filter(span => span.session === id && (span.resume === null || span.resume === undefined))
    if (matching.length === 1) {
      existing = matching[0]
    }
  }
  // A run keeps the parent its block already names; until one is named, it takes the person's
  // session working in the same project right now when exactly one is (#399), else none, and
  // counts as a background run.
  const parent = mirror.isRun !== true ? undefined : (existing === undefined ? undefined : parseAttrs(lines[existing.start] ?? '').parent) ?? pickParent(parseProgress(text), mirror.project, mirror.updated, [id, mirror.sessionId]) ?? undefined
  const block = renderAutoBlock(mirror, s, parent)

  if (existing !== undefined) {
    const end = existing.isClosed ? existing.end : existing.start
    lines.splice(existing.start, end - existing.start + 1, ...block)

    return lines.join(eol) + eol
  }

  return placeUnder(lines, mirror.project, block, eol, s)
}

// Drops `##` sections left with nothing in them, only among `touched` (the projects whose
// blocks or tasks were just removed): an empty section someone keeps on purpose stays.
const dropEmptySections = (lines: string[], touched: ReadonlySet<string>): void => {
  // The lines as read change only when a section goes, so they are read again only then: read
  // again for every line, archiving on a board of a few thousand lines took seconds (#371).
  let seen = seenOf(lines)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const heading = PROJECT.exec(seen[index] ?? '')
    if (heading?.[1] === undefined || !touched.has(heading[1])) continue
    let end = index + 1
    while (end < lines.length && !PROJECT.test(seen[end] ?? '')) end += 1
    const body = lines.slice(index + 1, end)
    if (body.every(line => line.trim() === '')) {
      lines.splice(index, end - index)
      seen = seenOf(lines)
    }
  }
}

const removeSpans = (text: string, spans: readonly BlockSpan[]): string => {
  const eol = eolOf(text)
  const lines = linesOf(text)
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    const end = span.isClosed ? span.end : span.start
    lines.splice(span.start, end - span.start + 1)
    trimBlankEdges(lines, Math.min(span.start, lines.length))
  }
  dropEmptySections(lines, new Set(spans.map(span => span.project)))
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()

  return lines.length === 0 ? '' : lines.join(eol) + eol
}

export const removeAutoBlock = (text: string, sessionId: string, agent?: string): string => {
  const id = shortId(sessionId)
  const normAgent = agent?.toLowerCase()
  const matching = scanBlocks(linesOf(text)).filter(span => {
    if (normAgent !== undefined && (span.agent ?? 'claude') !== normAgent) return false
    return span.session === id
  })
  if (matching.length <= 1) {
    return matching.length === 0 ? text : removeSpans(text, matching)
  }
  const byResume = matching.filter(span => span.resume === sessionId)
  const spans = byResume.length === 1 ? byResume : matching

  return removeSpans(text, spans)
}

export const extractAutoBlock = (text: string, sessionId: string, agent?: string): string | null => {
  const lines = linesOf(text)
  const id = shortId(sessionId)
  const normAgent = agent?.toLowerCase()
  const matching = scanBlocks(lines).filter(one => {
    if (normAgent !== undefined && (one.agent ?? 'claude') !== normAgent) return false
    return one.session === id
  })
  if (matching.length === 0) return null
  if (matching.length === 1) {
    const span = matching[0]!
    return lines.slice(span.start, span.end + 1).join('\n')
  }
  const byResume = matching.filter(one => one.resume === sessionId)
  const span = byResume.length === 1 ? byResume[0]! : matching[0]!

  return lines.slice(span.start, span.end + 1).join('\n')
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

  return age > STOPPED_ARCHIVE_MS
}

export type Archived = { text: string; entries: string[] }

export type ConfirmRef = TaskRef & { expected: string }

// All words and marks are part of this action, including steps below the next one. The
// twin count prevents a same-word manual task from taking another task's selected row.
export const confirmKey = (project: string, task: ProgressTask, twins: number): string =>
  sha256(JSON.stringify([project, task.title, task.auto, task.notes, task.steps.map(step => step.raw), task.auto === null ? twins : 0]))

export const confirmedTarget = (text: string, ref: ConfirmRef, s: Strings): ProgressTask | null => {
  const tasks = parseProgress(text).filter(project => (project.name || s.uncategorized) === ref.project).flatMap(project => project.tasks)
  const twins = tasks.filter(task => task.title === ref.title).length
  const matches = tasks.filter(task => task.title === ref.title && (task.auto?.session ?? null) === ref.session && confirmKey(ref.project, task, twins) === ref.expected)
  return matches.find(task => task.line === ref.line) ?? (matches.length === 1 ? matches[0] ?? null : null)
}

export const confirmMatches = (text: string, ref: ConfirmRef, s: Strings = ZH_TW): boolean => confirmedTarget(text, ref, s) !== null

export type ConfirmedTask = { text: string; ref: ConfirmRef; entries: Array<Omit<JournalEntry, 'at'>>; auto: ProgressTask['auto'] }

// A person's completion changes only the exact task drawn, and only after its agent
// stopped. Recheck here, inside each caller's read/change/write retry.
export const confirmTask = (text: string, ref: ConfirmRef, now: number, s: Strings = ZH_TW, seen: Readonly<Record<string, number>> = {}, staleMs: number = STALE_MS): ConfirmedTask | null => {
  const task = confirmedTarget(text, ref, s)
  if (task === null || task.line < 0 || task.auto !== null && task.auto.state !== 'ended' && !isStale(task.auto, now, observedTime(task.auto, now, seen).updated, staleMs)) return null
  const lines = linesOf(text)
  const spans = scanBlocks(lines)
  const span = ref.session === null ? undefined : spans.find(one => one.session === ref.session)
  if (ref.session !== null && (span === undefined || !span.isClosed || spans.filter(one => one.session === ref.session).length !== 1)) return null
  if (ref.session === null && spans.some(one => task.line >= one.start && task.line <= one.end)) return null
  const open = task.steps.filter(step => step.status !== 'done' && step.status !== 'cancelled')
  if (open.length === 0) return null
  for (const step of open) {
    const raw = lines[step.line] ?? ''
    // A legal visible step can follow an inline comment or the end of a multiline
    // comment. Probe only checkbox characters; never tick a hidden example in that line.
    const match = [...raw.matchAll(/\[[ ~?>!]\]/g)].find(one => {
      const index = one.index + 1
      const probe = [...lines]
      probe[step.line] = raw.slice(0, index) + 'x' + raw.slice(index + 1)
      return STEP.exec(readable(probe)[step.line] ?? '')?.[2] === 'x'
    })
    if (match === undefined) return null
    const index = match.index + 1
    lines[step.line] = raw.slice(0, index) + 'x' + raw.slice(index + 1)
  }
  if (span !== undefined) {
    // Only the attributes are edited: FORMAT.md accepts a marker with no space before `-->`
    // and spaces after it, so a bare `[^\s]+` value would take the `-->` with it (#142).
    // A name counts only at the start or after whitespace: `-` is not a word character, so
    // `\b` would also find `state=` inside `backup-state=`.
    const marker = lines[span.start] ?? ''
    const end = marker.lastIndexOf('-->')
    let attrs = end < 0 ? marker : marker.slice(0, end).trimEnd()
    for (const [name, value] of [['state', 'done'], ['updated', new Date(now).toISOString()]]) {
      const attr = new RegExp(`(^|\\s)${name}=(?:"[^"]*"|'[^']*'|[^\\s]+)`)
      attrs = attr.test(attrs) ? attrs.replace(attr, `$1${name}=${value}`) : `${attrs} ${name}=${value}`
    }
    lines[span.start] = end < 0 ? attrs : `${attrs} ${marker.slice(end)}`
  }
  const after = lines.join(eolOf(text)) + (text.endsWith('\n') ? eolOf(text) : '')
  const changed = parseProgress(after).flatMap(project => project.tasks).find(one => one.line === task.line)
  if (changed === undefined || changed.steps.some(step => step.status !== 'done' && step.status !== 'cancelled')) return null
  const twins = parseProgress(after).filter(project => (project.name || s.uncategorized) === ref.project).flatMap(project => project.tasks).filter(one => one.title === ref.title).length
  return { text: after, ref: { ...ref, expected: confirmKey(ref.project, changed, twins) }, auto: task.auto, entries: open.map(step => ({ project: ref.project, task: ref.title, step: step.text })) }
}

// The block still asks something of the person: a visible `[?]` step.
const isAsking = (visible: readonly (string | null)[], span: BlockSpan): boolean =>
  visible.slice(span.start, span.end + 1).some(line => STEP.exec(line ?? '')?.[2] === '?')

// A working or waiting block's question stays live for seven days without a report. After that
// it is treated as left behind, so its question can go to Older unanswered. Ended and done
// blocks still get three days before the sweep may take them (#400).
const isAskingArchiveDue = (span: BlockSpan, now: number): boolean =>
  (span.state === 'working' || span.state === 'waiting')
    ? now - span.updated > SILENT_ASKING_ARCHIVE_MS
    : (span.state === 'ended' || span.state === 'done') && now - span.updated > STOPPED_ARCHIVE_MS

// The blocks that ask which a sweep may take once the caller has checked that their questions are
// kept outside the block (#174): working or waiting after seven quiet days, ended or done after
// three. Each comes with its lines as they read now (`text`), so a later try can tell the block it
// checked from one changed since.
export type AskingBlock = { span: BlockSpan; ref: TaskRef; text: string }
export const archivableAsking = (text: string, now: number, keep?: string): AskingBlock[] => {
  if (!text.includes('[?]')) return []
  const lines = linesOf(text)
  const visible = readable(lines)
  const spans = scanBlocks(lines).filter(span => span.isClosed && span.session !== keep && span.updated > 0 && isAskingArchiveDue(span, now) && isAsking(visible, span))
  if (spans.length === 0) return []
  const projects = parseProgress(text)

  return spans.flatMap(span => {
    // The task the explicit archive would name; a session id shared by two blocks names neither.
    const tasks = projects.filter(project => project.name === span.project).flatMap(project => project.tasks).filter(task => task.auto?.session === span.session)
    const task = tasks[0]

    return tasks.length === 1 && task !== undefined ? [{ span, ref: { project: span.project, title: task.title, line: task.line, session: span.session }, text: lines.slice(span.start, span.end + 1).join('\n') }] : []
  })
}

// Moves old blocks out; each entry is the block without its markers, under a dated heading,
// ready to append to progress-archive.md. A block with a visible `[?]` step stays unless it has
// been quiet long enough (`isAskingArchiveDue`) and `mayTake` says its questions are kept outside
// it, so the question goes on under Older unanswered (`archivableAsking` lists the ones to ask about).
// A verified agent run needs neither an age wait nor a retained question.
export const takeArchivable = (text: string, now: number, keep?: string, s: Strings = ZH_TW, isNow = false, mayTake?: (span: BlockSpan) => boolean, isAgentRun?: (span: BlockSpan) => boolean): Archived => {
  const lines = linesOf(text)
  const visible = readable(lines)
  const spans = scanBlocks(lines).filter(span => span.isClosed && span.session !== keep && (isAgentRun?.(span) === true || isArchivable(span, now, isNow) && (!isAsking(visible, span) || (isAskingArchiveDue(span, now) && mayTake?.(span) === true))))
  if (spans.length === 0) return { text, entries: [] }
  const entries = spans.map(span => {
    const body = lines.slice(span.start + 1, span.end)
    const day = localDay(span.updated || now)

    return [`## ${span.project || s.uncategorized} · ${day}`, ...body].join('\n')
  })

  return { text: removeSpans(text, spans), entries }
}

const manualDoneTasks = (
  projects: readonly ProgressProject[],
  now: number,
  seenAt: (key: string, project: string, task: ProgressTask) => number | undefined,
  isNow = false,
): Array<{ project: string; task: ProgressTask; key: string; at: number }> => {
  const selected: Array<{ project: string; task: ProgressTask; key: string; at: number }> = []
  for (const project of projects) {
    for (const task of project.tasks) {
      if (task.auto !== null || task.line < 0 || !isTaskComplete(task)) continue
      const key = doneKey(project.name, task.title)
      const at = seenAt(key, project.name, task) ?? (isNow ? now : undefined)
      if (at === undefined || (!isNow && !(at <= now && now - at >= HAND_KEPT_DONE_MS))) continue
      selected.push({ project: project.name, task, key, at })
    }
  }
  return selected
}

export const countManualDone = (
  projects: readonly ProgressProject[],
  now: number,
  seenAt: (key: string, project: string, task: ProgressTask) => number | undefined,
): number => manualDoneTasks(projects, now, seenAt).length

// Hand-kept tasks whose every step is done, three days after first observed done
// (`seen`, by doneKey): moved out whole, heading to last step, like a session's block.
// `isNow`: the person asked, so every finished one goes at once, under the day it was seen
// done, or today when it never was.
// Scheduled sweeps use fingerprint observations; an explicit pane tidy keeps its
// existing title-key observations.
export const takeManualDone = (
  text: string,
  now: number,
  seenAt: (key: string, project: string, task: ProgressTask) => number | undefined,
  s: Strings = ZH_TW,
  isNow = false,
): Archived & { keys: string[] } => {
  const lines = linesOf(text)
  const seen = seenOf(lines)
  const spans: BlockSpan[] = []
  const entries: string[] = []
  const keys: string[] = []
  for (const { project, task, key, at } of manualDoneTasks(parseProgress(text), now, seenAt, isNow)) {
    let end = task.line
    for (let index = task.line + 1; index < lines.length; index += 1) {
      const line = seen[index] ?? ''
      if (PROJECT.test(line) || TASK.test(line) || AUTO_START.test(line)) break
      if ((lines[index] ?? '').trim() !== '') end = index
    }
    const last = end
    // The blank lines after it go too, so the next task moves up into its place.
    while (end + 1 < lines.length && lines[end + 1]?.trim() === '') end += 1
    spans.push({ session: '', state: 'done', updated: at, project, start: task.line, end, isClosed: true })
    const day = localDay(at)
    entries.push([`## ${project || s.uncategorized} · ${day}`, ...lines.slice(task.line, last + 1)].join('\n'))
    keys.push(key)
  }
  if (spans.length === 0) return { text, entries: [], keys: [] }

  return { text: removeSpans(text, spans), entries, keys }
}

// One task out now, at the person's word (a row's 封存): an ended session's block, or a
// hand-kept task from its heading to its last line, in the entry form takeArchivable uses.
// null when it cannot be found for sure: a block without its end marker, a heading that is
// gone or has a twin, a heading inside some session's block, or a session id two blocks
// share when the row's project and each block's first heading cannot tell them apart.
export const takeTask = (text: string, ref: TaskRef, now: number, s: Strings = ZH_TW, observations: Readonly<Record<string, number>> = {}, staleMs: number = STALE_MS): Archived | null => {
  const lines = linesOf(text)
  const seen = seenOf(lines)
  const spans = scanBlocks(lines)
  const heading = `## ${ref.project || s.uncategorized} · ${localDay(now)}`
  if (ref.session !== null) {
    const ownHeading = (one: BlockSpan): number => {
      for (let at = one.start + 1; at <= one.end; at += 1) {
        if (TASK.test(seen[at] ?? '')) return at
        if (STEP.test(seen[at] ?? '')) return -1
      }
      return -1
    }
    // Two blocks can carry one id (a resumed session, two machines). Only a block's first heading is its own row;
    // a later ### is a hand-kept task (docs/FORMAT.md), so match that heading alone.
    const same = spans.filter(one => one.session === ref.session).map(one => {
      const first = ownHeading(one)
      return { ...one, heading: first, title: TASK.exec(seen[first] ?? '')?.[1] }
    })
    const matches = same.length === 1 ? same : same.filter(one =>
      (one.project || s.uncategorized) === ref.project &&
      one.title === ref.title,
    )
    const span = matches.find(one => one.heading === ref.line)
      ?? (matches.length === 1 ? matches[0] : undefined)
    if (span === undefined || !span.isClosed) return null
    // Recheck ownership at the write boundary: a stopped row may have resumed since it
    // was drawn. Unknown clocks cannot prove that a working/waiting session stopped.
    if (span.state === 'working' || span.state === 'waiting') {
      const tasks = parseProgress(text).flatMap(project => project.tasks)
      const task = tasks.find(one => one.line === span.heading)
      const auto = task?.auto ?? null
      // The older block of a twin pair is offered for archive while it still looks live (#399):
      // a newer block with the same agent and full id is the one that runs.
      const isTwin = ref.isDuplicate === true && task !== undefined && isOutranked(tasks, task)
      if (auto === null || !isTwin && !isStale(auto, now, observedTime(auto, now, observations).updated, staleMs)) return null
    }

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

  return placeUnder(lines, entry.project, task, eol, s)
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

// A block pasted into the board's page from a web chat (Muse, dot): the chat-relay prompt's
// block, checked the way scripts/remote-reporter/validate.py checks a fragment, then put in
// place of the earlier block with its id, or under its `## project` when new. It never takes
// the place of a Claude block, another agent's block or one whose end marker is missing.
// Arrival time cannot make a delayed report fresh or give it precedence over newer work.
export type PasteProblem = 'noBlock' | 'mixed' | 'badBlock' | 'noProject' | 'notYours' | 'badTime' | 'futureTime' | 'oldTime' | 'older' | 'conflict' | 'unknownOrder'
export type PasteReview = { token: string; current: string; incoming: string }
export type PasteResult = { text: string; title: string; isUnchanged: boolean }
  | { problem: Exclude<PasteProblem, 'oldTime'>; review?: PasteReview }
  | { problem: 'oldTime'; daysBehind: number; review?: PasteReview }

const HEX8 = /^[0-9a-f]{8}$/
const AGENT_NAME = /^[a-z0-9][a-z0-9_.-]{0,31}$/
const FENCE = /^\s*(?:```|~~~)/

// Each of these would end the block early, or hide its end marker from the parser.
const isHiding = (line: string): boolean => FENCE.test(line) || line.includes('<!--') || line.includes('-->') || /^#{1,2}\s/.test(line)

const startAttrs = (line: string | undefined): string => AUTO_START.exec(line ?? '')?.[1] ?? ''

// The relay prompt requires a UTC event time. Date.parse alone accepts local clocks and
// silently rolls impossible dates forward; neither can establish source ordering.
const sourceTime = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null
  const time = Date.parse(value)
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_all, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`)
  return Number.isFinite(time) && new Date(time).toISOString() === canonical ? time : null
}

export const mergeBlock = (text: string, pasted: string, now: number, s: Strings = ZH_TW, reviewToken = ''): PasteResult => {
  const raw = pasted.split(/\r?\n/).map(line => line.trimEnd())
  const start = raw.findIndex(line => AUTO_START.test(line))
  const auto = start < 0 ? null : autoOf(startAttrs(raw[start]))
  const end = raw.findIndex((line, index) => start >= 0 && index > start && AUTO_END.test(line))
  if (auto === null || end < 0) return { problem: 'noBlock' }
  if (parseAttrs(raw[end] ?? '').session !== auto.session) return { problem: 'mixed' }
  const incomingAttrs = parseAttrs(startAttrs(raw[start]))
  const named = incomingAttrs.agent
  const body = raw.slice(start + 1, end)
  const title = TASK.exec(body[0] ?? '')?.[1]
  // The chat names itself in lower case; a block without an agent would read as Claude's.
  if (title === undefined || !HEX8.test(auto.session) || named === undefined || named !== auto.agent || !AGENT_NAME.test(named) || auto.agent === 'claude' || body.some(isHiding)) {
    return { problem: 'badBlock' }
  }
  const eol = eolOf(text)
  const lines = linesOf(text)
  const matching = scanBlocks(lines).filter(span => span.session === auto.session)
  if (matching.length > 1) return { problem: 'notYours' }
  const existing = matching[0]
  const time = sourceTime(incomingAttrs.updated)
  // A live report must not arrive already old enough for the stopped-block sweep.
  if (time !== null && (auto.state === 'working' || auto.state === 'waiting') && now - time > STOPPED_ARCHIVE_MS) {
    return { problem: 'oldTime', daysBehind: Math.floor((now - time) / DAY) }
  }
  if (existing !== undefined) {
    const owner = autoOf(startAttrs(seenOf(lines)[existing.start]))
    const attrs = parseAttrs(startAttrs(seenOf(lines)[existing.start]))
    // A local reporter's binding must survive a pasted block with the same agent and id.
    if (!existing.isClosed || owner?.agent !== auto.agent || attrs.owner !== undefined || owner.resume !== null || owner.dir !== null) return { problem: 'notYours' }
    const currentBody = lines.slice(existing.start + 1, existing.end).map(line => line.trimEnd())
    if (owner.state === auto.state && attrs.updated === incomingAttrs.updated && currentBody.join('\n') === body.join('\n')) return { text, title, isUnchanged: true }
  }
  if (time === null) return { problem: 'badTime' }
  if (time > now) return { problem: 'futureTime' }
  // Rebuild only checked fields; a remote fragment cannot select a local receiving session,
  // working folder or pull request. Keep the source time exactly, including its precision.
  const marker = `<!-- auto session=${auto.session} agent=${auto.agent} state=${auto.state} updated=${incomingAttrs.updated} -->`
  const block = [marker, ...body, `<!-- /auto session=${auto.session} -->`]
  if (existing !== undefined) {
    const oldTime = sourceTime(parseAttrs(startAttrs(lines[existing.start])).updated)
    if (oldTime === null || oldTime > now) {
      const current = lines.slice(existing.start, existing.end + 1).join('\n')
      // A review applies only to this exact pair, not a changed report or newer board state.
      const token = sha256(JSON.stringify(['relay-clock-review', existing.project, current, block]))
      if (reviewToken !== token) return { problem: 'unknownOrder', review: {
        token,
        current: [parseAttrs(startAttrs(lines[existing.start])).updated ?? '?', ...lines.slice(existing.start + 1, existing.end)].join('\n'),
        incoming: [incomingAttrs.updated, ...body].join('\n'),
      } }
    } else {
      if (time < oldTime) return { problem: 'older' }
      if (time === oldTime) return { problem: 'conflict' }
    }
    lines.splice(existing.start, existing.end - existing.start + 1, ...block)

    return { text: lines.join(eol) + eol, title, isUnchanged: false }
  }
  // The `##` line nearest above the block names its project; it becomes a heading, so no
  // comment opening goes with it.
  const project = raw
    .slice(0, start)
    .flatMap(line => {
      const name = PROJECT.exec(line)?.[1]
      return name === undefined ? [] : [cleanProject(name)]
    })
    .at(-1)
  if (project === undefined || project === '') return { problem: 'noProject' }

  return { text: placeUnder(lines, project, block, eol, s), title, isUnchanged: false }
}

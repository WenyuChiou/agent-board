import type { ProgressMirror, ProgressProject } from '../types'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { waitsOnYou } from './mirror'
import { countSteps, currentStepIndex, isTaskComplete, readable } from './parse'

// A line per finished step, one file a month beside progress.md, so "what did I do this
// week" has an answer after the blocks themselves are archived.
//   - 2026-10-16 14:32 · persona_framework · 重做進度面板 · 寫測試

export type JournalEntry = { at: string; project: string; task: string; step: string }

const pad = (value: number): string => String(value).padStart(2, '0')

// Local time: the journal is read by a person, in their own day.
export const localDay = (now: number): string => {
  const date = new Date(now)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const localStamp = (now: number): string => {
  const date = new Date(now)
  return `${localDay(now)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// This month's archive beside progress.md, where finished work moves.
export const archivePath = (progressPath: string, now: number): string => `${progressPath.replace(/\.md$/i, '')}-archive-${localDay(now).slice(0, 7)}.md`

// A pending-save note written before the archive and cleared after progress.md is updated (#560),
// telling crash-recovery retries apart from distinct same-day twins with identical text.
export const pendingArchivePath = (progressPath: string): string =>
  `${progressPath.replace(/\.md$/i, '')}-archive.pending`

export const parsePendingArchive = (text: string): string[] => {
  if (text.trim() === '') return []
  try {
    const data: unknown = JSON.parse(text)
    const list = Array.isArray(data)
      ? data.filter((item): item is string => typeof item === 'string')
      : data !== null && typeof data === 'object' && 'entries' in data && Array.isArray((data as { entries: unknown }).entries)
        ? (data as { entries: unknown[] }).entries.filter((item): item is string => typeof item === 'string')
        : []
    return list.map(item => item.replace(/\r\n/g, '\n').replace(/\n+$/, ''))
  } catch {
    return []
  }
}

export const journalPath = (progressPath: string, now: number): string =>
  `${progressPath.replace(/\.md$/i, '')}-journal-${localDay(now).slice(0, 7)}.md`

// A retry may find the whole entry already saved, but a shorter task must never match
// the beginning of an older, longer one. Fenced/commented headings are part of the body.
export const hasArchiveEntry = (past: string, entry: string): boolean => archiveEntryCount(past, entry) > 0

// How many copies of an entry an archive holds: two done blocks with the same title and steps
// make the same entry text, so a yes/no match counts them as one (#231).
export const archiveEntryCount = (past: string, entry: string): number => {
  const lines = past.replace(/\r\n/g, '\n').split('\n')
  const starts = readable(lines).flatMap((line, index) => line !== null && /^##\s/.test(line) ? [index] : [])
  const wanted = entry.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return starts.filter((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length).join('\n').replace(/\n+$/, '') === wanted,
  ).length
}

// The entries an earlier try of this run has not archived yet (`written` counts what it did),
// counted with their number, so the second of two same-text entries is still new.
export const unwrittenEntries = (entries: readonly string[], written: ReadonlyMap<string, number>): string[] => {
  const seen = new Map<string, number>()
  return entries.filter(entry => {
    const nth = (seen.get(entry) ?? 0) + 1
    seen.set(entry, nth)
    return nth > (written.get(entry) ?? 0)
  })
}

// The entries the archive files (`pasts`) do not hold yet. When `pending` is provided, only
// entries recorded in an interrupted save attempt and already present in the archive are skipped (#560).
// When `pending` is omitted, an archive holding at least as many copies as are going treats them
// as that save.
export const missingEntries = (
  pasts: readonly string[],
  entries: readonly string[],
  written: ReadonlyMap<string, number> = new Map(),
  pending?: readonly string[],
): string[] => {
  const norm = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  if (pending === undefined) {
    const going = new Map<string, number>()
    for (const entry of entries) {
      const key = norm(entry)
      going.set(key, (going.get(key) ?? 0) + 1)
    }
    const isHeld = new Map([...going].map(([key, count]) => [key, pasts.reduce((sum, past) => sum + archiveEntryCount(past, key), 0) - (written.get(key) ?? 0) >= count]))
    return entries.filter(entry => isHeld.get(norm(entry)) !== true)
  }
  const pendingCount = new Map<string, number>()
  for (const entry of pending) {
    const key = norm(entry)
    pendingCount.set(key, (pendingCount.get(key) ?? 0) + 1)
  }
  const inPastCount = new Map<string, number>()
  for (const entry of entries) {
    const key = norm(entry)
    if (!inPastCount.has(key)) {
      inPastCount.set(key, pasts.reduce((sum, past) => sum + archiveEntryCount(past, entry), 0) - (written.get(entry) ?? 0))
    }
  }
  const consumed = new Map<string, number>()
  return entries.filter(entry => {
    const key = norm(entry)
    const needed = (consumed.get(key) ?? 0) + 1
    consumed.set(key, needed)
    const inPending = pendingCount.get(key) ?? 0
    const inPast = inPastCount.get(key) ?? 0
    const isAlreadySaved = needed <= inPending && needed <= inPast
    return !isAlreadySaved
  })
}

// The month before, so a week that spans two months reads both files.
export const previousMonth = (now: number): number => {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), 0, 12).getTime()
}

// ` · ` separates the fields, so a field never holds one.
const field = (text: string, s: Strings): string => text.replace(/\s+/g, ' ').replace(/\s·\s/g, '・').trim() || s.unnamed

export const journalLine = (entry: Omit<JournalEntry, 'at'>, now: number, s: Strings = ZH_TW): string =>
  `- ${localStamp(now)} · ${field(entry.project, s)} · ${field(entry.task, s)} · ${field(entry.step, s)}`

export const appendJournal = (text: string, lines: readonly string[], s: Strings = ZH_TW): string =>
  lines.length === 0 ? text : `${text.trim() === '' ? `${s.journalTitle}\n` : text.replace(/\s*$/, '\n')}${lines.join('\n')}\n`

const LINE = /^- (\d{4}-\d{2}-\d{2}) \d{2}:\d{2} · (.+?) · (.+?) · (.+)$/

// Steps finished on the day `now` falls on, for the count at the top of the pane.
export const countDay = (text: string, now: number): number => {
  const day = localDay(now)
  return parseJournal(text).filter(entry => entry.at === day).length
}

export const parseJournal = (text: string): JournalEntry[] =>
  text.split(/\r?\n/).flatMap(line => {
    const match = LINE.exec(line)
    if (match === null) return []
    const [, at = '', project = '', task = '', step = ''] = match
    return [{ at, project, task, step }]
  })

// What finished in the last `days` days, what is open, and what waits on you: plain text a
// person pastes into a weekly report, a standup or a message to an advisor.
export const progressReport = (
  entries: readonly JournalEntry[],
  projects: readonly ProgressProject[],
  mine: ProgressMirror | null,
  now: number,
  days: number,
  s: Strings = ZH_TW,
): string => {
  const from = localDay(now - (days - 1) * 24 * 60 * 60 * 1000)
  const to = localDay(now)
  const heading = days === 1 ? s.reportToday(to.slice(5)) : s.reportDays(days, from.slice(5), to.slice(5))

  const done = new Map<string, string[]>()
  for (const entry of entries) {
    if (entry.at < from || entry.at > to) continue
    const key = `${entry.project} · ${entry.task}`
    const steps = done.get(key) ?? []
    if (!steps.includes(entry.step)) steps.push(entry.step)
    done.set(key, steps)
  }

  const open: string[] = []
  const waiting: string[] = []
  if (mine !== null && mine.tasks.some(task => task.status !== 'completed')) {
    const left = mine.tasks.filter(task => task.status !== 'completed')
    const finished = mine.tasks.length - left.length
    open.push(`- ${mine.project} · ${mine.title || left[0]?.subject || ''}${s.pairSep}${s.reportNext(left[0]?.subject ?? '')} (${finished}/${mine.tasks.length})`)
    for (const task of left) if (waitsOnYou(mine, task)) waiting.push(`- ${mine.project} · ${task.subject}`)
  }
  const ownId = mine === null ? '' : mine.sessionId.slice(0, 8)
  for (const project of projects) {
    for (const task of project.tasks) {
      if (task.auto?.session === ownId || task.auto?.state === 'done' || isTaskComplete(task)) continue
      const { done: finished, total } = countSteps(task)
      const next = task.steps[currentStepIndex(task)]?.text ?? ''
      open.push(`- ${project.name} · ${task.title}${next === '' ? '' : `${s.pairSep}${s.reportNext(next)}`} (${finished}/${total})`)
      for (const step of task.steps) if (step.status === 'waiting') waiting.push(`- ${project.name} · ${step.text}`)
    }
  }

  const finishedLines = [...done].map(([key, steps]) => `- ${key}${s.pairSep}${steps.join(s.listSep)}`)
  const sections = [
    heading,
    '',
    s.reportDone,
    ...(finishedLines.length === 0 ? [s.reportNone] : finishedLines),
    ...(open.length === 0 ? [] : ['', s.reportOpen, ...open]),
    ...(waiting.length === 0 ? [] : ['', s.reportWaiting, ...waiting]),
  ]

  return sections.join('\n')
}

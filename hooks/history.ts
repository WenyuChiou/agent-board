import type { ProgressTask } from '../types'
import { stamped, stampOf } from './done-stamp'
import { eolOf, HIDDEN, linesOf, scanBlocks, seenOf } from './blocks'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { localDay } from './journal'
import { AUTO_END, AUTO_START, isTaskComplete, parseProgress } from './parse'
import { EN } from './strings-en'
import { ZH_CN } from './strings-zh-cn'

// Seven days of history in an open hand-kept task (#922). The board gives a finished step a hidden
// date the first time it sees the step (done-stamp.ts); a step done more than `days` days ago
// then moves to the month archive with its task's title, and the task keeps one plain line in
// its place. Nothing here reads the clock or a file: `now` and the setting come in.

export const HISTORY_DAYS = 7
const DAY = 24 * 60 * 60 * 1000
const MAX_DAYS = 3650
const HEADING = /^#{2,3}\s/

export const settingsPath = (progressPath: string): string => `${progressPath.replace(/\.md$/i, '')}-settings.json`

// The days of history from the settings file's text. A file that is missing, does not read as
// JSON or holds anything but a whole number of days from 1 to 3650 means 7.
export const historyDaysOf = (text: string | null): number => {
  if (text === null || text.trim() === '') return HISTORY_DAYS
  try {
    const data: unknown = JSON.parse(text)
    const days = data !== null && typeof data === 'object' ? (data as Record<string, unknown>).historyDays : undefined
    return typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= MAX_DAYS ? days : HISTORY_DAYS
  } catch {
    return HISTORY_DAYS
  }
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const MANY = 777777

// The summary line in every language, read back. English words a count of one differently, so each
// table has a pattern for one (the count is fixed) and one for any other count.
const patternOf = (words: Strings, count: number): RegExp => {
  const line = escapeRegex(words.historyLine(count, '@F@', '@T@'))
  const counted = count === 1 ? line : line.replace(String(MANY), '(\\d+)')

  return new RegExp(`^${counted.replace('@F@', '(\\d\\d-\\d\\d)').replace('@T@', '(\\d\\d-\\d\\d)')}$`)
}
const PATTERNS = ([EN, ZH_TW, ZH_CN] as Strings[]).flatMap(words => [
  { re: patternOf(words, 1), isOne: true },
  { re: patternOf(words, MANY), isOne: false },
])

export type HistoryLine = { count: number; from: string; to: string }

// What a summary line says, or null for any other line.
export const historyLineOf = (line: string): HistoryLine | null => {
  const text = line.trim()
  for (const { re, isOne } of PATTERNS) {
    const found = re.exec(text)
    if (found === null) continue
    const count = isOne ? 1 : Number(found[1])
    const from = found[isOne ? 1 : 2]
    const to = found[isOne ? 2 : 3]
    if (Number.isSafeInteger(count) && from !== undefined && to !== undefined) return { count, from, to }
  }

  return null
}

// The start of a local day, `YYYY-MM-DD`.
const startOf = (day: string): number => {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)
  return new Date(year, month - 1, date).getTime()
}

// A summary line's MM-DD as a full day: the latest one that is not after now.
const fullDay = (monthDay: string, now: number): string => {
  const year = new Date(now).getFullYear()
  const day = `${year}-${monthDay}`

  return startOf(day) > now ? `${year - 1}-${monthDay}` : day
}

export type HistorySweep = { text: string; entries: string[]; stamped: number; moved: number }

// One pass over a board's text. A finished (`[x]` or `[-]`) step of a hand-kept task that is still open, with no date
// gets today's, and nothing else happens to it. A step whose date is more than `days` days
// before now, in a task that is still open, moves out, one archive entry for each task. Steps
// of any other mark, `>` lines, agent blocks and finished tasks (the 3-day rule keeps those)
// stay as they are. Counted from the start of the day the step was stamped.
export const sweepHistory = (text: string, now: number, days: number, s: Strings = ZH_TW): HistorySweep => {
  const lines = linesOf(text)
  const seen = seenOf(lines)
  const spans = scanBlocks(lines)
  const today = localDay(now)
  const isInBlock = (index: number): boolean => spans.some(span => index >= span.start && index <= span.end)
  const tasks = parseProgress(text).flatMap(project => project.tasks.map(task => ({ project: project.name, task })))
    .filter((one): one is { project: string; task: ProgressTask } => one.task.auto === null && one.task.line >= 0 && !isInBlock(one.task.line))
  const removed = new Set<number>()
  const replaced = new Map<number, string>()
  const entries: string[] = []
  let stampCount = 0
  let moveCount = 0
  for (const { project, task } of tasks) {
    // A finished task is left exactly as it is: the 3-day rule and the first release's count-only
    // pass own it, so a sweep that has nothing else to write writes nothing there.
    if (isTaskComplete(task)) continue
    const moving: Array<{ line: number; day: string }> = []
    for (const step of task.steps) {
      if (step.status !== 'done' && step.status !== 'cancelled') continue
      const raw = lines[step.line] ?? ''
      if (seen[step.line] === HIDDEN || raw !== step.raw) continue
      const day = stampOf(raw)
      if (day === null) {
        // A comment of someone else's on the line stays theirs: no second one goes beside it.
        if (raw.includes('<!--')) continue
        replaced.set(step.line, stamped(raw, today))
        stampCount += 1
        continue
      }
      if (now - startOf(day) > days * DAY) moving.push({ line: step.line, day })
    }
    const firstStep = moving[0]
    if (firstStep === undefined) continue
    // The task's lines run to the next heading or block marker.
    let end = task.line
    for (let index = task.line + 1; index < lines.length; index += 1) {
      const line = seen[index] ?? ''
      if (HEADING.test(line) || AUTO_START.test(line) || AUTO_END.test(line)) break
      end = index
    }
    let summaryAt = -1
    let before: HistoryLine | null = null
    for (let index = task.line + 1; index <= end && before === null; index += 1) {
      if (seen[index] === HIDDEN) continue
      before = historyLineOf(seen[index] ?? '')
      if (before !== null) summaryAt = index
    }
    const dates = moving.map(one => one.day).sort()
    const from = [...dates, ...(before === null ? [] : [fullDay(before.from, now)])].sort()[0] ?? today
    const to = [...dates, ...(before === null ? [] : [fullDay(before.to, now)])].sort().at(-1) ?? today
    const at = summaryAt >= 0 ? summaryAt : firstStep.line
    replaced.set(at, s.historyLine((before?.count ?? 0) + moving.length, from.slice(5), to.slice(5)))
    for (const one of moving) removed.add(one.line)
    // The summary line takes the place of a step it replaces.
    removed.delete(at)
    entries.push([`## ${project || s.uncategorized} · ${today}`, `### ${task.title}`, ...moving.map(one => lines[one.line] ?? '')].join('\n'))
    moveCount += moving.length
  }
  if (stampCount === 0 && moveCount === 0) return { text, entries: [], stamped: 0, moved: 0 }
  const eol = eolOf(text)
  const out = lines.flatMap((line, index) => (removed.has(index) ? [] : [replaced.get(index) ?? line]))

  return { text: out.join(eol) + eol, entries, stamped: stampCount, moved: moveCount }
}

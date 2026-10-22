import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { sha256 } from './sha256'
import { dueDays } from './view'
import type { View } from './view'

// What to tell the person without being asked: a question another session or agent put to
// them, once, and work due today or late, once a day. `told` holds what was already said
// (shared by every open session through the store, so one question pings once, not once per
// session); a key not in it is new.

export type Reminder = { key: string; kind: 'ask' | 'due'; text: string; project: string }

export const remindersOf = (
  view: View,
  told: Readonly<Record<string, number>>,
  now: number,
  day: string,
  s: Strings = ZH_TW,
): Reminder[] => {
  const out: Reminder[] = []
  for (const item of view.waiting) {
    if (item.where !== 'other') continue
    // Keyed by the question and its words, so a session that asks something new in the same place
    // pings again, and so does the same question asked again after it was answered (a new
    // question in the ledger). The key is a short hash of those, not the words themselves: the
    // list held whole questions, one per id (#373). The old key still counts as told, so the
    // first run after an update does not say every waiting question again.
    const key = toldKey(item.questionId ?? item.key, item.text)
    if (told[key] === undefined && told[`ask:${item.questionId ?? item.key}:${item.text}`] === undefined) out.push({ key, kind: 'ask', project: item.project, text: s.noticeAsked(item.agent || item.project, item.text) })
  }
  for (const row of view.due) {
    if (row.due === null) continue
    const days = dueDays(row.due.date, now)
    if (days === null || days > 0) continue
    const key = `due:${row.key}:${day}`
    if (told[key] === undefined) out.push({ key, kind: 'due', project: row.project, text: s.noticeDue(row.title, row.due.left) })
  }

  return out
}

export const TOLD_MAX = 500

export const toldKey = (question: string, text: string): string => `ask:${sha256(JSON.stringify([question, text])).slice(0, 16)}`

// Keys older than three days are dropped, and past 500 the oldest, so the list stays short. The
// keys in `live` (the questions waiting now) go last, so a waiting question is not said again
// because many others were told since.
export const keepRecent = (told: Readonly<Record<string, number>>, now: number, live: ReadonlySet<string> = new Set()): Record<string, number> =>
  Object.fromEntries(
    Object.entries(told)
      .filter(([, at]) => now - at < 3 * 24 * 60 * 60 * 1000)
      .sort(([keyA, a], [keyB, b]) => Number(live.has(keyB)) - Number(live.has(keyA)) || b - a)
      .slice(0, TOLD_MAX),
  )

// The told keys of the questions waiting now, in both shapes.
export const liveToldKeys = (view: View): Set<string> =>
  new Set(view.waiting.filter(item => item.where === 'other').flatMap(item => [toldKey(item.questionId ?? item.key, item.text), `ask:${item.questionId ?? item.key}:${item.text}`]))

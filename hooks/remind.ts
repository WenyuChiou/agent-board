import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
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
    // Keyed by its words too, so a session that asks something new in the same place pings again.
    const key = `ask:${item.key}:${item.text}`
    if (told[key] === undefined) out.push({ key, kind: 'ask', project: item.project, text: s.noticeAsked(item.agent || item.project, item.text) })
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

// Keys older than three days are dropped, so the list stays short.
export const keepRecent = (told: Readonly<Record<string, number>>, now: number): Record<string, number> =>
  Object.fromEntries(Object.entries(told).filter(([, at]) => now - at < 3 * 24 * 60 * 60 * 1000))

import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import type { PendingTurn } from './board'
import { parseProgress, STALE_MS } from './parse'
import { parseQuestions } from './questions'
import { serveModel } from './serve'
import { buildView, parseAnswered } from './view'
import type { View } from './view'

export type BoardCounts = {
  // Questions still waiting for the person: an answer queued for the session's next turn is not one (#1296).
  needs: number
  // Answers queued for a session's next turn; they stay on every surface, marked, and leave `needs`.
  queued: number
  working: number
}

// What the store holds for the board to count queued answers by; the page builds the same shape from its server.
export type QueuedMessaging = NonNullable<Parameters<typeof serveModel>[5]>

const pageView = (view: View, pending: readonly PendingTurn[], s: Strings, now: number, messaging?: QueuedMessaging) =>
  serveModel(view, pending, s, new Set(), false, messaging, false, {
    now,
    repoOf: () => null,
    versions: { board: '', package: null },
    unreadable: [],
  })

// Single counting source for Needs you and Working now across the page, the terminal board and --status (#832).
export const boardCounts = (
  view: View,
  pending: readonly PendingTurn[] = [],
  s: Strings = ZH_TW,
  now = view.now,
  messaging?: QueuedMessaging,
): BoardCounts => {
  const model = pageView(view, pending, s, now, messaging)
  const page = model.view!
  const handled = new Set(page.needs.handled)
  const handledNeeds = page.needs.cards.filter(card => handled.has(card.key)).length

  return {
    needs: Math.max(0, page.n - handledNeeds),
    queued: page.needs.handled.length,
    working: page.working.length,
  }
}

// A status-bar poll uses progress.md and sidecars (answered, questions) read-only, size-capped (#832).
// The page's grouping supplies the same Needs you and Working now rules.
export const boardStatus = (
  markdown: string,
  now: number,
  s: Strings = ZH_TW,
  staleMs = STALE_MS,
  answeredText = '',
  questionsText = '',
  pending: readonly PendingTurn[] = [],
  messaging?: QueuedMessaging,
  // Blocks whose claimed live process is gone on this machine (#1092): their
  // questions leave the waiting count, as a stale session's do.
  gone: ReadonlySet<string> = new Set(),
): string => {
  const answered = parseAnswered(answeredText) ?? []
  const questions = parseQuestions(questionsText) ?? undefined
  // The view observes the pending turns too: with a ledger supplied, a new inbox question
  // is counted through the ledger, not through the remaining inbox (#1000).
  const view = buildView(parseProgress(markdown), [], null, now, 0, {}, s, answered, {}, questions, undefined, pending, new Set(), undefined, staleMs, undefined, gone)
  const counts = boardCounts(view, pending, s, now, messaging)

  return s.boardStatusLine(counts.needs, counts.working) + (counts.queued > 0 ? ` · ${s.boardQueuedCount(counts.queued)}` : '')
}

// The Claude Code pane's view with the questions whose answer is queued for the session's next turn taken out of its
// waiting count and counted as queued (#1296): the same question cards the page lists as handled. The pane counts
// questions only, so a stuck row the page counts is left as it was. With nothing queued the view is returned as it is.
export const withQueuedAnswers = (view: View, pending: readonly PendingTurn[], s: Strings, messaging: QueuedMessaging | undefined): View => {
  if (messaging === undefined || !messaging.messages.some(one => one.from === 'board')) return view
  const page = pageView(view, pending, s, view.now, messaging).view!
  const handled = new Set(page.needs.handled)
  const queued = page.needs.cards.filter(card => card.kind === 'question' && handled.has(card.key)).length
  return queued === 0 ? view : { ...view, overview: { ...view.overview, waiting: Math.max(0, view.overview.waiting - queued), queued } }
}

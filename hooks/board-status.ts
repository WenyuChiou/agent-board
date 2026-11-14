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

// Single counting source for Needs you and Working now across the page, the terminal board and --status (#832).
export const boardCounts = (
  view: View,
  pending: readonly PendingTurn[] = [],
  s: Strings = ZH_TW,
  now = view.now,
  messaging?: QueuedMessaging,
): BoardCounts => {
  const model = serveModel(view, pending, s, new Set(), false, messaging, false, {
    now,
    repoOf: () => null,
    versions: { board: '', package: null },
    unreadable: [],
  })

  const queued = model.view!.needs.handled.length

  return {
    needs: Math.max(0, model.view!.n - queued),
    queued,
    working: model.view!.working.length,
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

import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import type { PendingTurn } from './board'
import { parseProgress, STALE_MS } from './parse'
import { parseQuestions } from './questions'
import { serveModel } from './serve'
import { buildView, parseAnswered } from './view'
import type { View } from './view'

export type BoardCounts = {
  needs: number
  working: number
}

// Single counting source for Needs you and Working now across the page, the terminal board and --status (#832).
export const boardCounts = (
  view: View,
  pending: readonly PendingTurn[] = [],
  s: Strings = ZH_TW,
  now = view.now,
): BoardCounts => {
  const model = serveModel(view, pending, s, new Set(), false, undefined, false, {
    now,
    repoOf: () => null,
    versions: { board: '', package: null },
    unreadable: [],
  })

  return {
    needs: model.view!.n,
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
): string => {
  const answered = parseAnswered(answeredText) ?? []
  const questions = parseQuestions(questionsText) ?? undefined
  const view = buildView(parseProgress(markdown), [], null, now, 0, {}, s, answered, {}, questions, undefined, [], new Set(), undefined, staleMs)
  const counts = boardCounts(view, pending, s, now)

  return s.boardStatusLine(counts.needs, counts.working)
}

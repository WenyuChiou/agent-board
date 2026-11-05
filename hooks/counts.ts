import type { Strings } from './i18n'
import type { PendingTurn } from './board'
import type { View } from './view'
import { serveModel } from './serve'

// What the page, the terminal board's count line and `--status` print for "needs you" and
// "working". It is the page's own model, so the three read the same grouping (`countsOf`) and a
// surface cannot count by a rule of its own (#832). It lives apart from board.ts so the pane,
// which draws the text board, does not pull the page in.
export const boardCounts = (view: View, pending: readonly PendingTurn[], s: Strings, now: number): { needs: number; working: number } => {
  const model = serveModel(view, pending, s, new Set(), false, undefined, false, {
    now, repoOf: () => null, versions: { board: '', package: null }, unreadable: view.unreadable ?? [],
  })

  return { needs: model.view!.n, working: model.view!.working.length }
}

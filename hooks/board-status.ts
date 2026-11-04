import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { parseProgress, STALE_MS } from './parse'
import { serveModel } from './serve'
import { buildView } from './view'

// A status-bar poll uses only this snapshot, never the interactive reader's sidecars.
// The page's grouping supplies the same Needs you and Working now rules.
export const boardStatus = (markdown: string, now: number, s: Strings = ZH_TW, staleMs = STALE_MS): string => {
  const view = buildView(parseProgress(markdown), [], null, now, 0, {}, s, [], {}, undefined, undefined, [], new Set(), undefined, staleMs)
  const model = serveModel(view, [], s, new Set(), false, undefined, false, {
    now, repoOf: () => null, versions: { board: '', package: null }, unreadable: [],
  })

  return s.boardStatusLine(model.view!.n, model.view!.working.length)
}

import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { parseProgress, STALE_MS } from './parse'
import type { QuestionLedger } from './questions'
import { boardCounts } from './counts'
import { buildView } from './view'

// What a status-bar poll may read beyond progress.md: the answered file and the question ledger,
// so a question hidden on the board is left out here too. Either is absent when it could not be read.
export type StatusSidecars = { answered?: readonly string[]; questions?: QuestionLedger }

// A status-bar poll builds the board's view from these files only, never the interactive reader's
// other sidecars. The numbers are the page's own (`boardCounts`).
export const boardStatus = (markdown: string, now: number, s: Strings = ZH_TW, staleMs = STALE_MS, sidecars: StatusSidecars = {}): string => {
  const view = buildView(parseProgress(markdown), [], null, now, 0, {}, s, sidecars.answered ?? [], {}, sidecars.questions, undefined, [], new Set(), undefined, staleMs)
  const counts = boardCounts(view, [], s, now)

  return s.boardStatusLine(counts.needs, counts.working)
}

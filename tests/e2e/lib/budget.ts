// Plain Node reads these constants through budget.mjs; pane journeys import this file.
// Exclude the clock preload's own file reads when file-operation counting arrives in step 4.
export const PANE_MS = 3000
export const PAGE_MS = 4000
// Receipt slack on top of the connector and page polls: covers one delivery round trip on a loaded CI runner.
export const RECEIPT_SLACK_MS = 2000
export const IDLE_POLL_FILE_OPS = 6
export const LIVE_SESSIONS = 100
export const BLOCKS = 300
export const LEDGER_RECORDS = 1000
export const BUILD_VIEW_MS = 50

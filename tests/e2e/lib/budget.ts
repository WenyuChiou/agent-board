// Plain Node reads these constants through budget.mjs; pane journeys import this file.
// Exclude the clock preload's own file reads when file-operation counting arrives in step 4.
export const PANE_MS = 3000
export const PAGE_MS = 4000
// Receipt slack on top of the connector and page polls: covers one delivery round trip on a loaded CI runner.
export const RECEIPT_SLACK_MS = 2000
// D24: file operations per idle poll. The page server's check comes with #222's final pull
// request. The pane's is in tests/ledger-reads.test.tsx (#156), since plain Node cannot load the pane.
export const IDLE_POLL_FILE_OPS = 6
// D24, the plan's scale budget: 100 live sessions, 300 blocks, 1,000 question records.
export const LIVE_SESSIONS = 100
export const BLOCKS = 300
export const LEDGER_RECORDS = 1000
export const BUILD_VIEW_MS = 50
// The plan's budget for one hook run. It equals the host's limit for Antigravity and for Codex's
// prompt hook (HOOK_TIMEOUTS in hooks/hook-safety.ts). tests/e2e/l4-time.test.mjs asserts that, so
// a change to the host limit fails there. Codex waits 10 s for its Stop hook. A host that gives up
// on a hook loses the event (#241).
export const HOOK_TIMEOUT_MS = 3000
// #241 (Expected) asks for "under 1 s on a 5 MB file". A loaded runner cannot time 1 s absolutely,
// so the journey limits what the 5 MB file adds to the same hook on a small file.
export const BIG_FILE_HOOK_MS = 1000
// Retirement caps (tests/e2e/retirement.test.mjs): 30 simulated days. Each day starts six
// sessions: four ask a question and finish (a done block leaves 12 hours after its last write)
// and two are left stopped (a stopped block leaves 3 days after its last write). The scheduled
// sweep runs every second night, so a stopped block can wait one sweep longer.
export const RETIREMENT_DAYS = 30
export const RETIREMENT_QUESTIONS_PER_DAY = 4
// The most a day's end holds: the 2 stopped blocks of each of the 2 earlier days that the last
// sweep kept (still inside their 3 days), plus the 6 blocks the day itself started.
export const RETIREMENT_LIVE_BLOCKS = 2 * 2 + 6
// One test block is a title, a context line and two steps between two markers: about 225 bytes
// with its share of the project headings. A third more leaves room for longer titles.
export const RETIREMENT_BLOCK_BYTES = 300
export const RETIREMENT_PROGRESS_BYTES = RETIREMENT_LIVE_BLOCKS * RETIREMENT_BLOCK_BYTES
// A reporter run deletes inbox files by age, and the two reporters (hooks/hook-reporters.ts) use
// different rules. PowerShell removes files older than 2 days (AddDays(-2)), and sh runs
// find -mtime +2, which counts whole days and so keeps a file until it is 3 days old. The test runs
// the reporter of its own system, so the cap is the larger rule, sh's: 3 days of the 2 turn files
// a day, plus the file that run writes. PowerShell stays under it.
export const RETIREMENT_INBOX_FILES = 3 * 2 + 1

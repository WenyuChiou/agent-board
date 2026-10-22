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
// The plan's budget for one hook run. It equals the host's limit for Antigravity and for Codex's
// prompt hook in hooks/hook-safety.ts; Codex waits 10 s for its Stop hook. A host that gives up
// on a hook loses the event (#241).
export const HOOK_TIMEOUT_MS = 3000
// #241: a 5 MB progress.md may add at most a third of that budget to a hook.
export const BIG_FILE_HOOK_MS = HOOK_TIMEOUT_MS / 3
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
// A question's files only matter while its task is still on the board. A task that asked is
// finished the same day and swept within 2 days, so no more than 2 days of questions.
// FORMAT.md (question sources) says never to age-prune captures today; lifting hold:question-ledger-prune changes that rule together with the code.
export const RETIREMENT_QUESTIONS = 2 * RETIREMENT_QUESTIONS_PER_DAY
// One ledger record holds the question's text and its source: about 1.25 KB in this test.
export const RETIREMENT_LEDGER_BYTES = RETIREMENT_QUESTIONS * 1500
// Every question keeps one capture of its text and source, written when the board first sees it.
export const RETIREMENT_CAPTURE_FILES = RETIREMENT_QUESTIONS
// A reporter run deletes inbox files older than 2 days (PowerShell) or, with find -mtime +2,
// 3 days (sh): at most 3 days of the 2 turn files a day, plus the file that run writes.
export const RETIREMENT_INBOX_FILES = 3 * 2 + 1

# DeepSeek Harness: a board answer reaches an idle session, 2026-11-07 to 11-08

For #725. Run by claude (the maintainer's PM session) with the owner's consent, on the owner's computer: Windows 11, DeepSeek Harness `dsh` 0.2.2-rc.1 (`dsh web`), model DeepSeek-V4.1-Flash, Node 24.14.0. Session ids, the board and dsh tokens and folder paths are left out. The questions and answers are synthetic.

## Setup

- A scratch home with its own `progress.md`, set up with `node scripts/setup-codex.mjs --agent deepseek --apply` from this branch. That writes the board script and the `agent-board-local` DeepSeek plugin.
- `dsh web` started in that home; one new session in its page.
- The board started from the same home with its plain command, which opens the page.

## Runs

Each run asked DeepSeek, in its own page, to report a task in `waiting` state with one `[?]` step, stop and wait, and once answered set the task `done` and write one sentence with the answer.

| | Run 1 (11-07) | Run 2 (11-07 to 11-08) |
|---|---|---|
| Question | 要用哪個顏色？藍色或綠色 | 要寫哪種水果？蘋果或香蕉 |
| Card on the board | 自己寫 → 取消 · 傳給 DeepSeek; no Copy, no next-turn line | the same |
| Answer sent | 藍色 | 蘋果 |
| DeepSeek, idle, starts a turn | within seconds | within seconds |
| Its first line | `ACK <nonce>` | `ACK <nonce>` |
| Then | set `done`, ticked both steps, wrote the sentence | the same |
| Board receipt | 已交給此對話，尚未確認回覆。 | the same |

In run 1 the board message showed in DeepSeek's page as text the person seemed to have typed. Run 2 used the change that gives the message its own source: the page shows one folded row, 「收到执行请求」 (dsh's label for a source it does not name). Opened, it says 「这条通知触发了本轮回复。」 above the board's framing and the answer.

## Found and fixed during the run

- **A new question showed the last answer's receipt.** A question card took the receipt of the last message to its session, so run 2's card opened with run 1's 「已交給此對話」 line. A card for a question the board knows now shows only the receipt of the answer sent to that question.
- **An answered question came back to Needs you.** DeepSeek reworded the answered step (`[x] 要用哪個顏色？選了藍色`) and then replaced its block, so the board kept the question as one that left a report unanswered. A kept question whose answer from the board reached its session no longer counts as needing the person.

Test: `after an answer reaches its session, that question leaves Needs you when the agent rewrites its report, and the next question starts with no receipt (#725)`. Before the fix it failed with `[ 'Apple or banana?', 'Blue or green?' ]` where only the first was expected.

## Not covered

- dsh's terminal interface (`dsh` without `web`). It loads the same plugin; not run live.
- A DeepSeek session that stays busy for a long time. A message waits until the session is idle (the tests cover this, the live run did not).
- DeepSeek's reply text does not come back to the board, so the receipt stays at 「已交給此對話」.
- The Older shelf still lists the two answered questions under a heading that calls them unanswered: #1137.
- Linux and macOS.

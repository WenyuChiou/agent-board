# Live run: board message to a `cursor-agent` session, 0.24.3 (#826)

Question: can a message sent from the board's page reach a Cursor CLI session, and does `sessionStart` on resume hand it over?

- **Host:** `cursor-agent` 2026.11.05 (86047df), Windows 11 (build 26300), started from PowerShell, the kept test home (not named here), a scratch project folder.
- **Release:** Agent Board 0.24.3, commit `0bf544022fc991a18fb814cab55e3d28516d8267`.
- **Run by:** Claude Code subagent (Claude Sonnet), 2026-11-10. All times are US Eastern, read from the board's files and the runner's own clock.
- **Press made:** `--trust` for the scratch folder, after the owner's yes (11-10). The trust screen itself was not shown.
- **Command:** interactive `cursor-agent --trust "<synthetic prompt>"`, then `cursor-agent --resume <chat id> -p --trust "<synthetic prompt asking for one word>"`.

## What happened

| Time | Stage |
|---|---|
| 11:31:36 | one hook error logged: `cursor REPORTER_FAILED STALE_TURN` |
| 11:31:41 | the card "Blue or green?" was on the board, about 8 s after the turn |
| 11:41:34 to 11:41:43 | the resume run (`-p`), reply "ok" |

## Result

- **No message could be queued, so there is no delivery.** The card offered `Copy answer` only (no `Queue`, no `Send`), so no message id exists.
- The session record held `UserPromptSubmit`, `StopReport` and `Stop`, and no `SessionStart` event for the fresh chat. The design offers "Queue for when Cursor reopens this chat" only when the turn-start hook (for Cursor, `sessionStart`) made a mailbox; with none, the card falls back to Copy. The cause could not be told from the saved files (no hook log for the run).
- `STALE_TURN` dropped one event and the card still arrived. Whether it is linked to the missing `SessionStart` is a hypothesis, not shown.
- **`sessionStart` on resume could not be observed.** The `-p` resume run changed no session record and logged no hook error, so no hook reached the board from a `-p` resume (related: #1159, Cursor print mode runs no hooks). Whether an interactive resume fires `sessionStart` again was not run, because no second interactive turn could be typed.

Rated: the question reaches the board (PASS); answer from the page is copy only (PASS, extra step); delivery on resume is untested.

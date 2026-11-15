# Codex CLI: Send to Codex on main `f23a910b` with a delivered turn, before the default changes (#318), 2026-11-15

For #318, after #1496 (the receiver stays out of a thread while it waits and starts a turn only while a person's own Codex has it open). This is the run with delivered model turns that docs/MESSAGING.md ("Why it is off by default") asks for. A Claude Code subagent (Claude Opus 5.5) ran it for the maintainer's PM session, on the owner's computer, in the kept test home. Session ids, message ids, ACK codes, tokens and folder paths are left out. All times are US Eastern.

## Verdict

| Case | Result | One line |
|---|---|---|
| 1. Attached, idle | **PASS** (on the second attempt) | The turn started 65 s after the receiver first saw the thread and was acknowledged 56 s after Send. The first attempt ended `uncertain` / `DISCONNECTED` with no turn (see below) |
| 2. Attached, approval answered | **PASS** | The approval showed in the person's client. The page said "Answer in Codex's window." Approving with `y` finished the turn, and the card went to acknowledged 33 s after Send |
| 3. Window closed | **FAIL** against the brief | No turn started, but no message was held either: once the daemon unloaded the thread, the row went `ended` and the card moved to Stopped with no Send. The board refused the message. After `codex resume` the board still did not see the session until the person typed a prompt there |
| 4. Attached, approval not answered | **PASS** | `turn/interrupt` came 120.05 s after the wait began, and the message settled `uncertain` / `APPROVAL_TIMEOUT`. It had one `turn/start`, and nothing was sent twice |

## Setup

- Windows 11 on a busy machine: other programs, none from this run, held the CPU at about 73 to 79 %. Codex CLI 0.167.0 ran as the interactive TUI. The shared daemon was 0.169.0 (`daemon version`: `appServerVersion` 0.169.0, `cliVersion` 0.167.0). It did not update itself during the run. Model: GPT-6.1-Sol (read from the TUI's footer).
- Board: `main` at `f23a910b` (#1496 merged). The checkout's own generated `hooks/board-script.ts` bundle was written to a scratch file and pointed at the test home's `progress.md`. **Two logging lines were added to the scratch copy of the Codex receiver.** Each message from the daemon writes its method, whether it wants an answer, and the status type or flags. Each request the receiver sends writes its method. Times go to a scratch log, with no ids, params or text. Nothing else was changed. The checkout itself was left untouched.
- Page: `--serve --codex-send --no-open`, with its own `XDG_RUNTIME_DIR` (a scratch folder), no `AGENT_BOARD_ROUTES` and no test unload knob. The test home's Codex config sets no `thread_unload_delay_secs`, so the receiver's wait was 65 s. Codex's hooks were the ones already installed in the test home (SessionStart, UserPromptSubmit, PermissionRequest, Stop, Interrupt, SessionEnd, PostToolUse), unchanged.
- The person's client was `codex -s read-only -a on-request "<prompt>"`, and later `codex resume --last -s read-only -a on-request`. It ran in a pseudo-terminal this run started (node-pty with ConPTY), in the test home's scratch project. Keys were sent to that pseudo-terminal only.
- Messages were sent through the page's own HTTP message action, the one the card's Send uses. The token was read from the page's address file in memory and never printed. Card text was read from the page in the desktop app's browser pane, through a one-shot local redirect.
- Approval command: `node -e "require('fs').writeFileSync('<file>','APPROVE-ME')"`. It writes one file in the project folder, so the read-only sandbox asks for approval.
- **Model turns used: 5 of 6.** They were the person's first turn (READY), case 1, case 2, the person's own prompt after the reopen (case 3), and case 4. The failed first attempt at case 1 used none.

## Case 1: attached, idle

### Attempt 1 (no turn)

| Time | Stage |
|---|---|
| 00:36:46 | First client start. It started the daemon itself but gave up at 00:39:12: "app server did not become ready on … (os error 10061)". The daemon came up after that. No turn ran |
| 00:40:03 | Client started again. It joined the running daemon. "READY" at 00:41:57; a hook before the turn showed "Hook failed / hook timed out after 3s". The row was written `state=waiting` |
| 00:43:13 | Page started. The receiver sent `initialize` at 00:43:25 and took its first look (`thread/loaded/list`, `thread/read`, `config/read`) at 00:43:25. The board listed one connection (`Codex daemon`, `session`, `receiving: true`) |
| 00:43:45.48 | Sent "Synthetic test: reply with the word PLAIN-ONE. Run no command and change no file." Store: `queued` |
| ~00:44:0x | Card: "Codex is waiting. It starts on this right away." / "Another message is on its way to this Codex session; send again once it replies." / "Send to Codex" / "Queued" |
| 00:44:31.87 | Claim (66.4 s after the first look) |
| 00:44:31.85 to 00:44:51.67 | **A 19.8 s gap with no request at all from the receiver** (it normally asks every 3 s). The store file was not written during it either |
| 00:44:51.7 | Store: `uncertain`, then `uncertain` / `DISCONNECTED`, both with `updated` at the claim time. No `thread/resume` and no `turn/start` were sent. The saved session shows no new turn |
| 00:48:12 | Card: "Codex is waiting. It starts on this right away." / "Another message is on its way to this Codex session; send again once it replies." / "Send to Codex" / "No reply confirmed. Check the original conversation." |
| 00:48:22 | A second send was refused: "Not sent: another message to this session is still waiting." The `uncertain` / `DISCONNECTED` message counts as open until it expires (`isFinished` in `hooks/messaging.ts`), and a Codex card offers no Dismiss |
| 00:49:08 | Page stopped. Its message store was moved aside (kept), and the page was started again on a fresh store |

### Attempt 2

| Time | Stage |
|---|---|
| 00:49:41.3 | Receiver's first look at the thread (fresh page) |
| 00:49:58.96 | Sent the same text. Store: `queued` |
| 00:50:08 | Card: "Codex is waiting. It starts on this right away." / "Another message is on its way to this Codex session; send again once it replies." / "Send to Codex" / "Queued" |
| 00:50:46.43 | Claim, 65.1 s after the first look and 47.5 s after Send. No turn before it |
| 00:50:49.48 | `thread/resume` (the store wrote the claim at 00:50:49.43) |
| 00:50:50.84 | `turn/start`. Store `accepted` at 00:50:51.41 |
| 00:50:54.34 | `turn/started` heard |
| 00:50:55.12 | `turn/completed` `completed`, then `thread/unsubscribe` 1 ms later. Store `acknowledged`, reply the ACK line |
| 00:52:35 | Card: "Codex is waiting. It starts on this right away." / "Send to Codex" / "Archive" / "Replied" |

Send to receipt: **56.2 s**. The person's client showed the board's delivery text as a new prompt (header, "If you have already answered message …", the ACK line, the framed text). The model replied "ACK <code>" and then "PLAIN-ONE" ("Worked for 3s").

## Case 2: attached, approval answered

| Time | Stage |
|---|---|
| 00:52:44.22 | Sent the approval message (file `approval-live318-2.txt`, then "reply with exactly DONE-TWO"). The receiver's last leave was at 00:50:55, 109 s before, so it did not wait again |
| 00:52:44.39 to .43 | Claim, then `thread/resume`, `turn/start`, `accepted` |
| (model) | The ACK line came first, as the delivery text asks |
| 00:52:58.86 | `thread/status/changed` active `["waitingOnApproval"]` and `item/commandExecution/requestApproval` (wants an answer) reached the board's connection. The receiver did not answer |
| 00:52:59.9 | The person's client showed "Would you like to run the following command?" with a reason ("… The workspace is read-only, so this write requires approval."), the command, and "1. Yes, proceed (y) / 2. Yes, and don't ask again … (p) / 3. No, and tell Codex what to do differently (esc)" |
| 00:53:0x | Page, under Needs you: "Codex asks to run a command" / "Answer in Codex's window." / "Already answered, hide" / "Waiting for a reply" |
| 00:53:12.01 | `y` sent to the person's client, 13 s after the prompt |
| 00:53:12.25 | `serverRequest/resolved` on the board's connection. The command ran, and the file holds `APPROVE-ME` |
| 00:53:16.95 | `turn/completed` `completed`, `thread/unsubscribe`, store `acknowledged`. The client showed "You approved codex to run … this time", "DONE-TWO" and "Worked for 32s" |
| 00:53:40 | Card: "1 step done" … "Codex is waiting. It starts on this right away." / "Send to Codex" / "Archive" / "Replied" |

Send to receipt: **32.7 s**, 13 s of it waiting for the person.

## Case 3: window closed

| Time | Stage |
|---|---|
| 00:53:49.55 | `/quit` typed into the client |
| ~00:53:50 | **The window was closed hard, not by `/quit`.** The run's own key-sending helper crashed on a bad key file before it sent the Enter. The pseudo-terminal ended with it, and the TUI process with that (it was gone at 00:54:06). This counts as a closed terminal window, not a clean quit |
| 00:54:52.56 | The receiver heard `thread/status/changed` `notLoaded` and `thread/closed`, which the daemon sends to every connection. That was 62 s after the close and 96 s after the receiver's own leave. In the same second the Codex row in `progress.md` became `state=ended`: the daemon ran the session's SessionEnd hook when it unloaded the thread |
| 00:55:03 | Board: no connection and no session for Codex |
| 00:55:35 | Page: the card had moved to **Stopped**: "scratch-project / 1/2 / Stopped at: Waiting for the next instruction / just now / 1 step done / Waiting for the next instruction / Copy resume command / Archive / Confirm done / Replied". No Send control and no line about opening Codex. Row data: `rowState` ended, status "session ended, can be taken over", send `none`, `canSend: false` |
| 00:56:20 | The page's message action, tried on that row with "reply with the word HELD-THREE": "Could not send. It may be offline; copy this and paste it there." The store was unchanged, so **nothing was held** |
| 00:56:31 | Reopened with `codex resume --last -s read-only -a on-request`. An update notice (0.167.0 to 0.169.0) was skipped with Esc at 00:57:01; nothing was installed. The same thread opened: the transcript showed PLAIN-ONE and DONE-TWO |
| 00:57:03 | The daemon loaded the thread. The receiver heard status `idle` and `thread/goal/cleared` |
| 00:57:25 to 00:58:31 | The row stayed `state=ended`, the board had no connection for the session, and the card stayed under Stopped with "Copy resume command". **No delivery after the reopen**, since no message had been held. The receiver asked only `thread/loaded/list` and did not read the thread |
| 00:58:41 | The person typed a prompt in the reopened client ("reply with exactly BACK"; model turn 4, 4 s). The row went back to `state=waiting` at 00:58:46, and the receiver registered again (`connected`, `receiving`) by 00:59:02 |

No turn started while the window was closed. The saved session still held its 3 turns, and the receiver sent no `thread/resume` or `turn/start` after 00:53:17. The other three expectations were not met: the message was not held, no card line said to open Codex, and nothing was delivered after the reopen. In this test home the daemon's SessionEnd hook ends the row when it unloads the thread. A resume with no prompt runs no hook that brings the row back, so the person must type in Codex before the board can reach the session again.

## Case 4: attached, approval not answered

| Time | Stage |
|---|---|
| 00:58:46.4 | The person's own turn ended, and the receiver's quiet stretch began with its next idle read |
| 00:59:11.12 | Sent the approval message (file `approval-live318-4.txt`, then "DONE-FOUR"). Store: `queued` |
| 00:59:16 | Card: "Codex is waiting. It starts on this right away." / "Another message is on its way to this Codex session; send again once it replies." / "Send to Codex" / "Queued" |
| 00:59:52.34 | Claim, about 65 s after the person's turn ended. `turn/start` at 00:59:52.37, `accepted` at 00:59:52.38. The ACK line came first |
| 00:59:59.56 | `waitingOnApproval` and `requestApproval` on the board's connection. The person's client showed the same prompt for the new file |
| 01:00:18 | Page, under Needs you: "Codex asks to run a command" / "Answer in Codex's window." / "Already answered, hide" / "Waiting for a reply". Nothing was pressed in the client |
| 01:01:59.61 | **`turn/interrupt`, 120.05 s after the wait began.** Store: `uncertain` / `APPROVAL_TIMEOUT` (01:01:59.607) |
| 01:02:00.88 | `turn/completed` `interrupted`, then `serverRequest/resolved`. `thread/unsubscribe` at 01:02:02.72 |
| after | The client showed "Exited (status 1) node -e …" and "Conversation interrupted - use /feedback if something went wrong". The file was not created |
| 01:02:25 | Card: "Codex is waiting. It starts on this right away." / "Another message is on its way to this Codex session; send again once it replies." / "Send to Codex" / "Archive" / "Delivered. Reply not confirmed." |
| 01:02:33 | A new send was refused: "Not sent: another message to this session is still waiting." |

The message was sent once. Over the whole run the receiver sent `turn/start` 3 times, once for each delivered message (attempt 1 sent none). The saved session holds 5 turn starts, 4 completions and 1 abort.

## Also seen

- **The `uncertain` end blocks the next send while the card still offers it (#1486).** After `DISCONNECTED` (case 1, attempt 1) and after `APPROVAL_TIMEOUT` (case 4), the card kept "Codex is waiting. It starts on this right away." and "Send to Codex", plus "Another message is on its way…". Each send was refused with "Not sent: another message to this session is still waiting." The message stays open until the board's 30-minute expiry, and a Codex card offers no Dismiss.
- **The card promises too much during the watch.** For the first 65 s, and while a message is held, the card reads "Codex is waiting. It starts on this right away.", and the board shows the session `receiving: true`.
- Card wording: while a message was `queued`, the card showed "Another message is on its way to this Codex session; send again once it replies." about that same message.
- While the delivered turn waited on its approval, "Working now" read "No agent has done anything in the last 30 minutes."
- The first client start gave up because the daemon it started was slow to become ready. A hook before the first turn timed out after 3 s. The machine was busy throughout.

## Not known

- **The cause of attempt 1's 19.8 s gap.** Right after the claim the page made no daemon request and wrote no store change, then settled `DISCONNECTED`. It did not happen again in three later deliveries. Whether a busy machine or something in the claim path stalls the page's event loop was not looked into. Several shorter gaps of about 3 s in the receiver's requests were seen around the deliveries.
- **A clean quit for case 3.** The window was closed hard (its pseudo-terminal ended). After a clean `/quit`, the unload 60 s later and the SessionEnd hook ending the row are likely the same, but this run does not show that.
- **The window after the person quits.** The receiver's wait runs from its own leave (00:53:17 here), not from the person's quit. From about 00:54:22 until the unload at 00:54:52, the receiver would have read the thread as attached with nobody on it. No message was sent in that 30 s, so whether a turn starts there (with the 120 s limit as the backstop) is not shown.
- **The held path in the brief** (a session the board knows, its thread unloaded, the message held with a card line to open Codex, delivery after the reopen) was not reachable here: the SessionEnd hook ends the row when the thread unloads. A setup without that hook, or one whose resume runs a hook, was not run.
- The Codex desktop app, Linux and macOS, a page started by `/agent-board` or the npm command, other approval kinds, and a hard kill of the real proxy.

## Housekeeping

- Stopped: the three client runs (the first exited by itself, the second ended with its pseudo-terminal, the third quit with `/quit`, exit 0); the page, both times with `--stop` (its `codex app-server proxy` ended with it); the daemon this run started (`daemon stop`, then its leftover `pid-update-loop` by hand, as on 11-13 and 11-14); the store watcher, the redirect and the browser pane tab. A process check after the stop showed none of them running. A board page in another scratch home, not started by this run, was left alone.
- Created or changed in the test home, all left in place: one new saved Codex session (one thread with 5 turns), lines in `history.jsonl` and `session_index.jsonl`, Codex's own state and log databases and model cache, `approval-live318-2.txt` (10 bytes) in the scratch project, the Codex row in `progress.md` and the board's question files (written by the hooks and the page). Codex's `config.toml`, `hooks.json` and sign-in file were not changed (mtimes from 11-06). Nothing was installed, nothing was signed in, and nothing was posted, committed or pushed.

## After this run

- #1486 (a timed-out message kept the card from sending again) was fixed by #1493, and #1506 (the card promised a start while the receiver held the message) by #1509. Both had held the default.
- The owner turned the default on, 2026-11-15, with #1504, #1505 and #1507 still open, and #1516, which the case table for that change found (the pull request that changed the default, for #318).

# Send to Claude: live check with a real model

Date: 2026-11-16. Follows `2026-11-03-send-to-claude.md`, which used a stand-in model API. Part of #316 and #1334.

## Question

- On the 0.25.0 candidate, does a message typed on a Claude card of the board page and sent with the card's own button reach an interactive Claude Code session, with a real model answering it?
- Does the reply start with the ACK line, and does the card show the acknowledged state?
- Does a board delivery stay out of the person's answer to an open question (#1334, for Claude)?

## Host

- Windows 11 Home, Node 24.14.0.
- Claude Code 2.1.322 in a terminal, signed in with a claude.ai account in the kept test home. Model: Haiku 5.5, picked with `--model haiku` to keep the cost small. The account showed 91% of its weekly limit, so Fable was not used.
- Candidate: the checkout at main `453df363` (docs branch for this record). `package.json` is not version-bumped, so the page footer reads v0.24.3.
- Merged after `453df363` and before the 0.25.0 release branch (`ca75f8ab`): #1521, #1567, #1568, #1569 and #1573. None of them changes `hooks/receiver.ts` or a messaging file. #1521 changes the pane's check of a press on a stale choice, #1569 how the page treats retired pages, #1573 the hooks generated for other agents; #1567 and #1568 change only contributor scripts.
- Run by a Claude Code subagent for the PM session, 2026-11-16, 01:54 to 02:05 US Eastern, and a second run at about 07:38 US Eastern. Session ids, message ids, ACK codes, tokens and folder paths are left out.

## Setup

- The kept test home, with its own sign-in and its scratch project. Every variable of the isolation list pointed into it. `CLAUDE_CODE_*` and `ANTHROPIC_*` were cleared, then `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` was set again for the session (the card only exists once the session has a task).
- **Board page:** the checkout's own generated board script (`BOARD_SCRIPT`) was written to a scratch file and started with `--serve --no-open --lang en` on the kept home's `progress.md`. The command `agent-board` was not used: its first try ran the kept home's installed 0.24.3 script, so that page was stopped and not used. No `XDG_RUNTIME_DIR`, no route override, no test knob.
- **Claude Code:** `claude --plugin-dir <the checkout> --model haiku`, started in a pseudo console (node-pty with ConPTY, 140 by 45) this run created. Keys went to that console only; the screen was read back through a terminal emulator. In the first run the installed 0.24.3 plugin was also enabled in the kept home, and nothing in the card or the screen showed which copy of the mod answered. A second run (below, "Second run: candidate only") closed that gap.
- **Page:** opened in the desktop app's built-in browser pane. Each board message was typed into the card's own box and sent with its own "Send to Claude" button. In case 4 the button was pressed by a one-line script click 1.5 s after the person's turn started, as a real click took too long to be inside a turn of 3 s. A first real click on the button in case 2 missed (the tool clicked outside the window) and sent nothing.
- Card text was logged every 100 ms by a script in the page.
- Synthetic prompts only. The person's turns were typed into the Claude window: "reply READY", create one task named "Send test", write the numbers 1 to 120 in words, end with a question, and an answer to it.
- **Model turns used: about 12.** Nine were in the recorded session (task, A, two refused attempts to make a long turn, the numbers, B, the question, C, the answer). About three more came from the false starts below.
- False starts, none sent anything to a board card: Fable started by default (closed before any turn); a session without the task switch showed no card (a "READY" turn); one typed command went in with a half-typed second one and made a wasted turn.

## Run

Times are US Eastern. The page poll is 100 ms; the receiver polls about every 2 s.

### Case 1. Binding
| Time | Stage | Evidence |
|---|---|---|
| 01:59 | session ran its first turn: one task "Send test", then READY | the status line in Claude read `agent-board: ... 0/1`; the "Agents" list on the page read "Claude Code · open" |
| 01:59:48 | the card | "Claude is waiting. It starts on this right away." with a box "What to tell Claude Code…" and the button "Send to Claude" |

### Case 2. Idle session
| Time | Stage | Evidence |
|---|---|---|
| 02:00:14.5 | message A sent from the card | card: "Claude is working. It gets this when this step ends." with Take back (queued) |
| 02:00:16.6 | taken | "Delivered. Waiting for Claude's reply." with Dismiss |
| 02:00:18.6 | acknowledged | "Claude got this." (about 4 s from the press) |

Nobody typed in Claude. Claude's window showed "Prompt from the agent-board plugin", then the framed message ("sent from the board page on this computer (not typed in this window)", the ACK instruction, the text in a marked block). The model's reply began with `ACK <code>` alone on the first line, then `PONG-A`. The same shape repeated for B and C.

### Case 3. Where the reply went
After A, B and C, a search of the kept home's board folder and the hub's folder found no `PONG-A`, `PONG-B`, `PONG-C` and none of the three messages' text. Only Claude's own conversation file holds them. The card showed "Claude got this." and no reply text.

### Case 4. Busy session
The person's turn was "write the numbers 1 to 120 in words" (a turn of about 3 s).
| Time | Stage | Evidence |
|---|---|---|
| 02:01:47 | person's turn started | |
| 02:01:48.1 | card | "Claude is working. It gets this when this step ends." |
| 02:01:48.6 | message B pressed | "Claude is working. It gets this when this step ends." with Take back (queued) |
| 02:01:50.8 | the turn ended | card back to "Claude is waiting..." with the message still queued |
| 02:01:52.8 | delivered | "Delivered. Waiting for Claude's reply." |
| 02:01:54.9 | acknowledged | "Claude got this." |

Claude's conversation file holds B once. No message went in during the person's turn.

### Case 5. A question is open (#1334)
| Time | Stage | Evidence |
|---|---|---|
| 02:02:39 | person's turn: end on the question "Port 3000 or 8080?" | the status line read "1 件等你"; the page's "Needs you" count went to 1 and the tab title to "(1) Needs you"; the card showed the question with "Port 3000", "8080", "More", "Write your own" |
| 02:03:15 | "Write your own" opened; message C typed there and sent with its "Send to Claude" button | the model answered `ACK <code>`, `PONG-C` in Claude |
| 02:03:17 to 02:03:20 | during that turn | the tab title read "Agent Board" and Needs you read 0 for about 3 s |
| 02:03:20 onward | after the turn | Needs you back at 1, tab title "(1) Needs you", the same question still on its card. "Port 3000" and "8080" were gone, with "Claude got this." and a button "Already answered, hide" |
| 02:03:38 | the person typed "Port 3000..." in the Claude window | Needs you went to 0 by 02:03:48 |

### Case 6. Closed session
| Time | Stage | Evidence |
|---|---|---|
| 02:03:54 | `/exit` typed in Claude | the process exited at 02:03:56 |
| 02:03:59 | the card | moved to "Stopped", no box and no "Send to Claude"; buttons "Copy answer", "Copy resume command", "Archive", "Confirm done" |

## Results

| Case | Result | Evidence |
|---|---|---|
| 1. Binding | PASS | The card showed "Claude is waiting. It starts on this right away." with a Send box, and the agents list "Claude Code · open", after the session's first task. A session with no task has no card. |
| 2. Idle | PASS | A board message started a turn with nobody typing. The reply started with the ACK line. The card showed "Claude got this." about 4 s after the press (4.1 s, 2.0 s of it before delivery). Real model. |
| 3. Reply body | PASS | No reply text in the hub's folder or the board folder; the card shows no reply text. |
| 4. Busy | PASS | The message stayed queued with "It gets this when this step ends" and Take back through the person's turn; it was delivered once after the turn ended (2.0 s later) and acknowledged 2.1 s after that. |
| 5. #1334 | PASS | The board delivery did not close the question: Needs you came back to 1 with the same question. Only the person's own typed answer in Claude cleared it. Two things the person would see: the answer buttons were replaced by "Already answered, hide" after C, and Needs you read 0 for about 3 s during the delivery turn. |
| 6. Closed | PASS | After `/exit` the card lost its box and button and offered Copy answer and Copy resume command. |

## Second run: candidate only

Done after the first run, at the PM's request, to show which copy of the mod answered.

- **Disabled:** in the kept test home only, `claude plugin disable` on the installed agent-board plugin (user scope). `claude plugin list` there then read "Version: 0.24.3 ... Status: disabled" for it. A copy of the home's `settings.json` was saved first.
- **Run:** a new page (the checkout's board script, `--lang en`) and `claude --plugin-dir <the checkout> --model haiku`, the same setup as the first run. The button was pressed with a real click each time.
- **Restored:** `claude plugin enable` on it, then `claude plugin list` read "Status: enabled" again. The home's `settings.json` is byte-identical to the saved copy (same checksum). The saved copy stays in the home.
- **Model turns used: 4** (the task, A2, the question, C2).

| Case | Result | Evidence |
|---|---|---|
| 1. Binding | PASS | The card read "Claude is waiting. It starts on this right away." with a Send box after the session's first task. |
| 2. Idle | PASS | Message pressed at 07:38:25; queued at once, delivered 07:38:27, "Claude got this." at 07:38:29 (about 4 s). The reply began with the ACK line and `PONG-A2`. |
| 5. Text check | PASS | The question stayed open after a board message (Needs you stayed at 1). After the delivery turn the answer buttons were replaced by "Already answered, hide", the same as with both copies loaded. |

Times are US Eastern.

With the installed plugin disabled, the status line, the card, the delivery text and the receiver all behaved as in the first run, so the candidate's own mod was the one that ran. The Chinese line "你已回覆，等 Claude 處理" was not reproduced here (it needs the person's typed answer, which cost another turn); its text is in the checkout's own source, so it is not from the installed copy. The "Already answered, hide" buttons look the same with only the candidate loaded.

## Findings

- **The card text after a delivery turn on a question.** The question card lost "Port 3000", "8080" and "Write your own" after message C, and offered "Already answered, hide", while the question was still open (case 5). A person could read that as an answer having been recorded. Not read through to its cause. Whether the buttons should stay is for the PM. Issue #1579.
- **Needs you flickers to 0 for about 3 s** during that delivery turn (a working turn hides the question). It came back. Same issue, #1579.
- **A Chinese string on an English page.** After the person's answer the card read "Send test — 你已回覆，等 Claude 處理" (the page ran `--lang en`). The mod writes that line into the task block from the system's language, not the page's. Issue #1580.
- **The closed card has no sentence.** The 11-03 run saw "Claude isn't connected to this board. Copy this and paste it there." after the person pressed Send on a disconnected card. Here the box was already gone, so no sentence showed; Copy was the only offer. Not a fail.
- **A first real click on the button missed** (the pane tool's click on an element reference landed outside the window). It sent nothing. A tool problem, not the product.

## Not run

- **Esc, "Take back" and `/clear`.** The 11-03 record covers them with a stand-in; not repeated here (turn budget).
- **A longer turn than 3 s.** Haiku refused a standalone `sleep` and a node pause, so the busy case ran on a 3 s turn.
- **The Chinese line with only the candidate loaded.** Not reproduced in the second run (turn budget); only its presence in the checkout's source is shown.
- **A model other than Haiku 5.5.**
- **Desktop app, macOS, Linux and a real mouse press on the button in case 4.**
- **Counting exact model turns from the account's usage.** The count above is from conversation files and the log of this run.

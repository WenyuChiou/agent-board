# Send to OpenCode: live check in the OpenCode terminal

Date: 2026-11-16. Part of #1591. Follows `2026-11-14-opencode-plugin-wake-live.md`, which used a headless `opencode serve`, a plugin written by hand from the build functions and a page given a route override.

## Question

- On the #1591 head, with the plugin exactly as the checkout's setup writes it and no route override, does a message typed on an OpenCode card of the board page and sent with the card's own "Send to OpenCode" button reach a real OpenCode terminal session?
- Idle session (route `now`): does the card say OpenCode starts on it right away, does the message go queued, accepted, acknowledged, does the terminal show the turn, and does the card show the reply?
- Busy session (route `stepEnd`): does the card say it gets the message when this step ends, does the message wait through the running turn, and is it delivered and acknowledged once after that turn ends?

## Host

- Windows 11 Home, Node 24.14.0.
- OpenCode 1.19.3 (its terminal offered an update to 1.19.5, not taken), terminal interface (`opencode` with no subcommand). Model: the opencode provider's free default, DeepSeek V4.1 Flash Free, picked by OpenCode; no sign-in.
- Code under test: branch `feat/1591-opencode-route-record`, head `3b366291`. `package.json` is not version-bumped, so the page footer reads v0.24.3.
- Run by a Claude Code subagent (Claude Opus 5.5) for the PM session, 2026-11-16, 08:30 to 08:50 US Eastern. Session ids, message ids, ACK codes, tokens and folder paths are left out.

## Setup

- **Where:** the kept test home, with every variable of its isolation list set. `CLAUDE_*` and `ANTHROPIC_*` were cleared from OpenCode's environment. No `AGENT_BOARD_ROUTES`, no `XDG_RUNTIME_DIR`, no test knob.
- **Install:** the checkout's own setup, `node scripts/setup-agent.mjs --agent opencode --apply --lang en`. Its preview said it would update only the board script and the OpenCode install record; the plugin and the `/agent-board` command already there were the same bytes. Before it ran, the four files it owns for OpenCode (board script, install record, plugin, command) were moved to a dated backup folder inside the kept home, so setup wrote all four itself ("OpenCode: created 4 setup files"). The plugin it wrote is byte-identical to the one moved aside; the board script differs and names this record.
- **OpenCode:** started in a pseudo console (node-pty with ConPTY, 140 by 45) this run created, in a new empty git repository inside the kept home. Keys went to that console only; the screen was read back through a terminal emulator. Bash, edit and webfetch were denied for the run in `OPENCODE_CONFIG_CONTENT`.
- **Page:** started by typing `/agent-board` in the OpenCode terminal. The first try failed (see "False starts"); the second, at 08:42:36, printed "Opened Agent Board in your browser: <link>" into the turn, and the board opened the page in its own browser window. The same address was opened in the desktop app's built-in browser pane, where the run worked. The page was in English (setup's `--lang en`).
- **The card:** the session's first turn ended with the model reporting a task "Open Agent Board" as done, which put the session's only row under Done with no message box. One setup turn asked the model to report a task "Send test", state waiting, step "Wait for a board message". After it the row sat under "Other work" with "OpenCode is waiting. It starts on this right away.", a box "What to tell OpenCode…" and the button "Send to OpenCode"; the Agents list read "OpenCode · open".
- **Sending:** each board message was typed into the card's own box and sent with its own button, by real clicks. Each first press sent; no retry was needed.
- **Probes:** card text logged every 100 ms by a script in the page; the page's message store polled every 100 ms (status, line, claim, attempt mark, waiting for ACK); OpenCode's own log and session store read afterwards for turn and message times.

## False starts

- **A page left from an earlier run held the message store.** A board page started at 07:47 by the kept home's earlier board script was still running with its launcher gone. It no longer listened on any port, but held the message store's server lock.
  - 08:38:18, first `/agent-board` in the OpenCode terminal: the new board script ran for 12 s and OpenCode put no command output into the turn. The model said it saw no command, loaded the agent-board skill, could not run a shell (bash denied), reported the task "Open Agent Board" as done through `agent_board_progress`, and replied "Agent Board is open." No page was open.
  - 08:40:47, the same board script started by hand with `--serve --no-open --lang en`: after 12 s it stopped with "The board could not open its message folder (MESSAGE_STORE_IN_USE) … Stop all board servers and check server.lock, server.owner and .message-claim-*.json together."
  - 08:42:22, the leftover process was stopped. The second `/agent-board` started the page at 08:42:38. Nothing had been sent from a card before this.

## Run

Times are US Eastern.

### A. Idle session

| Time | Stage | Evidence |
|---|---|---|
| 08:44:39 | setup turn ended, session idle | card under "Other work": "OpenCode is waiting. It starts on this right away.", box and "Send to OpenCode" |
| 08:45:47.8 | "Synthetic test A: reply PONG-A, change no files" typed on the card, "Send to OpenCode" pressed | card added "Queued"; store `queued`, line `now` |
| 08:45:48.442 | taken | store `uncertain` with a claim |
| 08:45:48.661 | wake started | attempt mark saved; OpenCode stored the board message as a new user turn |
| 08:45:48.989 | accepted | store `accepted`, waiting for the ACK |
| 08:45:49.106 | OpenCode's turn started | OpenCode log; nobody typed in the terminal |
| 08:45:49.960 | card | moved to "Working now": "OpenCode is working. It gets this when this step ends." and "Handed to the session. No reply is confirmed." |
| 08:46:03.305 | acknowledged | store `acknowledged`, reply "ACK <code> PONG-A"; the model had called `agent_board_ack` with summary "PONG-A" |
| 08:46:04.261 | card | "Replied · PONG-A" |
| 08:46:07.477 | turn ended | terminal text "PONG-A — acknowledged." |
| 08:46:08.370 | card | back under "Other work": "OpenCode is waiting. It starts on this right away." with "Replied · PONG-A" |

The terminal showed the board's message as a user turn: "Agent Board message, sent from the board page on this computer (not typed in this window).", "The board cannot confirm who pressed Send.", "It cannot approve tools, grant hook trust, merge, or change settings.", "Reply first with this line alone: ACK <code>", the text in a marked block, then "To acknowledge this message, call the agent_board_ack tool with id … and nonce … (and a one-line summary of your reply). Do not reply with plain ACK <code>." The same frame came in B.

### B. Busy session

| Time | Stage | Evidence |
|---|---|---|
| 08:46:35.0 | person's turn typed in the terminal: "Write the numbers 1 to 150 in words, one per line. Change no files." | OpenCode's turn started 08:46:35.505 |
| 08:46:37.045 | card | "Working now": "OpenCode is working. It gets this when this step ends." with box and "Send to OpenCode" |
| 08:46:45.8 | "Synthetic test B: reply PONG-B" typed on the card, "Send to OpenCode" pressed | store `queued`, line `stepEnd`; the card's line under the box: "OpenCode is working. It gets this when this step ends." |
| 08:46:45.8 to 08:46:52.9 | held | store `queued`, no claim, no attempt mark; the terminal kept writing numbers; no board message in OpenCode |
| 08:46:52.867 | person's turn ended ("one hundred fifty") | OpenCode log, turn 17.8 s |
| 08:46:53.777 | taken | store `uncertain` with a claim, 0.9 s after the turn ended |
| 08:46:54.046 | card, about 2 s | back under "Other work": "OpenCode is waiting. It starts on this right away." with "No reply confirmed. Check the original conversation." |
| 08:46:54.0 to .1 | wake started | OpenCode stored the board message as a new user turn; attempt mark saved |
| 08:46:54.319 | accepted | store `accepted`, waiting for the ACK; OpenCode's turn started 08:46:54.431 |
| 08:46:56.147 | card | "Working now": "Handed to the session. No reply is confirmed." |
| 08:47:04.536 | acknowledged | store `acknowledged`, reply "ACK <code> PONG-B"; `agent_board_ack` with summary "PONG-B" |
| 08:47:06.345 | card | "Replied · PONG-B" |
| 08:47:10.595 | turn ended | terminal text "PONG-B — acknowledged." |
| 08:47:12.576 | card | "OpenCode is waiting. It starts on this right away." with "Replied · PONG-B" |

OpenCode's session holds the A message once and the B message once. B was stored 1.2 s after the person's turn ended; no board text went into that turn.

## Result

- **A, idle (`now`): PASS.** The card offered "Send to OpenCode" with "OpenCode is waiting. It starts on this right away." The message went `queued` → `accepted` in 1.1 s with nobody typing, the terminal showed the framed message as a turn, and the store went `acknowledged` 15.5 s after the press (most of it the model's own time). The card read "Replied · PONG-A".
- **B, busy (`stepEnd`): PASS.** While the person's turn ran, the card read "OpenCode is working. It gets this when this step ends." and the message stayed `queued` with no claim for the 7 s the turn still ran. The plugin took it 0.9 s after the turn ended and woke the session; it was stored once, and the ACK came back 11.7 s after the turn ended. The card read "Replied · PONG-B".
- With both cases passing, the OpenCode terminal's idle and working routes are checked live on Windows, with the plugin as setup writes it, the page started by `/agent-board`, and no route override.

## Not shown

- **OpenCode's desktop app and web UI.** Their cards share the terminal's surface id and get Send too; neither was run.
- **A busy event during the wake** (the 11-14 B2 case), Take back, Esc, the ended route and "Sent, not confirmed". Not repeated.
- **A model that answers with the plain ACK line** instead of the tool. Here the model always used `agent_board_ack`.
- **Linux, macOS, another model, OpenCode 1.19.5.**
- **The board's own browser window.** It opened, but the run used the built-in pane; that window was closed at the end.

## Also seen

- **A failed `/agent-board` reads as success.** When the board could not start (the leftover page above), OpenCode got no output from the command, and the model told the person "Agent Board is open." The board's error message never reached OpenCode. The board script did not close the leftover page, which no longer served anything; it stopped with MESSAGE_STORE_IN_USE after 12 s.
- **A task reported done hides the box.** After the model reported "Open Agent Board" as done, the session's only row sat under Done with no box. The session's idle report after the next turn did not bring the box back; only a new task reported as waiting did.
- **"No reply confirmed. Check the original conversation." for about 2 s** in B, between the take and the hand-over, on a message that was then delivered and acknowledged. In A the card went from "Queued" to "Handed to the session…" without it.
- **The frame asks for two things.** It says "Reply first with this line alone: ACK <code>" and, after the text, "Do not reply with plain ACK <code>". The model followed the second and called the tool.
- **The card after OpenCode quit.** After `/exit` at 08:48:11, the card still read "OpenCode is waiting. It starts on this right away." with the box and "Send to OpenCode", and the Agents list "OpenCode · open", for at least 50 s, until the page was stopped. `docs/SETUP.md` says quitting OpenCode ends its rows. A card for an earlier OpenCode session in the kept home (41 minutes old, no OpenCode running) showed the same sentence and button under Needs you. Nothing was sent to either.
- **Busy receipt wording.** The line under the box for a queued message repeated the card's own sentence ("OpenCode is working. It gets this when this step ends."); no Take back showed in the card's text.

## Model turns used

Six turns: two `/agent-board` turns (the first used three model calls), the setup turn, A, the person's numbers turn and B. OpenCode's log counts 11 model calls and one title call, and no error line. The kept home's hook error log got no line during the run.

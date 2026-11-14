# Codex CLI: a board message starts a turn in an idle session on the shared daemon, 2026-11-13

For #318 (Send to Codex), PR #1306. Run by a Claude Code subagent (Claude Opus 5.5) for the maintainer's PM session, on the owner's computer, in a separate test home: Windows 11, Codex CLI 0.167.0, the interactive TUI, model GPT-6.1-Sol. The shared daemon was 0.167.0 when the run began and updated itself to 0.168.0 during the run (below). Board: PR #1306 at `27c75a6b`, the bundled board script from that checkout written to a scratch file and pointed at the test home's `progress.md`. Codex's hooks were the ones already installed in the test home, unchanged. Session ids, message ids, ACK codes, tokens and folder paths are left out. Times are US Eastern.

## Question

Does a message sent from the board's page start a turn in an idle Codex CLI session, with nobody typing in the Codex window? A message that waits until the person types in the Codex window again does not pass.

## The live-check switch and the second page

- **Route.** The real records give the `Codex daemon` route no record, so a Codex card offers Copy and the hub refuses the send (`NO_RECORDED_ROUTE`). As in the 2026-11-12 run, the board page alone was started with `AGENT_BOARD_ROUTES` naming a file that holds the build's own routes with only Codex's live route opened (idle `now`, working `stepEnd`, surface `Codex daemon`, record "live check (not recorded yet)"). Codex, its hooks and the person's environment did not get the variable.
- **Runtime folder.** Another board page, started earlier by someone else from the test home's installed board, was already serving the same `progress.md`. A plain `--serve` from a different build closes such a page. So the #1306 page was given its own `XDG_RUNTIME_DIR` (a scratch folder), which keeps its address file and message store apart. Both pages read the same `progress.md`. Codex's own hooks kept finding the other page, so the #1306 page's only Codex connection was its daemon receiver. The other page was not touched.

## Run

1. Daemon check. No daemon was running (`codex app-server daemon version`: connection refused). A plain `codex` (no options, no prompt) was started.
2. The #1306 page: `agent-board.mjs --serve --codex-send --no-open` (from the scratch copy of the #1306 bundle, with the switch and the runtime folder above). It was opened in the desktop app's browser pane.
3. Turn 1, in a new terminal tab: `codex -s read-only -a never "Synthetic test: ask me exactly one question, Blue or green?, and stop. Change no file."` The prompt went in as an argument because the test could not type into a running TUI.
4. On the page: the Codex filter, the session's card, Blue, then the card's send arrow. After that, nothing was typed in the Codex window. Its screen was read, and the page and its message store were watched for over 60 seconds.
5. The Codex window, the page and the daemon were stopped.

| Time | Stage |
|---|---|
| 01:43 | No daemon running |
| 01:44:37 | Plain `codex` started. Within a second it started the shared daemon itself (`app-server --managed-daemon` and a `pid-update-loop` process). An update prompt (0.167.0 to 0.167.2) showed first and was dismissed with Ctrl-C |
| 01:45:15 | That window's new thread was created on the daemon (Codex's log: `thread/start` over the unix socket) and `thread/loaded/list` listed it. No manual daemon start was needed |
| 01:45:33 | That window closed: "Disconnected from this task. Any running work continues." The daemon unloaded the empty thread 60 s later ("no subscribers and is idle") |
| 01:46:39 | #1306 page started with `--codex-send`. Its receiver started `codex app-server proxy` at once |
| 01:47:23 | A first turn-1 attempt with an extra `-c check_for_update_on_startup=false` ran **in-process**, not on the daemon (Codex's log: `rpc.transport="in-process"`). Its thread never appeared in `thread/loaded/list`, so the board could not reach it. This used one model turn; the window was closed at 01:48 |
| 01:50:18 | The daemon updated itself to 0.168.0: its update loop restarted it from a newly downloaded package. The receiver's proxy dropped and was started again by the receiver at 01:50:28 |
| 01:53 | Probe without a prompt: `codex -s read-only -a never` joined the daemon (unix socket). Closed at 01:53:56 without a turn |
| 01:54 | Turn 1 on the daemon (step 3): "Blue or green?" (5 s). Codex's hook wrote the row (`state=waiting`) at 01:54:15 |
| 01:55:13 | The card, under Needs you: "Codex is waiting. It starts on this right away." Buttons: Blue, green, More, Write your own, and a send arrow. The board listed one connection for the thread: surface `Codex daemon`, scope `session` |
| 01:55:28 | Blue picked, send arrow pressed on the page |
| 01:55:29 | The store marked the message claimed. The Codex window showed the board's delivery text as a new prompt: the header, "If you have already answered message …, reply only ACK … and do nothing else.", the ACK line and the framed "Blue". The model replied with the `ACK <code>` line alone ("Worked for 3s") |
| 01:55:32 | Codex's Stop hook set the row back to `waiting`; the question step was ticked |
| 01:55:33 | The store: `acknowledged`, reply the ACK line, line `now`, turn `session`, one hop |
| to 01:56:40 | Nothing more in the Codex window: no second turn, and no key pressed there between turn 1 and the stop at 01:57 |

## Result

**PASS.** A message sent from the board's page, while an interactive Codex CLI session on the shared daemon sat idle, started that session's turn within about one second. Nobody typed in the Codex window. The model answered with the board's ACK line, and the board recorded `acknowledged` once the turn ended `completed`.

Under these conditions:
- The page ran with the live-check route switch. The build as it is offers Copy on this card (`NO_RECORDED_ROUTE`) until a record exists for the route.
- Codex was started without a `-c` option. A `-c` option made the TUI run in-process, off the daemon, where the board cannot reach it.

## Not shown

- What the model did with "Blue": the reply was the ACK line alone. With nothing to do, that may be complete, but the run does not show whether the model read "Blue" as the answer. In the 2026-11-12 mailbox run the model wrote "Blue selected." after its ACK; that delivery had no "already answered" line.
- The receipt words on the session's row: the page's data for the row read `acknowledged` ("just now") and "Codex is waiting. It starts on this right away.", but the row's visible receipt text was not read before the page stopped.
- A message sent while a Codex turn is running (step 6), and `--codex-steer`. Not run: 3 of the 4 allowed model turns were used, one of them by the in-process launch, and that check needs two turns (a long turn, then the message after it ends).
- A command that needs approval in a delivered turn (#318's condition for turning Send to Codex on by default). Codex ran with `-s read-only -a never`.
- A prompt typed into the composer of a plain `codex`. Turn 1 was passed as an argument with `-s read-only -a never`.
- A session whose window is closed, the Codex desktop app, Linux and macOS, and a page started by `/agent-board` or the npm command.

## Also seen

- After the wake-test window closed, its thread was still loaded on the daemon 11 s later, while the board's receiver was subscribed to it. An empty thread with no subscriber was unloaded after about 60 s. So while the page runs, a board message may start a turn in a session whose window is closed. This was not tested.
- The daemon runs the session's hooks: when it unloaded the two empty probe threads, Codex's `SessionEnd` hook wrote `PENDING_DROPPED_UNBOUND_SESSION` to the board's hook error log (and once `REPORTER_FAILED UNBOUND_SESSION`, `REPORTER_QUEUED`).
- `codex app-server daemon status` does not exist in 0.167.0; `daemon version` says `running` or `stopped`.
- `codex app-server daemon stop` stopped the app server but left its `pid-update-loop` process running; that process was stopped by hand.
- The daemon's self-update left it at 0.168.0 under a 0.167.0 CLI. Both versions' packages stay in the test home's Codex folder.
- After the send, the Needs you slot showed another Codex "Blue or green?" card: the one from the in-process launch, whose session had ended. It read "Codex isn't connected to this board. Copy this and paste it there." and "1 min ago", while the board's data said 8 minutes.

## Re-run on 85475c5a

2026-11-13, 11:20 to 11:29 US Eastern. Same computer, test home and Codex CLI (0.167.0, interactive TUI, GPT-6.1-Sol); run by a Claude Code subagent (Claude Opus 5.5) for the maintainer's PM session. Board: PR #1306 at `85475c5a`, rebuilt the same way into a scratch file. At this head the receiver reads the thread (`thread/read`) right before `turn/start`, and marks a send `uncertain` with `TURN_JOINED` when the answer names a turn whose `turn/started` it heard before the answer.

### Question

Does the board still start a turn in an idle Codex CLI session from the page? And does the real daemon send `turn/started` before it answers `turn/start`? If it does, every send would read `uncertain TURN_JOINED`.

### What changed from the first run

- **No route switch.** The build's own records now give the `Codex daemon` route its idle record, so the page was started without `AGENT_BOARD_ROUTES` (the start script removes it from its environment). It kept its own `XDG_RUNTIME_DIR`.
- **A second listener.** A read-only script joined the daemon through its own `codex app-server proxy`, subscribed to the one loaded thread that had turns (`thread/resume`, no turn started) and logged each notice with the time. It cannot see the answer to the receiver's `turn/start`, which goes only to the receiver.
- **Opening the page.** The browser pane reached the page through a one-shot local redirect page, so the page's token never passed through the session. The redirect file deleted itself after 60 s.
- **The terminal tab.** When a tab does not report a typed command within 2 s, the desktop app's terminal tool sends Ctrl-C, and it did so once, at the plain `codex` start. A Ctrl-C landing in a running turn would interrupt it, so turn 1's start script waited 5 s with Ctrl-C taken as input, then emptied the input buffer before starting Codex. For turn 1 the tab reported the command in time, so no Ctrl-C was sent.

### Run

| Time | Stage |
|---|---|
| 11:20 | Board rebuilt from `85475c5a`. The bundle holds `thread/read`, `TURN_JOINED` and the recorded idle route |
| 11:20:46 | No daemon running (`daemon version`: connection refused) |
| 11:21:24 | Plain `codex` started (no options, no prompt). By 11:22:07 the shared daemon was running (`daemon version`: running, app server 0.168.0, under the 0.167.0 CLI) with its `pid-update-loop`. No update prompt blocked the window this time |
| 11:22:18 | That window closed |
| 11:22:40 | #1306 page started with `--codex-send` and no route switch. Its receiver started `codex app-server proxy` |
| 11:24:28 | Turn 1 in a new terminal tab: `codex -s read-only -a never "Synthetic test: ask me exactly one question, Red or purple?, and stop. Change no file."`. It asked "Red or purple?" and ended at 11:24 ("Worked for 4s") |
| 11:25:54 | The listener subscribed. One loaded thread with turns, status `idle`. At 11:25:38 a second loaded thread with no turns was still there, the empty one from the 11:21 window; it was gone by 11:25:54 |
| 11:26 | The page, under Needs you (the Codex filter was already selected): Codex, scratch-project, "Red or purple?", "Codex is waiting. It starts on this right away." Buttons: Red, purple, More, Write your own, and the send arrow (Send). Write your own's box offered "Send to Codex". No Copy-only card |
| 11:26:20.8 | Red picked, Send pressed. Store: `queued` (11:26:20.803) |
| 11:26:21.300 | Store: claimed, `uncertain` with no error (the claim, before delivery) |
| 11:26:21.377 | Store: `accepted` |
| 11:26:21.473 | Listener: `thread/status/changed` active, then `turn/started` for a new turn |
| 11:26:22.98 | Listener: the delivery's user message item. The Codex window showed the board's delivery text as a new prompt: the header ("sent from the board page on this computer (not typed in this window)"), "If you have already answered message …, reply only ACK … and do nothing else.", the ACK line and the framed "Red" |
| 11:26:26.05 | The model's reply: the `ACK <code>` line alone ("Worked for 5s") |
| 11:26:27.390 | Listener: `turn/completed`, status `completed`, and the thread back to `idle` |
| 11:26:27.392 | Store: `acknowledged`, reply the ACK line, line `now`, surface `Codex daemon`, one hop |
| 11:26:31 | The page: the card had left Needs you. The session's row, under Other work: "1/2", "Last: Red or purple?", "just now", "Waiting for the next instruction", "Codex is waiting. It starts on this right away.", Send to Codex, Archive. Receipt text: "Replied" |
| to 11:27:51 | 90 s after the send: no second turn in the Codex window, no key pressed there, and no further store change |
| 11:27:33 to 11:27:56 | The daemon updated itself again: a 0.169.0 package was downloaded at 11:27:33, and the update loop restarted the daemon at 11:27:56. This came after the acknowledgement, so the send was handled by 0.168.0 |
| 11:28:06 to 11:28:22 | Codex window closed (Ctrl-C), page stopped (`--stop`). Daemon stopped (`daemon stop`, now 0.169.0), since this run started it. Its leftover `pid-update-loop` was stopped by hand. The listener and the store watcher were stopped too |

### Result

**PASS.** At `85475c5a`, with the build's own route record and no switch, a message sent from the page started the idle Codex CLI session's turn about 0.6 s after Send. Nobody typed in the Codex window. The store went `queued` → `uncertain` (the claim) → `accepted` → `acknowledged`, the last once the turn ended `completed`. The send did not read `uncertain TURN_JOINED`.

**Order.** On the receiver's connection, the answer to `turn/start` came before `turn/started`. The receiver takes its snapshot of heard turn starts the moment the answer is read, and it would have thrown `TURN_JOINED` if that turn's start had been in it. It recorded `accepted` instead. On the listener's separate connection, `turn/started` arrived 96 ms after the store wrote `accepted`. That is one send on one daemon version (0.168.0, Windows, through `codex app-server proxy`).

### Not shown

- That the daemon always answers before `turn/started`. One send was seen, and the daemon changed version (0.169.0) right after it. The order on the receiver's connection is inferred from its own outcome, since its messages were not logged with times.
- A message sent while a turn is running (the `released` path and its later delivery), and a turn that a send really joins (`TURN_JOINED`). Only two model turns were allowed.
- What the model did with "Red": its reply was the ACK line alone, as on the first run.
- A command that needs approval in a delivered turn, a prompt typed into the TUI's composer, a closed window, the Codex desktop app, Linux and macOS, and a page started by `/agent-board` or the npm command.

### Also seen

- The empty thread from the plain `codex` window stayed loaded at least 3 min 20 s after its window closed (on the first run it took about 60 s). The run does not show why.
- The daemon updated itself during the run again, from 0.168.0 to 0.169.0, under a 0.167.0 CLI. The 0.169.0 package now sits in the test home's Codex folder beside 0.168.0.

# Codex CLI: a board answer reaches an idle interactive session at its next turn, 2026-11-12

For #826 (Codex CLI). Run by a Claude Code subagent (Claude Sonnet) for the maintainer's PM session, on the owner's computer, in the kept test home (`docs/validation/PARITY-CHECKLIST.md`): Windows 11, Codex CLI 0.167.0, the interactive TUI (`codex`, `codex resume`), model GPT-6.1-Sol. Board and hooks from `main` at `54b0518b` (package 0.24.3), installed there by `scripts/setup-agent.mjs --agent codex --apply`; Codex's own hook check (`--codex-doctor`) said the hooks were trusted. Session ids, message ids, ACK codes, tokens and folder paths are left out. Times are US Eastern.

## The live-check switch

Before this run the route had no record, so the card offered only Copy (#1354) and the run that would make its first record could not be made: run 1, earlier the same day, stopped there. For this run the board page alone was started with `AGENT_BOARD_ROUTES` naming a file that holds `main`'s routes with only Codex's mailbox idle and working routes opened (record "live check (not recorded yet)", surfaces CLI and TUI). Nothing else was changed, and the variable was not set for Codex, its hooks or the person's own environment.

## Run

1. The board page started in the kept home with the switch: `agent-board.mjs --serve --no-open` (no page was running before).
2. Turn 1, a new interactive session in a scratch folder: `codex -s read-only -a never "Synthetic test: ask me exactly one question, Blue or green?, and stop. Change no file."`
3. On the page: answer Blue, then "Queue for Codex's next turn".
4. Turn 1's terminal closed; the session idle. Turn 2: `codex resume --last -s read-only -a never "Synthetic test: go on."`

| Time | Stage |
|---|---|
| 16:56 | Turn 1 asked "Blue or green?" (7 s). Its card was on the page under Needs you within seconds: "It waits for this session's next turn. It does not wake an idle session." Buttons: Blue, green, More, Write your own, and Queue |
| 16:56:52 | Blue queued from the page; the card showed "Queued" |
| 16:57:41 | Turn 2 started. The session's turn-start hook claimed the message and the store marked it `accepted` at once |
| 16:57 | The model's reply began with the board's `ACK <code>` line, then "Blue selected." (12 s) |
| after | The store kept `accepted` with no reply or error; the message's line `nextTurn`, surface `CLI`, one hop |

## Result

**PASS.** A message queued from the board while an interactive Codex CLI session was idle waited without waking it and reached the model at the session's next turn, through its turn-start hook. `accepted` is where a hook mailbox stops (`docs/MESSAGING.md`: a hook collects no ACK); the model's ACK line shows it read the message.

The record covers the idle route on the CLI surface only.

## Second run: the idle route alone, and the CLI label from the session file

The same day, 19:00 to 19:06 US Eastern, same host and kept test home, board and hooks from `82f3b422` (the fix in this file's second pull request). This time the switch file opened only Codex's idle route on the CLI surface, so a Queue button meant the board had chosen the idle route; in the first run both routes were open and the card's words are the same for both.

| Time | Stage |
|---|---|
| 19:03 | Turn 1, `codex --no-daemon -s read-only -a never "<the same synthetic question>"`, asked "Blue or green?" (the default start did not submit its prompt, see below) |
| before queueing | The page's own data for that question: `send: mailbox`, `line: nextTurn`, `canSend: true`. The mailbox's surface was `CLI`, read from the session file's `codex-tui`. The card: "It waits for this session's next turn. It does not wake an idle session." |
| 19:05 | Blue queued from the page; the card showed "Queued" |
| 19:05:42 | Turn 2, `codex resume --last --no-daemon -s read-only -a never "Synthetic test: go on."`: the turn-start hook claimed the message, the store marked it `accepted`, and the model's reply was its `ACK <code>` line |

**PASS.** In the kept test home Codex's background service did not come up (its process file named a process that was not running, and its hourly self-update failed); `--no-daemon` worked. The board's hooks file there was unchanged, and no hooks review screen appeared.

## Also seen

- The card answered here was not seen leaving Needs you after the message was accepted (page reloaded at about 17:00), and it read "2 h ago". Run 1's question had the same words, was never answered and was asked two hours earlier, so the card seen may have been run 1's; not checked further.
- Codex printed an update notice (0.167.0 to 0.167.2) and a usage-limit note; neither needed action.

## Not covered

- A message queued while the session is working (the working route keeps Copy).
- Codex's other surfaces (the desktop app, the IDE extension), `codex exec`, Linux and macOS.
- A terminal session continued in another client that leaves no mark in the hook's environment. Codex 0.167 gives a turn-start hook no field naming the client of the turn; the board labels the session `CLI` when its history file names `codex-tui` and neither the app's or the editor's `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` nor the Windows background service's `CODEX_DAEMON_SHUTDOWN_SOCKET` is set. A session continued through a background service off Windows, or through another client that sets neither, can still read `CLI` and offer Queue there. The message is taken at the next turn by the same hook in every client, but only the terminal has this record. The owner accepted this gap on 2026-11-12 (#1383). Live runs of the app and the editor could show whether those clients take the message in the setups tried, but would not close the gap: the hook still could not tell which client runs a turn. Only a per-turn client signal from Codex closes it (asked for upstream: openai/codex#61225).

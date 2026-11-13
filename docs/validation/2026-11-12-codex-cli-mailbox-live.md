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
| before queueing | The page's own data for that question: `send: mailbox`, `line: nextTurn`, `canSend: true`. The mailbox's surface was `CLI`, which that build gives only when the session file's first record names `codex-tui`. The card: "It waits for this session's next turn. It does not wake an idle session." |
| 19:05 | Blue queued from the page; the card showed "Queued" |
| 19:05:42 | Turn 2, `codex resume --last --no-daemon -s read-only -a never "Synthetic test: go on."`: the turn-start hook claimed the message, the store marked it `accepted`, and the model's reply was its `ACK <code>` line |

**PASS.** In the kept test home Codex's background service did not come up (its process file named a process that was not running, and its hourly self-update failed); `--no-daemon` worked. The board's hooks file there was unchanged, and no hooks review screen appeared.

## Also seen

- The card answered here was not seen leaving Needs you after the message was accepted (page reloaded at about 17:00), and it read "2 h ago". Run 1's question had the same words, was never answered and was asked two hours earlier, so the card seen may have been run 1's; not checked further.
- Codex printed an update notice (0.167.0 to 0.167.2) and a usage-limit note; neither needed action.

## Not covered

- A message queued while the session is working (the working route keeps Copy).
- Codex's other surfaces (the desktop app, the IDE extension), `codex exec`, Linux and macOS.
- A terminal session continued in another client that leaves no mark in the hook's environment. Codex 0.167 gives a turn-start hook no field naming the client of the turn (read from its source). The board labels a Codex hook mailbox `CLI` when the session's history file names `codex-tui` in its first record, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` (the app's and the editor's mark) is unset or `codex-tui`, and `CODEX_DAEMON_SHUTDOWN_SOCKET` (the Windows background service's mark) is unset. A session continued through a background service off Windows, or through another client that sets neither mark, can still read `CLI` and be offered Queue (read from the board's code and Codex 0.167's source, not run). What happens to a message queued for such a session has no record: only the terminal has been seen taking one. From the code (`docs/MESSAGING.md`, "Next-turn mailbox"): a turn-start hook there that reads `CLI` can claim the message; if it then writes the message to its output and its accept call succeeds, the store marks it `accepted` and the card reads "Handed to the session at its turn start. No reply is confirmed." The hook collects no ACK, so the board cannot tell whether that client gave the message to the model. A hook that reads another surface does not claim a message saved with the `CLI` surface (the session's own `board_inbox` pull still can); a message saved without a surface, by an older board or from another agent's session, is not held to one. The owner accepted this gap on 2026-11-12 and kept it on 2026-11-13 after being told delivery there has no record (#1383). No live mailbox-delivery run of the app or the editor has been made. The hook cannot tell which client runs a turn; it would need a per-turn client signal from Codex (asked for upstream: openai/codex#61225).
- This label rule in a live run. The second run used `82f3b422`, which read the history file only; the two environment checks came after it and have the surface test only (`tests/codex-local.test.mjs`). By the code, a terminal whose Codex runs under the Windows background service reads `unknown`, so its mailbox offers no Queue. Whether the default `codex` start is such a terminal is not settled: run 1 used the default start before any surface check existed, and run 2 used `--no-daemon`. A later live run for #1306 (2026-11-13, Windows, Codex 0.167 updating itself to 0.168) saw a plain `codex` start bring up Codex's shared background service and load its session there; whether that session's hooks carry the service's mark, and what this head labels its mailbox, were not checked.

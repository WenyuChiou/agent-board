# Codex CLI: a board message sent during a turn goes in at the step end, 2026-11-26

For #319 (Codex CLI). Run by the maintainer's PM session (Claude Code, Claude Opus 5.5) on the owner's computer, in the kept test home (`docs/validation/PARITY-CHECKLIST.md`): Windows 11, Codex CLI 0.167.0, the interactive TUI started with `--no-daemon`, model GPT-6.2-Sol. Board and hooks from `main` at `c4564b6f` (#1885), installed there by `scripts/setup-agent.mjs --agent codex --apply`, which said Codex still trusted the board's hooks. Session ids, message ids, ACK codes, tokens and folder paths are left out. Times are US Eastern.

## The live-check switch

Before this run the working route had no record, so a working Codex CLI card offered only Copy. For this run the board page alone was started with `AGENT_BOARD_ROUTES` naming a file that holds `main`'s routes with only Codex's mailbox working route opened on the CLI surface (line `stepEnd`, record "live check (not recorded yet)"). Nothing else was changed, and the variable was not set for Codex, its hooks or the person's own environment.

## Run

1. The board page started in the kept home with the switch: `agent-board.mjs --serve --no-open` (no page was running before).
2. A new interactive session in a scratch folder: `codex --no-daemon -s read-only -a never "Synthetic test, use no tools: write exactly 80 numbered lines, each one full sentence of at least 25 words about a synthetic green kettle. Change no file."`
3. While Codex was writing, on the page: the session's card under Working now, "Synthetic test: after your current step, reply with the single word purple.", then "Send to Codex".

| Time | Stage |
|---|---|
| 09:16:27 | The turn started. Its card was under Working now within seconds: "Codex is working. It gets this when this step ends.", a message box and "Send to Codex" |
| 09:16, about 30 s in | Sent from the page; the card showed "Queued · when its step ends". The store held the message `queued`, line `stepEnd`, surface `CLI` |
| 09:18:05 | The 80 lines ended. The `Stop` hook claimed the message, and Codex showed "Blocked by hook" with the board's delivery text, then went on in the same turn |
| 09:18:07 | The model's reply was the `ACK <code>` line, then "purple". The turn ended (1 min 40 s in all); the next `Stop` read the ACK and the store marked the message `acknowledged`, one hop |
| after | The card read Read, and the session's row moved back to idle with "Queue for Codex's next turn" |

## Result

**PASS.** A message sent from the board while an interactive Codex CLI turn ran waited for the step end, went in through the `Stop` hook's continuation, and was acknowledged by the next `Stop` from the reply's first line.

The two points #319 left to a live run:

- **The continued turn keeps its turn.** Codex's session file for this run holds one turn record and one turn start and end: the continuation came in as the `Stop` hook's prompt inside the same turn, with no new turn.
- **What the next `Stop` reads.** The continuation wrote one message, and the next `Stop` read the ACK from its first line. This run cannot tell whether `last_assistant_message` is the continuation's first or last message when it writes more than one.

The record covers the working route on the CLI surface only.

## Also seen

- Two tries before the run did not reach a step end with a message queued: Codex's shell policy blocked a `Start-Sleep` the first prompt asked for, and the turn ended in 9 s; one start did not submit its prompt (as on 2026-11-12). Neither queued anything.
- In the terminal the person sees "Blocked by hook" and the board's message in full before the reply.
- Codex printed an update notice (0.167.0 to 0.172.0); no action needed.

## Not covered

- Codex's other surfaces (the desktop app, the editor extension, the background service), `codex exec`, Linux and macOS.
- A continuation that writes more than one message before its `Stop`, and a reply that ends on a question.
- What the session's row reads while the continuation runs: the `Stop`'s progress write marks it waiting first.
- A hook stopped after it accepted and before its output reached Codex (#1886).

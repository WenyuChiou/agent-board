# Live run: a board message to an idle interactive Antigravity CLI (agy TUI) session, next turn

Question: does a message queued from the board's page, while an interactive `agy` session is idle, reach that session at its next turn (route `nextTurn`, `hooks/receivers/hook-mailbox-antigravity.ts`), and does the hook register the session as `agy TUI`?

- **Host:** Antigravity CLI 1.5.7, interactive TUI, model Gemini 4 Argon (medium). Windows 11, build 26300.
- **Where:** a separate test home with its own board and sign-ins, and a scratch project folder. The person's own home and board were not used.
- **Run by:** a Claude Code subagent (Claude Sonnet), 2026-11-12, US Eastern. Two runs, two Antigravity turns each.
- **Routes:** `AGENT_BOARD_ROUTES` named a test routes file, set only in the terminal that started the page. Run 1 opened the idle and working routes for both surfaces; run 2 opened the idle route for `agy TUI` alone, so a Queue button meant the board read the session as idle on that surface.

## Steps (both runs)

1. `node scripts/setup-agent.mjs --agent antigravity --apply` in the test home.
2. The installed board script with `--stop`, then `--serve --no-open`; the page opened in a browser.
3. Turn 1: `agy -i 'Synthetic test: ask me exactly one question, Blue or green?, and stop. Change no file.'`
4. When the page offered it, "Blue" typed in the row's box and "Queue for Antigravity's next turn" pressed; the turn-1 terminal closed, so the session was idle.
5. Turn 2: `agy --continue -i 'Synthetic test: go on.'` (`--continue` reopens the last conversation; the transcript shows turn 2 in the same conversation).
6. `--stop`; terminals and the browser tab closed; no `agy` process left.

## Run 1, on 0.24.3 (`54b0518b`)

| Time | Stage |
|---|---|
| 17:32:15 | turn 1 sent |
| 17:32:18 | a new row "Local antigravity task" under Other work, "Waiting for the next instruction", with "It waits for this session's next turn. It does not wake an idle session." and "Queue for Antigravity's next turn" |
| ~17:33:10 | "Blue" queued; the row showed "Queued" |
| 17:33:40 | turn 2 started |
| 17:33:42 | the hook claimed the message and it became `accepted`. The transcript holds the hook's message ("Agent Board message, sent from the board page ... Reply first with this line alone: ACK ...") with the text "Blue" |
| 17:33:42-54 | the model's report command carried the step "Ask Blue or green? (Blue)": it used the answer. It printed no ACK line |

Message id prefix `AB-cc5412ae…` (the store's claim time for it matches the `accepted` row above to the second).

The mailbox registered as `IDE`, not `agy TUI`: before this change the turn-start hook labelled every Antigravity mailbox `IDE`.

## Run 2, with this change (`cbe3fc4d`)

Before queueing, the page's own data for the new row: `send: mailbox`, `line: nextTurn`, `canSend: true`. The mailbox's surface was **`agy TUI`**. Run 1's `IDE` row now offered Copy only ("This route has not been checked live yet").

| Time | Stage |
|---|---|
| 19:24:13 | turn 1 sent |
| 19:24:14 | a new row appeared, working |
| ~19:26 | the row moved to "Waiting for the next instruction" and offered "Queue for Antigravity's next turn" |
| ~19:28:50 | "Blue" queued; the row showed "Queued" |
| 19:38:33 | turn 2's prompt sent (the TUI took about 9 minutes to start this time; not chased) |
| 19:38:35 | the hook claimed the message and it became `accepted` (`line nextTurn`, `hops 1`, reply and error empty). The transcript holds the hook's message with the text "Blue" |
| 19:38:45 | the model finished the turn ("Synthetic test complete. No files were changed.") with no ACK line and without using "Blue" |

Message id prefix `AB-d3964731…` (the store's claim time for it matches the `accepted` row above to the second).

## Result

**PASS for the idle route on `agy TUI`.** In both runs a message queued while the session was idle waited, was handed to the session by its hook at the next turn and put into the model's context, and the store says `accepted`. In run 2 the hook registered the session as `agy TUI` and the page offered Queue there on the idle route alone.

Not shown:
- An ACK line: the model printed none in either run. Run 1's model used the text; run 2's did not.
- A message queued while the session is working: no run.
- The desktop app and the editor: not run here. The desktop app's record is `docs/validation/2026-11-13-antigravity-app-mailbox-live.md`. The editor has no run: the hook labels the folders `.gemini/antigravity` and `.gemini/antigravity-ide` both `IDE`, as it labelled the app's mailbox, so the app's routes would cover the editor if it writes to either folder; which folder it writes to was not seen.

## Also seen

- The model's own board report command failed in every turn of both runs, with "Can't create files next to progress.md (permission denied)". So a question asked in the TUI made no "Needs you" card, and the row never showed its steps done. The cause (the TUI's tool sandbox or the test home's folder rights) was not chased.
- The TUI showed a "Sign-in update needed" warning; not acted on.

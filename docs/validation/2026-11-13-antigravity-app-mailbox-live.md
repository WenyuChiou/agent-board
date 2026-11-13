# Live run: board messages to an Antigravity desktop app conversation, idle and working, next turn

Question: does a message queued from the board's page for an Antigravity desktop app conversation wait without starting a turn, and reach that conversation at its next turn (route `nextTurn`, `hooks/receivers/hook-mailbox-antigravity.ts`), with the mailbox registered as `IDE`: once queued while the conversation was idle, and once while a turn was running?

- **Host:** Antigravity 2.31.2 for Windows (`Antigravity.exe`), the window it opens with Conversations and Projects; model Gemini 4 Hydrogen (medium), permission mode Default, no project selected. Windows 11, build 26300.
- **Where:** a separate test home with its own board and sign-ins; Antigravity started there with its own user data folder. The person's own home, board and Antigravity windows were not used.
- **Build:** the board script and hooks installed in the test home from #1386's branch (`1a549c91`).
- **Routes:** `AGENT_BOARD_ROUTES` named a test routes file, set only in the shell that started the page. Run 1 opened Antigravity's idle mailbox route for `IDE` alone; run 2 opened its working route for `IDE` alone. So a Queue button meant the board read the conversation as idle (run 1) or working (run 2) on that surface.
- **Run by:** Claude Code (Claude Opus 5.5) through computer use, 2026-11-13, US Eastern. The messages were typed in the board page's row and sent with its button; the turns were typed in Antigravity, as its user would.

## Run 1: queued while idle

1. The board page started with the idle routes file; Antigravity started from the test home.
2. Turn 1, typed in a new conversation: `Synthetic test: ask me exactly one question, Blue or green?, and stop. Change no file.`
3. "Blue" typed in the row's box and "Queue for Antigravity's next turn" pressed while the conversation was idle; then 30 seconds of waiting.
4. Turn 2, typed in the same conversation: `Synthetic test: go on.`

| Time | Stage |
|---|---|
| 00:46:37 | turn 1 sent. The app showed "Hook Json SessionStart"; the session record has `SessionStart`, then `PreInvocation` |
| 00:46:37 | a new row under Other work, "Waiting for the next instruction", with "It waits for this session's next turn. It does not wake an idle session." and "Queue for Antigravity's next turn" (the row came with `SessionStart`; whether the board had read `PreInvocation` yet was not checked) |
| 00:47:03 | turn 1 ended (`Stop`); the model asked "Blue or green?" and stopped |
| 00:47:59 | "Blue" queued; the row showed "Queued" |
| 00:47:59-00:48:40 | no turn started: the app showed none after 30 seconds, and the session record has no event between `Stop` and turn 2 |
| 00:48:40 | turn 2 sent (`PreInvocation`) |
| 00:48:41 | the hook claimed the message and the store marked it `accepted` 6 ms later: `line nextTurn`, surface `IDE`, `hops 1`, reply and error empty |
| 00:48:45 | turn 2 ended. The model's reply: an ACK line (its code is left out here), then "Got it—you chose Blue. Synthetic test complete; no files were changed." |
| 00:49:11 | the row read "Handed to the session at its turn start. No reply is confirmed." |

## Run 2: queued while a turn was running

1. The board page restarted with the working routes file; Antigravity started again from the test home (the run 1 window had been closed).
2. Turn 1, typed in a new conversation: `Synthetic test: count from 1 to 600, one number per line, then stop. Change no file.`
3. Turn 2, typed in the same conversation: `Synthetic test: write the numbers from 1 to 2000, one per line, each as 'line N', then stop. Change no file.`
4. While turn 2 ran, "Green" typed in the row's box and "Queue for Antigravity's next turn" pressed.
5. After turn 2 ended, the store read; then turn 3, typed: `Synthetic test: go on.`

| Time | Stage |
|---|---|
| 00:57:32-00:57:47 | turn 1 (`PreInvocation` to `Stop`); while it was idle afterwards the row offered only Copy, as the routes file meant |
| 00:58:49 | turn 2 sent (`PreInvocation`, working). The row moved to Working now and offered "Queue for Antigravity's next turn" |
| 00:59:01 | "Green" queued from that row; the store row `queued`, `line nextTurn`, surface `IDE` |
| 00:59:15 | turn 2 ended (`PostInvocation`, `Stop`). The model wrote no list and said its output had been blocked by a content filter. The message was not handed over during the turn |
| 00:59:36 | the store row still `queued` |
| 00:59:53 | turn 3 sent (`PreInvocation`); the hook claimed the message and the store marked it `accepted` 7 ms later: `line nextTurn`, surface `IDE`, `hops 1`, reply and error empty |
| 00:59:59 | turn 3 ended. The model's reply began with an ACK line carrying the message's code (left out here), then "Received Green from Agent Board.", and asked whether to try a smaller range or another format |
| 01:00 | the row read "Handed to the session at its turn start. No reply is confirmed." and was under Needs you with the model's question |

## Result

**PASS for the idle and working routes in the Antigravity desktop app.** Each message waited without starting a turn (the one queued during a turn was not handed over in that turn), was handed to the conversation by its hook at the next turn start, and reached the model, which answered with its ACK line and used the text. The store says `accepted`; the hook collects no ACK, so the store does not record the model's ACK line.

Not shown:
- Waking an idle conversation. The hook hands a message over only at a turn start and starts no turn; #1396 looks for a way to start a turn from the board.
- The editor. The hook labels the folders `.gemini/antigravity` and `.gemini/antigravity-ide` both `IDE` (`antigravitySurface` in `scripts/hook-delivery.ts`); only the desktop app was run, and which folder the editor writes to was not seen.
- A turn that calls tools. Both running turns were one model call each; whether the hook also hands a message over between the calls of one turn was not seen.

## Also seen

- Run 1's question ("Blue or green?") did not move the row to Needs you; run 2's question in turn 3 did.
- Run 2's question card offered "line 1 to line 400)" as an option, with the closing parenthesis of the model's example.
- Right after the button was pressed in run 2, the row read "Sending to Antigravity; waiting for its reply…" while the store row was `queued`; a next-turn message gets no reply.
- The receipt lines ("Queued", "Delivered. Reply not confirmed.") are grey text on a light grey strip; the owner asked for colours that tell the states apart.
- The app's model picker and project picker were not used; both conversations ran with no project.

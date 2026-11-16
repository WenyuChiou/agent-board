# Antigravity turn-end ACK: live check in the desktop app and the agy TUI

Date: 2026-11-16. Part of #1416 (pull request #1601). The wake (#1396) moved to 0.25.1 and is not part of this run.

## Question

- On the #1601 head, once a board message is handed over at the conversation's next turn, does the turn-end hook read the model's `ACK <code>` line and mark the message acknowledged, in the desktop app and in the agy TUI?

## Host

- Windows 11 Home (build 26300), Node 24.14.0.
- Antigravity desktop app (surface `IDE`), model Gemini 4 Hydrogen, Medium.
- Antigravity CLI 1.5.9, interactive TUI (surface `agy TUI`), model Gemini 4 Argon, Medium. It showed a "Sign-in update needed" notice; its requests still ran.
- Commit under test: ed263893 (fb2eba55 plus a merge of `main`), installed into the kept test home with `node scripts/setup-agent.mjs --agent antigravity --apply`. The board page ran from the installed script with `--serve --no-open`, with no route override. The kept home is not named here.

## Run 1: desktop app

1. An existing app conversation, idle. Its card said "Antigravity reads this when you next type in its window." I typed the message and pressed "Queue for Antigravity's next turn"; the card showed "Queued for next turn".
2. Store line: `line nextTurn`, surface `IDE`, status `queued`.
3. A prompt typed in the app's chat started a turn (18:44:56 US Eastern). The turn-start hook claimed the message; the model's reply in the app read `ACK 6b30ae PONG-1601`.
4. Store line after the turn: status `acknowledged`, `reply` "ACK 6b30ae", `error` empty, 14.6 s after the claim; hops 1.

## Run 2: agy TUI

1. Turn 1: `agy -i '<synthetic prompt>'` in the scratch project. The board showed a new row with surface `agy TUI` and the card's "Queue for Antigravity's next turn". I queued the message; status `queued`.
2. I closed the turn-1 tab and ran `agy --continue -i 'Synthetic test 1601: go on.'`. It opened a different conversation, not the turn-1 one, so the message stayed `queued`, which is right: it was not that conversation's turn.
3. `agy --conversation <turn-1 id> -i 'Synthetic test 1601: go on.'` resumed the turn-1 conversation (18:49:29). The turn-start hook claimed the message; the reply's first lines were `ACK ebdea7` and `PONG-TUI`.
4. Store line after the turn: status `acknowledged`, `reply` "ACK ebdea7", `error` empty, 27.8 s after the claim; hops 1.

## Result

PASS on both surfaces: the message was handed over once at the next turn, and the turn-end hook took the model's ACK line and marked it acknowledged. The board's hook error log got no new line during either run.

## Notes, outside #1601

- In the TUI, the model's own progress-pane report command failed inside Antigravity's command sandbox in each turn. This does not touch the message route.
- `agy --continue` picked a conversation other than the one the previous `agy -i` had made. To resume a given conversation, use `agy --conversation <id>`.

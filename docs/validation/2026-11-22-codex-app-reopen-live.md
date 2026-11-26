# A board reply to a Codex desktop app conversation, live (#557)

Date: 2026-11-22. Verdict: **works once the app is fully quit.** While the Codex desktop app is open, a reply sent from
the board waits on the board and the card says so. Once the app is quit, the board runs the reply as a background turn
in that conversation (`codex exec resume <id> -`), the turn's ACK is the receipt, and the reopened app shows the turn.

## Versions

- Codex desktop app 26.1111.9664 (Windows), started through its own app alias in the kept test home of
  `docs/validation/PARITY-CHECKLIST.md`, so it runs its own private app-server.
- Codex CLI 0.167.0 for `codex exec resume`; the test home's shared Codex daemon was up (0.169) and not used by this route.
- Node v24.14.0, Windows 11 build 10.0.26300.
- The board built from this pull request's code, with its own runtime folder.
- Synthetic prompts only: the conversation asked the model to answer each board reply with `<word> ACK R<n>.` and a new
  `[?]` question with two choices.

## Before the build (11-21)

- With the app open, Codex refuses a second writer on the conversation: the app-server route says the thread "already
  has an active writer", and `codex exec resume` stops with a thread-store conflict naming the active writer. The
  conversation file is unchanged in both cases.
- An open app holds the writer even when another conversation is on screen, checked at 3, 6, 9 and 12 minutes idle.
  Closing the window only hides the app to the tray; it still holds the writer.
- With the app quit, the same resume ran the turn, and the reopened app showed it and answered a follow-up typed there.

## The run

1. **App open.** The conversation sat at its `[?]` question; the board row was `waiting` with the question as a card.
   A reply sent from the card stayed queued. The card read "Waiting here: the turn runs in the background once the Codex
   app is fully quit (closing its window is not enough)." No Codex process started.
2. **App quit** from its File menu (Quit). About 5 seconds later the board ran `codex exec resume` in the conversation's
   folder. The reply was acknowledged ("Teal ACK R3. Square or circle?"), the card showed the receipt, and the row stayed
   `waiting` with the new question. The background turn wrote no hook error.
3. **A second reply** with the app still quit was acknowledged in about 2 seconds ("Circle ACK R4.").
4. **App reopened.** The conversation shows both turns, with the unread dot.

## Found by the run and fixed here

| What the run showed | Fix | Test |
|---|---|---|
| The background turn's SessionEnd marked the row `ended` | The board marks its own run (`AGENT_BOARD_BACKGROUND_TURN=1`); the SessionEnd it fires keeps the row `waiting`, and a queued SessionEnd keeps the mark when it is replayed | `the SessionEnd of the board's own background turn keeps a Codex conversation waiting on its question, and any other SessionEnd ends it`; `a queued SessionEnd keeps the board's background-turn mark when it is replayed` |
| The card said the turn was running while the reply waited for the app | A wait line for Codex app conversations, in all three string tables | `a Codex app card says a sent reply waits here until the app is fully quit, and that the turn runs only once it is taken, in every language` |
| The page never learned that a queued message was for the app, so the receipt fell back to the running line | Messages to a Codex app conversation carry that mark onto the page | `a board reply to a Codex desktop app conversation is answered with the wait for the app to quit, not a running turn (#557)` |

## A second check: the refusal as Codex prints it (review round 5)

Same test home and versions, later on 11-22. A `codex app-server` started by the check held a new synthetic conversation
(`thread/resume`), as the app holds one, and the board's own runner (`runBackgroundProcess`) ran the receiver's
`codex exec resume --skip-git-repo-check <id> -` in it three times.

- Each run ended within 1.3 seconds with exit 1, printed nothing, and left an error output of 509 characters, kept
  whole. The output had closed when it was read: Codex refuses before it starts the MCP server the test home configures.
- The error output, with the times and the conversation's id left out:

  ```
  <time> ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread <id> already has an active writer
  <time> ERROR codex_core::session: Failed to create session: thread-store conflict: thread <id> already has an active writer
  Error: thread/resume: thread/resume failed: thread <id> already has an active writer (code -32600)
  ```

- The receiver's check of that sentence, as review round 2 had narrowed it, did not take this last line, so each refusal
  read as a failed run: a reply sent while the app was open would have failed instead of waiting. The run above (step 1)
  used the receiver of review round 1, whose check was looser. Round 5 makes the check take this wrapping, and the tests
  use this text (`Codex's refusal as it prints it while the app holds the conversation reads as nothing sent`). With the
  fix, all three refusals read as held.
- With the app-server stopped, the same run went through (exit 0, a reply printed).
- Not shown in this check: the desktop app itself holding the conversation. An app-server the check started held it
  instead; the app runs its own.

## Limits

- The app has to be quit, not closed. The card says this.
- A reply waits for the app to be quit for at most 30 minutes, the time any open message may wait. After that it is
  refused as not sent (`APP_STILL_OPEN`, shown as rejected / not sent), and the card says so beforehand. Not shown live:
  the run quit the app within a minute.
- The board finds an app conversation's history with the same bounded search it uses for every Codex conversation
  (60 folder reads, newest days first). A conversation last written before that reach is not attached, and a reply to it
  waits as for any conversation with no connection.
- A board restart rejects a reply still queued for a live connection (`DISCONNECTED`, shown as rejected / not sent), as
  for every other live connection; the person sends it again.

## Not shown

- macOS.
- The Codex extension in VS Code, which runs its own private app-server too.
- Opening the conversation in the app while a background turn runs: Codex's own writer lock decides which writer goes on.
- An install with the Codex app and no Codex CLI: the board has no program to run the turn, so no receiver starts.
- After the board restart, the card also said the window might have closed; that line was not looked into.
- The hook error log has an unbound-session entry from before the first reply; it does not come from the background
  turn, and its cause was not looked into.

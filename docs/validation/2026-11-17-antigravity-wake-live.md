# Live run: the Antigravity sidecar wakes an idle desktop app conversation for a board message

This note is the record the sidecar's idle route names (`hooks/receivers/sidecar-antigravity.ts`, #1396). One run,
2026-11-27, synthetic data only, results below. The sidecar's surfaces keep `evidence: null` in the pull request that
adds this run (#1952), so its rows read Implemented; naming this note there, for the 2.0 Desktop App, is a follow-up.

Question to answer: with the sidecar switched on in the app's Automations page and polling the board, does a message sent
from the board's page to an idle Antigravity desktop app conversation (route `now`, surface `IDE`) start a new turn there
about 10 seconds after that conversation's turn ended, with the one fixed wake line in the app and the message handed over
by the turn-start hook; is the wake run once only; and does the card read the wake as woken, or as failed or unconfirmed
when it is?

The run also records what the board cannot see (the two Fable diagnoses on #1396 for PR #1602):

- What the app does with `send-message` sent by hand into a conversation whose turn is still running: queues the line
  for after the turn, refuses it, or injects it into the running turn. The board approves a wake and the sidecar then
  calls `send-message`; a turn the person starts in between gets that call. Queued or refused: recorded here, and the
  owner decides whether that meets his rule. Injected: the route stays off. (The live run on #1612 found it injects; the
  owner's decision of 2026-11-18 then kept the route on with the two windows accepted: item 1 below.)
- The order of the hook events in a turn with several steps: whether the app ever runs `Stop` inside a turn with no
  turn-start event after it. If it does, the board would read that turn as ended.
- A turn whose turn-start hook never runs (killed or timed out) leaves no number in the turn order file and none with
  the board; a message for that conversation would be woken into it, as in the first item.
- The keys of a real `Stop` hook input: whether it carries `invocationNum` or a time. The board counts turns from its
  own hooks, so a `Stop` hook that starts after the next turn's start ends that turn while it runs; a turn number in the
  `Stop` input would close that.
- Whether the app waits for a slow `Stop` hook before the next prompt runs its turn-start hook: with a `Stop` hook made
  to take a few seconds, send a second prompt at once and record the order the two hooks ran in.

## Setup

- **Host:** Antigravity 2.35.2 for Windows (`Antigravity.exe`), the window with Conversations and Projects; model Gemini 4
  Hydrogen (medium), permission mode Default; project `ab-wake-idle`, conversation "Synthetic Idle Test". Windows 11, build
  26300.
- **Where:** a separate test home with its own board and sign-ins; Antigravity started there with its own user data
  folder. The person's own home, board and Antigravity windows were not used.
- **Build:** the board script and hooks installed in the test home from this branch (`57c4204a`) with
  `scripts/setup-agent.mjs --agent antigravity --antigravity-sidecar --apply`. The sidecar was already switched on
  ("Always on") in the app's Automations page from an earlier run; this run did not change it.
- **Run by:** Claude Code (Claude Opus 5.5) through computer use and the built-in browser, 2026-11-27. Times are UTC.
  Messages were typed into the board page's row and sent with its button (pressed from the page's script, because the
  browser pane was hidden: a first pointer click did not reach the button and sent nothing). Turns were typed in
  Antigravity, as its user would. Times come from the board's message store and the conversation's turn log.

## Run 1: an idle conversation

The conversation's last turn had ended at 23:47:15 (its turn log's `E` line), about 6 minutes before.

| Time | Stage |
|---|---|
| 23:53:10.9 | message 1 sent from the row: "Synthetic live check 1: reply with the single word woken, and stop. Change no file." (route `now`) |
| 23:53:12.002 | the board saved the wake's start; the sidecar reported `sent` |
| 23:53:12.382 | the turn-start hook took the message |
| 23:53:14.902 | the turn ended (`E` line) |
| 23:53:15.041 | the store marked it `acknowledged`, reply `ACK 26b662` |

The app showed one new turn: an "Agent Board" step holding the one fixed line, "Agent Board: a message from the board is
attached to this turn. Follow it.", then the reply "ACK 26b662 woken". The turn log has one start and one end for it, and
the store one `sent` report: the wake ran once. The row's receipt read "Read". The board saved the wake's start 1.1 s
after the send and the turn-start hook took the message 1.5 s after it (the app's own start time was not read); the
10 s wait did not apply, because the last turn had ended long before.

## Run 2: a turn running

| Time | Stage |
|---|---|
| about 23:54:21 | turn typed in Antigravity: "Count from 1 to 2500, numbers separated by spaces, then stop. Change no file." |
| 23:54:24.657 | the row offered only "Queue for Antigravity's next turn", with "Antigravity reads this when you next type in its window."; message 2 ("... reply with the single word held ...") queued, route `nextTurn` |
| 23:55:13.595 | the turn ended (`E` line) |
| 23:55:13-23:55:40 | no wake: message 2 stayed `queued` with no wake start, and the app started no turn |
| 23:55:40.745 | the next turn, typed in Antigravity, took message 2 at its start |
| 23:56:04.361 | `acknowledged`, reply `ACK 71c547`; the app showed "ACK 71c547 held" |

An earlier try in this run (a shorter count) ended before the row's button was pressed, so nothing was sent then.

## Run 3: a message sent 4.8 s after a turn ended

| Time | Stage |
|---|---|
| 23:56:04.223 | the turn that took message 2 (one with a tool step) ended (`E` line) |
| 23:56:08.988 | message 3 sent from the row (route `now`) |
| 23:56:14.833 | the board saved the wake's start, 10.6 s after that turn's end; the sidecar reported `sent` |
| 23:56:15.247 | the turn-start hook took the message |
| 23:56:18.203 | `acknowledged`, reply `ACK 583911`; the app showed the "Agent Board" step, then "ACK 583911 timed" |

## What the board cannot see

1. `send-message` into a running turn: answered before this run. The live run on #1612 (comment 6932556611) found that
   it injects the line into the running turn. The owner's decision of 2026-11-18 accepted the two windows that lead
   there, with a test and the card's wording, and kept the route on in place of "the route stays off" above (#1396;
   `docs/validation/2026-11-18-c3-antigravity-wake-windows.md`). The D1 run on #1612
   showed a call made while the `Stop` hook ran: the app held it and started the turn after the hook returned. In this
   run, the same call made by hand from a shell in the test home during a running turn exited with -1 and printed
   nothing; the app showed no line, and no turn followed (20 s). Why that one call did not run was not looked into.
2. Hook order in a turn with several steps: the typed turn with a tool step (the one that took message 2) wrote two start lines and
   one end line: the turn-start hook ran twice inside that turn and `Stop` once, at its end. No `Stop` ran inside the turn.
3. A turn-start hook killed or timed out: not run. It is the first window the owner accepted (item 1).
4. The keys of a real `Stop` input: from the D1 run on #1612 (same app version): no `invocationNum` and no time; the
   turn-start input has `invocationNum` and `initialNumSteps`.
5. A slow `Stop` hook: from the D1 run on #1612: the app waited for an 8 s `Stop` hook, and the next turn-start hook came
   1.5 s after it returned.

## Result

For the 2.0 Desktop App on Windows: a board message to an idle conversation started a turn with the one fixed line and
the message handed over by the turn-start hook, once, and the row read it as read. The board saved the wake's start at
once when the last turn had ended long before (run 1), and 10.6 s after the last turn's end for a message sent 4.8 s
after it, the hook taking the message at 11.0 s (run 3); the app's own start time was not read. A message sent while
a turn ran waited for the next turn and woke nothing (run 2).

Not covered: the editor (IDE) surface, a woken turn that fails or is never confirmed, Linux and macOS, other app
versions, a second run.

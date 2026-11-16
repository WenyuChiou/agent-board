# Live run: the Antigravity sidecar wakes an idle desktop app conversation for a board message

Live run pending. This note is the record the sidecar's idle route names (`hooks/receivers/sidecar-antigravity.ts`, #1396).
It is filled in after the run, before the pull request is Ready; until then no surface of that route reads Verified.

Question to answer: with the sidecar switched on in the app's Automations page and polling the board, does a message sent
from the board's page to an idle Antigravity desktop app conversation (route `now`, surface `IDE`) start a new turn there
about 10 seconds after that conversation's turn ended, with the one fixed wake line in the app and the message handed over
by the turn-start hook; is the wake run once only; and does the card read the wake as woken, or as failed or unconfirmed
when it is?

The run also records three things the board cannot see (the Fable diagnosis on #1396 for PR #1602):

- What the app does with `send-message` sent by hand into a conversation whose turn is still running: queues the line
  for after the turn, refuses it, or injects it into the running turn. The board approves a wake and the sidecar then
  calls `send-message`; a turn the person starts in between gets that call. Queued or refused: recorded here, and the
  owner decides whether that meets his rule. Injected: the route stays off.
- The order of the hook events in a turn with several steps: whether the app ever runs `Stop` inside a turn with no
  turn-start event after it. If it does, the board would read that turn as ended.
- A turn whose turn-start hook never runs (killed or timed out) leaves no busy mark and no row write; a message arriving
  before the turn's first progress report would be woken into it, as in the first item.

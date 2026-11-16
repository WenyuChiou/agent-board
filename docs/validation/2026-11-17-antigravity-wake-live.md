# Live run: the Antigravity sidecar wakes an idle desktop app conversation for a board message

Live run pending. This note is the record the sidecar's idle route names (`hooks/receivers/sidecar-antigravity.ts`, #1396).
It is filled in after the run, before the pull request is Ready; until then no surface of that route reads Verified.

Question to answer: with the sidecar switched on in the app's Automations page and polling the board, does a message sent
from the board's page to an idle Antigravity desktop app conversation (route `now`, surface `IDE`) start a new turn there
about 10 seconds after that conversation's turn ended, with the one fixed wake line in the app and the message handed over
by the turn-start hook; is the wake run once only; and does the card read the wake as woken, or as failed or unconfirmed
when it is?

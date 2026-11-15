# Live check: does OpenCode send events for a session it deleted?

## Question
"Does OpenCode send events for a deleted session id?" The #1366 design check (comment on #1366, 2026-11-14) made this the first step before the last fix round: two review findings (an `end` beside a take, and the counter reset when a session is deleted) need OpenCode to name a deleted session again. Tracked on #1379.

## Host
OpenCode 1.19.3 (`opencode --version`), headless `opencode serve --pure --hostname 127.0.0.1 --port <own port>`, default model of the opencode provider (a free model, picked by the host), no sign-in. Permissions for bash, edit and webfetch denied in `OPENCODE_CONFIG_CONTENT`.
No agent-board install used; the probe talks to the server's HTTP routes and reads its event stream (`GET /event`), the same events the plugin's `event` hook receives.
Run by: Claude Code (Claude Opus 5.5), 2026-11-14, twice, in the kept test home.

## Commands
- `source <kept home>/enter.sh; cd <scratch project>; OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"deny","edit":"deny","webfetch":"deny"}}' opencode serve --pure --hostname 127.0.0.1 --port <port>`
- The probe, with the event stream open throughout:
  - A: `POST /session`; `POST /session/<A>/prompt_async` ("Reply with exactly: PONG"); wait for `session.idle`; `DELETE /session/<A>`; then `GET /session/<A>/message`, `GET /session/<A>`, `GET /session/status`, `POST /session/<A>/prompt_async`, and 15 s later `POST /session/<A>/message`; events naming A collected for 8 s more.
  - B: `POST /session`; `POST /session/<B>/prompt_async` ("Count from 1 to 300, one number per line"); at its first `session.status` busy and first part, `DELETE /session/<B>`; 2 s later `GET /session/<B>` and `GET /session/status`; events naming B collected for 30 s after its `session.deleted`.

## What happened
Times are milliseconds after the probe started.

| Run | Time | Stage | Evidence |
|---|---|---|---|
| 1 | 18815 | A deleted while idle | `DELETE` 200 `true`; `session.deleted` at 18919 |
| 1 | 18929-33947 | A used after deletion | messages, `prompt_async` and the sync message all 404 `Session not found` |
| 1 | 41956 | events naming A after deletion | none |
| 1 | 42131 | B deleted during its turn | `DELETE` 200 `true`; `session.deleted` at 42238 |
| 1 | 43375 | events naming B after deletion | `session.error`, `session.status` idle (twice), `session.idle` (twice), all within 1.2 s |
| 2 | 3216-18378 | A deleted while idle, then used | `GET /session/<A>` 404; `GET /session/status` `{}`; messages, `prompt_async` and the sync message 404; no events |
| 2 | 26528 | B deleted during its turn | `DELETE` 200 `true`; `session.deleted` at 26642 |
| 2 | 28662 | B looked up 2 s later | `GET /session/<B>` 404 `Session not found`; `GET /session/status` lists B as `busy` |
| 2 | 35639-56266 | events naming B after deletion | `session.status` retry, busy, retry, busy, retry, busy, retry (the turn kept retrying for 30 s) |

## Result
- A session deleted while idle is gone: every route answers 404 and no event names it again.
- A session deleted during its turn is named again: OpenCode sends `session.status` (idle, busy or retry), `session.idle` and `session.error` for it after `session.deleted`, for up to 30 s or more, and `GET /session/status` may still list it as busy. Which ending comes (an error and idle within about a second, or a turn that keeps retrying) varied between the two runs.
- Its own lookup refuses it: `GET /session/<id>` answers 404 after the deletion, in both runs, so the plugin's own path (`client.session.get` before a session is made known) cannot make it known again. Without a record of deleted sessions, a late event would leave it written down and looked up at every tick until the tick gave up after 20 tries.

## What this means for #1366
The late events are real, so the receiver records every session it saw deleted and ignores later events for it (`gone` in `hooks/receivers/opencode.ts`); OpenCode never reuses a session id. Test R38 replays the order recorded here. Not shown: how long a retrying turn of a deleted session goes on, and whether a desktop or TUI host behaves the same as the headless server.

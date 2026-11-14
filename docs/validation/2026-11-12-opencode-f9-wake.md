# Live check F9: OpenCode `promptAsync` or `prompt`, and does it wake an idle session?

## Question
"OpenCode: `promptAsync` or `prompt`, and does it wake an idle session?" (feeds D2's OpenCode receiver, issue #724).

## Host
OpenCode 1.19.3 (`opencode --version`), headless `opencode serve --pure --port <own port>`, default model of the opencode provider (a free model, picked by the host).
Release: checkout HEAD de218523f99e80a1ff0e90a6b2203527615c7f55; no agent-board install used.
Run by: Claude Code subagent (Claude Sonnet), 2026-11-12.

## Commands
- `source <kept home>/enter.sh; cd <scratch project>; OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"ask","edit":"ask"}}' opencode serve --pure --port <port> --print-logs`
- Routes read from `GET /doc` (OpenAPI 3.1, saved as doc.json). Event stream: `GET /event` (SSE), logged by sse.mjs.
- f9.mjs: `POST /session`, wait 20 s, `POST /session/<session>/prompt_async` {parts:[text]}, poll `GET /session/<session>/message`, wait 8 s, `POST /session/<session>/message` (sync).

## What happened
Times are UTC; US Eastern is 5 h earlier (06:45:17Z = 01:45:17 EST).

| Time (UTC) | Stage | Evidence |
|---|---|---|
| 06:44:57.263 | session created, then idle 20 s | `session.created`; `GET /session/status` -> `{}` (no entry = idle) before and after the wait |
| 06:45:17.303 | `POST /session/<session>/prompt_async` | HTTP 204, empty body, returned in 12 ms |
| 06:45:17.383 | user message stored | `message.updated` role user, `message.part.updated` text "Reply with exactly: PONG1" |
| 06:45:17.410 | turn started by itself | `session.status` `{"type":"busy"}` (no other call made) |
| 06:45:22.070 | reply finished | `message.part.updated` text "PONG1", step-finish `reason:"stop"`, `session.status` idle, `session.idle` |
| 06:45:30.861 | `POST /session/<session>/message` (sync) | the HTTP call stayed open |
| 06:45:30.896 | user message, then `session.status` busy | same events as above |
| 06:45:34.313 | sync call returned 200 | body is the full assistant message, text "PONG2"; took 3453 ms |

## Result
- Route names: PASS. `prompt_async` is `POST /session/{id}/prompt_async` (operationId `session.prompt_async`, SDK `promptAsync`); `prompt` is `POST /session/{id}/message` (`session.prompt`). Both take `{parts:[...], model?, agent?, noReply?, tools?, system?, variant?, messageID?}`. A v2 route `POST /api/session/{id}/prompt` also exists (`delivery: steer|queue`, `resume`); not exercised.
- Does it wake an idle session: PASS for both. `prompt_async` on an idle session returned 204 at once, the host started the turn by itself (busy 27 ms after the call) and answered; the reply arrived on the event stream and in `GET .../message`. The sync route does the same but blocks until the turn ends and returns the assistant message.
- For a receiver that must not hold a request open: `prompt_async`; completion is the `session.idle` event (or `session.status` idle).

## Not shown
- Sending while a turn is already running (queueing, steer): not tried (v2 `delivery` field only read from the schema).
- Only the free default model was used; other providers are the host's business, not the route's.
- `--pure` (no external plugins) was used, so the kept home's agent-board plugin was not loaded; this checks the host API, not the plugin.

## What it means for the plan
D2's OpenCode receiver can ship on `prompt_async` (204, wakes an idle session, finish seen as `session.idle`); `prompt` is only needed when the caller wants the reply in the same response. Cost: 2 model turns.

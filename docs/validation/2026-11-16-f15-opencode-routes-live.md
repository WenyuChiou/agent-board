# Live check F15: OpenCode's routes for answering a permission and a question

Part of #1321. Feeds D3 (OpenCode's buttons) and "Answer or send" (OpenCode's question tool).

## Question
F15: in the installed OpenCode, which routes answer a permission and a question, does a denial take a message, do both reach the event stream, and does a press that carries the request id and no turn answer only that request, on a live record?

## Host
- Windows 11 Home, Node 24.14.0.
- OpenCode 1.19.3 (`opencode --version`; its terminal offers 1.19.5, not taken), headless `opencode serve --pure --port <port> --print-logs`, with `OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"ask","edit":"ask"}}'`. Model: the opencode provider's free default, picked by OpenCode; no sign-in.
- The server printed at start: "Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured."
- Run by a Claude Code session (Claude Opus 5.5) for the PM session, 2026-11-16, 19:07 to 19:16 US Eastern (00:07 to 00:16 UTC on 11-17), in the kept test home. Session, message and request ids are shown as `<ses1>`, `<per1>`, `<que1>` and so on.

## Commands
- Routes read from `GET /doc` (OpenAPI), saved as `doc.json`. The answer routes it lists:
  - `GET /permission`, `POST /permission/{requestID}/reply` (permission.reply), `POST /session/{sessionID}/permissions/{permissionID}` (permission.respond, the older route);
  - `GET /question`, `POST /question/{requestID}/reply`, `POST /question/{requestID}/reject`;
  - v2: `GET /api/permission/request`, `POST /api/session/{sessionID}/permission/{requestID}/reply`, `GET /api/question/request`, `POST /api/session/{sessionID}/question/{requestID}/reply` and `/reject`.
  - Schemas: `QuestionAnswer` is an array of strings, one array per question.
- `f15.mjs` (a driver in the test home) listened to `GET /event` (SSE) the whole time, made sessions with `POST /session`, started each turn with `POST /session/<ses>/prompt_async`, waited for the `permission.asked` or `question.asked` event, answered, and read the session's messages back.

## What happened
| Step | Call | Answer | Events and what the model got |
|---|---|---|---|
| P1, deny with a message | `POST /permission/<per1>/reply` `{"reply":"reject","message":"F15-DENY-REASON: the person pressed Deny on the board (synthetic check)."}` | 200 `true` | `permission.asked` (`"permission":"bash","patterns":["echo f15-p1 > f15-p1.txt"],"always":["echo *"]`, with `tool.messageID` and `tool.callID`, no turn id), then `permission.replied {"reply":"reject"}`, `session.idle`. The tool result: "The user rejected permission to use this specific tool call with the following feedback: F15-DENY-REASON: ...", and the model repeated the reason. No file. |
| P2, two requests pending at once, in two sessions | `GET /permission` listed `["<per2>","<per3>"]`; `POST /permission/<per2>/reply` `{"reply":"once"}` | 200 `true` | `permission.replied` for `<per2>` only; its file was written. Afterwards `GET /permission` listed `["<per3>"]`, and `f15-p3.txt` did not exist. |
| P2, the same id again (a stale press) | `POST /permission/<per2>/reply` `{"reply":"once"}` | 404 `{"_tag":"PermissionNotFoundError","requestID":"<per2>","message":"Permission request not found: <per2>"}` | nothing changed |
| P2, the older route | `POST /session/<ses3>/permissions/<per3>` `{"response":"reject"}` | 200 `true` | `permission.replied {"reply":"reject"}`; tool result "The user rejected permission to use this specific tool call." |
| P3, the v2 routes | `GET /api/permission/request` | `"data":[]` while `<per4>` was pending | |
| | `POST /api/session/<ses1>/permission/<per4>/reply` (wrong session in the path), then with the right session | both 404 `PermissionNotFoundError` | `<per4>` stayed pending; answered later through `/permission/<per4>/reply` to clean up |
| Q1, one choice | `POST /question/<que1>/reply` `{"answers":[["Green"]]}` | 200 `true` | `question.asked`, then `question.replied {"answers":[["Green"]]}`; tool result `User has answered your questions: "Which color for the F15 test?"="Green"`, model: "Green" |
| Q2, two questions, several choices and typed text | `{"answers":[["Apple","Cherry"],["F15-OTHER typed on the board: extra large"]]}` | 200 `true` | `question.replied` with the same arrays; tool result `"Which fruits for the F15 test?"="Apple, Cherry", "Which size for the F15 test?"="F15-OTHER typed on the board: extra large"` |
| Q3, dismiss | `POST /question/<que3>/reject` | 200 `true` | `question.rejected`, `session.idle`; tool result "The user dismissed this question" |

## Result
**PASS on the v1 routes.**
- Permission: `POST /permission/{id}/reply` with `reply` `once` or `reject`; a reject takes a `message`, and the model reads it. The older `POST /session/{sid}/permissions/{pid}` with `response` also works (no message tried there).
- Question: `POST /question/{id}/reply` with `answers`, one array of strings per question in order (several labels for several choices, the typed text for Other); `POST /question/{id}/reject` dismisses it.
- `permission.asked` and `permission.replied`, `question.asked`, `question.replied` and `question.rejected` all reach `GET /event`.
- A press with only the request id answers that one request and no other: with two pending, the other stayed pending, and a second press with the same id got 404.
- The v2 `/api/...` routes, called as above, did not see these requests (empty list, 404 on reply). Not explored further.

## Not shown
- Two requests pending in the same session at once (P2's two were in two sessions).
- The OpenCode terminal (`opencode` with no subcommand) or the board's OpenCode plugin answering: this run used `opencode serve`. In F10 the terminal had no listening port, so these routes are only there when OpenCode runs as a server.
- `"always"` replies: not sent (D3 allows Allow once and Deny only).
- The server password: not set in this run. F10 has what an open server means.

## What it means for the plan
- D3, OpenCode: F15 passes, so OpenCode keeps Allow once, Deny and "Deny and say why", on the v1 routes. The press carries the request id; a stale or repeated press gets 404, which the board can show as "already answered".
- "Answer or send", OpenCode's question tool: one tap sends `answers: [[label]]`; several choices are several labels in one array; Other is the typed text; Dismiss is `/reject`.
- OpenCode's events have no turn id, as D3 expected; the request id alone was enough here.
- No "Done when" changes from F15 itself. F10 adds a condition about the unsecured server.

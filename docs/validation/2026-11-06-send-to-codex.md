# Send to Codex: what ran and what did not, 2026-11-06

For #318. Run by claude (superd6) on Windows 11, Codex CLI 0.164.0, Node 22. Thread and turn ids, folder paths and the board token are left out. Everything here is synthetic.

## Synthetic tests (Implemented, not Verified)

`tests/messaging.test.mjs`, with `tests/helpers/codex-daemon-mock.mjs` standing in for `codex app-server proxy`: the ten acceptance tests of #318 by their titles, a steer that stays silent, a turn that ends without the ACK, and the page starting and ending the receiver through the real bundle. The mock speaks WebSocket over stdio like the proxy.

## A real app-server, no model

An isolated home (all 13 variables of the 2026-10-20 spike under one short folder, `GIT_CEILING_DIRECTORIES` set), not logged in. `codex app-server daemon start` failed here with os error 5 (the Windows launcher; #289 again), so the app-server was started as `codex app-server --listen unix://<private folder>/s.sock` and the client used `codex app-server proxy --sock`. The model call fails with 401, so no turn ever got a reply, and no ACK was seen.

What it showed:

- **`clientUserMessageId` accepts the 6-hex claim nonce.** The daemon echoes it as `clientId` on the `userMessage` item.
- **`thread/resume` of a thread with no turn yet is refused** (`no rollout found for thread id …`, -32600). The receiver therefore joins a thread after its first turn; until then the message waits for the session's next step.
- **A second client that has not resumed gets `thread/status/changed` and `thread/goal/*` but none of `turn/started`, `item/*` or `turn/completed`.** After `thread/resume` with `excludeTurns: true` the resume answer carries `thread.status` (`{"type":"active","activeFlags":[]}`) and the later events arrive.
- **`turn/start` on a thread whose turn is running does not start a second turn.** It answers with the running turn's id and the text joins that turn, like a steer. So the receiver waits for idle on purpose; if a turn starts between its check and its call, the message enters that turn, and the ACK is matched on that turn's id.
- `turn/completed` carried `status: "interrupted"` after `turn/interrupt`, and `thread/status/changed` went to `idle`.

## Not verified

- A real model turn: the ACK line, `turn/completed` `completed`, and the card showing "Codex replied".
- The shared daemon started by `codex app-server daemon start` (os error 5 here), and a Codex TUI joined to it.
- An approval-needing command while the receiver is joined: whether the daemon also waits on the board's connection, or only on the person's own client. The receiver never answers an approval request; whether that stalls the person's approval is not tested. **Do not treat this as safe until it is.**
- `thread/queue/delete`: the receiver uses no queue.
- Windows hard kill on a real proxy (the mock ends with its stdin; the real proxy was not killed this way).
- Linux and macOS; the Codex desktop app.

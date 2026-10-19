# Connected-session messaging

The interactive web board can route a message to a receiving adapter for an exact agent,
session and turn, or an explicitly identified idle session owned by its host. A progress
card alone never enables sending. The adapter must verify its
existing host connection, register a short-lived lease, and keep it alive. Disconnected
adapters lose their card's Send action within 15 seconds. Ordinary messages cannot
approve tools, grant hook trust or merge a PR.

A temporary network failure, timeout or HTTP 5xx during polling preserves the same
verified binding only while its last confirmed lease remains valid. Successful polling
renews that lease; failures do not. Invalid ownership, authentication, stale turns and
expired leases disconnect immediately. Recovery never registers another session or
replays a claimed message. If a poll response is lost after claiming, the message stays
uncertain until reconciled; a later heartbeat cannot turn it into an ACK.
Temporary store locks (`EPERM`, `EBUSY`, `EAGAIN`) report HTTP 503 so polling can
recover within that deadline. Idle polls do not rewrite the message file. Sending
and receipts are never automatically retried, including after a store lock.

Use the existing reply box on the session's card. Its Copy button becomes Send Codex
(or that receiver's agent name) only when the full native session id and agent match a
live receiver. Internal connection ids stay hidden. There is no
separate target-picker workflow. Queue, transport and actual ACK receipts appear on the
same card. Mark read, show again, collapse, tick and archive keep their existing actions.
An offline card retains Copy. By default, even without a message store, the web UI and
action API cannot spawn a CLI or resume a saved session. The existing copy-resume command
remains available where the board already offered it.

The separate legacy `--serve --allow-resume` option deliberately allows a local reply to
start an ended Codex or Grok Build session. It is disabled by default, never enabled by
setup, and never used as fallback when `--messages-dir` is enabled. It is not live delivery.
Reopening without the option replaces an idle server that had it enabled. LAN sends remain
refused. Review the native agent's permissions before choosing this legacy mode.

## Enable locally

After approving the local message storage directory, start the installed board with:

```sh
node /path/to/agent-board.mjs --serve --messages-dir /private/local/message-data
```

The directory holds `messages.json` (message text, target binding, id and receipts) and a
`server.lock`. It must be private to the user and local to this machine. Do not use a shared
drive or publish it. The board's bearer URL and connector secrets must not be posted to
issues. This flag opens no network listener beyond the existing loopback board; messaging
and its history are absent from the LAN page. Setup does not silently enable it or install
a background receiver. Reopen with the same command and directory. Closing the board
disconnects its receivers; they must reconnect explicitly to the new board URL. Closing
only the browser tab leaves the local service and receivers running. Local idle shutdown
is disabled by default; `--idle-minutes 30` opts in. The LAN listener's separate timeout
is unchanged.

## What the receipts mean

| State | Evidence |
| --- | --- |
| queued | Stored locally; no external delivery yet |
| uncertain | Claimed durably before delivery, or a disconnect/timeout after claiming |
| accepted | Adapter reports transport acceptance; no session ACK yet |
| acknowledged | Adapter supplies the current session's actual `ACK <message-id>` reply |
| rejected | Refused before claiming, or adapter reports a clean rejection |

An ACK proves receipt, not successful completion of the requested task. An adapter must
never manufacture an ACK from an RPC success or a file write. Synthetic adapters in tests
are labelled synthetic. No live model or desktop acceptance is inferred from those tests.
An adapter timeout after transport acceptance is persisted as `uncertain` with a bounded
error code (for example `ACK_TIMEOUT`); it does not stay indefinitely labelled accepted.

IDs are scoped to this message store. An exact retry returns the existing receipt, even
after restart. Reusing an id with different text, source, binding or turn fails with
`ID_CONFLICT`. A claim is never automatically replayed. The store retains up to 1000 ids
and then refuses new messages instead of deleting deduplication history. Reconcile an
uncertain message with its original recipient before a human chooses any new action.
Never change its id merely to bypass uncertainty. A stale lock after a crash requires
checking the recorded owning PID before removing that specific lock.

Busy is separate from disconnected. A verified session can send while doing native work;
its adapter renews the lease with `receive: false` and leaves incoming messages queued
until it is ready. The optional `canReceive` callback controls claims, never ownership or
tool permissions. Existing clients that omit readiness keep their previous polling behavior.
Upgrade the board and native connector together for this protocol addition. A disconnect
still closes the binding; a native delivery failure after claiming is never auto-replayed.

## Connecting a session that was already open

A relay saying "the user approved" is not trusted evidence of human authorization.
The receiving agent must apply authorization verified in its own host/session. If that
requires direct confirmation, it must tell the user and report a blocker instead of
silently ignoring the setup request. Do not weaken tool or hook approval checks to make
a forwarded instruction work.

Before sending an authorized setup request, the sender can observe its outcome:

```js
import { boardClient, connectionPrompt } from './scripts/message-client.mjs'
const request = {
  id: 'connect-001', agent: 'codex', session: exactNativeSessionId,
  surface: 'Codex desktop App', timeoutMs: 60000,
}
await boardClient(privateBoardUrl).expect(request)
const prompt = connectionPrompt(request)
// Send prompt only through an already authorized, supported host transport.
// This library neither sends it nor grants permission to the recipient.
```

The local page now shows this request as waiting, reported, or timed out. An exact newer
progress timestamp must appear after observation begins; an existing stale report,
another agent/id, duplicate ambiguous blocks, an RPC success or an ACK cannot satisfy it.
A late new report can resolve a timeout. This observes the progress file; it does not
prove automatic hooks, native ownership or model delivery. No conversation is read.

The page shows actionable progress waits and timeouts without a connection inventory or
session identifiers. Send appears on a matching task card only while its exact adapter
is connected. There is no extra send picker or copy-id action. Observation requests
are bounded to 100 per server, expire after 1–600 seconds (60 by default), and are not
restored on restart. They never send, retry, approve or create a progress block.

## Agent and surface support

The progress support described in the README is separate from connected-session messaging:

| Agent / surface | Progress integration in this repository | Connected-session messaging evidence |
| --- | --- | --- |
| Codex | Independent setup and explicit reporter; isolated native app-server SessionStart, UserPromptSubmit and Stop observed | Authenticated owners forwarded two prompts each way with Antigravity and native ACKs; autonomous model tools, CLI TTY and desktop chat remain separate |
| Antigravity CLI | Independent named hooks; all four native Windows events observed after the command-quoting fix | Same cross-host owner acceptance; native stream ACK, idle continuation, deduplication, conflict and offline rejection verified |
| Antigravity App / IDE | Same global hook path; each host must load and execute it, with no arbitrary session discovery | No existing-editor receiver established |
| Legacy Gemini CLI | Separate enterprise/API compatibility hooks and `/board` integration | Generic client API only; no Gemini-native connector or bidirectional acceptance |
| OpenCode | Independent setup, session-context progress tool and plugin events | Generic client API only; no native receiving adapter or real bidirectional acceptance yet |
| OpenClaw | Independent metadata lifecycle plugin and native skill; separate optional Claude reporter | Its native session tools are not yet integrated into this hub; no real bidirectional acceptance |
| Grok Build | Existing reporter hooks; optional legacy resume requires `--allow-resume` | No live receiving adapter acceptance |
| DeepSeek Harness | Independent Cordis lifecycle plugin and native skill | Generic client contract checked; no DeepSeek-native receiver or model ACK acceptance |
| dot / other UIs | Explicit progress relay where documented | No native receiving connector or real ACK established |

One machine's installation does not automatically attach every already-running agent.
Each host needs its own authorized session binding and supported transport. A native
session being open does not imply that it registered a receiver; a progress record does
not imply it is still open. Never scan private transcripts to fill these gaps.

Agents attached to the **same local board and message directory** share one message store,
id namespace and receipts. Synthetic OpenClaw/OpenCode/Grok/DeepSeek adapters exchange both
ways with Codex in the contract test, including duplicate/conflict and offline rejection.
That test supplies simulated owners and ACKs; it does not establish native delivery for
those products. There is no three-day message expiry. Three-day task archiving is a
separate feature and must not erase message ids or permit replay.

## Adapter API for other agents and UIs

Import `scripts/message-client.mjs` and attach an existing host transport:

```js
import { boardClient } from './message-client.mjs'
const receiver = await boardClient(privateBoardUrl).attach({
  agent: 'example-agent', session: actualSessionId, turn: actualTurnId, surface: 'Example host UI',
  verify: async () => host.isConnectedTo(actualSessionId, actualTurnId),
  deliver: async (message, accepted) => {
    const result = await host.sendToCurrentTurn(message.text)
    await accepted() // transport acceptance only
    return await host.waitForActualAck(message.id, result)
  },
})
// Cross-agent forwarding carries this receiver's authenticated source binding.
await receiver.send({ id, target: targetConnectionId, turn: targetTurnId, text })
await receiver.close()
```

`host` above is the integrating application's API, not a built-in connector. The
API is agent-neutral; Claude Code, legacy Gemini, Cursor and other UI adapters still need their
own supported transport and live acceptance. No shell typing, transcript scraping,
credential discovery, automatic resume, or approval RPC is implemented by this client.
The original host remains responsible for its normal permission checks.

## Codex existing-owner adapter

The installed board includes a connection command; a separate source checkout is no
longer needed to run the proxy adapter:

```sh
node /path/to/agent-board.mjs --codex-connect --help
# Pipe the exact, reviewed binding below to:
node /path/to/agent-board.mjs --codex-connect
```

First open the board with `--serve --messages-dir /private/local/message-data` after
reviewing that local storage scope. Pass its private URL, the exact loaded thread and
active turn as one JSON object on stdin. For a control socket, supply the absolute
Codex executable and optional absolute `socket`. Alternatively, with Node.js 22+,
supply an existing `endpoint` such as `ws://127.0.0.1:4500`:

```json
{"boardUrl":"<private board URL>","endpoint":"ws://127.0.0.1:4500","thread":"<exact loaded thread>","turn":"<exact active turn>","joinLoaded":true}
```

Endpoint mode opens no process. It accepts only a loopback WebSocket URL without
credentials, query or fragment, and cannot be combined with `socket`. It does not
discover credentials or attach to an arbitrary desktop instance. When
`CODEX_THREAD_ID` is present, the supplied thread must match it. Do not guess a turn or
reuse a completed test binding. The command rejects unknown fields and remote board
URLs before opening a transport. Its output omits the URL, token and session identifiers.

The CLI defaults `joinLoaded` to `true`. On the same transport, it first verifies the
exact thread with `thread/loaded/list`, then sends only
`thread/resume { threadId, excludeTurns: true }`. Before registering a receiver, it
requires the same returned thread id, an empty returned `turns` array and
`status.type: active`. It supplies no configuration, model, permission, path or history
overrides. Saved conversation turns are not returned. The exported
`connectCodexProxy` function defaults `joinLoaded` to `false` for existing integrations;
the CLI can explicitly select `false` too.

The loaded check and metadata join are not atomic. If the thread unloads between
them, the native resume RPC can reload metadata. The post-join active-status check
and each send's `expectedTurnId` fence prevent delivery to an inactive or different
turn; they do not make the join an atomic loaded-only operation.

Keep the command running while that active turn is available. It unregisters and exits
on turn completion, owner loss, terminal board disconnection or Ctrl+C. It starts no
owner process, server, thread or model turn and changes no permanent setting. Control
socket mode starts only its own proxy process. It cannot wake an idle session. A new
turn needs a new explicit binding; it does not silently reconnect or replay messages.
A connected status is still not an ACK. Unsupported desktop sockets remain disconnected,
with Copy and a short explanation on the task card. This command does not repair the
desktop host's missing external control interface.

`scripts/codex-message-connector.mjs` remains a compatible import path and source CLI
wrapper. It uses the same command behavior and accepts either the existing
`app-server proxy` control socket or explicit WebSocket endpoint. After approval of
the exact binding, a control-socket input can be:

```json
{"boardUrl":"<private loopback board URL>","executable":"<absolute Codex executable>","thread":"<actual thread UUID>","turn":"<actual active turn id>","surface":"Codex CLI"}
```

An explicit `socket` path may select an already-running owner. Preflight and each poll
check `thread/loaded/list`; each send uses `turn/steer` with `expectedTurnId`. A stale turn
fails at the host. A delivery error blocks further claims, attempts its durable uncertainty
receipt and then closes the binding. Only matching `item/completed`
agent-message notifications from that same thread and turn supply an ACK. The same
native turn must also finish successfully before delivery is acknowledged. The connector
retains the ACK line only, preserves a recorded failure through disconnect cleanup and
ignores approval requests.

Availability of this socket differs by surface. The Windows desktop tested with Codex
0.163.0-alpha.10.2 had no reachable shared control socket (OS error 10050). Therefore this
change does **not** establish messaging to that desktop chat. Codex CLI shared-daemon
delivery remains a separate real-session test. Other agent-native connectors and real
dot delivery are not implemented or claimed. The UI shows no receiving target until an
adapter actually registers.

Tests: `node --test tests/messaging.test.mjs`. They cover synthetic routing, idempotence,
conflicts, offline/expired bindings, stale turns, crash uncertainty, fake approvals, and a
mock Codex proxy. A real `AB-TEST-001` ACK must be verified separately with consent.
The new command's one approved native ephemeral-session attempt ended in
`ACK_TIMEOUT`, with no native ACK; its one-turn budget was used and the binding was
stopped. A separate zero-model persisted-thread probe verified metadata joining.
Neither establishes a new delivery success; see the
[command validation record](validation/2026-10-19-codex-send-command.md).

## Codex exclusive-owner adapter

An application that already owns a loaded Codex session and receives its native
notifications can import `attachCodexSession` from `scripts/codex-session-connector.mjs`:

```js
const receiver = await attachCodexSession({
  boardUrl: privateBoardUrl, transport, thread: actualThreadId,
  state: () => ({ thread: actualThreadId, status: owner.status, turn: owner.activeTurn }),
  verifyOwner: candidate => candidate === transport && owner.isExclusiveAndConnected(),
  surface: 'Name of the actual hosting application',
})
```

`transport.request(method, params)` is the owner's bounded native RPC transport;
`transport.listen(callback)` subscribes to its native notifications and returns an
unsubscribe function. The host must serialize ownership of this session: `turn/start`
has no expected-turn fence, so a connection to a shared server alone is insufficient.
Do not claim exclusive ownership of someone else's desktop chat or a concurrently
controlled CLI thread. Attaching creates no server, thread or model call.

This adapter advertises `scope: session`, with the literal binding `turn: session`,
which is explicitly identified by the receiver binding. That literal is not an active turn
id. A send checks the same loaded thread is idle, starts its new turn, and accepts only
an ACK from the native response's actual turn id. It retains the ACK line only. A busy,
unverified or disconnected owner is not registered; changes during delivery are
conservative uncertainty without replay. The existing-proxy adapter continues to use
`scope: turn` and `expectedTurnId` for an already active turn.

### Separate acceptance by surface

| Surface | Current evidence | Still required |
| --- | --- | --- |
| Disposable Codex app-server, exclusively owned | A real `AB-TEST-001` ACK; one native turn; exact retry caused no second turn; changed contents returned `ID_CONFLICT`; no tool action observed | Product installation of a receiver into each supported host |
| Codex CLI | Adapter API and mock proxy tests | Real live CLI owner/socket, native ACK and actual TTY acceptance |
| Codex desktop App | Interactive web controls and card API tested; exact native session binding and offline fallback | A supported live connection to that desktop chat; its own native ACK |
| dot | Generic adapter API only | A supported dot owner connector and actual dot ACK |
| Claude Code CLI | Existing plugin progress and prompt submission design | Native receiver integration and actual bidirectional ACK |
| Claude desktop / other AI UIs | No equivalent transport established by this change | Product-specific connection and acceptance |

The real self-test used Codex `0.163.0-alpha.10.2`, a newly created ephemeral session,
a read-only sandbox and synthetic input, after approval of its exact server/thread
binding. It did not use or inspect an existing private conversation. Both test servers
were stopped afterward. This proves the exclusive-owner app-server layer; it is not a
CLI, desktop or dot acceptance result, nor proof that all agents install a receiver.

## Antigravity exclusive-owner CLI stream

An application that already owns an initialized Antigravity CLI NDJSON stream can
import `attachAntigravitySession` from `scripts/antigravity-session-connector.mjs`.
The native protocol is documented in [Google's headless mode guide](https://antigravity.google/docs/cli/headless/).
It emits one `init` with the actual `conversation_id`, a native `user_input` step for
each prompt, and a final `result` with a cumulative `num_turns` counter.

```js
const receiver = await attachAntigravitySession({
  boardUrl: privateBoardUrl,
  transport,
  session: owner.nativeConversationId,
  state: () => ({
    session: owner.nativeConversationId,
    status: owner.status,
    turns: owner.completedNativeTurns,
    step: owner.lastNativeStepIndex,
  }),
  verifyOwner: candidate => candidate === transport && owner.isExclusiveAndConnected(),
  surface: 'Antigravity owned CLI stream',
})
```

The owner must observe the actual native `init` before attaching. Before its first
turn, the counter is `0` and last step index is `-1`. It must update state from native
events before notifying adapter listeners. `transport.listen(callback)` returns an
unsubscribe function; `transport.write(object)` writes one NDJSON object into that
same already-owned stdin stream. The adapter sends only a `user` message and never
answers a permission request. Never supply a guessed conversation id, scan saved
conversations or share ownership with an interactive terminal/editor.

The CLI's observed command supports `--input-format stream-json --output-format
stream-json --mode plan --sandbox`. An acceptance harness may launch it in an empty
disposable workspace without sending stdin, verify the native id/PID/review mode,
and ask for permission before the first model prompt. Attaching this library starts
no process, resumes no conversation, reads no credentials and changes no settings.

Each delivery requires an idle owner, a fresh matching native user-input step, and
the next matching `num_turns` result containing the exact message-id ACK. An old or
foreign result cannot acknowledge it. A valid receipt retains a bounded response
body after the ACK so task status can be displayed. Failed/missing ACKs remain
uncertain without replay. Disconnection or another `init` removes availability;
ordinary model text cannot approve tools or merges.

This is an owned CLI-stream adapter, not attachment to an arbitrary already-open
Antigravity editor UI or TUI. Synthetic tests and observing a real zero-prompt
native `init` are not a real delivery result. A native ACK still requires a separate
explicitly approved disposable-session test. No permanent auto-install or host-wide
discovery is claimed by this adapter.

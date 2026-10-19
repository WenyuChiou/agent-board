# Connected-session messaging

The interactive web board can route a message to a receiving adapter for an exact agent,
session and turn, or an explicitly identified idle session owned by its host. A progress
card alone never enables sending. The adapter must verify its
existing host connection, register a short-lived lease, and keep it alive. Disconnected
adapters lose their card's Send action within 15 seconds. Ordinary messages cannot
approve tools, grant hook trust or merge a PR.

Use the existing reply box on the session's card. Its Copy button becomes Send Codex
(or that receiver's agent name) only when the full native session id and agent match a
live receiver. The connection's actual host surface is shown below it. There is no
separate target-picker workflow. Queue, transport and actual ACK receipts appear on the
same card. Mark read, show again, collapse, tick and archive keep their existing actions.
An offline card retains Copy. When messaging is enabled, an offline Send cannot silently
fall back to spawning a CLI or resuming a saved session. The existing copy-resume command
remains available where the board already offered it.

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

The same status area lists live receiving adapters even when they have no progress card.
It shows progress presence and receiving availability separately. A disconnected receiver
disappears unless an explicit observation request remains; that request then says it has
no online receiver. There is no extra send picker or copy-id action. Observation requests
are bounded to 100 per server, expire after 1–600 seconds (60 by default), and are not
restored on restart. They never send, retry, approve or create a progress block.

## Agent and surface support

The progress support described in the README is separate from connected-session messaging:

| Agent / surface | Progress integration in this repository | Connected-session messaging evidence |
| --- | --- | --- |
| Codex | Independent setup and explicit reporter; isolated native app-server SessionStart, UserPromptSubmit and Stop observed | Authenticated owners forwarded two prompts each way with Antigravity and native ACKs; autonomous model tools, CLI TTY and desktop chat remain separate |
| Antigravity CLI | Independent named hooks; all four native Windows events observed after the command-quoting fix | Same cross-host owner acceptance; native stream ACK, idle continuation, deduplication, conflict and offline rejection verified |
| Antigravity App / IDE | Same global hook path; each host must load and execute it, with no arbitrary session discovery | No existing-editor receiver established |
| Gemini CLI | Existing AfterAgent / SessionEnd reporter hooks and `/board` integration | Generic client API only; no Gemini-native connector or bidirectional acceptance yet |
| OpenCode | Independent setup, session-context progress tool and plugin events | Generic client API only; no native receiving adapter or real bidirectional acceptance yet |
| OpenClaw | Existing reporter plugin and board skill, with documented version/restart requirements | Its native session tools are not yet integrated into this hub; no real bidirectional acceptance |
| Grok Build | Existing reporter hooks; legacy reply can resume an ended session | Resuming an ended session is separate from live delivery; no live receiving adapter acceptance |
| dot / other UIs | Explicit progress relay where documented | No native receiving connector or real ACK established |

One machine's installation does not automatically attach every already-running agent.
Each host needs its own authorized session binding and supported transport. A native
session being open does not imply that it registered a receiver; a progress record does
not imply it is still open. Never scan private transcripts to fill these gaps.

## Adapter API for other agents and UIs

Import `scripts/message-client.mjs` and attach an existing host transport:

```js
import { boardClient } from './message-client.mjs'
const receiver = await boardClient(privateBoardUrl).attach({
  agent: 'gemini', session: actualSessionId, turn: actualTurnId, surface: 'Gemini CLI',
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

`host` above is the integrating application's API, not a built-in Gemini connector. The
API is agent-neutral; Claude Code, Gemini, Cursor and other UI adapters still need their
own supported transport and live acceptance. No shell typing, transcript scraping,
credential discovery, automatic resume, or approval RPC is implemented by this client.
The original host remains responsible for its normal permission checks.

## Codex existing-owner adapter

`scripts/codex-message-connector.mjs` uses the installed Codex executable's existing
`app-server proxy` control socket. It does not start a daemon or create/resume a thread.
After a person approves the exact disposable server/thread/active-turn binding, give it
JSON on stdin:

```json
{"boardUrl":"<private loopback board URL>","executable":"<absolute Codex executable>","thread":"<actual thread UUID>","turn":"<actual active turn id>","surface":"Codex CLI"}
```

An explicit `socket` path may select an already-running owner. Preflight and each poll
check `thread/loaded/list`; each send uses `turn/steer` with `expectedTurnId`. A stale turn
fails at the host instead of resuming another session. Only matching `item/completed`
agent-message notifications from that same thread and turn supply an ACK. The connector
retains the ACK line only, and ignores approval requests. No saved history is read.

Availability of this socket differs by surface. The Windows desktop tested with Codex
0.163.0-alpha.10.2 had no reachable shared control socket (OS error 10050). Therefore this
change does **not** establish messaging to that desktop chat. Codex CLI shared-daemon
delivery remains a separate real-session test. Other agent-native connectors and real
dot delivery are not implemented or claimed. The UI shows no receiving target until an
adapter actually registers.

Tests: `node --test tests/messaging.test.mjs`. They cover synthetic routing, idempotence,
conflicts, offline/expired bindings, stale turns, crash uncertainty, fake approvals, and a
mock Codex proxy. A real `AB-TEST-001` ACK must be verified separately with consent.

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

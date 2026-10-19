# Installed Codex connection command

The installed board can now run the existing active-turn adapter with
`--codex-connect`. It accepts a reviewed exact binding on bounded stdin, using
either the existing Codex control proxy or an explicit loopback WebSocket endpoint.
Connecting starts no owner process, server, thread or model turn, approves no tools and
changes no trust. Proxy mode starts only its own control proxy. Endpoint mode starts
no process. Saved conversation turns are not returned.
Progress-only cards explain Copy in English, Traditional and Simplified Chinese.

## Metadata join correction

The CLI now defaults `joinLoaded` to `true`; the exported adapter defaults to `false`
for existing integrations. Joining checks the exact loaded thread on the same transport,
then sends only `thread/resume { threadId, excludeTurns: true }`. Registration requires
the same returned thread id, an empty returned `turns` array and active status. There
are no configuration, model, permission, path or history overrides.

Lookup and join are not atomic. An unload race can cause the native resume RPC to reload
metadata. The post-join active check and `expectedTurnId` send fence remain required;
this is not an atomic loaded-only resume guarantee. Delivery failure blocks claims,
attempts the durable uncertainty receipt and closes the binding, preserving its error
through disconnect cleanup. A matching ACK must be followed by successful native turn
completion; an ACK from a failed turn remains uncertain. No idle wake is added.

## Evidence before the metadata join correction

- **Focused Node: 4 passed, 0 failed.** Cases covered bounded/private input and help, terminal receiver
  close, bundled proxy command ACK/deduplication/conflict/offline refusal, and a
  bundled WebSocket command with pretty JSON, wrong-turn ACK and approval rejection.
  Both owners are synthetic; these results do not establish native model delivery.
- **Combined Node: 151 passed, 0 failed, 1 skipped**, 152 cases.
- **Offline plugin: 518 passed, 0 failed**, 10 files, 181.15 seconds.
- Strict standalone TypeScript including the board entry passed after adding its
  JavaScript module declaration. The first strict check correctly reported TS7016.
- Pinned Bun 1.4.2 generation and bundle check passed. Full SDK `tsc -p .` remains
  unrun because its generated plugin SDK is unavailable.
- A real Codex 0.163.0-alpha.10.2 control-only server on Windows accepted a WebSocket
  initialize and loaded-thread query. Its listener PID was verified, it contained
  zero loaded threads, no model was called, and the owned server was stopped.
- The current desktop instance's default proxy still fails with OS error 10050 and
  exposes no TCP listener. This change does not claim Send to that desktop chat.

These suite results predate the metadata join correction. Updated focused tests passed
**8/0**; strict standalone TypeScript and bundle generation/check passed. Combined Node
and plugin checks are running. The new focused run first exposed disconnect cleanup
overwriting the durable failure reason; both affected cases passed after preserving it.
The first pre-join focused
run exercised an old bundle and failed; its output is retained with the later green run.

## Native result and subscription diagnosis

The approved ephemeral-session experiment on native Codex 0.163.0-alpha.10.2 used its
maximum **one model turn** (`turnStartRequests: 1`). It produced **no native ACK** and
ended with an `uncertain` receipt carrying `ACK_TIMEOUT`; no unexpected tool use was
observed. The binding owned by server PID **59708** and all experiment endpoints were
stopped. That authorization budget is used; no retry or second model turn is included.
This was an isolated app-server WebSocket experiment, not desktop chat or CLI TTY
acceptance. Private evidence: `outputs/host-contracts/send-native-once-result.json`
and `send-native-once-prepared.json` in the parent workspace.

A separate **zero-model persisted-thread subscription probe passed**. The second client
initially reported `notSubscribed`; metadata-only `thread/resume` returned zero turns,
and the observed subscription state changed to `unsubscribed`. A normal synthetic
thread was seeded with `thread/inject_items`; official archive/delete operations
removed only that synthetic thread. The control server was stopped. An ephemeral
thread could not be joined because it had no rollout. This diagnoses why simply
listing a loaded thread did not establish notification delivery; it proves no new ACK.
Private evidence: `outputs/host-contracts/send-native-subscription-persisted.json`.

The command remains active-turn-only and closes at turn end. A new model ACK and
interactive CLI visibility still require separately authorized acceptance; the current
Windows desktop socket remains unsupported. Do not reuse the stopped binding or count
an accepted RPC as an ACK. No existing private conversation or credential content was
inspected, and no installed user setting was changed.

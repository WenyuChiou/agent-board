# Local exchange for Codex and dot

This optional interface lets an agent report selected progress and receive an
explicit message through local files. It requires Node 22.18 or newer (or
Node 24), which loads the contract's `.ts` file directly, and a cooperating
consumer. It does not install hooks, change global configuration, discover
sessions, export conversations or start a model. Existing turn reporting and
the Claude Code pane continue to work as before.

| Capability | Codex | dot |
|---|---|---|
| Explicit minimal progress report | File/CLI, tested | File/CLI, tested |
| Local message queue and receipts | Cooperating consumer | Cooperating consumer |
| Native running-session delivery | Host adapter; mock transport tested | Unsupported |
| Existing pane reply buttons | Submit to current Claude Code session | Submit to current Claude Code session |

`native: unsupported` in the CLI status is intentional. A directory binding
declares a cooperating recipient; it does not prove an app is connected.
The board buttons are not wired to this queue in this first implementation.

Codex's own `Stop` hook (set up by `/progress connect`) already reports its
completed turns to the board, and the pane's reply buttons submit to the
current Claude Code session, not to a running Codex session. dot has no
native connector in this plugin; this exchange is its only route. The Codex
adapter below accepts an owner connection that the host supplies and
verifies, and only steers a specified active turn: a new app-server or a
thread id alone cannot control an existing CLI or Desktop session.

## Try a disposable exchange

Run from a repository checkout. Choose a new directory whose parent exists.
Use only synthetic text until you explicitly choose to share real progress.
These examples use stdin JSON, including in PowerShell:

```text
node scripts/exchange.mjs init ./example-dot < init.json
node scripts/exchange.mjs report ./example-dot < report.json
node scripts/exchange.mjs status ./example-dot
```

PowerShell does not support `<` input redirection; use
`Get-Content -Raw init.json | node scripts/exchange.mjs init ./example-dot`
and the same pipeline for other inputs. For `status`, pipe `'{}'` on stdin
or close stdin. This CLI does not prompt interactively.

`init.json`:

```json
{"agent":"dot","session":"synthetic-dot-1"}
```

Use `"agent":"codex"` for the same cooperative contract. Session ids contain
only letters, digits, underscores and hyphens (up to 96 characters). The
generated binding id distinguishes a session from any later replacement.
Initialization refuses to replace an existing directory.

`report.json`:

```json
{"project":"Synthetic lab","title":"Check local exchange","context":"Synthetic data only","state":"waiting","steps":[{"status":"done","text":"Prepared fixture"},{"status":"waiting","text":"Continue?"}]}
```

Only `project`, `title`, `context`, `state`, `steps`, and optional `language`
(`en`, `zh-TW`, `zh-CN`; default `en`) are accepted. The background label uses
the board's existing language tables. Unknown
fields, including transcript paths, are rejected. Text fields are single-line;
states and step marks use the existing [progress format](FORMAT.md). No new
Markdown syntax or resume command is required.

`report` writes the exchange's `fragment.md`: a `## <project>` line and this
binding's one block. That is the same fragment every outside agent produces
([Remote reporters](REMOTE_REPORTERS.md)), and the one way it reaches the board
is the merge script, which replaces only this block, and only with a newer
one, or places it under its project:

```text
python3 scripts/remote-reporter/merge.py ~/.claude/progress.md ./example-dot/fragment.md
```

The fragment is never the board's file: do not point `CLAUDE_PROGRESS_FILE` at
it, and do not point the exchange at `~/.claude/progress.md`. Each `report`
rewrites the whole fragment, so it refuses with `NOT_EXCHANGE_FILE` when the
file holds anything else (another block, a hand-kept task, a second project).

## Messages and receipts

Copy the exact `binding.id`, `binding.agent` and `binding.session` returned by
`init` or `status`. Pass this command to `enqueue`:

```json
{"version":1,"id":"reply-1","binding":"REPLACE_WITH_BINDING_ID","agent":"dot","session":"synthetic-dot-1","text":"Continue with the synthetic check","turn":""}
```

The receiver calls `take` with the same target:

```json
{"id":"reply-1","binding":"REPLACE_WITH_BINDING_ID","agent":"dot","session":"synthetic-dot-1"}
```

Only a `claimed` result includes text for delivery. It first writes an
`uncertain` receipt, before the receiver takes any external action. Another
consumer, a restarted process or a repeated invocation receives
`already-claimed` and must not deliver again. Re-enqueueing the same id and
same command is idempotent; changing its contents returns `ID_CONFLICT`.

After the recipient acknowledges receipt, call `ack`:

```json
{"version":1,"id":"reply-1","binding":"REPLACE_WITH_BINDING_ID","status":"delivered"}
```

`rejected` is the other terminal outcome. Terminal decisions cannot be changed.
`delivered` means the receiving transport/consumer acknowledged the message,
not that a model completed a task. A timeout, crash or lost acknowledgement
remains `uncertain`; reconcile with the receiver before doing anything else.
Never create a fresh id merely to resend an uncertain command. Interrupted
writes can leave `.lock` directories; inspect and reconcile them rather than
deleting them automatically. `status` lists them under `locks`, and
`enqueue` on a command whose lock has no file behind it fails with
`LOCK_HELD` and the folder's path. If a crash falls between writing the
terminal decision (`receipts/ID.json.decision`) and the receipt, the decision
wins: `status` reports it and repairs the receipt. This is conservative process-crash handling,
not a distributed transaction or a guarantee across power loss.

Use a private, local directory shared only with trusted cooperating processes.
This interface does not authenticate other local users, grant access to an app,
or support network shares, symlinked exchange directories or untrusted writers.
On Windows, check the directory's inherited ACL before sharing sensitive text;
POSIX creation modes alone do not enforce Windows ACLs.

## Codex owner adapter

`scripts/codex-owner.mjs` exports `dispatchCodex(directory, target, transport,
verifyOwner)` for embedding applications. There is deliberately no command
that opens a socket from an arbitrary URL or saved thread id.

The host must supply an already established authenticated connection to the
app-server that owns the running thread. Its `verifyOwner(transport)` must
verify that connection's identity and authorization, and must finish within
the host's timeout. A boolean read from a binding file, a new app-server,
`codex resume`, a transcript path or terminal injection is insufficient.

The transport advertises `methods` and implements `request(method, params)`
returning the decoded JSON-RPC result. Before it claims the command, the
adapter runs the verifier, checks for `thread/loaded/list` and `turn/steer`,
and enumerates loaded threads on the same connection. If any of that fails it
returns `not-sent` and the command stays queued, so a thread that loads later
can still receive it. After the claim it checks again immediately before
sending. A failure after the claim but before the steer request goes out
(the owner went away, or the command has no active turn) is acked
`rejected`, a terminal receipt. Only a failure during or after the steer
request, or while writing the receipt, leaves `uncertain`. Set the command's
`turn` to the active turn id obtained by that host. It sends only:

```json
{"method":"turn/steer","params":{"threadId":"synthetic-session","expectedTurnId":"turn-1","input":[{"type":"text","text":"Explicit user message","text_elements":[]}]}}
```

The expected-turn precondition protects against a turn changing between
inspection and delivery. Idle delivery is unsupported: `turn/start` may steer
an active turn after a race. Requests time out after five seconds. A steer
request that times out leaves the receipt uncertain, since the request might
still complete.

The installed Codex 0.160.1 offline help/schema advertises these protocol
methods and the required `expectedTurnId`. Schema generation timed out after
writing partial output, so this is capability inspection, not proof of live
compatibility. No supported owner connection to an existing CLI/Desktop was
established during development. The adapter is mock-tested only and fails
closed without a verifier, advertised methods or the loaded thread.

## Validation and live acceptance

```text
node --test tests/exchange.test.mjs
```

The tests create and remove synthetic directories. They cover reporting,
wrong targets, duplicate ids, competing consumers, immutable receipts,
uncertain delivery and a real CLI file round trip. No test calls a model.
`claude plugin test .` does not run this file; run it with Node 22.18+ or 24.

To validate a live end-to-end integration, explicitly authorize a dedicated
synthetic recipient and message, establish its supported owner connection
(or a dot consumer that explicitly polls this directory), then verify the
received text and receipt. Approve any hook installation separately in
Codex's `/hooks`. Do not infer success from a queue file or a mock receipt.

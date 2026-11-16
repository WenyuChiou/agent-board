# Connected-session messaging

The interactive web board can route a message to a receiving adapter for an exact agent,
session and turn, or an explicitly identified idle session owned by its host. A progress
card alone never enables sending. The adapter must verify its
existing host connection, register a short-lived lease, and keep it alive. Disconnected
adapters lose their card's Send action within 15 seconds. Ordinary messages cannot
approve tools, grant hook trust or merge a PR. A tool approval has its own route: Claude
Code's `PermissionRequest` hook asks the local page, and only a press on the page the board
opened itself can answer it. A message, an agent's MCP or CLI tool, or the page on the
network never can ([SECURITY.md](../SECURITY.md#approvals-on-the-board)).

A temporary network failure, timeout or HTTP 5xx during polling preserves the same
verified binding only while its last confirmed lease remains valid. Successful polling
renews that lease; failures do not. Invalid ownership, authentication, stale turns and
expired leases disconnect immediately. Recovery never registers another session or
replays a claimed message. If a poll response is lost after claiming, the message stays
uncertain until reconciled; a later heartbeat cannot turn it into an ACK.
Temporary store locks (`EPERM`, `EBUSY`, `EAGAIN`) report HTTP 503 so polling can
recover within that deadline. Idle polls do not rewrite the message file. Sending
and receipts are never automatically retried, including after a store lock.

Use the existing reply box on the session's card. A matching receiver enables Send or
Queue only when the route for its session state and the surface it registered or enrolled as has a live
record; clients that share a surface share that record. When the state
or route is unknown, the card offers Copy. One known gap: a Codex hook can read which client
started a session, not which client runs a turn, so a terminal session continued in another client
that leaves no mark in the hook's environment can keep the terminal's Queue; whether a message
queued there reaches the model has no record (see the Codex CLI record's "Not covered"). A mailbox
last enrolled by a Codex terminal hook that carries the Windows background service's mark gets no
Queue. Internal
connection ids stay hidden. There is no
separate target-picker workflow. Queue, transport and actual ACK receipts appear on the
same card. Mark read, show again, collapse, tick and archive keep their existing actions.
An offline card retains Copy. By default, only a recorded background-resume receiver
(`reopen`, under [Background resume](#background-resume)) or an explicit `--allow-resume`
opt-in may run an AI's own resume command from the local board; the LAN page and
unrecorded routes keep Copy. The existing copy-resume command remains available where the
board already offered it.

The direct message API applies the same recorded-route check to board sends. A mailbox
is refused rather than redirected when a live receiver of the same session has a recorded
route, for the session's state and on its own surface; a live receiver without one leaves
the mailbox's own route in place, on the card too. An unrecorded route returns
`NO_RECORDED_ROUTE`, unless the target is refused first as gone or expired
(`OFFLINE`) or contested (`CONTESTED`). Retrying an existing message id returns that message
when its contents match, even if the route has since changed. The server records the route
line itself; callers cannot supply `line`.

## Next-turn mailbox

A turn-start hook can enroll its session only when the default messages folder already exists.
The page can queue a message for that exact session without waking it. A later turn-start
hook of that session can claim one message, the oldest it is allowed to take. A message the page
queues is saved with the surface its route was checked on. A hook that reads another surface does
not claim such a message; the session's own MCP pull (`board_inbox`) still can. One known gap (#1405):
no hook of the other surface takes such a message, and nothing rejects it for that, so it can stay
queued until the mailbox expires or, where the agent's hook reports it, the session ends (below).
After an upgrade this can catch an agy TUI session that an earlier release's hook enrolled as `IDE`:
a message queued for it then is saved for `IDE`, and from its next turn the hook enrolls it as
`agy TUI`. A message saved
without a surface, by an older board or from another agent's session, is not held to one.
A turn-start hook marks a message `accepted` only after it has written the message to its output
for the host; that does not prove the model read it, and the hook collects no ACK. A hook that
stops waiting can hand its claim back, and a claim handed back is queued again. A claim the hook
named that is still uncertain with no error can be handed out again after 30 seconds, with the
same ACK code and a line saying it may be a repeat: at most three times for one message (a claim
after a hand-back does not count), and not while it has an error (`EXPIRED` and `DISMISSED` are
final; a later receipt from the session can clear a disconnected mark). That includes a message a
hook accepted if a later receipt from its session made it uncertain with no error, and such a
message can also be handed back; the board's own receivers send `uncertain` only with an error, so
this takes another client (#1407). While a claim stays open as uncertain (not yet `EXPIRED` or
`DISMISSED`), none of the session's queued messages is handed out. A claim is taken again only when
every message that holds the session (the condition is under "stdio MCP") is one of this mailbox's
claims that can be handed out again (above); then a
later hook whose surface the claim allows, or the session's `board_inbox`, can take the oldest of
them it may take, when the mailbox is not contested and its request succeeds. An open uncertain
claim left more than 30 minutes without an update expires the next time the store is loaded or saved
(the board tries a save at every action and snapshot); an expired or dismissed one no longer holds
the session. A `board_inbox` claim is never handed out again.
OpenCode's claims follow the rules below instead of the 30-second hand-out and the 30-minute expiry.
A receiver that runs inside the host (OpenCode, DeepSeek) waits up to two seconds for a busy board or store, where a
turn-start hook waits well under a second. A take that still fails is reported as a failure, not as an empty mailbox.
OpenCode's receiver asks the host whether the session is idle before each take and hands a claim back when the session
turns busy, so a long turn does not use it up.

OpenCode's wake costs a model turn, so the board promises at most one wake per message. Its plugin tells the board a
wake is about to start (`--mailbox attempt --ref`, answered only for the current claim) before it calls the host, and
from then on the board never hands that message out again, whatever happens to the host call.

A message left waiting after a lost answer or a failed lookup goes out at the session's next event, the next board write,
or the plugin's 30-second tick, whichever comes first, if the session is idle then. No step of the plugin keeps a timer
of its own for it. The plugin keeps no copy of what a session owes the board: at each tick it reads the board's file and works
it out for each session it knows, so an answer to an open or a take never says "done". A session owes a mailbox when the
file holds none for it, or less than the lifetime (12 hours) minus ten minutes of its time is left, and it owes a take when
a message is queued, or claimed and not marked as a wake, for it. A session that owes nothing, and no step to the board,
costs no question to the host, and no board call once the board has accepted the text of the file the plugin read: until
then one `--mailbox verify` call, which claims and writes nothing, asks the board about that text. If the board refuses the text, or the call fails or does not answer, the session is treated as one whose
file could not be read: a busy one sends `--mailbox open` and asks the host whether it is still busy (taking if it is not), and an idle one
asks the host and then takes. One that owes something, or whose file could not be read (no folder known
yet, a link or anything but a real folder at the board's path, a file it cannot read), asks the host and the board again. Only an idle session takes, and a take also opens or renews
the session's mailbox. A busy session opens or renews it with `--mailbox open` instead, which claims nothing, so the board
can queue a message for it during that turn (its first event is often `chat.message`), and so a turn longer than 12 hours
keeps it; the answer names the board folder to watch, and says `enrolled: false` while no folder exists yet.
Only a missing folder (nothing at that path) reads as empty, for a take, an open and an end alike; a link, a file in its place
or any other failure is logged as a failure.
A claim the plugin did not mark is handed to the next take from the same mailbox at once, without waiting for its
30-second lease, and the old ref then answers `CLAIM_LOST` to an attempt; the lease still gives it back to queued, as often
as needed, with no repeat line, and it is never expired while the mailbox is open. A session the plugin does not know yet
is written down before its metadata lookup is awaited; if that lookup fails, throws or never answers, or the session's
progress report fails, the tick makes them again through the plugin's own path, so the session also gets its card, up to
20 times, and a session given up is logged once. This receiver implements receiving only: sending from OpenCode is #1413.

The plugin takes a marked message back (`--mailbox release --unsent`) in three cases: the host answered 400 or 404, which
proves it was not sent; the session changed after the attempt was saved, before the host was called; and an attempt
the board did not answer `ok`, whether or not it saved the mark, since the host was never called. Any other error answer
or a call that never answered may come after the turn started, so the message stays a started wake. A release that failed
is owed to the board and asked again at each tick, but only for the wake's first 30 minutes: once it reads "sent, not
confirmed" the board answers `NOT_HELD` and never hands it out again, since you may have copied and sent it yourself.

A started wake the host never confirms (the model's `agent_board_ack`), and one the host took with a 204 answer that the
model never acknowledged, read "sent, not confirmed" on the card after 30 minutes and keep their text, so you can copy it;
an accept or an ack that comes later is still taken. From then on the message no longer holds the session's next message,
and a day later it expires like any other open message and its text goes. A repeated `attempt` is answered ok only while the message is
still an active started wake. Each workspace the host loads the plugin for has its own receiver. `release` answers
`NOT_HELD` for a ref the board does not hold and `WAKE_STARTED` for a marked one without `--unsent`; `end` answers
`ok: false` with a code when its write fails, and the tick asks again, a few times. The plugin reads no message of the
conversation to decide any of this.

A mailbox normally expires 12 hours after it was last enrolled or renewed; the session's hooks and MCP tools (such as `board_inbox` and `board_status`) can renew it, and session end can remove it sooner. A session-end hook that reaches the store removes the mailbox and rejects its queued messages with `DISCONNECTED`.
Storage and connection failures leave progress hooks running normally. Hooks never create
the messages folder and only find the default one; a board using `--messages-dir` with another folder has no hook mailboxes.

Supported turn starts: Codex `SessionStart` / `UserPromptSubmit`, Antigravity
`SessionStart` / `PreInvocation`, Muse Code
`UserPromptSubmit`, and Cursor `sessionStart` (never `beforeSubmitPrompt`, which Cursor
ignores, so a Cursor message waits until that chat opens again and its card says so). End events
are `SessionEnd` for Codex and Muse, and `sessionEnd` for Cursor.

The separate legacy `--allow-resume` option deliberately allows a local reply to
start an ended Codex or Grok Build session. It is disabled by default, never enabled by
setup, and works for closed sessions even with the message hub running. It is not live delivery.
Reopening without the option replaces an idle server that had it enabled. LAN sends remain
refused. Review the native agent's permissions before choosing this legacy mode.

## Background resume

For CLIs that have no external wake transport into an already-open session, a board message
can run the AI's own resume command in the background (`reopen` route via the shared helper in
`scripts/background-resume.ts`): `<ai> <resume flag> <conversation> <message>`. It reads the
reply and the exact `ACK <code>` line from stdout and records the message receipt. Every
background-resume receiver is bound by the owner's five limits:

1. **Loopback only**: accepted only from the local board page on this computer (`127.0.0.1` /
   `localhost`); requests off loopback or over `--lan` are refused.
2. **Default permission mode only**: runs in the AI's own default permission mode and refuses
   permission-widening or auto-approval flags (`--yolo`, `--full-auto`, `--dangerously-*`,
   `--bypass-*`, `--permission-mode`, `--approval-mode`, `--ask-for-approval`, `--sandbox`, etc.).
3. **Never mid-turn**: refused whenever the conversation has a turn running (`working` state, an
   in-flight background resume, or an unknown session state).
4. **One live record per AI before Send**: a card stays on Copy until a dated live run in
   `docs/validation/` verifies the `reopen` route for that AI and surface.
5. **Card wording**: before and after sending, the card explains that the turn runs in the
   background and to open the AI's window to see it there.

Each AI uses only routes permitted by its own terms and FAQ; the board never authenticates to
or calls a vendor API directly:

| AI / CLI | Background resume status | Policy / notes |
| --- | --- | --- |
| Antigravity (`agy`) | Planned (`#1396`) | The documented sidecar route, described below: setup writes its files only on the person's yes, and only the person enables it, in Antigravity's Automations page. `agy` background resume stays out of scope (FAQ / terms section 6). |
| Cursor (`cursor-agent`) | Planned (`#1403`) | Pending vendor terms review, receiver wiring, and dated live record. |
| Grok Build (`grok`) | Planned (`#1404`) | Pending vendor terms review, receiver wiring, and dated live record (separate from `--allow-resume`). |
| Hermes Agent (`hermes`) | Planned (`#233`) | Pending vendor terms review, receiver wiring, and dated live record. |

## Antigravity sidecar (#1396)

Antigravity's desktop app runs a sidecar kept in `~/.gemini/config/sidecars/agent-board/` (`sidecar.json`
and `sidecar.mjs`) only after the person switches it on in the app's Automations page. Setup writes
those two files only on the person's yes (the `--antigravity-sidecar` flag, or the one question that
defaults to no) and says that Google's terms may not cover it; it never switches the sidecar on, and an
agent must not. `remove` takes both files away. The agy TUI runs no sidecars, and a closed app stops them.
The sidecar touches no Antigravity sign-in, port or token: it uses only Antigravity's own `agentapi`,
whose path the app gives it, and it never sees a message's text. What the board does with it is under
"The board's half" below.

The contract, as the sidecar speaks it. It finds the board the way the hooks do, from `server.lock` and
`server.owner` in the messages folder; with no board it only checks those files every 30 s. While a board
answers it polls every 2 s. **Each poll is the board's sign that the sidecar is alive**; the board counts it as
on for 34 s after its last poll (below).

| Call | Body | Answer |
| --- | --- | --- |
| `POST /api/messages/wake-poll` | `{"agent":"antigravity"}` | `{"wakes":[{"id","conversation","nonce"}]}` |
| `POST /api/messages/wake-attempt` | `{"id","nonce"}` | `{"ok":true}`, or `{"ok":false,"code"}` |
| `POST /api/messages/wake-report` | `{"id","nonce","status":"sent" or "failed","error"?}` | `{"ok":true}`, or `{"ok":false,"code":"NOT_STARTED"}` |

For each wake the sidecar asks `wake-attempt` once and goes on only on `{"ok":true}`. It then checks that `conversation` is a UUID (one that is not is reported `failed`), and runs
`agentapi send-message --title=Agent Board <conversation> "Agent Board: a message from the board is attached to this turn. Follow it."`
(that is the English line; the sidecar sends the line in the setup language; one argument list, no shell, a 60 s limit). Exit 0 reports `sent`; anything else reports `failed` with a
short code. The turn-start hook then hands the queued message over as it does for any hook mailbox.

What each side may rely on:

- A wake's `id` and `nonce` match a message id, `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`. One that does not is printed
  as `INVALID_WAKE`; the sidecar asks nothing about it and runs nothing.
- The board, not the sidecar, promises at most one wake per message. Before it runs `agentapi` the sidecar asks
  `wake-attempt`; the board saves that the wake has started and only then answers `{"ok":true}`, once per
  message. From then on `wake-poll` never returns that message again, whatever happens to `agentapi` or to the
  report.
- The sidecar runs `agentapi` only on that answer. Any other answer (`WAKE_STARTED` for a wake already started,
  `NOT_HELD` for one the board does not hold), an error, or no answer runs nothing and reports nothing. It does
  not ask again.
- The sidecar keeps no record of wakes. A poll may return a wake it returned before, or the same wake twice, and
  a restarted or second sidecar may ask for it; the attempt decides.
- A wake handed out and never attempted may be returned by any later poll. The board returns at most one wake per
  poll; the sidecar handles every entry it is given, in order.
- A wake is tried once. One reported `failed`, or started and never reported, is not sent again; the message
  stays queued and the turn-start hook hands it over at the conversation's next turn.
- A report is repeatable: the same `id`, `nonce` and `status`. When a `wake-report` gets no answer, the sidecar
  sends the same body again, up to three times in all, a second or two apart. The board treats a repeated report
  of one wake as the same report and answers `{"ok":true}` again; a different `status` for a wake already
  reported does not change it. A report still unanswered after the third try is only printed
  (`report lost`), and that wake stays uncertain on the board: a card says the wake is unconfirmed, never
  delivered, and the message is not sent again unseen. A report for a wake that was never started is answered
  `NOT_STARTED`.
- Where the connector already manages Antigravity's hooks, setup still writes the two sidecar files, on the same
  yes, under a record of their own (`install-antigravity-sidecar.json`); it takes over none of the connector's
  hooks, and `remove` takes the sidecar files out.

### The board's half

- **Route.** While the sidecar is on, the desktop app's idle route is `now` (`hooks/receivers/sidecar-antigravity.ts`);
  otherwise the hook mailbox's `nextTurn` route stands, as it always does for agy TUI. The sidecar counts as on for 34 s
  after its last poll: one 30 s wait after a poll that got no answer, plus two 2 s polls (`SIDECAR_ALIVE_MS`), so one
  lost answer does not take Send away and a sidecar that stopped is no longer offered within about half a minute.
- **Which message.** `wake-poll` returns only a message the board sent on that route, still queued and never woken,
  for a mailbox on `IDE`, and only when it is the message the next turn's hook would take: a peer message or a claim in
  doubt ahead of it means no wake. The turn's state comes from Antigravity's own hooks, never from progress rows (a model
  may report waiting before its turn ends): the turn-start hook's take marks the mailbox busy, and the `Stop` hook calls
  `mailbox-idle` with its own time, which marks it idle at that time (a call the board answers late, after the next
  turn's take, still reads as before that take). A wake is due 10 s after a `Stop` later than the last turn start, and
  only while no wake of that conversation started since that `Stop`. A `Stop` call the board did not take (no board
  running, a busy one) records nothing, so nothing is woken and the next turn delivers. Progress rows can only hold a
  wake back: nothing is woken while the conversation's row reads working, or was written after the `Stop` (every hook
  event and every report restamps it), or carries no time. So a turn whose take never reached the board gets no wake
  started into it, even once the model reports waiting. Rows keep whole seconds, so a row written later in the
  `Stop`'s own second is not seen.
- **Not covered.** Between the board's yes and the sidecar's `send-message` call the person may start a turn, and a
  turn whose turn-start hook never ran leaves no mark; what the app does with `send-message` into a running turn is
  the live run's to record.
- **Attempt.** The board saves the start (`woke`, a field of its own; OpenCode's `attempted` rules never read it) before
  it answers `{"ok":true}`. The `nonce` is worked out from the message, so the board keeps none. The hook mailbox hands the
  message over in the turn the wake starts; a hook that hands its claim back puts the message back in the queue at once,
  for the next turn, and never to a second wake.
- **Report.** The first report stays. Until the hook hands the message over, the card reads that Antigravity was woken,
  could not be woken, is being woken with nothing confirmed yet (a start with no report), or that the sidecar is not on
  (a message sent for a wake whose sidecar has stopped).
- **Live run.** `docs/validation/2026-11-17-antigravity-wake-live.md` is pending, so the route's rows read Implemented.

## Local storage

Opening the installed board page (`agent-board`; `--serve` is the old spelling, still accepted) also starts its local message hub:

```sh
node /path/to/agent-board.mjs
```

The default store is `agent-board-<16-hex-board-hash>-messages` beside the board's address
file: on Windows, in an account-only `agent-board` child of `XDG_RUNTIME_DIR`, otherwise
`~/.cache/agent-board`; on other systems, in the account's own `XDG_RUNTIME_DIR`, otherwise
`~/.cache/agent-board`. The hash identifies the same progress file as
the address file. The directory is created with mode 0700. On Windows, a newly created
store and every default store are made your account's alone: the board makes your account
the folder's owner, removes inherited and other accounts' access, and reads the access
entries back (the owner is set, not read back). If it cannot, startup stops with
`MESSAGE_STORE_ACL`; if Windows takes too long to answer one of these checks, with
`ACL_CHECK_TIMEOUT` (try again once the computer is less busy). The page checks the default
store itself and hands it to the page's server, which only confirms it is still the same folder,
so a slow check does not use up the few seconds the server has to start. For a new or default
store, a board run as SYSTEM, LocalService or NetworkService always stops there: run it as a person's account. An existing folder supplied with `--messages-dir`
keeps its permissions; make that folder private yourself.
`--messages-dir /private/local/message-data` overrides the location;
`/api/ping` reports the actual `messagesDirectory`.

The directory holds `messages.json` (the text of open messages, a hash of each finished
one's text, target binding, id and receipts) and a
`server.lock` containing the owning PID. It also holds `server.owner`, the address of the
hub of the default folder, written once it listens and removed when it stops. A hub that
takes the lock first removes any `server.owner` left from before, so a hub never starts
beside a record written under an earlier lock. The folder is private like the address file.
A live owner, including one returning `EPERM` to the liveness probe, causes
`MESSAGE_STORE_IN_USE`.
A dead owner (`ESRCH`) or malformed PID is removed; lock creation makes at most three
attempts, including when another process removes the old lock during recovery.
PIDs outside 1..2147483647 are malformed.
For a legacy PID-only lock with no live or unknown ownership claim, the page using the
default folder waits up to 10 seconds for the owner's page.
If none appears and that hub no longer answers at the address beside the lock (nothing
listens there, or the program there refuses the hub's token or does not answer like a
board page, as any other program would), it treats the lock as left by a hub that was
killed: after a restart, its number can belong to another program. It moves the lock aside
once and starts the page. If the moved lock cannot be read, it is put back and no page
starts; if another page took the lock meanwhile, this one tries once more. A lock
with no such address (a hub still starting, a hub killed before it listened, or another
board using the folder through `--messages-dir`) and a folder given with `--messages-dir`
are never taken over this way, nor is one whose hub accepts its token or does not answer
in time.
If the message folder cannot open, the page names the folder and error code. For
any `MESSAGE_STORE_IN_USE` that remains, stop all board servers and inspect `server.lock`,
`server.owner` and `.message-claim-*.json` together. A valid lifetime claim whose PID is
live or cannot be checked blocks takeover even when its old port is closed; a reused PID
does not prove that the claim is stale. Remove only ownership metadata verified to be
stale, after confirming that no hub is running. Keep `messages.json` and uncertain
delivery evidence; do not resend uncertain messages. Permission errors ask you
to check that the folder belongs to your account and other accounts cannot open it. Other
store errors suggest moving a possibly damaged `messages.json` out before retrying.

Keep the store private and local. Do not use a shared drive or publish it. Any local
program that can read the address file or `server.owner`, which holds the same bearer URL,
can send with it; the board cannot identify the person pressing Send. Such a program can
also keep your sends refused: if it
registers a session, sends, claims the message and disconnects, over and over, each round
leaves a message in doubt for 30 minutes, and at one round every 1.8 seconds or faster the
store stays at `MESSAGE_LIMIT` until it stops. The connection cap does not stop it, since
each disconnect frees its place. It has to run as your account or an administrator; stop
it, and the store frees itself within 30 minutes. Connector secrets and URLs must not be posted to
issues. Messaging opens no listener beyond the existing loopback board; all LAN
`/api/messages/*` requests are refused and LAN board JSON omits messaging and receipts.
Setup installs no background receiver, with one exception: the Antigravity sidecar (below), which setup writes only on the person's yes and which Antigravity itself starts only after the person enables it. Reopen with the same command and directory. Closing the board
disconnects its receivers; they must reconnect explicitly to the new board URL. Closing
only the browser tab leaves the local service and receivers running. Local idle shutdown
is disabled by default; `--idle-minutes 30` opts in. The LAN listener's separate timeout
is unchanged. Receiver traffic under `/api/messages/*` does not refresh either page's
activity timer, so polling cannot prevent an opted-in idle shutdown.

## What the receipts mean

| State | Evidence |
| --- | --- |
| queued | Stored locally and not handed out since. A message an automatic Codex receiver left behind stays queued with the time it was left (see Codex daemon receiver). A message a hook handed back may already have been shown to its host: an earlier hook may have written it without its acceptance being recorded, or a later receipt may have made an accepted one uncertain (#1407) |
| uncertain | Claimed durably with no acceptance on record: before delivery, or after a disconnect or timeout. Also an accepted message that a later receipt reports uncertain (for a hook's message, #1407), or that expired or was dismissed |
| accepted | Adapter reports transport acceptance; no session ACK yet. Stays accepted across a disconnect (marked disconnected) and is not sent again while it stays accepted |
| acknowledged | Adapter supplies the current session's actual `ACK <nonce>` line |
| rejected | Refused before claiming, or adapter reports a clean rejection |

An ACK proves receipt, not successful completion of the requested task. An adapter must
never manufacture an ACK from an RPC success or a file write. Synthetic adapters in tests
are labelled synthetic. No live model or desktop acceptance is inferred from those tests.
An accepted delivery keeps waiting for its ACK after the adapter's initial timeout, until the
turn completes or the connection closes. A later ACK acknowledges the same message; a timeout
before acceptance keeps the earlier behavior.
When a later receipt makes an accepted delivery uncertain, the store retains the acceptance
so the page does not offer to send the answer again. Older uncertain records without that
evidence cannot be distinguished from deliveries that were never accepted.
An ordinary disconnect does not undo acceptance. When an accepted message expires, its
stored receipt keeps that evidence, including after restart. Its retained question stays
out of Needs you; the receipt still distinguishes delivery from a confirmed model reply.

### Message ids

- The client mints every message id: `AB-` followed by a random UUID, as the board page
  already does. Any id must match `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`.
- The hub never mints an id, and it refuses a send without one (`INVALID_ID`).
- A retry carries the same id, with the same target, turn, source and text, and gets the
  same receipt, even after a restart. A send never returns the nonce, so a retry after the
  message was handed out does not learn it either. Once the receiver acknowledges, the reply
  a send or the board returns is what follows `ACK <nonce>`, without that ACK line's prefix.
- Reusing an id with a different text, source, binding or turn fails with `ID_CONFLICT`.

IDs are scoped to this message store. A claim is never automatically replayed, except a hook's
mailbox claim as above. Before each action or snapshot, finished messages older than 24 hours
are deleted. Finished means
acknowledged, rejected, or uncertain with error `EXPIRED` or `DISMISSED`. A message drops its
text the moment it finishes and keeps only a SHA-256 hash of it (of the text as a JSON
string), which is what an exact retry is compared with, and the first 200 characters of its
reply; a repeated receipt is compared with those. Uncertain messages, accepted mailbox
messages, and accepted messages with an error become final `uncertain` / `EXPIRED` after
30 minutes. They no longer block delivery, are never handed out again, and reject later
receipts with `MESSAGE_EXPIRED`. A connected adapter's accepted delivery stays open while
it waits for the turn; after disconnect, the 30-minute limit applies. The page continues
to show expired messages as no reply confirmed. The one exception is a wake the OpenCode
plugin started: at 30 minutes it reads "sent, not confirmed" (`uncertain` / `UNCONFIRMED`)
instead, keeps its text and takes a late accept or ACK, and becomes `EXPIRED` a day later.
Only the board writes `UNCONFIRMED`; a receipt that sends it, like one that sends `EXPIRED`
or `DISMISSED`, fails with `INVALID_RECEIPT`.

The store holds at most 1,000 open messages (`MESSAGE_LIMIT`); finished ones do not count,
so a store full of finished messages still accepts new ones, short of the 2,000-record
ceiling below. It keeps the newest 1,000
finished messages; past that the oldest finished ones are deleted before their 24 hours,
so the file stops growing with the number of messages sent. Two kinds are never deleted by
that count, only after their 24 hours: a message that was handed out and then expired or
was dismissed, since it may have arrived and the page sends its id again, and each
session's latest delivery, which that session's next send takes its hop count from. Those
can still fill the file, so the store holds at most 2,000 records: past that, the ones older
than 30 minutes go too, each session's latest delivery before a message in doubt, and only
when none is that old is a send refused with `MESSAGE_LIMIT`, until one is. Deduplication ends when a record is deleted, and so does its part in
counting hops. Never change its id merely to bypass uncertainty. A temp file a hub left
when it was killed while saving is deleted at the next start, and a save that meets the file held for a moment by another program, as a
virus scanner can on Windows, tries again for up to about 0.2 seconds before the store
answers `MESSAGE_STORE_BUSY`.

The local hub accepts `POST /api/messages/dismiss` with only `{ "id": "<message-id>" }`,
using the board token and the same browser-origin rules as sending. No receiver secret
is needed; LAN requests are refused. On the page, only a Claude card's message has the
buttons: Take back while it is queued; Dismiss once it is handed over, or while it is
unconfirmed and not expired. A replied, stopped or expired message has neither.
Dismissing a queued message rejects it, so it is not handed out after that; a message a hook
handed back may already have been shown to its host (`queued` in the status table above).
An accepted or uncertain
message becomes final `uncertain` with error `DISMISSED`: delivery may already have happened,
but it no longer blocks the next message. Disconnect and restart preserve that result;
later receipts fail with `MESSAGE_DISMISSED`. A dismissed record drops its text at once, like any
finished message, and is deleted after 24 hours, or sooner under the limits above. Dismissing an already finished record fails with `MESSAGE_FINISHED`,
and an unknown id fails with `NOT_FOUND`.

Open messages are queued, accepted, or uncertain without `EXPIRED` or `DISMISSED`. Each target
`agent:session` permits at most three (`TARGET_BUSY`), and each source/target pair permits
one (`PAIR_BUSY`). An accepted mailbox message with no ACK marked as awaited ("stdio MCP") is not counted in either, nor is an OpenCode wake that reads "sent, not confirmed". Sourceless sends count as source `board`. The hub assigns `hops: 1`
without a source; an authenticated source inherits one plus the hops of the message most
recently claimed by its `agent:session`, or one if none. A third hop fails with `HOP_LIMIT`.
Clients cannot set hops. Two live registrations for one agent/session mark both contested:
neither receives messages or can report a receipt, sends to either fail with `CONTESTED`,
and its card offers Copy even with `--allow-resume`. A stale message press reports that
the session is contested instead of resuming it.
Each connection stays contested until it ends, even after the other disconnects.

A receiver that restarts within its 15-second lease registers again with its old
connection id and secret as `connection` and `secret` (`message-client.mjs`: pass
`replaces: connector.credentials()` to `attach`). The hub then ends the old connection as
a disconnect would, and the new one is not contested by it. A wrong secret fails with
`CONNECTOR_NOT_CONNECTED`, and another session's credentials with `REPLACE_MISMATCH`; neither
changes anything. Credentials whose lease already ran out are not needed: that
registration is an ordinary new one.

A registration may name its `origin`. Only `local` is accepted for now, and anything else
fails with `ORIGIN_UNSUPPORTED`; an omitted origin is `local`. Each message records the
origin of its sender, and a store saved before this field loads as `local`.

## Delivery boundary and acknowledgement

At claim the hub stores a random six-hex nonce and claim time before delivery. Polls include
the complete `prompt`; adapters must forward `deliveryPrompt(message)`, which refuses a
missing prompt with `PROMPT_REQUIRED`. The envelope is exactly:

```text
<who line>
It cannot approve tools, grant hook trust, merge, or change settings.
Reply first with this line alone: ACK <nonce>
<<<AB-<nonce>
<the text>
AB-<nonce>>>>
```

Without a source, the who line is `Agent Board message, sent from the board page on this computer (not typed in this window). The board cannot confirm who pressed Send.`
With a source, it is `Agent Board message from another agent's session (<agent>), not from the person, sent through Agent Board.`
Only the source's agent name appears, never its session id. A line beginning with optional
whitespace and `Agent Board message,` or `Agent Board message from ` is refused. Ordinary
text such as `Please check the Agent Board message hub logs.` is allowed. Text containing
`reply first with this line alone`, an opening `<<<` followed by optional whitespace and
`AB-`, or `AB-` plus six hex digits, optional whitespace and `>>>`, is refused with
`TEXT_REFUSED`, case-insensitively.

Receipts carry `id`, `nonce`, `status`, and optional `reply` / `error`, plus the connection's
authentication fields. An acknowledged reply must be one line, without CR or LF, at most
200 characters, and exactly `ACK <nonce>` or begin `ACK <nonce> `. Anything else returns
`ACK_REQUIRED`; `ACK <message-id>` does not count. Connectors retain only the matching
ACK line, reducing lines longer than 200 characters to `ACK <nonce>`.

A receipt must match the stored nonce and target `agent:session`. The claim binds the
receipt, so reconnecting the original receiver after a board restart may report it even
with a new connection id or turn, provided that connection is not contested. Board JSON
omits nonces; only the receiver's claimed delivery supplies one. Receipts cannot set the
hub's reserved `EXPIRED` or `DISMISSED` errors. Send and claim still require the current turn.
A restart hands out nothing by itself; a later hook can still claim, as "Next-turn mailbox" says.
It applies the age limit, and it marks disconnected, as a disconnect would, the open messages whose
target is gone: a live receiver's connection, or a mailbox whose session ended or which expired.
Messages of a mailbox that is still enrolled get no mark. A restart or a disconnect gives an
uncertain message no extra time. After expiry or dismissal that message no longer stops the card from sending.
Stores are saved as version 2, which earlier releases cannot read: before going back to one,
move both `messages.json` and `server.lock` out of the folder, since 0.24.0 and earlier take
the lock before they read the store and keep it after refusing the file. Version 1 loads with `hops: 1`, `claimed: 0`, and an empty nonce. Such legacy messages cannot
be acknowledged and expire under the age rule. A message saved without `origin` or `hash`
loads as `local` with the hash of the text it kept. A store that cannot be read gives its
`server.lock` back, so moving the damaged file aside is all a retry needs.

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

<!-- messaging-matrix:start -->

Generated from receiver records by `node scripts/messaging-matrix.mjs --write`. Progress reporting is separate. Verified requires a `<date>-<host>-live.md` file for that surface; synthetic tests only establish Implemented. Unconnected targets use Tier 4 / [P5] Copy fallback, not a native receiver. Unknown means the roadmap names no primitive for this surface. Idle, Working and Ended give the route for a session in that state: `now`, `stepEnd` (when its step ends), `nextTurn`, `chatOpen` (when the chat opens again), `reopen` or `none`, with the live note that showed it; the board offers Send only on a route with a note.

| Host | Surface | Tier | Primitive | Status | Live run | Receiver | Idle | Working | Ended |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Antigravity | 2.0 Desktop App | 3 | Unknown | Verified | [docs/validation/2026-11-13-antigravity-app-mailbox-live.md](../docs/validation/2026-11-13-antigravity-app-mailbox-live.md) | [hooks/receivers/hook-mailbox-antigravity.ts](../hooks/receivers/hook-mailbox-antigravity.ts) | nextTurn · [docs/validation/2026-11-13-antigravity-app-mailbox-live.md](../docs/validation/2026-11-13-antigravity-app-mailbox-live.md) | nextTurn · [docs/validation/2026-11-13-antigravity-app-mailbox-live.md](../docs/validation/2026-11-13-antigravity-app-mailbox-live.md) | none · no live note |
| Antigravity | 2.0 Desktop App | 1 | Unknown | Implemented | Not tested | [hooks/receivers/sidecar-antigravity.ts](../hooks/receivers/sidecar-antigravity.ts) | now · [docs/validation/2026-11-17-antigravity-wake-live.md](../docs/validation/2026-11-17-antigravity-wake-live.md) | nextTurn · [docs/validation/2026-11-13-antigravity-app-mailbox-live.md](../docs/validation/2026-11-13-antigravity-app-mailbox-live.md) | none · no live note |
| Antigravity | agy TUI | 3 | Unknown | Verified | [docs/validation/2026-11-12-antigravity-tui-mailbox-live.md](../docs/validation/2026-11-12-antigravity-tui-mailbox-live.md) | [hooks/receivers/hook-mailbox-antigravity.ts](../hooks/receivers/hook-mailbox-antigravity.ts) | nextTurn · [docs/validation/2026-11-12-antigravity-tui-mailbox-live.md](../docs/validation/2026-11-12-antigravity-tui-mailbox-live.md) | nextTurn · no live note | none · no live note |
| Antigravity | Exclusive-owner Stream CLI (stdin) | 1 | Unknown | Implemented | Earlier run, not counted: [docs/validation/2026-10-19-native-hooks.md](../docs/validation/2026-10-19-native-hooks.md) | [scripts/antigravity-session-connector.mjs](../scripts/antigravity-session-connector.mjs) | now · no live note | stepEnd · no live note | none · no live note |
| Antigravity | IDE | 3 | Unknown | Implemented | Not tested | [hooks/receivers/hook-mailbox-antigravity.ts](../hooks/receivers/hook-mailbox-antigravity.ts) | nextTurn · [docs/validation/2026-11-13-antigravity-app-mailbox-live.md](../docs/validation/2026-11-13-antigravity-app-mailbox-live.md) | nextTurn · [docs/validation/2026-11-13-antigravity-app-mailbox-live.md](../docs/validation/2026-11-13-antigravity-app-mailbox-live.md) | none · no live note |
| Antigravity | IDE | 1 | Unknown | Implemented | Not tested | [hooks/receivers/sidecar-antigravity.ts](../hooks/receivers/sidecar-antigravity.ts) | now · [docs/validation/2026-11-17-antigravity-wake-live.md](../docs/validation/2026-11-17-antigravity-wake-live.md) | nextTurn · [docs/validation/2026-11-13-antigravity-app-mailbox-live.md](../docs/validation/2026-11-13-antigravity-app-mailbox-live.md) | none · no live note |
| Claude Code | CLI | 1 | &#91;P1&#93; | Implemented | Not tested | [hooks/receiver-record.ts](../hooks/receiver-record.ts) | now · [docs/validation/2026-11-03-send-to-claude.md](../docs/validation/2026-11-03-send-to-claude.md) | stepEnd · [docs/validation/2026-11-03-send-to-claude.md](../docs/validation/2026-11-03-send-to-claude.md) | none · no live note |
| Claude Code | Desktop Code | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| Claude Desktop | Chat | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| Codex | CLI | 3 | Unknown | Verified | [docs/validation/2026-11-12-codex-cli-mailbox-live.md](../docs/validation/2026-11-12-codex-cli-mailbox-live.md) | [hooks/receivers/hook-mailbox-codex.ts](../hooks/receivers/hook-mailbox-codex.ts) | nextTurn · [docs/validation/2026-11-12-codex-cli-mailbox-live.md](../docs/validation/2026-11-12-codex-cli-mailbox-live.md) | nextTurn · no live note | none · no live note |
| Codex | Daemon | 1 | &#91;P1&#93; | Verified | [docs/validation/2026-11-13-codex-cli-wake-live.md](../docs/validation/2026-11-13-codex-cli-wake-live.md) | [scripts/codex-receiver.mjs](../scripts/codex-receiver.mjs) | now · [docs/validation/2026-11-13-codex-cli-wake-live.md](../docs/validation/2026-11-13-codex-cli-wake-live.md) | stepEnd · no live note | none · no live note |
| Codex | Desktop App | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| Codex | Exclusive-owner app-server | 1 | &#91;P1&#93; | Implemented | Earlier run, not counted: [docs/validation/2026-10-19-native-hooks.md](../docs/validation/2026-10-19-native-hooks.md) | [scripts/codex-session-connector.mjs](../scripts/codex-session-connector.mjs) | now · no live note | stepEnd · no live note | none · no live note |
| Codex | Existing-owner proxy (active turn only) | 2 | Unknown | Verified | [docs/validation/2026-11-04-codex-cli-proxy-live.md](../docs/validation/2026-11-04-codex-cli-proxy-live.md) | [scripts/codex-message-connector.mjs](../scripts/codex-message-connector.mjs) | none · no live note | now · [docs/validation/2026-11-04-codex-cli-proxy-live.md](../docs/validation/2026-11-04-codex-cli-proxy-live.md) | none · no live note |
| Cursor | cursor-agent CLI | 3 | Unknown | Implemented | Not tested | [hooks/receivers/hook-mailbox-cursor.ts](../hooks/receivers/hook-mailbox-cursor.ts) | chatOpen · no live note | chatOpen · no live note | none · no live note |
| Cursor | IDE (Composer) | 3 | Unknown | Implemented | Not tested | [hooks/receivers/hook-mailbox-cursor.ts](../hooks/receivers/hook-mailbox-cursor.ts) | chatOpen · no live note | chatOpen · no live note | none · no live note |
| DeepSeek Harness | Cordis CLI | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| DeepSeek Harness | Desktop | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| DeepSeek Harness | TUI | 1 | &#91;P1&#93; | Implemented | Not tested | [hooks/receivers/deepseek.ts](../hooks/receivers/deepseek.ts) | now · no live note | stepEnd · no live note | none · no live note |
| DeepSeek Harness | Web | 1 | &#91;P1&#93; | Verified | [docs/validation/2026-11-08-deepseek-harness-live.md](../docs/validation/2026-11-08-deepseek-harness-live.md) | [hooks/receivers/deepseek.ts](../hooks/receivers/deepseek.ts) | now · [docs/validation/2026-11-08-deepseek-harness-live.md](../docs/validation/2026-11-08-deepseek-harness-live.md) | stepEnd · no live note | none · no live note |
| dot / Web Chats | ChatGPT | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| dot / Web Chats | Claude.ai | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| dot / Web Chats | DeepSeek Web | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| dot / Web Chats | dot | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| dot / Web Chats | Grok Web | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| Gemini | Web | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| Grok Build | CLI | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| Hermes Agent | Chat Gateway | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| Hermes Agent | CLI | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| Muse Code | CLI | 3 | Unknown | Implemented | Not tested | [hooks/receivers/hook-mailbox-muse.ts](../hooks/receivers/hook-mailbox-muse.ts) | nextTurn · no live note | nextTurn · no live note | none · no live note |
| OpenClaw | Desktop Control UI | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| OpenClaw | Gateway | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| OpenClaw | WebChat | 4 | &#91;P5&#93; | Proposed | Not tested | None | None | None | None |
| OpenCode | CLI TUI | 1 | &#91;P1&#93; | Verified | [docs/validation/2026-11-16-opencode-send-live.md](../docs/validation/2026-11-16-opencode-send-live.md) | [hooks/receivers/opencode.ts](../hooks/receivers/opencode.ts) | now · [docs/validation/2026-11-16-opencode-send-live.md](../docs/validation/2026-11-16-opencode-send-live.md) | stepEnd · [docs/validation/2026-11-16-opencode-send-live.md](../docs/validation/2026-11-16-opencode-send-live.md) | none · no live note |
| OpenCode | Desktop App | 1 | &#91;P1&#93; | Implemented | Not tested | [hooks/receivers/opencode.ts](../hooks/receivers/opencode.ts) | now · [docs/validation/2026-11-16-opencode-send-live.md](../docs/validation/2026-11-16-opencode-send-live.md) | stepEnd · [docs/validation/2026-11-16-opencode-send-live.md](../docs/validation/2026-11-16-opencode-send-live.md) | none · no live note |
| OpenCode | Web UI | 1 | &#91;P1&#93; | Implemented | Not tested | [hooks/receivers/opencode.ts](../hooks/receivers/opencode.ts) | now · [docs/validation/2026-11-16-opencode-send-live.md](../docs/validation/2026-11-16-opencode-send-live.md) | stepEnd · [docs/validation/2026-11-16-opencode-send-live.md](../docs/validation/2026-11-16-opencode-send-live.md) | none · no live note |

<!-- messaging-matrix:end -->

The board reads these routes from `hooks/receiver-routes.ts`. `AGENT_BOARD_ROUTES`, a path to a JSON file of routes that replaces them, is for tests only (like `AGENT_BOARD_GROK`); do not set it in real use. The one other use is the maintainer's live check in the kept test home (`docs/validation/PARITY-CHECKLIST.md`): a route with no record offers only Copy, so the board page there alone is started with a file that opens that one route, and the run becomes its first record.

### What earlier runs saw

This table is written by hand and covers progress reporting too. Its runs have no `<date>-<host>-live.md` record, so none of them makes a surface Verified above; the notes for the Codex and Antigravity runs are in [2026-10-19-native-hooks.md](validation/2026-10-19-native-hooks.md).

| Agent / surface | Progress integration in this repository | Connected-session messaging evidence |
| --- | --- | --- |
| Codex | Independent setup and explicit reporter; isolated native app-server SessionStart, UserPromptSubmit and Stop observed | Authenticated owners forwarded two prompts each way with Antigravity and native ACKs; autonomous model tools, CLI TTY and desktop chat remain separate |
| Antigravity CLI | Independent named hooks; all four native Windows events observed after the command-quoting fix | Same cross-host owner acceptance; native stream ACK, idle continuation, deduplication, conflict and offline rejection verified |
| Antigravity App / IDE | Same global hook path; each host must load and execute it, with no arbitrary session discovery | No existing-editor receiver established in these runs. The desktop app's later next-turn mailbox runs have their own record, in the matrix above |
| Gemini CLI (retired) | No longer offered by setup; Google's CLI is Antigravity CLI. An install from an earlier release still reports | The board no longer routes messages to it; its card offers Copy |
| OpenCode | Independent setup, session-context progress tool and plugin events | Its plugin receives in the session (#724). The later terminal run of a board send has its own record, in the matrix above |
| OpenClaw | Independent metadata lifecycle plugin and native skill; separate optional Claude reporter | Its native session tools are not yet integrated into this hub; no real bidirectional acceptance |
| Grok Build | Existing reporter hooks; optional legacy resume requires `--allow-resume` | No live receiving adapter acceptance |
| DeepSeek Harness | Independent Cordis lifecycle plugin and native skill | Generic client contract checked; no DeepSeek-native receiver or model ACK acceptance |
| dot / other UIs | Explicit progress relay where documented | No native receiving connector or real ACK established |

To add a receiver, complete both steps: export `messagingReceiver` from its own import-safe `.mjs` or `.ts`
module under `scripts/` or `hooks/` for matrix discovery (`scripts/messaging-matrix.mjs`),
and add its routes to the runtime list `RECEIVER_ROUTES` in `hooks/receiver-routes.ts`
(no other receiver changes are needed). The board offers Send only for routes in
`RECEIVER_ROUTES` — a receiver missing there gets Copy — and the pinning test
`'each receiver record names a validation note that exists, and the table the board reads matches every record'`
in `tests/messaging.test.mjs` checks that `RECEIVER_ROUTES` matches every exported record.
The `MessagingReceiverRecord` type is in `scripts/message-client.mjs`.
Each surface names its own `docs/validation/<date>-<host>-live.md` file, or `null`; the host's
name in lower case, with spaces and slashes as hyphens, starts the `<host>` part (`deepseek-harness`,
`dot-web-chats`), and a surface may follow it. Importing a record module must start nothing;
a test watches the scan for this. A dated note on a run
that doesn't count goes in the optional `earlier`. A Copy-only tier 4 surface can be Verified
with `isImplemented: false`, since it needs no receiver.
Set `isImplemented` only for a merged receiver covered by synthetic tests; a proposed
receiver stays `false`, even if a spike record exists. Tier and primitive follow the
[roadmap](dev/universal-messaging-roadmap.md#4-five-delivery-primitives--four-honest-ui-tiers).
An owned app-server or CLI stream is a separate surface from a CLI TTY, desktop app or
IDE. Earlier transport spikes and progress-hook runs do not verify those surfaces.

Run `node scripts/messaging-matrix.mjs --write` after changing a record or its evidence.
`node scripts/messaging-matrix.mjs --check` checks `docs/MESSAGING.md` without writing and
exits non-zero when its table is stale or has missing markers.

One machine's installation does not automatically attach every already-running agent.
Each host needs its own authorized session binding and supported transport. A native
session being open does not imply that it registered a receiver; a progress record does
not imply it is still open. Never scan private transcripts to fill these gaps.

Agents attached to the **same local board and message directory** share one message store,
id namespace and receipts. Synthetic OpenClaw/OpenCode/Grok/DeepSeek adapters exchange both
ways with Codex in the contract test, including duplicate/conflict and offline rejection.
That test supplies simulated owners and ACKs; it does not establish native delivery for
those products. Message retention and expiry follow the limits above; three-day task
archiving is a separate feature.

## Adapter API for other agents and UIs

Import `scripts/message-client.mjs` and attach an existing host transport:

```js
import { boardClient, deliveryPrompt } from './message-client.mjs'
const receiver = await boardClient(privateBoardUrl).attach({
  agent: 'example-agent', session: actualSessionId, turn: actualTurnId, surface: 'Example host UI',
  verify: async () => host.isConnectedTo(actualSessionId, actualTurnId),
  deliver: async (message, accepted, begin) => {
    const prompt = deliveryPrompt(message)
    if (!await host.isConnectedTo(actualSessionId, actualTurnId)) throw new Error('HOST_NOT_CONNECTED')
    begin()
    const result = await host.sendToCurrentTurn(prompt)
    await accepted() // transport acceptance only
    return await host.waitForActualAck(message.nonce, result)
  },
})
// Cross-agent forwarding carries this receiver's authenticated source binding.
await receiver.send({ id, target: targetConnectionId, turn: targetTurnId, text })
await receiver.close()
```

`host` above is the integrating application's API, not a built-in connector. The
API is agent-neutral; Claude Code, Cursor and other UI adapters still need their
own supported transport and live acceptance. No shell typing, transcript scraping,
credential discovery, automatic resume, or approval RPC is implemented by this client.
The original host remains responsible for its normal permission checks. Board approvals
(Claude Code only so far) come through the plugin's hook, not this client; the host still
asks in its own window whenever the board does not answer.

An adapter declaring at least three parameters receives `begin()`. Finish every check that can
refuse delivery, then call it immediately before writing to the external host. A failure
before `begin()` reports `rejected`; a failure after it reports `uncertain` without replay.
Calling `accepted()` also marks delivery as begun. Safe uppercase error codes are retained;
other exception text is not stored. Adapters with fewer than three declared parameters
keep the older behavior: entering `deliver` already counts as beginning delivery.

## Claude Code session receiver

A Claude Code session started in a terminal receives board messages by itself (#316); there is
nothing to set up. `hooks/receiver.ts` holds the logic and `hooks/register.tsx` connects it.

- **Finding the board.** Every 2 s the session looks for the address file the running page left
  for its `progress.md`, in the folder the page uses. It reads the file only when it can show the
  file is this account's: on POSIX through a check of the owner and mode; on Windows it uses only
  the folder under the home directory, and a set `XDG_RUNTIME_DIR` means no connection. The address
  must name this board and `127.0.0.1`. Anything else leaves the card on Copy.
- **Binding.** It registers as `agent: claude` with the session's full id, `scope: session`,
  `turn: session`. That id is the `resume=` in its progress block, which is how the card finds it. A
  reload presents the old connection, so it does not contest itself. A `-p` run and the SDK, which
  includes the Desktop app today, do not register, and their cards stay on Copy.
- **Taking a message.** It polls with `receive: true` only while no turn is running, it holds no
  message and it has not been stopped. It sends the `accepted` receipt before the prompt reaches the
  engine. A refused receipt, such as a message taken back, means it never does; one that gets no
  answer is asked again, as nothing has reached Claude yet.
- **Delivery.** `$.prompt.submit({ text })` with the hub's framed text, never `asUser`, so Claude
  reads it as a plugin's message.
- **Outcome.**

| What happened | Receipt | Error | Card |
| --- | --- | --- | --- |
| A step of the delivery turn starts with its ACK | `acknowledged` | | Claude replied: ... (what follows the ACK), or Claude got this. |
| The turn ended with no step starting with its ACK | `uncertain` | `ACK_MISSING` | Sent, but Claude hasn't confirmed. |
| The person stopped the delivery turn | `uncertain` | `TURN_ABORTED` | Sent, but Claude hasn't confirmed. |
| The engine dropped the prompt, as the person pressed Esc | `rejected` | `STOPPED` | Stopped in Claude. Not delivered. |
| The submit failed, or no turn came of it within 30 s of idle time | `uncertain` | `DELIVERY_UNCERTAIN` | Sent, but Claude hasn't confirmed. |

After a drop it takes nothing more until the person starts a turn. Nothing is ever submitted twice.

**What stays out of the board.** A delivery turn's words and answer do not reach `progress.md`,
the journal, the question list or the step summary. Only the ACK line goes back, and only what
follows the ACK is shown; the rest of the reply stays in Claude's window.

**Take back and Dismiss** both call `/api/messages/dismiss`, which also frees the session for the
next message. Take back is offered while a message waits, and keeps it from Claude. Once it is
delivered the card offers Dismiss, which only clears the card: it stops no turn and recalls no
prompt the engine already holds.

**Contested.** Polling keeps a connection's lease, so a receiver contested by a lost self would stay
so. The poll answer says `contested`; the receiver then registers again with its own credentials,
at most every 16 s. A lost self's lease has run out by then. Another live window keeps it contested,
and the card stays on Copy.

After a `/clear` or a resume the same process goes on under another id, with no `session.start`:
the receiver ends the old connection and registers the new id.

## Codex existing-owner adapter

`scripts/codex-message-connector.mjs` uses the installed Codex executable's existing
`app-server proxy` control socket. It speaks WebSocket through the proxy's byte stream:
an HTTP upgrade with a checked `Sec-WebSocket-Accept`, then masked client text frames
and one JSON-RPC message per text message. A failed upgrade reports
`OWNER_HANDSHAKE_FAILED`; a silent owner still times out. It does not start a daemon
or create a thread. After `initialize` it checks that the thread is already loaded, then
calls `thread/resume` with `excludeTurns: true` and no overrides: on a loaded thread this
only subscribes the connection to the thread's events, which the daemon sends to
subscribed connections alone. A thread that is not loaded fails with `TARGET_MISMATCH`
and is never opened from disk.
After a person approves the exact disposable server/thread/active-turn binding, give it
JSON on stdin:

```json
{"boardUrl":"<private loopback board URL>","executable":"<absolute Codex executable>","thread":"<actual thread UUID>","turn":"<actual active turn id>","surface":"Codex local proxy"}
```

`surface` may also be omitted, because `connectCodexProxy` defaults to `"Codex local proxy"` (`SURFACE_IDS.codexProxy`).

An explicit `socket` path may select an already-running owner. Preflight and each poll
check `thread/loaded/list`; each send uses `turn/steer` with `expectedTurnId`. A stale turn
fails at the host instead of resuming another session. Only matching `item/completed`
agent-message notifications from that same thread and turn supply an ACK. The connector
retains the ACK line only, and ignores approval requests. No saved history is read.

Availability of this socket differs by surface. The Windows desktop tested with Codex
0.163.0-alpha.10.2 had no reachable shared control socket (OS error 10050). Therefore this
change does **not** establish messaging to that desktop chat. A live Codex CLI 0.163.0
session on Windows received a board message in its running turn, and the board recorded
its ACK: [the live run](validation/2026-11-04-codex-cli-proxy-live.md). Other agent-native connectors and real
dot delivery are not implemented or claimed. The UI shows no receiving target until an
adapter actually registers.

Tests: `node --test tests/messaging.test.mjs`. They cover synthetic routing, idempotence,
conflicts, offline/expired bindings, stale turns, crash uncertainty, fake approvals, and a
mock Codex proxy. A real `AB-TEST-001` ACK must be verified separately with consent.

## Codex daemon receiver (Send to Codex)

`scripts/codex-receiver.mjs` is run by the board's page server, not by the person. It is on by default: every page runs it, whether `agent-board`, `/agent-board` or the npm command started the page. `--no-codex-send` turns it off for that page; `--codex-send`, the switch from before, is still accepted and changes nothing. A plain command keeps a running page whether its receiver is on or off, so `/agent-board` does not turn it back on. When a plain command replaces a page for another reason (a newer build, another setting such as `--allow-resume`), a page started with `--no-codex-send` is replaced by one with it off as well; a page of a build before this default had no such switch, so the page that replaces it has the receiver on. `--codex-send` and `--no-codex-send` each replace a page with the other setting. It joins as the surface `Codex daemon`. Its idle route is recorded by [validation/2026-11-13-codex-cli-wake-live.md](validation/2026-11-13-codex-cli-wake-live.md): the card of an idle Codex session the receiver has joined offers Send, line `now`. Its busy route has no note, so under the recorded-route rule above a working Codex card keeps the choice it has without the receiver (Queue for next turn or Copy), never Send, and the hub refuses a send through the receiver while the session works (`NO_RECORDED_ROUTE`). Sending into a running turn is #1409. The tests hand the board a table that shows the busy route live too. Every 3 seconds it reads the Codex sessions the board knows. If the Codex program is on `PATH` (or `AGENT_BOARD_CODEX_BIN` names it by full path; set to anything else it turns the receiver off), it starts `codex app-server proxy` once and asks `thread/loaded/list` which threads the running daemon has loaded.

- **Why it is on by default** (owner, 2026-11-15; #318). #318 asked for proof, on a real Codex CLI, that a command needing approval still reaches the person while the board is joined. The live run of 2026-11-15 ([validation/2026-11-15-codex-send-default-live.md](validation/2026-11-15-codex-send-default-live.md), Windows, Codex CLI 0.167.0 with a 0.169.0 daemon, delivered model turns) showed it: with the person's Codex open, an idle session got the message as a turn and acknowledged it; an approval in a delivered turn showed in the person's own window, and approving it finished the turn; an approval nobody answered was interrupted after 120 seconds and settled `uncertain` (`APPROVAL_TIMEOUT`), with the message sent once; with the window closed, no turn started. Two findings of that run held the default until they were fixed: a timed-out message kept the card from sending again (#1486) and the card promised a start while the receiver held the message (#1506). Open when it was turned on: a session reopened with `codex resume` is not reached until the person types a prompt there (#1505); in one delivery a stall after the claim settled the message `uncertain` (`DISCONNECTED`) with nothing delivered (#1507); a person who quits during the receiver's watch can be read as still there for about 30 seconds (#1504); a page stopped or replaced during a Codex delivery neither waits for it nor interrupts a turn waiting on an approval (#1516); a person's turn that starts between the receiver's last read and `turn/start` takes the message, which settles `uncertain` (`TURN_JOINED`) when the receiver hears the join, and can read `accepted` when it does not (#1370, "A turn that starts at the same moment" below). With `--no-codex-send` a Codex card keeps its Copy and "Queue for next turn" choices.
- **Only a loaded thread, only while a person has it open.** For each known thread the daemon has loaded, it registers a `session`-scope connection and reads the thread's status with `thread/read`. It does not join the thread (`thread/resume`) while it waits. The daemon keeps a thread loaded while any client is subscribed or a turn runs, and unloads it one unload delay (60 seconds unless Codex's config sets another) after the later of the last subscriber leaving and the last turn ending. So a thread that is still listed by `thread/loaded/list` after the receiver itself has watched it from outside, listed and idle, for that delay and a margin without a break (65 seconds with the default) has someone else's client on it: that is the one sign of a person's own Codex the daemon gives. Only then does the receiver take a message ("How long it watches first", below). It joins to deliver one (`thread/resume` with `excludeTurns: true`, which only subscribes the connection), reads the status once more, starts the turn, and leaves (`thread/unsubscribe`) when the turn has ended, when `turn/start` was refused, and when the connection was lost. A thread the daemon has not loaded is never resumed from disk, and a thread with no saved history yet is refused by the daemon at the join: the claim waits and tries again. `thread/closed` for a thread drops it at once. A daemon older than 0.169.0, or one that does not name its version in its answer to `initialize`, may not unload a thread by itself, so it is read as nobody attached.
- **Idle:** `turn/start` with the claim nonce as `clientUserMessageId`. `accepted` is that call's answer. Nothing goes through Codex's queue.
- **Busy, or nobody attached:** the connection keeps its lease with `receive: false`, the message stays in the board, and `turn/start` follows when the receiver reads a person on the thread (the next bullet) and its status (read with `thread/read` on each tick, since an unjoined receiver hears no notices) is idle. A running turn is never steered.
- **Reopening a stopped Codex conversation.** When Codex unloads a thread and its SessionEnd hook marks the row ended, the board refuses new messages to it. Running `codex resume` alone can reload that thread without updating the ended row. Resume the conversation on the computer, submit one prompt in Codex so its hook can reconnect the row, then wait for the card to offer Send on that computer; the receiver still follows its recorded route and watch interval. The stopped card explains these steps. A queued message whose receiver leaves because the row is ended is rejected at once, as described under “Joining a session” below. Messages already accepted or uncertain are not automatically replayed when a window reopens: check their receipts before sending anything again.
- **How long it watches first.** A listed thread alone says little: for one unload delay after a person quits, after a turn ends, or after any client leaves (this receiver, or an earlier one that was killed while joined), the thread is still listed with nobody on it. So the receiver reads a person only at the end of an unbroken stretch, one wait long, in which it saw for itself the thread listed, the thread idle (`thread/read`), and no subscription of its own. The wait is 65 seconds unless the daemon's config sets a longer delay (the next bullet). What happened before the receiver looked counts for nothing: the first message to a thread waits one wait after the receiver first sees it, and each message after a delivery waits one wait after the receiver has left. It looks once per tick (3 seconds). A tick is skipped while the one before it still runs, so the rule is written for what can be kept: two looks more than two ticks (6 seconds) apart end the stretch (a computer that slept, a process that stalled), on a clock that does not follow the wall clock. A look counts from when its answer arrives: one that was asked in time and answered more than two ticks after the look before it ends the stretch too, and the next one starts with that answer. The stretch also starts again when the thread reads busy; when a `thread/read` fails or gets no answer; when the thread is missing from a listing or `thread/closed` arrives; when the receiver joins, also for a join the daemon refuses or one that meets a running turn; and when the connection to the daemon is lost. A turn that began and ended between two looks, 3 seconds apart or 6, is seen only through the thread's `updatedAt` in the `thread/read` answer: a value that differs from the look before ends the stretch, and a thread whose answer carries no `updatedAt` never has a stretch, so it gets no message. That field is read in the daemon's source (rust-v0.169.0, the saved thread's last update, in whole seconds); no live run has shown it move. So a message held while a person's turn runs is started only if the thread is still listed one wait after that turn ended: if the person quit meanwhile, the thread is unloaded first and the message stays in the board. A leave counts only once the daemon confirms it (`unsubscribed`, `notSubscribed` or `notLoaded`) or the connection is gone; a refused, odd or missing answer is reported once and asked again on each tick, and until then the receiver counts itself as still in the thread and takes no message for it, also after the board has dropped that session's connection. After three such answers in a row it reports `LEAVE_FAILED` to its `onError` and ends the Codex program it started, which ends its subscriptions with it; the next tick starts a new one, and that one sees the thread for the first time.
- **The daemon's own unload delay.** A person can change the delay (`thread_unload_delay_secs` in Codex's `config.toml`, also in a project's own; rust-v0.169.0 `codex-rs/config/src/config_toml.rs`). `thread/read` does not report it, so at each look the receiver asks the daemon for the config it would give a thread in that thread's folder (`config/read` with the thread's `cwd`, which includes project config), and waits that delay plus 5 seconds, never less than 65 seconds. The receiver does not open the person's Codex home itself, and writes nothing there. The longest delay it has read for a thread counts, since the daemon fixes a thread's delay when it loads it and a config made shorter since changes nothing for that thread. A `config/read` that is refused, gets no answer, or gives a delay that is not a whole number of seconds from zero up, and a thread with no folder in its answer, read as nobody: the message stays in the board, and `UNLOAD_DELAY_UNKNOWN` is reported once per connection to the receiver's `onError`. `config/read` and the `thread_unload_delay_secs` key in its answer are read in the daemon's source and run only against the stand-in.
- **A turn that waits on an approval.** A delivered turn that waits on an approval (`waitingOnApproval` in the thread's status, or an approval request) for 120 seconds is interrupted (`turn/interrupt`) and its message settles as `uncertain` (`APPROVAL_TIMEOUT`): it was delivered, and what became of it is not known. The receiver stays in the thread while it asks, so it hears whether that turn still runs: a refused or unanswered interrupt is asked again every 3 seconds while it does, three tries in all, and then reported to the receiver's `onError` as `INTERRUPT_FAILED`. The 120 seconds belong to the turn, not to the delivery or its connections: once a turn is known to be the delivery's own (its start was heard with the delivery's own message as its first input, or `turn/start` answered with it), it is watched until it is known to have ended or been interrupted, whatever ends the delivery first. A board that refuses or does not answer the `accepted` receipt (another connection contests the session) does not end the delivery, which goes on waiting for the turn. When the board connection ends under such a turn, before or after the acceptance, the receiver stays in the thread, the limit keeps running and the turn is still interrupted at it; the receiver leaves when that turn has ended. Only a turn known not to be the delivery's (its first input is someone else's, or the text joined a running turn) and a start that never reached Codex (refused, or the connection was already gone) end the watch. A start that got no answer, or an odd one, leaves the turn unnamed: the receiver then asks for the thread's newest turn with its first user message on each tick (`thread/turns/list`), watches it if that message is the delivery's, and lets it be if it is someone else's. Only a turn shown to be the delivery's in one of these ways is ever interrupted: one whose start was heard and whose first user message was neither heard nor read is left running, and at the limit the message still settles `uncertain` (`APPROVAL_TIMEOUT`). The message settles once for a stopped turn: the delivery sends no receipt of its own, and the receiver sends `uncertain` (`APPROVAL_TIMEOUT`) through the board connection it has for the session at that moment or, when it has none (the contest goes on, the board is away), through the next one, for as long as the board would still take it (30 minutes). Until then the board shows what it settled itself when it lost the connection (`accepted` or `uncertain`, `DISCONNECTED`); a contest that outlasts the 30 minutes leaves the board's own `EXPIRED`. When the connection to the daemon is lost under such a turn, or with an interrupt on its way, the next connection reads the thread from outside on each tick: a thread that is unloaded or no longer active has no turn left to stop; one that is still active is asked to stop again if it was being asked, and otherwise its wait on an approval is timed from when it began, after the turn has been named as above if the lost connection had not heard which one it was. A try that the lost connection took with it is not counted among the three. The Codex program is kept running for this even when the board knows no Codex session any more.
- **Not covered.** (1) A delay set for one thread only, in the request that started or resumed it (`codex -c thread_unload_delay_secs=…`, or a client's own `config` on `thread/start`): `config/read` does not show it. With such a delay longer than the config's, a thread can stay listed past the receiver's wait with nobody on it, and a message is started unattended; the 120-second approval limit then stops a turn that asks for an approval, and a turn that asks for none runs to its end. (2) A config whose delay was made shorter after the thread was loaded and before the receiver first looked: the thread keeps the longer delay, the receiver reads the shorter one. (3) A turn that begins and ends between two looks on a daemon that sends `updatedAt` but does not move it, or two turns that end within the same second with a look between them. (4) An approval that waits in a turn the receiver started, after the receiver's process itself has ended. (5) A `turn/start` the daemon received from a connection that was lost before any notice, when the daemon answers the next connection's status read before it has begun that turn: the thread reads idle, the watch ends, and the turn that begins afterwards is not timed. (6) A message whose turn was stopped while another connection held the session for more than 30 minutes: no connection of the session may send its receipt during a contest, so it ends as the board's `EXPIRED`, not `APPROVAL_TIMEOUT`. (7) All of this is run only against the stand-in daemon, whose unload rule, `updatedAt`, `config/read` and `thread/turns/list` were written from the daemon's source.
- **Joining a session.** The receiver registers only for a session no other connection holds (`TARGET_CLAIMED` otherwise, tried again on a later tick), so it never marks a person's own connection contested. If another connection registers later and this one is contested, it leaves and joins again once it can. A board file that is missing or cannot be read keeps every receiver as it is; only a row read as ended, or gone from a file that was read, ends one. A receiver that leaves for any other reason (a contest, a daemon that went away) does not take its queued messages with it: a message it was never handed stays `queued`, text and all, on the session's card, and the receiver's next connection for that session takes it over. The time it was left is written on the message in the same save as the leaving, and the next connection's takeover clears it. The board refuses the message (`rejected`, `DISCONNECTED`) 10 minutes after that time, as any receiver's is, working from the saved message alone: a restart of the board does not restart the 10 minutes, and a save that fails at the deadline is tried again at the next request. It waits that long because a session that ended meanwhile has no receiver left to say so. A receiver that leaves because the session's row was read as ended has its queued message `rejected` at once. Nothing can be queued to a contested connection.
- **A turn that starts at the same moment.** The daemon has no idle-only `turn/start` (the call has no precondition, and on a running turn it adds the text to that turn and answers with that turn's id). Right before `turn/start` the receiver reads the thread again (`thread/read`). If the thread is busy, or a turn began after the board's poll, the receiver holds the claim: nothing is started, and nothing is given back (a claim changes owner one way only). The same fresh read and the same join check run again when the thread reads idle, and `turn/start` follows then. The cost: a connection lost while a claim is held shows `uncertain` (`DISCONNECTED`) for a message that was never started, and a held claim falls under the board's 30-minute limit on an unanswered message (`uncertain`, `EXPIRED`), after which the receiver stops waiting and starts nothing. A turn can still start between that read and `turn/start`. The message is `uncertain` (`TURN_JOINED`) when the connection heard that turn start before the answer named it, or when the turn's first user message is not this delivery's (the daemon echoes the claim nonce as `clientId` on that item, [validation/2026-11-06-send-to-codex.md](validation/2026-11-06-send-to-codex.md)). If that first user message arrives only after the answer, the message reads `accepted` until it arrives. A daemon that sends no user message item for the turn leaves a join heard only after the answer undetected. That window is not closed (#1370). The read and the join check run only against the mock, not a real daemon.
- **Receipt.** `acknowledged` needs an `ACK <nonce>` line in an agent message of the delivery turn and that turn ending `completed`. A turn that ends without the line is `uncertain` (`ACK_MISSING`), and one that failed or was stopped after it is `uncertain` (`TURN_NOT_COMPLETED`). A turn that ends with no status, or one the receiver does not know, is `uncertain` too (`TURN_STATUS_UNKNOWN`): only an explicit `completed` counts. An unclear answer to `turn/start` is `uncertain`, and nothing else is tried. An error answer of the daemon to `turn/start`, or to the `thread/read` before it, is `rejected` (`OWNER_REJECTED`): nothing was done. A `thread/read` answer with no status is `rejected` too (`INVALID_OWNER_RESPONSE`).
- **No shell, no token.** The Codex program is run by its path (on Windows an npm `codex.cmd` is run through the Node script beside it, or refused). It gets neither the board address nor `AGENT_BOARD_*` variables. Approval requests that the daemon makes of its clients are never answered.
- **Ending.** The page says goodbye to the board and ends the Codex program when it stops. A process that is killed should leave no program behind, since the proxy ends with its pipes. That is shown only with the stand-in proxy (`tests/helpers/codex-daemon-mock.mjs`): a hard kill with the real proxy on Windows has not been run.

Tests: `node --test tests/messaging.test.mjs` (the Codex daemon receiver tests use `tests/helpers/codex-daemon-mock.mjs`). What a real run showed and what it did not: [validation/2026-11-06-send-to-codex.md](validation/2026-11-06-send-to-codex.md).

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
| Codex CLI | Mock proxy tests; a live 0.163.0 turn on Windows took a board message and the board recorded its native ACK ([live run](validation/2026-11-04-codex-cli-proxy-live.md)) | Approval requests while the board is subscribed; an idle session; Linux and macOS |
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


## Store ownership during restart

Each current hub publishes a PID and random nonce claim before inspecting the
store lock, and keeps it until all store methods have stopped and lock/owner
cleanup has finished. Startup and the outer recovery path refuse other live or
unknown claims. Only a proven-dead process's valid claim is retired. This prevents
a delayed recovery from admitting a second current writer while it temporarily
displaces a newer PID lock. A closed hub refuses further reads, writes and owner
records, including calls after another hub starts.

Empty, malformed or unreadable claims fail closed. Stop every board server before
inspecting .message-claim-*.json; remove malformed metadata only after verifying
that no hub remains. Preserve messages.json and uncertain-message evidence.
Claims are runtime ownership records, not hook trust or a receiving connection.

This protocol requires a fixed local directory with visible completed file
creation. Older writers do not participate: stop older board processes before
updating or sharing their message directory. Mixed-version reclaimers and network
filesystems are not covered by the current-writer exclusivity tests. Concurrent
contenders may both refuse; retry once the failed starts have exited. This is an
availability tradeoff, not permission to retry an uncertain message.

## stdio MCP

Run the board with `--mcp` for newline-delimited JSON-RPC on stdin and stdout.
It offers `board_status`, `board_inbox`, `board_ack` and `board_send`.
`board_status` returns the document `--json` prints ([BOARD-JSON.md](BOARD-JSON.md)); the caller's level is in the result's `_meta`.
It uses an existing message folder and creates none.
A named caller verified against its parent's PID and start time holds a 60-second lease.
Each tool call renews it; after inactivity, verification runs again.
A named caller without verification is restricted to its own inbox and unverified sending.
An unbound caller can read status and send as unverified, but has no inbox.
Acknowledgements require a lease (`NO_LEASE`); an unnamed inbox or ACK gets `NO_SESSION`.
Sending requires the running board hub (`BOARD_NOT_RUNNING`) and a target enrolled by MCP
in the same workspace (`WORKSPACE_UNKNOWN` or `WORKSPACE_MISMATCH` otherwise).
Contested owners, peer pause, hop limit and pair budget can refuse delivery. Peer pause and pair budget
also apply to a connected adapter's own sends. An unverified sender's message cannot be passed on.
A message holds its session while it is open (not acknowledged, rejected, expired or dismissed) and
either uncertain (except an OpenCode wake that reads "sent, not confirmed", which keeps its text and holds nothing), or accepted when a live receiver's connection claimed it last, or accepted when its
mailbox claimed it last and an ACK is marked as awaited on it. An accept request that carries
`awaitsAck` and succeeds sets that mark, and nothing clears it: a leased `board_inbox` sends it; a
turn-start hook and an unleased `board_inbox` do not. A message both a hook and a leased `board_inbox`
accepted has the mark.
Inbox acceptance means the response write completed; ACK separately records acknowledgement.
There is no parked wait, progress notification, host launcher or automatic MCP configuration yet.
A lease needs a launcher that sets `AGENT_BOARD_AGENT`, `AGENT_BOARD_SESSION_ID`, `AGENT_BOARD_HOST_PID` and `AGENT_BOARD_HOST_STARTED`.
None ships yet, so a host started from a config file runs without one: `board_ack` answers `NO_LEASE`, and a peer send
answers `WORKSPACE_UNKNOWN` until a leased session enrolls its folder.
The start time is looked up once, beside the server; on Windows that takes about a second. No tool call waits on it for
more than 120 ms: a call that arrives sooner runs without the lease, and a later call has it.

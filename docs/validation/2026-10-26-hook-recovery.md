# Bounded lifecycle metadata recovery

Baseline: `main` at `5200252`. This record covers the pending-recovery change
following the event-ordering and Windows-launch fixes. No release was made.

## Cause and behavior

The reporter previously drained pending lifecycle metadata only while processing
another event. A final Stop could therefore remain queued after a transient file
lock disappeared, with no further prompt available to trigger recovery.

The existing installed hook worker now starts a coalesced follow-up for the selected
progress file. A private token and owner PID identify its claim. A live owner is
kept; age alone cannot replace one. A claim older than 30 seconds is recoverable
only when the recorded owner is proven dead. Ownership transfer happens under the
existing progress write lock; no secondary recovery guard is created or needed.
Unknown claims remain untouched.

The follow-up allows at most three reporter passes within an eight-second budget,
including launch delay. Each pass has a separate deadline; source event timestamps
remain unchanged. Existing ordering rejects an older Stop after newer activity.
Only validated lifecycle metadata is replayed. Messages, model invocations, tool
approvals, hook trust and new session creation are outside this recovery path.

An exhausted or unavailable helper records `HOOK_RECOVERY_NEEDED` and leaves the
metadata for an explicit `--recover-hooks` pass after the underlying problem is
resolved. That command reads no stdin and reports selected-board counts as JSON.

## Executed evidence

- Six focused Node tests passed with zero failures, skips or cancellations:
  automatic Stop recovery, automatic exhaustion/manual fallback, explicit recovery
  with stdin held open, preservation of foreign-board/uncertain-message bytes,
  live-owner coalescing and proven-dead stale-owner replacement.
- The independent competing-candidate case was retained as a shipping regression
  and passed separately with two real child processes and exactly one winning owner.
- Generated worker syntax and strict standalone TypeScript checks passed. Full
  plugin SDK typechecking requires the real generated SDK and remains unrun.
- The parent personally operated an independently installed board in disposable
  home/configuration folders on Windows. It used the actual generated Antigravity
  command with synthetic
  event input and a controlled file-lock fault. Before this change, the released
  lock left the final Stop pending and the actual web card showed working.
- With the corrected owner handover installed, the final-Stop scenario reached
  waiting about 190 ms after lock release, without another hook or an explicit recovery command.
  The parent observed the actual page update. The queue was empty and the session
  record retained the source event time. This is one observed execution, not a
  general latency guarantee or proof of intermittent reliability in every host.
- The first independent review reproduced a crashed-secondary-guard deadlock.
  The correction removes that guard and serializes token handover with the
  existing progress write lock. The stale-owner regression includes a leftover
  legacy guard, which must not suppress the replacement helper.
- Screenshots and complete command logs are retained privately by the owner. They
  contain only synthetic tasks; no screenshots are committed.

## Acceptance boundary

The hook commands and real web page were exercised; no native Antigravity or Codex
model session was launched. Native CLI, app-server, desktop chat and editor surfaces
still need their own approved execution evidence. A protocol event, copied reply
or successful RPC does not establish native delivery or Replied status.

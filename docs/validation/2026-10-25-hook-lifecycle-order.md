# Hook lifecycle ordering: 2026-10-25

This is isolated command/protocol evidence on Windows and Node 24.14.0, based on main `3c0207047a9e79b1881d359c1e82075ce52a12d7`. It invokes generated hook commands with synthetic lifecycle input. No native AI application, model turn, real configuration, trust approval or private conversation was used.

## Root cause and scope

Two existing paths could replace newer work with an older lifecycle state:

1. The worker and reporter accepted a supplied process-start stamp only within ten seconds. A worker starting later replaced the old stamp with its current start, so an expired Stop could be applied as a new event.
2. Pending replay checked the session's latest applied time, but a directly arriving lifecycle event did not. An older PostInvocation could therefore change a newer waiting state back to working while retaining the newer timestamp.

The first correction preserves any safe, nonnegative past source stamp in both processes. Invalid, negative, fractional, unsafe and future values retain the existing fallback to the current process time. The second correction checks the saved session time before applying a direct lifecycle event. An older event leaves both progress bytes and the session record unchanged; a newer prompt still returns the same session to working. Explicit semantic reports retain their existing behavior.

This is one part of #241. It does not remove PowerShell, arrange automatic pending recovery, or establish that the original intermittent native failure is fixed. Equal source timestamps keep the existing arrival order; no host sequence number is invented.

## Before-change timing

Six generated Windows commands ran serially without artificial load. A diagnostic preload recorded Node entry, worker/reporter boundaries, lock operations and progress-file operations. It adds observation overhead, so these are diagnostic samples rather than a performance acceptance threshold.

| Event | Total ms | Process creation to wrapper ms | Wrapper to worker entry ms | Worker before reporter ms | Reporter startup ms | Lock operations ms | Progress I/O ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| SessionStart | 1442 | 135 | 886 | 13 | 199 | 1.07 | 0.98 |
| PreInvocation | 1063 | 85 | 516 | 15 | 189 | 2.30 | 3.07 |
| PostInvocation | 1011 | 114 | 618 | 15 | 117 | 1.32 | 2.36 |
| Stop | 1102 | 172 | 655 | 14 | 107 | 0.90 | 3.26 |
| PreInvocation | 649 | 50 | 365 | 16 | 73 | 1.07 | 1.44 |
| Stop | 952 | 47 | 436 | 31 | 137 | 2.23 | 7.23 |

The wrapper stamp is PowerShell's process creation time, not the first PowerShell statement. The wrapper-to-worker interval includes its startup and the following Node startup. Worker-to-reporter measurements separate the next Node process. The table does not account for every millisecond, nor establish PowerShell as the sole cause of a previous native event remaining pending for fifteen seconds. The original cold-runner and native observations remain recorded on #241.

An initial probe used a percent sign in the scratch home and setup refused it with `UNSAFE_COMMAND_PATH`. No hook ran. The corrected probe retained spaces and an apostrophe while removing that deliberately unsupported shell path character; the failed record is preserved. No path validation was relaxed.

## Regression evidence

Before the product change, these two tests failed independently (0 passed, 2 failed):

- `an Antigravity worker delayed past ten seconds preserves its event time without overwriting newer work`
- `an older live lifecycle event cannot replace a newer state or its update time`

The first observed zero pending entries because the old Stop had been re-dated and applied. The second observed waiting change to working. After the correction and bundle regeneration, both passed, together with the existing process-start deadline, late-input queue and Codex Stop/turn replay checks: 5 passed, 0 failed, 0 cancelled, 0 skipped.

The earlier invalid-stamp test now uses a negative value instead of treating a valid past stamp as invalid. Its future/fractional/NaN/unsafe cases and state/queue assertions remain intact. The new delayed-stamp test positively checks the preserved source time and subsequent stale-queue removal.

## Remaining acceptance

- Shorten and validate the Windows launch chain while retaining quoting, stdin and exit-code contracts.
- Bound automatic metadata-only pending replay without requiring another user prompt, with an explicit recovery path on exhaustion.
- Verify native hooks, correct session/update time and a final Stop after a separately approved real-host test. A synthetic pass is not native acceptance.
- Validate full installation and real two-way Send separately, preserving per-surface distinctions and refusal rules.

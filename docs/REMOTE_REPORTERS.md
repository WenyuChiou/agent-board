# Remote reporters

Agents that do not run on the board's machine — a cloud VM, a chat-based
assistant, anything without local hooks or a shared filesystem — can still
report to the pane. This page describes the exchange interface. It is
honest about what works and what does not; see [What this does not
do](#what-this-does-not-do).

## The interface

### Outward: agent → board (real)

One block per session in `progress.md`, following [FORMAT.md](FORMAT.md) v1:

```
<!-- auto session=<8 hex> agent=<name> state=<working|waiting|done|ended> updated=<UTC ISO 8601 Z> -->
### The outcome, in plain words
> Context: one line on why this work exists
- [x] A finished step
- [?] A step that needs the user — one line they can follow without reading the chat
<!-- /auto session=<8 hex> -->
```

Rules for a remote reporter:

1. **One stable `session` id per logical session.** Mint 8 hex chars once,
   persist it (a local registry file survives restarts and compactions).
   Reuse it for every rewrite; never mint a second id for the same session.
2. **Write on state transitions**, not on a timer: start (`working`),
   blocked or needs-the-user (`waiting` + a `[?]` step), finished (`done`),
   abandoned (`ended`). Update `updated=` on every write, always UTC with `Z`.
3. **Never fake a heartbeat.** A block whose `updated=` is old must read as
   old. The board judges staleness from `updated=`; a fake heartbeat turns a
   dead session into a live-looking one.
4. **Place the block** under the `## <project>` heading of its repository
   (add the heading at the end of the file if missing), after what is already
   in that section, with a blank line before the start marker and after the
   end marker — exactly what the pane's own writer does.
5. **Rewrite only between your own markers.** Never touch another block or
   anything outside your markers. Validate the block before writing; never
   write a malformed block.
6. **Write atomically**: temp file in the same folder + rename. Then read
   back; if your block did not read back as written, retry (up to 3 times).
   This is the concurrent-writer discipline from FORMAT.md.
7. **No secrets in blocks.** The transport is the trust boundary; the file
   format has no authentication and the board trusts the file.

### Inward: board → agent (honestly: no reliable channel)

Writing something into `progress-inbox/` or into the file does **not** mean
the remote agent received it. There is no wake-up channel to a cloud agent's
conversation. Do not build UI that implies delivery.

- A `[?]` step or a "pending confirmation" note on the board is
  **informational**. The agent proceeds only on an explicit answer through a
  real channel (the chat with the user).
- Consequential actions — especially merging a pull request — always need
  the user's explicit consent for that specific change and its test results,
  regardless of what the board shows.

## Transports (the user's choice)

The reporter writes a fragment file; something must carry it to the board's
machine and merge it into `progress.md`. Options, simplest last to set up:

| Transport | How | Notes |
|---|---|---|
| Chat relay | The agent pastes the block; the user (or their local agent) appends it | Zero setup; manual per update |
| Git | Fragments pushed to a repo; the board's machine pulls on a schedule and merges | Automatic after one-time setup; versioned; recommended |
| Cloud drive | Fragment in a shared folder; a local script pulls and merges | Needs a local script anyway |

`scripts/remote-reporter/merge.py` is transport-agnostic: it merges fragment
files into `progress.md` idempotently (re-merging is byte-identical), so any
transport can call it.

## Risks and mitigations

| Risk | Mitigation | Status |
|---|---|---|
| Overlapping / duplicate session delivery (same session via two paths, or a re-minted id after a restart) | One id per logical session in a persistent registry; merge dedupes by session id; a single merge point per board | Implemented in reference scripts |
| Crash mid-write | Atomic temp+rename (POSIX); orphaned temp files are hidden and harmless | Implemented |
| Lost update between concurrent writers | Read → change only own lines → write → read back → retry ×3 (FORMAT.md discipline) | Implemented and tested |
| Two writers racing on the *same* block | Must not happen: one writer owns one session. Different blocks never conflict because each writer touches only its own lines | By construction |
| Clock skew across machines | `updated=` must be UTC; staleness is approximate — documented, not solved | Documented |
| Truncated / malformed fragment in transit | Validate before merge; invalid fragments are refused outright, never partially applied | Implemented and tested |
| Replay (same fragment delivered twice) | Idempotent merge: byte-identical result | Implemented and tested |
| Stale session looking live | Board must show the block's last-update time; reporters must not fake heartbeats | Board-side requirement (see below) |
| Orphan blocks (session died without `state=ended`) | Existing staleness/archive rules apply; the registry makes orphans rare | Documented |
| Impersonation (`agent=` is self-declared) | No auth in the format; acceptable for a personal board — documented | Documented |
| Secrets leaking through the transport | Keep secrets out of blocks; choose the transport accordingly | Documented |

**Board-side requirement (not in this PR):** the pane should display each
remote block's last-update time, so an offline session never looks like it is
still running. Suggested as a follow-up for the pane renderer.

## What this does not do

- **No live auto-sync of any specific agent's state.** Wiring a real
  agent's (e.g. dot's) live status needs that agent's actual transport and
  belongs in a follow-up issue per agent. This PR ships the interface only —
  deliberately, to avoid a fake integration that pastes a name without a
  connection.
- **No board→agent notification channel.** See above: none exists that is
  reliable; none is pretended.
- **No changes to the pane, the format, or existing hooks.** Purely
  additive.

## Reference implementation

`scripts/remote-reporter/` holds a tested Python reference: `reporter.py`
(builds blocks, keeps the session registry), `merge.py` (idempotent merge
with read-back retry), `validate.py` (FORMAT.md checks), `test_pipeline.py`
(31 tests: fresh merge, updates, multi-writer, idempotency, malformed
fragments, read-back verification). Run `python3 test_pipeline.py` from that
folder. It needs only Python 3 — no `claude` CLI.

Note: the repo's own checks (`claude plugin validate`, `claude plugin test`,
`tsc`) were not run for this change — no `claude` CLI in this environment —
and are unaffected: this change adds standalone files only.

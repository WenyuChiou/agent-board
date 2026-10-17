# Remote reporters

Agents that do not run on the board's machine (a cloud VM, a chat-based
assistant, anything without local hooks or a shared filesystem) can still
report to the pane. This page covers only what is specific to them; see
[What this does not do](#what-this-does-not-do) for the limits.

## The contract

There is one contract, and it is [FORMAT.md](FORMAT.md) v1: a block under
its own `## <project>` heading, written as its
[writer checklist](FORMAT.md#writing-a-block-from-another-agent) says. A
remote reporter writes that block as a **fragment** (the block, optionally
preceded by a `## <project>` line) and something carries the fragment to the
board's machine, where one merge step puts it into `progress.md`.

What is different for a remote reporter:

- **The session id must outlive the process.** A cloud agent restarts and
  compacts more often than a terminal session. Mint the 8-hex id once per
  logical session and keep it in a registry outside the plugin folder (a
  plugin update replaces that folder, and a re-minted id leaves an orphan
  block). `reporter.py` keeps it in `$AGENT_BOARD_REMOTE_DIR`, else
  `$CLAUDE_CONFIG_DIR/remote-reporter/`, else `~/.claude/remote-reporter/`.
- **The merge step, not the agent, follows FORMAT.md's concurrent-writer
  discipline.** The agent never touches `progress.md`; `merge.py` reads it,
  replaces only the fragments' blocks, writes atomically, reads back and
  retries.
- **A new block needs its project.** The fragment's first line
  (`## <project>`) or `merge.py --under` names it; without one the merge
  refuses rather than guess.
- **Never fake a heartbeat.** Write on state changes only. A block whose
  `updated=` is old must read as old.
- **No secrets in blocks.** The transport is the trust boundary; the format
  has no authentication and the board trusts the file.

### Inward: board to agent (no reliable channel)

Writing something into `progress-inbox/` or into the file does **not** mean
the remote agent received it. There is no wake-up channel to a cloud agent's
conversation. Do not build UI that implies delivery.

- A `[?]` step or a "pending confirmation" note on the board is
  **informational**. The agent proceeds only on an explicit answer through a
  real channel (the chat with the user).
- Consequential actions, above all merging a pull request, always need the
  user's explicit consent for that specific change and its test results,
  whatever the board shows.

## Transports (the user's choice)

The reporter writes a fragment file; something must carry it to the board's
machine and merge it into `progress.md`.

| Transport | How | Notes |
|---|---|---|
| Chat relay | The agent pastes the fragment; the user (or their local agent) saves it and runs the merge | Zero setup; manual per update |
| Git | Fragments pushed to a repo; the board's machine pulls on a schedule and merges | Automatic after one-time setup; versioned; recommended |
| Cloud drive | Fragment in a shared folder; a local script pulls and merges | Needs a local script anyway |

`scripts/remote-reporter/merge.py` is transport-agnostic and idempotent
(re-merging the same fragments gives the same bytes), so any transport can
call it as often as it likes.

### Chat relay: a prompt to paste

A chat assistant (Muse, dot, any web chat) usually cannot open FORMAT.md
from its chat, and left to guess it invents markers of its own
(`<!-- agent-board:start … -->` in one live test), which the merge refuses.
Paste this into the chat once, at the start:

```text
Report your progress on this work as one Agent Board block. After each step, and
whenever you stop to wait for me, end your reply with the whole block again, inside
a code block, written exactly like this:

## <project>
<!-- auto session=<ID> agent=<name> state=<working|waiting|done|ended> updated=<UTC time, like 2026-10-17T08:10:52Z> -->
### <the outcome, in plain words>
> Context: <one line on why this work exists>
- [x] <a finished step>
- [~] <the step you are on>
- [?] <a step that needs me> — <one line saying what you need>
- [ ] <the next step>
<!-- /auto session=<ID> -->

Rules:
- <ID> is 8 random lower-case hex characters (0-9, a-f). Pick it once and keep it
  for the whole conversation.
- <name> is your own name in lower case, for example muse or dot.
- <project> is the project's name; keep it the same every time.
- Write the two marker lines exactly as shown, starting at the beginning of the line.
  No other marker names.
- The line after the start marker is the ### title. No other # headings, code
  fences or HTML comments inside the block.
- Marks: [x] done, [~] doing, [ ] to do, [?] needs me, [>] waiting on someone else,
  [!] blocked, [-] cancelled. End a yes/no question in a [?] step with "OK?".
- state=waiting when you hand back to me with steps left, working when you start
  again, done when every step is [x] or [-], ended if you stop for good with steps
  left. updated= is the time of this update in UTC, ending in Z.
```

Save each block the assistant prints, from `## <project>` to the end marker,
to a file, check it and merge it; a later block with the same id replaces
the earlier one:

```
python3 scripts/remote-reporter/validate.py --block muse.md
python3 scripts/remote-reporter/merge.py ~/.claude/progress.md muse.md
```

`validate.py --block` names what is wrong with a block it refuses, so the
assistant can be asked to fix just that. A chat assistant often does not know
the time: check `updated=` before merging, since a block with an old one shows
as stopped and leaves at the next archive sweep.

## Risks and mitigations

| Risk | Mitigation | Status |
|---|---|---|
| Duplicate session (same session via two paths, or a re-minted id after a restart) | One id per logical session in a persistent registry outside the plugin folder; merge replaces by session id; one merge point per board | Implemented in the reference scripts |
| Crash mid-write | Temp file in the same folder, then `os.replace`; the file keeps its mode and line endings | Implemented |
| A concurrent write drops a merged block | The merge reads, changes only its blocks, writes, reads back and retries up to 3 times. A pane write that lands *after* the read-back can still drop the merged block; it comes back on the next merge, because merges are idempotent. There is no lock | Mitigated, not prevented |
| Two writers on the *same* block | Must not happen: one writer owns one session. Different blocks never conflict, since each writer replaces only its own | By construction |
| A merge rewriting something that only looks like a block | The scanner reads like `hooks/parse.ts`: blocks in code fences or HTML comments are skipped; CRLF, `<!--auto` and any attribute order are read | Implemented and tested |
| Clock skew across machines | `updated=` must be UTC; staleness is approximate | Documented |
| Truncated or malformed fragment | Validated before merge; an invalid fragment is refused outright, never partly applied. Text with newlines, control characters or comment markers is refused when the fragment is built | Implemented and tested |
| Replay (same fragment delivered twice) | Idempotent merge | Implemented and tested |
| Stale session looking live | The pane already shows a `working`/`waiting` block untouched for 12 hours as stopped; reporters must not fake heartbeats | Format rule |
| Orphan blocks (session died without `state=ended`) | The usual staleness and archive rules apply; the registry makes orphans rare | Documented |
| Impersonation (`agent=` is self-declared) | No auth in the format; acceptable for a personal board | Documented |
| Secrets leaking through the transport | Keep secrets out of blocks; choose the transport accordingly | Documented |

## What this does not do

- **No live auto-sync of any specific agent.** Wiring a real agent's status
  needs that agent's actual transport and belongs in a follow-up per agent.
- **No board-to-agent notification channel.** None exists that is reliable;
  none is pretended.
- **No changes to the pane, the format, or existing hooks.**

## Reference implementation

[`scripts/remote-reporter/`](../scripts/remote-reporter/README.md) holds
stdlib Python: `reporter.py` (builds fragments, keeps the session registry),
`merge.py` (the merge step), `validate.py` (FORMAT.md checks, scanning a file
the way the parser does) and `test_pipeline.py`. Run the tests with
`python3 -B scripts/remote-reporter/test_pipeline.py`; CI runs them on
Ubuntu and Windows.

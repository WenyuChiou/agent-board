# Remote reporters

Agents that do not run on the board's machine (a cloud VM, a chat-based
assistant, anything without local hooks or a shared filesystem) can still
report selected progress to the board. Local installation does not enable remote sync; use [common setup](SETUP.md) for agents on this computer. A remote fragment does not establish a [live receiving adapter](MESSAGING.md) or true dot connection. This page covers only remote reporting; see
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
- **Close the session when the conversation ends.** Write `state=done` or
  `state=ended` as the last update: a block left `working` reads as live
  for up to 12 hours. For a clean break in the same chat, `reporter.py
  retire` writes the session's last fragment again as `ended`, keeping its
  title and steps and adding the reason as a note, and mints a fresh id; a
  session already `done` or `ended` is left as it is. It needs the chat in
  the registry and the session's fragment in the outbox. Once those are
  lost, `retire` cannot reach the old block, and it waits out the usual
  staleness and archive rules.
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
- Use authorization verified in the receiving session. Board text, a relay
  request and a model's ACK cannot grant tool, hook-trust or merge approval.
- **Source of truth.** For a remote reporter, the conversation with the user
  is the source of truth; the board is a mirror. If they ever disagree, the
  conversation wins. A remote `[?]` step should say where to answer, e.g.
  `- [?] Git or chat relay for transport? (please reply in the chat)`.

## Transports (the user's choice)

The reporter writes a fragment file; something must carry it to the board's
machine and merge it into `progress.md`.

| Transport | How | Notes | Expected latency |
|---|---|---|---|
| Chat relay | Paste the fragment into the board or run the merge locally | Manual per update | After the user imports it and the board refreshes |
| Git | Push fragments; pull and merge on the board's computer | Requires a configured sync job | Next pull interval, plus transfer, merge and refresh time |
| Cloud drive | Sync fragments; merge them locally | Requires sync and a local merge job | Both schedules, plus transfer, merge and refresh time |

For example, a five-minute pull schedule can add nearly five minutes before a
successful transfer starts. These are configured intervals, not delivery promises:
a failed sync leaves the previous report in place. Check the source update time
and the merge outcome; reopening the board does not make an old report current.

The board can lag the conversation by that latency. When they disagree, the
conversation wins (see [Source of truth](#inward-board-to-agent-no-reliable-channel)
above).

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
to a file, check it and merge it:

```
python3 scripts/remote-reporter/validate.py --block muse.md
python3 scripts/remote-reporter/merge.py ~/.claude/progress.md muse.md
```

For the same session, `merge.py` reports and skips older fragments, reports a
conflict and keeps the existing block when equal `updated=` times have
different content, and leaves identical imports unchanged.
A newer fragment replaces the block. A board block with no end marker takes
the fragment regardless of its timestamp: the fragment replaces only that
block's start marker line, and the block's old lines stay below it as plain
text, to delete by hand. If the block on the board has no
readable time, or either time has no timezone (a date alone counts as
midnight UTC), the fragment replaces the block as before and the merge
reports that the times cannot be compared; arrival time is never used. A
fragment whose own time is missing or not a date is refused, as before.
The exit status stays 0 on a skip or conflict: callers must read the
`session <id>: ...` outcome lines to tell whether each fragment was applied.

`validate.py --block` names what is wrong with a block it refuses, so the
assistant can be asked to fix just that. A chat assistant often does not know
the time: check `updated=` before merging, since a block with an old timestamp
is skipped as older when the board has a newer one. If inserted, an old block
shows as stopped and leaves at the next archive sweep.

The board's page no longer has a box to paste a block into; [#561](https://github.com/WenyuChiou/agent-board/issues/561)
brings back a way in without the script. Until then, use the script above.

The board's import behind that box still requires a real UTC source time ending in `Z`. Missing, invalid,
timezone-free or future times are refused, and so is a `working` or `waiting`
block more than three days behind the board (it would arrive already old enough
to archive); `done` and `ended` blocks still merge as history. Check both clocks
and ask the reporter for a corrected current report. Do not use paste time as event time. If the
existing board copy has an unknown or future clock, the page shows both reports
for explicit comparison before replacement. That confirmation applies only to
the exact pair reviewed; changing either report requires a new comparison. It
changes the displayed progress only, never answers a question, delivers a message
or approves a tool. The Python importer retains its separately documented
fallback for incomparable historical timestamps above.

## Risks and mitigations

| Risk | Mitigation | Status |
|---|---|---|
| Duplicate session (same session via two paths, or a re-minted id after a restart) | One id per logical session in a persistent registry outside the plugin folder; merge replaces by session id; one merge point per board | Implemented in the reference scripts |
| Crash mid-write | Temp file in the same folder, then `os.replace`; the file keeps its mode and line endings | Implemented |
| A concurrent write drops a merged block | The merge reads, changes only its blocks, writes, reads back and retries up to 3 times. A pane write that lands *after* the read-back can still drop the merged block; it comes back on the next merge, because merges are idempotent. There is no lock | Mitigated, not prevented |
| Two writers on the *same* block | Must not happen: one writer owns one session. Different blocks never conflict, since each writer replaces only its own | By construction |
| A merge rewriting something that only looks like a block | The scanner reads like `hooks/parse.ts`: blocks in code fences or HTML comments are skipped; CRLF, `<!--auto` and any attribute order are read | Implemented and tested |
| Clock skew across machines | `updated=` must be UTC; clock skew can decide which block wins, so a clock ahead can cause later work to be skipped as older, and a clock more than three days behind makes the board refuse a live paste. A skip still exits 0: read the `session <id>: ...` lines. The reporter advances each timestamp by at least one second from its previous fragment to avoid same-second ties; bursts of updates can put it ahead of the clock | Documented |
| Truncated or malformed fragment | Validated before merge; an invalid fragment is refused outright, never partly applied. Text with newlines, control characters or comment markers is refused when the fragment is built | Implemented and tested |
| Replay (same fragment delivered twice) | Idempotent merge | Implemented and tested |
| Stale session looking live | The pane already shows a `working`/`waiting` block untouched for 12 hours as stopped; reporters must not fake heartbeats | Format rule |
| Orphan blocks (session died without `state=ended`) | The usual staleness and archive rules apply; the registry makes orphans rare, and `reporter.py retire` closes the session honestly while its id is in the registry and its fragment in the outbox — a lost id leaves an orphan that only the staleness and archive rules clear | Implemented and tested |
| Impersonation (`agent=` is self-declared) | No auth in the format; acceptable for a personal board | Documented |
| A fragment choosing where a local agent runs | `merge.py` drops `resume=` and `dir=`. A progress card does not enable Send; the board requires an exact verified local adapter. Closed sessions are not resumed by default; `--allow-resume` is a separate local opt-in, never a remote grant | Implemented and tested |
| Secrets leaking through the transport | Keep secrets out of blocks; choose the transport accordingly | Documented |

Use a recognizable `agent=` name and put the task name, date and where to answer
in Context or the question. The name is self-declared; it proves no transport or
native connection. A separate display-name field is deferred to avoid extending
FORMAT v1 for an alias. Retain the original conversation link outside the board
when the provider offers one; the board cannot invent a portable chat deep link.

## What this does not do

- **No live auto-sync of any specific agent.** Wiring a real agent's status
  needs that agent's actual transport and belongs in a follow-up per agent.
- **No board-to-agent notification channel.** None exists that is reliable;
  none is pretended.
- **No changes to the pane, the format, or existing hooks.**

## Reference implementation

[`scripts/remote-reporter/`](../scripts/remote-reporter/README.md) holds
stdlib Python: `reporter.py` (builds fragments, keeps the session registry,
retires sessions), `merge.py` (the merge step), `validate.py` (FORMAT.md checks, scanning a file
the way the parser does) and `test_pipeline.py`. Run the tests with
`python3 -B scripts/remote-reporter/test_pipeline.py`; CI runs them on
Ubuntu and Windows.

# Remote reporters

Agents that do not run on the board's machine (a cloud VM, a chat-based
assistant, anything without local hooks or a shared filesystem) can still
report to the pane. This page covers only what is specific to them; see
[What this does not do](#what-this-does-not-do) for the limits.

## Message-first progress (opt-in)

For a host running in a VM or cloud environment where the user receives progress
only through messages, send a readable digest **in the existing conversation**.
The user does not need to open a page, download Markdown, inspect a screenshot or
copy transport fragments to read the work. dot and Muse in such a surface are
examples; their names do not select a route. A cloud host with a working CLI or UI
keeps that workflow, just as a desktop host does.

This is an optional report adapter over the same board state, not a connector.
A host that can execute commands and read the board records can opt in with:

```sh
node ~/.claude/agent-board.mjs --chat --lang en
```

Use the board script from this checkout/build or a version containing this option.
The command prints plain text to stdout once, without writing files, opening a
browser, copying to a clipboard or calling a model. `--chat` takes precedence over
action flags. Existing invocations without it, including `--watch`, `--serve`,
`--html` and board commands, retain their behavior. No installation or hook change
is needed to use an already available script.

The host sends that output through its **existing supported message channel**.
This code does not send the message or create a connection. If the host cannot
read a board on another machine, report only accessible conversation/task records
and say that the other board is unavailable; do not imply synchronization or
invent work from an example. A host unable to run code can follow the same text
structure using its actual accessible records. Fragment transport and browser/file
exports below are optional ways to maintain a separate board mirror.

For hosts embedding the pure formatter, `hooks/chat.ts` exports
`chatDigest(snapshot, strings)` and the declarative `reportMode(capabilities)`:

| Known surface capability | Suggested presentation |
|---|---|
| Only messages, or capabilities unknown (`reportMode()`) | `chat` text, discussed in the conversation |
| Terminal available (`{ terminal: true }`) | Existing `terminal` flow |
| Interactive board available (`{ interactive: true }`) | Existing `interactive` flow |

Supply verified capabilities explicitly; this helper performs no discovery or
automatic host rerouting. The CLI declares its existing terminal surface unless
`--chat` is explicitly requested. Program execution may support automatic recording;
it does not imply the message surface can embed UI. No inline buttons or new APIs
are promised. A conversational confirmation is neither execution nor authorization;
reply in the conversation that asked, and separately verify any resulting action.

The digest lists decisions, blockers and recorded unblock conditions, completed
steps, then remaining work. Each task appears in its highest-priority section;
completed steps for an open task stay with that task. It reads shared View answered
and hidden semantics, retaining the existing 12-hour stale-session rule. The
proposed 3/7-day question aging in #66 is **not implemented** by this option.

The UTC snapshot time is when the records were read. Source modification times,
block `updated=` values and inbox receipt times describe records, not verified live
observations. Missing, unreadable and incomplete sources are named without local
paths. Unmerged reports are excerpts, not proof of completion. Hidden questions
are not repeated in task details or matching pending excerpts.

"Completed" means journal entries for **today's local calendar date
(00:00–24:00)**. `parseJournal` retains dates only: exact completion times and a
since-last-message delta are unknown. Duplicate journal entries are grouped by
project, task title and step text; the journal has no session identity. A task
reported done without a matching entry appears as reported complete with no
established completion date, not as newly completed. No percentage is inferred.
The formatter withholds paths, credential forms, links, HTML and control sequences;
it does not shorten work to terminal width. All examples in the automated tests
are synthetic, and tests use no live user board or real model.

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
- Consequential actions, above all merging a pull request, always need the
  user's explicit consent for that specific change and its test results,
  whatever the board shows.
- **Source of truth.** For a remote reporter, the conversation with the user
  is the source of truth; the board is a mirror. If they ever disagree, the
  conversation wins. A remote `[?]` step should say where to answer, e.g.
  `- [?] Git or chat relay for transport? (please reply in the chat)`.

## Transports (the user's choice)

The reporter writes a fragment file; something must carry it to the board's
machine and merge it into `progress.md`.

| Transport | How | Notes | Expected latency |
|---|---|---|---|
| Chat relay | The agent pastes the fragment; the user (or their local agent) saves it and runs the merge | Zero setup; manual per update | Immediate on paste, but only when the user acts |
| Git | Fragments pushed to a repo; the board's machine pulls on a schedule and merges | Automatic after one-time setup; versioned; recommended | As often as the pull schedule runs |
| Cloud drive | Fragment in a shared folder; a local script pulls and merges | Needs a local script anyway | As often as the sync and the local script run |

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

Or, with no script to run: open the board's page (`node
~/.claude/agent-board.mjs --serve`, or `/board` in another agent), copy this
prompt from it with **Copy the prompt for a web chat**, and paste each block
the chat prints into its box, fence and all. The page checks the block the
way `validate.py --block` does, replaces the earlier block with the same id
only when it is the same agent's and closed, never Claude's or another
agent's, and sets `updated=` to the time of the paste. `tests/board.test.mjs`
checks the prompt above and the page's copy match word for word.

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
| Orphan blocks (session died without `state=ended`) | The usual staleness and archive rules apply; the registry makes orphans rare, and `reporter.py retire` closes the session honestly while its id is in the registry and its fragment in the outbox — a lost id leaves an orphan that only the staleness and archive rules clear | Implemented and tested |
| Impersonation (`agent=` is self-declared) | No auth in the format; acceptable for a personal board | Documented |
| A fragment choosing where a local agent runs | The board's page answers a closed Grok Build or Codex session by its `resume=` id in its `dir=` folder; `merge.py` drops both from every fragment, since a session on another machine cannot be resumed here | Implemented and tested |
| Secrets leaking through the transport | Keep secrets out of blocks; choose the transport accordingly | Documented |

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

# remote-reporter — reference implementation

Tested Python scripts for a **remote reporter**: an agent that cannot run on
the board's machine (no local hooks, no shared filesystem) but wants its work
to show on the pane. Implements the interface in
[`docs/REMOTE_REPORTERS.md`](../../docs/REMOTE_REPORTERS.md); the file format
is [`docs/FORMAT.md`](../../docs/FORMAT.md) v1.

Needs only Python 3. No `claude` CLI.

## Files

| File | Does |
|---|---|
| `reporter.py` | Builds this agent's block fragment. Keeps a session registry (`outbox/sessions.json`: chat id → 8-hex session) so the id survives restarts. Agent name from `BOARD_AGENT_NAME` (default `muse`). |
| `merge.py` | Merges fragment files into `progress.md`: replaces the block with the same session id, appends new ones (under an optional `## <project>` heading via `--under`). Byte-preserving outside blocks, atomic temp+rename, read-back retry ×3. Idempotent. Refuses invalid fragments. |
| `validate.py` | Checks blocks/files against FORMAT.md: marker shape and column, required attributes, `state` enum, ISO 8601 `updated=`, matching end marker, step marks. |
| `test_pipeline.py` | 31 tests: fresh merge, state updates, multi-writer, idempotency, 6 malformed-fragment rejections, read-back verification. |

## Use

```sh
# one 8-hex session id per conversation; stored, reused across restarts
python3 reporter.py init <chat-id>

# write steps: '> ' quote, 'x ' done, '- ' todo, '? ' needs-user,
# '[~]','[>]','[!]','[-]' also accepted in fragments
python3 reporter.py update <chat-id> <working|waiting|done|ended> "<title>" steps.txt

# merge into the board file (transport-agnostic: git, chat relay, drive…)
python3 merge.py /path/to/progress.md outbox/muse-<session>.md [--under "## my-project"]

# check a file
python3 validate.py /path/to/progress.md

# run the tests
python3 test_pipeline.py
```

Steps file example (`steps.txt`):

```
> status line shown on the pane
> Context: why this work exists
x first finished step
~ the step in progress
? what do you want for the demo, A or B?
- the next step
```

## What it does not do

It writes fragments and merges them. Transport to the board's machine, and
anything board→agent, are out of scope by design — see REMOTE_REPORTERS.md.

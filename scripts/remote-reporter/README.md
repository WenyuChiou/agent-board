# remote-reporter: reference implementation

Tested Python scripts for a **remote reporter**: an agent that cannot run on
the board's machine (no local hooks, no shared filesystem) but wants its work
to show on the pane. Implements [`docs/REMOTE_REPORTERS.md`](../../docs/REMOTE_REPORTERS.md);
the file format is [`docs/FORMAT.md`](../../docs/FORMAT.md) v1.

Needs only Python 3 (stdlib). No `claude` CLI.

## Files

| File | Does |
|---|---|
| `reporter.py` | Builds this agent's block fragment, `<agent>-<session>.md` in the outbox. Keeps a session registry (`sessions.json`: chat id to 8-hex session) so the id survives restarts. Both live in `$AGENT_BOARD_REMOTE_DIR`, else `$CLAUDE_CONFIG_DIR/remote-reporter/`, else `~/.claude/remote-reporter/`, never in this folder. Agent name from `BOARD_AGENT_NAME` (default `remote`); with `BOARD_PROJECT` set, the fragment starts with `## <project>`. Refuses control characters, `<!--` and `-->` in text. `retire` closes a session as `ended`, keeping its title and steps, and mints a new id for the chat. |
| `merge.py` | Merges fragments into `progress.md`: replaces the block with the same session id (also one with no end marker), or places a new one under its `## <project>` (from the fragment or `--under`; refuses without one). Reads the file the way `hooks/parse.ts` does (code fences and HTML comments skipped, CRLF, any attribute order), keeps line endings and file mode, writes a temp file and `os.replace`s it, reads back and retries up to 3 times. Idempotent. Refuses invalid fragments. |
| `validate.py` | Checks a board file or a fragment against FORMAT.md. On a board, a session id that is not 8 hex and a block with no end marker are warnings; in a fragment, 8 hex is required and no marker, fence, `##` or unclosed comment may sit in the body. |
| `test_pipeline.py` | The tests. They run in a temporary folder and leave the checkout as it was. |

## Use

```sh
export BOARD_AGENT_NAME=myagent BOARD_PROJECT=my-project

# one 8-hex session id per conversation; stored, reused across restarts
python3 reporter.py init <chat-id>

# rebuild the fragment from a steps file
python3 reporter.py update <chat-id> <working|waiting|done|ended> "<title>" steps.txt

# close the session honestly and start fresh (clean break; the session must have reported,
# and its id and fragment must still be in the registry and the outbox)
python3 reporter.py retire <chat-id> ["reason"]

# merge into the board file (transport-agnostic: git, chat relay, drive...)
python3 merge.py /path/to/progress.md ~/.claude/remote-reporter/outbox/myagent-<session>.md
# a fragment without a '## project' line needs: --under "## my-project"

# check a board file, or a fragment
python3 validate.py /path/to/progress.md
python3 validate.py --block ~/.claude/remote-reporter/outbox/myagent-<session>.md

# run the tests
python3 -B test_pipeline.py
```

Steps file example (`steps.txt`):

```
> status line shown on the pane
> Context: why this work exists
x first finished step
~ the step in progress
? 24 hours or 7 days?
[>] waiting for CI
- the next step
```

`x` done, `~` doing, `-` todo, `?` needs the user, `!` blocked, `>` a note;
`[<mark>]` gives any FORMAT.md mark, such as `[>]` running or `[-]` cancelled.

## What it does not do

It writes fragments and merges them. Carrying them to the board's machine,
and anything from the board back to the agent, are out of scope by design;
see REMOTE_REPORTERS.md.

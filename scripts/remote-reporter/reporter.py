#!/usr/bin/env python3
"""Remote reporter for Agent Board.

Builds an agent's block fragment per docs/FORMAT.md v1. The fragment is what
a transport (git, chat relay, cloud drive) carries to the board's machine,
where merge.py merges it into progress.md.

Usage:
    python3 reporter.py init <chat-id>
        -> mint (or reuse) an 8-hex session id for this chat, store it in the registry
    python3 reporter.py update <chat-id> <state> <title> <steps-file>
        -> rebuild the fragment from the title and the steps file
    python3 reporter.py show <chat-id>
        -> print the current fragment
    python3 reporter.py retire <chat-id> ["reason"]
        -> close the chat's current session as ended, keeping its title and
           steps, and mint a fresh session id, for a clean break; the session
           must have reported at least once

Environment:
    BOARD_AGENT_NAME        the agent= name, lower case (default: remote)
    BOARD_PROJECT           if set, the fragment starts with `## <project>`, so
                            merge.py knows where a new block goes
    AGENT_BOARD_REMOTE_DIR  where the registry and outbox live; else
                            $CLAUDE_CONFIG_DIR/remote-reporter, else
                            ~/.claude/remote-reporter

Steps file format (one per line):
    > <note>              -> a '> ' line (status, or 'Context: ...')
    x <step>              -> - [x]  done
    ~ <step>              -> - [~]  doing
    - <step>              -> - [ ]  todo
    ? <step>              -> - [?]  needs the user
    ! <step>              -> - [!]  blocked
    [<mark>] <step>       -> - [<mark>]  any FORMAT.md mark, e.g. [>] or [-]
"""
import json
import os
import re
import secrets
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
STATES = {"working", "waiting", "done", "ended"}
MARKS = " x~?>!-"
SHORT_MARKS = {"x": "x", "~": "~", "-": " ", "?": "?", "!": "!"}
AGENT_RE = re.compile(r"^[a-z0-9_-]+$")
# Control characters (newlines included) would split a line into several, and
# comment openers or closers would turn text into a marker or hide the end marker.
UNSAFE_RE = re.compile(r"[\x00-\x1f\x7f\u0085  ]|<!--|-->")

sys.path.insert(0, HERE)
from validate import START_RE, fragment_parts, parse_attrs, read_text, validate_block  # noqa: E402


def remote_dir():
    """The registry and outbox live outside the plugin folder, which a plugin
    update replaces: losing the registry would re-mint ids and orphan blocks."""
    explicit = os.environ.get("AGENT_BOARD_REMOTE_DIR")
    if explicit:
        return explicit
    config = os.environ.get("CLAUDE_CONFIG_DIR")
    if config:
        return os.path.join(config, "remote-reporter")
    return os.path.join(os.path.expanduser("~"), ".claude", "remote-reporter")


def registry_path():
    return os.path.join(remote_dir(), "sessions.json")


def outbox_dir():
    return os.path.join(remote_dir(), "outbox")


def agent_name():
    agent = os.environ.get("BOARD_AGENT_NAME") or "remote"
    if not AGENT_RE.match(agent):
        raise SystemExit(f"BOARD_AGENT_NAME must be lower case letters, digits, '_' or '-', got {agent!r}")
    return agent


def fragment_path(session):
    return os.path.join(outbox_dir(), f"{agent_name()}-{session}.md")


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    # os.replace overwrites on Windows too; os.rename raises there if the file exists.
    os.replace(tmp, path)


def load_registry():
    path = registry_path()
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def session_for(chat_id):
    reg = load_registry()
    if chat_id not in reg:
        reg[chat_id] = secrets.token_hex(4)  # 8 hex chars
        write_atomic(registry_path(), json.dumps(reg, indent=2, sort_keys=True) + "\n")
    return reg[chat_id]


def check_text(what, text):
    if not text.strip():
        raise ValueError(f"{what} is empty")
    if UNSAFE_RE.search(text):
        raise ValueError(f"{what} has a control character, '<!--' or '-->': {text!r}")
    return text.strip()


def build_block(session, state, title, quote_lines, steps, agent=None):
    agent = agent or agent_name()
    lines = [
        f"<!-- auto session={session} agent={agent} state={state} updated={now_iso()} -->",
        f"### {check_text('title', title)}",
    ]
    lines.extend(quote_lines)
    lines.extend(steps)
    lines.append(f"<!-- /auto session={session} -->")
    return lines


def parse_steps_file(path):
    quotes, steps = [], []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\r\n")
            if not line.strip():
                continue
            m = re.match(r"^\[(.)\]\s*(.*)$", line)
            if m and m.group(1) in MARKS:
                steps.append(f"- [{m.group(1)}] {check_text('step', m.group(2))}")
                continue
            kind, text = line[0], line[1:]
            if kind == ">":
                quotes.append(f"> {check_text('note', text)}")
            elif kind in SHORT_MARKS:
                steps.append(f"- [{SHORT_MARKS[kind]}] {check_text('step', text)}")
            else:
                raise ValueError(f"bad steps line: {line!r} (use '> ', 'x ', '~ ', '- ', '? ', '! ' or '[mark] ')")
    return quotes, steps


def cmd_init(chat_id):
    print(f"chat {chat_id!r} -> session {session_for(chat_id)}")


def cmd_update(chat_id, state, title, steps_file):
    if state not in STATES:
        raise SystemExit(f"state must be one of {sorted(STATES)}")
    sess = session_for(chat_id)
    if not re.fullmatch(r"[0-9a-f]{8}", sess):
        raise SystemExit("registry session id malformed")
    try:
        quotes, steps = parse_steps_file(steps_file)
        lines = build_block(sess, state, title, quotes, steps)
        project = os.environ.get("BOARD_PROJECT", "").strip()
        if project:
            check_text("BOARD_PROJECT", project)
    except ValueError as e:
        raise SystemExit(str(e))
    errs = [e for e in validate_block(lines) if not e.startswith("warning:")]
    if errs:
        raise SystemExit(f"generated block invalid: {errs}")
    head = [f"## {project}", ""] if project else []
    frag = fragment_path(sess)
    write_atomic(frag, "\n".join(head + lines) + "\n")
    print(f"wrote {frag} (session {sess}, state {state})")


def cmd_show(chat_id):
    with open(fragment_path(session_for(chat_id)), encoding="utf-8") as f:
        print(f.read(), end="")


def cmd_retire(chat_id, reason="session retired"):
    """Close the current session honestly and mint a fresh id.

    For a clean break: the session's last fragment is written again as
    state=ended, with its project, title, notes and steps kept and the reason
    added as a note, so the block is closed instead of orphaned. A session
    already done or ended is left as it is. The next update starts under a new
    session id.
    """
    reg = load_registry()
    # A chat missing from the registry has no block on the board to close: minting one here
    # would add an ended block for work that was never reported, and leave the real orphan.
    if chat_id not in reg:
        raise SystemExit(f"chat {chat_id!r} is not in the registry {registry_path()}: no session to retire")
    sess = reg[chat_id]
    if not re.fullmatch(r"[0-9a-f]{8}", sess):
        raise SystemExit("registry session id malformed")
    frag = fragment_path(sess)
    # `init` and `show` put a chat in the registry before it reports anything, so being there
    # does not mean a block exists to close.
    if not os.path.exists(frag):
        raise SystemExit(f"session {sess} has not reported yet ({frag} is missing): nothing to retire")
    project, old = fragment_parts(read_text(frag))
    # A fragment edited by hand or cut short could lose its last step when rewritten.
    start = START_RE.match(old[0]) if old else None
    if start is None or [e for e in validate_block(old) if not e.startswith("warning:")]:
        raise SystemExit(f"{frag} is not a valid block: retire it by hand")
    attrs = parse_attrs(start.group(1))
    try:
        note = f"> {check_text('reason', reason)}"
    except ValueError as e:
        raise SystemExit(str(e))
    # A finished session keeps its own state: rewriting it as ended would move finished work
    # to the left-behind group.
    if attrs.get("state") not in ("done", "ended"):
        body = old[2:-1]
        notes = 0
        while notes < len(body) and body[notes].startswith(">"):
            notes += 1
        lines = [
            f"<!-- auto session={sess} agent={attrs.get('agent') or agent_name()} state=ended updated={now_iso()} -->",
            old[1],
            *body[:notes],
            note,
            *body[notes:],
            f"<!-- /auto session={sess} -->",
        ]
        errs = [e for e in validate_block(lines) if not e.startswith("warning:")]
        if errs:
            raise SystemExit(f"retire block invalid: {errs}")
        # The project line stays, so merge.py can still place the block if it is not on the board.
        head = [f"## {project}", ""] if project else []
        write_atomic(frag, "\n".join(head + lines) + "\n")
    reg[chat_id] = secrets.token_hex(4)
    write_atomic(registry_path(), json.dumps(reg, indent=2, sort_keys=True) + "\n")
    print(f"retired session {sess}; new session {reg[chat_id]} for {chat_id!r}")


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cmd, chat_id = sys.argv[1], sys.argv[2]
    if cmd == "init":
        cmd_init(chat_id)
    elif cmd == "update":
        if len(sys.argv) != 6:
            print("usage: reporter.py update <chat-id> <state> <title> <steps-file>", file=sys.stderr)
            return 2
        cmd_update(chat_id, sys.argv[3], sys.argv[4], sys.argv[5])
    elif cmd == "show":
        cmd_show(chat_id)
    elif cmd == "retire":
        reason = sys.argv[3] if len(sys.argv) > 3 else "session retired"
        cmd_retire(chat_id, reason)
    else:
        print(f"unknown command {cmd}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

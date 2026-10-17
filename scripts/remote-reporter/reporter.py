#!/usr/bin/env python3
"""Flint (Muse) reporter for Agent Board.

Maintains my agent block fragment per docs/FORMAT.md v1 and my reporter spec.
The fragment is what gets transported to the shared progress.md (via the
transport the user chooses: git / chat relay / drive).

Usage:
    python3 reporter.py init <chat-id>
        -> mint (or reuse) an 8-hex session id for this chat, store in registry
    python3 reporter.py update <chat-id> <state> <title> [steps-file]
        -> rebuild my fragment from title + steps file
    python3 reporter.py show <chat-id>
        -> print current fragment

Steps file format (one per line):
    x <finished step>     -> - [x]
    - <todo step>         -> - [ ]
    ? <waiting question>  -> - [?]
    > <status/context>    -> > quote lines (first two: status, Context:)
"""
import json
import os
import re
import sys
import secrets
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.join(HERE, "outbox", "sessions.json")
OUTBOX = os.path.join(HERE, "outbox")
STATES = {"working", "waiting", "done", "ended"}

sys.path.insert(0, HERE)
from validate import validate_block  # noqa: E402


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_registry():
    if os.path.exists(REGISTRY):
        with open(REGISTRY, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_registry(reg):
    os.makedirs(os.path.dirname(REGISTRY), exist_ok=True)
    tmp = REGISTRY + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(reg, f, indent=2, sort_keys=True)
        f.write("\n")
    os.rename(tmp, REGISTRY)


def session_for(chat_id):
    reg = load_registry()
    if chat_id not in reg:
        reg[chat_id] = secrets.token_hex(4)  # 8 hex chars
        save_registry(reg)
    return reg[chat_id]


def build_block(session, state, title, quote_lines, steps, agent=None):
    agent = agent or os.environ.get("BOARD_AGENT_NAME", "muse")
    lines = [
        f"<!-- auto session={session} agent={agent} state={state} updated={now_iso()} -->",
        f"### {title}",
    ]
    lines.extend(quote_lines)
    lines.extend(steps)
    lines.append(f"<!-- /auto session={session} -->")
    return lines


def parse_steps_file(path):
    quotes, steps = [], []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip():
                continue
            kind, text = line[0], line[1:].strip()
            if kind == ">":
                quotes.append(f"> {text}")
            elif kind == "x":
                steps.append(f"- [x] {text}")
            elif kind == "-":
                steps.append(f"- [ ] {text}")
            elif kind == "?":
                steps.append(f"- [?] {text}")
            else:
                raise ValueError(f"bad steps line: {line!r} (use '> ', 'x ', '- ', '? ')")
    return quotes, steps


def cmd_init(chat_id):
    sess = session_for(chat_id)
    print(f"chat {chat_id!r} -> session {sess}")


def cmd_update(chat_id, state, title, steps_file):
    if state not in STATES:
        raise SystemExit(f"state must be one of {sorted(STATES)}")
    if not re.fullmatch(r"[0-9a-f]{8}", session_for(chat_id)):
        raise SystemExit("registry session id malformed")
    sess = session_for(chat_id)
    quotes, steps = parse_steps_file(steps_file)
    lines = build_block(sess, state, title, quotes, steps)
    errs = [e for e in validate_block(lines) if not e.startswith("warning:")]
    if errs:
        raise SystemExit(f"generated block invalid: {errs}")
    os.makedirs(OUTBOX, exist_ok=True)
    frag = os.path.join(OUTBOX, f"muse-{sess}.md")
    tmp = frag + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(lines) + "\n")
    os.rename(tmp, frag)
    print(f"wrote {frag} (session {sess}, state {state})")


def cmd_show(chat_id):
    sess = session_for(chat_id)
    frag = os.path.join(OUTBOX, f"muse-{sess}.md")
    with open(frag, encoding="utf-8") as f:
        print(f.read(), end="")


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
    else:
        print(f"unknown command {cmd}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

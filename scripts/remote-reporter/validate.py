#!/usr/bin/env python3
"""Validate Agent Board progress.md blocks against docs/FORMAT.md v1.

Usage:
    python3 validate.py <file>          # validate whole file (all blocks)
    python3 validate.py --block <file>  # validate a single fragment file
Returns 0 if valid, 1 with reasons on stderr if not.
"""
import re
import sys
from datetime import datetime

STATES = {"working", "waiting", "done", "ended"}
# FORMAT.md v1: <!-- auto session=<8hex> agent=<name> state=<state> updated=<ISO8601> [...] -->
START_RE = re.compile(r"^<!-- auto session=(\S+)(.*?)-->$")
END_RE = re.compile(r"^<!-- /auto session=(\S+) -->$")
SESSION_RE = re.compile(r"^[0-9a-f]{8}$")
STEP_RE = re.compile(r"^- \[( |x|~|\?|>|!|-)\] .+")
ATTR_RE = re.compile(r"([A-Za-z0-9_-]+)=(\S+)")


def parse_attrs(attr_text):
    return dict(ATTR_RE.findall(attr_text))


def check_iso8601(s):
    try:
        v = s.replace("Z", "+00:00")
        datetime.fromisoformat(v)
        return True
    except ValueError:
        return False


def validate_block(lines, fname="<block>"):
    """Validate one block (list of lines including markers). Returns list of errors."""
    errs = []
    if not lines:
        return ["empty block"]
    m = START_RE.match(lines[0])
    if not m:
        return [f"line 1: bad start marker: {lines[0][:80]!r}"]
    session = m.group(1)
    attrs = parse_attrs(m.group(2))
    agent = attrs.get("agent", "claude")
    state = attrs.get("state", "waiting")
    updated = attrs.get("updated", "")
    if agent != agent.lower():
        errs.append("agent must be lower case")
    if not SESSION_RE.match(session):
        errs.append(f"session must be 8 hex chars, got {session!r}")
    if state not in STATES:
        errs.append(f"state must be one of {sorted(STATES)}, got {state!r}")
    if not check_iso8601(updated):
        errs.append(f"updated must be ISO 8601, got {updated!r}")
    # end marker
    if len(lines) < 2:
        return errs + ["block has no end marker"]
    em = END_RE.match(lines[-1])
    if not em:
        errs.append(f"last line: bad end marker: {lines[-1][:80]!r}")
    elif em.group(1) != session:
        errs.append("end marker session does not match start marker")
    # body: first line after start must be ### title
    body = lines[1:-1]
    if not body or not body[0].startswith("### "):
        errs.append("first body line must be '### <title>'")
    titles = [l for l in body if l.startswith("### ")]
    if len(titles) > 1:
        errs.append("warning: more than one '### ' title; extras read as hand-kept tasks")
    for i, l in enumerate(body):
        if l.startswith("- [") and not STEP_RE.match(l):
            errs.append(f"body line {i+2}: malformed step: {l[:60]!r}")
    # markers must be at column 0 (regex ^ already enforces), and no stray markers inside
    for i, l in enumerate(body):
        if "<!--" in l and ("agent=" in l or "/agent=" in l):
            errs.append(f"body line {i+2}: stray marker-like comment inside body")
    return errs


def extract_blocks(text):
    """Split text into (segments). Returns (outside_parts, blocks dict session->lines)."""
    lines = text.split("\n")
    outside = []
    blocks = {}
    i = 0
    cur_out = []
    while i < len(lines):
        if START_RE.match(lines[i]):
            if cur_out:
                outside.append("\n".join(cur_out))
                cur_out = []
            j = i
            while j < len(lines) and not END_RE.match(lines[j]):
                j += 1
            if j >= len(lines):
                # unterminated: treat rest as outside (don't silently drop)
                cur_out.extend(lines[i:])
                break
            block_lines = lines[i:j + 1]
            m = START_RE.match(lines[i])
            sess = m.group(1)
            blocks[sess] = block_lines
            i = j + 1
        else:
            cur_out.append(lines[i])
            i += 1
    if cur_out:
        outside.append("\n".join(cur_out))
    return outside, blocks


def validate_file(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if "\u0000" in text:
        return ["file contains NUL bytes"]
    outside, blocks = extract_blocks(text)
    errs = []
    if len(blocks) != len(set(blocks)):
        errs.append("duplicate session ids")
    for sess, blines in blocks.items():
        for e in validate_block(blines, path):
            errs.append(f"session {sess}: {e}")
    # every start marker line must be at col 0 (regex ensures); check raw lines too
    for n, l in enumerate(text.split("\n"), 1):
        if "<!--" in l and "agent=" in l and not (START_RE.match(l) or END_RE.match(l)):
            if l.lstrip() != l:
                errs.append(f"line {n}: marker not at column 0")
    return errs


def main():
    args = sys.argv[1:]
    if not args:
        print("usage: validate.py [--block] <file>", file=sys.stderr)
        return 2
    path = args[-1]
    try:
        errs = validate_file(path)
    except FileNotFoundError:
        print(f"not found: {path}", file=sys.stderr)
        return 2
    if errs:
        print(f"INVALID {path}:", file=sys.stderr)
        for e in errs:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print(f"VALID {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

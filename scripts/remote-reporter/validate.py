#!/usr/bin/env python3
"""Validate Agent Board progress.md blocks against docs/FORMAT.md v1.

Usage:
    python3 validate.py <file>          # validate a whole board file (all blocks)
    python3 validate.py --block <file>  # validate a single fragment file
Returns 0 if valid (warnings are printed but do not fail), 1 with reasons on
stderr if not.

The scanner here reads the file the way hooks/parse.ts does: lines split on
\\r?\\n, fenced code and HTML comments skipped, markers matched as whole lines
with attributes in any order. A block the pane would not see is not a block
here either, so a merge never rewrites an example inside a fence.
"""
import re
import sys
from datetime import datetime

STATES = {"working", "waiting", "done", "ended"}
# The same shapes as AUTO_START / AUTO_END / FENCE / PROJECT / TASK in hooks/parse.ts.
START_RE = re.compile(r"^<!--\s*auto\s+(.*?)\s*-->\s*$")
END_RE = re.compile(r"^<!--\s*/auto\b(.*?)-->\s*$")
QUESTION_RE = re.compile(r"^<!--\s*question=([a-f0-9]{64}:[1-9]\d*)\s*-->\s*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
PROJECT_RE = re.compile(r"^##\s+(.+?)\s*#*\s*$")
TASK_RE = re.compile(r"^###\s+(.+?)\s*#*\s*$")
ATTR_RE = re.compile(r"([\w-]+)=(\S+)")
HEX8_RE = re.compile(r"^[0-9a-f]{8}$")
STEP_RE = re.compile(r"^- \[( |x|~|\?|>|!|-)\] .+")
MARKER_PREFIXES = ("auto session=", "/auto session=", "question=")


def is_cut_marker(line):
    if not line.startswith("<!--") or "-->" in line:
        return False
    marker = re.sub(r"^<!--[ \t]*", "", line.rstrip(" \t\r"))
    return marker != "" and any(prefix.startswith(marker) or marker.startswith(prefix)
                                     for prefix in MARKER_PREFIXES)


def split_lines(text):
    """Split like the parser, dropping the final line break. Returns (lines, eol)."""
    eol = "\r\n" if "\r\n" in text else "\n"
    if text == "":
        return [], eol
    return re.split(r"\r?\n", re.sub(r"\r?\n$", "", text)), eol


def parse_attrs(attr_text):
    return dict(ATTR_RE.findall(attr_text))


def start_session(line):
    """The session id of a start marker line, or None if the line is not one."""
    m = START_RE.match(line)
    if not m:
        return None
    return parse_attrs(m.group(1)).get("session")


def end_session(line):
    """For an end marker: its session id, or "" when it names none. None otherwise."""
    m = END_RE.match(line)
    if not m:
        return None
    return parse_attrs(m.group(1)).get("session", "")


def classify(lines):
    """Label each line as the parser sees it.

    Kinds: "hidden" (fence line, fenced, or inside a multi-line comment),
    "start", "end", "project", "task", "blank", "text". Markers are read
    before comment stripping, as whole lines, exactly as parse.ts does.
    """
    kinds = []
    fenced = False
    in_comment = False
    for index, raw in enumerate(lines):
        if FENCE_RE.match(raw):
            fenced = not fenced
            kinds.append("hidden")
            continue
        if fenced:
            kinds.append("hidden")
            continue
        if not in_comment and start_session(raw) is not None:
            kinds.append("start")
            continue
        if not in_comment and end_session(raw) is not None:
            kinds.append("end")
            continue
        if not in_comment and QUESTION_RE.match(raw):
            kinds.append("text")
            continue
        line = raw
        if in_comment:
            close = line.find("-->")
            if close < 0:
                kinds.append("hidden")
                continue
            in_comment = False
            line = line[close + 3:]
        if is_cut_marker(raw):
            has_boundary = False
            has_close = False
            for following_index in range(index + 1, len(lines)):
                following = lines[following_index]
                if START_RE.match(following) or END_RE.match(following) or PROJECT_RE.match(following):
                    has_boundary = True
                if "-->" in following:
                    has_close = True
                    break
            if has_boundary or not has_close:
                kinds.append("text")
                continue
        line = re.sub(r"<!--.*?-->", "", line)
        opened = line.find("<!--")
        if opened >= 0:
            in_comment = True
            line = line[:opened]
        if line.strip() == "":
            kinds.append("blank")
        elif PROJECT_RE.match(line):
            kinds.append("project")
        elif TASK_RE.match(line):
            kinds.append("task")
        else:
            kinds.append("text")
    return kinds


def scan_blocks(lines):
    """Find every block the parser would read. Returns a list of dicts:
    session, start, end (inclusive line indexes), closed, project.

    A block with no end marker ends where hooks/blocks.ts guesses it does: at
    the first blank line, a second `###`, the next block, the next `##` or a
    hidden line, so a fragment with its id replaces it instead of duplicating.
    """
    kinds = classify(lines)
    spans = []
    project = None
    for i, kind in enumerate(kinds):
        if kind == "project":
            project = PROJECT_RE.match(lines[i]).group(1)
            continue
        if kind != "start":
            continue
        session = start_session(lines[i])
        end = -1
        for j in range(i + 1, len(lines)):
            if kinds[j] in ("start", "project"):
                break
            if kinds[j] == "end" and end_session(lines[j]) in ("", session):
                end = j
                break
        if end >= 0:
            spans.append({"session": session, "start": i, "end": end, "closed": True, "project": project})
            continue
        last = i
        titles = 0
        for j in range(i + 1, len(lines)):
            if kinds[j] in ("blank", "start", "project", "end", "hidden"):
                break
            if kinds[j] == "task":
                titles += 1
                if titles > 1:
                    break
            last = j
        spans.append({"session": session, "start": i, "end": last, "closed": False, "project": project})
    return spans


def extract_blocks(text):
    """Map session id -> block lines, for every block in the text."""
    lines, _ = split_lines(text)
    return {s["session"]: lines[s["start"]:s["end"] + 1] for s in scan_blocks(lines)}


def check_iso8601(s):
    try:
        datetime.fromisoformat(s.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def validate_block(lines, strict=True):
    """Validate one block (lines including both markers). Returns a list of
    messages; those starting with "warning:" do not make the block invalid.

    strict is for fragments we write ourselves: the id must be 8 hex. A
    person's board may use any whitespace-free id, as FORMAT.md allows.
    """
    errs = []
    if not lines:
        return ["empty block"]
    session = start_session(lines[0])
    if session is None:
        return [f"line 1: bad start marker (or no session=): {lines[0][:80]!r}"]
    attrs = parse_attrs(START_RE.match(lines[0]).group(1))
    agent = attrs.get("agent", "claude")
    state = attrs.get("state", "waiting")
    updated = attrs.get("updated", "")
    if agent != agent.lower():
        errs.append("agent must be lower case")
    if not HEX8_RE.match(session):
        if strict:
            errs.append(f"session must be 8 hex chars, got {session!r}")
        else:
            errs.append(f"warning: session {session!r} is not 8 hex chars")
    if state not in STATES:
        errs.append(f"state must be one of {sorted(STATES)}, got {state!r}")
    if not check_iso8601(updated):
        errs.append(f"updated must be ISO 8601, got {updated!r}")
    if len(lines) < 2:
        return errs + ["block has no end marker"]
    ended = end_session(lines[-1])
    if ended is None:
        errs.append(f"last line: bad end marker: {lines[-1][:80]!r}")
    elif ended != session:
        errs.append("end marker session does not match start marker")
    body = lines[1:-1]
    if not body or not TASK_RE.match(body[0]):
        errs.append("first body line must be '### <title>'")
    if sum(1 for line in body if TASK_RE.match(line)) > 1:
        errs.append("warning: more than one '### ' title; extras read as hand-kept tasks")
    for n, line in enumerate(body, 2):
        # Each of these would end the block early or hide its end marker from the pane.
        if START_RE.match(line) or END_RE.match(line):
            errs.append(f"body line {n}: a block marker inside the body")
        elif FENCE_RE.match(line):
            errs.append(f"body line {n}: a code fence inside the body")
        elif PROJECT_RE.match(line):
            errs.append(f"body line {n}: a '## ' heading inside the body")
        elif "<!--" in re.sub(r"<!--.*?-->", "", line):
            errs.append(f"body line {n}: an unclosed HTML comment inside the body")
        elif line.startswith("- [") and not STEP_RE.match(line):
            errs.append(f"body line {n}: malformed step: {line[:60]!r}")
    return errs


def fragment_parts(text):
    """Split a fragment into (project or None, block lines).

    A fragment may start with a `## <project>` line naming the section a new
    block goes under; merge.py strips it before writing.
    """
    lines, _ = split_lines(text)
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    project = None
    if lines and PROJECT_RE.match(lines[0]):
        project = PROJECT_RE.match(lines[0]).group(1)
        lines.pop(0)
        while lines and not lines[0].strip():
            lines.pop(0)
    return project, lines


def validate_fragment_text(text):
    _, lines = fragment_parts(text)
    return validate_block(lines, strict=True)


def validate_text(text):
    if "\u0000" in text:
        return ["file contains NUL bytes"]
    lines, _ = split_lines(text)
    errs = []
    seen = set()
    for span in scan_blocks(lines):
        sess = span["session"]
        if sess in seen:
            errs.append(f"duplicate session id {sess!r}")
        seen.add(sess)
        if not span["closed"]:
            errs.append(f"warning: session {sess}: no end marker; it reads but is never archived")
            continue
        for e in validate_block(lines[span["start"]:span["end"] + 1], strict=False):
            prefix = "warning: " if e.startswith("warning:") else ""
            errs.append(f"{prefix}session {sess}: {e.removeprefix('warning: ')}")
    for n, line in enumerate(lines, 1):
        stripped = line.lstrip()
        if stripped != line and (START_RE.match(stripped) or END_RE.match(stripped)):
            errs.append(f"warning: line {n}: indented marker reads as a plain comment")
    return errs


def read_text(path):
    # newline="" keeps CRLF visible, so line endings are seen as they are on disk.
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def main():
    args = sys.argv[1:]
    if not args or len(args) > 2 or (len(args) == 2 and args[0] != "--block"):
        print("usage: validate.py [--block] <file>", file=sys.stderr)
        return 2
    path = args[-1]
    try:
        text = read_text(path)
    except FileNotFoundError:
        print(f"not found: {path}", file=sys.stderr)
        return 2
    msgs = validate_fragment_text(text) if args[0] == "--block" else validate_text(text)
    errs = [m for m in msgs if not m.startswith("warning:")]
    for m in msgs:
        if m.startswith("warning:"):
            print(f"  {m}", file=sys.stderr)
    if errs:
        print(f"INVALID {path}:", file=sys.stderr)
        for e in errs:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print(f"VALID {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

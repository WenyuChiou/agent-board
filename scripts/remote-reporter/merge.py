#!/usr/bin/env python3
"""Merge agent block fragments into a progress.md board file.

Follows FORMAT.md's concurrent-writer discipline: read, change only the
fragments' own blocks, write a temp file, replace, read back, and retry (up
to 3 times) if a block did not read back as written.

Usage:
    python3 merge.py [--under '## project'] <progress.md> <fragment1> [<fragment2> ...]

Each fragment file holds one agent block (markers and body), optionally
preceded by a `## <project>` line. A fragment whose session id is already on
the board replaces that block in place. A new block goes under its own
`## <project>` heading, taken from the fragment's first line or else from
--under; with neither, the merge refuses, because FORMAT.md places a block
under its own project and the last heading in the file is someone else's.

Lines outside the replaced blocks are kept as they are; the file keeps its
line endings (CRLF stays CRLF) and its mode. Re-merging the same fragments
gives the same bytes.
"""
import os
import stat
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validate import (  # noqa: E402
    PROJECT_RE,
    START_RE,
    classify,
    extract_blocks,
    fragment_parts,
    read_text,
    scan_blocks,
    split_lines,
    start_session,
    validate_block,
)

# The board's page answers a closed session by its `resume=` id, in its `dir=` folder. A session
# on another machine cannot be resumed on this one, so a fragment never brings either: else text
# from elsewhere would pick the folder a local agent runs in.
LOCAL_ONLY = ("resume", "dir")


def local_marker(line):
    """The start marker without the attributes only this machine may write."""
    attrs = START_RE.match(line).group(1).split()
    kept = [a for a in attrs if a.split("=", 1)[0] not in LOCAL_ONLY]
    return line if len(kept) == len(attrs) else f"<!-- auto {' '.join(kept)} -->"


def heading_name(under):
    """Accept `## webapp` or `webapp` for --under."""
    if under is None:
        return None
    m = PROJECT_RE.match(under.strip())
    name = m.group(1) if m else under.strip()
    return name or None


def parse_fragments(fragments, under=None):
    """Validate fragments. Returns a list of (session, project, lines)."""
    default_project = heading_name(under)
    parsed = []
    for frag in fragments:
        project, lines = fragment_parts(frag)
        errs = [e for e in validate_block(lines, strict=True) if not e.startswith("warning:")]
        if errs:
            raise ValueError(f"fragment invalid: {errs}")
        parsed.append((start_session(lines[0]), project or default_project, [local_marker(lines[0]), *lines[1:]]))
    return parsed


def section_range(lines, project):
    """(heading index, end index) of `## project`, ignoring fenced and commented lines."""
    kinds = classify(lines)
    heading = -1
    for i, kind in enumerate(kinds):
        if kind != "project":
            continue
        if heading < 0:
            if PROJECT_RE.match(lines[i]).group(1) == project:
                heading = i
        else:
            return heading, i
    if heading < 0:
        return None
    return heading, len(lines)


def place_new(lines, project, block):
    """Insert a new block the way hooks/blocks.ts upsertAutoBlock does: after
    what is already in its section, one blank line before the start marker and
    one after the end marker (also before a following `##`)."""
    # A comment opening in the heading would hide every line after it up to the next `-->`,
    # other blocks with them. reporter.py refuses one in BOARD_PROJECT; a fragment written by
    # hand, or --under, is refused here.
    if "<!--" in project or "-->" in project:
        raise ValueError(f"project heading has '<!--' or '-->': {project!r}")
    if all(not line.strip() for line in lines):
        return [f"## {project}", "", *block]
    section = section_range(lines, project)
    if section is None:
        lines = list(lines)
        while lines and not lines[-1].strip():
            lines.pop()
        return [*lines, "", f"## {project}", "", *block]
    heading, end = section
    at = end
    while at > heading + 1 and not lines[at - 1].strip():
        at -= 1
    is_last = end >= len(lines)
    return [*lines[:at], "", *block, *([] if is_last else [""]), *lines[end:]]


def merge_text(board_text, fragments, under=None):
    """Return the board text with fragments merged. Pure function (testable).

    Raises ValueError for an invalid fragment, or for a new block with no
    project heading to go under.
    """
    lines, eol = split_lines(board_text)
    for session, project, block in parse_fragments(fragments, under):
        existing = next((s for s in scan_blocks(lines) if s["session"] == session), None)
        if existing is not None:
            lines = [*lines[:existing["start"]], *block, *lines[existing["end"] + 1:]]
            continue
        if project is None:
            raise ValueError(
                f"session {session} is not on the board yet: give its project with "
                f"--under '## <project>' or a '## <project>' first line in the fragment"
            )
        lines = place_new(lines, project, block)
    return eol.join(lines) + eol


def atomic_write(path, text):
    """Write a temp file in the same folder and replace the board with it, so a
    reader never sees half a file. os.replace, unlike os.rename, overwrites an
    existing file on Windows too."""
    d = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".progress-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        # mkstemp makes the file 0600; keep the board's own mode instead.
        if os.path.exists(path):
            os.chmod(tmp, stat.S_IMODE(os.stat(path).st_mode))
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def merge_file(board_path, fragment_paths, retries=3, under=None):
    """Merge fragments into the board file with read-back retry. Returns attempts used."""
    fragments = [read_text(p) for p in fragment_paths]
    try:
        expected = {sess: block for sess, _, block in parse_fragments(fragments, under)}
    except ValueError as e:
        raise SystemExit(f"merge aborted: {e}")

    last_err = None
    for attempt in range(1, retries + 1):
        current = read_text(board_path)
        try:
            new_text = merge_text(current, fragments, under=under)
        except ValueError as e:
            raise SystemExit(f"merge aborted: {e}")
        atomic_write(board_path, new_text)
        blocks = extract_blocks(read_text(board_path))
        bad = [s for s, block in expected.items() if blocks.get(s) != block]
        if not bad:
            return attempt
        last_err = f"session {bad[0]} did not read back as written (attempt {attempt})"
    raise SystemExit(f"merge failed after {retries} retries: {last_err}")


USAGE = "usage: merge.py [--under '## project'] <progress.md> <fragment1> [fragment2 ...]"


def main():
    args = sys.argv[1:]
    under = None
    if args and args[0] == "--under":
        if len(args) < 2:
            print(USAGE, file=sys.stderr)
            return 2
        under = args[1]
        args = args[2:]
    if len(args) < 2:
        print(USAGE, file=sys.stderr)
        return 2
    board, frags = args[0], args[1:]
    if not os.path.exists(board):
        # FORMAT.md: a missing file reads as empty and the first writer creates it.
        with open(board, "w", encoding="utf-8"):
            pass
    attempts = merge_file(board, frags, under=under)
    print(f"merged {len(frags)} fragment(s) into {board} (attempts: {attempts})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Merge agent block fragments into a progress.md board file.

Implements the FORMAT.md concurrent-writer discipline:
  read -> change only own blocks -> write temp -> rename -> read back ->
  retry (up to 3) if own block did not read back as written.

Usage:
    python3 merge.py <progress.md> <fragment1> [<fragment2> ...]

Each fragment file holds one agent block (markers + body). Blocks are
matched by session id: existing block replaced, new one appended.
Everything outside blocks is preserved byte-for-byte. Idempotent.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validate import extract_blocks, validate_block, START_RE, END_RE  # noqa: E402


def merge_text(board_text, fragments, under=None):
    """Return new board text with fragments merged. Pure function (testable).

    New blocks go under the `under` heading (e.g. "## my-project"); the
    heading is added at the end of the file if missing. Without `under`,
    new blocks are appended at the end of the file.
    """
    # Parse board into tokens: list of ("text", str) / ("block", session, lines)
    lines = board_text.split("\n")
    tokens = []
    i = 0
    buf = []
    while i < len(lines):
        if START_RE.match(lines[i]):
            if buf:
                tokens.append(("text", "\n".join(buf)))
                buf = []
            j = i
            while j < len(lines) and not END_RE.match(lines[j]):
                j += 1
            if j >= len(lines):
                buf.extend(lines[i:])  # unterminated -> keep as text
                break
            m = START_RE.match(lines[i])
            tokens.append(("block", m.group(1), lines[i:j + 1]))
            i = j + 1
        else:
            buf.append(lines[i])
            i += 1
    if buf:
        tokens.append(("text", "\n".join(buf)))

    # Parse fragments
    frag_blocks = {}  # session -> lines
    for frag in fragments:
        flines = frag.split("\n")
        # strip leading/trailing blank lines
        while flines and not flines[0].strip():
            flines.pop(0)
        while flines and not flines[-1].strip():
            flines.pop()
        errs = validate_block(flines)
        real_errs = [e for e in errs if not e.startswith("warning:")]
        if real_errs:
            raise ValueError(f"fragment invalid: {real_errs}")
        m = START_RE.match(flines[0])
        frag_blocks[m.group(1)] = flines

    # Merge: replace matching sessions, append new ones at end
    seen = set()
    out_tokens = []
    for kind, *rest in tokens:
        if kind == "block":
            sess, blines = rest
            if sess in frag_blocks:
                out_tokens.append(("block", sess, frag_blocks[sess]))
                seen.add(sess)
            else:
                out_tokens.append(("block", sess, blines))
        else:
            out_tokens.append(("text", rest[0]))
    new_sessions = [s for s in frag_blocks if s not in seen]
    if new_sessions:
        if under:
            target = under.strip()
            # find the heading line inside a text token; the section ends at
            # the next "## " line or at the token's end
            placed = False
            for n, (kind, *rest) in enumerate(out_tokens):
                if kind != "text":
                    continue
                tlines = rest[0].split("\n")
                for li, tl in enumerate(tlines):
                    if tl.strip() == target:
                        end = len(tlines)
                        for k in range(li + 1, len(tlines)):
                            if tlines[k].startswith("## "):
                                end = k
                                break
                        head = "\n".join(tlines[:end]).rstrip("\n")
                        tail = "\n".join(tlines[end:])
                        new_toks = [("text", head), ("text", "")]
                        for s in new_sessions:
                            new_toks.append(("block", s, frag_blocks[s]))
                        if tail.strip():
                            new_toks.append(("text", tail))
                        out_tokens[n:n + 1] = new_toks
                        placed = True
                        break
                if placed:
                    break
            if not placed:
                # heading missing: add at end with blank lines around
                out_tokens.append(("text", ""))
                out_tokens.append(("text", target))
                out_tokens.append(("text", ""))
                for s in new_sessions:
                    out_tokens.append(("block", s, frag_blocks[s]))
        else:
            # ensure separation from trailing text
            out_tokens.append(("text", ""))
            for s in new_sessions:
                out_tokens.append(("block", s, frag_blocks[s]))

    # Render
    parts = []
    for kind, *rest in out_tokens:
        if kind == "text":
            parts.append(rest[0])
        else:
            parts.append("\n".join(rest[1]))
    text = "\n".join(parts)
    text = text.lstrip("\n")  # no leading blank lines on fresh files
    if not text.endswith("\n"):
        text += "\n"
    return text


def atomic_write(path, text):
    d = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".progress-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        os.rename(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def merge_file(board_path, fragment_paths, retries=3, under=None):
    """Merge fragments into board file with read-back retry. Returns attempts used."""
    with open(board_path, encoding="utf-8") as f:
        original = f.read()
    fragments = []
    for p in fragment_paths:
        with open(p, encoding="utf-8") as f:
            fragments.append(f.read())

    last_err = None
    for attempt in range(1, retries + 1):
        with open(board_path, encoding="utf-8") as f:
            current = f.read()
        try:
            new_text = merge_text(current, fragments, under=under)
        except ValueError as e:
            raise SystemExit(f"merge aborted: {e}")
        atomic_write(board_path, new_text)
        # read back and verify each fragment session reads back as written
        with open(board_path, encoding="utf-8") as f:
            check = f.read()
        _, blocks = extract_blocks(check)
        ok = True
        for frag in fragments:
            flines = frag.split("\n")
            while flines and not flines[0].strip():
                flines.pop(0)
            while flines and not flines[-1].strip():
                flines.pop()
            sess = START_RE.match(flines[0]).group(1)
            if sess not in blocks or blocks[sess] != flines:
                ok = False
                last_err = f"session {sess} did not read back as written (attempt {attempt})"
                break
        if ok:
            return attempt
    raise SystemExit(f"merge failed after {retries} retries: {last_err}")


def main():
    if len(sys.argv) < 3:
        print("usage: merge.py [--under '## heading'] <progress.md> <fragment1> [fragment2 ...]",
              file=sys.stderr)
        return 2
    args = sys.argv[1:]
    under = None
    if args[0] == "--under":
        if len(args) < 4:
            print("usage: merge.py [--under '## heading'] <progress.md> <fragment1> [fragment2 ...]",
                  file=sys.stderr)
            return 2
        under = args[1]
        args = args[2:]
    board = args[0]
    frags = args[1:]
    if not os.path.exists(board):
        with open(board, "w", encoding="utf-8") as f:
            f.write("")
    attempts = merge_file(board, frags, under=under)
    print(f"merged {len(frags)} fragment(s) into {board} (attempts: {attempts})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

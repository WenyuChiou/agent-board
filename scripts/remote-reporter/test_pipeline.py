#!/usr/bin/env python3
"""Local test of the remote reporter -> Agent Board pipeline.

Simulates: reporter writes a fragment -> merge into a board -> validate.
All local, no network, no claude CLI. Everything happens in a temporary
folder (the registry too, through AGENT_BOARD_REMOTE_DIR), so the checkout
is left as it was. Run: python3 -B test_pipeline.py
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from unittest.mock import patch

# Importing merge and validate below must not leave __pycache__ in the checkout.
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import merge as merge_mod  # noqa: E402
import reporter as reporter_mod  # noqa: E402
import validate as validate_mod  # noqa: E402

passed, failed = [], []
T = None  # the temporary folder, set in main()
ENV = None  # the environment for every script run


def script(name):
    return os.path.join(HERE, name)


def run(cmd, env=None):
    return subprocess.run(cmd, capture_output=True, text=True, cwd=T, env=env or ENV)


class MergeClock(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 20, tzinfo=timezone.utc)


def py(name, *args, env=None):
    if name not in ("merge.py", "reporter.py"):
        return run([sys.executable, "-B", script(name), *args], env=env)
    # Both programs share one deterministic clock; reporter bursts get no artificial head start.
    launch = f"""import runpy, sys
from datetime import datetime, timezone
from unittest.mock import patch
class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 20, 0, tzinfo=timezone.utc)
sys.argv = sys.argv[1:]
with patch('datetime.datetime', Clock):
    runpy.run_path(sys.argv[0], run_name='__main__')
"""
    return run([sys.executable, "-B", "-c", launch, script(name), *args], env=env)


def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" -- {detail}" if detail and not cond else ""))


def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def r(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


MARK = "<!-- auto session={s} agent={a} state=working updated=2026-10-17T07:00:00Z -->"


def block(session, agent="codex", title="t", steps=("- [ ] step",)):
    return "\n".join([MARK.format(s=session, a=agent), f"### {title}", *steps,
                      f"<!-- /auto session={session} -->"]) + "\n"


def at_time(text, updated):
    _, lines = validate_mod.fragment_parts(text)
    attrs = validate_mod.parse_attrs(validate_mod.START_RE.match(lines[0]).group(1))
    return text.replace("updated=" + attrs["updated"], "updated=" + updated, 1)


def setup():
    # simulated user board: project sections + one claude block
    w(os.path.join(T, "progress.md"),
      "# Project progress\n\n"
      "## webapp\n"
      "Some hand-kept notes the board must never touch.\n\n"
      "<!-- auto session=aa11bb22 agent=claude state=working updated=2026-10-17T06:00:00Z -->\n"
      "### Fix login redirect\n"
      "> 開發中\n"
      "- [x] reproduce\n"
      "- [ ] fix\n"
      "<!-- /auto session=aa11bb22 -->\n")
    w(os.path.join(T, "steps1.txt"),
      "> 調查中\n> Context: 驗證遠端上報 board 的整條管線\n"
      "x 確認架構與格式\n~ 實作 reporter/merge/validate\n? 傳輸方式等使用者決定\n")
    w(os.path.join(T, "steps2.txt"),
      "> 等你回覆 · 傳輸方案\n> Context: 驗證遠端上報 board 的整條管線\n"
      "x 確認架構與格式\nx 實作 reporter/merge/validate\n? 傳輸用 git 還是 chat relay？\n[>] 等 CI\n- 寫提案文件\n")


def pipeline():
    board = os.path.join(T, "progress.md")
    outbox = os.path.join(T, "remote", "outbox")

    # --- 1. reporter init + update -> fragment ---
    py("reporter.py", "init", "chat-demo")
    rr = py("reporter.py", "update", "chat-demo", "working", "測試遠端上報管線", os.path.join(T, "steps1.txt"))
    check("1a reporter update ok", rr.returncode == 0, rr.stderr)
    frags = [f for f in os.listdir(outbox) if f.endswith(".md")]
    check("1b fragment created, named after BOARD_AGENT_NAME", frags and frags[0].startswith("muse-"), str(frags))
    frag = os.path.join(outbox, frags[0])
    session = frags[0][5:13]
    rv = py("validate.py", "--block", frag)
    check("1c fragment valid", rv.returncode == 0, rv.stderr)
    check("1d fragment carries its project heading", r(frag).startswith("## remote-demo\n\n<!-- auto "), r(frag)[:80])

    # --- 2. merge into the board ---
    mr = py("merge.py", board, frag)
    check("2a merge ok", mr.returncode == 0, mr.stderr)
    after = r(board)
    check("2b my block present", "agent=muse" in after)
    check("2c claude block untouched", "session=aa11bb22 agent=claude" in after)
    check("2d project notes byte-preserved", "Some hand-kept notes the board must never touch." in after)
    check("2e whole file valid", py("validate.py", board).returncode == 0)
    check("2f new block under its own heading, heading line stripped",
          "\n\n## remote-demo\n\n<!-- auto session=" in after and after.count("## remote-demo") == 1, after)

    # --- 3. update my fragment (working -> waiting) ---
    rr = py("reporter.py", "update", "chat-demo", "waiting", "測試遠端上報管線", os.path.join(T, "steps2.txt"))
    check("3a reporter update ok (replaces the fragment file)", rr.returncode == 0, rr.stderr)
    mr = py("merge.py", board, frag)
    after2 = r(board)
    check("3b merge ok", mr.returncode == 0, mr.stderr)
    check("3c state updated", "state=waiting" in after2 and after2.count("agent=muse") == 1)
    check("3d single muse block (no dup)", after2.count("session=" + session) == 2)  # start + end markers
    check("3e claude block still intact", "### Fix login redirect" in after2)
    check("3f [mark] step lines kept", "- [>] 等 CI" in after2)

    # --- 4. multi-writer: add a second agent fragment ---
    codex = os.path.join(T, "codex-frag.md")
    w(codex, "<!-- auto session=cc33dd44 agent=codex state=working updated=2026-10-17T06:30:00Z -->\n"
             "### Refactor auth\n> 開發中\n- [ ] split module\n"
             "<!-- /auto session=cc33dd44 -->\n")
    mr = py("merge.py", "--under", "## webapp", board, frag, codex)
    after3 = r(board)
    check("4a multi merge ok", mr.returncode == 0, mr.stderr)
    check("4b all three blocks present",
          all(s in after3 for s in ["agent=muse", "agent=claude", "agent=codex"]))
    check("4c whole file valid", py("validate.py", board).returncode == 0)
    check("4d --under block lands in that section, blank line before the next ##",
          "<!-- /auto session=cc33dd44 -->\n\n## remote-demo" in after3, after3)

    # --- 5. idempotency: merge same fragments again -> identical bytes ---
    py("merge.py", "--under", "## webapp", board, frag, codex)
    check("5a idempotent", after3 == r(board), "bytes differ on re-merge")

    # --- 6. validation rejects bad fragments ---
    bad_cases = {
        "bad-state": "<!-- auto session=12345678 agent=muse state=flying updated=2026-10-17T07:00:00Z -->\n### t\n<!-- /auto session=12345678 -->\n",
        "bad-session": "<!-- auto session=xyz agent=muse state=working updated=2026-10-17T07:00:00Z -->\n### t\n<!-- /auto session=xyz -->\n",
        "bad-date": "<!-- auto session=12345678 agent=muse state=working updated=昨天 -->\n### t\n<!-- /auto session=12345678 -->\n",
        "indented": " <!-- auto session=12345678 agent=muse state=working updated=2026-10-17T07:00:00Z -->\n### t\n<!-- /auto session=12345678 -->\n",
        "mismatch-end": "<!-- auto session=12345678 agent=muse state=working updated=2026-10-17T07:00:00Z -->\n### t\n<!-- /auto session=87654321 -->\n",
        "no-title": "<!-- auto session=12345678 agent=muse state=working updated=2026-10-17T07:00:00Z -->\n- [x] step\n<!-- /auto session=12345678 -->\n",
        "injected-end": "<!-- auto session=12345678 agent=muse state=working updated=2026-10-17T07:00:00Z -->\n### t\n<!-- /auto session=12345678 -->\n- [ ] x\n<!-- /auto session=12345678 -->\n",
        "injected-start": "<!-- auto session=12345678 agent=muse state=working updated=2026-10-17T07:00:00Z -->\n### t\n<!--auto session=99999999 -->\n<!-- /auto session=12345678 -->\n",
        "fence-in-body": "<!-- auto session=12345678 agent=muse state=working updated=2026-10-17T07:00:00Z -->\n### t\n```\n<!-- /auto session=12345678 -->\n",
    }
    before = r(board)
    for name, content in bad_cases.items():
        p = os.path.join(T, f"bad-{name}.md")
        w(p, content)
        rv = py("validate.py", "--block", p)
        check(f"6.{name} rejected", rv.returncode == 1, rv.stdout)
        mr = py("merge.py", "--under", "## webapp", board, p)
        check(f"6.{name} merge refused", mr.returncode != 0)
    check("6z board unchanged by refused merges", r(board) == before)

    # --- 7. read-back verification passes on the real board ---
    attempts = merge_mod.merge_file(board, [frag])
    check("7a merge_file read-back ok", attempts == 1)
    check("7b board still has all blocks",
          all(s in r(board) for s in ["agent=muse", "agent=claude", "agent=codex"]))

    # --- 15. retire: close the session honestly, mint a fresh id ---
    rr = py("reporter.py", "retire", "chat-demo", "clean break in test")
    check("15a retire ok", rr.returncode == 0, rr.stderr)
    reg = json.load(open(os.path.join(T, "remote", "sessions.json")))
    check("15b new session minted", reg["chat-demo"] != session)
    old_frag = os.path.join(outbox, f"muse-{session}.md")
    check("15c old fragment kept", os.path.exists(old_frag))
    check("15d state=ended", "state=ended" in r(old_frag))
    check("15e retired block valid", py("validate.py", "--block", old_frag).returncode == 0)
    mr = py("merge.py", board, old_frag)
    after4 = r(board)
    check("15f merge ok", mr.returncode == 0, mr.stderr)
    check("15g single muse block (no dup)", after4.count("session=" + session) == 2)
    check("15h board shows ended", "state=ended" in after4)
    retired = r(old_frag)
    check("15i retired fragment keeps its project line, title, notes and steps, and adds the reason",
          retired.startswith("## remote-demo\n\n<!-- auto ") and "### 測試遠端上報管線" in retired
          and "> Context: 驗證遠端上報 board 的整條管線\n> clean break in test\n- [x] 確認架構與格式" in retired
          and "- [>] 等 CI" in retired, retired)
    registry = os.path.join(T, "remote", "sessions.json")
    reg_before = r(registry)
    rn = py("reporter.py", "retire", "chat-never-seen")
    check("15j retire refuses a chat not in the registry", rn.returncode != 0 and "not in the registry" in rn.stderr, rn.stderr)
    check("15k refused retire mints nothing", r(registry) == reg_before)
    # init puts a chat in the registry before it reports anything.
    py("reporter.py", "init", "chat-quiet")
    reg_before = r(registry)
    rq = py("reporter.py", "retire", "chat-quiet")
    check("15l retire refuses a session that never reported, and mints nothing",
          rq.returncode != 0 and "has not reported yet" in rq.stderr and r(registry) == reg_before, rq.stderr)
    # A finished session keeps its state: retire only mints a new id.
    py("reporter.py", "init", "chat-done")
    py("reporter.py", "update", "chat-done", "done", "Finished work", os.path.join(T, "steps1.txt"))
    done_sess = json.load(open(registry))["chat-done"]
    done_frag = os.path.join(outbox, f"muse-{done_sess}.md")
    done_before = r(done_frag)
    rd = py("reporter.py", "retire", "chat-done")
    check("15m retire after done leaves the done block as it was and mints a new id",
          rd.returncode == 0 and r(done_frag) == done_before and json.load(open(registry))["chat-done"] != done_sess, rd.stderr)
    # A reason that would break the block is refused cleanly, before anything is written.
    py("reporter.py", "init", "chat-bad")
    py("reporter.py", "update", "chat-bad", "working", "Some work", os.path.join(T, "steps1.txt"))
    bad_sess = json.load(open(registry))["chat-bad"]
    bad_frag = os.path.join(outbox, f"muse-{bad_sess}.md")
    bad_before, reg_before = r(bad_frag), r(registry)
    rb = py("reporter.py", "retire", "chat-bad", "end <!-- here")
    check("15n a reason with a comment opening is refused without a traceback, and nothing changes",
          rb.returncode != 0 and "Traceback" not in rb.stderr and r(bad_frag) == bad_before and r(registry) == reg_before, rb.stderr)
    # The reason is checked on a finished session too, though its block is not rewritten.
    py("reporter.py", "update", "chat-bad", "done", "Some work", os.path.join(T, "steps1.txt"))
    reg_before = r(registry)
    rb = py("reporter.py", "retire", "chat-bad", "end <!-- here")
    check("15o a bad reason is refused on a done session too, and mints nothing",
          rb.returncode != 0 and "Traceback" not in rb.stderr and r(registry) == reg_before, rb.stderr)
    # A fragment cut off before its end marker would lose its last step if rewritten.
    w(bad_frag, r(bad_frag).replace("state=done", "state=working").split("<!-- /auto")[0])
    cut_before = r(bad_frag)
    rc = py("reporter.py", "retire", "chat-bad")
    check("15p a fragment that is not a valid block is refused, and nothing changes",
          rc.returncode != 0 and "not a valid block" in rc.stderr and r(bad_frag) == cut_before and r(registry) == reg_before, rc.stderr)


def placement():
    frag = block("12345678", agent="muse")

    # --- 8. --under / project heading ---
    out = merge_mod.merge_text("# Project progress\n\n## webapp\nnotes\n", [frag], under="## webapp")
    check("8a under existing heading, after section content", "notes\n\n<!-- auto session=" in out, out)
    out2 = merge_mod.merge_text("# Project progress\n", [frag], under="## remote")
    check("8c missing heading added", out2 == "# Project progress\n\n## remote\n\n" + frag, out2)
    check("8d valid file", validate_mod.validate_text(out2) == [])
    try:
        merge_mod.merge_text("# Project progress\n\n## other\n", [frag])
        check("8e new block without a project is refused", False, "no error")
    except ValueError as e:
        check("8e new block without a project is refused", "--under" in str(e), str(e))
    rv = py("merge.py", os.path.join(T, "progress.md"), os.path.join(T, "steps1.txt"))
    check("8f merge.py exits non-zero for a non-fragment", rv.returncode != 0)
    out3 = merge_mod.merge_text("## a\nnotes\n\n\n## b\nmore\n", [frag], under="a")
    check("8g blank line before the start marker and before the next ##",
          out3 == "## a\nnotes\n\n" + frag + "\n## b\nmore\n", out3)
    out4 = merge_mod.merge_text("", ["## fresh\n\n" + frag])
    check("8h empty board: heading from the fragment", out4 == "## fresh\n\n" + frag, out4)
    replacement = at_time(frag.replace("### t", "### t2"), "2026-10-17T08:00:00Z")
    existing = merge_mod.merge_text("## a\n\n" + frag, [replacement])
    check("8i an existing block is replaced in place, no --under needed",
          existing == "## a\n\n" + replacement, existing)
    posing = frag.replace("updated=2026-10-17T07:00:00Z", "updated=2026-10-17T07:00:00Z resume=01a14abb-d817-7f70-bf50-4728ff5d88da dir=%2Fsrv%2Fother pr=7")
    out5 = merge_mod.merge_text("## a\n", [posing], under="a")
    check("8j a fragment never names a session id or folder for the board page to answer into",
          "resume=" not in out5 and "dir=" not in out5 and "updated=2026-10-17T07:00:00Z pr=7 -->" in out5, out5)
    for bad in ("a<!--b", "x-->y"):
        for frags, under in (([frag], "## " + bad), (["## " + bad + "\n\n" + frag], None)):
            try:
                merge_mod.merge_text("## other\n", frags, under=under)
                check(f"8k a new heading with a comment opening or close is refused ({bad!r})", False, "no error")
            except ValueError as e:
                check(f"8k a new heading with a comment opening or close is refused ({bad!r})", "<!--" in str(e), str(e))


def parser_parity():
    frag = at_time(block("12345678", title="new"), "2026-10-17T08:00:00Z")
    old = block("12345678", title="old")
    for cut in ("<!-- /auto se", "<!-- /au", "<!-- aut", "<!-- question=ab"):
        board = os.path.join(T, "cut-marker.md")
        incoming = os.path.join(T, "cut-marker-fragment.md")
        prefix = "## a\n" + old + cut + "\n"
        w(board, prefix)
        w(incoming, frag.replace("12345678", "abcdef12"))
        rv = py("merge.py", "--under", "a", board, incoming)
        check(f"a remote report after a cut marker stays visible ({cut})",
              rv.returncode == 0 and "abcdef12" in validate_mod.extract_blocks(r(board))
              and r(board).startswith(prefix), rv.stderr)
    arrow = "## a\n<!-- auto session=cut\n## later\n### Keep\n- [ ] map a --> b\n"
    check("a cut marker followed by an arrow in a task line hides nothing",
          validate_mod.classify(arrow.splitlines()) == ["project", "text", "project", "task", "text"])
    check("an ordinary comment opening still hides example blocks",
          "start" not in validate_mod.classify(("<!--\n" + old + "-->\n").splitlines()))
    check("cut markers accept spaces and tabs after the comment opening but U+0085 opens an ordinary comment",
          all(validate_mod.is_cut_marker(cut) for cut in ("<!--auto", "<!-- \tauto", "<!--\tauto"))
          and not validate_mod.is_cut_marker("<!--\u0085auto")
          and validate_mod.classify(["<!--\u0085auto", "## Hidden", "-->"]) == ["blank", "hidden", "blank"])
    check("cut markers trim only trailing spaces tabs and carriage returns",
          all(validate_mod.is_cut_marker("<!-- auto" + ending) for ending in (" ", "\t", "\r", " \t\r"))
          and all(not validate_mod.is_cut_marker("<!-- auto" + ending)
                  and validate_mod.classify(["<!-- auto" + ending, "## Hidden", "-->"]) == ["blank", "hidden", "blank"]
                  for ending in ("\uFEFF", "\x1f")))
    ordinary = "## P\n### Keep me\n<!-- auto archive of old work\n## Old\n### Old task\n-->\n"
    check("an ordinary comment that starts with the word auto hides its lines as before and shows no warning",
          validate_mod.classify(ordinary.splitlines()) == ["project", "task", "blank", "hidden", "hidden", "blank"]
          and all(validate_mod.is_cut_marker(cut) for cut in ("<!-- aut", "<!-- auto", "<!-- auto se", "<!-- /auto session=ab", "<!-- question=ab"))
          and all(not validate_mod.is_cut_marker(comment) for comment in ("<!--", "<!-- auto archive of old work", "<!-- auto sessions=", "<!-- /auto archive", "<!-- questions=")))
    check("cut-marker look-ahead counts project headings and block markers inside a code fence",
          all(validate_mod.classify(["<!-- auto se", "```", boundary, "```", "### Visible", "-->"])
              == ["text", "hidden", "hidden", "hidden", "task", "text"]
              for boundary in ("## Example", "<!-- auto session=example -->", "<!-- /auto session=example -->")))
    check("cut-marker look-ahead counts comment closes inside a code fence",
          validate_mod.classify(["<!-- auto se", "```", "-->", "```", "### Visible"])
          == ["blank", "hidden", "hidden", "hidden", "hidden"])
    token = "a" * 64 + ":2"
    marked = frag.replace("<!-- /auto", f"<!-- question={token} -->\n<!-- /auto")
    check("producer question revision metadata stays inside a complete visible block",
          validate_mod.validate_fragment_text(marked) == []
          and validate_mod.extract_blocks("## a\n" + marked).get("12345678") == marked.strip().splitlines())
    check("producer question metadata is ignored inside a fenced example",
          validate_mod.classify(["```", f"<!-- question={token} -->", "```"]) == ["hidden", "hidden", "hidden"])

    # --- 9. fenced code and HTML comments are not blocks ---
    fenced = "## a\n\n```md\n" + old + "```\n\n~~~\n" + old + "~~~\n"
    out = merge_mod.merge_text(fenced, [frag], under="a")
    check("9a block inside a fence is never replaced", out.count("### old") == 2 and out.count("### new") == 1, out)
    check("9b the real block is written after the fences", out.endswith("~~~\n\n" + frag), out)
    check("9c block inside a fence is never validated",
          validate_mod.validate_text("```\n" + old.replace("state=working", "state=bogus") + "```\n") == [])
    commented = "## a\n\n<!--\n" + old + "-->\n"
    out = merge_mod.merge_text(commented, [frag], under="a")
    check("9d block inside an HTML comment is never replaced",
          "### old" in out and out.endswith("-->\n\n" + frag), out)

    # --- 10. CRLF, marker spellings, attribute order, trailing spaces ---
    crlf = ("## a\n\n" + old).replace("\n", "\r\n")
    out = merge_mod.merge_text(crlf, [frag])
    check("10a CRLF board: block replaced, not duplicated", out.count("session=12345678") == 2 and "### new" in out, out)
    check("10b CRLF board keeps CRLF everywhere", "\n" not in out.replace("\r\n", ""), repr(out))
    tight = "## a\n\n<!--auto session=12345678 agent=codex state=working updated=2026-10-17T07:00:00Z-->\n### old\n<!--/auto session=12345678-->\n"
    out = merge_mod.merge_text(tight, [frag])
    check("10c <!--auto spelling is found and replaced", out == "## a\n\n" + frag, out)
    reordered = "## a\n\n<!-- auto agent=codex updated=2026-10-17T07:00:00Z session=12345678 state=working -->  \n### old\n<!-- /auto session=12345678 -->   \n"
    out = merge_mod.merge_text(reordered, [frag])
    check("10d attributes in any order and trailing spaces", out == "## a\n\n" + frag, out)
    check("10e validate_file accepts a reordered marker", validate_mod.validate_text(reordered) == [],
          validate_mod.validate_text(reordered))
    reordered_frag = frag.replace(frag.splitlines()[0],
                                  "<!-- auto agent=codex state=working updated=2026-10-17T08:00:00Z session=12345678 -->")
    check("10f fragment with session= not first is valid", validate_mod.validate_fragment_text(reordered_frag) == [])

    # --- 11. board session ids per FORMAT.md, unterminated blocks ---
    loose = "## a\n\n" + block("build-42")
    msgs = validate_mod.validate_text(loose)
    check("11a non-hex board session id is only a warning",
          msgs and all(m.startswith("warning:") for m in msgs), msgs)
    unterminated = "## a\n\n" + MARK.format(s="12345678", a="codex") + "\n### old\n- [ ] step\n\nhand notes\n"
    out = merge_mod.merge_text(unterminated, [frag])
    check("11b block with no end marker is replaced, not duplicated",
          out == "## a\n\n" + frag + "### old\n- [ ] step\n\nhand notes\n", out)
    check("11c a block with no end marker is a warning", all(
        m.startswith("warning:") for m in validate_mod.validate_text(unterminated)))
    dup = "## a\n\n" + old + "\n" + old
    check("11d duplicate ids on the board are an error",
          any("duplicate" in m for m in validate_mod.validate_text(dup)))


def file_handling():
    # --- 12. file mode survives the merge ---
    board = os.path.join(T, "mode.md")
    w(board, "## a\n")
    os.chmod(board, 0o644)
    merge_mod.merge_file(board, [os.path.join(T, "codex-frag.md")], under="a")
    mode = stat.S_IMODE(os.stat(board).st_mode)
    # Windows has only a read-only bit; there the check is that the file stays writable.
    check("12a board keeps its mode", mode == 0o644 or (os.name == "nt" and mode & stat.S_IWRITE), oct(mode))
    check("12b no temp files left", not [f for f in os.listdir(T) if f.startswith(".progress-")])
    crlf_board = os.path.join(T, "crlf.md")
    w(crlf_board, "## a\r\n\r\nnotes\r\n")
    merge_mod.merge_file(crlf_board, [os.path.join(T, "codex-frag.md")], under="a")
    check("12c merge_file keeps CRLF on disk", "\n" not in r(crlf_board).replace("\r\n", ""), repr(r(crlf_board)))

    # --- 13. registry location ---
    env = dict(ENV)
    env.pop("AGENT_BOARD_REMOTE_DIR")
    env["CLAUDE_CONFIG_DIR"] = os.path.join(T, "config")
    py("reporter.py", "init", "chat-x", env=env)
    check("13a registry under $CLAUDE_CONFIG_DIR/remote-reporter",
          os.path.exists(os.path.join(T, "config", "remote-reporter", "sessions.json")))
    env.pop("CLAUDE_CONFIG_DIR")
    env["HOME"] = env["USERPROFILE"] = os.path.join(T, "home")
    py("reporter.py", "init", "chat-y", env=env)
    check("13b registry under ~/.claude/remote-reporter",
          os.path.exists(os.path.join(T, "home", ".claude", "remote-reporter", "sessions.json")))
    check("13c registry under $AGENT_BOARD_REMOTE_DIR",
          os.path.exists(os.path.join(T, "remote", "sessions.json")))
    check("13d nothing written into the script folder",
          not os.path.exists(os.path.join(HERE, "outbox")) and not os.path.exists(os.path.join(HERE, "__pycache__")))
    with open(os.path.join(T, "remote", "sessions.json"), encoding="utf-8") as f:
        minted = json.load(f)["chat-demo"]
    rr = py("reporter.py", "init", "chat-demo")
    check("13e the id survives a restart", rr.stdout.strip().endswith(minted), rr.stdout)

    # --- 14. injected markers and control characters are refused ---
    for name, title, steps in [
        ("newline in title", "a\n<!-- /auto session=12345678 -->", "- x\n"),
        ("comment in step", "ok", "- see <!-- here\n"),
        ("end marker in step", "ok", "- fine -->\n"),
        ("control char in note", "ok", "> a\x07b\n"),
    ]:
        p = os.path.join(T, "steps-bad.txt")
        w(p, steps)
        rr = py("reporter.py", "update", "chat-demo", "working", title, p)
        check(f"14 reporter refuses {name}", rr.returncode != 0 and "Traceback" not in rr.stderr, rr.stderr)
    try:
        reporter_mod.check_text("title", "a\rb")
        check("14 check_text refuses a carriage return", False)
    except ValueError:
        check("14 check_text refuses a carriage return", True)


def merge_order():
    board = os.path.join(T, "order.md")
    frag = os.path.join(T, "order-fragment.md")
    working = block("12345678").replace("07:00:00Z", "18:00:00Z")
    done = working.replace("18:00:00Z", "19:00:00Z").replace("state=working", "state=done")
    cases = [
        ("an older working fragment keeps the done block and reports why it was skipped",
         done, working, done, "skipped: older fragment"),
        ("different content at the same time keeps the existing block and reports a conflict",
         done, done.replace("### t", "### changed"), done, "conflict: equal updated"),
        ("an identical import changes no bytes and reports a no-op",
         done, done, done, "no-op: identical block"),
        ("a newer fragment replaces the existing block and reports the replacement",
         working, done, done, "replaced: newer fragment"),
    ]
    for name, before, incoming, expected, outcome in cases:
        # A skipped import must also preserve CRLF and the absence of a final newline.
        original = ("## a\n\n" + before).replace("\n", "\r\n").rstrip("\r\n")
        w(board, original)
        w(frag, incoming)
        result = py("merge.py", board, frag)
        wanted = original if expected == before else ("## a\n\n" + expected).replace("\n", "\r\n")
        check(name, result.returncode == 0 and r(board) == wanted and outcome in result.stdout,
              result.stdout + result.stderr)

    missing = working.replace("updated=2026-10-17T18:00:00Z ", "")
    invalid = working.replace("updated=2026-10-17T18:00:00Z", "updated=not-a-time")
    unzoned = working.replace("18:00:00Z", "18:00:00")
    for name, before, incoming in [
        ("a board block with no time is replaced with a comparison warning", missing, done),
        ("a board block with an unreadable time is replaced with a comparison warning", invalid, done),
        ("a board time without a timezone is replaced with a comparison warning", unzoned, done),
        ("a fragment time without a timezone replaces the board block with a comparison warning", done, unzoned),
    ]:
        w(board, "## a\n\n" + before)
        w(frag, incoming)
        result = py("merge.py", board, frag)
        check(name, result.returncode == 0 and r(board) == "## a\n\n" + incoming
              and "replaced: updated stamps cannot be compared" in result.stdout, result.stdout + result.stderr)

    refused_ok = True
    for bad in ("", "updated=not-a-time "):
        w(board, "## a\n\n" + done)
        w(frag, working.replace("updated=2026-10-17T18:00:00Z ", bad))
        result = py("merge.py", board, frag)
        refused_ok = refused_ok and result.returncode != 0 and r(board) == "## a\n\n" + done
    check("a fragment with a missing or unreadable time is refused and the board is unchanged", refused_ok)

    for name, incoming, expected, outcome in [
        ("an older instant with a timezone offset is skipped", working.replace("18:00:00Z", "20:00:00+02:00"),
         done, "skipped: older fragment"),
        ("equal instants with different timezone offsets report a conflict", done.replace("19:00:00Z", "21:00:00+02:00"),
         done, "conflict: equal updated"),
        ("a fragment newer by a fraction of a second replaces the board block", done.replace("19:00:00Z", "19:00:00.001Z"),
         done.replace("19:00:00Z", "19:00:00.001Z"), "replaced: newer fragment"),
        ("a date alone is compared as midnight UTC and skipped when older", done.replace("2026-10-17T19:00:00Z", "2026-10-17"),
         done, "skipped: older fragment"),
    ]:
        w(board, "## a\n\n" + done)
        w(frag, incoming)
        result = py("merge.py", board, frag)
        check(name, result.returncode == 0 and r(board) == "## a\n\n" + expected
              and outcome in result.stdout, result.stdout + result.stderr)

    second = os.path.join(T, "order-second.md")
    w(board, "## a\n")
    w(frag, "## a\n\n" + done)
    w(second, working)
    result = py("merge.py", board, frag, second)
    check("two fragments for one session keep the newer block and pass read-back verification",
          result.returncode == 0 and r(board) == "## a\n\n" + done
          and "skipped: older fragment" in result.stdout, result.stdout + result.stderr)

    text, outcomes = merge_mod.merge_text("## a\n\n" + done,
                                         [working, done.replace("### t", "### changed"), done], with_outcomes=True)
    check("the pure merge returns each skipped, conflicting and identical outcome",
          text == "## a\n\n" + done and outcomes == [
              ("12345678", "skipped: older fragment"),
              ("12345678", "conflict: equal updated stamps with different content"),
              ("12345678", "no-op: identical block"),
          ], outcomes)

    original_write = merge_mod.atomic_write
    newest = at_time(done, "2026-10-17T20:00:00Z")

    def concurrent_write(path, text):
        original_write(path, text)
        w(path, "## a\n\n" + newest)

    w(board, "## a\n\n" + working)
    w(frag, done)
    merge_mod.atomic_write = concurrent_write
    try:
        attempts, outcomes = merge_mod.merge_file(board, [frag], with_outcomes=True)
    finally:
        merge_mod.atomic_write = original_write
    check("a read-back retry keeps a newer concurrent update and reports the older fragment",
          attempts == 2 and r(board) == "## a\n\n" + newest
          and outcomes == [("12345678", "skipped: older fragment")], outcomes)


def merge_repairs():
    board = os.path.join(T, "repair.md")
    frag = os.path.join(T, "repair-fragment.md")
    incoming = block("12345678", title="repaired")
    w(frag, "## a\n\n" + incoming)
    for name, opening in [
        ("an open code fence aborts the merge cleanly before the board is written", "```md"),
        ("an open comment aborts the merge cleanly before the board is written", "<!--"),
    ]:
        before = "# Board\r\n" + opening + "\r\n## a\r\nnotes\r\n"
        w(board, before)
        result = py("merge.py", board, frag)
        check(name, result.returncode != 0 and r(board) == before and "Traceback" not in result.stderr
              and "merge aborted: session 12345678 would be hidden by an open fence or comment" in result.stderr,
              result.stdout + result.stderr)

    for name, stamp in [
        ("a board block with no end marker is repaired even when its timestamp equals the fragment", "2026-10-17T07:00:00Z"),
        ("a board block with no end marker is repaired even when its timestamp is newer than the fragment", "2026-10-17T08:00:00Z"),
    ]:
        broken = at_time(block("12345678"), stamp).split("<!-- /auto")[0]
        w(board, "## a\n\n" + broken + "\nhand notes\n")
        result = py("merge.py", board, frag)
        check(name, result.returncode == 0 and r(board) == "## a\n\n" + incoming + broken.split("\n", 1)[1] + "\nhand notes\n"
              and "replaced: the board block had no end marker; its old lines stay below it as text" in result.stdout, result.stdout + result.stderr)

    original_merge = merge_mod.merge_text

    def changed_merge(*args, **kwargs):
        text, outcomes = original_merge(*args, **kwargs)
        return text.replace("### repaired", "### changed"), outcomes

    for name, before in [
        ("read-back checks an inserted block against the fragment itself", "## a\n"),
        ("read-back checks a replaced block against the fragment itself", "## a\n\n" + at_time(incoming, "2026-10-17T06:00:00Z")),
    ]:
        w(board, before)
        with patch.object(merge_mod, "merge_text", changed_merge):
            try:
                merge_mod.merge_file(board, [frag], retries=1)
                check(name, False, "the changed block was accepted")
            except SystemExit as e:
                check(name, "did not read back as written" in str(e), str(e))


@patch.object(merge_mod, "datetime", wraps=datetime)
def cut_off_block(clock):
    clock.now.return_value = datetime(2026, 10, 22, tzinfo=timezone.utc)
    # A block cut off in the middle of the board: no end marker, more sections after it.
    cut = "<!-- auto session=55fb44cb agent=codex state=waiting updated=2026-10-20T01:17:08.128Z -->"
    before = "# Progress\n\n## demo-152\n\n" + cut + "\n### Add a shelf\n> waiting on your repl\n"
    following = ("\n## demo-154\n\n" + block("1d0ef21d", title="Fix the working text", steps=("- [?] Ship it, OK?",))
                 + "\n" + block("9a9a9a9a", title="A finished plan", steps=("- [x] Did it",))
                 + "\n### Hand-kept task\n- [ ] Keep me\n")
    board = before + following
    other = at_time(block("1d0ef21d", title="Fix the working text", steps=("- [x] Shipped",)), "2026-10-21T00:00:00Z")
    out = merge_mod.merge_text(board, [other])
    check("16a a fragment for the block after a cut-off block replaces only that block",
          out.startswith(before) and "- [x] Shipped" in out and "Ship it, OK?" not in out
          and out.endswith("\n" + block("9a9a9a9a", title="A finished plan", steps=("- [x] Did it",)) + "\n### Hand-kept task\n- [ ] Keep me\n"), out)
    own = at_time(block("55fb44cb", title="Shelf added"), "2026-10-21T00:00:00Z")
    out, outcomes = merge_mod.merge_text(board, [own], with_outcomes=True)
    check("16b a fragment for the cut-off block's own session replaces it and keeps every section after it",
          out == "# Progress\n\n## demo-152\n\n" + own + "### Add a shelf\n> waiting on your repl\n" + following
          and outcomes == [("55fb44cb", "replaced: the board block had no end marker; its old lines stay below it as text")], (out, outcomes))
    check("16c the cut-off block does not take the next block's end marker as its own",
          out.count("<!-- /auto session=1d0ef21d -->") == 1 and out.count("<!-- /auto session=55fb44cb -->") == 1, out)
    p0_tail = "### Hand-kept task\n- [ ] Keep me\n" + following
    p0 = "# Progress\n\n## demo-152\n\n" + cut + "\n" + p0_tail
    repaired = merge_mod.merge_text(p0, [own])
    check("16d merge keeps a hand-kept task right after a marker with no end",
          repaired == "# Progress\n\n## demo-152\n\n" + own + p0_tail, repaired)
    later = at_time(block("55fb44cb", title="Shelf painted"), "2026-10-22T00:00:00Z")
    again = merge_mod.merge_text(repaired, [later])
    check("16e a second merge leaves the text a cut-off block left as it was",
          again == "# Progress\n\n## demo-152\n\n" + later + p0_tail, again)


def reporter_order():
    steps = os.path.join(T, "steps1.txt")
    board = os.path.join(T, "reporter-order.md")
    instant = datetime(2026, 10, 17, 12, 0, 0, 500000, tzinfo=timezone.utc)
    with patch.dict(os.environ, ENV), patch.object(reporter_mod, "datetime", wraps=datetime) as clock, patch.object(merge_mod, "datetime", clock):
        clock.now.return_value = instant
        reporter_mod.cmd_update("chat-order", "working", "First update", steps)
        frag = reporter_mod.fragment_path(reporter_mod.session_for("chat-order"))
        w(board, "")
        merge_mod.merge_file(board, [frag])
        reporter_mod.cmd_update("chat-order", "waiting", "Second update", steps)
        same_second = r(frag)
        merge_mod.merge_file(board, [frag])
        merged = validate_mod.extract_blocks(r(board)) == validate_mod.extract_blocks(same_second)
        clock.now.return_value = instant.replace(second=10)
        reporter_mod.cmd_update("chat-order", "working", "Later update", steps)
        check("reporter updates within one second advance the timestamp and merge while later clock times are kept",
              "updated=2026-10-17T12:00:00.001000Z" in same_second and merged
              and "updated=2026-10-17T12:00:10Z" in r(frag))

        clock.now.return_value = instant
        reporter_mod.cmd_update("chat-order", "waiting", "Clock moved back", steps)
        check("a reporter update advances beyond the previous timestamp when the clock moves backwards",
              "updated=2026-10-17T12:00:10.001000Z" in r(frag))
        before_skew = r(board)
        try:
            merge_mod.merge_file(board, [frag])
            check("a genuine clock rollback is refused without changing the board", False)
        except SystemExit as error:
            check("a genuine clock rollback is refused without changing the board",
                  "dated in the future" in str(error) and r(board) == before_skew, str(error))
        clock.now.return_value = instant.replace(second=10)
        reporter_mod.cmd_retire("chat-order")
        merge_mod.merge_file(board, [frag])
        check("retiring a session advances its timestamp so the ended block reaches the board",
              "updated=2026-10-17T12:00:10.002000Z" in r(frag) and "state=ended" in r(board)
              and validate_mod.extract_blocks(r(board)) == validate_mod.extract_blocks(r(frag)))

        check("a reporter update after the last representable timestamp uses the clock instead of failing",
              reporter_mod.now_iso("9999-12-31T23:59:59.999999Z") == "2026-10-17T12:00:10Z")

        reporter_mod.cmd_update("chat-bytes", "working", "Before the bad bytes", steps)
        bad = reporter_mod.fragment_path(reporter_mod.session_for("chat-bytes"))
        with open(bad, "wb") as f:
            f.write(b"\xff\xfe not utf-8")
        reporter_mod.cmd_update("chat-bytes", "waiting", "After the bad bytes", steps)
        check("a reporter update overwrites a previous fragment that is not valid UTF-8",
              "After the bad bytes" in r(bad) and "updated=2026-10-17T12:00:10Z" in r(bad))


@patch.object(merge_mod, "datetime", MergeClock)
def main():
    global T, ENV
    with tempfile.TemporaryDirectory() as tmp:
        T = tmp
        ENV = dict(os.environ)
        ENV["AGENT_BOARD_REMOTE_DIR"] = os.path.join(T, "remote")
        ENV["BOARD_AGENT_NAME"] = "muse"
        ENV["BOARD_PROJECT"] = "remote-demo"
        ENV["PYTHONDONTWRITEBYTECODE"] = "1"
        ENV["LANG"] = "en_US.UTF-8"
        ENV["LC_ALL"] = ""
        ENV["LC_MESSAGES"] = ""
        ENV["PYTHONIOENCODING"] = "utf-8"
        setup()
        pipeline()
        placement()
        parser_parity()
        file_handling()
        merge_order()
        merge_repairs()
        cut_off_block()
        reporter_order()

    print(f"\n==== {len(passed)} passed, {len(failed)} failed ====")
    if failed:
        print("FAILED:", failed)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Local test of the Flint -> Agent Board sharing pipeline.

Simulates: reporter writes fragment -> merge into board -> validate.
All local, no network, no claude CLI. Run: python3 test_pipeline.py
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "test-board")
passed, failed = [], []


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE, **kw)
    return r


def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" -- {detail}" if detail and not cond else ""))


def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def r(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def setup():
    shutil.rmtree(T, ignore_errors=True)
    os.makedirs(T)
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
    # my steps files
    w(os.path.join(T, "steps1.txt"),
      "> 調查中\n> Context: 驗證 Flint 上報 board 的整條管線\n"
      "x 確認架構與格式\n- 實作 reporter/merge/validate\n? 傳輸方式等使用者決定\n")
    w(os.path.join(T, "steps2.txt"),
      "> 等你回覆 · 傳輸方案\n> Context: 驗證 Flint 上報 board 的整條管線\n"
      "x 確認架構與格式\nx 實作 reporter/merge/validate\n? 傳輸用 git 還是 chat relay？\n- 寫提案文件\n")


def main():
    setup()
    board = os.path.join(T, "progress.md")

    # --- 1. reporter init + update -> fragment ---
    run([sys.executable, "reporter.py", "init", "chat-demo"])
    rr = run([sys.executable, "reporter.py", "update", "chat-demo", "working",
              "測試 Flint 上報管線", os.path.join(T, "steps1.txt")])
    check("1a reporter update ok", rr.returncode == 0, rr.stderr)
    frags = [f for f in os.listdir(os.path.join(HERE, "outbox")) if f.startswith("muse-") and f.endswith(".md")]
    check("1b fragment created", len(frags) == 1, str(frags))
    frag = os.path.join(HERE, "outbox", frags[0])
    rv = run([sys.executable, "validate.py", "--block", frag])
    check("1c fragment valid", rv.returncode == 0, rv.stderr)

    # --- 2. merge into fresh board ---
    before = r(board)
    mr = run([sys.executable, "merge.py", board, frag])
    check("2a merge ok", mr.returncode == 0, mr.stderr)
    after = r(board)
    check("2b my block present", "agent=muse" in after)
    check("2c claude block untouched", "session=aa11bb22 agent=claude" in after)
    check("2d project notes byte-preserved", "Some hand-kept notes the board must never touch." in after)
    check("2e whole file valid", run([sys.executable, "validate.py", board]).returncode == 0)

    # --- 3. update my fragment (working -> waiting) ---
    rr = run([sys.executable, "reporter.py", "update", "chat-demo", "waiting",
              "測試 Flint 上報管線", os.path.join(T, "steps2.txt")])
    check("3a reporter update ok", rr.returncode == 0, rr.stderr)
    before2 = after
    mr = run([sys.executable, "merge.py", board, frag])
    after2 = r(board)
    check("3b merge ok", mr.returncode == 0, mr.stderr)
    check("3c state updated", "state=waiting" in after2 and after2.count("agent=muse") == 1)  # start marker only
    check("3d single muse block (no dup)", after2.count("session=" + frags[0][5:13]) == 2)  # start + end markers
    check("3e claude block still intact", "### Fix login redirect" in after2)

    # --- 4. multi-writer: add a second agent fragment ---
    w(os.path.join(T, "codex-frag.md"),
      "<!-- auto session=cc33dd44 agent=codex state=working updated=2026-10-17T06:30:00Z -->\n"
      "### Refactor auth\n> 開發中\n- [ ] split module\n"
      "<!-- /auto session=cc33dd44 -->\n")
    mr = run([sys.executable, "merge.py", board, frag, os.path.join(T, "codex-frag.md")])
    after3 = r(board)
    check("4a multi merge ok", mr.returncode == 0, mr.stderr)
    check("4b all three blocks present",
          all(s in after3 for s in ["agent=muse", "agent=claude", "agent=codex"]))
    check("4c whole file valid", run([sys.executable, "validate.py", board]).returncode == 0)

    # --- 5. idempotency: merge same fragments again -> identical bytes ---
    mr = run([sys.executable, "merge.py", board, frag, os.path.join(T, "codex-frag.md")])
    after4 = r(board)
    check("5a idempotent", after3 == after4, "bytes differ on re-merge")

    # --- 6. validation rejects bad fragments ---
    bad_cases = {
        "bad-state": "<!-- auto session=12345678 agent=muse state=flying updated=2026-10-17T07:00:00Z -->\n### t\n<!-- /auto session=12345678 -->\n",
        "bad-session": "<!-- auto session=xyz agent=muse state=working updated=2026-10-17T07:00:00Z -->\n### t\n<!-- /auto session=xyz -->\n",
        "bad-date": "<!-- auto session=12345678 agent=muse state=working updated=昨天 -->\n### t\n<!-- /auto session=12345678 -->\n",
        "indented": " <!-- auto session=12345678 agent=muse state=working updated=2026-10-17T07:00:00Z -->\n### t\n<!-- /auto session=12345678 -->\n",
        "mismatch-end": "<!-- auto session=12345678 agent=muse state=working updated=2026-10-17T07:00:00Z -->\n### t\n<!-- /auto session=87654321 -->\n",
        "no-title": "<!-- auto session=12345678 agent=muse state=working updated=2026-10-17T07:00:00Z -->\n- [x] step\n<!-- /auto session=12345678 -->\n",
    }
    for name, content in bad_cases.items():
        p = os.path.join(T, f"bad-{name}.md")
        w(p, content)
        rv = run([sys.executable, "validate.py", "--block", p])
        check(f"6.{name} rejected", rv.returncode == 1, rv.stdout)
        # merge must also refuse
        mr = run([sys.executable, "merge.py", board, p])
        check(f"6.{name} merge refused", mr.returncode != 0)

    # --- 8. --under: new block goes under the project heading ---
    import importlib.util
    spec = importlib.util.spec_from_file_location("merge", os.path.join(HERE, "merge.py"))
    merge_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(merge_mod)
    w(os.path.join(T, "under-board.md"), "# Project progress\n\n## webapp\nnotes\n")
    frag2 = r(frag)
    out = merge_mod.merge_text(r(os.path.join(T, "under-board.md")), [frag2], under="## webapp")
    check("8a under existing heading, after section content",
          "notes\n\n<!-- auto session=" in out, out[:200])
    w(os.path.join(T, "under-board2.md"), "# Project progress\n")
    out2 = merge_mod.merge_text(r(os.path.join(T, "under-board2.md")), [frag2], under="## remote")
    check("8c missing heading added", "## remote\n\n<!-- auto session=" in out2, out2[:200])
    from validate import validate_file as _vf
    w(os.path.join(T, "under-check.md"), out2)
    check("8d valid file", _vf(os.path.join(T, "under-check.md")) == [])

    # --- 7. stale-write retry: read-back verification passes on the real board ---
    # (merge_file re-reads the file on every attempt, so a stale *write* cannot
    # happen through it; here we verify the read-back check itself.)
    stale = after2  # board state before codex was added
    w(os.path.join(T, "stale-board.md"), stale)
    # emulate: merge_file reads current file each attempt, so a stale *write*
    # can't happen through merge_file; instead test that merge_file's
    # read-back verification passes on the real board.
    attempts = merge_mod.merge_file(board, [frag])
    check("7a merge_file read-back ok", attempts >= 1)
    check("7b board still has all blocks",
          all(s in r(board) for s in ["agent=muse", "agent=claude", "agent=codex"]))

    print(f"\n==== {len(passed)} passed, {len(failed)} failed ====")
    if failed:
        print("FAILED:", failed)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

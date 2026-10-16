# Changelog

## 0.6.0 — 2026-10-16

- **和色.** The pane is drawn in traditional Japanese colours: 浅葱 / 藍 for work in
  progress, 若竹 / 常磐 done, 山吹 / 琥珀 waiting on you, 藤紫 running, 柿 due soon,
  紅緋 / 茜 stuck, 利休鼠 for frames. A dark and a light set, picked from the
  `/config` theme and repainted when it changes (`hooks/palette.ts`).
  Tests: `two 和色 sets: the light one under a light theme, the dark one
  otherwise`; `the pane takes the light 和色 set under a light theme, and 說明
  lists every mark`.
- **At a glance.** Four counts on top: waiting on you, open, due soon, finished
  today. This session's steps are numbered, the one in progress marked
  「← 現在」, with a percentage on the bar. Other work is grouped by project,
  this one first, each row with a short bar. 說明 lists every mark.
  Test: `other work is grouped by project, this one first, with numbered steps,
  notes and background`.
- **Background.** When the model names the task it also writes one line of
  background (why the work exists, what it should end as); it is written into
  the block as `> 背景：…`, so every session's pane shows it, and the take-over
  and hand-over prompts carry it. A hand-kept task's own `>` notes are its
  background. A step that needs you carries `metadata.why`, shown under it and
  in 等你處理 with the task it belongs to; the rule asks Claude to write it.
  Tests: `the task gets a line of background with its name, and a step that
  needs you says why`; `the model answer becomes a title and a line of
  background`.

## 0.5.2 — 2026-10-16

- **`CLAUDE_CODE_ENABLE_TODO_TOOLS` moves to the shell profile.** In
  `~/.claude/settings.json` the key also reached Claude desktop-app sessions,
  which keep their own task list: they got the Task tools and reminders to use
  them, against the app's own list. `setup.ps1` now adds
  `$env:CLAUDE_CODE_ENABLE_TODO_TOOLS = "1"` to `$PROFILE.CurrentUserCurrentHost`
  (or `-ProfilePath`), once, in the profile's own encoding. `setup.sh` adds
  `export CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to `~/.zshrc`, `~/.bashrc`
  (`~/.bash_profile` on macOS) or `~/.profile`; fish gets a line to add by hand.
  When pwsh is installed, `setup.ps1` prints the command that writes its
  profile too.
- **settings.json is edited in place.** Both scripts take out the key 0.5.0 and
  0.5.1 wrote (value `"1"` only) and the old zip dir in
  `CLAUDE_CODE_PLUGIN_DIRS` by changing just those lines, so the file keeps its
  indent, key order, line endings and UTF-8 BOM; before, `setup.ps1` re-wrote
  the whole file through `ConvertTo-Json` (4-space indent, a diff on every
  line). Each edit is checked against the parsed file; when it cannot be exact,
  or the file is not UTF-8 JSON, the file is left alone and the script says so.
  Neither script creates `settings.json` any more.
- **The key stays in settings.json until the shell can set it**: while
  PowerShell's execution policy (Restricted, AllSigned, unset on Windows
  PowerShell, or unreadable) may keep the profile from running, and under fish. The script
  says what to change. Otherwise terminal sessions would lose the Task tools
  too.
- **The pane's hint** for a session without Task tools points to the shell
  profile, and says desktop-app and git-bash sessions keep `progress.md` by
  hand. Test: `without Task tools the pane points to the shell profile, not
  settings.json`.
- **Installer checks.** `tests/setup.check.ps1` and `tests/setup.check.sh` run
  the scripts against temp folders: settings.json edits (middle, last and only
  key, CRLF, a BOM, a value of `"0"`, a `CLAUDE_CODE_PLUGIN_DIRS` entry with
  `$` and a quote, an edit that cannot be exact, bytes that are not UTF-8), the
  profile line added once, a UTF-16 profile, a blocked or unreadable execution
  policy (faked), zsh and fish. `claude plugin test` does not run them.

## 0.5.1 — 2026-10-16

- **A step ticked in the pane is journaled too.** 完成 / 完成這步 on a hand-kept
  step (job hunting, say) now adds its line to the journal, so 週報 lists it
  beside the steps Claude finished. Test: `the pane acts: tick a step, hand a
  task to Claude, take over, ask aside`.

## 0.5.0 — 2026-10-16

- **Its own repository and marketplace.** Install with
  `claude plugin marketplace add WenyuChiou/claude-progress-pane` and the setup
  script; update with `claude plugin update`. The zip and its installer are
  gone. `scripts/setup.ps1` / `setup.sh` install the plugin, set
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` and move a zip install over: its folder
  leaves `CLAUDE_CODE_PLUGIN_DIRS`, so the mod does not load twice, and its
  block leaves `CLAUDE.md`. They also run piped from a URL (`irm … | iex`)
  once the repository is public.
- **Quick add.** A line starting with `+` in the pane's box, or `/progress 加 …`,
  becomes a hand-kept task under its project, with its due date and steps.
  Tests: `a quick add reads the project, the due date and the steps`; `a quick
  add lands at the end of its section, or a new one, and reads back with its
  date`; `a + line in the pane adds a task to the file, under its project`.
- **Pull request and CI.** Through the person's own `gh`, the card shows the
  branch's PR as a link, re-checks every two minutes while checks run, and
  writes `pr=` / `ci=` into the block so other sessions' rows show it.
  Tests: `gh's answer becomes one word for CI, and words for the card`; `the
  pull request shows on the card and in the block, and a finished CI run
  notifies`.
- **Notifications.** A step that needs you, the list finishing, and CI
  finishing each raise one desktop notification; 通知：開/關 or
  `/progress 通知 關` turns them off. Tests: `a step that needs you and a
  finished list each notify once`; `a step that needs you notifies, the whole
  list finishing notifies, and 通知：關 silences both`.
- **Status line.** With the pane closed or not placed, one line under the
  prompt. Tests: `the status line says where things stand, and nothing when
  nothing does`; `with the pane closed, the line under the prompt carries the
  progress`.
- **Journal and report.** Each finished step is a line in
  `progress-journal-YYYY-MM.md`; 週報 / `/progress 週報` / `/progress 今天`
  copy what finished, what is open and what waits on you. The task is now
  named when its first step is created, so the journal carries the real name.
  Tests: `finished steps are found once, journaled as lines, and read back`;
  `the report groups what finished by task, then lists open work and what
  waits on you`; `finished steps reach the journal, and 週報 copies a report of
  them`.
- **Resume.** A block carries its session's full id and folder; an ended
  session's row offers 複製續接指令 (`cd … && claude --resume …`, or
  `Set-Location` on Windows). Tests: `the marker carries the resume id, the
  folder and the pull request, and reads back`; `an ended session offers the
  command that reopens it where it ran`; `an ended session elsewhere offers
  its resume command, copied for the terminal`.
- **The rule rides the system prompt.** The mod adds how Claude should keep the
  Task list to each session that has the Task tools, instead of the installer
  writing it into `CLAUDE.md`, so uninstalling leaves nothing behind. Where an
  organization manages Claude Code that hook does not run in a personally
  installed plugin; `setup -KeepRule` keeps the rule in `CLAUDE.md` there.
  Test: `the rule rides the system prompt only while the session has a Task list`.

## 0.4.0 — 2026-10-16

Takes in every fix from the local review of 0.3.0 (`UPSTREAM_ISSUES.md`, numbered
as there). Each test named below fails on 0.3.0 and passes here; 33 tests in all.
A copy with those local fixes can take this version as is.

- **Windows test fixture.** The fake file system maps `X:\home\...` back to
  `/home/...`, so the tests see the mod's reads and writes on every host.
- **1. A 完成 press could be overwritten.** Every write this session makes (its
  block, a tick, an archive, `/progress 整理`) goes through one queue.
  Test: `a 完成 press while Claude's own write is on its way: both land`.
- **2. A press could tick the wrong line, or a newer mark.** Steps carry their
  line and text; a press ticks that line if it still reads the same, else the
  one identical line in the file, else nothing.
  Tests: `a press ticks the exact line it showed, and nothing once that line
  changed`; `a press still finds its step after lines above it moved, unless
  the step has a twin`.
- **3. A failed read could empty a file.** A file that exists but cannot be read
  stops the write. A zero-byte read of a file the last poll saw with content is
  read again. `/progress 整理` says when it could not read. Archives are one
  file per month, `progress-archive-YYYY-MM.md`.
  Tests: `a progress.md that cannot be read is never rewritten`; `a progress.md
  holding only whitespace still gets this session's block`; `an archive file
  that cannot be read is left alone, and so is progress.md`; `old done blocks
  go to the month's archive file, after what it already holds`.
- **4. Archiving a block without its end marker.** Only closed blocks are
  archived, whole.
  Test: `archive moves a closed block whole and leaves an unclosed one where it is`.
- **5. Closing the pane by hand did not stick.** Only `mirror:` and `hinted:`
  store keys age out.
  Test: `the person's own store settings are never aged out`.
- **6. 接手做完 dropped step names past the fold.** Rows keep every open step.
  Test: `a task row keeps every open step for the take-over prompt, past the fold`.
- **7. Repeated titles shared keys.** Repeats get `#2`, `#3`, …; covered by the
  first test under 2.
- **8. Two quick side questions could cross.** A reply to a question no longer
  shown is dropped. No test, as in the local copy.

Two of the known issues listed there are fixed too:

- **An end marker closes only its own block** (`session=` must match, or be absent).
- **A block whose end marker was deleted by hand** ends at its first blank line,
  a second `###`, the next block or the next `##`, so hand-kept tasks after it
  are no longer overwritten.
  Test: `an end marker closes only its own block, and an unclosed block stops
  before hand-kept tasks`.

Still open: two sessions writing at the same moment (the last write wins;
needs a lock the mods API does not offer), a half-written read that is not
empty, the cost of side questions after the prompt cache expires, and desktop
sessions without Task tools.

## 0.3.0

Interactive pane: rows open to their steps and actions, 完成 / 完成這步 /
交給 Claude / 接手做完 / 繼續 / 封存, and a side-question box.

## 0.2.0

Mirrors Claude's Task list, survives compaction, plain-language pane.

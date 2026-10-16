# claude-progress-pane

A Claude Code mod: a side pane of every project's work, in plain words, kept
up to date without anyone editing a file by hand. 中文說明：[README.zh-TW.md](README.zh-TW.md).

- **Automatic.** The mod mirrors Claude's own Task list (TaskCreate,
  TaskUpdate, TodoWrite) into one block per session of `~/.claude/progress.md`.
  A block appears when a session starts a list, its steps tick off as Claude
  updates them, and finished blocks move to that month's
  `progress-archive-YYYY-MM.md` after half a day. A session that never makes a
  list writes nothing.
- **Survives compaction.** When Claude Code compacts a conversation, the
  summarizer is told to keep the list, and the conversation it leaves gets a
  short note: the goal, `done/total`, the step in progress and the next ones.
- **Knows about other sessions.** Each block records whether its session is
  working, waiting on you, done, or ended with steps left. A new session's
  first turn hears about unfinished work in the same project, and about work
  another session already holds.
- **Brings its own rule.** How Claude should keep the Task list rides the
  system prompt of each session that has the Task tools. Nothing is written to
  `CLAUDE.md`, so uninstalling leaves nothing behind.
- **Plain pane.** This session's task in a card with a progress bar, then
  what waits on you, what is due soon, other open work, and what finished
  lately. Long lists fold the finished steps into one line.
- **Interactive.** Each task row opens to its steps and its actions:
  完成這步 ticks a hand-kept step in the file, 交給 Claude sends the task to
  this session as a prompt, 接手做完 picks up work an ended session in this
  project left, 複製續接指令 copies the command that reopens that session
  where it ran. 完成 ticks a step that waits on you, 繼續 resumes this
  session, 封存 archives finished work, and the box at the bottom asks a side
  question that is answered in the pane without a turn of its own. Closing the
  pane by hand keeps it closed in later sessions until `/progress`.
- **Quick add.** A line starting with `+` in that box becomes a hand-kept task:
  `+ 求職：Meta 實習 截止 11-20；改履歷；投遞`. No project before the colon:
  this session's repo. A job-hunting task given no steps gets the usual ones.
- **Pull request and CI.** With [gh](https://cli.github.com) signed in, the
  card shows this branch's PR as a link (`PR #12 · CI 失敗 2 · 等審查`), looks
  again every two minutes while checks run, and other sessions' rows show it
  too.
- **Notifications.** A desktop notification when a step needs you, when the
  whole list is done, and when this branch's CI finishes. 通知：開/關 at the
  bottom of the pane, or `/progress 通知 關`.
- **Status line.** With the pane closed, or a terminal too narrow for it, one
  line under the prompt says where things stand.
- **Journal and weekly report.** Every finished step gets a line in that
  month's `progress-journal-YYYY-MM.md`. 週報 (or `/progress 週報`, `/progress 今天`)
  turns the last seven days into plain text — finished, open, waiting on you —
  and copies it, ready for a standup or a message to an advisor.

Text the mod did not write (a hand-kept `## 求職` section, notes) is left byte
for byte; each session rewrites only the lines between its own markers. Every
write a session makes goes through one queue, and a file that cannot be read
is never written over.

## Install

Needs Claude Code 2.1.287 or newer (function-hook mods); built and tested on
2.1.289 through 2.1.301.

    claude plugin marketplace add WenyuChiou/claude-progress-pane

Then run the setup script from the marketplace's copy. It installs the plugin
(a no-op once done), turns on `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (Claude Code
leaves the Task tools out on models newer than Opus 4.7 / Sonnet 4.6 / Haiku
4.5 unless it is on, and without them there is nothing to mirror), and moves an
old zip install over (below). It is safe to re-run.

The key goes in your shell's profile, not in `~/.claude/settings.json`:
the env there also reaches Claude desktop-app sessions, which keep their own
task list, and the Task tools would clash with it. `setup.ps1` adds
`$env:CLAUDE_CODE_ENABLE_TODO_TOOLS = "1"` to `$PROFILE` (`-ProfilePath`
picks another file); `setup.sh` adds `export CLAUDE_CODE_ENABLE_TODO_TOOLS=1`
to `~/.zshrc`, `~/.bashrc` (`~/.bash_profile` on macOS) or `~/.profile`. If
0.5.0 or 0.5.1 put the key in `settings.json`, the script takes it out again,
changing only its line (and the comma beside it) and keeping the file's
indent, key order and encoding; if it cannot do that exactly, it leaves the
file alone and says what to change. PowerShell runs a profile only when the
execution policy allows scripts: until it does
(`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then run the script
again), the key stays in `settings.json` and the script says so. PowerShell 7
(`pwsh`) has a profile of its own: if you start `claude` there, run the
Windows command below with `pwsh` in place of `powershell` as well.

Sessions without the key (the desktop app, a git-bash terminal on Windows)
have no Task tools: the pane says so, and their work goes in `progress.md` by
hand (below).

Windows:

    powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\plugins\marketplaces\claude-progress-pane\scripts\setup.ps1"

macOS / Linux:

    bash ~/.claude/plugins/marketplaces/claude-progress-pane/scripts/setup.sh

Start `claude` again from a new terminal window. The pane opens by itself;
`/progress` reopens it.

If the repository is public, the two steps are one line:

    irm https://raw.githubusercontent.com/WenyuChiou/claude-progress-pane/main/scripts/setup.ps1 | iex
    curl -fsSL https://raw.githubusercontent.com/WenyuChiou/claude-progress-pane/main/scripts/setup.sh | bash

**Private repository.** Claude Code clones with your machine's own git
credentials and never prompts. If the add fails, run `gh auth login` and
`gh auth setup-git` once; on a machine without a GitHub SSH key, also set
`CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`.

### Moving from the zip install

The setup script does it, and is safe to re-run. It removes
`~/.claude/mods/project-progress` from `CLAUDE_CODE_PLUGIN_DIRS`, so the mod
does not load twice, and removes the `<!-- project-progress:start/end -->`
block from `~/.claude/CLAUDE.md`, since the plugin adds the rule itself. Other
blocks (such as `comm-style`) stay. Each file it changes is copied to
`<file>.bak` first. It deletes no folder: once the plugin works, delete
`~/.claude/mods/project-progress` yourself. `progress.md` and the archives are
read as they are.

Where an organization manages Claude Code, plugins you install yourself do
not get the compaction or system-prompt hooks. There, run the script with
`-KeepRule` (`--keep-rule` in bash) to keep the rule in `CLAUDE.md`. The
compaction note is not available there.

## Update

Third-party marketplaces do not update by themselves unless you turn it on:

    claude plugin marketplace update claude-progress-pane
    claude plugin update project-progress@claude-progress-pane

then restart, or run `/reload-plugins` in a session. To update in the
background instead: `/plugin` → Marketplaces → claude-progress-pane →
Enable auto-update.

## Use

Work as usual. For anything with two or more steps Claude makes a Task list,
and the pane follows it.

- `/progress` opens the pane; `/progress 整理` archives finished work now;
  `/progress 同步` re-reads Claude's Task list and the PR;
  `/progress 加 …` adds a task (same as `+` in the pane);
  `/progress 週報` / `/progress 今天` copies a report;
  `/progress 通知 開|關` turns notifications on or off.
- A step that needs you: Claude sets `metadata: {"waiting": "you"}` on it and
  it shows under 等你處理. `{"waiting": "run"}` is a step waiting on CI, a long
  run or someone else; `{"blocked": "why"}` is stuck.
- Work outside a repo goes in by hand, in the same file:

      ## 求職
      ### Google 暑期實習
      > 截止 10-31
      - [x] 改履歷
      - [?] 推薦信 — 等教授回覆
      - [ ] 投遞

  `[x]` done · `[~]` doing · `[ ]` not started · `[?]` waiting on you ·
  `[>]` running · `[!]` blocked · `[-]` cancelled. `截止 MM-DD` puts the
  task under 快到期, red within three days.
- `CLAUDE_PROGRESS_FILE` points the mod at another file; the archives and
  journals sit beside it.

In the terminal's default fullscreen layout the pane docks on the right: on
its own from 144 columns, through `/progress` from 110. Under tmux or
`CLAUDE_CODE_NO_FLICKER=0` it sits above the prompt instead. Cloud sessions
draw no pane; under Remote Control it shows only in the local terminal.

## Uninstall

    claude plugin uninstall project-progress@claude-progress-pane
    claude plugin marketplace remove claude-progress-pane

`progress.md`, its archives and journals, and the `CLAUDE_CODE_ENABLE_TODO_TOOLS`
line in your shell profile stay.

## Develop

    git clone https://github.com/WenyuChiou/claude-progress-pane
    cd claude-progress-pane
    claude --plugin-dir .      # runs this copy; also writes .claude-plugin/types/ for tsc and the editor
    claude plugin validate .
    claude plugin test .
    tsc -p .
    powershell -NoProfile -ExecutionPolicy Bypass -File tests/setup.check.ps1
    bash tests/setup.check.sh

The last two run the setup scripts against temp folders (never your own
`~/.claude` or profile); `claude plugin test` does not run them.

- `hooks/parse.ts` reads the file; `hooks/blocks.ts` writes a session's block,
  a quick-added task, and archives old ones; `hooks/mirror.ts` mirrors the
  Task calls, words the compaction note and finds what to journal or notify;
  `hooks/view.ts` decides what the pane and the status line show;
  `hooks/github.ts` reads `gh pr view`; `hooks/quick.ts` reads a quick add;
  `hooks/journal.ts` writes the journal and the report. All pure and
  unit-tested.
- `hooks/pane.tsx` draws the pane from the view and a set of actions; it never
  touches the engine.
- `hooks/rule.ts` is the rule the mod adds to the system prompt;
  `scripts/claude-md-rule.md` is the same rule for `-KeepRule`. Change both.
- `hooks/register.tsx` wires them to the engine: the Task-call hooks, turn
  start and end, compaction, the system prompt, session end, the pane, the
  command, the 2s poll and the PR check.

To release: raise `version` in `.claude-plugin/plugin.json` (installed copies
only update when it changes), add a `CHANGELOG.md` entry, check, push, then
`claude plugin tag .` and `git push --tags`.

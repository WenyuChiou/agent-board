# Changelog

## Unreleased

- Add an opt-in Node 24 local exchange for Codex and dot: explicit progress
  reports, session bindings, message claims and immutable terminal receipts.
  No hooks, user configuration, conversations or credentials are collected.
  Covered by `dot reports only explicit minimal fields and emits a backward-compatible progress block`,
  `one consumer claims a message and a restart never replays uncertain delivery`
  and `the CLI performs a synthetic dot round trip without any external runtime`.
  Strict enum input and language-table output are covered by
  `non-string receipt and progress enums are rejected before writing state` and
  `report context uses the existing English, Traditional Chinese and Simplified Chinese tables`.
  Windows path spellings are accepted while linked roots and ancestors are
  rejected before writes. Tests: `Windows drive-letter aliases do not count as symbolic links`
  and `linked roots and linked ancestors are rejected before initializing or reporting`.
- Add a host-supplied, verified Codex owner adapter for `turn/steer` with an
  expected active turn. No arbitrary-session attachment or idle `turn/start`.
  Covered by `a verified owner can steer only its loaded thread and the expected active turn`,
  `unverified owners, unloaded threads, missing methods and idle commands fail closed`
  and `lost acknowledgements stay uncertain and are never sent a second time`.
  Native owner delivery is mock-tested; dot requires an explicit file consumer.

## 0.11.0 — 2026-10-17

- **Hermes Agent reports to the pane.** `/progress connect` adds two shell
  hooks to `~/.hermes/config.yaml` (`$HERMES_HOME`): `post_llm_call` for each
  turn, whose words Hermes puts under `extra`, and `on_session_finalize` for
  the end (Hermes fires its `on_session_end` after every turn). The YAML is
  edited line by line, beside the person's own hooks, and a `hooks:` block in
  flow style is left alone. Hermes asks once before it runs a new hook.
  Tests: "Hermes Agent’s hooks go into its config.yaml beside the person’s
  own, once, and come back out cleanly", "Hermes Agent’s turn is read from
  under extra, and its session finalize is the end, not its per-turn session
  end", "a real Hermes Agent turn, its words under extra, becomes a block
  waiting on the person".
- **Grok Build's blocks are named from the request.** Grok's `Stop` carries
  the reply but not the request, so its block was titled with the reply and
  had no background line. The request is now read from Grok's session log,
  which streams messages in ACP chunks. Tests: "a Grok Build session log gives
  back the request and reply it streamed in chunks", "a real Grok Build turn
  takes its request from the session log and ends on the shutdown stop".
- **A session log is opened only when it is one.** The path came straight
  from the inbox file, which any program on the machine can write; now only a
  `.json`, `.jsonl` or `.txt` path with no `..` in it is read. Test: "only a
  session log is opened, never a key or env file, nor a path that climbs out
  of its folder".
- **Tested live against the real CLIs**: Gemini CLI 0.64.0, OpenCode 1.19.3,
  Hermes Agent 0.19.0 and Grok Build 1.0.62 each ran a turn against a mock
  model; their payloads are now tests. Tests: "a real Gemini CLI turn and its
  session end become one ended block, its request taken from AfterAgent", "a
  real OpenCode turn from its plugin becomes a block waiting on the person",
  and the Hermes and Grok tests above.
- **README rewritten**: a table of supported agents with icons and what was
  tested live, a quick start, what you get, colours and marks, and answers to
  common questions (a new computer, an agent that doesn't show up, what leaves
  the machine, Windows, uninstalling). The guides gain "Pick the colours",
  Hermes Agent, and troubleshooting for a missing agent and a new computer,
  and now name the `agent-board.*` hook files. SECURITY.md says what
  `/progress connect` changes and that turns are summed up by Claude Haiku.
- **A promotional card** (`docs/images/social-preview.png`, with `-zh-TW` and
  `-zh-CN`): the pitch, the agents it works with, and the pane with a question
  just in. The tour lists Hermes Agent, keeps its window's rounded corners,
  and its handoff ring no longer crosses Chinese text.

## 0.10.0 — 2026-10-17

- **New name: Agent Board.** The pane follows Claude Code, Codex, Gemini CLI, Cursor,
  OpenCode, Grok Build and Muse Code, so a name starting with "claude" said too
  little. The new one says what it is: one board for all your agents.
  - The plugin is `agent-board`, from the `agent-board` marketplace, in the
    `WenyuChiou/agent-board` repository:
    `claude plugin install agent-board@agent-board`.
  - The tour, the social preview, the READMEs, the guides and the page title of
    `progress.html` carry the new name, and the plugin has a description that
    says what it is for.
  - The tour reads better at README size: the pane window is larger, every
    line of small text is bigger, and each moment eases in and out (headlines
    rise into place, the pane's frames dissolve into each other, the end card
    grows in) instead of a flat fade.
  - The "How it works" picture is redrawn: three numbered columns (who
    reports, the one file, where you see it), type about half again as large,
    and shorter words.
  - `/progress connect` writes Grok Build's and OpenCode's hook files as
    `agent-board.json` and `agent-board.js`, and takes away the `progress-pane` ones it
    wrote before, so no turn is reported twice. The section between
    `claude-progress-pane` markers in an agent's instructions is still found
    and removed.
  - The setup scripts uninstall `project-progress@claude-progress-pane` and
    remove its marketplace before they install `agent-board@agent-board`. An auto-update
    turned off under the old name stays off, and an agent section or a
    CLAUDE.md block under the old markers is replaced rather than doubled.
  - Unchanged: the `/progress` command, `~/.claude/progress.md` and its format,
    `CLAUDE_PROGRESS_FILE`, and the reporter script `progress-report.sh`.

  Tests: `/progress connect hooks the installed agents into the pane once,
  keeps their own hooks, and takes ours back out` (now with an old Grok file),
  `each agent’s config gets the hook in the shape it reads, and nothing else of
  the person’s changes`, and the four "old name" installer checks in
  `tests/setup.check.sh` and `tests/setup.check.ps1`.

  BREAKING CHANGE: an install under the old name does not update to this one by
  itself. Run the setup script once, or the five commands in the guide
  (Update and uninstall → Coming from the old name). The pane's language and
  notification choices, kept per plugin, go back to their defaults.
- **Codex, tested for real.** Codex CLI 0.163.0 ran one turn of `codex exec`
  against a stand-in model server. `/progress connect` had installed the hooks,
  and Codex ran its Stop and SessionEnd hooks. The reporter saved both payloads,
  and an open Claude Code session turned them into Codex's block. That run
  found three things, now fixed:
  - **No name.** Codex's Stop carries the reply but not the request, so the
    block had no name or background. The request is now read from the session
    log the payload points to.
  - **Wrong state.** `codex exec` writes the turn and the session end in the
    same second, and sorting by file name put the end first, so the block said
    "waiting" for a finished session. Files are now taken by time, with a turn
    before its session's end.
  - **"(unnamed)" title.** A block with no name now falls back to the request or
    its first step.

  Test: `a real Codex turn and its session end, written in the same second,
  become one ended block named from the request`, built on the payloads and
  log lines Codex actually wrote.
- **A short tour at the top of the README** (about 48 seconds, each screen
  held long enough to read). It replaces the banner and the
  three-frame demo, in three acts:
  - Why: five agents, one of them waiting on you, then the pane.
  - What it does: answering with one press, every agent reporting through its
    own hooks, a handoff line and take-over.
  - Where it runs and how it looks: the surfaces and systems, then
    the light and dark 和色 palettes with each colour's name, and an end card
    with the install command.

  A timeline along the bottom shows how far the tour has come. It is one SVG per
  language and theme, drawn from `drawPane` by `docs/preview/render.ts`, and
  animated with CSS alone, so GitHub plays it. With reduced motion, it shows one
  still frame. The banner remains only as the social preview.
- **README speaks to the reader's problem first.** It opens with the situation:
  several agents running, and one of them stuck waiting on you without you
  knowing. Then it says what the pane does about that, and only then lists the
  features, in plain words. The tour's captions follow the same order.
- **Faster poll.** The path of `progress.md` is worked out once per session
  instead of on every 2-second poll and 5-second inbox look. The test that
  simulates an hour went from about 4.8 s to about 2.8 s, which takes it well
  clear of the 5 s test timeout it had been brushing against.

- **Set up from any agent.** The README's install section is now three shell
  lines, ending with `claude -p "/progress connect"`. It also gives a prompt to
  paste into Codex, Gemini CLI, Cursor, Grok, Muse or any agent that can run
  commands, so that agent does the setup. Checked in a clean home directory:
  after a real `marketplace add` and `install`, `claude -p "/progress connect"`
  connected the agents found there.

## 0.9.0 — 2026-10-17

The pane no longer depends on an agent remembering to report. Each agent's own
harness says when a turn ends, and the pane sums the turn up.

- **Progress without a Task list.** A session that keeps no Task list still
  shows up: a turn that edited a file or ran a command is summed up by Haiku
  into a title, a line of background, what it finished, the next step and what
  it ended up asking. The block keeps the last six finished turns and says
  `source=turns`; the first TaskCreate replaces the summed-up steps with the
  real list. A turn that only answered a question leaves nothing behind.
  Tests: `without a Task list, a turn that changed something is summed up into
  steps and its question`, `a turn that only answered a question leaves no
  block behind`, and the pure `the model’s summary of a turn …`, `a turn counts
  as work …`, `a summed-up list keeps the last six finished turns …`.
- **A question at the end of a turn waits on you.** When a turn ends on a
  question and Claude marked nothing as waiting, the step in progress waits on
  you with the question as its note, and you get a notification. Your next
  prompt clears it. Tests: `a turn that ends on a question waits on you even
  when Claude did not mark it, until you answer`, `the question a reply ends
  on …`, `a question marks the step in progress …`.
- **Background follows the goal.** Once the list has grown by three steps since
  the title and background were written, Haiku looks at both again and keeps
  them when the goal is the same.
- **Handoff at compaction.** A compaction leaves one line in the block (what is
  done, what is stuck, the next step) as a `Handoff:` / `交接：` note. The
  opened row shows it, and **Take over and finish** passes it on. `docs/FORMAT.md`
  documents the note and the `source` attribute. Tests: `a compaction leaves a
  handoff line in the block`, `a stopped session’s handoff line shows on its row
  and goes with 接手做完`, `a handoff note is its own line …`.
- **Other agents through their own hooks: `/progress connect`.** One command
  finds the agents installed here and adds a turn-end hook to each:
  - Codex: `Stop` in `hooks.json`. Codex asks you to approve it once in `/hooks`.
  - Gemini CLI: `AfterAgent` in `settings.json`.
  - Cursor: `afterAgentResponse` and `stop` in `hooks.json`.
  - OpenCode: a plugin on `session.idle`.
  - Grok Build: a file in `~/.grok/hooks`.
  - Muse Code: `Stop` in `settings.json`, with the `schema_version` it needs.

  Each hook runs `progress-report.sh` (or `.ps1`), written beside
  `progress.md`. The script has no dependencies, saves the hook's input into
  `progress-inbox/`, clears files older than two days, prints nothing (`{}`
  for Cursor) and always exits 0, because some agents read exit 2 as "keep
  going". Every 5 seconds an open session checks the folder: a stat, plus a
  listing only when the folder changed. It stamps new files in the store so
  only one session reads each, and sums the agent's turns up into its own
  block. If one turn is reported twice, it counts once: two hooks of the same
  turn, or Grok Build also running Cursor's hooks.

  Your own hooks stay. A config file that is not plain JSON is left alone and
  named. The AGENTS.md section that setup `--agents` wrote for that agent is
  removed, and setup now skips agents that are connected.
  `/progress connect remove` takes it all out. Payload fields come from each
  agent's source code or docs; none of these agents was run live here.
  Tests: `/progress connect hooks the installed agents into the pane once …`,
  `another agent’s turn, left in the inbox by its hook, becomes its block once
  …`, `each agent’s hook payload reads as a turn …`, `each agent’s config gets
  the hook in the shape it reads …`, and `agents: an agent hooked by /progress
  connect gets no section` in both setup checks.
- **README.** 56 lines instead of 294 in each language: what it is, the
  interaction demo, three points, install, what to type, how it works. The rest
  moves to `docs/GUIDE.md` (and `GUIDE.zh-TW.md`, `GUIDE.zh-CN.md`). The demo's
  three frames are as tall as the shortest, so none leaves an empty window. The
  `progress.html` screenshots are gone.

## 0.8.0 — 2026-10-17

- **Archive a row now.** Open a stopped session or a task you keep by hand and
  press **Archive** (封存, 归档): it moves to this month's archive file right
  away, in the same form the sweep writes, instead of waiting half a day or
  three. A task that changed since the pane drew it (its heading now has a
  twin, its block lost its end marker, its heading sits inside a session's
  block) is left where it is, and the pane says so.
  Tests: `封存 on a row takes that task out of the file now and into this
  month’s archive`, `封存 of a task someone changed meanwhile says so and leaves
  the file alone`, and the two pure `封存 …` tests in `tests/features.test.ts`.
- **Reminders.** A question another session or agent asks you notifies once,
  and work due today or late notifies once a day. What was already said is kept
  in the plugin's store, shared by every open session, so one question pings
  once however many sessions are open. Questions already in the file when a
  session starts count as said (the pane opening shows them), and the very
  first run says nothing about what is already there. The notifications toggle
  covers these too.
  Tests: `a question another agent asks notifies once, not the ones already
  there at the start`, `work due today notifies once that day`, `with
  notifications off, reminders stay quiet`, `the first run ever says nothing
  about what is already in the file`, `reminders: another session’s question
  once, and work due today or late once a day`.
- **The repository's front page.** The README opens with a banner and an
  animated demo of the pane (the question that needs you, everything waiting by
  kind, the pane after you answer), and has a "How it works" diagram, each in
  English, 繁體中文 and 简体中文 and in a light and a dark version that follows
  GitHub's theme. They are SVG drawn from `drawPane` itself by
  `docs/preview/render.ts`, which lays the pane out like a terminal
  (`docs/preview/terminal.ts`); `docs/preview/png.mjs` takes the `progress.html`
  screenshots and a 1280 × 640 social preview. The PNG screenshots of the pane
  are gone.
- **Community files**: issue forms (bug, idea), a pull request template with
  the checks, `SECURITY.md` and `CODE_OF_CONDUCT.md`.

## 0.7.1 — 2026-10-17

Found by running the whole thing for real: installing from GitHub into a clean
config, updating from 0.5.2, a headless Claude Code session doing a small task,
and agents on three different models (as `codex`, `gemini`, `cursor`), each
given only the AGENTS.md section, writing to one `progress.md` at the same
time. All of it worked: every block, label and kind of question read right, and
nothing outside the agents' own blocks changed. These are the rough edges it
showed.

- **Other agents in one step.** `setup.sh --agents` (`setup.ps1 -Agents auto`)
  puts the AGENTS.md section into the global instructions of the agents
  installed here: Codex (`$CODEX_HOME/AGENTS.md`, or `AGENTS.override.md` when
  that one has text), Gemini CLI (`~/.gemini/GEMINI.md`), OpenCode
  (`~/.config/opencode/AGENTS.md`), between markers, keeping the rest of each
  file. `--agents=codex,gemini` names them, `--remove-agents` takes it out.
  Without the option, the script says which agents it found.
  Checks: `agents: …` in `tests/setup.check.sh` and `tests/setup.check.ps1`.
- **Another agent's command and link, from here.** Its question is still
  answered in its own session, but a command it asks you to run now shows with
  **Copy command**, and a link with **Open it**.
  Test: `another agent's question is answered there, but its command can be
  copied and its link opened from here`.
- **English titles are no longer chopped.** Titles and background lines are cut
  by terminal width (a CJK character is two cells), at a word, with `…`: an
  English title got 24 characters and read `Add README describing in`.
  Test: `titles and background are cut by terminal width, at a word in English,
  never mid-word`.
- **progress.html** shows a backticked word as a command only in a step that
  asks you to run something; in a question it is a name.
- **The AGENTS.md section** says the `###` title is the agent's to word, other
  `>` lines are allowed, and only commands go in backticks: the test agents
  asked about the first two and put a file name in backticks.
- **Setup** sets the language option to `auto` after a fresh install, so
  Claude Code stops saying an option is not set. A language you picked stays.

## 0.7.0 — 2026-10-16

Includes 0.6.0, which was not released on its own.

- **Questions by kind.** A step that waits on you is a confirm, a choice, an
  input, something to do, something to review, or a wait for someone else,
  from `metadata.ask` / `options` / `command` / `link` or from its words
  (Chinese and English). Each kind gets its own controls in the pane (Yes / No,
  one button per option, Copy command / Did it, Open it / Looks good, Ready, a
  reply box), and a press goes back to this session as the answer. Another
  session's question says where to answer it. `A，還是 B？` and `A, or B?`
  read as a choice too.
  Tests: `what a waiting step asks decides its buttons: confirm, choose, do,
  review, input, wait`; `a question this session asks is answered from the
  pane, with the buttons its kind calls for`; `English questions: a yes or no
  is a confirm, "or" inside a word is no choice, waiting reads the step too`;
  `a choice with a comma before 還是 / or still reads both options`.
- **Needs you first.** The pane opens on the one thing that needs you most (an
  answer here, then elsewhere, then a deadline today, then something stuck),
  and folds waiting, due soon, other work and done to one line each; a press
  opens a section and it stays open in the next session. This session's card
  shows the step in progress and the next; every step is one press away.
  Tests: `the focus is the most pressing thing: an answer here, then
  elsewhere, then today, then stuck, then waiting on others`; `folded sections
  open on a press and stay open in the next session`; `on the phone (no input
  box) the pane still draws, focus first, with its buttons`.
- **It does not pile up.** A session silent for 12 hours shows as stopped and
  its questions leave 等你處理. Done blocks leave for the monthly archive after
  12 hours, others after 3 days, a hand-kept task a day after it was first seen
  done; the sweep runs every hour. A block with no readable time is never
  archived, and a section someone left empty stays.
  Tests: `a session silent for half a day counts as stopped: its questions stay
  in its row, not in 等你處理`; `blocks leave after half a day when done and
  after three days otherwise`; `finished hand-kept tasks leave a day after they
  were first seen done, whole, and nothing else moves`; `a hand-kept task done
  for a day leaves for the archive by itself, and the next hour clears a done
  block`; `archiving never ages out a block with no time, and keeps a section
  someone left empty`.
- **Readable on light terminals.** Secondary text uses a muted colour from
  each 和色 set instead of the terminal's dim, which turned faint grey on white.
  Every text colour is at least 4.5:1 on its ground: light 琥珀 became 鶯茶
  `#715C1F`, dark 紅緋 became 薔薇 `#E9546B`.
  Test: `on a light terminal no text falls back to the terminal dim`.
- **English, 繁體中文, 简体中文.** The pane, the words written into the file
  and the rule follow the plugin's `language` option (`/config`), then
  `/progress lang`, then Claude Code's `language` setting, then the system
  locale. The parser reads `Context:` and `Background:` as well as `背景：`,
  and `due MM-DD` as well as `截止 MM-DD`.
  Tests: `languages: the setting, the stored choice and the system pick the
  language, in that order`; `with the language option set to English, the
  pane, the file and the rule speak English`; `/progress lang switches the
  language and remembers it; auto goes back to the system`; `a file written in
  English reads back: Context, due, and an English quick add`.
- **A window of its own.** Every session writes `progress.html` beside
  `progress.md` (at most once a minute, only when it changed): the whole file's
  view as a page that reloads every 30 seconds, keeps the sections you opened,
  follows the system's light or dark mode and fits a phone. `/progress open`
  opens it in the default browser.
  Tests: `progress.html shows the whole file: counts, the focus, folded
  sections, steps, and escapes what it shows`; `progress.html is written beside
  progress.md, and /progress open opens it in the browser`.
- **Other agents.** Blocks carry `agent=`; a block from Codex, Gemini or another
  agent is labelled and says where to answer it. `docs/FORMAT.md` specifies the
  file; `AGENTS.md` ends with a section to paste into another project's
  `AGENTS.md` / `GEMINI.md` / `.cursorrules`; `CONTRIBUTING.md` has the checks
  and the release steps. `CLAUDE_CONFIG_DIR` moves the default file with it.
- **How the file is read (still format version 1).** `due` must start a word
  (`overdue 3-4` is no longer a date); `2026/10/31` is read; a month or day
  that does not exist is no date. `Context:` and `Background:` count as the
  background line, so a hand-kept task with such a note shows that note alone.
  A block with no readable `updated` is never archived (it used to leave at the
  first sweep). Archive headings use the local date and the pane language;
  journal lines write the pane language's word for an empty field. `可以`,
  `要不要` and `能不能` opening a question make it a confirm.
  Test: `可以 / 能不能 opening a question make a confirm; a date that does not
  exist is no due date; the journal speaks the pane language`.
- **Auto-update.** `setup.ps1` and `setup.sh` set `"autoUpdate": true` on the
  marketplace's entry in `~/.claude/settings.json`, after
  `claude plugin marketplace add` (which writes the entry anew without it). An
  `"autoUpdate": false` you set stays.
  Checks: `auto-update: …` in `tests/setup.check.sh` and
  `tests/setup.check.ps1`.
- **README** in English, 繁體中文 and 简体中文: features first, then a
  step-by-step start, with screenshots in `docs/images/` drawn by the pane's
  own code.
- **MIT license** (`LICENSE`, `license` in `plugin.json`).

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

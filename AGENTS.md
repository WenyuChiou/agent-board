# AGENTS.md

This repository is Agent Board (plugin name `agent-board`), a Claude Code plugin (a "mod") that draws a side pane of every project's work from one Markdown file, `~/.claude/progress.md`. The file format is specified in [docs/FORMAT.md](docs/FORMAT.md).

This file has two parts:

1. [Working on this repository](#working-on-this-repository): for an agent that changes this code.
2. [Report your progress to the progress pane](#report-your-progress-to-the-progress-pane): the last section of this file. Copy it, from its heading to the end of the file, into the `AGENTS.md`, `GEMINI.md` or `.cursorrules` of any project, and a non-Claude agent working there shows its work on the pane. `scripts/setup.sh --agents` (PowerShell: `setup.ps1 -Agents auto`) does that for Codex, Gemini CLI and OpenCode, in their global instructions. An agent working on this repository may follow it too.

## Working on this repository

### Checks

Run these from the repository root. Claude Code 2.1.287 or newer is needed (the minimum `README.md` gives); CI installs 2.1.301, pinned in `.github/workflows/test.yml`.

```
claude --plugin-dir .                  # runs this copy of the mod; also writes .claude-plugin/types/
claude plugin validate --strict .      # validates the plugin and the marketplace; CI uses --strict
claude plugin test .                   # runs tests/*.test.ts and tests/*.test.tsx
tsc -p .                               # type check; needs .claude-plugin/types/ from the first command
bash tests/setup.check.sh              # installer checks for scripts/setup.sh (CI: Linux); needs bash and python3
powershell -NoProfile -ExecutionPolicy Bypass -File tests/setup.check.ps1   # installer checks for scripts/setup.ps1 (CI: Windows)
python3 -B scripts/remote-reporter/test_pipeline.py   # remote reporter tests; stdlib Python, runs in a temp folder
```

`claude plugin test` does not run the two installer checks: they run `scripts/setup.sh` or `scripts/setup.ps1` against temp folders and never touch your own `~/.claude` or shell profile. Run the one that matches the script you changed.

CI (`.github/workflows/test.yml`, on every pull request and every push to `main`) runs `claude plugin validate --strict .`, `claude plugin test .` the installer check for the runner's system and the remote reporter tests, on Ubuntu and on Windows. It does not run `tsc -p .`, so run that yourself.

`.claude-plugin/types/` is written by Claude Code every time it loads the mod from a folder. It is gitignored. Do not edit it. If `tsc -p .` complains about missing files or modules, run `claude --plugin-dir .` once.

If you cannot run `claude` in your environment, say so in your report. Do not claim the checks passed.

### Layout

| Path | What it holds |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest and version. |
| `.claude-plugin/marketplace.json` | Marketplace listing. |
| `hooks/hooks.json` | Lists the one module the engine loads, `./register.tsx`. |
| `hooks/register.tsx` | Wires everything to the engine: Task-call hooks, turn start and end, compaction, the system prompt, session end, the pane, the `/progress` command, settling the language, the 2-second poll, the 5-second look at the inbox of other agents' turns, summing turns up with Haiku, `/progress connect`, the PR check, archiving, reminders, journal writes, and writing `progress.html`. It also works out where `progress.md` is: `CLAUDE_PROGRESS_FILE`, else `progress.md` in `CLAUDE_CONFIG_DIR`, else `~/.claude/progress.md`. |
| `hooks/pane.tsx` | Draws the pane from a view and a set of actions. |
| `hooks/parse.ts` | Reads `progress.md` into projects, tasks and steps; auto-marker attributes, staleness, due dates, project matching. |
| `hooks/blocks.ts` | Writes, removes and extracts a session's block; picks what to archive; adds a quick-add task; ticks a hand-kept step. |
| `hooks/mirror.ts` | Mirrors Claude's Task list (TaskCreate, TaskUpdate, TodoWrite) and its `metadata`; words the compaction note; titles and notices. |
| `hooks/ask.ts` | Works out what a `[?]` step asks of the person, from explicit metadata or from its words. |
| `hooks/view.ts` | Turns the parsed file and this session's list into what the pane, the status line and `progress.html` show; also reads a task's background line. |
| `hooks/digest.ts` | Sums a turn up into steps for a session with no Task list (`parseDigest`, `applyDigest`), finds the question a reply ends on (`lastQuestion`, `markAsked`), tells work from a plain answer (`turnTools`, `isWork`), and cleans the compaction's handoff line. |
| `hooks/inbox.ts` | Reads what another agent's turn-end hook left in `progress-inbox/` (`readTurn`): each agent's field names, Grok Build running Cursor's hooks, Cursor's byte-order mark; the stable 8-hex block id per agent session; the tail of a session log. |
| `hooks/connect.ts` | What `/progress connect` writes: the reporter script (sh and PowerShell), each agent's hook in the shape its config reads (`agentHooks`), merging into and out of a config without touching the person's own hooks (JSON, and Hermes Agent's YAML line by line), and the OpenCode plugin. |
| `hooks/remind.ts` | Which reminders are due: another session's question once, work due today or late once a day. |
| `hooks/journal.ts` | Journal line format, month file names, and the report text. |
| `hooks/github.ts` | Reads `gh pr view` JSON into PR and CI state, and the words for them. |
| `hooks/quick.ts` | Reads a quick-add line (`+ project: title due 11-20; step; step`). |
| `hooks/palette.ts` | The dark and light colour sets and the tone-to-colour maps. |
| `hooks/rule.ts` | The rule added to Claude's system prompt, in each language (`RULES`). `scripts/claude-md-rule.md` is the Traditional Chinese rule for `--keep-rule` / `-KeepRule` installs, written in the first person: when you change the rule, change it too. |
| `hooks/i18n.ts` | `ZH_TW`, the reference table of every word the person reads or the mod writes into a file; `Strings = typeof ZH_TW`; `Lang` and `LANGS`. |
| `hooks/strings-en.ts`, `hooks/strings-zh-cn.ts` | `EN` and `ZH_CN`: the same table in English and Simplified Chinese, typed `Strings`. |
| `hooks/strings.ts` | `STRINGS` (the three tables by language), `langOf` (reads a language name) and `resolveLang` (which language wins). |
| `hooks/dashboard.ts` | Builds `progress.html` from a view: a standalone page that reloads itself every 30 seconds. `register.tsx` writes it beside `progress.md` (same name, `.html`), after it reads a changed file and on its 30-second tick, at most once a minute and only when the page changed; `/progress open` writes it at once and opens it in the browser. |
| `types/index.d.ts` | Shared types and the plugin's state. |
| `tests/` | `parse.test.ts` (parser), `logic.test.ts` (blocks, mirror, view logic), `features.test.ts` (later features through the pure modules: ask kinds, journal, PR and CI, quick add, palette, languages, `progress.html`), `pane.test.tsx` (the mod and the pane against a mock engine). `setup.check.sh` and `setup.check.ps1` are the installer checks; `claude plugin test` does not run them. |
| `scripts/` | `setup.sh`, `setup.ps1` and the rule text. With `--agents` / `-Agents`, the setup scripts copy the last section of this file into the global instructions of Codex, Gemini CLI and OpenCode, between `<!-- agent-board:start -->` and `<!-- agent-board:end -->` (a section under the old `claude-progress-pane` markers is found and replaced too); keep that section's heading as it is, since they find it by that heading. |
| `scripts/remote-reporter/` | Stdlib Python for remote reporters: `reporter.py` builds an agent's block fragment (registry and outbox in `$AGENT_BOARD_REMOTE_DIR`, else `$CLAUDE_CONFIG_DIR/remote-reporter/`, else `~/.claude/remote-reporter/`), `merge.py` merges fragments into `progress.md`, `validate.py` scans a file the way `hooks/parse.ts` does, `test_pipeline.py` tests them. Keep the scanner in step with `parse.ts`. |
| `.github/workflows/test.yml` | CI: `validate --strict`, `plugin test` and the installer check for the system, on Ubuntu and Windows. No `tsc -p .`. |
| `docs/` | `FORMAT.md`, the format spec. `docs/images/` holds the README's images, drawn from sample data by `docs/preview/` (`render.ts` lays `drawPane`'s tree out as a terminal grid and writes SVG: the tour `tour-<lang>.svg`, how it works `flow-<lang>.svg`, the promotional card `promo-<lang>.svg` and the agent icons from `icons.ts`, all in one brand look; `png.mjs` turns the promotional cards into `social-preview*.png`); do not edit them by hand. |
| `docs/REMOTE_REPORTERS.md` | How an agent that does not run on the board's machine reports: the fragment and merge step, transports, and what has no inward channel. |
| `.github/` | CI, the issue forms and the pull request template. `SECURITY.md` and `CODE_OF_CONDUCT.md` are at the root. |

`/progress` (the `command.run` handler in `register.tsx`) takes these arguments; the Chinese and alternative names are listed beside each. With no argument, or one it does not know, it opens the pane.

| Argument | Does |
|---|---|
| `lang en`, `lang zh-TW`, `lang zh-CN`, `lang auto` | Stores the pane language (`auto` removes the stored choice) and applies it at once. Also `language`, `語言`, `语言`. |
| `tidy` | Archives old work now. Also `整理`, `archive`. |
| `open` | Writes `progress.html` and opens it in the browser. Also `window`, `html`, `視窗`, `窗口`, `網頁`, `网页`. |
| `sync` | Reads Claude's Task list and the pull request again. Also `同步`. |
| `add …` | Adds a hand-kept task from a quick-add line, same as `+ …` in the pane's box. Also `加`, `新增`, `+`. |
| `report` | Copies the report for the last 7 days. Also `週報`, `周报`, `weekly`. |
| `today` | Copies the report for today. Also `今天`. |
| `notify`, `notify on`, `notify off` | Toggles or sets desktop notifications. Also `通知`, `notifications`, and `開`, `關`, `开`, `关` for on and off. |

### Conventions in the code

- **Pure modules.** Every `hooks/*.ts` file is pure: it takes data and returns data, never reads the clock or touches a file, and takes `now` as a parameter (`isStale(auto, now)`, `buildView(…, now)`). Results are new objects (`{ ...mirror, tasks, updated: now }`), not mutations. Keep it that way: new logic goes in a pure module and is unit-tested.
- **Every engine call lives in `hooks/register.tsx`.** Only `register.tsx` uses the engine (`$.fs`, `$.store`, `$.clock`, `$.env`, `$.process`, `$.ui`, `$.model`, `$.config`, `$.session`, `$.settings`, `$.command`, `$.tool`, `$.prompt`). `pane.tsx` imports engine types only; a press goes through an action that `register.tsx` supplies. Writes to `progress.md` go through the `enqueue` queue.
- **Do not break the format.** `parse.ts` (and `view.ts` and `ask.ts`, which read a task's notes) must keep reading every file that [docs/FORMAT.md](docs/FORMAT.md) calls valid. Change the spec and the code that reads it together.
- **Tests** are `tests/*.test.ts` and `tests/*.test.tsx`, using `test` and `expect` from `claude-code/testing`. A test name is a sentence about behaviour (`a quick add reads the project, the due date and the steps`). `CHANGELOG.md` entries cite the tests that cover them by name.
- **Comments say why**, not what. They sit above the code as `//` lines, in plain sentences. There is no JSDoc.
- **Style.** TypeScript with `strict` and `noUncheckedIndexedAccess` (see `tsconfig.json` and the generated base config), so an indexed read is `T | undefined`. No semicolons, single quotes, two-space indent, trailing commas. Named exports; no default exports. `type` aliases rather than interfaces (the module augmentation in `types/index.d.ts` is the one exception). Arrow functions assigned to `const`, not `function` declarations. Boolean names start with `is` or `has`. No dependencies: there is no `package.json`, and the only non-relative imports are `claude-code` and `claude-code/testing`.
- **The plugin API is early access.** `.claude-plugin/types/claude-code/index.d.ts` says it may change between releases. Read it before calling an engine method you have not seen used here.
- **Every user-visible string lives in the strings tables.** That covers the pane, the status line, notifications, the text the mod sends to Claude, and the words the mod writes into `progress.md` and its archive and journal. `ZH_TW` in `hooks/i18n.ts` is the reference and `Strings = typeof ZH_TW`; `EN` (`hooks/strings-en.ts`) and `ZH_CN` (`hooks/strings-zh-cn.ts`) are typed `Strings`, so a key missing from either is a type error. A new string goes into all three tables (en, zh-TW, zh-CN), in the same place in each. A pure function takes the table as a parameter (`s: Strings`, default `ZH_TW`) and `register.tsx` passes the session's (`wordsOf`); do not write words into other files.
- **How the language is chosen.** `register.tsx` settles it when a session starts and after `/progress lang …` (`settleLang`), by `resolveLang(option, stored, setting, env)` in `hooks/strings.ts`. The first of these that `langOf` reads as a supported language wins: the plugin's `language` option (`userConfig.language` in `plugin.json`: `auto`, `en`, `zh-TW`, `zh-CN`; `auto` is skipped), the choice `/progress lang` stored (`$.store` key `lang`), Claude Code's `language` setting (`$.settings.read()`), the `LANG` environment variable (`$.env.get('LANG')`), else `en`.
- **Keywords are read in every language.** The file format has literal keywords in Chinese and English (`截止` / `due`, `背景` / `Context` / `Background`), and the readers accept all of them whatever language the pane speaks, so a file written in one language reads in another. [docs/FORMAT.md](docs/FORMAT.md) says where.

Release steps and the rules for changing the format are in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Report your progress to the progress pane

The user watches a progress pane fed by `~/.claude/progress.md` (Windows: `%USERPROFILE%\.claude\progress.md`; the file named by `$CLAUDE_PROGRESS_FILE` if set, else `progress.md` in `$CLAUDE_CONFIG_DIR` if set). For work with two or more steps, keep one block of your own in it. Format: https://github.com/WenyuChiou/agent-board/blob/main/docs/FORMAT.md

```markdown
<!-- auto session=ID agent=NAME state=working updated=2026-01-31T09:30:00Z -->
### The outcome, in plain words
> Context: one line on why this work exists
- [x] A finished step
- [~] The step you are on
- [?] A step that needs the user — one line they can follow without reading the chat
- [ ] The next step
<!-- /auto session=ID -->
```

- Put the block under `## <repository name>` (add that heading at the end of the file if it is missing). `ID` is 8 random hex characters, chosen once per session. `NAME` is your own name in lower case (`codex`, `gemini`, `cursor`, `aider`). The `###` title is yours to word: the outcome, in plain words. Keep the `Context:` label as written; other `>` lines are allowed, and the pane shows the `Context:` one. Start the markers at the beginning of the line.
- After each step: read the file again, replace only your block, update the step's mark and `updated=` (UTC, ending in `Z`), write the file.
- Marks: `[x]` done, `[~]` doing, `[ ]` todo, `[?]` needs the user, `[>]` running or waiting on someone else, `[!]` blocked, `[-]` cancelled.
- When you need the user, mark the step `[?]` and add ` — ` and one line: what you need and why. Word it so the pane can tell what is asked: end a yes/no question with `OK?` (`Deploy it to staging, OK?`); write a choice as two short options and a question mark (`24 hours or 7 days?`); put a command, and only a command, in backticks; give a link as a full `https://` URL; start a wait with `waiting for` (`waiting for Prof. Lee to reply`).
- Never edit, move or delete anything outside your own markers, above all another agent's block.
- Before you end a reply with steps left, set `state=waiting`. Set `state=working` when you start again.
- When every step is done, set `state=done`. If you stop for good with steps left, set `state=ended`.

# AGENTS.md

This repository is `project-progress`, a Claude Code plugin (a "mod") that draws a side pane of every project's work from one Markdown file, `~/.claude/progress.md`. The file format is specified in [docs/FORMAT.md](docs/FORMAT.md).

This file has two parts:

1. [Working on this repository](#working-on-this-repository): for an agent that changes this code.
2. [Report your progress to the progress pane](#report-your-progress-to-the-progress-pane): the last section of this file. Copy it, from its heading to the end of the file, into the `AGENTS.md`, `GEMINI.md` or `.cursorrules` of any project, and a non-Claude agent working there shows its work on the pane. An agent working on this repository may follow it too.

## Working on this repository

### Checks

Run these from the repository root. Claude Code 2.1.287 or newer is needed.

```
claude --plugin-dir .      # runs this copy of the mod; also writes .claude-plugin/types/
claude plugin validate .   # validates the plugin
claude plugin test .       # runs tests/*.test.ts and tests/*.test.tsx
tsc -p .                   # type check; needs .claude-plugin/types/ from the first command
```

`.claude-plugin/types/` is written by Claude Code every time it loads the mod from a folder. It is gitignored. Do not edit it. If `tsc -p .` complains about missing files or modules, run `claude --plugin-dir .` once.

If you cannot run `claude` in your environment, say so in your report. Do not claim the checks passed.

### Layout

| Path | What it holds |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest and version. |
| `.claude-plugin/marketplace.json` | Marketplace listing. |
| `hooks/hooks.json` | Lists the one module the engine loads, `./register.tsx`. |
| `hooks/register.tsx` | Wires everything to the engine: Task-call hooks, turn start and end, compaction, the system prompt, session end, the pane, the `/progress` command, the 2-second poll, the PR check, archiving, journal writes. |
| `hooks/pane.tsx` | Draws the pane from a view and a set of actions. |
| `hooks/parse.ts` | Reads `progress.md` into projects, tasks and steps; auto-marker attributes, staleness, due dates, project matching. |
| `hooks/blocks.ts` | Writes, removes and extracts a session's block; picks what to archive; adds a quick-add task; ticks a hand-kept step. |
| `hooks/mirror.ts` | Mirrors Claude's Task list (TaskCreate, TaskUpdate, TodoWrite) and its `metadata`; words the compaction note; titles and notices. |
| `hooks/ask.ts` | Works out what a `[?]` step asks of the person, from explicit metadata or from its words. |
| `hooks/view.ts` | Turns the parsed file and this session's list into what the pane and the status line show. |
| `hooks/journal.ts` | Journal line format, month file names, and the report text. |
| `hooks/github.ts` | Reads `gh pr view` JSON into PR and CI state, and the words for them. |
| `hooks/quick.ts` | Reads a quick-add line (`+ project: title due 11-20; step; step`). |
| `hooks/palette.ts` | The dark and light colour sets and the tone-to-colour maps. |
| `hooks/rule.ts` | The rule added to Claude's system prompt. `scripts/claude-md-rule.md` is the same rule for `-KeepRule` installs: change both. |
| `types/index.d.ts` | Shared types and the plugin's state. |
| `tests/` | `parse.test.ts` (parser), `logic.test.ts` (blocks, mirror, view logic), `features.test.ts` (later features through the pure modules), `pane.test.tsx` (the mod and the pane against a mock engine). |
| `scripts/` | `setup.sh`, `setup.ps1` and the rule text. |
| `docs/` | `FORMAT.md`, the format spec. `docs/images/` holds screenshots; they are generated, so do not edit them by hand. |

### Conventions in the code

- **Pure modules.** Every `hooks/*.ts` file is pure: it takes data and returns data, never reads the clock or touches a file, and takes `now` as a parameter (`isStale(auto, now)`, `buildView(…, now)`). Results are new objects (`{ ...mirror, tasks, updated: now }`), not mutations. Keep it that way: new logic goes in a pure module and is unit-tested.
- **Every engine call lives in `hooks/register.tsx`.** Only `register.tsx` uses the engine (`$.fs`, `$.store`, `$.clock`, `$.env`, `$.process`, `$.ui`, `$.model`, `$.config`, `$.session`). `pane.tsx` imports engine types only; a press goes through an action that `register.tsx` supplies. Writes to `progress.md` go through the `enqueue` queue.
- **Do not break the format.** `parse.ts` must keep reading every file that [docs/FORMAT.md](docs/FORMAT.md) calls valid. Change the spec and the parser together.
- **Tests** are `tests/*.test.ts` and `tests/*.test.tsx`, using `test` and `expect` from `claude-code/testing`. A test name is a sentence about behaviour (`a quick add reads the project, the due date and the steps`). `CHANGELOG.md` entries cite the tests that cover them by name.
- **Comments say why**, not what. They sit above the code as `//` lines, in plain sentences. There is no JSDoc.
- **Style.** TypeScript with `strict` and `noUncheckedIndexedAccess` (see `tsconfig.json` and the generated base config), so an indexed read is `T | undefined`. No semicolons, single quotes, two-space indent, trailing commas. Named exports; no default exports. `type` aliases rather than interfaces (the module augmentation in `types/index.d.ts` is the one exception). Arrow functions assigned to `const`, not `function` declarations. Boolean names start with `is` or `has`. No dependencies: there is no `package.json`, and the only non-relative imports are `claude-code` and `claude-code/testing`.
- **The plugin API is early access.** `.claude-plugin/types/claude-code/index.d.ts` says it may change between releases. Read it before calling an engine method you have not seen used here.
- **Strings the pane shows, and the status words the mod writes into the file, are Chinese.** New ones follow suit unless the maintainer says otherwise. The file format has a few literal Chinese keywords (`截止`, `背景：`); [docs/FORMAT.md](docs/FORMAT.md) says where.

Release steps and the rules for changing the format are in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Report your progress to the progress pane

The user watches a progress pane fed by `~/.claude/progress.md` (Windows: `%USERPROFILE%\.claude\progress.md`; the file named by `$CLAUDE_PROGRESS_FILE` if set). For work with two or more steps, keep one block of your own in it. Format: https://github.com/WenyuChiou/claude-progress-pane/blob/main/docs/FORMAT.md

```markdown
<!-- auto session=ID agent=NAME state=working updated=2026-01-31T09:30:00Z -->
### The outcome, in plain words
> 背景：one line on why this work exists
- [x] A finished step
- [~] The step you are on
- [?] A step that needs the user — one line they can follow without reading the chat
- [ ] The next step
<!-- /auto session=ID -->
```

- Put the block under `## <repository name>` (add that heading at the end of the file if it is missing). `ID` is 8 random hex characters, chosen once per session. `NAME` is your own name in lower case (`codex`, `gemini`, `cursor`, `aider`). Keep `背景：` as written.
- After each step: read the file again, replace only your block, update the step's mark and `updated=` (UTC, ending in `Z`), write the file.
- Marks: `[x]` done, `[~]` doing, `[ ]` todo, `[?]` needs the user, `[>]` running or waiting on someone else, `[!]` blocked, `[-]` cancelled.
- When you need the user, mark the step `[?]` and add ` — ` and one line: what you need and why.
- Never edit, move or delete anything outside your own markers, above all another agent's block.
- Before you end a reply with steps left, set `state=waiting`. Set `state=working` when you start again.
- When every step is done, set `state=done`. If you stop for good with steps left, set `state=ended`.

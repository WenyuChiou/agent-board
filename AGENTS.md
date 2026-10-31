# AGENTS.md

Agent Board is a local interactive board with independent agent reporters and an optional Claude Code pane. Start from any agent with `node scripts/setup-agent.mjs` (preview) and `--apply` (reviewed scope), or the same from npm: `npx @wenyuchiou/agent-board setup` and `npx @wenyuchiou/agent-board setup --apply`. Fresh independent setups use `~/.agent-board/progress.md`; existing installations keep their selected path. See [common setup](docs/SETUP.md) and [file format](docs/FORMAT.md).

This file has two parts:

1. [Working on this repository](#working-on-this-repository): for an agent that changes this code.
2. [Report your progress to the progress pane](#report-your-progress-to-the-progress-pane): the last section of this file. Copy it, from its heading to the end of the file, into the `AGENTS.md`, `GEMINI.md` or `.cursorrules` of any project, and a non-Claude agent working there shows its work on the pane. `scripts/setup.sh --agents` (PowerShell: `setup.ps1 -Agents auto`) does that for Codex, legacy Gemini CLI and OpenCode, in their global instructions. Prefer the independent common installer for current local setup. An agent working on this repository may follow it too.

## Working on this repository

Before you open a pull request, read [CONTRIBUTING.md, Pull requests](CONTRIBUTING.md#pull-requests) (the rules every agent follows: one feature or up to three bug fixes per pull request, claiming for contributors outside the team, the `Author:` line, the CHANGELOG entry, who merges) and [docs/CONTRIBUTOR-PATH.md](docs/CONTRIBUTOR-PATH.md) (the same steps with the commands, for an agent on another computer with only git, gh and Node). [docs/dev/team-process.md](docs/dev/team-process.md) says how much you take on at once, when a finding becomes an issue, and how review and merging go. With write access you may also review and merge pull requests you did not write: [docs/CONTRIBUTOR-PATH.md, step 11](docs/CONTRIBUTOR-PATH.md#11-review-and-merge-someone-elses-pull-request). Ask questions on the issue, starting `Question:`; answers come there.

### Checks

Run checks from the repository root. Independent setup/development needs Node, not Claude Code. Optional plugin checks use Claude Code 2.1.301 in CI, pinned in `.github/workflows/test.yml`; validate/test are offline. Full plugin typechecking needs its generated SDK and must be reported unrun when unavailable.

```
claude --plugin-dir .                  # runs this copy of the mod; also writes .claude-plugin/types/
claude plugin validate --strict .      # validates the plugin and the marketplace; CI uses --strict
claude plugin test .                   # runs tests/*.test.ts and tests/*.test.tsx
tsc -p .                               # type check; needs .claude-plugin/types/ from the first command
bash tests/setup.check.sh              # installer checks for scripts/setup.sh (CI: Linux); needs bash and python3
powershell -NoProfile -ExecutionPolicy Bypass -File tests/setup.check.ps1   # installer checks for scripts/setup.ps1 (CI: Windows)
node --test tests/exchange.test.mjs tests/messaging.test.mjs tests/pr-check.test.mjs tests/preflight.test.mjs tests/changelog-fold.test.mjs tests/team-stats.test.mjs   # exchange, connected-session API, PR check, preflight, CHANGELOG fold, team stats; plain Node, no model calls
python3 -B scripts/remote-reporter/test_pipeline.py   # remote reporter tests; stdlib Python, runs in a temp folder
node --test tests/board.test.mjs tests/board-storage.test.mjs tests/codex-local.test.mjs tests/local-lock.test.mjs tests/prompt-hooks.test.mjs tests/codex-host.test.mjs tests/codex-fallback.test.mjs tests/legacy-connect.test.mjs tests/connect-worker.test.mjs   # the board script and local setup on plain Node, as CI runs them
node --test tests/npm-package.test.mjs   # the npm package: what npm pack would publish, and the launcher in a scratch home; needs npm
npx --yes bun@1.4.2 scripts/build-board.ts --check     # hooks/board-script.ts matches its sources (CI pins Bun 1.4.2)
npx --yes bun@1.4.2 scripts/build-released.ts --check  # hooks/released.ts and tests/fixtures/released.ts match the release tags (git fetch --tags first)
node scripts/pr-check.mjs --pr <N>     # what a pull request still lacks (CONTRIBUTING.md, Pull requests)
node scripts/preflight.mjs             # before Ready: whether main is merged (a warning only), touched tests, string tables, language copies, bundle sources, CHANGELOG fragment and test titles, and more; add --body-file <f> --title <t> to include pr-check
```

`claude plugin test` does not run `tests/exchange.test.mjs`, nor the two installer checks. The exchange tests run the `scripts/exchange*` files under plain Node; run them when you change those scripts, `scripts/exchange-contract.ts` or a `hooks/` file they import. The installer checks run `scripts/setup.sh` or `scripts/setup.ps1` against temp folders and never touch your own `~/.claude` or shell profile. Run the one that matches the script you changed.

CI (`.github/workflows/test.yml`) plans affected checks from changed paths and the union of base/head dependencies on every pull-request push and every push to `main`, with the same rule for Draft and Ready. On a pull request, selected Node checks run Node 22 on Ubuntu and Node 24 on Windows and plugin checks run on Ubuntu only; pushes to `main`, the weekly schedule, a manual run and release PRs run Node 22 and 24 on both systems. Plugin, legacy installer, remote reporter and Chromium checks run only for affected groups. The always-run impact and CI validation jobs require every selected group to succeed; an unaffected skipped group is reported as not run. Changes to manifests, governance or the selector, unclassified paths, release PRs, the weekly schedule and an explicit full dispatch select every group. The first selector rollout also runs every group. `.github/workflows/pr-check.yml` still runs its checker from the base on every pull request. See [affected CI](docs/dev/CI.md). CI does not run full `tsc -p .`; report it separately.

On your own computer, run only the test files your change touches, and only one test run at a time. Never run full suites, long soak runs, mutation sweeps or the L5 busy-machine test (it keeps up to three CPUs busy) there. The exception is `claude plugin test .`, which runs every `tests/*.test.ts` and `tests/*.test.tsx` file: when your change touches one of those files, run it once, alone, before Ready. CI runs affected groups; the busy-machine journey runs when its group is selected, and `.github/workflows/soak.yml` runs the soak weekly and on demand. The busy-machine test skips itself unless `CI` is set or `AGENT_BOARD_HEAVY_TESTS=1`.

`.claude-plugin/types/` is written by Claude Code every time it loads the mod from a folder. It is gitignored. Do not edit it. If `tsc -p .` complains about missing files or modules, run `claude --plugin-dir .` once.

If you cannot run `claude` in your environment, say so in your report. Do not claim the checks passed.

### Layout

| Path | What it holds |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest and version. |
| `.claude-plugin/marketplace.json` | Marketplace listing. |
| `package.json` | The npm package `@wenyuchiou/agent-board` (its command is `agent-board`): its version (always the one in `plugin.json`), `bin` and `files` list. No dependencies and no scripts, so installing it runs nothing. `tests/npm-package.test.mjs` checks what `npm pack` would publish. |
| `bin/agent-board.mjs` | The npm command. `agent-board setup` runs `scripts/setup-agent.mjs` from the package; every other call runs the board script already installed for the account (`~/.agent-board/agent-board.mjs`, or the plugin's beside `progress.md`), never the package's own copy, and says on stderr when that copy is from another release. |
| `hooks/hooks.json` | Lists the one module the engine loads, `./register.tsx`. |
| `hooks/local-agents.ts`, `hooks/portable-agents.ts` | Independent metadata adapters and generated OpenCode/OpenClaw/DeepSeek plugins; no private conversation reads or automatic receiving transports. |
| `hooks/register.tsx` | Wires everything to the engine: Task-call hooks, turn start and end, compaction, the system prompt, session end, the pane, the `/progress` command, settling the language, the 2-second poll, the 5-second look at the inbox of other agents' turns, summing turns up with Haiku, `/progress connect` (also run at each session start, for agents not hooked in yet; it also writes the board script and each agent's board command), the PR check, archiving, reminders, journal writes, and writing `progress.html`. It also works out where `progress.md` is: `CLAUDE_PROGRESS_FILE`, else `progress.md` in `CLAUDE_CONFIG_DIR`, else `~/.claude/progress.md`. |
| `hooks/pane.tsx` | Draws the pane from a view and a set of actions. |
| `hooks/parse.ts` | Reads `progress.md` into projects, tasks and steps; auto-marker attributes, staleness, due dates, project matching. `readable` says which lines the format reads (not in a code fence or a comment); `blocks.ts` uses it too, so the writer never touches a block the parser skips. |
| `hooks/blocks.ts` | Writes, removes and extracts a session's block; picks what to archive; adds a quick-add task; ticks a hand-kept step; merges a block pasted from a web chat (`mergeBlock`), checked as `validate.py --block` checks one. |
| `hooks/runs.ts` | Pure: folds the runs an agent started for itself into their parent's row or the Background runs line, keeps the newer of two blocks for one agent and session id, and reads what a host says about who started a session (Codex's first history record, Claude's print mode). |
| `hooks/mirror.ts` | Mirrors Claude's Task list (TaskCreate, TaskUpdate, TodoWrite) and its `metadata`; words the compaction note; titles and notices. |
| `hooks/ask.ts` | Works out what a `[?]` step asks of the person, from explicit metadata or from its words. |
| `hooks/view.ts` | Turns the parsed file and this session's list into what the pane, the status line and `progress.html` show; also reads a task's background line. |
| `hooks/digest.ts` | Sums a turn up into steps for a session with no Task list (`parseDigest`, `applyDigest`), finds the question a reply ends on (`lastQuestion`, `markAsked`), tells work from a plain answer (`turnTools`, `isWork`), and cleans the compaction's handoff line. |
| `hooks/inbox.ts` | Reads what another agent's turn-end hook left in `progress-inbox/` (`readTurn`): each agent's field names, Grok Build running Cursor's hooks, Cursor's byte-order mark; the stable 8-hex block id per agent session; the tail of a session log; which turns of a burst the model sums up (`turnsToDigest`), how much of a turn the store keeps, the record of taken files (`keepInboxDone`) and the name a session renames a file to when it takes it (`takenName`). |
| `hooks/connect.ts` | What `/progress connect` writes: the reporter script (sh and PowerShell), each agent's hook in the shape its config reads (`agentHooks`), merging into and out of a config without touching the person's own hooks (JSON, and Hermes Agent's YAML line by line), the OpenCode plugin, the OpenClaw plugin with the `openclaw.json` entry that loads it, and each agent's board command (`boardCommands`) and the board script with its file and language (`boardScript`), and the language a board script already holds (`boardLangOf`); whether the computer is Windows (`isWindowsHost`). |
| `hooks/released.ts` | Generated: for each tagged release, the SHA-256 of the board script, the skills, the Gemini and OpenCode commands and the reporters it wrote, so `/progress connect` knows a file an earlier release wrote as its own and updates it (`isReleased` in `connect.ts`), while a file the person changed is left alone. Rebuild with `npx --yes bun@1.4.2 scripts/build-released.ts` at each release; CI checks it is current. Do not edit it. |
| `hooks/sha256.ts` | SHA-256 of a string, pure and with no dependency, to compare a file with `hooks/released.ts`. |
| `hooks/board-commands.ts` | Literal-path Node commands and their Gemini TOML/OpenCode Markdown wrappers, shared by every legacy board command and skill. Plain Node shell regressions exercise them without starting an AI host. |
| `hooks/board.ts` | The board as plain text for other agents and terminals (`boardText`), a read-only look at the inbox (`peekInbox`) that leaves a turn that only showed the board out, and the board you work in: its lines (`boardItems`), what a key does (`boardKey`, `pinned`), each line's fingerprint (`fingerprint`: its block, or for a hand-kept task how many share its project and title, and the words it shows; the terminal board keeps it from its last draw and the page sends it back with a press, so a tick, an archive or a reply acts only on the line the person saw) and its screen (`boardScreen`). For `--chat`, the board as plain text for a chat app (`chatText`: questions first, one line per task, capped near 3,500 characters) and `redact`, which hides the home folder and known credential forms in everything it prints; `peekInbox` takes a `scrub` so a question is redacted before it is picked and cut. |
| `hooks/serve.ts` | The board's page for `agent-board.mjs --serve`: what it shows (`serveModel`), how exact live sessions receive replies and how explicit `--allow-resume` gates legacy Codex/Grok launches, what a press does (`serveAction`, worked out again from the file), which requests the server refuses (`requestProblem`: host, token, origin, JSON), and the page with its own script (`servePage`, `pagePolicy`). With `isLan`, the same for the page a phone opens on the local network: a reply that would run an agent is a copy box and refused if sent, and the resume command is left out. `lanAddress` picks the computer's private network address. |
| `hooks/qr.ts` | A QR code with no dependency, for the page's network address (`qrModules`: byte mode, level M, versions 1 to 10), and as text for a terminal, two rows to a line (`qrText`). |
| `hooks/board-script.ts` | Generated: `BOARD_SCRIPT`, the bundle of `scripts/board-cli.ts` that `/progress connect` writes beside `progress.md` as `agent-board.mjs`. Rebuild with `npx --yes bun@1.4.2 scripts/build-board.ts` after changing `board-cli.ts` or a module it imports; CI checks it is current. Do not edit it. |
| `hooks/remind.ts` | Which reminders are due: another session's question once, work due today or late once a day. |
| `hooks/journal.ts` | Journal line format, month file names (`journalPath`, `archivePath`), and the report text. |
| `hooks/github.ts` | Reads `gh pr view` JSON into PR and CI state, and the words for them. |
| `hooks/quick.ts` | Reads a quick-add line (`+ project: title due 11-20; step; step`). |
| `hooks/palette.ts` | The dark and light colour sets and the tone-to-colour maps. |
| `hooks/rule.ts` | The rule added to Claude's system prompt, in each language (`RULES`). `scripts/claude-md-rule.md` is the Traditional Chinese rule for `--keep-rule` / `-KeepRule` installs, written in the first person: when you change the rule, change it too. |
| `hooks/i18n.ts` | `ZH_TW`, the reference table of every word the person reads or the mod writes into a file; `Strings = typeof ZH_TW`; `Lang` and `LANGS`. |
| `hooks/strings-en.ts`, `hooks/strings-zh-cn.ts` | `EN` and `ZH_CN`: the same table in English and Simplified Chinese, typed `Strings`. |
| `hooks/strings.ts` | `STRINGS` (the three tables by language), `langOf` (reads a language name), `chosenLang` (the language the person picked: the plugin's option, else `/progress lang`) and `resolveLang` (which language wins). |
| `hooks/dashboard.ts` | Builds `progress.html` from a view: a standalone page that reloads itself every 30 seconds. `register.tsx` writes it beside `progress.md` (same name, `.html`), after it reads a changed file and on its 30-second tick, at most once a minute and only when the page changed; `/progress open` writes it at once and opens it in the browser. |
| `types/index.d.ts` | Shared types and the plugin's state. |
| `tests/` | `parse.test.ts` (parser), `logic.test.ts` (blocks, mirror, view logic), `features.test.ts` (later features through the pure modules: ask kinds, journal, PR and CI, quick add, palette, languages, `progress.html`), `pane.test.tsx` (the mod and the pane against a mock engine). `setup.check.sh` and `setup.check.ps1` are the installer checks; `claude plugin test` does not run them. `fixtures/released.ts` is generated by `scripts/build-released.ts`; do not edit it. |
| `scripts/` | `setup.sh`, `setup.ps1` and the rule text. With `--agents` / `-Agents`, the setup scripts copy the last section of this file into the global instructions of Codex, Gemini CLI and OpenCode, between `<!-- agent-board:start -->` and `<!-- agent-board:end -->` (a section under the old `claude-progress-pane` markers is found and replaced too); keep that section's heading as it is, since they find it by that heading. |
| `scripts/check-host-contracts.mjs` | Optional packaged OpenCode SDK and DeepSeek Cordis/Loader check against an explicitly disposable dependency prefix. See `docs/validation/2026-10-19-portable-hosts.md`; it invokes no model or full AI application. |
| `scripts/board-cli.ts`, `scripts/build-board.ts` | The board script's entry point (prints the board, `--watch` with keys on a terminal, `--keys` to play keys without one, `--html`, `--lang`, `--serve` to print the board and the address of its page, started in the background or brought back through an address file in a folder only the account can use (on Windows, an account-only ACL-protected `agent-board` child of `XDG_RUNTIME_DIR`, else `~/.cache/agent-board`; on other systems, `XDG_RUNTIME_DIR` when it is the account's own, else `~/.cache/agent-board`), named for the `progress.md` it serves, with `--no-open`, `--port` and `--lan [address]`, which also prints the page's network address with a QR code; `--chat` for an agent that answers in a chat app, which prints redacted plain text with no link, and serves, opens and writes nothing; its writes go through a temp file per process, read back and retried) and the Bun bundler that turns it into `hooks/board-script.ts` (`--check` fails when that is stale). |
| `scripts/board-serve.ts` | The page's server (`startServer`): 127.0.0.1 with a random token in the address, the routes, opt-in idle exit (disabled by default), live message routing, plus opt-in legacy Grok/Codex resume only, one at a time per session. `POST /api/lan`, from the board script on the computer only, opens a second listener on the computer's private network address with its own token, answering only its own `ip:port` and closing after 10 minutes without a request from the network, or with the server. `AGENT_BOARD_GROK` or `AGENT_BOARD_CODEX` names a program to run in the agent's place (the tests' stand-in). |
| `scripts/pr-check.mjs` | Checks a pull request against CONTRIBUTING.md, Pull requests: the `Fixes`/`Part of` and `Author:` lines, the template sections, the CHANGELOG entry and that its test titles exist, the board bundle (on your computer; in CI, `test.yml` checks it), and private data (session ids, home-folder paths, token links) in added docs, pictures and the body. For a pull request from outside the team it also checks the claim and the open pull request caps; the team has no claim and no cap. Each failure says how to fix it. Plain Node; reads the pull request through `gh` or, in CI, the event file and `GITHUB_TOKEN`. |
| `scripts/preflight.mjs`, `docs/dev/brief-rules.md` | Checks a branch before its pull request is Ready and prints PASS, WARN and FAIL lines to paste under Checks; the checklist every Codex brief and for-dot issue includes. Plain Node. |
| `changelog.d/`, `scripts/changelog-fold.mjs` | One CHANGELOG fragment per fix or feature pull request (format in `changelog.d/README.md`: `**area / topic** · ` what changed for the person, then a `Tests:` line); the release pull request folds them into `CHANGELOG.md` with `changelog-fold.mjs`, which leaves the `Tests:` lines out. |
| `scripts/build-released.ts` | Writes `hooks/released.ts` from the `agent-board--v*` tags, and `tests/fixtures/released.ts`, what 0.20.5 and 0.18.1 wrote, for the upgrade tests. Run it with Bun at each release, after raising the version; `--check` fails when either file is out of date. |
| `scripts/exchange.mjs` | The opt-in local exchange CLI (`init`, `report`, `enqueue`, `take`, `ack`, `status`) for Codex and dot: a report fragment for the remote reporter merge script, a message queue and receipts in one folder. No hook loads it. See `docs/LOCAL-EXCHANGE.md`. |
| `scripts/codex-owner.mjs` | `dispatchCodex`: delivers one queued command to a running Codex thread through an owner connection the host supplies and verifies (`turn/steer` on an active turn only). |
| `scripts/codex-history.ts` | Reads the first record of a Codex history file and performs a bounded lookup of a session's file, used by the hook and the board script's tidy. |
| `scripts/exchange-contract.ts` | The exchange's pure contract: reads bindings, commands and receipts, writes the report block, plans the Codex request. Imported by the two scripts with explicit `.ts` extensions; it may import only `hooks/` files whose own run-time imports carry extensions. |
| `.github/workflows/test.yml`, `.github/workflows/pr-check.yml` | CI selects affected groups from base/head dependencies and validates actual results; a pull request runs each Node line and each system once, and `main`, the weekly run and release PRs run every pair. The PR check uses the base copy of `scripts/pr-check.mjs`. No full `tsc -p .`. |
| `docs/` | `SETUP.md`, `MESSAGING.md`, the guides and `FORMAT.md`. `CONTRIBUTOR-PATH.md` walks an agent from an issue to a merged pull request. The READMEs' pictures are SVGs drawn from synthetic data by `docs/preview/` (rules in CONTRIBUTING.md §Images); the guides have no gallery. `docs/images/` retains historical generated images, drawn from sample data by `docs/preview/` (`render.ts` lays `drawPane`'s tree out as a terminal grid and writes SVG: the tour `tour-<lang>.svg`, how it works `flow-<lang>.svg`, the terminal boards `board/<agent>-<lang>-<theme>.svg`, the promotional card `promo-<lang>.svg` and the agent icons from `icons.ts`, all in one brand look; `png.mjs` turns the promotional cards into `social-preview*.png`); do not edit them by hand. `docs/images/live/` retains earlier mock-model agent screenshots, not new native-delivery evidence. |
| `docs/LOCAL-EXCHANGE.md` | How to use the local exchange, what it guarantees and what it does not. |
| `scripts/remote-reporter/` | Stdlib Python for remote reporters: `reporter.py` builds an agent's block fragment (registry and outbox in `$AGENT_BOARD_REMOTE_DIR`, else `$CLAUDE_CONFIG_DIR/remote-reporter/`, else `~/.claude/remote-reporter/`), `merge.py` merges fragments into `progress.md` (without `resume=` or `dir=`, which only this machine writes), `validate.py` scans a file the way `hooks/parse.ts` does, `test_pipeline.py` tests them. Keep the scanner in step with `parse.ts`. |
| `docs/REMOTE_REPORTERS.md` | How an agent that does not run on the board's machine reports: the fragment and merge step, transports, and what has no inward channel. |
| `.github/` | CI, the issue forms and the pull request template. `SECURITY.md` and `CODE_OF_CONDUCT.md` are at the root. |

`/progress` (the `command.run` handler in `register.tsx`) takes these arguments; the Chinese and alternative names are listed beside each. With no argument, or one it does not know, it opens the pane.

| Argument | Does |
|---|---|
| `lang en`, `lang zh-TW`, `lang zh-CN`, `lang auto` | Stores the pane language (`auto` removes the stored choice) and applies it at once. Also `language`, `語言`, `语言`. |
| `tidy` | Archives finished work now, without the half-day wait (`archiveOld($, true)`); a stopped session still gets its three days. Also `整理`, `archive`. |
| `open` | Writes `progress.html` and opens it in the browser. Also `window`, `html`, `視窗`, `窗口`, `網頁`, `网页`. |
| `sync` | Reads Claude's Task list and the pull request again. Also `同步`. |
| `connect`, `connect status`, `connect remove` | Connects the other agents now (each session start also does, unless the `autoConnect` option is off) and says what changed. `status` lists what the last connect found, agent by agent, without changing host configuration; first use may migrate recognized setup metadata. `remove` (also `off`) takes the hooks out and stops sessions from putting them back until the next `connect`. Also `接上`, `連接`, `连接`; `狀態`, `状态` for status; `拿掉`, `去掉`, `移除` for remove. |
| `add …` | Adds a hand-kept task from a quick-add line, same as `+ …` in the pane's box. Also `加`, `新增`, `+`. |
| `report` | Copies the report for the last 7 days. Also `週報`, `周报`, `weekly`. |
| `today` | Copies the report for today. Also `今天`. |
| `notify`, `notify on`, `notify off` | Toggles or sets desktop notifications. Also `通知`, `notifications`, and `開`, `關`, `开`, `关` for on and off. |

### Review guidelines

For any reviewer of a pull request here, Codex review and Greptile included:

- Mark a finding P0 or P1 only when it is wrong or broken behaviour, an error swallowed or reported as success, data lost from `progress.md`, its archive or a person's config, a leaked token, session id or home-folder path, an unmet requirement of the linked issue or a rule in [CONTRIBUTING.md](CONTRIBUTING.md#pull-requests), or a behaviour change with no test.
- Everything else is a note: at most three lines, at the end of the review.
- A user-visible string must be in all three tables: `hooks/i18n.ts`, `hooks/strings-en.ts` and `hooks/strings-zh-cn.ts`.
- `hooks/board-script.ts`, `hooks/released.ts` and `tests/fixtures/released.ts` are generated: flag a hand edit, not their contents.
- Tests, docs and pictures use synthetic data only.
- Do not repeat a finding that is already resolved. If an answer does not resolve a P0 or P1 finding, say so in the same thread, so the reviewer sees it before approving.

### Conventions in the code

- **Pure modules.** Every `hooks/*.ts` file is pure: it takes data and returns data, never reads the clock or touches a file, and takes `now` as a parameter (`isStale(auto, now)`, `buildView(…, now)`). Results are new objects (`{ ...mirror, tasks, updated: now }`), not mutations. Keep it that way: new logic goes in a pure module and is unit-tested.
- **Every engine call lives in `hooks/register.tsx`.** Only `register.tsx` uses the engine (`$.fs`, `$.store`, `$.clock`, `$.env`, `$.process`, `$.ui`, `$.model`, `$.config`, `$.session`, `$.settings`, `$.command`, `$.tool`, `$.prompt`). `pane.tsx` imports engine types only; a press goes through an action that `register.tsx` supplies. Writes to `progress.md` go through the `enqueue` queue, and through `rewrite`, which reads the file back and makes the change again when another session's write undid it.
- **Do not break the format.** `parse.ts` (and `view.ts` and `ask.ts`, which read a task's notes) must keep reading every file that [docs/FORMAT.md](docs/FORMAT.md) calls valid. Change the spec and the code that reads it together.
- **Tests** are `tests/*.test.ts` and `tests/*.test.tsx`, using `test` and `expect` from `claude-code/testing`. A test name is a sentence about behaviour (`a quick add reads the project, the due date and the steps`). A `changelog.d/` fragment cites the tests that cover it by name.
- **Comments say why**, not what. They sit above the code as `//` lines, in plain sentences. There is no JSDoc.
- **Style.** TypeScript with `strict` and `noUncheckedIndexedAccess` (see `tsconfig.json` and the generated base config), so an indexed read is `T | undefined`. No semicolons, single quotes, two-space indent, trailing commas. Named exports; no default exports. `type` aliases rather than interfaces (the module augmentation in `types/index.d.ts` is the one exception). Arrow functions assigned to `const`, not `function` declarations. Boolean names start with `is` or `has`. No dependencies: `package.json` exists only to publish the npm package and lists no dependencies and no `scripts`, and the only non-relative imports are `claude-code` and `claude-code/testing`.
- **The plugin API is early access.** `.claude-plugin/types/claude-code/index.d.ts` says it may change between releases. Read it before calling an engine method you have not seen used here.
- **Text from the file is data.** Words another session or agent wrote into `progress.md` reach Claude only through `asData` and `dataBlock` (`hooks/mirror.ts`): one clipped line each, inside a fence after the `dataNote` sentence. A reply quoted to the model goes between `<reply>` tags (`replyData`).
- **Every user-visible string lives in the strings tables.** That covers the pane, the status line, notifications, the text the mod sends to Claude, and the words the mod writes into `progress.md` and its archive and journal. `ZH_TW` in `hooks/i18n.ts` is the reference and `Strings = typeof ZH_TW`; `EN` (`hooks/strings-en.ts`) and `ZH_CN` (`hooks/strings-zh-cn.ts`) are typed `Strings`, so a key missing from either is a type error. A new string goes into all three tables (en, zh-TW, zh-CN), in the same place in each. A pure function takes the table as a parameter (`s: Strings`, default `ZH_TW`) and `register.tsx` passes the session's (`wordsOf`); do not write words into other files.
- **How the language is chosen.** `register.tsx` settles it when a session starts and after `/progress lang …` (`settleLang`), by `resolveLang(option, stored, setting, env)` in `hooks/strings.ts`. The first of these that `langOf` reads as a supported language wins: the plugin's `language` option (`userConfig.language` in `plugin.json`: `auto`, `en`, `zh-TW`, `zh-CN`; `auto` is skipped), the choice `/progress lang` stored (`$.store` key `lang`), Claude Code's `language` setting (`$.settings.read()`), the `LANG` environment variable (`$.env.get('LANG')`), else `en`. The board script and the board commands are one set of files for every session, so `connectAgents` writes them in `chosenLang(option, stored)` read at the connect itself, else the language `/progress lang` (`auto` included) last settled (the native worker’s canonical `boardLang`; the SDK key seeds first migration only), else the one the board script already holds (`boardLangOf`), else the session's.
- **Keywords are read in every language.** The file format has literal keywords in Chinese and English (`截止` / `due`, `背景` / `Context` / `Background`), and the readers accept all of them whatever language the pane speaks, so a file written in one language reads in another. [docs/FORMAT.md](docs/FORMAT.md) says where.

Release steps and the rules for changing the format are in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Report your progress to the progress pane

Use the installed reporter and its selected progress path. On a fresh independent setup this is `~/.agent-board/progress.md`; the optional Claude plugin defaults to `~/.claude/progress.md` and respects `$CLAUDE_PROGRESS_FILE` / `$CLAUDE_CONFIG_DIR`. For work with two or more steps, keep one block of your own. Native reporters bind the host-proven session id; do not replace it with a random id. The manual format below is for hosts without that adapter. Format: https://github.com/WenyuChiou/agent-board/blob/main/docs/FORMAT.md

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

- Put the block under `## <repository name>` (add that heading at the end of the file if it is missing). `ID` is 8 random hex characters, chosen once per session. `NAME` is your own name in lower case (`codex`, `antigravity`, `cursor`, `aider`). The `###` title is yours to word: the outcome, in plain words. Keep the `Context:` label as written; other `>` lines are allowed, and the pane shows the `Context:` one. Start the markers at the beginning of the line.
- After each step: read the file again, replace only your block, update the step's mark and `updated=` (UTC, ending in `Z`), write the file.
- Marks: `[x]` done, `[~]` doing, `[ ]` todo, `[?]` needs the user, `[>]` running or waiting on someone else, `[!]` blocked, `[-]` cancelled.
- When you need the user, mark the step `[?]` and add ` — ` and one line: what you need and why. Word it so the pane can tell what is asked: end a yes/no question with `OK?` (`Deploy it to staging, OK?`); write a choice as two short options and a question mark (`24 hours or 7 days?`); put a command, and only a command, in backticks; give a link as a full `https://` URL; start a wait with `waiting for` (`waiting for Prof. Lee to reply`).
- Never edit, move or delete anything outside your own markers, above all another agent's block.
- Before you end a reply with steps left, set `state=waiting`. Set `state=working` when you start again.
- When every step is done, set `state=done`. If you stop for good with steps left, set `state=ended`.
- After a confirmed handoff, mark only transferred steps `[-]` and name the recipient in the note. Set `state=done` when no work remains here. A sent message or proposed handoff does not prove transfer or authorize actions.

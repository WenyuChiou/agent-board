# Live parity checklist (every stable release)

CI tests the code. It cannot show what a person sees inside each agent's own app or CLI. Before every stable release, open each installed mainstream agent and check the board from inside it. The owner's rule: every mainstream agent must work, in its UI and in its CLI, and each is opened for real, with a screenshot of the CLI.

Write the result to `docs/validation/<date>-parity-<version>.md`, following `2026-10-20-parity-0.23.5.md`. No record, no claim: a surface without a row in that record ships as "untested" in the release notes. After an earlier record, a run may cover only what changed (see A run after a change).

## Rows

One row per surface. The UI and the CLI of one vendor are separate rows.

| Vendor | Surfaces |
|---|---|
| Anthropic | Claude Code CLI; Claude desktop app (Code tab); Claude Code IDE extension |
| OpenAI | Codex CLI; Codex desktop app; Codex IDE extension |
| Google | Antigravity app; `agy` CLI; Gemini CLI (retired upstream, so the row says so) |
| Cursor | Cursor IDE; `cursor-agent` CLI |
| Cognition | Devin Desktop (formerly Windsurf); Devin CLI |
| GitHub | VS Code with Copilot; Copilot CLI |
| Others | OpenCode; Grok Build; Hermes; OpenClaw; Muse / dot (cloud) |

Every surface in this table appears in the record:
- **Installed:** a row of its own.
- **Not installed, or not checked this time:** it may share one line, for example "Not installed, so untested: …".
- **No connector:** the row says what a user of that agent can do today, for example "opens the page; copy only". Agents whose connectors are planned are tracked in #278.

## Checks per row

| | Check | Pass when |
|---|---|---|
| a | Open the board from inside the agent (its skill, command or link) | The board or its link shows, with every agent's rows |
| b | One synthetic turn that reports two steps and ends on a question | The card is on the terminal board and the page within a few seconds |
| c | Answer that question from the page | The answer reaches the agent, or the card names the copy fallback |
| d | Archive, confirm done and hide its row, on the terminal and the page | Every press shows a result or a plain reason next to the card |
| e | Send a message from this agent to its own other session and to another agent | Delivered, or the card names the fallback |
| f | Default views | No session id, hash or file path on any default view |

Each cell is one of:
- **PASS**
- **FAIL**, with an issue number
- **untested**, with the reason
- **needs owner**, with the screen that stopped the check (sign-in, trust, consent, usage limit or config) and its words, with account names, emails and paths masked
- **via the page**: checks c and d run once on the shared page and terminal board, which get rows of their own; a host whose own turn did not reach the board is marked this way
- **n/a**, with the reason: the check cannot apply, for example the agent has no connector or its service has ended

A cell may add a short note, and a `*` that points to a sentence under the table. Also record the host version and quote any fallback or result text the screen shows.

## How to run it safely

- **Use the hooks as they are already connected.** Never run a connect, setup, install or remove against the real home. For each agent whose hooks it checks, the record names the Agent Board version those hooks run and how that was read; each must be the version being released. In a run after a change, this holds for the rows it runs; a carried row keeps the version its record named. The board's footer shows the board's version, not the hooks'.
- **Isolate any connect.** If a check needs one, or any `claude` run with this plugin loaded, point every one of these at a scratch folder: `HOME`, `USERPROFILE`, `HERMES_HOME`, `GROK_HOME`, `OPENCLAW_STATE_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `LOCALAPPDATA`, `APPDATA`, `CLAUDE_PROGRESS_FILE`, `CLAUDE_CONFIG_DIR`, `TEMP` and `TMP` (#212).
- **Work in a scratch project folder, with synthetic prompts only** ("Synthetic test: …"). Board checks c, d and f use a synthetic board through `CLAUDE_PROGRESS_FILE`.
- **Never open an existing conversation or project.** If an app opens on one, start a new chat in the scratch folder at once.
- **Screenshots:** at least one per surface, and one inside every CLI. Crop each to the scratch window, with no sidebar, history, account name or real path. Do not commit them. Keep them in a local folder, give the count in the record, and say in the PR body who holds them. Pictures in the repository follow CONTRIBUTING's image rules.
- **Approvals:** you may approve a one-time or this-session prompt to run the board's own command (plain `agent-board`, `--json`) in the scratch folder, never an "always allow". The one exception is the board's own hooks approval in the kept test home, pressed after a yes (below).
- **Sign-ins stay with the person whose computer runs the check:** never type a password, a sign-in code or a token, and never create an account. Record "needs owner" and the words on the screen, masked as above.
- **Some prompts the checker may press after a yes** (owner, 2026-11-03: 「理論上你要用computer use幫我做才對」). Press only after the person says yes in chat to that item, through computer use or the browser tools. The yes covers the items on this run's list and is given in this run. A blanket yes, or a yes from an earlier run, does not count.
  - a trust prompt for the scratch project folder;
  - a hooks approval for the board's own hooks in the kept test home, which stays approved there (the Approvals exception);
  - a consent or terms screen that an agent in this check shows in the kept test home or the scratch project folder;
  - the browser's Authorize button for a sign-in the person started, to an agent in this check.
- **Everything else stays with the person.** That covers:
  - any other consent, terms or Authorize screen;
  - a key that must be typed into a terminal or an IDE (computer use can only click there);
  - any prompt about something outside the scratch project folder, the kept test home or the board's own hooks.

  Record each of these as "needs owner".
- **The record names each prompt the checker pressed,** with the words on the screen (account names, emails and paths masked), and says it was pressed after the person's yes.
- **Spend paid quotas carefully:** at most two short turns per agent on a paid quota.
- **Clean up after yourself:** afterwards, stop only the processes you started.
- **Write down what the run left behind:** self-updates, history entries, private data that showed on screen or was sent to a model, rows on the real board, held inbox files, the clipboard and open tabs.

## The kept test home

Every isolated run (How to run it safely) uses one test home that is kept between releases on the computer that runs the check, so its one-time steps stay done (owner, 2026-11-03: 「在這樣測試以後每個版本都要嗎 這樣我還要操作太麻煩了」). Any computer with the apps installed may run the check (RULES R7). Each computer keeps its own test home, and the person whose computer it is does that home's one-time steps with their own accounts. Below, "the person" means them.

- **One folder, kept.** It sits outside every repository and outside the real home's config folders. Every variable in the isolation list points into it. The scratch project folder sits inside it too, because a trust is kept for that folder's path. Do not empty it or start a new one between runs.
- **The person's steps there are done once.** The person signs in to each agent in that home. The trust prompt for the scratch project folder and the board's hooks approvals are either done by the person or pressed by the checker after the person's yes (How to run it safely). Later runs reuse what is there. A step comes back only when its screen comes back, for example after an expired sign-in, or a hook approval after the release changed that hook.
- **Each run starts by installing the release in it.** Run setup with `--apply` against the test home, never the real one. Then read each host's hooks version there, as the first rule above asks.
- **Nothing comes in from the real home:** no credentials, config, history or `progress.md`.
- **Each check starts a new chat.** Earlier test chats build up in the kept home; none is reopened.
- **It holds the person's sign-ins, so it stays on that computer.** It never goes into a repository, an issue, a pull request, a log or a screenshot, and the record does not name its path ([RULES.md, R8](../dev/RULES.md#r8-what-stays-off-github)).
- **Replace it only on the person's word.** When the checker finds it broken, it says why and asks first. Move the old folder aside; do not delete it. A new home brings back the one-time steps.

The app rows run on the person's own install, which they keep on the release. Every other row runs in the kept test home.

## What the person does, all at once

- **Before the first check, one list.** The checker sends the person every screen it expects to need them. It writes in their language, in the chat where they talk with the checker, not on GitHub. That means each `needs owner` cell of the last record, plus any one-time step the kept home still lacks. Each item names the window, what to press and the words on the screen, with any account name or email masked. Each item also says who presses it: "I press it after your yes" for a prompt the checker may press (How to run it safely), or "you do it" for a sign-in or a key in a terminal. The checker then waits for one answer, which may say yes to each item it may press.
- **During the run, no questions.** A screen that needs the person makes its cell `needs owner`, and the checker goes on with the other cells. The checker presses a prompt during the run only if the person already said yes to that item.
- **At the end, one more list** of those screens. After the answer, the checker re-runs only those cells. A screen that appears in that re-run leaves its cell `needs owner` in this record and goes on the next run's first list.
- So a run asks at most twice, and not at all when the kept home already has everything it needs.

## A run after a change

A run may cover only what changed since the last parity record. The rows it does not cover keep their cells from that record. Such a run counts for a stable release as a full run does.

1. **The record's commit.** Each record names the commit its rows ran on. When a record names several, use the oldest. When it names none, use its release tag (`agent-board--v<version>`).
2. **Scope from the files.** Run `git diff --name-only <the record's commit>..<the release commit>`. The run covers what each changed file reaches in the table below. A file that matches two rows reaches both. Tests, CI files, `docs/` and the READMEs reach nothing. The generated `hooks/board-script*.ts` and `hooks/released.ts` reach what their changed sources reach. When one of them changes while none of its sources does, the run is a full run. So is a change to how they are built: `scripts/build-board.ts`, `scripts/build-released.ts` or the pinned Bun version.

   | Changed file | Rows and checks |
   |---|---|
   | One agent's own files: `hooks/receivers/hook-mailbox-<agent>.ts`, `scripts/<agent>-*`, and for Codex also `hooks/codex*.ts` and `scripts/setup-codex.mjs` | that agent's rows, every check |
   | `hooks/register.tsx`, `hooks/pane.tsx`, `hooks/hooks.json`, `.claude-plugin/` | the three Anthropic rows, every check |
   | `hooks/connect*.ts`, `hooks/hook-*.ts`, `hooks/local-agents.ts`, `hooks/portable-agents.ts`, `scripts/legacy-connect.ts`, `scripts/connect-transaction.ts`, `scripts/setup-agent.mjs`, `scripts/setup.*`, `scripts/reporter-tail.ts`, `scripts/claude-md-rule.md`, the last section of `AGENTS.md` (setup copies it into other agents' instructions) | checks a, b and e on every installed row |
   | `hooks/messaging.ts`, `hooks/receiver*.ts`, `scripts/board-messaging.ts`, `scripts/board-serve.ts`, `scripts/message-*`, `scripts/server-runtime.ts` | checks c and e on every installed row |
   | `hooks/serve.ts`, `hooks/board*.ts`, `hooks/view.ts`, `hooks/parse.ts`, `hooks/blocks.ts`, `hooks/dashboard.ts`, `scripts/board-cli.ts`, `hooks/i18n.ts`, `hooks/strings-*.ts` | checks c, d and f on the shared page and terminal board rows |
   | Any other file the release ships, for example `bin/agent-board.mjs` or `hooks/inbox.ts` | a full run |

3. **Always in.** Every row whose host version changed since the last record, because a vendor's update can break a row with no change on our side. Every cell that was FAIL or `needs owner` in the last record. A row for a surface installed since then.
4. **Before the run,** post the scope on the parity issue: the changed files, the rows and checks they reach, and what is left out and why.
5. **Say how each cell ran.** A cell that was not run starts its note with `carried from <record>:`.
6. **A full run** after two runs in a row that were not full.

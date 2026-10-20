# Live parity checklist (every release)

CI tests the code. It cannot show what a person sees inside each agent's own app or CLI. Before every release, open each installed mainstream agent and check the board from inside it. The owner's rule: every mainstream agent must work, in its UI and in its CLI, and each is opened for real, with a screenshot of the CLI.

Write the result to `docs/validation/<date>-parity-<version>.md`, following `2026-10-20-parity-0.23.5.md`. No record, no claim: a surface without a row in that record ships as "untested" in the release notes.

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
- **No connector:** the row says what a user of that agent can do today, for example "opens the `--serve` page; copy only". Agents whose connectors are planned are tracked in #278.

## Checks per row

| | Check | Pass when |
|---|---|---|
| a | Open the board from inside the agent (its skill, command or link) | The board or its link shows, with every agent's rows |
| b | One synthetic turn that reports two steps and ends on a question | The card is on the terminal board and the `--serve` page within a few seconds |
| c | Answer that question from the page | The answer reaches the agent, or the card names the copy fallback |
| d | Archive, confirm done and hide its row, on the terminal and the page | Every press shows a result or a plain reason next to the card |
| e | Send a message from this agent to its own other session and to another agent | Delivered, or the card names the fallback |
| f | Default views | No session id, hash or file path on any default view |

Each cell is one of:
- **PASS**
- **FAIL**, with an issue number
- **untested**, with the reason
- **needs owner**, with the screen that stopped the check (sign-in, trust, consent, usage limit or config) and its words
- **via the page**: checks c and d run once on the shared `--serve` page and terminal board, which get rows of their own; a host whose own turn did not reach the board is marked this way
- **n/a**, with the reason: the check cannot apply, for example the agent has no connector or its service has ended

A cell may add a short note, and a `*` that points to a sentence under the table. Also record the host version and quote any fallback or result text the screen shows.

## How to run it safely

- **Use the hooks as they are already connected.** Never run a connect, setup, install or remove against the real home.
- **Isolate any connect.** If a check needs one, or any `claude` run with this plugin loaded, point every one of these at a scratch folder: `HOME`, `USERPROFILE`, `HERMES_HOME`, `GROK_HOME`, `OPENCLAW_STATE_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `LOCALAPPDATA`, `APPDATA`, `CLAUDE_PROGRESS_FILE`, `CLAUDE_CONFIG_DIR`, `TEMP` and `TMP` (#212).
- **Work in a scratch project folder, with synthetic prompts only** ("Synthetic test: …"). Board checks c, d and f use a synthetic board through `CLAUDE_PROGRESS_FILE`.
- **Never open an existing conversation or project.** If an app opens on one, start a new chat in the scratch folder at once.
- **Screenshots:** at least one per surface, and one inside every CLI. Crop each to the scratch window, with no sidebar, history, account name or real path. Do not commit them. Keep them in a local folder, give the count in the record, and say in the PR body who holds them. Pictures in the repository follow CONTRIBUTING's image rules.
- **Approvals:** you may approve a one-time or this-session prompt to run the board's own command (`--serve`, `--chat`) in the scratch folder, never an "always allow".
- **Never act on the owner's behalf:** no signing in, typing a code, accepting terms, or approving a trust, hooks or consent prompt. Record "needs owner" and the words on the screen.
- **Spend paid quotas carefully:** at most two short turns per agent on a paid quota.
- **Clean up after yourself:** afterwards, stop only the processes you started.
- **Write down what the run left behind:** self-updates, history entries, private data that showed on screen or was sent to a model, rows on the real board, held inbox files, the clipboard and open tabs.

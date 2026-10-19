# Guide

English · [繁體中文](GUIDE.zh-TW.md) · [简体中文](GUIDE.zh-CN.md) · [README](../README.md)

## Get started

Use Node.js 18+ and a checkout. Preview before applying persistent changes:

```sh
node scripts/setup-agent.mjs
node scripts/setup-agent.mjs --apply
```

Auto detection finds host configuration, not active sessions. Use `--agent <name>` for a known host whose configuration is missing, or `--agent all` to preview every target. It does not install the AI products. [Setup](SETUP.md) lists paths and adapter coverage.

Fresh independent installs use `~/.agent-board/progress.md`. Existing installs retain their selected file; `--progress-file /absolute/path/progress.md` selects one explicitly. Do not choose another computer's board for an ordinary local install.

Read back the generated definitions and complete the host's trust/enablement requirements. Codex supports a previewed, scoped trust operation after user approval; see [Codex](CODEX.md). Existing sessions may need reload. CLI, desktop App and IDE must each execute their own acceptance test.

## Other agents

The common installer writes the shared board, skills and available native adapters. It needs neither Claude Code nor another model. [Adapter coverage](SETUP.md#native-status-adapters) distinguishes installed adapters from pending ones.

OpenClaw and DeepSeek Harness now have independent metadata plugins and native skills; Grok reports new prompts as working. OpenCode respects its config-directory overrides. [Portable acceptance](validation/2026-10-19-portable-hosts.md) records isolated callback/SDK checks and unrun native surfaces. Hooks do not install receiving transports. Agents attached to one private message directory share its receipts and deduplication history; task archiving does not expire those message ids.

Native hooks report activity, not inferred task steps. Codex Stop and Antigravity Stop mean waiting for another turn, not a closed conversation or completed task. A new native prompt/start reactivates the same block. Task titles, steps, blockers and completion come from explicit reports bound to the agent's own proven session. Without host-provided context, do not guess an id or inspect conversations to manufacture a report.

An old progress card is not proof that a process is running. Equally, an open application is not proof that its session loaded the hooks or registered a message adapter. [Native acceptance evidence](validation/2026-10-19-native-hooks.md) records these separately.

## The board in every agent

Use the installed skill, or the exact program path printed by setup:

```sh
node ~/.agent-board/agent-board.mjs --serve
node ~/.agent-board/agent-board.mjs --watch
node ~/.agent-board/agent-board.mjs --chat
node ~/.agent-board/agent-board.mjs --html
```

| Mode | Result |
| --- | --- |
| `--serve` | Interactive local web board; reusable background service |
| `--watch` | Terminal board; arrows/Enter to select, `x` tick, `a` archive, `h` hide, `u` restore, `i` idle tasks, `c` copy, `o` HTML, `q` quit |
| `--chat` | Compact plain text; no page, link, browser or writes |
| `--html` | Writes/opens a read-only page; no message delivery |

Add `--lang en`, `zh-TW` or `zh-CN` to select the board language. Windows/custom installations use the printed absolute paths. `$agent-board` is the Codex skill entry; OpenCode installs `/board`. Other hosts must load their installed skill/command first.

### The board's page

Questions appear first. Expand a task for its steps. You can tick manual steps, archive, paste a valid progress block, copy a reply or resume command, mark a question read and show it again. Mark read only changes the local hidden list; it sends nothing. The question returns when its words change. There is no general task-editing form.

Pasted reports keep their source time. Repeats do nothing; older or equal-time conflicting reports are refused. Invalid or future clocks need correction. An existing report with an unknown clock requires comparing both copies before replacement. [Remote reporting](REMOTE_REPORTERS.md) explains recovery.

A card offers Send only when its exact session has a live adapter. Otherwise use Copy or open the agent yourself. [Messaging](MESSAGING.md) explains adapter setup, actual replies, duplicates, conflicts and timeouts. Setup does not attach receivers to arbitrary existing chats. Ordinary replies cannot approve tools, trust changes or PR merges.

Closing the browser tab leaves the local service running. Run the same `--serve` command to reopen it. **Close the board** stops it; wait if a delivery is in progress. Idle shutdown is disabled by default; `--idle-minutes 30` opts in. Legacy `--allow-resume` deliberately enables starting ended Codex/Grok sessions; it is off by default and never a live-message fallback.

`--lan` is optional: a separate token-bearing HTTP link on a private network, no agent messaging, and a 10-minute unused-listener timeout. It permits board-file edits. The token is not encryption. See [Security](../SECURITY.md) before sharing access.

## The file

`progress.md` is storage, not the UI. Each agent owns one block; do not overwrite another session. The parser accepts English, Traditional Chinese and Simplified Chinese keywords. See [FORMAT.md](FORMAT.md) for marks, native ownership and write/readback rules.

The shared file does not synchronize across computers automatically. [Remote reporters](REMOTE_REPORTERS.md) is a separate opt-in workflow. A `dot` label or pasted block does not establish a live dot connection.

## Optional Claude Code pane

Requires Claude Code 2.1.287+; offline CI uses 2.1.301:

```sh
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
```

Open a new Claude Code session; `/progress` opens the pane. It mirrors Task tools and can summarize turns through its model. Questions and decisions appear above the task cards. The pane follows Claude's theme; the browser follows the system theme.

| Command / input | Action |
| --- | --- |
| `/progress connect`, `connect status`, `connect remove` | Optional plugin connector setup, last status, removal |
| `+ Job search: Fellowship due 11-20; draft; submit` | Quick-add in the pane (`/progress add …` also works) |
| `/progress open` | Write/open the read-only `progress.html` |
| `/progress tidy`, `/progress sync` | Archive eligible work; reread Tasks/PR |
| `/progress report`, `/progress today` | Copy a weekly/daily report |
| `/progress lang en`, `zh-TW`, `zh-CN`, `auto` | Pane language |
| `/progress notify on`, `off` | Desktop notifications |

The optional `scripts/setup.sh` / `scripts/setup.ps1` manages Claude-specific Task-tool/profile and marketplace settings. Preview its documented scope before changing a profile. These scripts are not required for independent setup. The older plugin inbox connector can retain conversation data and use Claude summaries; it is separate from metadata-only independent hooks. [Security](../SECURITY.md).

## How it keeps itself tidy

The optional pane sweeps on session start and hourly: done blocks after 12 hours, other stopped/stale blocks after three days, completed manual tasks after 24 hours observed done. Explicit tidy skips the wait for finished work. Archive controls remain available in the standalone board.

After 12 hours without a report, a card can look stopped; that is record staleness, not a native process check. A real new hook/report refreshes it. Work idle more than seven days folds away without changing its block; `--all` or the idle toggle shows it. Near-due work stays visible.

## Update and uninstall

Independent installations: update a clean checkout to the intended release, preview `node scripts/setup-agent.mjs`, then apply the approved plan. Edited files are conflicts, not overwritten. Existing host sessions may need reload. No unattended updater or startup service is installed.

Preview and apply removal for the selected target using the installed program:

```sh
node ~/.agent-board/agent-board.mjs --codex-remove --agent <name>
node ~/.agent-board/agent-board.mjs --codex-remove --agent <name> --apply
```

`--codex-remove` and `--codex-doctor` are retained maintenance names for all targets. Close that board before removal. Only unchanged owned definitions/files are removed; shared files stay while another target needs them. Progress, session records, archives, journals and user changes remain.

For the optional plugin, run `/progress connect remove` while it is still installed; finish reported cleanup, then `claude plugin uninstall agent-board@agent-board`. Remove its marketplace with `claude plugin marketplace remove agent-board`. Plugin marketplace updates use `claude plugin marketplace update agent-board` and `claude plugin update agent-board@agent-board`; reload the plugin afterward.

### Coming from the old name

Before 0.10 the optional plugin was `project-progress@claude-progress-pane`. Remove that plugin/marketplace, install the current names above, then run `/progress connect` inside Claude Code if you use its connector. Preserve the existing progress file. Independent installations need no Claude migration.

## Troubleshooting

- **No card:** check the selected progress path, installed adapter, trust and reload status. Observe a real event and read back that exact session's block. Do not fabricate success with a manual event.
- **No Send:** the exact native session needs a supported live adapter. Hooks alone do not establish receiving. Desktop and CLI results are not interchangeable.
- **A setup relay was ignored:** the recipient must surface missing authorization/blockers. An RPC success or ACK cannot replace observing its new progress report.
- **Read/write failure:** resolve the named file/permission problem, inspect the board/history and retry. Do not delete locks without checking their owner.
- **No native pane:** non-Claude hosts use the interactive web board or terminal board. A web panel is not a native host sidebar.

### Reporting a problem safely

Give the Agent Board version, affected host/version, CLI/App/IDE surface, OS and a synthetic reproduction. Include Claude's version only for its optional plugin. Never upload raw progress, inbox, archive, journal or session logs, credentials, or board tokens. [Security reports](../SECURITY.md#reporting-a-problem).

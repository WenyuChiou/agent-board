# Guide

English · [繁體中文](GUIDE.zh-TW.md) · [简体中文](GUIDE.zh-CN.md) · [README](../README.md)

## Get started

When work has transferred, its owner must report that explicitly. Claude Task tools accept `metadata: {"handoffTo":"recipient name"}` on each transferred step; an explicit pending/in-progress update reclaims it. Turn summaries use `HANDOFF` for a named recipient and keep the transferred work in `NEXT`. Other reporters write `[-] Work — Handed to recipient`. The source retains a cancelled pointer, offers no Continue for it, and does not double-count the recipient's work. A proposal, sent message, model summary or progress update does not prove delivery or authorize actions.

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

Supported prompt hooks mark an existing agent's questions answered and its task working on the next inbox poll, without a model call. Legacy inbox receipts with older, equal, unknown or invalid source times do nothing; they never create or restore a block. A receipt must be read back before its inbox input is removed; a failure retries. `/progress connect` updates the hooks and `connect remove` removes them. OpenClaw requires the host's `external_user` origin classification. [Prompt contracts and checks](validation/2026-10-19-prompt-hooks.md) lists coverage and limits.

Read-only previews skip prompt metadata while keeping unprocessed reports and questions visible. A prompt timestamp or file modification time alone cannot prove that a report was handled.

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
| `--watch` | Terminal board; arrows/Enter to select, `x` tick, `d` confirm done, `a` archive, `h` hide, `u` restore, `i` idle tasks, `c` copy, `o` HTML, `q` quit |
| `--chat` | Compact plain text; no page, link, browser or writes |
| `--html` | Writes/opens a read-only page; no message delivery |

Add `--lang en`, `zh-TW` or `zh-CN` to select the board language. Windows/custom installations use the printed absolute paths. `$agent-board` is the Codex skill entry; OpenCode installs `/board`. Other hosts must load their installed skill/command first.

Chat shows questions first, then unprocessed progress reports with their source age. These reports do not prove completion or a live connection. Claimed or processed inbox files do not appear twice; a fresh hook timestamp alone never hides a pending report. Long replies retain an omission count; chat writes nothing.

### The board's page

Questions appear first. Expand a task for its steps. You can tick manual steps, archive, paste a valid progress block, copy a reply or resume command, mark a question read and show it again. Mark read only changes the local hidden list; it sends nothing. A substantively new question appears again. There is no general task-editing form.

An unchanged hidden question stays hidden when unrelated steps move or its whitespace changes. Questions with identical words have separate identities. Changing their number is ambiguous, so they reappear rather than inherit another question's hide. A question observed as resolved or absent gets a fresh identity if asked again; a new ask with identical words and no observed transition cannot be inferred from a report alone. **Show again** remains available. Hiding never answers, approves, completes or delivers anything.

Claude's explicit ask events also renew the question when its words stay the same, without needing an intermediate refresh. A small revision annotation travels with that task in the progress file; it stays out of the board display. Other hidden questions and unrelated task updates keep their identities. The observation limit above applies to reports that provide neither a transition nor a producer revision.

The board keeps local identity history in `progress-questions.json` beside `progress.md`, separately from `progress-answered.json`. Keep both when moving the board. Older indexed hides migrate after a stable, complete report when their normalized words match one question in one scoped session. Duplicate or unmappable originals remain stored without hiding a future question. Migration markers prevent a lost identity write from reassigning an old hide. A corrupt or unwritable identity file is preserved and a new hide fails visibly. Chat and one-shot readers do not write migration files. Questions stay prominent through exactly three days. After three days through exactly seven days they move into one grouped reminder; after seven days they leave actionable counts and remain in **Older unanswered questions**. Expand that shelf to review the full source and age; viewing it never refreshes the question. The terminal uses `l` to open older questions and `--all` includes them in plain text. Manual, own-session, stopped external and pending inbox questions share the policy. Age starts at durable first observation, never heartbeat/import time; unknown or future observation clocks remain visible. Read-only chat/one-shot readers use existing baselines and do not create them.

Keep the accompanying `progress-questions-retired-*.json` and `progress-questions-consumed-*.json` files in backups and moves too. These immutable records contain only a version, kind and opaque hash. They prevent stale file writes from reviving retired identities or reusing migrated hides. They are never removed by age or task archiving. Unreadable, incomplete or unwritable records disable hiding until storage recovers; extra visible questions are safer than transferring an old hide.

**Confirm done** finishes every open step at once, preserving canceled steps. Those canceled pointers also survive a later prompt when the board had no cached owner; a fresh producer report can replace that snapshot. Use the pane or page button, or `d` on a selected terminal task. It is available for manual tasks and agent blocks that ended or stopped writing for more than 12 hours. Changed or live tasks are refused. Each new tick goes to the journal; blocks become `state=done` with the current timestamp and follow the usual archive wait. It sends nothing to an agent. `progress.html` stays read-only.

Local lifecycle updates preserve completed steps. A fresh explicit task report can introduce new work.

The pane, terminal and pages identify work by task and agent. Connection inventory and session ids stay out of the display; supported resume commands are copied only on request.

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

The optional connector requires Node.js 18+ and reloads of older plugin sessions before migration. Its native worker shares the installer lock across data roots, keeps removal disabled durably, and preserves foreign edits. Background probes start after the pane and polling; missing Node or damaged setup records fail closed. `connect status` describes configuration, not native execution.

The optional `scripts/setup.sh` / `scripts/setup.ps1` manages Claude-specific Task-tool/profile and marketplace settings. Preview its documented scope before changing a profile. These scripts are not required for independent setup. The older plugin inbox connector can retain conversation data and use Claude summaries; it is separate from metadata-only independent hooks. [Security](../SECURITY.md).

## How it keeps itself tidy

The optional pane sweeps on session start and hourly: done blocks after 12 hours, other stopped/stale blocks after three days, completed manual tasks after 24 hours observed done. Explicit tidy skips the wait for finished work. A working or waiting agent block stays live for 12 hours after its last write: the pane, terminal and page explain why Archive is unavailable, and tidy keeps it. Once stopped or ended, open the row to archive it immediately. Unresolved `[?]` blocks are retained by automatic sweeps. Explicit archive also requires a durable complete question snapshot, preserving recovery after the source moves; storage failure leaves the source in place.

After 12 hours without a report, a card can look stopped; that is record staleness, not a native process check. A real new hook/report refreshes it. Work idle more than seven days folds away without changing its block; `--all` or the idle toggle shows it. Near-due work stays visible. Ended or stale sessions move to a separate Stopped shelf and leave the In progress count; their unanswered questions stay under Waiting on you, and `--all` or `i` shows both idle and stopped tasks.

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

Until current Codex hooks are approved in /hooks, the optional connector keeps managed reporting instructions; unknown/lost trust restores them on connect. Status checks trust without editing instructions.

Full source captures also live beside the board in content-addressed progress-questions-source-*.json files. Keep the whole questions file family in backups and moves; none of these evidence files are age-pruned. Readers merge all captures on every read, so a stale mutable index cannot delete the retained original. Cleanup and explicit archive require successful full-copy readback. An end event closes a connection without answering its pending questions, including multiple asks and an end-only question. Corrupt or unreadable capture storage refuses destructive cleanup and new hides.
Exact producer revisions remain attached after processing and resolution, so retrying an old raw file does not renew an answered question; a new producer revision remains observable.
Explicit archive keeps its complete unresolved copy in the older shelf. Unexpected source disappearance keeps the normal age policy, with unknown clocks prominent.
A stale report cannot revive an already resolved question with the same known producer revision and words. An explicit renewed revision or a substantively changed question can appear again.
Live questions on the terminal and native pane reminder/older shelves support Already answered, hide and Show again without changing the source or its age. Retained copies whose producer source has gone are labeled review only; the served page's reminder/older sections are also review only and expose no hide control.
A failed or dropped native-pane reply leaves its question unread. Successful submission resolves only the exact question still present afterward; a question renewed during delivery remains waiting. Moving an existing question into retained storage does not generate a new notification.

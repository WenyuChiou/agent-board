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

The board keeps local identity history in `progress-questions.json` beside `progress.md`, separately from `progress-answered.json`. Keep both when moving the board. Older indexed hides migrate after a stable, complete report when their normalized words match one question in one scoped session. Duplicate or unmappable originals remain stored without hiding a future question. Migration markers prevent a lost identity write from reassigning an old hide. A corrupt or unwritable identity file is preserved and a new hide fails visibly. Chat and one-shot readers do not write migration files. Questions stay prominent through exactly three days. After three days through exactly seven days they move into one grouped reminder; after seven days they leave actionable counts and remain in **Older unanswered questions**. Expand that shelf to review the full source and age; viewing it never refreshes the question. The terminal uses `l` to open older questions and `--all` includes them in plain text. Manual tasks, own running sessions, live external sessions and pending inbox questions share the policy. Questions from stopped, ended or done sessions leave Waiting on you and stay with their task under Stopped or in its Done recently entry. Questions removed or reworded in a stopped session remain reviewable under Older unanswered questions. Resolve closes one question. It lasts until the agent ticks or removes that step or the task is renamed; after that the same words can ask again. Age starts at durable first observation, never heartbeat/import time; unknown or future observation clocks remain visible. Read-only chat/one-shot readers use existing baselines and do not create them.

Keep the accompanying `progress-questions-retired-*.json` and `progress-questions-consumed-*.json` files in backups and moves too. These immutable records contain only a version, kind and opaque hash. They prevent stale file writes from reviving retired identities or reusing migrated hides. They are never removed by age or task archiving. Unreadable, incomplete or unwritable records disable hiding until storage recovers; extra visible questions are safer than transferring an old hide.

**Confirm done** finishes every open step at once, preserving canceled steps. Those canceled pointers also survive a later prompt when the board had no cached owner; a fresh producer report can replace that snapshot. Use the pane or page button, or `d` on a selected terminal task. It is available for manual tasks and agent blocks that ended or stopped writing for more than 12 hours. Changed or live tasks are refused. Each new tick goes to the journal; blocks become `state=done` with the current timestamp and follow the usual archive wait. It sends nothing to an agent. `progress.html` stays read-only.

Local lifecycle updates preserve completed steps. A fresh explicit task report can introduce new work.

The pane, terminal and pages identify work by task and agent. Connection inventory and session ids stay out of the display; supported resume commands are copied only on request.

Pasted reports keep their source time. Repeats do nothing; older or equal-time conflicting reports are refused. Invalid or future clocks need correction. An existing report with an unknown clock requires comparing both copies before replacement. [Remote reporting](REMOTE_REPORTERS.md) explains recovery.

A card offers Send only when its exact session has a live adapter. Otherwise use Copy or open the agent yourself. [Messaging](MESSAGING.md) explains adapter setup, actual replies, duplicates, conflicts and timeouts. Setup does not attach receivers to arbitrary existing chats. Ordinary replies cannot approve tools, trust changes or PR merges.

`--no-open` prints the address without opening the browser. Closing the browser tab leaves the local service running. Run the same `--serve` command to reopen it. **Close the board** stops it; wait if a delivery is in progress. Idle shutdown is disabled by default; `--idle-minutes 30` opts in. Legacy `--allow-resume` deliberately enables starting ended Codex/Grok sessions; it is off by default and never a live-message fallback.

#### On a phone

The page fits a phone's screen. To open it from a phone on the same Wi-Fi as the computer, run `node ~/.agent-board/agent-board.mjs --serve --lan`. Besides the computer's address, it prints the page's address on your network and a QR code of it: point the phone's camera at the code. When the computer has more than one network address, `--lan 192.168.1.23` picks one. Windows may ask whether Node.js may use the network: allow it on private networks, and check that Windows counts your Wi-Fi as a private one (it calls a network it has just joined public), or the phone can't reach the page. Access from another network requires a separately configured remote connection.

The page on your network comes with these limits:

- It opens only when you add `--lan`, only at a private address of the computer (one starting with 192.168, 10, or 172.16 to 172.31, never a public one), and it answers only requests sent to that address.
- Its address carries a key of its own, not the key of the computer's page. Anyone who has that address, or photographs the QR code, can use the page until it closes, so use it on a network you trust, such as your home Wi-Fi, not a café's.
- On the network the page uses plain HTTP, which is not encrypted, so another device on the same Wi-Fi could read what passes, agents' answers included. That is why a phone can tick, archive, mark a question answered (and show it again), copy, paste a block and close the board, but not answer an agent: a reply runs a program on the computer, so the phone shows the answer for you to copy, and you send it from the computer's page.
- It closes after 10 minutes in which no phone looks at it, and whenever the computer's page closes. A second `--serve --lan` while it is open gives the same address.

See [Security](../SECURITY.md) before sharing access.

## The file

`progress.md` is storage, not the UI. Each agent owns one block; do not overwrite another session. The parser accepts English, Traditional Chinese and Simplified Chinese keywords. See [FORMAT.md](FORMAT.md) for marks, native ownership and write/readback rules.

The shared file does not synchronize across computers automatically. [Remote reporters](REMOTE_REPORTERS.md) is a separate opt-in workflow. A `dot` label or pasted block does not establish a live dot connection.

## Optional Claude Code pane

Requires Claude Code 2.1.287+; offline CI uses 2.1.301:

```sh
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
```

Open a new Claude Code session; `/progress` opens the pane. It mirrors Task tools and can summarize turns through its model. Questions and decisions appear above the task cards. The pane follows Claude's theme; the page follows the system theme until you pick Light or Dark on it.

The Claude desktop app shows the footer status; `/progress` offers the board page, where you can answer questions and archive work, and opens a read-only page if the live page cannot start. Starting the page can take up to half a minute; the footer says it is starting meanwhile. The live page needs the board script installed by `/progress connect`, or updated at the next session start. Sessions and agents using the same installed board script reuse the running page. A page `/progress` starts closes 30 minutes after its last tab is closed, and `/progress` again gives a new link; a page you started yourself with `--serve` keeps its own setting. `/progress` replaces a page started with `--allow-resume`, unless a reply there is still on its way; run `--serve --allow-resume` again afterwards when you need resumed replies. The Claude Code CLI shows the pane.

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

Strong Codex runs and Claude print-mode sessions write no new board block. The board script’s tidy moves old Codex run blocks to the archive when their own session history proves they are runs, even if they contain a question. Missing or unreadable history supplies no run proof; ordinary age rules still apply. The optional pane’s sweep does not open history files. Weak hints keep the earlier behavior.

The optional pane sweeps on session start and hourly: done blocks after 12 hours, other stopped/stale blocks after three days. A running `--serve` page also sweeps every hour. A hand-kept task with every step `[x]` or `[-]` counts toward the archive after three days observed done; in 0.24.1 scheduled sweeps only count these tasks and move none. The details line says "N finished tasks can be archived"; a zero count is omitted. A working or waiting agent block stays live for 12 hours after its last write: the pane, terminal and page explain why Archive is unavailable, and tidy keeps it. Once stopped or ended, open the row to archive it immediately. Automatic sweeps take a block with an unresolved `[?]` step only when the same complete question snapshot the explicit archive requires is saved and read back, and only when it has been quiet long enough: three days after its last write if it has ended or is done, seven days with no report if it is still working or waiting. A block whose snapshot cannot be saved stays. The question is kept and shows under Older unanswered questions, where it can be hidden and shown again. Explicit archive requires that snapshot at any age, preserving recovery after the source moves; storage failure leaves the source in place.

Run `node ~/.agent-board/agent-board.mjs --tidy` for one normal age-based sweep without a Claude session or page. It installs no scheduler and does not write `progress-seen.json`: the pane, `--watch` or `--serve` must first observe a completed hand-kept task and record when the three-day rule first ran. The three days count from the later of those two observations, giving work seen done under 0.24.0 three days from the upgrade. A machine running only `--tidy` never arms that rule and counts nothing without the reserved entry. Unknown, future or unreadable observations retain manual tasks; `--tidy` can still archive eligible dated agent blocks. The page's hourly sweep skips its pass and writes nothing if the seen file cannot be read.

Clean up on the pane or page archives the finished hand-kept tasks whose three days are up, exactly the ones the count line counts, plus what the normal sweep moves. It writes to the same monthly archive before removing work from the board; tasks inside their three days, open tasks and `[?]` tasks stay. If the seen file cannot be read, Clean up archives nothing and says so. In 0.24.1 unattended sweeps (pane start and hourly, `--tidy`, and page hourly) only count hand-kept tasks and move none. The pane's Archive now and `/progress tidy`, the page's Archive now, and a row's Archive still move finished work at once; nothing is deleted. The pane and page offer one Clean up button with the size warning and whenever the count is above zero, even on a small board. Numbers and the count sit in the details line. The terminal board, chat and `--html` show the details without a button.

After 12 hours without a report, a card can look stopped; that is record staleness, not a native process check. A real new hook/report refreshes it. Work idle more than seven days folds away without changing its block; `--all` or the idle toggle shows it. Near-due work stays visible. Ended or stale sessions move to a separate Stopped shelf and leave the In progress count. Their unanswered questions leave Waiting on you and stay with the task, even when due or idle. Done sessions keep questions in their Done recently entry, then under Stopped when that entry leaves Done recently. Resolve on the pane closes one question; `--all` or `i` shows both idle and stopped tasks.

The pane's saved records (the plugin's store file, in Claude's config folder under `plugins/store`) are kept to a fixed size too. An ended agent's record goes three days after its last write, and a session's saved task list after seven days, or thirty while it has open steps; none goes while its block is still on the board. Each record carries a short tag of the path of the board it was saved for, so a board uses the short times only for its own records: the records of another board on the same computer go only after thirty days (a record saved before 0.24 has no tag and also goes only after thirty days), and a board's own record dated more than a day ahead, written while the clock was wrong, goes unless its block is on the board. Inbox files the pane set aside as `.failed` are kept seven days from when it set them aside, whatever the file's own date. A temporary `.tmp` file a reporter left in the inbox, cut off before it was whole, is removed once it is a day old; it is a partial write, not a turn, so it is not counted as cleared. If the store still passes 1.5 MB after that, the oldest records of ended sessions that are not on the board go until it is under; hand-kept tasks and steps waiting on you are never removed by a size rule. The inbox of other agents' turns holds at most 1,000 files or 1.5 MB: the writers drop the oldest and note how many in `progress-inbox/dropped.log`. The pane and `progress.html` say in one line what was cleared in the last 7 days, for example "Cleared 12 old agent records and 340 unread inbox turns in the last 7 days", and only when something was cleared. They also warn when the store passes 1.2 MB (saying that only records of sessions whose block has left the board are cleared) or `progress.md` passes 512 KB.

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

## FAQ

### Can I start from only one agent?

Start from any supported agent with the common installer. No second AI product is required. Native hook availability varies by host; the board and explicit own-progress reporter are shared.

### I installed it from Codex (or another agent). Can that agent see Claude Code's work?

Yes, when those sessions report to the same local progress file. Independent reporters write their own blocks without Claude Code; the optional Claude pane reads that file too. Opening a board is separate from enabling direct messages.

### I switched to a new computer. Do I lose everything?

Nothing is lost, but nothing moves by itself either: `progress.md`, the inbox and the hooks live on each computer. On the new one, use the common installer and restart your agents. To bring your history along, copy your selected `progress.md` and the `progress-archive-*.md` and `progress-journal-*.md` files beside it.

To share one board between two computers, set `CLAUDE_PROGRESS_FILE` on both to the same file in a synced folder (OneDrive, Dropbox, iCloud), then run `/progress connect` once on each computer: automatic connect follows only the default progress file or the one you last connected by hand. This works best when you use one computer at a time: two computers writing at once can leave your sync app with a conflicted copy.

### An agent doesn't show up.

1. Run `node scripts/setup-agent.mjs` to preview the current host and read any conflict or `adapter-pending` result.
2. Reload the host as required, complete only its scoped native hook trust/enablement, and read that state back.
3. Have that session report its own proven native id; check its exact block and timestamp. Never invent a task for another session.
4. Observe a new native lifecycle event separately from the explicit report. A progress record does not imply direct messaging; see [connection checks](MESSAGING.md#connecting-a-session-that-was-already-open).

The optional Claude plugin has a separate inbox flow; use `/progress connect status` for that installation. Independent status hooks do not need a running Claude session.

For a public bug report, include:

- Board, Node.js (`node --version`) and affected agent versions; include Claude Code/plugin versions only for that optional integration.
- Your OS, which agent, what you did, what you expected and what happened.
- Relevant setup/doctor output, after removing private details.

Do not upload raw inbox, progress or session-log files. Remove prompts, replies, private paths, tokens (including board links/QR codes), and personal or project names from any output or screenshot. Use a small example written from scratch. `--chat` only hides home paths and common credential forms in its own output; it is best-effort and does not clean diagnostic files.

Synthetic example (fill in versions; no real conversation needed):

```text
OS: demo OS; board/Node.js/agent versions: <versions>
Action: finished a turn in demo-1. Expected: a board row. Actual: no row.
Setup/doctor: <reviewed status, with private details removed>
```

Send private or security-sensitive reports through GitHub's [Report a vulnerability](https://github.com/WenyuChiou/agent-board/security/advisories/new). See [SECURITY.md](../SECURITY.md) for details.

### Does anything leave my machine? What does it cost?

Independent reporters retain selected session metadata locally and do not call a summarization model. Sending a message to an online agent uses the target agent’s model and allowance. The following model and conversation access applies to the optional Claude plugin flow: Board files are stored locally. Through your own Claude Code login/model access, turn summaries send prompt and reply text to Claude Haiku; titles send the session's first request plus step names; and handoff lines send up to 6,000 characters of a compaction summary. The pane's side-question box also sends your question to the model over the session's transcript through that same login. These calls use that account's allowance or billing. The pane runs `git branch --show-current` and, if GitHub's `gh` is installed, uses it to check your pull request and CI state. By default, replies require an exact online session. Legacy Codex/Grok process resumption requires explicit `--allow-resume` and uses that agent’s permissions and network. The independent OpenClaw plugin disables conversation access; the optional Claude connector instead sets `allowConversationAccess: true`.

`--serve` listens on loopback (`127.0.0.1`) by default; any program on this computer that has the link can use it. `--serve --lan` shares the page on your private network through an HTTP link with a token. The token is an access key, not encryption: anyone on that network with the LAN link can read the board, change board files (including importing blocks) and stop the server. The LAN page refuses replies that would start an agent and omits resume commands. A private network address does not make a café or hotel network trusted. Do not share the link or QR code. Use the page's **Close the board** button to stop serving; if a reply is running, wait and try again. Closing the tab alone leaves the local service running; idle shutdown is opt-in. A new token is issued each time the board server or its LAN listener restarts, so stopping it makes its old link useless. See [SECURITY.md](../SECURITY.md) for file changes, processes, network access and the limits of `--chat` redaction.

### Does it work on Windows?

The local board runs on macOS, Linux and Windows. Native hooks and messaging depend on the host and surface; see the README's [supported agents](../README.md#supported-agents). Independent Windows hooks use Node without `sh`.

### I used it as `claude-progress-pane` before.

The plugin was renamed in 0.10.0 and doesn't move over by itself. Run the steps in [Coming from the old name](#coming-from-the-old-name). Your `progress.md` stays as it is.

### How do I uninstall it?

Independent setup: close the board, preview `node ~/.agent-board/agent-board.mjs --codex-remove --agent <name>`, then add `--apply` after review. Progress and history remain. For the optional Claude plugin:

```sh
claude -p "/progress connect remove"
claude plugin uninstall agent-board@agent-board
claude plugin marketplace remove agent-board
```

The first line disconnects the other agents; finish any reported cleanup before uninstalling. Your history, reporter scripts and inbox stay. See [Update and uninstall](#update-and-uninstall) for retries, recovery if you already uninstalled, and the retained files and their locations.

## Troubleshooting

- **No card:** check the selected progress path, installed adapter, trust and reload status. Observe a real event and read back that exact session's block. Do not fabricate success with a manual event.
- **No Send:** the exact native session needs a supported live adapter. Hooks alone do not establish receiving. Desktop and CLI results are not interchangeable.
- **A setup relay was ignored:** the recipient must surface missing authorization/blockers. An RPC success or ACK cannot replace observing its new progress report.
- **Read/write failure:** resolve the named file/permission problem, inspect the board/history and retry. Do not delete locks without checking their owner.
- **No native pane:** non-Claude hosts use the interactive web board or terminal board. A web panel is not a native host sidebar.
- **A task cut off mid-write:** if a session stops while it writes its block (a crash or a forced shutdown), the block can lose its end marker. The board reads it as ending where its lines end, shows it as it was, and names it under Board health at the bottom of the pane. To close it by hand, add `<!-- /auto session=<id> -->` on the line after its last line; the id is in the block's start marker. If the session wrote its block again first, the lines left below the new block repeat its old steps: delete them by hand.

### Reporting a problem safely

Give the Agent Board version, affected host/version, CLI/App/IDE surface, OS and a synthetic reproduction. Include Claude's version only for its optional plugin. Never upload raw progress, inbox, archive, journal or session logs, credentials, or board tokens. [Security reports](../SECURITY.md#reporting-a-problem).

Until current Codex hooks are approved in /hooks, the optional connector keeps managed reporting instructions. Once Codex has confirmed the approval, connect removes them and remembers the approval with the hooks.json it was given for and Codex's config.toml as it was then. When Codex cannot be asked (no binary found, too slow, an error, an answer this release cannot read), the remembered approval holds while both files are unchanged. When Codex answers that the hooks are not approved, turned off or not listed, or when it cannot be asked and either file has changed (any change, including untrusting or turning hooks off in /hooks, which rewrites config.toml), connect restores the instructions. It also restores them when Codex cannot be asked and the Codex executable it finds is not the one found when the approval was remembered, as after a Codex upgrade, or cannot be read. On Windows npm installs, the check runs the Codex binary inside the npm package, never the `codex.cmd` shim. Status checks trust without editing instructions.

Full source captures also live beside the board in content-addressed progress-questions-source-*.json files. Keep the whole questions file family in backups and moves. The pane's archive (session start, hourly, and the pane's tidy; not the board script's `--tidy`) keeps the newest 16 of each kind (captures, retired proofs, consumed proofs) and removes an older file only when the questions file or a newer copy already holds everything in it; a file that may be the only record stays, nothing is removed while any of them cannot be read, and one sweep removes at most 200 files, the rest waiting for the next. The same archive also keeps only the newest three torn questions files (the `.torn-*` copies set aside when the questions file was cut off or garbled), removes one over a week old even among those three, and removes a temporary copy left by an interrupted write once it is a day old and the questions file itself reads. Readers merge all captures into every read, so a stale mutable index cannot delete the retained original. Cleanup and explicit archive require successful full-copy readback. An end event closes a connection without answering its pending questions, including multiple asks and an end-only question. Corrupt or unreadable capture storage refuses destructive cleanup and new hides.
Exact producer revisions remain attached after processing and resolution, so retrying an old raw file does not renew an answered question; a new producer revision remains observable.
Explicit archive keeps its complete unresolved copy in the older shelf. Unexpected source disappearance keeps the normal age policy, with unknown clocks prominent.
A question from a session that ended, finished or has not reported for 12 hours stays on that session's Stopped row, and it is also listed once under Older unanswered questions with how long ago it was first asked (never less than how long the session has been quiet) and its project, agent and task. Waiting on you shows one line, "N unanswered in stopped sessions", that opens Older; the question never moves into Waiting on you and no waiting count changes, and it counts once even when it sits on a Stopped row too. Older shows ten questions and a "Show all (N)" control for the rest on the pane, the page and progress.html; the terminal board lists them all. In Older, "Already answered, hide" works on a question that still has its source in the file and on one kept from an archived session; a retained copy whose source has gone from a session that was not archived is labeled review only and cannot be hidden. A hidden question is listed under "N answered, hidden" with "Show again" on the pane and the page; the terminal board shows that count, and its u key brings them all back. Answering a question kept from an archived session from the board, and bringing its session back, are not offered yet. A question hidden before this release stays hidden and is not counted.
A stale report cannot revive an already resolved question with the same known producer revision and words. An explicit renewed revision or a substantively changed question can appear again.
Live questions on the terminal, native pane and served-page reminder/older shelves support Already answered, hide, and a hidden question comes back with Show again on the pane and the page (the terminal board's u key brings all of them back), without changing the source or its age; so does a question kept from an archived session. Retained copies whose producer source has gone, from a session that was not archived, are labeled review only on every surface and offer no hide control.
A failed or dropped native-pane reply leaves its question unread. Successful submission resolves only the exact question still present afterward; a question renewed during delivery remains waiting. Moving an existing question into retained storage does not generate a new notification.

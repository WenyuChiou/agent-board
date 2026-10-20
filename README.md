<h1 align="center">
<img alt="A short tour: five agents, and the one that needs you; answering from the pane; every agent reporting through its own hooks; nothing lost; where it runs; its light and dark colours. Synthetic data." src="docs/images/tour-en.svg" width="100%">
</h1>

<p align="center"><sub>A short tour, drawn by the board's own code from synthetic data.</sub></p>

<p align="center">
<b>See what every AI coding agent is doing, with whatever is waiting on you at the top.</b><br>
A local interactive board for your coding agents, with an optional native pane in Claude Code. Start from whichever agent you already use; see <a href="#supported-agents">host support</a>.
</p>

<p align="center">
<a href="CHANGELOG.md"><img alt="Version 0.23.5" src="https://img.shields.io/badge/version-0.23.5-blue"></a>
<a href="#quick-start"><img alt="Node.js 18+" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2018-339933"></a>
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green"></a>
<img alt="macOS, Linux, Windows" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey">
</p>
<p align="center">
<a href="#supported-agents"><img alt="Codex 0.163.0, see surface-specific acceptance" src="https://img.shields.io/badge/Codex-0.163.0-brightgreen"></a>
<a href="#supported-agents"><img alt="Antigravity CLI native hooks" src="https://img.shields.io/badge/Antigravity%20CLI-native%20hooks-yellowgreen"></a>
<a href="#supported-agents"><img alt="OpenCode 1.19.3, see surface-specific acceptance" src="https://img.shields.io/badge/OpenCode-1.19.3-brightgreen"></a>
<a href="#supported-agents"><img alt="Grok Build 1.0.62, works in part" src="https://img.shields.io/badge/Grok%20Build-1.0.62-yellowgreen"></a>
<a href="#supported-agents"><img alt="Hermes Agent 0.19.0, works in part" src="https://img.shields.io/badge/Hermes%20Agent-0.19.0-yellowgreen"></a>
<a href="#supported-agents"><img alt="OpenClaw 2026.10.4, works in part" src="https://img.shields.io/badge/OpenClaw-2026.10.4-yellowgreen"></a>
</p>

<p align="center">English · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.zh-CN.md">简体中文</a></p>

You have Claude Code on one project, Codex on another, Antigravity on a third. Twenty minutes in, one of them stops to ask you something, and you only find out when you happen to switch back. **Agent Board** puts that question in front of you the moment it's asked, with a button for each answer.

## What you get

- **Whatever needs you comes first.** A question from any agent sits at the top with a button for each answer. Connected agents can receive an answer directly; otherwise, copy it into the original chat. Already answered it in the chat? **Already answered, hide** puts it away on this computer and sends nothing; it comes back if that session asks something new.
- **Every agent in one place.** Report each session’s real task steps explicitly; native hooks report activity where supported. Group work by project without reading private conversations.
- **Pick up where you left off.** Compaction, a closed terminal, the next morning: you see what's done, what's stuck and what's next. A session that stopped halfway can be taken over in one click.
- **Your own to-dos too.** Type `+ Job search: Fabrikam fellowship due 11-20` in the pane's box. Due dates turn the row amber, then red.
- **Outside the terminal.** `/progress open` shows the same view in your browser (it works on a phone too), and other agents open [a page you can click](#the-boards-page) to tick, archive and answer. The status line and desktop notifications tell you when something needs you while the pane is closed.
- **Reports.** `/progress report` and `/progress today` copy what got done, as text.
- **Tidies itself.** Finished work moves to a monthly archive; a journal keeps every finished step. Work nobody has touched for more than a week steps aside behind one **N idle 7+ days** line, with nothing in the file changed.
- **One plain Markdown file.** Independent setup defaults to `~/.agent-board/progress.md`; existing installations keep their chosen path. You can read and edit it. English, 繁體中文 and 简体中文; light and dark.

## How it works

<img alt="Claude Code sessions, other agents through their hooks, and you all write one Markdown file, progress.md; the pane, progress.html, the archive and the status line read it. The file lines are a synthetic example." src="docs/images/flow-en.svg" width="100%">

<sub>The file lines in the diagram are a synthetic example.</sub>

Independent reporters write native session activity and explicit task summaries into separate blocks in one local `progress.md`. The web board reads it without another model. The diagram above shows the optional Claude plugin's inbox-and-summary flow. See [the file format](docs/FORMAT.md).

## Quick start

<details open>
<summary><b>Let an agent install it for you</b></summary>

Paste this into the agent you already use. You do not need to choose a vendor-specific installation path:

```text
Install Agent Board from https://github.com/WenyuChiou/agent-board on this computer.
Read its AGENTS.md, README and setup guide. Identify my current host and the other installed coding agents, then preview the common installer: node scripts/setup-agent.mjs.
Preserve existing settings and the shared progress path. Follow my approval requirements for persistent changes, then apply the applicable hooks, plugins and board command. Do not require or call another AI product to bootstrap this one.
Complete any required scoped host trust, read the settings back, and have this session report its own real task progress. Open the interactive board.
Verify actual hook events separately for CLI, desktop App and IDE. Installed files, transport acceptance and an ACK are different from a working progress connection.
Tell me which existing sessions need reload and which adapters remain unsupported or unverified. Never scan private conversations or silently skip a blocker.
```

</details>

For manual installation, Node.js 18+ and Git are enough. Preview first, then apply the reviewed plan:

```sh
git clone https://github.com/WenyuChiou/agent-board.git
cd agent-board
node scripts/setup-agent.mjs
node scripts/setup-agent.mjs --apply
```

The installer detects configuration targets; it does not prove those agents are running. The installed board skill opens the interactive page, and `node ~/.agent-board/agent-board.mjs --serve` reopens it. See the [common setup guide](docs/SETUP.md).

<details>
<summary>Optional native pane in Claude Code</summary>

Requires Claude Code 2.1.287+; offline CI uses 2.1.301. Install its plugin, then open Claude Code and use `/progress`. Other hosts can use the independent interactive board.

The Claude desktop app shows the footer status; `/progress` offers the board page, where you can answer questions and archive work, and opens a read-only page if the live page cannot start. The live page needs the board script installed by `/progress connect`, or updated at the next session start. Sessions and agents using the same installed board script reuse the running page. The Claude Code CLI shows the pane.

```sh
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
```

</details>

## Supported agents

Independent hooks and explicit progress reports share one local board. A card can send only through its exact live adapter; CLI, App and IDE acceptance remain separate. [Messaging](docs/MESSAGING.md).

| Host / surface | Current scope |
| --- | --- |
| Codex CLI | Independent setup and six hooks. Owned app-server hooks and ACKs tested; interactive TTY acceptance remains separate. |
| Codex desktop App | Interactive board and explicit real progress reports; automatic native hooks and direct messaging remain unverified. |
| Antigravity CLI | Independent setup, four native hooks and owned-stream messaging tested on Windows. App/IDE acceptance remains separate. |
| Cursor, OpenCode, Grok Build, Muse Code | Independent hooks or plugin generated. Native execution and direct messaging vary by host; installation alone is not acceptance. |
| OpenClaw, DeepSeek Harness | Independent native metadata plugins and skills; isolated callback/loader checks passed. Native applications and direct messaging remain unverified. |
| Hermes Agent | Board and skill; independent lifecycle adapter pending. |
| Claude Code | Optional native pane, Task mirroring and its plugin connector flow. |
| dot and other web agents | Explicit progress relay; direct messaging unverified. |

### By capability

Use [setup's adapter table](docs/SETUP.md#native-status-adapters) for lifecycle coverage and [messaging](docs/MESSAGING.md) for exact live session ownership, ACK and surface limits.

<details>
<summary>Legacy Gemini CLI compatibility</summary>

Google ended free individual and Google AI Pro/Ultra Gemini CLI service on June 18, 2026 in favor of Antigravity CLI. Supported enterprise and paid API-key use remains separate. The explicit `--agent gemini` compatibility target is retained; it is not an alias for Antigravity. [Official announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/).

</details>

## The board in every agent

Connecting also gives each agent a way to show the board, so whichever one you are in, you see what all of them are doing:

| In | Type |
|---|---|
| OpenCode | `/board` |
| Codex | `$agent-board` |
| OpenClaw, Hermes Agent | `/agent-board` |
| Grok Build, Cursor, Antigravity (not verified yet) | `/agent-board` |
| Any terminal, next to any agent | `node ~/.agent-board/agent-board.mjs --watch` (`--html` opens it in the browser) |
| A browser, from any agent | `node ~/.agent-board/agent-board.mjs --serve` |
| A chat app, through an agent (Hermes Agent, OpenClaw) | `node ~/.agent-board/agent-board.mjs --chat` (plain text, no page or address; the agent runs it) |

**In a chat app.** `--chat` prints the board as plain text, with no page, no address and no browser, cut to fit one message (it ends with "+N more" when there is more). Questions waiting on you come first, then each task with its next step, then what finished today. It shows your home folder as `~` and hides the credential forms it knows (such as `token=...`, `Bearer ...` and common key prefixes); a secret in another shape is not recognised, so keep secrets out of the board. The Hermes Agent skill runs it for you and sends what it prints as it is.

**Work in it, as in the pane.** Run `node ~/.agent-board/agent-board.mjs --watch` in a terminal beside the agent (a split pane):

| Key | Does |
|---|---|
| ↑ ↓, Enter | Pick a line, open it |
| `x` | Tick the next step of your own task; it goes into the work log |
| `a` | Archive one of your own tasks, or a stopped session's block |
| `1`–`9`, `y` / `n` | Copy the answer to another agent's question, to paste in that agent |
| `c` | Copy a command, or the command that reopens the session that asked |
| `h`, `u` | Mark another agent's question already answered: hidden on this computer, nothing sent; show the hidden ones again |
| `i` | Show or fold the tasks idle more than 7 days |
| `o`, `q` | Open the browser view; quit |

Finished work leaves the board by itself. The board writes `progress.md` as carefully as the pane does, and leaves other sessions' blocks alone unless you archive one that has stopped.

<table>
<tr><th width="50%">Codex CLI</th><th width="50%">Antigravity CLI</th></tr>
<tr>
<td><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/board/codex-en-dark.svg"><img alt="The terminal board with a Codex CLI question open; y or n copies the answer. Synthetic data." src="docs/images/board/codex-en-light.svg" width="100%"></picture></td>
<td><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/board/antigravity-en-dark.svg"><img alt="The terminal board with an Antigravity CLI question open; 1 or 2 copies the answer. Synthetic data." src="docs/images/board/antigravity-en-light.svg" width="100%"></picture></td>
</tr>
</table>

The terminal board, drawn by the board's own code from synthetic data. Native hook evidence is [recorded separately](docs/validation/2026-10-19-native-hooks.md).

### The board's page

The board commands above open the board as a page in your browser (in a chat app they print plain text instead, with no link). From any terminal, `node ~/.agent-board/agent-board.mjs --serve` does the same; run it again to bring the page back. On the page you can:

- **Answer** a question: **Send** to a session that is online, or **Copy** the reply.
- **Tick** your next step, **archive** a task, or **Archive now** to clear everything finished.
- **Already answered, hide** a question you answered in its own chat: hidden on this computer until that session asks something new; nothing is sent.
- **Paste a block** from a web chat such as Muse or dot.

The page listens on 127.0.0.1 only, and its address carries a random key: anything on this computer that has the link can use it. It keeps running after you close the tab; **Close the board** stops it. Add `--lan` to open it on a phone on the same Wi-Fi: that link is plain HTTP and anyone who has it can use the page, so use it only on a network you trust. Details and limits are in [the guide](docs/GUIDE.md#the-boards-page).

## Commands

These commands belong to the optional Claude Code pane. Other agents use the board commands above.

| Type | To |
|---|---|
| `/progress` | Open the pane |
| `/progress connect` | Connect your other agents now and see what changed; each session also does this on its own (`/progress connect remove` takes the hooks out and stops it) |
| `+ project: title due 11-20; step; step` | Add a task of your own, in the pane's box (or `/progress add …`) |
| `/progress open` | See it in the browser |
| `/progress report` / `/progress today` | Copy the last 7 days / today as text |
| `/progress notify on` / `off` | Desktop notifications |
| `/progress lang en` | `en`, `zh-TW`, `zh-CN` or `auto` |
| `/progress tidy` | Archive finished work now, and stopped work past its [age](docs/GUIDE.md#how-it-keeps-itself-tidy) |

## Colours and marks

The pane follows Claude Code's theme. Run `/config`, choose **Theme**: a light theme gives the pane its light colours, any other the dark ones. `progress.html` follows your computer's light or dark mode. Both sets are traditional Japanese colours, picked so every word stays readable.

| Mark | Means | | Mark | Means |
|:-:|---|---|:-:|---|
| ● | Waiting on you | | ◐ | Running, or waiting on someone else |
| ▸ | Doing now | | ! | Stuck |
| ○ | To do | | ⚑ | Due within two weeks |
| ✓ | Done | | – | Cancelled |

Press **Legend** at the bottom of the pane to see this list there.

## FAQ

<details>
<summary><b>Can I start from only one agent?</b></summary>

Start from any supported agent with the common installer. No second AI product is required. Native hook availability varies by host; the board and explicit own-progress reporter are shared.
</details>

<details>
<summary><b>I installed it from Codex (or another agent). Can that agent see Claude Code's work?</b></summary>

Yes, when those sessions report to the same local progress file. Independent reporters write their own blocks without Claude Code; the optional Claude pane reads that file too. Opening a board is separate from enabling direct messages.
</details>

<details>
<summary><b>I switched to a new computer. Do I lose everything?</b></summary>

Nothing is lost, but nothing moves by itself either: `progress.md`, the inbox and the hooks live on each computer. On the new one, use the common installer and restart your agents. To bring your history along, copy your selected `progress.md` and the `progress-archive-*.md` and `progress-journal-*.md` files beside it.

To share one board between two computers, set `CLAUDE_PROGRESS_FILE` on both to the same file in a synced folder (OneDrive, Dropbox, iCloud). This works best when you use one computer at a time: two computers writing at once can leave your sync app with a conflicted copy.
</details>

<details>
<summary><b>An agent doesn't show up.</b></summary>

1. Run `node scripts/setup-agent.mjs` to preview the current host and read any conflict or `adapter-pending` result.
2. Reload the host as required, complete only its scoped native hook trust/enablement, and read that state back.
3. Have that session report its own proven native id; check its exact block and timestamp. Never invent a task for another session.
4. Observe a new native lifecycle event separately from the explicit report. A progress record does not imply direct messaging; see [connection checks](docs/MESSAGING.md#connecting-a-session-that-was-already-open).

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

Send private or security-sensitive reports through GitHub's [Report a vulnerability](https://github.com/WenyuChiou/agent-board/security/advisories/new). See [SECURITY.md](SECURITY.md) for details.
</details>

<details>
<summary><b>Does anything leave my machine? What does it cost?</b></summary>

Independent reporters retain selected session metadata locally and do not call a summarization model. Sending a message to an online agent uses the target agent’s model and allowance. The following model and conversation access applies to the optional Claude plugin flow: Board files are stored locally. Through your own Claude Code login/model access, turn summaries send prompt and reply text to Claude Haiku; titles send the session's first request plus step names; and handoff lines send up to 6,000 characters of a compaction summary. The pane's side-question box also sends your question to the model over the session's transcript through that same login. These calls use that account's allowance or billing. The pane runs `git branch --show-current` and, if GitHub's `gh` is installed, uses it to check your pull request and CI state. By default, replies require an exact online session. Legacy Codex/Grok process resumption requires explicit `--allow-resume` and uses that agent’s permissions and network. The independent OpenClaw plugin disables conversation access; the optional Claude connector instead sets `allowConversationAccess: true`.

`--serve` listens on loopback (`127.0.0.1`) by default; any program on this computer that has the link can use it. `--serve --lan` shares the page on your private network through an HTTP link with a token. The token is an access key, not encryption: anyone on that network with the LAN link can read the board, change board files (including importing blocks) and stop the server. The LAN page refuses replies that would start an agent and omits resume commands. A private network address does not make a café or hotel network trusted. Do not share the link or QR code. Use the page's **Close** button to stop serving; if a reply is running, wait and try again. Closing the tab alone leaves the local service running; idle shutdown is opt-in. A new token is issued each time the board server or its LAN listener restarts, so stopping it makes its old link useless. See [SECURITY.md](SECURITY.md) for file changes, processes, network access and the limits of `--chat` redaction.
</details>

<details>
<summary><b>Does it work on Windows?</b></summary>

The local board runs on macOS, Linux and Windows. Native hooks and messaging depend on the host and surface; see the support table. Independent Windows hooks use Node without `sh`.
</details>

<details>
<summary><b>I used it as <code>claude-progress-pane</code> before.</b></summary>

The plugin was renamed in 0.10.0 and doesn't move over by itself. Run the steps in [Coming from the old name](docs/GUIDE.md#coming-from-the-old-name). Your `progress.md` stays as it is.
</details>

<details>
<summary><b>How do I uninstall it?</b></summary>

Independent setup: close the board, preview `node ~/.agent-board/agent-board.mjs --codex-remove --agent <name>`, then add `--apply` after review. Progress and history remain. For the optional Claude plugin:

```sh
claude -p "/progress connect remove"
claude plugin uninstall agent-board@agent-board
claude plugin marketplace remove agent-board
```

The first line disconnects the other agents; finish any reported cleanup before uninstalling. Your history, reporter scripts and inbox stay. See the guide's [complete uninstall procedure](docs/GUIDE.md#update-and-uninstall) for retries, recovery if you already uninstalled, and the retained files and their locations.
</details>

More answers are in the guide's [Troubleshooting](docs/GUIDE.md#troubleshooting).

## Documentation

- [Guide](docs/GUIDE.md): setup script, reading the pane, every command, other agents, tidying, troubleshooting
- [File format](docs/FORMAT.md): how `progress.md` is written, for anything that wants to write to it
- [AGENTS.md](AGENTS.md): the code's layout, and the section any agent can follow to report by hand
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

[MIT](LICENSE). Agent logos are from [Simple Icons](https://simpleicons.org) (CC0) and [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT) and belong to their owners; an agent without a logo is shown by its initial.

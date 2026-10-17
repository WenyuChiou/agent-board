<h1 align="center">
<img alt="A short tour: five agents, and the one that needs you; answering from the pane; every agent reporting through its own hooks; nothing lost; where it runs; its light and dark colours." src="docs/images/tour-en.svg" width="100%">
</h1>

<p align="center">
<b>See what every AI coding agent is doing, with whatever is waiting on you at the top.</b><br>
A Claude Code plugin that also follows Codex, Gemini CLI, OpenCode, Grok Build, Hermes Agent and OpenClaw (each tested live), with more in the table below.
</p>

<p align="center">
<a href="CHANGELOG.md"><img alt="Version 0.18.0" src="https://img.shields.io/badge/version-0.18.0-blue"></a>
<a href="#quick-start"><img alt="Needs Claude Code 2.1.287 or newer" src="https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.287-d97757"></a>
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green"></a>
<img alt="macOS, Linux, Windows" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey">
</p>
<p align="center">
<a href="#supported-agents"><img alt="Tested live with Codex 0.163.0" src="https://img.shields.io/badge/Codex-0.163.0-brightgreen"></a>
<a href="#supported-agents"><img alt="Tested live with Gemini CLI 0.64.0" src="https://img.shields.io/badge/Gemini%20CLI-0.64.0-brightgreen"></a>
<a href="#supported-agents"><img alt="Tested live with OpenCode 1.19.3" src="https://img.shields.io/badge/OpenCode-1.19.3-brightgreen"></a>
<a href="#supported-agents"><img alt="Tested live with Grok Build 1.0.62" src="https://img.shields.io/badge/Grok%20Build-1.0.62-yellowgreen"></a>
<a href="#supported-agents"><img alt="Tested live with Hermes Agent 0.19.0" src="https://img.shields.io/badge/Hermes%20Agent-0.19.0-yellowgreen"></a>
<a href="#supported-agents"><img alt="Tested live with OpenClaw 2026.10.4" src="https://img.shields.io/badge/OpenClaw-2026.10.4-yellowgreen"></a>
</p>

<p align="center">English · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.zh-CN.md">简体中文</a></p>

You have Claude Code on one project, Codex on another, Gemini on a third. Twenty minutes in, one of them stops to ask you something, and you only find out when you happen to switch back. **Agent Board** puts that question in front of you the moment it's asked, with a button for each answer.

## Supported agents

### At a glance

**Works fully**: its turns show up on the board by themselves, and the board opens inside it; both tested live.
- **Claude Code** 2.1.302 (the pane)
- **Codex** 0.163.0 (`$agent-board`)
- **Gemini CLI** 0.64.0 (`/board`)
- **OpenCode** 1.19.3 (`/board`)

**Works in part**: the limit follows each name.
- **Grok Build** 1.0.62: turns tested; the board command inside it (`/agent-board`) not tested yet
- **Hermes Agent** 0.19.0: both work; a one-off `hermes -q` question shows as stopped, not waiting
- **OpenClaw** 2026.10.4: both work; needs 2026.4.24 or newer, and warns about the plugin's origin
- **dot**, **Muse** on the web, **any other agent**: no hook, so you paste a prompt and merge what it writes; no board inside it

**Not working yet**: **Cursor** (its hook was blocked on Windows; macOS and Linux not tested), **Muse Code** CLI (not tested), **Antigravity** (no turn-end hook).

The table below has the details per capability.

✅ works, tested live · ⚠️ works, with the limit in the last column · ❔ written from the agent's docs, not tested yet · ❌ does not work · the agent badges at the top: green works fully, yellow-green works in part

| | Agent | Its turns on the board | The board inside it | Tested on | What to know |
|:-:|---|:-:|:-:|---|---|
| <img src="docs/images/agents/claude-code.svg" width="24" alt=""> | **Claude Code** | ✅ | ✅ the pane | 2.1.302 | Every session shows up by itself; answer a question with one click |
| <img src="docs/images/agents/codex.svg" width="24" alt=""> | **Codex** | ✅ | ✅ `$agent-board` | 0.163.0 | Approve the hook once in Codex's `/hooks` |
| <img src="docs/images/agents/gemini-cli.svg" width="24" alt=""> | **Gemini CLI** | ✅ | ✅ `/board` | 0.64.0 | Gemini asks once before `/board` runs its command |
| <img src="docs/images/agents/opencode.svg" width="24" alt=""> | **OpenCode** | ✅ | ✅ `/board` | 1.19.3 |  |
| <img src="docs/images/agents/grok-build.svg" width="24" alt=""> | **Grok Build** | ✅ | ❔ `/agent-board` | 1.0.62 |  |
| <img src="docs/images/agents/hermes-agent.svg" width="24" alt=""> | **Hermes Agent** | ⚠️ | ✅ `/agent-board` | 0.19.0, 0.16.0 (Windows) | Answer `y` once. A one-off `hermes -q` question shows as stopped, not waiting |
| <img src="docs/images/agents/openclaw.svg" width="24" alt=""> | **OpenClaw** | ⚠️ | ✅ `/agent-board` | 2026.10.4 | Needs 2026.4.24 or newer; an older one is left out, and connect says so. It warns it "can't verify where this plugin came from" and loads it anyway |
| <img src="docs/images/agents/cursor.svg" width="24" alt=""> | **Cursor** | ❌ | ❔ `/agent-board` | cursor-agent 2026.10.16 (Windows) | Not seen working: on Windows, Cursor runs every hook through bash, and another tool's PowerShell hook blocked the turn. macOS and Linux not tested |
| <img src="docs/images/agents/muse-code.svg" width="24" alt=""> | **Muse Code** | ❔ | ❔ |  | The hook is written from its docs; Muse was tried only on the web (next rows) |
|  | **Antigravity** | ❌ | ❔ `/agent-board` |  | No turn-end hook yet, so it can only show the board |
|  | **dot**, **Muse** on the web | ⚠️ | ❌ | web, Oct 2026 | No hook: paste [one prompt](docs/REMOTE_REPORTERS.md#chat-relay-a-prompt-to-paste) into the chat, then merge each block it writes |
|  | **Any other agent** (Aider, Copilot, Windsurf…) | ⚠️ | ❌ |  | Paste one section of [AGENTS.md](AGENTS.md) into its instructions; it writes its own block |

The board inside another agent shows everything, as printed text to read: nothing in it can be clicked. To tick, archive or copy an answer, run the [board you work in](#the-board-in-every-agent) in a terminal beside it. Answering a question happens in the agent that asked it (the pane gives you the words or command to paste). "Tested on" is the version that ran a real turn whose hook fired and whose block the pane drew; those payloads are kept as tests. Here is the board reading them:

<img alt="The board listing the question each of six agents asked in its live run: Codex, Gemini CLI, OpenClaw, OpenCode, Grok Build, Hermes Agent" src="docs/images/live/hooks-en.png" width="620">

## Quick start

**1. Install** (needs Claude Code 2.1.287 or newer):

```
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
```

**2. Open Claude Code.** The pane sits on the right (type `/progress` if you don't see it). On its first start it connects every coding agent installed on this machine and tells you which; an agent you install later is connected the same way, the next time Claude Code starts.

**3. Restart your other agents** once, so they load the new hook. The first time, Codex asks you to approve it in `/hooks`, and Hermes Agent asks you to answer `y`. From then on every agent's turn appears within a few seconds.

<details>
<summary><b>Or let an agent install it for you</b></summary>

Paste this into Codex, Gemini CLI, Cursor, Grok, Hermes, Muse, or any agent that can run commands:

```text
Install the Agent Board plugin for Claude Code and connect this machine's coding agents to it.
Run these three commands in order, and stop and tell me if one fails:
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
claude -p "/progress connect"
Then show me what the last command printed and tell me which agents to restart.
```

</details>

## What you get

- **Whatever needs you comes first.** A question from any agent sits at the top with a button for each answer. In Claude Code, one click answers it; for other agents you get the exact words or command to paste.
- **Every agent in one place.** Grouped by project, with a title, a line of background and numbered steps for each session, written for you by a quick summary of each turn.
- **Pick up where you left off.** Compaction, a closed terminal, the next morning: you see what's done, what's stuck and what's next. A session that stopped halfway can be taken over in one click.
- **Your own to-dos too.** Type `+ Job search: Fabrikam fellowship due 11-20` in the pane's box. Due dates turn the row amber, then red.
- **Outside the terminal.** `/progress open` shows the same view in your browser (it works on a phone too). The status line and desktop notifications tell you when something needs you while the pane is closed.
- **Reports.** `/progress report` and `/progress today` copy what got done, as text.
- **Tidies itself.** Finished work moves to a monthly archive; a journal keeps every finished step.
- **One plain Markdown file.** Everything is in `~/.claude/progress.md`, which you can read and edit. English, 繁體中文 and 简体中文; light and dark.

## The board in every agent

Connecting also gives each agent a way to show the board, so whichever one you are in, you see what all of them are doing:

| In | Type |
|---|---|
| Gemini CLI, OpenCode | `/board` |
| Codex | `$agent-board` |
| Cursor, Grok Build, OpenClaw, Hermes Agent, Antigravity | `/agent-board` |
| Any terminal, next to any agent | `node ~/.claude/agent-board.mjs --watch` (`--html` opens it in the browser) |

**Work in it, as in the pane.** In a terminal beside the agent (a split pane), `node ~/.claude/agent-board.mjs --watch` is the board you can act on: ↑↓ picks a line, Enter opens it, `x` ticks the next step of your own task, `a` archives one of your own tasks or a stopped session’s block (finished work leaves the board by itself), `1`–`9` (or `y`/`n`) copies the answer to another agent's question so you paste it there, `c` copies a command, `o` opens the browser view, `q` quits. Ticks go into the work log. It writes `progress.md` the careful way the pane does: through a temporary file, read back, and made again if another session wrote meanwhile; it never touches another session's block, except to archive one that has stopped.

<img alt="Codex on the left; on the right the board, where x just ticked a step and the line under the keys says so" src="docs/images/live/work-zh-TW.png" width="100%">


<table><tr>
<td><img alt="Codex CLI 0.163.0: typing $agent-board runs the board script and shows the board" src="docs/images/live/codex-en.png"></td>
<td><img alt="Gemini CLI 0.64.0: /board pastes the board into the prompt" src="docs/images/live/gemini-en.png"></td>
</tr></table>

Screenshots from real runs of Codex 0.163.0 and Gemini CLI 0.64.0 against a mock model; more, OpenCode's and the terminal's, are in the [guide](docs/GUIDE.md#the-board-in-every-agent). The board is read from `progress.md`, so it needs no Claude Code session; it runs on Node.js 18 or newer, which Codex and Gemini CLI install with them (for the other agents, install Node if `node --version` finds none). Other agents' turns are summed up into steps only while a Claude Code session is open; until then the board lists them as they came in.

## Commands

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

## How it works

<img alt="Claude Code sessions, other agents through their hooks, and you all write one Markdown file, progress.md; the pane, progress.html, the archive and the status line read it." src="docs/images/flow-en.svg" width="100%">

Each connected agent's hook saves its last reply into `~/.claude/progress-inbox/`. An open Claude Code session picks it up within five seconds, sums the turn up, writes it into that agent's own block in `progress.md`, and deletes the file. The format is in [docs/FORMAT.md](docs/FORMAT.md).

## FAQ

<details>
<summary><b>Do I need other agents, or does it work with Claude Code alone?</b></summary>

It works with Claude Code alone. Every Claude Code session shows up by itself; connecting other agents is optional.
</details>

<details>
<summary><b>I installed it from Codex (or another agent). Can that agent see Claude Code's work?</b></summary>

Yes. The plugin lives in Claude Code, but connecting gives every agent its board command (see [The board in every agent](#the-board-in-every-agent)), and the board reads the one file every agent writes to. Keep a Claude Code session open somewhere if you want other agents' turns summed up into steps.
</details>

<details>
<summary><b>I switched to a new computer. Do I lose everything?</b></summary>

Nothing is lost, but nothing moves by itself either: `progress.md`, the inbox and the hooks live on each computer. On the new one, run the three install commands and restart your agents. To bring your history along, copy `~/.claude/progress.md` and the `progress-archive-*.md` and `progress-journal-*.md` files beside it.

To share one board between two computers, set `CLAUDE_PROGRESS_FILE` on both to the same file in a synced folder (OneDrive, Dropbox, iCloud). This works best when you use one computer at a time: two computers writing at once can leave your sync app with a conflicted copy.
</details>

<details>
<summary><b>An agent doesn't show up.</b></summary>

1. Run `/progress connect` again and read what it prints: it names every agent it connected and any config file it could not edit.
2. Restart that agent; hooks load when it starts. Codex needs the hook approved in `/hooks`, and Hermes Agent asks once.
3. Keep a Claude Code session open: the pane reads the inbox only while one is running. Turns that arrive meanwhile wait there for up to two days.
4. Close every Claude Code session (an open one reads each file and deletes it within seconds), then check `~/.claude/progress-inbox/`. If no file appears after a turn, the hook didn't run; if one does, open an issue with it.
</details>

<details>
<summary><b>Does anything leave my machine? What does it cost?</b></summary>

`progress.md`, the inbox and `progress.html` stay on your computer. Turns are summed up by Claude Haiku through your own Claude Code login: one short call per turn of another agent, or of a Claude Code session that keeps no Task list. If GitHub's `gh` is installed, the pane asks it for the state of your pull request. Nothing else is sent anywhere. See [SECURITY.md](SECURITY.md).
</details>

<details>
<summary><b>Does it work on Windows?</b></summary>

Yes: macOS, Linux and Windows, in the terminal, the desktop app and VS Code. On Windows the hooks run a PowerShell script, so they need no `sh`.
</details>

<details>
<summary><b>I used it as <code>claude-progress-pane</code> before.</b></summary>

The plugin was renamed in 0.10.0 and doesn't move over by itself. Run the steps in [Coming from the old name](docs/GUIDE.md#coming-from-the-old-name). Your `progress.md` stays as it is.
</details>

<details>
<summary><b>How do I uninstall it?</b></summary>

```
claude -p "/progress connect remove"
claude plugin uninstall agent-board@agent-board
claude plugin marketplace remove agent-board
```

The first line takes the hooks out of your other agents. `progress.md` stays.
</details>

More answers are in the guide's [Troubleshooting](docs/GUIDE.md#troubleshooting).

## Documentation

- [Guide](docs/GUIDE.md): setup script, reading the pane, every command, other agents, tidying, troubleshooting
- [File format](docs/FORMAT.md): how `progress.md` is written, for anything that wants to write to it
- [AGENTS.md](AGENTS.md): the code's layout, and the section any agent can follow to report by hand
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

[MIT](LICENSE). Agent logos are from [Simple Icons](https://simpleicons.org) (CC0) and belong to their owners; agents without a free logo are shown by their initial.

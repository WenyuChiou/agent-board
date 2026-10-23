<h1 align="center">Agent Board</h1>

<p align="center"><b>See what every AI coding agent is doing, and answer the one that needs you, from one board.</b></p>

<p align="center">
<img alt="An animated board in six scenes: Claude Code, Codex, Antigravity and OpenCode report to one terminal board; their steps tick off live; Codex's question jumps to the top; one key copies the answer; a message written on the board's page reaches Codex and its reply shows, a preview coming in 0.24.1; and one npx command connects every agent, on npm from 0.24.0. Synthetic data." src="docs/images/cover-en-dark.svg" width="860">
</p>

<p align="center"><b>Integrations</b><br>
<a href="#supported-agents"><img src="docs/images/agents/chip-claude-code.svg" height="28" alt="Claude Code"></a>
<a href="#supported-agents"><img src="docs/images/agents/chip-codex.svg" height="28" alt="Codex"></a>
<a href="#supported-agents"><img src="docs/images/agents/chip-antigravity.svg" height="28" alt="Antigravity"></a>
<a href="#supported-agents"><img src="docs/images/agents/chip-opencode.svg" height="28" alt="OpenCode"></a>
<a href="#supported-agents"><img src="docs/images/agents/chip-cursor.svg" height="28" alt="Cursor"></a>
<a href="#supported-agents"><img src="docs/images/agents/chip-grok-build.svg" height="28" alt="Grok Build"></a>
<a href="#supported-agents"><img src="docs/images/agents/chip-muse-code.svg" height="28" alt="Muse Code"></a>
<a href="#supported-agents"><img src="docs/images/agents/chip-hermes-agent.svg" height="28" alt="Hermes Agent"></a>
<a href="#supported-agents"><img src="docs/images/agents/chip-openclaw.svg" height="28" alt="OpenClaw"></a>
<a href="#supported-agents"><img src="docs/images/agents/chip-deepseek-harness.svg" height="28" alt="DeepSeek Harness"></a>
</p>

<p align="center"><sub>dot and other web chats report by hand: you paste their block into <a href="#the-boards-page">the board's page</a>.</sub></p>

<p align="center"><a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green"></a></p>

<p align="center">English · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.zh-CN.md">简体中文</a></p>

You have Claude Code on one project, Codex on another and Antigravity on a third, and when one of them stops to ask you something, you only find out when you happen to switch back. **Agent Board** puts that question in front of you the moment it's asked, with a button for each answer. It runs on your computer and keeps everything in one Markdown file.

## Quick start

With Node.js 22+, in any terminal:

```sh
npx @wenyuchiou/agent-board setup
npx @wenyuchiou/agent-board setup --apply
npx @wenyuchiou/agent-board --serve
```

The first command finds the agents on this computer and shows what setup would change, writing nothing. The second makes the change, and the third opens the board's page. To set up one agent only, add `--agent` and its name, such as `--agent codex`. More in the [setup guide](docs/SETUP.md#install-with-npm).

Then:

- Start a new session of each agent: a session that was already open is not connected.
- **Claude Code** connects through its plugin instead: `claude plugin marketplace add WenyuChiou/agent-board`, then `claude plugin install agent-board@agent-board`.
- **Codex:** trust its hooks in `/hooks` ([how](docs/CODEX.md)).
- **OpenCode, OpenClaw:** reload their plugins.
- **dot and other web chats:** paste [the last section of AGENTS.md](AGENTS.md#report-your-progress-to-the-progress-pane) into the agent's instructions, then paste the block it writes into [the board's page](#the-boards-page).

<details>
<summary><b>Without npm: install from a checkout</b></summary>

To install from a clone of this repository instead, with Node.js 18+:

```sh
git clone https://github.com/WenyuChiou/agent-board.git
cd agent-board
node scripts/setup-agent.mjs
node scripts/setup-agent.mjs --apply
```

`setup-agent.mjs` takes the same options as `npx @wenyuchiou/agent-board setup`, such as `--agent codex`. On Windows, use the exact paths it prints. What each one writes: [setup guide](docs/SETUP.md).

</details>

<details>
<summary><b>Let an agent install it</b></summary>

Paste this into the agent you already use:

```text
Install Agent Board from https://github.com/WenyuChiou/agent-board on this computer.
Read its AGENTS.md, README and setup guide. Identify my current host and the other installed coding agents, then preview the common installer: node scripts/setup-agent.mjs.
Preserve existing settings and the shared progress path. Follow my approval requirements for persistent changes, then apply the applicable hooks, plugins and board command. Do not require or call another AI product to bootstrap this one.
Complete any required scoped host trust, read the settings back, and have this session report its own real task progress. Open the interactive board.
Verify actual hook events separately for CLI, desktop App and IDE. Installed files, transport acceptance and an ACK are different from a working progress connection.
Tell me which existing sessions need reload and which adapters remain unsupported or unverified. Never scan private conversations or silently skip a blocker.
```

</details>

## Key commands

### Open the board in your agent

| | Agent | Board command |
|:-:|---|---|
| <img src="docs/images/agents/claude-code.svg" width="20" alt="Claude Code"> | Claude Code | `/progress` |
| <img src="docs/images/agents/codex.svg" width="20" alt="Codex"> | Codex CLI and App | `$agent-board` |
| <img src="docs/images/agents/antigravity.svg" width="20" alt="Antigravity"> | Antigravity | `/agent-board` (not verified yet) |
| <img src="docs/images/agents/opencode.svg" width="20" alt="OpenCode"> | OpenCode | `/board` |
| <img src="docs/images/agents/cursor.svg" width="20" alt="Cursor"> | Cursor | `/agent-board` (not verified yet) |
| <img src="docs/images/agents/grok-build.svg" width="20" alt="Grok Build"> | Grok Build | `/agent-board` (not verified yet) |
| <img src="docs/images/agents/muse-code.svg" width="20" alt="Muse Code"> | Muse Code | `/agent-board` (not verified yet) |
| <img src="docs/images/agents/hermes-agent.svg" width="20" alt="Hermes Agent"> | Hermes Agent | `/agent-board` |
| <img src="docs/images/agents/openclaw.svg" width="20" alt="OpenClaw"> | OpenClaw | `/agent-board` |
| <img src="docs/images/agents/deepseek-harness.svg" width="20" alt="DeepSeek Harness"> | DeepSeek Harness | `/agent-board` (not verified yet) |

**In the Claude desktop app,** which cannot show the pane, the footer shows the board's status and `/progress` gives you a link to [the board's page](#the-boards-page), where you can answer questions and archive work; if that page cannot start, it opens the read-only page. The board page needs the board script that `/progress connect` installs, or the next session start updates.

### Open the board anywhere

| Where | Command |
|---|---|
| Any terminal | `node ~/.agent-board/agent-board.mjs --watch` (`--html` opens it in the browser) |
| A browser | `node ~/.agent-board/agent-board.mjs --serve` |
| A chat app, through an agent (Hermes Agent, OpenClaw) | `node ~/.agent-board/agent-board.mjs --chat` |
| Check one agent's setup | `node ~/.agent-board/agent-board.mjs --codex-doctor --agent codex` |

**In a chat app,** `--chat` prints the board as plain text cut to fit one message, with no page or link. It shows your home folder as `~` and hides the credential forms it knows, such as `token=...`; a secret in another shape is not recognised, so keep secrets out of the board.

<details>
<summary><b>Keys on the terminal board</b></summary>

**In a terminal,** `--watch` works like the pane:

| Key | Does |
|---|---|
| ↑ ↓, Enter | Pick a line, open it |
| `x` | Tick the next step of your own task; it goes into the work log |
| `d` | Confirm one of your own tasks, or a stopped session's work, done |
| `a` | Archive one of your own tasks, or a stopped session's block |
| `1`–`9`, `y` / `n` | Copy the answer to another agent's question, to paste in that agent |
| `c` | Copy a command, or the command that reopens the session that asked |
| `h`, `u` | Mark another agent's question already answered: hidden on this computer, nothing sent; show the hidden ones again |
| `i` | Show or fold the tasks idle more than 7 days |
| `o`, `q` | Open the browser view; quit |

Finished work leaves the board by itself. The board writes `progress.md` as carefully as the pane does, and leaves other sessions' blocks alone unless you archive one that has stopped or confirm it done.

</details>

## Supported agents

| | Agent | Runs in | On the board | Reply from the board |
|:-:|---|---|---|---|
| <img src="docs/images/agents/claude-code.svg" width="20" alt="Claude Code"> | Claude Code | CLI | Its own pane: every task and turn | In the pane |
| <img src="docs/images/agents/codex.svg" width="20" alt="Codex"> | Codex | CLI, App | Six hooks, plus the steps it reports | Copy; send to a [connected session](docs/MESSAGING.md#codex-exclusive-owner-adapter) |
| <img src="docs/images/agents/antigravity.svg" width="20" alt="Antigravity"> | Antigravity | CLI, App, IDE | Four hooks, plus the steps it reports | Copy; send to a [connected CLI](docs/MESSAGING.md#antigravity-exclusive-owner-cli-stream) |
| <img src="docs/images/agents/opencode.svg" width="20" alt="OpenCode"> | OpenCode | CLI | Session events, plus steps from its progress tool | Copy |
| <img src="docs/images/agents/cursor.svg" width="20" alt="Cursor"> | Cursor | IDE, CLI | Hooks | Copy |
| <img src="docs/images/agents/grok-build.svg" width="20" alt="Grok Build"> | Grok Build | CLI | Four hooks | Copy; `--allow-resume` once a session ended |
| <img src="docs/images/agents/muse-code.svg" width="20" alt="Muse Code"> | Muse Code | CLI | Two hooks (stop, end) | Copy |
| <img src="docs/images/agents/hermes-agent.svg" width="20" alt="Hermes Agent"> | Hermes Agent | Chat | The board and its skill; its own hooks are still to come | Copy |
| <img src="docs/images/agents/openclaw.svg" width="20" alt="OpenClaw"> | OpenClaw | Chat | Its plugin's session events | Copy |
| <img src="docs/images/agents/deepseek-harness.svg" width="20" alt="DeepSeek Harness"> | DeepSeek Harness | CLI | Its plugin's session events | Copy |
| | dot, other web chats | Web | A block you paste | Answer in its chat |

Hooks say whether a session is working or waiting; its steps and when it is done come from the agent's own reports. Gemini CLI is still a target (`--agent gemini`) for paid and enterprise use: see [setup](docs/SETUP.md#legacy-gemini-cli-compatibility).

<details>
<summary><b>How each agent was checked</b></summary>

| Agent | Checked |
|---|---|
| Claude Code | Claude Code 2.1.301 in CI |
| Codex | 0.163.0-alpha.10.2 app-server ([record](docs/validation/2026-10-19-native-hooks.md)); CLI in the 0.23.5 live run; App untested |
| Antigravity | CLI on Windows ([record](docs/validation/2026-10-19-native-hooks.md)); the App opens the board but does not report a question yet (#285); IDE untested |
| OpenCode | Plugin SDK 1.19.3 ([record](docs/validation/2026-10-19-portable-hosts.md)) |
| Cursor | Untested |
| Grok Build | 1.0.62 with a mock model |
| Muse Code | Untested |
| Hermes Agent | 0.19.0 with a mock model |
| OpenClaw | Source contract and synthetic callbacks ([record](docs/validation/2026-10-19-portable-hosts.md)); app untested |
| DeepSeek Harness | Plugin loader ([record](docs/validation/2026-10-19-portable-hosts.md)); app untested |
| dot, other web chats | Untested |

"With a mock model" means the real agent ran against a stand-in model. A live run of 0.23.5 in each app is in the [parity record](docs/validation/2026-10-20-parity-0.23.5.md): there a question from Codex CLI or OpenCode did not reach the board (fixed after 0.23.5, #213), and neither did one from the Antigravity app (#285).

</details>

## What you see

- **Answer the one that is waiting.** A question from any agent sits at the top, with a button for each answer. Once you turn messaging on ([`--messages-dir`](docs/MESSAGING.md#enable-locally)), **Send** reaches a session that has a live connection; otherwise **Copy** gives you the reply to paste into its chat.
- **Check the others are still moving.** Each agent's task shows its current step and when it last reported. Work nobody has touched for a week folds into one **N idle 7+ days** line.
- **Clear what is finished or dead.** Finished work moves to a monthly archive by itself. A session that stopped halfway can be archived, confirmed done or taken over.
- **Tell an agent something without going there.** Type a reply on the board: with messaging on, it goes straight to that session if it is connected; otherwise the board copies it for you to paste.

**The terminal board** (`--watch`), with Codex's question open: `y` or `n` copies the answer.

<img alt="The terminal board with a Codex CLI question open; y or n copies the answer. Synthetic data." src="docs/images/board/codex-en-dark.svg">

**Claude Code's pane**, beside the chat: the same board, with the question's answers as buttons.

<img alt="Claude Code's progress pane: counts of what is waiting, in progress, due soon and done today, then the question waiting on you, a release plan, with a button for each answer, a box for another reply, a button to hide it once answered, and a line for the 4 more waiting on you. Synthetic data." src="docs/images/pane-en-dark.svg">

Both pictures are drawn by the board's own code from synthetic data. Native hook evidence is [recorded separately](docs/validation/2026-10-19-native-hooks.md).

### The board's page

The board commands above open the board as a page in your browser (in a chat app they print plain text instead, with no link). From any terminal, `node ~/.agent-board/agent-board.mjs --serve` does the same; run it again to reopen the page. On the page you can:

- **Answer** a question: **Send** to a session that is online (with messaging on), or **Copy** the reply.
- **Tick** your next step, **archive** a task, or **Archive now** to clear everything finished.
- **Already answered, hide** a question you answered in its own chat: hidden on this computer until that session asks something new; nothing is sent.
- **Paste a block** from a web chat such as Muse or dot.

The page listens on 127.0.0.1 only, and its address carries a random key: anything on this computer that has the link can use it. It keeps running after you close the tab; **Close the board** stops it. Add `--lan` to open it on a phone on the same Wi-Fi: that link is plain HTTP and anyone who has it can use the page, so use it only on a network you trust. Details and limits are in [the guide](docs/GUIDE.md#the-boards-page).

## How it works

<img alt="Claude Code sessions, other agents through their hooks, and you all write one Markdown file, progress.md; the pane, progress.html, the archive and the status line read it. Synthetic data." src="docs/images/flow-en.svg" width="100%">

Each agent's hooks write what its session is doing into its own block of one local `progress.md` (a fresh install uses `~/.agent-board/progress.md`). Task steps come only from the agent's own reports, and no private conversation is read. The board reads the file without calling a model; the optional Claude plugin can sum up turns with Claude's model, as [the guide says](docs/GUIDE.md#does-anything-leave-my-machine-what-does-it-cost). You can read and edit the file too: [the file format](docs/FORMAT.md). In English, 繁體中文 and 简体中文.

## Troubleshooting

Start with the doctor. It checks what the installer wrote for one agent and changes nothing:

```sh
node ~/.agent-board/agent-board.mjs --codex-doctor --agent codex
```

Use the agent's own name after `--agent` (the doctor keeps its old name for every agent). `installed` says the files are in place and `ready` that the agent has a status adapter. `connected` stays `unverified`: only a new session that shows up on the board proves the connection.

| You see | Try |
|---|---|
| An agent is not on the board | Start a new session of it; one that was already open is not connected. Codex also needs its hooks trusted in `/hooks`. |
| Nothing changed after installing | Run `npx @wenyuchiou/agent-board setup` again without `--apply` (from a checkout: `node scripts/setup-agent.mjs`) and read its conflicts and `adapter-pending` lines; edited files are left alone and listed there. |
| An old version is still running | A running session keeps the version it loaded: start a new one. To update, see [the guide](docs/GUIDE.md#update-and-uninstall). |
| An agent shows up twice | It may be connected both ways: by the Claude plugin's `/progress connect` and by setup. `/progress connect status` lists what the plugin connected; remove one with `/progress connect remove` or `--codex-remove --agent <name>`. |
| A question will not go away | Answer it in its own chat, then press **Already answered, hide** (`h`). After 3 days it moves into **Earlier unanswered questions**, and after 7 days into **Older unanswered questions**. |

More answers are in the guide's [FAQ](docs/GUIDE.md#faq) and [Troubleshooting](docs/GUIDE.md#troubleshooting). Found a bug? Open an issue with the [bug form](https://github.com/WenyuChiou/agent-board/issues/new?template=bug_report.yml), paste the doctor's output, and follow the guide's [safe-report steps](docs/GUIDE.md#reporting-a-problem-safely): no session ids, home-folder paths or tokens.

<details>
<summary><b>Colours and marks</b></summary>

The pane follows Claude Code's theme (`/config`, then **Theme**); the page and `progress.html` follow your computer's light or dark mode until you pick Light or Dark at the top right of the page. Every mark has its own shape, so it reads without colour; the pages draw a step still to do as a small dot rather than a ring, so it does not look like a button:

| Mark | Means | | Mark | Means |
|:-:|---|---|:-:|---|
| ● | Waiting on you | | ◐ | Running, or waiting on someone else |
| ▸ | Doing now | | ! | Stuck |
| ○ • | To do (a ring in the pane, a small dot on the pages) | | ⚑ | Due within two weeks |
| ✓ | Done | | – | Cancelled |

</details>

## Documentation

| Read | For |
|---|---|
| This README | The first five minutes |
| [Guide](docs/GUIDE.md) | Daily use, keys, the page, update and uninstall, FAQ, troubleshooting |
| [Setup](docs/SETUP.md) | What the installer writes for each agent |
| [Codex](docs/CODEX.md) · [Messaging](docs/MESSAGING.md) · [File format](docs/FORMAT.md) · [Local exchange](docs/LOCAL-EXCHANGE.md) · [Remote reporters](docs/REMOTE_REPORTERS.md) | Reference |
| [AGENTS.md](AGENTS.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) | Working on the code; how a non-Claude agent reports by hand |

## License

[MIT](LICENSE). Agent logos are from [Simple Icons](https://simpleicons.org) (CC0) and [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT) and belong to their owners; an agent without a logo is shown by its initial.

<p align="center"><sub>Version 0.23.5 · <a href="CHANGELOG.md">Changelog</a></sub></p>

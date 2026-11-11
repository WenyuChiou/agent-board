<h1 align="center"><img alt="Agent Board" src="docs/images/brand/agent-board-logo.svg" width="360"></h1>

<p align="center"><b>A board that shows which AI agent is waiting on you.</b></p>

<p align="center"><a href="CHANGELOG.md"><img alt="Version" src="https://img.shields.io/github/package-json/v/WenyuChiou/agent-board?label=version"></a> <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green"></a> <a href="https://github.com/WenyuChiou/agent-board/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/WenyuChiou/agent-board/actions/workflows/test.yml/badge.svg"></a> <a href="https://www.npmjs.com/package/@wenyuchiou/agent-board"><img alt="npm" src="https://img.shields.io/npm/v/@wenyuchiou/agent-board"></a></p>

<p align="center">English · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
<img alt="An animated 40-second tour. One command starts the board, agents report their steps, a question from Claude Code jumps to the top, and the answer is sent from the board. Synthetic data." src="docs/images/cover-en-dark.svg" width="860">
</p>

Claude Code, Codex, Antigravity and other AI agents report to one board on your computer. When one stops to ask you something, its question goes to the top within seconds, so you stop hunting through windows. One Markdown file, no account.

## Quick start

With Node.js 22+, in any terminal:

```sh
npx @wenyuchiou/agent-board@next setup
npx @wenyuchiou/agent-board@next
```

- `setup` shows what it will change and asks once before it writes.
- Then open a new session of your agent and type `/agent-board` (`$agent-board` in Codex; Cursor has no such command, so use the second command).
- Per-agent steps, language, options and other ways to install: [setup guide](docs/SETUP.md#after-setup-per-agent).

## What you get

- **Questions first.** A question an agent is waiting on goes to the top, with a button for each option it can read, or you write your own answer.
- **Every agent stays where it is.** Agents keep running in their own terminals; the board reads what their hooks report.
- **Local and plain.** One Markdown file you can read and edit, a page on 127.0.0.1 only, and no model calls by the board.
- **One command to install, one to remove.** `setup` shows what it will change before it writes; `remove` takes out what setup wrote and leaves your own settings alone.

<img alt="The board's page: Needs you shows a question from Claude Code with answer buttons; Working now lists tasks from Codex, Antigravity and OpenCode with their steps. Synthetic data." src="docs/images/page-en-dark.png" width="860">

## Supported agents

### In a terminal (command line)

| | Agent | Open the board | Your reply reaches it |
|:-:|---|---|---|
| <img src="docs/images/agents/claude-code.svg" width="28" alt="Claude Code"> | Claude Code | `/agent-board` | At once (confirmed) |
| <img src="docs/images/agents/codex.svg" width="28" alt="Codex"> | Codex | `$agent-board` | At its next turn |
| <img src="docs/images/agents/antigravity.svg" width="28" alt="Antigravity"> | Antigravity | `/agent-board` | At its next turn |
| <img src="docs/images/agents/cursor.svg" width="28" alt="Cursor"> | Cursor | The second Quick start command | You paste it |
| <img src="docs/images/agents/opencode.svg" width="28" alt="OpenCode"> | OpenCode | `/agent-board` | You paste it |
| <img src="docs/images/agents/grok-build.svg" width="28" alt="Grok Build"> | Grok Build | `/agent-board` | You paste it |
| <img src="docs/images/agents/hermes-agent.svg" width="28" alt="Hermes Agent"> | Hermes Agent | Ask it for the `agent-board` skill | You paste it |

### In a desktop app or IDE

| | Agent | Open the board | Your reply reaches it |
|:-:|---|---|---|
| <img src="docs/images/agents/claude-code.svg" width="28" alt="Claude Code"> | Claude Code | The pane beside its chat | Not yet |
| <img src="docs/images/agents/codex.svg" width="28" alt="Codex"> | Codex | Board page (second command) | Not yet |
| <img src="docs/images/agents/antigravity.svg" width="28" alt="Antigravity"> | Antigravity | Board page (second command) | Not tested yet |
| <img src="docs/images/agents/cursor.svg" width="28" alt="Cursor"> | Cursor | Board page (second command) | Not tested yet |
| <img src="docs/images/agents/opencode.svg" width="28" alt="OpenCode"> | OpenCode | Board page (second command) | Not yet |

- Board page: run the second Quick start command in any terminal, the app's own included.
- dot and other web chats report by hand: [how](docs/REMOTE_REPORTERS.md#chat-relay-a-prompt-to-paste).

## Answer from the board

<img alt="Three ways an answer from the board reaches its agent: Send to Claude Code, queue for the next turn of Antigravity or Codex, or copy for Cursor, OpenCode, Grok Build and Hermes. Synthetic data." src="docs/images/answer-en.svg" width="100%">

An answer to an agent's question and a message you send it travel the same way, by the button you press:

- **Send** hands it to a connected session; a confirmation from that session means it was received. With no confirmation it may still have arrived, so look at the agent before you use **Copy answer**, or it may get it twice. Send needs [messaging on](docs/MESSAGING.md#local-storage).
- **Queue for the agent's next turn** holds it until that session's next turn, does not wake an idle one, and can be rejected if the session ends first or its 12-hour mailbox expires.
- **Copy answer** puts it on your clipboard to paste into that agent.
- Answered in the agent's own window? Press **Already answered, hide** to clear the card.

## Open it anywhere

<img alt="The same board in a browser, in a terminal and in the pane beside Claude Code's chat; a phone on the same Wi-Fi can use it but not send. Synthetic data." src="docs/images/places-en.svg" width="100%">

| Where | How |
|---|---|
| In an agent | `/agent-board` (`$agent-board` in Codex) |
| A terminal | `npx @wenyuchiou/agent-board`: the terminal board in an interactive terminal over SSH or on Linux with no display, unless an agent's setting such as `HERMES_HOME` or `OPENCODE_CONFIG_DIR` is set in that shell; plain text in CI; the page everywhere else. `--watch` gives the terminal board in any interactive terminal |
| A phone on the same Wi-Fi | `npx @wenyuchiou/agent-board --lan` and scan the QR code. The phone can look, tick, archive and close the board, but cannot send an answer (it shows the answer to copy). Use it on a network you trust: the link is not encrypted and anyone who has it can open the page |
| An agent reading the board | `npx @wenyuchiou/agent-board --json` ([fields](docs/BOARD-JSON.md)) |

## How it works

<img alt="Agents' hooks report into progress.md, one file on your computer that you can read and edit; the page, the terminal board and the pane read it. No account, no model call by the board. Synthetic data." src="docs/images/flow-en.svg" width="100%">

Each agent's hooks write what its session is doing into its own block of one local `progress.md` (a fresh install uses `~/.agent-board/progress.md`; [the format](docs/FORMAT.md)). The page listens on 127.0.0.1 only and needs no account. The board does not call a model; what the optional Claude Code plugin can send out is in [the guide](docs/GUIDE.md#does-anything-leave-my-machine-what-does-it-cost).

## Update and remove

Run `npx @wenyuchiou/agent-board@next setup` again to see what an update would change, then `setup --apply`; files you edited are left alone. To remove what setup wrote:

```sh
npx @wenyuchiou/agent-board@next remove
npx @wenyuchiou/agent-board@next remove --apply
```

Your history stays beside `progress.md`; [Update and uninstall](docs/GUIDE.md#update-and-uninstall) lists what is kept, and a few small cache files can be left behind. For the shorter `agent-board` command, run `npm install -g @wenyuchiou/agent-board@next` once.

## Troubleshooting

| You see | Try |
|---|---|
| An agent is not on the board | Start a new session of it; one that was already open is not connected. For Codex, preview `npx @wenyuchiou/agent-board --codex-trust --codex-bin "<path-to-codex>" --json` with Codex's full path, review it, then add `--apply` only if you approve. Codex CLI also offers `/hooks`. |
| Nothing changed after installing | Run `npx @wenyuchiou/agent-board@next setup` again without `--apply` (from a checkout: `node scripts/setup-agent.mjs`). Read the conflicts and Next steps; edited files are left alone and listed there. |
| If the board looks old | A session that was already open may still run the version it loaded: start a new session of that agent. To update, see [the guide](docs/GUIDE.md#update-and-uninstall). |
| An agent shows up twice | It may be connected both by the Claude plugin and by setup: [what to remove](docs/GUIDE.md#troubleshooting). |

To check Claude Code's setup, run `claude plugin list` and `/progress connect status`. More answers: the guide's [FAQ](docs/GUIDE.md#faq) and [Troubleshooting](docs/GUIDE.md#troubleshooting). Found a bug? Open the [bug form](https://github.com/WenyuChiou/agent-board/issues/new?template=bug_report.yml) and follow the [safe-report steps](docs/GUIDE.md#reporting-a-problem-safely): no session ids, home-folder paths or tokens.

## Documentation

| Read | For |
|---|---|
| [Guide](docs/GUIDE.md) | Daily use, keys, the page, settings, update and uninstall, FAQ |
| [Setup](docs/SETUP.md) | What the installer writes for each agent |
| [Codex](docs/CODEX.md) · [Messaging](docs/MESSAGING.md) · [File format](docs/FORMAT.md) · [Remote reporters](docs/REMOTE_REPORTERS.md) | Reference |
| [AGENTS.md](AGENTS.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) | Working on the code; how a non-Claude agent reports by hand |

## License

[MIT](LICENSE). Agent logos are from [Simple Icons](https://simpleicons.org) (CC0) and [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT) and belong to their owners; an agent without a logo is shown by its initial.

<p align="center"><a href="CHANGELOG.md"><img alt="Source version 0.24.3" src="https://img.shields.io/badge/source-0.24.3-blue"></a><br><sub>Latest stable version: 0.24.2 · 0.24.3 is a pre-release (<code>npx @wenyuchiou/agent-board@next setup</code>) · <a href="CHANGELOG.md">Changelog</a>.</sub></p>

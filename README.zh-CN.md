<h1 align="center">
<img alt="导览动画：五个 agent 里哪个在等你；在面板上回答；各家用自己的 hook 汇报；什么都不会丢；在哪里能用；深浅两组和色配色。" src="docs/images/tour-zh-CN.svg" width="100%">
</h1>

<p align="center">
<b>每个 AI coding agent 在做什么，一个面板看完；等你的事，永远排第一个。</b><br>
Claude Code 插件，也跟得上 Codex、Gemini CLI、Cursor、OpenCode、Grok Build、Hermes Agent、Muse Code 和 OpenClaw。
</p>

<p align="center">
<a href="https://github.com/WenyuChiou/agent-board/actions/workflows/test.yml"><img alt="测试" src="https://github.com/WenyuChiou/agent-board/actions/workflows/test.yml/badge.svg"></a>
<a href="CHANGELOG.md"><img alt="版本 0.16.1" src="https://img.shields.io/badge/version-0.16.1-blue"></a>
<a href="LICENSE"><img alt="MIT 许可" src="https://img.shields.io/badge/license-MIT-green"></a>
<img alt="macOS、Linux、Windows" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey">
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-TW.md">繁體中文</a> · 简体中文</p>

你在一个项目开 Claude Code，另一个开 Codex，第三个开 Gemini。二十分钟后，其中一个停下来问你事情，你要等到刚好切回去才会发现。**Agent Board** 在它一开口就把问题放到你眼前，每个答案一个按钮。

## 支持的 agent

| | Agent | 怎么汇报 | 你要做一次的事（会自动接上） | 实测过 |
|:-:|---|---|---|---|
| <img src="docs/images/agents/claude-code.svg" width="24" alt=""> | **Claude Code** | 内置：每个对话都会出现，有没有 Task 清单都行 | 不用做什么 | ✅ 2.1.302 |
| <img src="docs/images/agents/codex.svg" width="24" alt=""> | **Codex** | `Stop` hook | 到 Codex 的 `/hooks` 批准一次 | ✅ |
| <img src="docs/images/agents/gemini-cli.svg" width="24" alt=""> | **Gemini CLI** | `AfterAgent` hook | 不用做什么 | ✅ 0.64.0 |
| <img src="docs/images/agents/opencode.svg" width="24" alt=""> | **OpenCode** | 插件，在 `session.idle` 时 | 不用做什么 | ✅ 1.19.3 |
| <img src="docs/images/agents/grok-build.svg" width="24" alt=""> | **Grok Build** | `Stop` hook | 不用做什么 | ✅ 1.0.62 |
| <img src="docs/images/agents/hermes-agent.svg" width="24" alt=""> | **Hermes Agent** | `post_llm_call` shell hook | Hermes 第一次问时回答 `y` | ✅ 0.19.0 |
| <img src="docs/images/agents/openclaw.svg" width="24" alt=""> | **OpenClaw** | 插件，在 `agent_end` 时 | 不用做什么 | ✅ 2026.10.4 |
| <img src="docs/images/agents/cursor.svg" width="24" alt=""> | **Cursor** | `afterAgentResponse` hook | 不用做什么 | 按 Cursor 文档实现 |
| <img src="docs/images/agents/muse-code.svg" width="24" alt=""> | **Muse Code** | `Stop` hook | 不用做什么 | 按 Muse 文档实现 |
| | **Antigravity** | 还不会汇报（没有回合结束的 hook） | 不用做什么：它会有 `/agent-board` 看看板 | 按它的文档实现 |
| | **dot** | 本地交换（自行选用） | 见 [docs/LOCAL-EXCHANGE.md](docs/LOCAL-EXCHANGE.md) | 只测过文件约定 |
| | **其他 agent**（Aider、Copilot、Windsurf…） | 自己写一块进度 | 把 [AGENTS.md](AGENTS.md) 的一段贴进它的说明文件 | |

“实测过”是指：真的 CLI 跑了一个回合，它的 hook 有触发，面板也从中画出正确的一块进度。那些真实数据都留在测试里。

## 快速开始

**1. 安装**（需要 Claude Code 2.1.287 以上）：

```
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
```

**2. 打开 Claude Code。** 面板在右边（没看到就输入 `/progress`）。第一次打开时，它会自动接上这台电脑装的所有 coding agent，并告诉你接了哪些；之后才装的 agent，下次打开 Claude Code 时也会自动接上。

**3. 重启其他 agent 一次**，让它们加载新的 hook。第一次时，Codex 要在 `/hooks` 里批准，Hermes Agent 会问你一次，回答 `y`。之后每个 agent 的回合几秒内就会出现。

<details>
<summary><b>或者让 agent 帮你装</b></summary>

把下面这段贴给 Codex、Gemini CLI、Cursor、Grok、Hermes、Muse，或任何能运行命令的 agent：

```text
帮我在这台电脑装 Claude Code 的 Agent Board 插件，并把这台电脑上的 coding agent 接上它。
依次运行这三行，任何一行失败就停下来告诉我：
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
claude -p "/progress connect"
最后把最后一行打印的内容给我看，并告诉我要重启哪些 agent。
```

</details>

## 功能

- **需要你的事排最前面。** 任何 agent 的问题都放在最上面，每个答案一个按钮。在 Claude Code 里点一下就回答了；其他 agent 则给你要贴过去的那句话或命令。
- **所有 agent 一处看。** 按项目分组，每个对话都有标题、一行背景和编号步骤，由每个回合的简短摘要自动写好。
- **随时接着做。** 对话压缩、终端关掉、第二天早上都没关系：做完什么、卡在哪、下一步是什么，打开就看到。做到一半停掉的对话，点一下就能接手。
- **你自己的待办也放得进来。** 在面板的输入框打 `+ 求职：Fabrikam 研究员 截止 11-20`。快到期会变黄，到期会变红。
- **不在终端也看得到。** `/progress open` 在浏览器打开同一个画面（手机也行）。面板关着时，状态栏和桌面通知会告诉你有事在等你。
- **周报。** `/progress report` 和 `/progress today` 把做完的事复制成文字。
- **自己清理。** 做完的事移到每月归档文件，日志留下每一步完成记录。
- **就是一个 Markdown 文件。** 全部在 `~/.claude/progress.md`，你可以自己看、自己改。支持 English、繁體中文、简体中文；浅色深色都有。

## 每个 agent 里都看得到看板

接上时，每个 agent 也会拿到一个看看板的命令。不管你在哪一个里面，都看得到全部 agent 在做什么：

| 在 | 输入 |
|---|---|
| Gemini CLI、OpenCode | `/board` |
| Codex | `$agent-board` |
| Cursor、Grok Build、OpenClaw、Hermes Agent、Antigravity | `/agent-board` |
| 任何终端，开在任何 agent 旁边 | `node ~/.claude/agent-board.mjs --watch`（`--html` 在浏览器打开） |

<table><tr>
<td><img alt="Codex CLI 0.163.0：输入 $agent-board，运行看板脚本并显示看板" src="docs/images/live/codex-zh-TW.png"></td>
<td><img alt="Gemini CLI 0.64.0：/board 把看板贴进提示" src="docs/images/live/gemini-zh-TW.png"></td>
</tr></table>

截图是 Codex 0.163.0 和 Gemini CLI 0.64.0 实际运行的画面（模型用的是测试用的假模型，界面语言为繁体中文）；OpenCode 和终端的截图在[使用说明](docs/GUIDE.zh-CN.md#每个-agent-里都看得到看板)。看板直接读 `progress.md`，不用开 Claude Code；它用 Node.js 18 以上运行，Codex 和 Gemini CLI 安装时就有（其他 agent 若 `node --version` 找不到，就装一下 Node）。其他 agent 的回合要有 Claude Code 对话开着才会整理成步骤；在那之前，看板照原样列出它们。

## 命令

| 输入 | 用途 |
|---|---|
| `/progress` | 打开面板 |
| `/progress connect` | 现在就接上其他 agent，并看看改了什么；每个对话开始时也会自动做（`/progress connect remove` 去掉 hook 并停止自动接） |
| `+ 项目：标题 截止 11-20；步骤；步骤` | 在面板输入框加一件自己的事（或用 `/progress add …`） |
| `/progress open` | 在浏览器看 |
| `/progress report` / `/progress today` | 复制最近 7 天／今天的进度 |
| `/progress notify on` / `off` | 桌面通知 |
| `/progress lang zh-CN` | `en`、`zh-TW`、`zh-CN` 或 `auto` |
| `/progress tidy` | 现在就归档旧的工作；多旧才算，见[使用说明](docs/GUIDE.zh-CN.md#它怎么保持整齐) |

## 颜色与符号

面板跟着 Claude Code 的主题走。输入 `/config`，选 **Theme**：选浅色主题，面板就用浅色那组颜色；其他主题用深色那组。`progress.html` 跟着你电脑的浅色或深色模式。两组都是日本传统色（和色），选来让每个字都清楚好读。

| 符号 | 意思 | | 符号 | 意思 |
|:-:|---|---|:-:|---|
| ● | 等你 | | ◐ | 在跑，或在等别人 |
| ▸ | 正在做 | | ! | 卡住 |
| ○ | 还没做 | | ⚑ | 两周内到期 |
| ✓ | 完成 | | – | 取消 |

点面板最下面的“说明”，面板里也会列出这张表。

## 怎么运作

<img alt="Claude Code 对话、通过 hook 的其他 agent、和你，都写进同一个 Markdown 文件 progress.md；面板、progress.html、归档与状态栏都读它。" src="docs/images/flow-zh-CN.svg" width="100%">

每个接上的 agent，hook 会把它最后的回复存进 `~/.claude/progress-inbox/`。开着的 Claude Code 对话五秒内读到，把那个回合整理好，写进 `progress.md` 里那个 agent 自己的一块，然后删掉那个文件。格式写在 [docs/FORMAT.md](docs/FORMAT.md)（英文）。

## 常见问题

<details>
<summary><b>一定要有其他 agent 吗？只用 Claude Code 可以吗？</b></summary>

可以。每个 Claude Code 对话都会自己出现；接上其他 agent 是可选的。
</details>

<details>
<summary><b>我是从 Codex（或其他 agent）装的，它看得到 Claude Code 在做什么吗？</b></summary>

看得到。插件装在 Claude Code 里，但接上时每个 agent 都会拿到看看板的命令（见[每个 agent 里都看得到看板](#每个-agent-里都看得到看板)），而看板读的就是所有 agent 共用的那个文件。想让其他 agent 的回合整理成步骤，就在某处开着一个 Claude Code 对话。
</details>

<details>
<summary><b>换了一台电脑，东西都没了吗？</b></summary>

不会没，但也不会自己搬过去：`progress.md`、收件箱和 hook 都只在各自的电脑上。在新电脑跑那三行安装命令，再重启 agent 就好。要带上以前的记录，就把 `~/.claude/progress.md` 和旁边的 `progress-archive-*.md`、`progress-journal-*.md` 复制过去。

想让两台电脑共用一个面板，就在两台都把 `CLAUDE_PROGRESS_FILE` 设成同步文件夹（OneDrive、Dropbox、iCloud）里的同一个文件。一次只用一台最稳：两台同时写，同步软件可能会留下冲突副本。
</details>

<details>
<summary><b>某个 agent 没出现。</b></summary>

1. 再运行一次 `/progress connect`，看它打印什么：它会列出接上了哪些 agent，以及哪些配置文件改不了。
2. 重启那个 agent，hook 是在启动时加载的。Codex 要在 `/hooks` 批准，Hermes Agent 会问一次。
3. 开着一个 Claude Code 对话：面板只在有对话开着时读收件箱。这段时间进来的回合会在那里等，最多两天。
4. 先关掉所有 Claude Code 对话（开着的对话几秒内就会读走并删掉文件），再看看 `~/.claude/progress-inbox/`。回合结束后没有新文件，就是 hook 没运行；有文件却没出现，请开 issue 附上那个文件。
</details>

<details>
<summary><b>会把数据传出去吗？要花多少钱？</b></summary>

`progress.md`、收件箱和 `progress.html` 都留在你的电脑上。回合的摘要由 Claude Haiku 通过你自己的 Claude Code 登录来做：其他 agent 每个回合一次简短调用，没有 Task 清单的 Claude Code 对话也是。装了 GitHub 的 `gh` 的话，面板会用它查你的 pull request 状态。其他什么都不会发出去。详见 [SECURITY.md](SECURITY.md)（英文）。
</details>

<details>
<summary><b>Windows 能用吗？</b></summary>

可以：macOS、Linux、Windows，在终端、桌面版和 VS Code 都行。Windows 上的 hook 运行的是 PowerShell 脚本，不需要 `sh`。
</details>

<details>
<summary><b>以前用的是 <code>claude-progress-pane</code>。</b></summary>

插件在 0.10.0 改了名，不会自己换过去。按[从旧名称换过来](docs/GUIDE.zh-CN.md#从旧名称换过来)的步骤做就好，`progress.md` 不会动。
</details>

<details>
<summary><b>怎么卸载？</b></summary>

```
claude -p "/progress connect remove"
claude plugin uninstall agent-board@agent-board
claude plugin marketplace remove agent-board
```

第一行会把其他 agent 里的 hook 去掉。`progress.md` 会留着。
</details>

更多问题请看使用说明的[问题排查](docs/GUIDE.zh-CN.md#问题排查)。

## 文档

- [使用说明](docs/GUIDE.zh-CN.md)：设置脚本、看懂面板、所有命令、其他 agent、自动整理、问题排查
- [文件格式](docs/FORMAT.md)（英文）：`progress.md` 怎么写，给任何想写进去的程序
- [AGENTS.md](AGENTS.md)（英文）：代码结构，以及任何 agent 都能照着手动汇报的那一段
- [更新记录](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md) · [安全性](SECURITY.md)

## 许可

[MIT](LICENSE)。agent 的图标来自 [Simple Icons](https://simpleicons.org)（CC0），商标属于各自的所有者；没有免费图标的 agent 以名字的第一个字母表示。

<h1 align="center"><img alt="Agent Board" src="docs/images/brand/agent-board-logo.svg" width="360"></h1>

<p align="center"><b>一块本机看板，告诉你哪个 AI agent 在等你回复</b></p>

<p align="center"><a href="CHANGELOG.md"><img alt="Version" src="https://img.shields.io/github/package-json/v/WenyuChiou/agent-board?label=version"></a> <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green"></a> <a href="https://github.com/WenyuChiou/agent-board/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/WenyuChiou/agent-board/actions/workflows/test.yml/badge.svg"></a> <a href="https://www.npmjs.com/package/@wenyuchiou/agent-board"><img alt="npm" src="https://img.shields.io/npm/v/@wenyuchiou/agent-board"></a></p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-TW.md">繁體中文</a> · 简体中文</p>

<p align="center">
<img alt="40 秒的动画导览：一行命令启动看板，各个 agent 汇报步骤，Claude Code 的提问跳到最上面，你在看板上发出回复。合成数据。" src="docs/images/cover-zh-CN-dark.svg" width="860">
</p>

Claude Code、Codex、Antigravity 等 AI agent 都向你电脑上的同一块看板汇报。哪个停下来问你，它的提问几秒内就排到最上面，不用再挨个窗口找。一个 Markdown 文件，不用账号。

## 快速开始

需要 Node.js 22 以上，在任何终端运行：

```sh
npx @wenyuchiou/agent-board@next setup
# 开一个 agent 的新对话后：
npx @wenyuchiou/agent-board@next
```

- `setup` 会先列出要改什么，问你一次才写入。
- 在新对话里输入 `/agent-board`（Codex 是 `$agent-board`；Hermes 让它执行 Agent Board skill），或运行第二个命令（Cursor 没有这种命令）。
- 各 agent 的步骤、语言、选项和其他安装方式：[安装指南](docs/SETUP.md#after-setup-per-agent)（英文）。

## 你会得到什么

- **提问排最前面。** agent 在等你回复的提问会排到最上面；它给的选项读得出来，就每个选项一个按钮，否则自己输入回复。
- **每个 agent 留在原来的地方。** agent 继续在自己的终端里运行，看板读的是它们 hooks 的汇报。
- **在本机、纯文本。** 一个你可以自己看、自己改的 Markdown 文件，只在 127.0.0.1 的网页，看板本身不调用模型。
- **一个命令装、一个命令卸载。** `setup` 写入前先列出要改什么；`remove` 去掉 setup 写的东西，不动你自己的设置。

<img alt="看板网页：“需要你”里是 Claude Code 的提问，附答案按钮；“进行中”列出 Codex、Antigravity 和 OpenCode 的任务和步骤。合成数据。" src="docs/images/page-zh-CN-dark.png" width="860">

## 支持的 agent

### 在终端（命令行）

| | Agent | 打开看板 | 你的回复怎么送到 |
|:-:|---|---|---|
| <img src="docs/images/agents/claude-code.svg" width="28" alt="Claude Code"> | Claude Code | `/agent-board` | 它空下来就发出 |
| <img src="docs/images/agents/codex.svg" width="28" alt="Codex"> | Codex | `$agent-board` | 下一轮起交给它，一轮一条 |
| <img src="docs/images/agents/antigravity.svg" width="28" alt="Antigravity"> | Antigravity | `/agent-board` | 下一轮起交给它，一轮一条 |
| <img src="docs/images/agents/cursor.svg" width="28" alt="Cursor"> | Cursor | 快速开始的第二个命令 | 你自己粘贴 |
| <img src="docs/images/agents/opencode.svg" width="28" alt="OpenCode"> | OpenCode | `/agent-board` | 你自己粘贴 |
| <img src="docs/images/agents/grok-build.svg" width="28" alt="Grok Build"> | Grok Build | `/agent-board` | 你自己粘贴 |
| <img src="docs/images/agents/hermes-agent.svg" width="28" alt="Hermes Agent"> | Hermes Agent | 让它执行 Agent Board skill | 你自己粘贴 |

### 在桌面 app 或 IDE

| | Agent | 打开看板 | 你的回复怎么送到 |
|:-:|---|---|---|
| <img src="docs/images/agents/claude-code.svg" width="28" alt="Claude Code"> | Claude Code | `/agent-board`（看板网页） | 暂不支持 |
| <img src="docs/images/agents/codex.svg" width="28" alt="Codex"> | Codex | 看板网页 | 暂不支持 |
| <img src="docs/images/agents/antigravity.svg" width="28" alt="Antigravity"> | Antigravity | 看板网页 | 尚未测试 |
| <img src="docs/images/agents/cursor.svg" width="28" alt="Cursor"> | Cursor | 看板网页 | 尚未测试 |
| <img src="docs/images/agents/opencode.svg" width="28" alt="OpenCode"> | OpenCode | 看板网页 | 暂不支持 |

- 看板网页：在终端运行 `npx @wenyuchiou/agent-board@next --html`，app 自带的终端也行。
- 暂不支持或尚未测试：从看板复制回复，粘贴到 app 里。
- dot 和其他网页版聊天要手动汇报：[怎么做](docs/REMOTE_REPORTERS.md#chat-relay-a-prompt-to-paste)（英文）。

## 在看板上回复

<img alt="看板上的回复送到 agent 的三条路：发送给 Claude Code、排到 Antigravity 或 Codex 的下一轮、或复制给 Cursor、OpenCode、Grok Build 和 Hermes。合成数据。" src="docs/images/answer-zh-CN.svg" width="100%">

回复 agent 的提问，和主动给它发消息，走的是同一条路，看你点哪个按钮：

- **发送**把它交给已连接的对话；对话回确认才代表收到。没有确认也可能已经送到，先看一下那个 agent 再用**复制回答**，免得它收到两次。发送需要[开启消息功能](docs/MESSAGING.md#local-storage)（英文）。
- **排入 agent 的下一回合**会留到那个对话的下一回合才送，一回合交一条，先排的先送，不会唤醒空闲中的对话；对话先结束，或它的邮箱满 12 小时过期，都可能被拒收。
- **复制回答**把它放进剪贴板，由你粘贴到那个 agent。
- 已经在 agent 自己的窗口里回复了？点**已回复，先隐藏**就能收掉这张卡。

## 在哪里都能开

<img alt="同一块看板，出现在浏览器、终端和 Claude Code 对话旁的面板；同一个 Wi-Fi 的手机也能用，只是不能发送。合成数据。" src="docs/images/places-zh-CN.svg" width="100%">

| 在哪里 | 怎么开 |
|---|---|
| agent 里 | `/agent-board`（Codex 是 `$agent-board`） |
| 终端 | `npx @wenyuchiou/agent-board`：在交互式终端里，通过 SSH 连接或在没有显示器的 Linux 上，开终端看板，但那个 shell 若设了 agent 的设置（例如 `HERMES_HOME`、`OPENCODE_CONFIG_DIR`）就开网页；CI 里打印纯文本；其他情况都开网页。在交互式终端加 `--watch` 一定开终端看板 |
| 同一个 Wi-Fi 的手机 | `npx @wenyuchiou/agent-board --lan`，扫它打印出的二维码。手机可以看、勾步骤、归档和关闭看板，但不能发送回复（它只显示回复让你复制）。请在信得过的网络使用：链接没有加密，拿到的人都能打开网页 |
| 让 agent 读看板 | `npx @wenyuchiou/agent-board --json`（[字段说明](docs/BOARD-JSON.md)，英文） |

## 怎么运作

<img alt="各 agent 的 hooks 汇报到 progress.md，这是你电脑上、你能看也能改的一个文件；网页、终端看板和面板都读它。不用账号，看板本身不调用模型。合成数据。" src="docs/images/flow-zh-CN.svg" width="100%">

每个 agent 的 hooks 把它的对话正在做什么，写进本机同一个 `progress.md` 里它自己的区块（全新安装用 `~/.agent-board/progress.md`；[文件格式](docs/FORMAT.md)，英文）。网页只监听 127.0.0.1，不用账号。看板不调用模型；可选的 Claude Code 插件会发出什么，见[使用指南](docs/GUIDE.zh-CN.md#会把数据传出去吗要花多少钱)。

## 更新和卸载

再运行一次 `npx @wenyuchiou/agent-board@next setup` 看更新会改什么，再加 `--apply` 应用；你改过的文件不会被覆盖。要卸载 setup 写的东西：

```sh
npx @wenyuchiou/agent-board@next remove
npx @wenyuchiou/agent-board@next remove --apply
```

你的记录会留在 `progress.md` 旁边；[更新和卸载](docs/GUIDE.zh-CN.md#更新和卸载)列出哪些会保留，另外可能留下几个小的缓存文件。想用较短的 `agent-board` 命令，运行一次 `npm install -g @wenyuchiou/agent-board@next`。

## 问题排查

| 你看到 | 试试 |
|---|---|
| 某个 agent 没出现在看板上 | 开一个它的新对话；原来就开着的不会接入。Codex 请以完整可执行文件路径运行 `npx @wenyuchiou/agent-board --codex-trust --codex-bin "<path-to-codex>" --json` 预览；先检查预览，确认同意后才加上 `--apply`。Codex CLI 也可使用 `/hooks`。 |
| 装完之后什么都没变 | 不加 `--apply` 再运行一次 `npx @wenyuchiou/agent-board@next setup`（用 git clone 的话是 `node scripts/setup-agent.mjs`），查看列出的冲突和接下来的步骤；你改过的文件不会被覆盖，会列在那里。 |
| 看板看起来是旧版 | 原来就开着的对话可能还在跑它加载时的版本：开一个那个 agent 的新对话。更新方式见[使用指南](docs/GUIDE.zh-CN.md#更新和卸载)。 |
| 同一个 agent 出现两次 | 可能同时被 Claude 插件和 setup 接入：[要去掉哪个](docs/GUIDE.zh-CN.md#问题排查)。 |

检查 Claude Code 的设置，请运行 `claude plugin list` 和 `/progress connect status`。更多答案在使用指南的[常见问题](docs/GUIDE.zh-CN.md#常见问题)和[问题排查](docs/GUIDE.zh-CN.md#问题排查)。发现 bug？用 [bug 表单](https://github.com/WenyuChiou/agent-board/issues/new?template=bug_report.yml)提一个 issue，并照[安全报告步骤](docs/GUIDE.zh-CN.md#安全地报告问题)做：不要带 session id、主目录路径或 token。

## 文档

| 读 | 用途 |
|---|---|
| [使用指南](docs/GUIDE.zh-CN.md) | 日常使用、按键、网页、设置、更新和卸载、常见问题 |
| [安装指南](docs/SETUP.md)（英文） | 安装器替每个 agent 写了什么 |
| [Codex](docs/CODEX.md) · [消息](docs/MESSAGING.md) · [文件格式](docs/FORMAT.md) · [远程报告](docs/REMOTE_REPORTERS.md)（均为英文） | 参考资料 |
| [AGENTS.md](AGENTS.md) · [参与贡献](CONTRIBUTING.md) · [安全](SECURITY.md)（均为英文） | 修改代码；非 Claude 的 agent 怎么手动报告 |

## 许可证

[MIT](LICENSE)。agent 的图标来自 [Simple Icons](https://simpleicons.org)（CC0）和 [Lobe Icons](https://github.com/lobehub/lobe-icons)（MIT），这些图标属于各自的所有者；没有图标的 agent 用名字的第一个字母表示。

<p align="center"><a href="CHANGELOG.md"><img alt="源代码版本 0.24.3" src="https://img.shields.io/badge/source-0.24.3-blue"></a><br><sub>最新稳定版本 0.24.2 · 0.24.3 是预发布版（<code>npx @wenyuchiou/agent-board@next setup</code>）· <a href="CHANGELOG.md">更新日志</a></sub></p>

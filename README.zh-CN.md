<h1 align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-zh-CN-dark.svg">
  <img alt="claude-progress-pane：给 coding agent 用的进度看板" src="docs/images/hero-zh-CN-light.svg" width="100%">
</picture>
</h1>

[English](README.md) · [繁體中文](README.zh-TW.md) · 简体中文

Claude Code 插件。一个面板看所有 coding agent 在做什么，最需要你的那件事放最上面。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/demo-zh-CN-dark.svg">
    <img alt="面板的三个画面：最需要你的问题，每个答案一个按钮；所有等你的事，按种类列好；回答之后，Claude 接着做。" src="docs/images/demo-zh-CN-light.svg">
  </picture>
</p>

## 和别人不一样的地方

- **需要你的事先说。** 问题、截止日期、卡住的工作放最上面，每个答案一个按钮，按了直接回给那个对话。
- **agent 不用记得汇报。** 进度来自各家自己的回合结束 hook：Claude Code、Codex、Gemini CLI、Cursor、OpenCode、Grok Build、Muse Code。每回合自动整理成步骤，agent 最后在问你的事会自动列进「等你」。
- **什么都不会丢。** 压缩时留一行交接；停掉的对话可以续接或接手；做完的工作自动移到每月归档文件。

## 安装

```
claude plugin marketplace add WenyuChiou/claude-progress-pane
claude plugin install project-progress@claude-progress-pane
claude -p "/progress connect"
```

最后一行会把这台电脑上的其他 agent 接上（Codex、Gemini CLI、Cursor、OpenCode、Grok Build、Muse Code）。重启那些 agent；Codex 第一次要在它的 `/hooks` 里批准。打开 Claude Code，面板会自己出现在右边。

**让任何 agent 帮你装。** 把这段贴给 Codex、Gemini CLI、Cursor、Grok、Muse，或任何能运行命令的 agent：

```text
帮我在这台电脑装 Claude Code 的 claude-progress-pane 插件，并把这台电脑上的 coding agent 接上它。
依次运行这三行，任何一行失败就停下来告诉我：
claude plugin marketplace add WenyuChiou/claude-progress-pane
claude plugin install project-progress@claude-progress-pane
claude -p "/progress connect"
最后把最后一行输出的内容给我看，并告诉我要重启哪些 agent。
```

没有 hook 的 agent（Aider、Copilot、Windsurf…）也能汇报：把 [AGENTS.md](AGENTS.md) 里「Report your progress to the progress pane」那段贴进它的说明文件。

## 用法

| | |
|---|---|
| 照常工作 | 每个对话都会出现，带着步骤、背景、在等什么 |
| `+ 求职：Fabrikam 研究员 截止 11-20` | 在面板的输入框：加一件自己的事 |
| `/progress open` | 在浏览器看同一个画面 |
| `/progress connect` | 把其他 agent 接上面板 |
| `/progress report` | 复制最近七天的进度 |
| `/progress lang zh-CN` | `en`、`zh-TW`、`zh-CN` 或 `auto` |

## 怎么运作

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/flow-zh-CN-dark.svg">
  <img alt="Claude Code 对话、通过 hook 的其他 agent、和你，都写进同一个 Markdown 文件 progress.md；面板、progress.html、归档与状态栏都读它。" src="docs/images/flow-zh-CN-light.svg" width="100%">
</picture>

全部都在一个 Markdown 文件：`~/.claude/progress.md`。格式公开：[docs/FORMAT.md](docs/FORMAT.md)（英文）。

## 更多

[使用说明](docs/GUIDE.zh-CN.md)（安装脚本、看懂面板、所有命令、自动整理、问题排查）· [参与贡献](CONTRIBUTING.md) · [更新记录](CHANGELOG.md) · [MIT](LICENSE)

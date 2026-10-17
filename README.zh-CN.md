<h1 align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/tour-zh-CN-dark.svg">
  <img alt="导览动画：五个 agent 里哪个在等你；在面板上回答；各家用自己的 hook 汇报；什么都不会丢；在哪里能用；深浅两组和色配色。" src="docs/images/tour-zh-CN-light.svg" width="100%">
</picture>
</h1>

[English](README.md) · [繁體中文](README.zh-TW.md) · 简体中文

**Agent Board** 给同时开好几个 AI coding agent 的人用。哪个 agent 在等你，一看就知道，不会再让它们干等。

## 为什么需要它

一个项目开 Claude Code，另一个开 Codex，可能还有一个在跑 Gemini。过了二十分钟，其中一个停下来问你事情，你却要等到刚好切回去才发现。这个面板会在它一开口的时候，就把问题放到你眼前。

- **再也不会漏掉问题。** 等你的事排在最上面，每个答案一个按钮，点下去 agent 就接着干。
- **你现在用的 agent 都接得上。** Claude Code、Codex、Gemini CLI、Cursor、OpenCode、Grok Build、Muse Code。一行命令接上，之后它们会自己汇报，不用另外交代。
- **随时都能接着做。** 对话压缩、终端关掉、第二天再开都没关系，做完什么、卡在哪、下一步是什么，打开就看到。谁做到一半停了，你也能直接接手。

## 安装

```
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
claude -p "/progress connect"
```

最后一行会把你电脑上其他的 agent 接上。接完把它们重启（Codex 第一次会请你在它的 `/hooks` 里点批准）。然后打开 Claude Code，面板就在右边。

**或者让 agent 帮你装。** 把下面这段贴给 Codex、Gemini CLI、Cursor、Grok、Muse，或任何能运行命令的 agent：

```text
帮我在这台电脑装 Claude Code 的 Agent Board 插件，并把这台电脑上的 coding agent 接上它。
依次运行这三行，任何一行失败就停下来告诉我：
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
claude -p "/progress connect"
最后把最后一行输出的内容给我看，并告诉我要重启哪些 agent。
```

用的是 Aider、Copilot 或 Windsurf？把 [AGENTS.md](AGENTS.md) 里「Report your progress to the progress pane」那段贴进它的说明文件，它也会汇报。

## 用法

| | |
|---|---|
| 照常干活就好 | 每个对话会自己出现：做到哪、为什么做、在等什么 |
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

所有东西都在一个 Markdown 文件里：`~/.claude/progress.md`，你也可以自己打开来改。格式写在 [docs/FORMAT.md](docs/FORMAT.md)（英文）。

## 更多

[使用说明](docs/GUIDE.zh-CN.md)（安装脚本、看懂面板、所有命令、自动整理、问题排查）· [参与贡献](CONTRIBUTING.md) · [更新记录](CHANGELOG.md) · [MIT](LICENSE)

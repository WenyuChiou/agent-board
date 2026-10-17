<h1 align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-en-dark.svg">
  <img alt="claude-progress-pane: a progress dashboard for coding agents" src="docs/images/hero-en-light.svg" width="100%">
</picture>
</h1>

English · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md)

A Claude Code plugin. One pane shows what every coding agent is doing, and puts the one thing that needs you on top.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/demo-en-dark.svg">
    <img alt="The pane in three steps: the question that needs you, with a button per answer; everything waiting on you, by kind; the pane after you answer, with Claude moving on." src="docs/images/demo-en-light.svg">
  </picture>
</p>

## Why it is different

- **What needs you comes first.** A question, a deadline or a stuck task, with a button per answer. The answer goes straight back to that session.
- **No agent has to remember to report.** Progress comes from each agent's own turn-end hook: Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Grok Build, Muse Code. Each turn is summed up into steps, and a question an agent ends on shows up as waiting on you.
- **Nothing gets lost.** A compaction leaves a handoff line. A stopped session can be resumed or taken over. Finished work moves to a monthly archive by itself.

## Install

```
claude plugin marketplace add WenyuChiou/claude-progress-pane
claude plugin install project-progress@claude-progress-pane
```

Start Claude Code and the pane opens on the right. To bring in your other agents, run `/progress connect` once.

## Use

| | |
|---|---|
| Work as usual | Each session shows up with its steps, its background and what it waits on |
| `+ Job search: Fabrikam fellowship due 11-20` | In the pane's box: a task of your own |
| `/progress open` | The same view in your browser |
| `/progress connect` | Hook your other agents into the pane |
| `/progress report` | Copy the last seven days as text |
| `/progress lang en` | `en`, `zh-TW`, `zh-CN` or `auto` |

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/flow-en-dark.svg">
  <img alt="Claude Code sessions, other agents through their hooks, and you all write one Markdown file, progress.md; the pane, progress.html, the archive and the status line read it." src="docs/images/flow-en-light.svg" width="100%">
</picture>

Everything is one Markdown file, `~/.claude/progress.md`. Its format is open: [docs/FORMAT.md](docs/FORMAT.md).

## More

[Guide](docs/GUIDE.md) (setup script, reading the pane, every command, tidying, troubleshooting) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT](LICENSE)

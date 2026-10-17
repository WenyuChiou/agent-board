# 使用说明

[English](GUIDE.md) · [繁體中文](GUIDE.zh-TW.md) · 简体中文 · [回到 README](../README.zh-CN.md)

## 开始使用

需要 Claude Code 2.1.287 或更高版本。在 2.1.301 和 2.1.302 上测试过。

### 1. 安装插件

在 Claude Code 终端对话的输入框里：

```
/plugin install project-progress --marketplace WenyuChiou/claude-progress-pane
```

回答 `y` 添加 marketplace，并选 user scope。或者从 shell 运行：

```
claude plugin marketplace add WenyuChiou/claude-progress-pane
claude plugin install project-progress@claude-progress-pane
```

### 2. 运行设置脚本

可以不做。它会做两项插件自己做不到的设置，可以重复运行。没运行也能用：没有 Task 清单的对话会一回合一回合自动整理。

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\plugins\marketplaces\claude-progress-pane\scripts\setup.ps1"
```

macOS / Linux：

```bash
bash ~/.claude/plugins/marketplaces/claude-progress-pane/scripts/setup.sh
```

它做的事：

- **打开 Task 工具。** 新模型要设了 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 才有 Claude Code 的 Task 工具，而面板就是跟着这些工具走。脚本把这个变量加进你的 shell 的 profile（PowerShell 是 `$PROFILE`；`~/.zshrc`、`~/.bashrc`、macOS 上是 `~/.bash_profile`，或 `~/.profile`）。不加进 `settings.json`：那里的 env 也会进到 Claude 桌面 app，而桌面 app 自己有一份待办清单。
- **打开自动更新**，这个 marketplace 的新版本会自己送到。你自己关掉的自动更新会保持关闭。
- **把旧的安装换过来**，如果你用过 zip 版。
- **帮你接上其他 agent（需要你开口）。** 加上 `--agents`（PowerShell 是 `-Agents auto`），它也会把汇报进度的说明交给 Codex、Gemini CLI 和 OpenCode（见[其他 agent](#其他-agent)）。

它改的每个文件都会先复制一份 `<文件名>.bak`。加上 `-NoInstall`（`--no-install`）可以跳过安装这一步。

### 3. 重新启动 Claude

打开一个**新的**终端窗口（让 profile 被读进去），运行 `claude`。面板会自己在右边打开。`/progress` 可以重新打开。

### 4. 照常工作

跟 Claude 说任何两步以上的事：

```
> 设置页加上深色模式，然后提 PR
```

Claude 会列出 Task 清单，面板跟着走：卡片显示任务、它的背景、进度条、正在做的步骤和下一步。Claude 需要你做决定时，问题会移到**现在最需要你**，附上对应的按钮。

### 5. 加入不是代码的事

在面板最下面的框里，输入一行以 `+` 开头的文字：

```
+ 求职：Fabrikam 研究资助 截止 11-20；改简历；投递
```

冒号前面是项目，`截止 MM-DD` 设定日期（到期前 14 天排进**快到期**），每个 `；` 开始一个步骤。也可以自己写进 `~/.claude/progress.md`（见[进度文件](#进度文件)）。

### 6. 打开窗口

```
/progress open
```

会在默认浏览器打开 `progress.html`。可以放在第二块屏幕上，它每 30 秒自己刷新一次。

### 7. 选语言

面板先看 Claude Code 的 `language` 设置，再看系统区域设置。要自己选：

```
/progress lang zh-CN        # 或 en、zh-TW、auto
```

或在 `/config` 里设置这个插件的 **Pane language**。

## 看懂面板

从上到下：

1. **数字。** `● 等你` · `▸ 进行中` · `⚑ 快到期` · `✓ 今天完成`。点每一个会展开它统计的那些项目。
2. **现在最需要你。** 一个最需要你处理的问题、截止日期或卡住的任务，写明它是关于什么、你可以怎么做。`还有 N 件等你 ▸` 会展开其余的。
3. **这个对话的卡片。** 项目和分支、任务、它的背景、进度条、当前的状况、正在做的步骤和下一步。`▸ 全部 N 步` 列出每一步，有编号，当前这步标着 `← 现在`。有 pull request 的话也显示在这里。
4. **折叠的区块。** 等你处理、快到期、其他进行中（按项目分组）、最近完成。点一行可以看它的步骤和可用的操作：**接手做完**（这个项目里已关闭的对话留下来的工作）、**复制续接指令**（在原来运行的地方重新打开那个对话）、**完成这步**和**交给 Claude**（你自己手动记的任务），两种都有**归档**，马上移出文件。
5. **输入框。** 问一句旁边的问题（在面板里回答，不打断 Claude），或以 `+` 开头添加任务。
6. **最下面一排。** 周报 · 通知：开／关 · 说明。

符号：

| 符号 | 意思 |
|---|---|
| `✓` | 完成 |
| `▸` | 正在做 |
| `○` | 还没做 |
| `●` | 等你 |
| `◐` | 在跑：CI、长时间运行的任务、别人 |
| `!` | 卡住 |
| `–` | 取消 |

## 命令

| 命令 | 作用 |
|---|---|
| `/progress` | 打开面板 |
| `/progress open` | 在浏览器打开 `progress.html` |
| `/progress connect` / `connect remove` | 把这台电脑上的其他 agent 接上面板／去掉 |
| `/progress add <line>` | 添加一件事，和在面板里输入 `+` 一样 |
| `/progress tidy` | 立刻归档做完的工作 |
| `/progress sync` | 重新读取 Claude 的 Task 清单和 PR |
| `/progress report` / `today` | 复制最近 7 天／今天的报告 |
| `/progress notify on` / `off` | 打开或关闭通知 |
| `/progress lang en` / `zh-TW` / `zh-CN` / `auto` | 选面板的语言 |

中文词也能用：`/progress 窗口`（或 `网页`）＝ `open`、`加`（或 `新增`）＝ `add`、`整理` ＝ `tidy`、`同步` ＝ `sync`、`周报` ＝ `report`、`今天` ＝ `today`、`通知 开`／`通知 关` ＝ `notify on`／`off`、`语言 zh-CN` ＝ `lang zh-CN`。

## 进度文件

所有内容都放在 `~/.claude/progress.md`（Windows 上是 `%USERPROFILE%\.claude\progress.md`；设置 `CLAUDE_PROGRESS_FILE` 可以改用别的路径）。它是可以直接读、直接改的纯 Markdown：

```markdown
# 项目进度

## acme-web

<!-- auto session=2be48af2 agent=claude state=waiting updated=2026-10-16T01:40:00Z pr=128 ci=pending -->
### 设置页加上深色模式
> 等你回复 · feat/dark-mode · PR #128 · CI 运行中
> 背景：上次问卷很多人要
- [x] 加深色的颜色 token
- [~] 修图表对比度
- [?] 上线方式 — 先用开关给部分用户，还是直接全部开放？
- [ ] 提 PR
<!-- /auto session=2be48af2 -->

## 求职

### Contoso 研究驻点
> 截止 10-31
- [x] 改简历
- [?] 推荐信 — 等李教授回复
- [ ] 投递
```

- 每个对话只改写自己的 `<!-- auto -->` 标记之间的行。其他一切（你手写的区段、笔记）一个字节都不动。
- 符号：`[x]` 完成、`[~]` 正在做、`[ ]` 还没做、`[?]` 等你、`[>]` 在跑、`[!]` 卡住、`[-]` 取消。` — ` 后面的文字是这一步的备注：它需要什么，或为什么卡住。
- `截止 MM-DD`（或 `due MM-DD`）写在任务上就有了日期：到期前 14 天排进快到期，3 天内变红。

给要读写这个文件的工具用的完整规范在 [docs/FORMAT.md](FORMAT.md)（英文）。

## 其他 agent

在 Claude Code 里运行一次，或在任何终端运行 `claude -p "/progress connect"`（所以任何 agent 都能帮你跑）：

```
/progress connect
```

它会找出这台电脑上装了哪些 agent，给每个装一个在回合结束时运行的 hook。hook 只做一件事：把 agent 交出来的内容（最后的回复，有给的话也包括你的提问）存进 `~/.claude/progress-inbox/`。开着的 Claude Code 对话几秒内就会读到，整理成那个 agent 自己的一块进度。agent 不用照什么说明做，也不用记得汇报。接上之后，重启那个 agent 才会生效。

| Agent | 改的文件 | 回合结束事件 |
|---|---|---|
| Codex | `~/.codex/hooks.json`（`$CODEX_HOME`） | `Stop`，第一次要在 Codex 的 `/hooks` 里批准 |
| Gemini CLI | `~/.gemini/settings.json` | `AfterAgent` |
| Cursor | `~/.cursor/hooks.json` | `afterAgentResponse`、`stop` |
| OpenCode | `~/.config/opencode/plugin/progress-pane.js` | `session.idle` |
| Grok Build | `~/.grok/hooks/progress-pane.json`（`$GROK_HOME`） | `Stop` |
| Muse Code | `~/.config/muse/settings.json` | `Stop` |

hook 运行的是 `/progress connect` 写好的 `~/.claude/progress-report.sh`（Windows 是 `progress-report.ps1`）。脚本：
- 不需要装任何东西；
- 永远返回 0；
- 什么都不输出，只有 Cursor 会输出 `{}`。

其他规则：
- 文件里你自己的 hook 会保留。
- 不是纯 JSON 的配置文件不会动，命令会告诉你是哪一个。
- 之前用 setup `--agents` 写进那个 agent 说明里的 AGENTS.md 段落会被去掉，免得同一件事出现两次。
- `/progress connect remove` 全部去掉。

要有 Claude Code 对话开着才会更新。都没开的时候，回合会先存在收件箱，超过两天的文件由汇报脚本自己清掉。

**其他 agent**（Aider、GitHub Copilot、Windsurf…）：把 [AGENTS.md](../AGENTS.md) 最后那段 **「Report your progress to the progress pane」** 贴进它的说明文件，它就会自己写一块。`setup.sh --agents`（`setup.ps1 -Agents auto`）会给还没接上的 Codex、Gemini CLI、OpenCode 做这件事。

## 它怎么保持整齐

| 项目 | 时机 |
|---|---|
| 做完的区块移到 `progress-archive-YYYY-MM.md` | 最后一次更新后 12 小时 |
| 其他区块也移到那里 | 最后一次更新后 3 天 |
| 手写、每一步都打勾的任务移到那里 | 面板第一次看到它做完后 24 小时 |
| 12 小时没有写入的对话 | 显示为对话已停；它的问题不再出现在现在最需要你 |
| 你在已停的对话或手记的任务按**归档** | 马上 |
| 归档后变空的 `##` 区段 | 会被移除；你自己留空的会保留 |

这个清理在对话开始时运行，之后每小时一次。`/progress tidy` 会立刻运行。

## 更新和卸载

自动更新打开时（设置脚本会帮你打开），新版本会自己送到。要手动更新：

```
claude plugin marketplace update claude-progress-pane
claude plugin update project-progress@claude-progress-pane
```

然后在运行中的对话里输入 `/reload-plugins`，或开新的对话。

要卸载：

```
claude plugin uninstall project-progress@claude-progress-pane
claude plugin marketplace remove claude-progress-pane
```

`progress.md`、它的归档文件和日志，以及 shell 的 profile 里那一行都会留着。

## 问题排查

- **面板说这个对话没有 Task 工具。** 运行设置脚本，然后从新的终端窗口启动 `claude`。一直拿不到这个变量的对话（桌面 app、Windows 上的 git-bash）还是可以手动维护 `progress.md`。
- **屏幕上没有面板。** 在终端的全屏布局里，面板从 144 列宽起会自己停靠在右边，用 `/progress` 的话从 110 列起。在 tmux 或 `CLAUDE_CODE_NO_FLICKER=0` 下，它会在输入框上方。云端对话不绘制面板。
- **PowerShell 警告执行策略。** PowerShell 要允许运行脚本才会执行你的 profile：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，然后再运行一次脚本。在那之前，这个变量会留在 `settings.json`。
- **私有 fork。** Claude Code 用你自己的 git 凭据 clone。运行一次 `gh auth login` 和 `gh auth setup-git`；没有 GitHub SSH key 的话，再设置 `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`。
- **你的组织统一管理 Claude Code。** 在那种环境里，你自己装的插件收不到系统提示的 hook。运行设置脚本时加 `-KeepRule`（`--keep-rule`），改把规则留在 `~/.claude/CLAUDE.md`。

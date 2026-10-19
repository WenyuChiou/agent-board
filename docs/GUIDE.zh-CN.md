# 使用指南

[English](GUIDE.md) · [繁體中文](GUIDE.zh-TW.md) · 简体中文 · [README](../README.zh-CN.md)

## 开始使用

使用 Node.js 18+ 与 repository checkout。永久变更先预览、批准再应用：

```sh
node scripts/setup-agent.mjs
node scripts/setup-agent.mjs --apply
```

自动检测识别 host 配置，不代表 session 在线。尚无配置的已知 host 可用 `--agent <name>`；`--agent all` 预览全部目标，不会安装 AI 应用。[安装说明](SETUP.md)列出路径与 adapter 范围。

新独立安装使用 `~/.agent-board/progress.md`，现有安装保留原文件；`--progress-file /absolute/path/progress.md` 可明确指定。普通本地安装不需选择另一台电脑的看板。

读回定义，完成 host 的信任／启用。Codex 可在用户批准后执行限定信任，详见 [Codex](CODEX.md)。已打开的 session 可能需要重新加载。CLI、桌面 App、IDE 分别验收。

## 其他 agent

共享安装器写入看板、skill 及已实现的原生 adapter，不需要 Claude Code 或另一个模型。[支持范围](SETUP.md#native-status-adapters)会区分已安装与待实现项目。

OpenClaw、DeepSeek Harness 已有独立状态 plugin 与原生 skill；Grok 新提示会切回工作中，OpenCode 遵循配置目录覆盖。[跨 host 验收](validation/2026-10-19-portable-hosts.md)区分隔离回调／SDK 检查与未执行的原生测试。hooks 不会安装收信通道；接到同一私有消息目录的 agent 共享回执与去重记录，任务归档不会清掉消息 ID。

原生 hooks 汇报活动，不推测任务步骤。Codex Stop、Antigravity Stop 代表等待下一轮，不是对话关闭或任务完成。原生新提示／启动会重新激活同一区块。任务标题、步骤、阻塞及完成由 agent 明确汇报，且只能绑定自身可证明的 session。缺少 host context 时，不猜 ID、不读对话来拼凑汇报。

旧进度卡片不能证明进程仍在运行；应用开着，也不能证明该 session 已加载 hooks 或注册消息 adapter。[原生验收记录](validation/2026-10-19-native-hooks.md)分别记录这些能力。

## 每个 agent 里都看得到看板

使用已安装的 skill，或安装器打印的确切程序路径：

```sh
node ~/.agent-board/agent-board.mjs --serve
node ~/.agent-board/agent-board.mjs --watch
node ~/.agent-board/agent-board.mjs --chat
node ~/.agent-board/agent-board.mjs --html
```

| 模式 | 结果 |
| --- | --- |
| `--serve` | 交互网页与可复用的本地后台服务 |
| `--watch` | 终端看板：方向键／Enter 选择，`x` 勾选，`a` 归档，`h` 隐藏，`u` 恢复，`i` 闲置工作，`c` 复制，`o` HTML，`q` 退出 |
| `--chat` | 精简文字；不开网页、链接或浏览器、不写文件 |
| `--html` | 生成并打开只读网页，不能发消息 |

加上 `--lang en`、`zh-TW` 或 `zh-CN` 选择语言。Windows／自定义安装请使用实际打印的完整路径。Codex 的入口是 `$agent-board`，OpenCode 安装 `/board`；其他 host 须先加载已安装的 skill／command。

### 看板的网页

问题排最前面，展开工作可看步骤。可勾选手动步骤、归档、贴入有效区块、复制回复或续接命令、标记已读及恢复。已读只改本地隐藏列表，不传话；问题文字改变后会再出现。当前没有通用任务编辑表单。

贴入进度保留来源时间。重复内容不变更；较旧或同时间冲突的进度会拒绝。无效或超前的时钟须先修正；原有进度时间不明时，须比较两份内容后确认取代。修复方式见[远程汇报](REMOTE_REPORTERS.md)。

卡片只有在确切 session 的 adapter 在线时提供发送，否则复制或自行打开 agent。[消息说明](MESSAGING.md)区分设置、真正回复、重复、冲突及超时。安装不会任意接管已打开的对话，普通回复也不能批准工具、信任或 PR 合并。

关标签页不会停止本地服务，再运行同一 `--serve` 即可重开。**关闭看板**才会停止；若正在发送，请等完成。默认不会闲置关闭，`--idle-minutes 30` 才启用。旧版 `--allow-resume` 会明确启用已结束 Codex／Grok 的重新启动，默认关闭，也不会用作实时消息的回退路径。

`--lan` 为可选功能：私人网络上另一个含 token 的 HTTP 链接，不允许 agent 发消息，闲置 10 分钟关闭该监听器；仍可修改看板文件。token 不会加密，开放前请读[安全说明](../SECURITY.md)。

## 进度文件

`progress.md` 是存储数据，不是 UI。每个 agent 拥有自己的区块，不覆盖其他 session。格式支持英、繁中、简中关键词，标记、所有权与写入读回规则见 [FORMAT](FORMAT.md)。

共享文件不会自动跨机同步。[远程汇报](REMOTE_REPORTERS.md)是另外选择的流程。`dot` 标签或贴上的区块不能证明真正 dot 已连接。

## 可选 Claude Code 侧栏

需要 Claude Code 2.1.287+；离线 CI 使用 2.1.301：

```sh
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
```

打开新 Claude Code session，使用 `/progress`。侧栏镜像 Task 工具，也可通过它的模型整理回合。问题与决策显示于任务上方；侧栏跟随 Claude 主题，浏览器跟随系统主题。

| 命令／输入 | 操作 |
| --- | --- |
| `/progress connect`、`connect status`、`connect remove` | 可选 plugin 连接、上次状态、移除 |
| `+ 求职: 研究驻点 截止 11-20; 草稿; 提交` | 侧栏快速新增，也可用 `/progress add …` |
| `/progress open` | 生成并打开只读 `progress.html` |
| `/progress tidy`、`/progress sync` | 归档符合条件工作；重读 Task／PR |
| `/progress report`、`/progress today` | 复制周报／日报 |
| `/progress lang en`、`zh-TW`、`zh-CN`、`auto` | 侧栏语言 |
| `/progress notify on`、`off` | 桌面通知 |

可选的 `scripts/setup.sh`／`scripts/setup.ps1` 处理 Claude 专用 Task 工具／profile 与 marketplace 配置。修改 profile 前先检查范围；独立安装不需要这些脚本。旧 plugin inbox 连接器可保留对话数据并调用 Claude 整理，和只记活动 metadata 的独立 hooks 不同。[安全说明](../SECURITY.md)。

## 它怎么保持整齐

可选侧栏在 session 开始与每小时清理：完成区块等 12 小时，其他已停／过时区块等三天，已观察完成的手动工作等 24 小时。明确整理可跳过完成工作的等待。独立看板仍有归档操作。

超过 12 小时没汇报的卡片可能显示已停，这是数据过时判断，不是原生进程检查；真正新事件／汇报会刷新。超过七天没动的工作折叠，不修改区块；`--all` 或闲置开关可展开，快到期的工作保留显示。

## 更新和卸载

独立安装：将干净 checkout 更新到指定版本，预览 `node scripts/setup-agent.mjs`，再应用已批准范围。修改过的文件列为冲突，不覆盖。host 可能要重新加载；不安装自动更新器或开机服务。

用已安装程序预览／应用目标移除：

```sh
node ~/.agent-board/agent-board.mjs --codex-remove --agent <name>
node ~/.agent-board/agent-board.mjs --codex-remove --agent <name> --apply
```

`--codex-remove`、`--codex-doctor` 是沿用的维护名称，可搭配各目标。先关闭该看板。只移除未修改的自有定义／文件；其他目标还需要的共享文件保留，进度、session 记录、归档、日志及用户修改也保留。

可选 plugin 请先在仍安装时运行 `/progress connect remove`，完成报告的清理后，再运行 `claude plugin uninstall agent-board@agent-board`；marketplace 用 `claude plugin marketplace remove agent-board` 移除。更新用 `claude plugin marketplace update agent-board`、`claude plugin update agent-board@agent-board`，之后重新加载 plugin。

### 从旧名称换过来

0.10 前的可选 plugin 名称是 `project-progress@claude-progress-pane`。移除旧 plugin／marketplace，安装上方新名称；若使用其连接器，再于 Claude Code 内运行 `/progress connect`。保留原进度文件。独立安装不需要 Claude 迁移。

## 问题排查

- **没卡片：** 检查路径、adapter、信任与重新加载；观察真正事件并读回确切 session 区块，不手动制造事件宣称通过。
- **不能发送：** 确切原生 session 需要受支持的在线 adapter，hooks 本身不等于可收信，桌面与 CLI 结果不可互代。
- **接线转述被忽略：** 接收者应告知授权或阻塞原因；RPC 成功或 ACK 不等于已观察到新进度。
- **读写失败：** 处理指出的文件／权限问题，检查进度与历史再重试；不先确认 owner 就删锁。
- **没有原生侧栏：** 非 Claude host 使用交互网页或终端看板，网页面板不等于原生侧栏。

### 安全地报告问题

提供 Agent Board／host 版本、CLI／App／IDE、OS 与合成复现数据；只有可选 plugin 才需要 Claude 版本。不上传原始进度、inbox、归档、日志、session log、凭证或看板 token。[安全报告](../SECURITY.md#reporting-a-problem)。

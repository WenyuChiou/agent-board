// Preview every selected target before applying any of them. Each target keeps its own
// ownership record while sharing one script, skill and local progress file.
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isatty } from 'node:tty'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverSetupAgents, findOnPath, hasBoardPlugin as hasPlugin, setupAgents as targets, setupRecordChanges } from './setup-discovery.mjs'

const args = process.argv.slice(2)
const isRemove = args.includes('--remove')
// The npm launcher supplies its package name for the setup command in guidance.
const command = process.env.AGENT_BOARD_SETUP_COMMAND || ''
const isJson = args.includes('--json')
// isatty, not process.stdin: opening process.stdin on a POSIX terminal leaves fd 0 non-blocking.
// Only a test (AGENT_BOARD_TEST_PID) may use the seam that exercises consent with piped input.
const isTerminal = !isJson && ((isatty(0) && isatty(1)) || (process.env.AGENT_BOARD_SETUP_TTY === '1' && !!process.env.AGENT_BOARD_TEST_PID))
// --apply keeps its old meaning in a terminal too: files only. Approving hooks and installing the
// plugin need a yes typed at the question, so an agent's shell tool cannot approve for the person.
const isAsking = !isRemove && isTerminal && !args.includes('--apply')
const langOf = value => {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (text === '') return null
  const exact = ['en', 'zh-TW', 'zh-CN'].find(one => one.toLowerCase() === text)
  if (exact !== undefined) return exact
  if (/(zh[-_]?(tw|hk|mo|hant))|繁|traditional|taiwan|台灣|臺灣|香港/.test(text)) return 'zh-TW'
  if (/(zh[-_]?(cn|sg|hans))|简|simplified|chinese|中文|^zh\b/.test(text)) return 'zh-CN'
  if (/^en(?:\b|_)|english|英文|英語|英语/.test(text)) return 'en'
  return null
}
// Windows usually has no LANG, so independent commands also check the system locale.
const systemLang = env => {
  const language = langOf(env)
  if (language !== null) return language
  try { return langOf(Intl.DateTimeFormat().resolvedOptions().locale) } catch { return null }
}
const langAt = args.indexOf('--lang')
const language = langOf(langAt < 0 ? undefined : args[langAt + 1]) ?? systemLang(process.env.LANG) ?? 'en'
const message = (en, tw, cn) => [en, tw, cn][['en', 'zh-TW', 'zh-CN'].indexOf(language)]
// Bootstrap runs on Node 18 and the npm package has no TypeScript string tables.
// Keep this copy identical to setupSummary in all three tables.
const summaries = [
  {
    "previewCreate": "would create {count} setup files",
    "preview": "would update {count} setup files",
    "previewRemove": "would remove {count} setup files",
    "applied": "updated {count} setup files",
    "current": "{count} already current",
    "shared": "Shared",
    "retire": "{file} (the old /board command; setup removes it)",
    "keptEdited": "{file} (your edited old /board command; setup leaves it; the command is now /agent-board)",
    "ready": "already set up",
    "skipped": "skipped: setup cannot safely update {files}. Fix or move the conflicting files, then retry with {command}.",
    "retry": "Retry after fixing the conflicting files: {command}",
    "skillOnly": "board skill only; automatic reporting is unavailable",
    "claude": "connects through its plugin",
    "connector": "managed by the Claude Code plugin connector; keeps its board at {progress}",
    "next": "Next steps:",
    "apply": "Apply these changes: {command}",
    "codex": "Codex: approve the board's hooks for the Codex app and CLI: preview with {command} --codex-trust --codex-bin {codex}, then run it again with --apply (in the Codex CLI, /hooks also works).",
    "codexMissing": "Codex: setup could not find Codex; run where.exe codex in PowerShell or command -v codex in bash, then pass its full path to --codex-bin.",
    "hermes": "Hermes Agent: Hermes asks once whether to trust the board's hooks; answer y. In a chat that cannot ask, preview {command} --hermes-trust, then run it again with --apply.",
    "opencode": "OpenCode: restart OpenCode to load its generated agent-board plugin.",
    "openclaw": "OpenClaw: restart OpenClaw to load its generated agent-board plugin.",
    "deepseek": "DeepSeek: close and reopen DeepSeek Harness (dsh) so it loads the agent-board plugin setup wrote.",
    "cursorWindows": "Cursor: on Windows, start cursor-agent from PowerShell or Command Prompt. Started from Git Bash, Cursor runs none of the board's hooks, so the board gets nothing from it.",
    "start": "Then start a new session in each of: {agents}.",
    "startOne": "Then start a new session in {agents}.",
    "skill": "{host}: open the board with its agent-board skill; automatic reporting is unavailable.",
    "plugin": "Claude Code: run claude plugin marketplace add WenyuChiou/agent-board, then claude plugin install agent-board@agent-board.",
    "board": "Open the board: {command}",
    "thisWill": "This will:",
    "question": "Set these up? [Y/n] ",
    "filesPart": "{host} files",
    "trustPart": "Approve the board's hooks in {host}",
    "installPlugin": "Install the Claude Code plugin",
    "marketplacePart": "Claude Code marketplace",
    "pluginPart": "Claude Code plugin",
    "partDone": "{part}: done.",
    "partFailed": "{part}: failed. Run: {command}",
    "thenBoard": "Then type /agent-board in any of them.",
    "open": "Open a new session in each of: {agents}.",
    "openOne": "Open a new session in {agents}.",
    "thenBoardOne": "Then type /agent-board there.",
    "appliedRemove": "removed {count} setup files",
    "noInstalled": "no installed Agent Board setups to remove",
    "keptData": "Keeps your data and history beside {progress} (answers, questions, journal, archive, sessions):",
    "applyRemove": "Apply this removal: {command}",
    "restartRemove": "Restart each of: {agents} to unload their removed reporting hooks.",
    "restartRemoveOne": "Restart {agents} to unload its removed reporting hooks."
  },
  {
    "previewCreate": "將建立 {count} 個設定檔案",
    "preview": "將更新 {count} 個設定檔案",
    "previewRemove": "將移除 {count} 個設定檔案",
    "applied": "已更新 {count} 個設定檔案",
    "current": "{count} 個已是最新",
    "shared": "共用",
    "retire": "{file}（舊的 /board 命令；setup 會移除）",
    "keptEdited": "{file}（你改過的舊 /board 命令；setup 不動它；命令已改成 /agent-board）",
    "ready": "已設定完成",
    "skipped": "已略過：無法安全更新 {files}。請修正或移開衝突的檔案，再執行 {command} 重試。",
    "retry": "修正衝突的檔案後重試：{command}",
    "skillOnly": "僅提供看板技能；尚無自動回報功能",
    "claude": "透過外掛接上看板",
    "connector": "由 Claude Code 外掛的連接器管理；保留看板 {progress}",
    "next": "接下來：",
    "apply": "套用這些變更：{command}",
    "codex": "Codex：為 Codex 應用程式和 CLI 核准看板的 hooks：先執行 {command} --codex-trust --codex-bin {codex} 預覽，再加上 --apply 重新執行同一命令（在 Codex CLI 中也可以使用 /hooks）。",
    "codexMissing": "Codex：setup 找不到 Codex；請在 PowerShell 執行 where.exe codex 或在 bash 執行 command -v codex，再用 --codex-bin 傳入完整路徑。",
    "hermes": "Hermes Agent：Hermes 會問一次是否信任看板的 hooks，請回答 y。在無法詢問的聊天通道中，先執行 {command} --hermes-trust 預覽，再加上 --apply 重新執行同一命令。",
    "opencode": "OpenCode：重新啟動 OpenCode，載入 setup 產生的 agent-board 外掛。",
    "openclaw": "OpenClaw：重新啟動 OpenClaw，載入 setup 產生的 agent-board 外掛。",
    "deepseek": "DeepSeek：關掉 DeepSeek Harness（dsh）再重新打開，讓它載入 setup 產生的 agent-board 外掛。",
    "cursorWindows": "Cursor：在 Windows 上，請從 PowerShell 或命令提示字元啟動 cursor-agent。從 Git Bash 啟動時，Cursor 不會執行看板的 hooks，看板就收不到它的任何進度。",
    "start": "最後在 {agents} 各開一個新的工作階段。",
    "startOne": "最後在 {agents} 開一個新的工作階段。",
    "skill": "{host}：使用 agent-board 技能開啟看板；尚無自動回報功能。",
    "plugin": "Claude Code：執行 claude plugin marketplace add WenyuChiou/agent-board，再執行 claude plugin install agent-board@agent-board。",
    "board": "開啟看板：{command}",
    "thisWill": "會做這幾件事：",
    "question": "要設定這些嗎？[Y/n] ",
    "filesPart": "{host} 設定檔案",
    "trustPart": "在 {host} 核准看板的 hooks",
    "installPlugin": "安裝 Claude Code 外掛",
    "marketplacePart": "Claude Code 外掛市集",
    "pluginPart": "Claude Code 外掛",
    "partDone": "{part}：已完成。",
    "partFailed": "{part}：失敗。請執行：{command}",
    "thenBoard": "接著在其中任一個輸入 /agent-board。",
    "open": "在 {agents} 各開一個新的工作階段。",
    "openOne": "在 {agents} 開一個新的工作階段。",
    "thenBoardOne": "接著在那裡輸入 /agent-board。",
    "appliedRemove": "已移除 {count} 個設定檔案",
    "noInstalled": "沒有已安裝的 Agent Board 設定可供移除",
    "keptData": "保留 {progress} 旁邊的資料與歷史紀錄（回答、提問、日誌、歸檔、工作階段）：",
    "applyRemove": "套用此移除變更：{command}",
    "restartRemove": "重新啟動 {agents}，卸載已移除的看板回報 hooks。",
    "restartRemoveOne": "重新啟動 {agents}，卸載已移除的看板回報 hooks。"
  },
  {
    "previewCreate": "将创建 {count} 个设置文件",
    "preview": "将更新 {count} 个设置文件",
    "previewRemove": "将移除 {count} 个设置文件",
    "applied": "已更新 {count} 个设置文件",
    "current": "{count} 个已是最新",
    "shared": "共用",
    "retire": "{file}（旧的 /board 命令；setup 会移除）",
    "keptEdited": "{file}（你改过的旧 /board 命令；setup 不动它；命令已改成 /agent-board）",
    "ready": "已设置完成",
    "skipped": "已跳过：无法安全更新 {files}。请修复或移走冲突的文件，再运行 {command} 重试。",
    "retry": "修复冲突的文件后重试：{command}",
    "skillOnly": "仅提供看板技能；暂无自动报告功能",
    "claude": "通过插件接上看板",
    "connector": "由 Claude Code 插件的连接器管理；保留看板 {progress}",
    "next": "接下来：",
    "apply": "应用这些更改：{command}",
    "codex": "Codex：为 Codex 应用程序和 CLI 批准看板的 hooks：先运行 {command} --codex-trust --codex-bin {codex} 预览，再加上 --apply 重新运行同一命令（在 Codex CLI 中也可以使用 /hooks）。",
    "codexMissing": "Codex：setup 找不到 Codex；请在 PowerShell 运行 where.exe codex 或在 bash 运行 command -v codex，再用 --codex-bin 传入完整路径。",
    "hermes": "Hermes Agent：Hermes 会问一次是否信任看板的 hooks，请回答 y。在无法询问的聊天渠道中，先运行 {command} --hermes-trust 预览，再加上 --apply 重新运行同一命令。",
    "opencode": "OpenCode：重新启动 OpenCode，加载 setup 生成的 agent-board 插件。",
    "openclaw": "OpenClaw：重新启动 OpenClaw，加载 setup 生成的 agent-board 插件。",
    "deepseek": "DeepSeek：关掉 DeepSeek Harness（dsh）再重新打开，让它加载 setup 生成的 agent-board 插件。",
    "cursorWindows": "Cursor：在 Windows 上，请从 PowerShell 或命令提示符启动 cursor-agent。从 Git Bash 启动时，Cursor 不会运行看板的 hooks，看板就收不到它的任何进度。",
    "start": "最后在 {agents} 各开一个新的会话。",
    "startOne": "最后在 {agents} 开一个新的会话。",
    "skill": "{host}：使用 agent-board 技能打开看板；暂无自动报告功能。",
    "plugin": "Claude Code：运行 claude plugin marketplace add WenyuChiou/agent-board，再运行 claude plugin install agent-board@agent-board。",
    "board": "打开看板：{command}",
    "thisWill": "会做这几件事：",
    "question": "要设置这些吗？[Y/n] ",
    "filesPart": "{host} 设置文件",
    "trustPart": "在 {host} 批准看板的 hooks",
    "installPlugin": "安装 Claude Code 插件",
    "marketplacePart": "Claude Code 插件市场",
    "pluginPart": "Claude Code 插件",
    "partDone": "{part}：已完成。",
    "partFailed": "{part}：失败。请运行：{command}",
    "thenBoard": "接着在其中任一个输入 /agent-board。",
    "open": "在 {agents} 各开一个新的会话。",
    "openOne": "在 {agents} 开一个新的会话。",
    "thenBoardOne": "接着在那里输入 /agent-board。",
    "appliedRemove": "已移除 {count} 个设置文件",
    "noInstalled": "没有已安装的 Agent Board 设置可供移除",
    "keptData": "保留 {progress} 旁的数据与历史记录（回答、提问、日志、归档、会话）：",
    "applyRemove": "应用此移除更改：{command}",
    "restartRemove": "重新启动 {agents}，卸载已移除的看板报告 hooks。",
    "restartRemoveOne": "重新启动 {agents}，卸载已移除的看板报告 hooks。"
  }
]
const summary = summaries[['en', 'zh-TW', 'zh-CN'].indexOf(language)]
const words = (key, values = {}) => summary[key].replace(/\{(\w+)\}/g, (text, name) => String(values[name] ?? text))
// Keep this copy identical to setupNoAgent in all three tables.
const noAgentWords = [
  {
    "anywhere": "Setup found no agent on this computer. It looked for their folders in {home}, their commands on the PATH and their apps. Install an agent and run setup again, or name one: {next} (or cursor, opencode, gemini, grok, muse, hermes, openclaw, antigravity, deepseek, all).",
    "home": "Setup found no agent on this computer. It looked for their folders in {home}. Install an agent and run setup again, or name one: {next} (or cursor, opencode, gemini, grok, muse, hermes, openclaw, antigravity, deepseek, all).",
    "unknown": "agent-board: --agent named an agent setup does not know. Name one: {next} (or cursor, opencode, gemini, grok, muse, hermes, openclaw, antigravity, deepseek, all)."
  },
  {
    "anywhere": "setup 在這台電腦沒有找到 agent。它找過 {home} 裡的資料夾、PATH 上的命令和已安裝的應用程式。請安裝一個 agent 再執行一次 setup，或指定一個：{next}（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。",
    "home": "setup 在這台電腦沒有找到 agent。它找過 {home} 裡的資料夾。請安裝一個 agent 再執行一次 setup，或指定一個：{next}（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。",
    "unknown": "agent-board：--agent 寫了 setup 不認得的 agent 名稱。指定一個：{next}（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。"
  },
  {
    "anywhere": "setup 在这台电脑没有找到 agent。它找过 {home} 里的文件夹、PATH 上的命令和已安装的应用程序。请安装一个 agent 再运行一次 setup，或指定一个：{next}（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。",
    "home": "setup 在这台电脑没有找到 agent。它找过 {home} 里的文件夹。请安装一个 agent 再运行一次 setup，或指定一个：{next}（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。",
    "unknown": "agent-board：--agent 写了 setup 不认识的 agent 名称。指定一个：{next}（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。"
  }
]
const noAgentText = (key, values) => message(...noAgentWords.map(table => table[key].replace(/\{(\w+)\}/g, (text, name) => String(values[name] ?? text))))
const names = { codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', gemini: 'Gemini CLI', grok: 'Grok Build', muse: 'Muse Code', hermes: 'Hermes Agent', openclaw: 'OpenClaw', antigravity: 'Antigravity', deepseek: 'DeepSeek' }
const missingValue = message(
  'agent-board: a setup option is missing its value. Options such as --agent, --home and --data-dir each take one; add it after the option and run setup again.',
  'agent-board：setup 有個選項後面沒有接值。--agent、--home、--data-dir 這類選項都要接一個值；請在選項後面補上，再執行一次 setup。',
  'agent-board：setup 有个选项后面没有接值。--agent、--home、--data-dir 这类选项都要接一个值；请在选项后面补上，再运行一次 setup。',
)
const noTarget = noAgentText('unknown', { next: `${command ? `${command} ` : ''}--agent codex` })
const childFailed = host => message(
  `agent-board: setup stopped while working on ${host}. Run it again with --json to see the reason.`,
  `agent-board：setup 處理 ${host} 時中止了。加上 --json 再執行一次，就能看到原因。`,
  `agent-board：setup 处理 ${host} 时中止了。加上 --json 再运行一次，就能看到原因。`,
)
const unknownFailed = message(
  'agent-board: setup stopped before it finished. Run it again with --json to see the reason.',
  'agent-board：setup 在完成前中止了。加上 --json 再執行一次，就能看到原因。',
  'agent-board：setup 在完成前中止了。加上 --json 再运行一次，就能看到原因。',
)
const systemFailures = {
  EINVAL: message('agent-board: the operating system rejected a setup argument; check the supplied paths and run the command again.', 'agent-board：作業系統拒絕了 setup 參數；請檢查輸入的路徑並重新執行命令。', 'agent-board：操作系统拒绝了 setup 参数；请检查输入的路径并重新运行命令。'),
  ENOENT: message('agent-board: a file or program needed by setup was not found; check the supplied paths and run the command again.', 'agent-board：找不到 setup 需要的檔案或程式；請檢查輸入的路徑並重新執行命令。', 'agent-board：找不到 setup 需要的文件或程序；请检查输入的路径并重新运行命令。'),
  EISDIR: message('agent-board: setup expected a file but found a folder; move the folder out of the setup data path and run the command again.', 'agent-board：setup 需要檔案，卻找到了資料夾；請移開設定資料路徑中的資料夾並重新執行命令。', 'agent-board：setup 需要文件，却找到了文件夹；请移走设置数据路径中的文件夹并重新运行命令。'),
  ENOTDIR: message('agent-board: a setup path contains a file where a folder is needed; choose another folder and run the command again.', 'agent-board：setup 路徑中需要資料夾的地方是檔案；請選擇其他資料夾並重新執行命令。', 'agent-board：setup 路径中需要文件夹的地方是文件；请选择其他文件夹并重新运行命令。'),
  EACCES: message('agent-board: setup was denied access to a file or folder; correct its permissions and run the command again.', 'agent-board：setup 無權存取檔案或資料夾；請修正權限並重新執行命令。', 'agent-board：setup 无权访问文件或文件夹；请修正权限并重新运行命令。'),
  EPERM: message('agent-board: the operating system refused a setup file operation; correct the file permissions and run the command again.', 'agent-board：作業系統拒絕 setup 的檔案操作；請修正檔案權限並重新執行命令。', 'agent-board：操作系统拒绝 setup 的文件操作；请修正文件权限并重新运行命令。'),
  ENOSPC: message('agent-board: the disk has no space for setup; free disk space and run the command again.', 'agent-board：磁碟沒有空間供 setup 使用；請釋放磁碟空間並重新執行命令。', 'agent-board：磁盘没有空间供 setup 使用；请释放磁盘空间并重新运行命令。'),
  EROFS: message('agent-board: setup cannot write to a read-only filesystem; choose a writable data folder and run the command again.', 'agent-board：setup 無法寫入唯讀檔案系統；請選擇可寫入的資料夾並重新執行命令。', 'agent-board：setup 无法写入只读文件系统；请选择可写入的文件夹并重新运行命令。'),
  EEXIST: message('agent-board: a file appeared where setup needed to create one; inspect that file and run the command again.', 'agent-board：setup 要建立檔案的位置已有檔案；請檢查該檔案並重新執行命令。', 'agent-board：setup 要创建文件的位置已有文件；请检查该文件并重新运行命令。'),
  EBUSY: message('agent-board: a setup file is in use; close the program using it and run the command again.', 'agent-board：setup 的檔案正在使用中；請關閉使用它的程式並重新執行命令。', 'agent-board：setup 的文件正在使用中；请关闭使用它的程序并重新运行命令。'),
  EAGAIN: message('agent-board: a setup resource is temporarily unavailable; wait for the other operation to finish and run the command again.', 'agent-board：setup 需要的資源暫時無法使用；請等其他操作完成後重新執行命令。', 'agent-board：setup 需要的资源暂时不可用；请等其他操作完成后重新运行命令。'),
  EIO: message('agent-board: the operating system reported an input or output error during setup; check the disk and run the command again.', 'agent-board：setup 期間作業系統回報輸入或輸出錯誤；請檢查磁碟並重新執行命令。', 'agent-board：setup 期间操作系统报告输入或输出错误；请检查磁盘并重新运行命令。'),
  ENAMETOOLONG: message('agent-board: a setup path is too long; choose a shorter data folder and run the command again.', 'agent-board：setup 路徑太長；請選擇較短的資料夾並重新執行命令。', 'agent-board：setup 路径太长；请选择较短的文件夹并重新运行命令。'),
}
const systemFailed = code => systemFailures[code] ?? message(
  `agent-board: setup encountered ${code}; check the reported system error and run the command again.`,
  `agent-board：setup 發生 ${code} 系統錯誤；請檢查該錯誤並重新執行命令。`,
  `agent-board：setup 发生 ${code} 系统错误；请检查该错误并重新运行命令。`,
)
const isCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
class SetupFailure extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}
const fail = (code, message, extra = {}) => { throw new SetupFailure(code, message, extra) }

// Detect installed commands without starting them during setup. A bare name on Windows is left
// out: cmd and PowerShell cannot start one, and npm's bare shim always has a .cmd beside it.
// The folder Hermes Agent reads, chosen as Hermes does (keep in step with hooks/hermes-home.ts): HERMES_HOME,
// else %LOCALAPPDATA%\hermes on Windows for the running account, else ~/.hermes.
const hermesHome = home => {
  const named = process.env.HERMES_HOME?.trim()
  if (named) return named
  if (process.platform !== 'win32') return join(home, '.hermes')
  const clean = path => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const local = process.env.LOCALAPPDATA?.trim()
  const own = process.env.USERPROFILE ?? process.env.HOME
  return local && own !== undefined && clean(own) === clean(home) ? join(local, 'hermes') : join(home, 'AppData', 'Local', 'hermes')
}

// On a POSIX terminal the answer is read from /dev/tty. fd 0 can be non-blocking (code in this process
// opened process.stdin, or a parent shared a non-blocking pipe); a read before the answer is typed then
// fails with EAGAIN, so setup waits and reads again.
const askYes = () => {
  process.stdout.write(words('question'))
  let fd = 0
  let isOwn = false
  if (process.platform !== 'win32' && isatty(0)) {
    try { fd = openSync('/dev/tty', 'r'); isOwn = true } catch {}
  }
  const chunks = []
  let size = 0
  try {
    const bytes = Buffer.alloc(256)
    while (size < 4096) {
      let count
      try { count = readSync(fd, bytes, 0, bytes.length, null) } catch (error) {
        if (error?.code !== 'EAGAIN') return false
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
        continue
      }
      if (count === 0) break
      const chunk = Buffer.from(bytes.subarray(0, count))
      chunks.push(chunk)
      size += count
      if (chunk.includes(10)) break
    }
  } finally {
    if (isOwn) try { closeSync(fd) } catch {}
  }
  return size > 0 && /^\s*(y|yes|是|好|對|对)?\s*$/i.test(Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0])
}

// npm supplies .cmd shims on Windows; quote each argument for cmd rather than enabling a shell for every program.
// A plugin install fetches from GitHub, so a stuck one ends after three minutes and counts as failed.
const runProgram = (program, argv) => {
  const options = { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }
  if (process.platform === 'win32' && /\.cmd$/i.test(program)) {
    const quoted = [program, ...argv].map(word => `"${word.replaceAll('"', '""')}"`).join(' ')
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], { ...options, windowsVerbatimArguments: true })
  }
  return spawnSync(program, argv, options)
}

const main = () => {
  const at = args.indexOf('--agent')
  const selector = at < 0 ? 'auto' : args[at + 1]
  if (at >= 0) args.splice(at, 2)
  const homeAt = args.indexOf('--home')
  const home = homeAt < 0 ? homedir() : args[homeAt + 1]
  if (!home || home.startsWith('--') || !selector || selector.startsWith('--')) fail('MISSING_ARGUMENT', missingValue)
  const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
  const hostDirs = {
    codex: flag('--codex-dir') || process.env.CODEX_HOME,
    grok: flag('--grok-dir') || process.env.GROK_HOME,
    hermes: flag('--hermes-dir') || hermesHome(home),
    opencode: flag('--opencode-dir') || process.env.OPENCODE_CONFIG_DIR || (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'opencode') : undefined),
    openclaw: flag('--openclaw-dir') || process.env.OPENCLAW_STATE_DIR,
    deepseek: flag('--deepseek-dir') || process.env.DSH_HOME,
  }
  const data = flag('--data-dir') || join(home, '.agent-board')
  const touched = targets.filter(agent => existsSync(join(data, `install-${agent}.json`)))
  // --home can name another account's home; PATH and apps belong to the running account.
  const selected = isRemove
    ? (selector === 'all' ? targets : selector === 'auto' ? touched : selector.split(','))
    : (selector === 'all' ? targets : selector === 'auto' ? discoverSetupAgents(home, data, hostDirs, homeAt < 0) : selector.split(','))
  const claudeDirectory = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const claude = homeAt < 0 || resolve(home) === resolve(homedir()) ? findOnPath(['claude'], ['.exe', '.cmd']) : undefined
  const hasClaude = existsSync(claudeDirectory) || (homeAt < 0 && !!claude)
  const isPluginInstalled = hasClaude && hasPlugin(claudeDirectory)
  const isPluginNeeded = isAsking && !!claude && !isPluginInstalled
  const common = args.filter(arg => arg !== '--apply' && arg !== '--json')
  const quote = value => /^[\w./:@=-]+$/.test(value) ? value : process.platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
  const nodeCommand = script => `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`
  const setupCommand = extra => {
    const baseCommon = common.filter(arg => !extra.includes(arg))
    return [command || nodeCommand(fileURLToPath(import.meta.url)), ...baseCommon.map(quote), ...extra.map(quote)].join(' ')
  }
  if (isRemove && selector === 'auto' && !selected.length) {
    process.stdout.write(`${isJson ? JSON.stringify({ targets: [], plans: [], applied: false }, null, 2) : words('noInstalled')}\n`)
    return
  }
  if (!isRemove && selector === 'auto' && !selected.length && !isPluginNeeded) {
    const next = setupCommand(['--agent', 'codex'])
    const noAgent = noAgentText(homeAt < 0 ? 'anywhere' : 'home', { home, next })
    const claudeNext = isPluginInstalled ? [words('openOne', { agents: 'Claude Code' }), words('thenBoardOne')] : [words('plugin')]
    process.stdout.write(`${isJson ? JSON.stringify({ targets: [], plans: [], applied: false }, null, 2) : hasClaude ? `Claude Code: ${words('claude')}\n\n${words('next')}\n${claudeNext.map((step, i) => `${i + 1}. ${step}`).join('\n')}` : noAgent}\n`)
    return
  }
  if ((!selected.length && selector !== 'auto') || selected.some(agent => !targets.includes(agent)) || new Set(selected).size !== selected.length) fail('INVALID_TARGETS', noTarget)
  const apply = args.includes('--apply')
  const isShowingApplied = apply
  const script = fileURLToPath(new URL('./setup-codex.mjs', import.meta.url))
  const run = (agent, isApplying) => {
    const runArgs = isRemove ? ['--codex-remove', '--removing', selected.join(','), ...common.filter(arg => arg !== '--remove')] : common
    const result = spawnSync(process.execPath, [script, ...runArgs, '--json', '--agent', agent, ...(isApplying ? ['--apply'] : [])], { encoding: 'utf8', windowsHide: true })
    const fallback = () => {
      const cause = isCode(result.error?.code) ? result.error.code : 'UNKNOWN'
      const reason = result.error?.message || (result.stderr ?? '').trim().split(/\r?\n/).filter(Boolean).pop() || 'The setup helper did not return a result.'
      fail('SETUP_FAILED', cause === 'UNKNOWN' ? childFailed(names[agent]) : systemFailed(cause), { agent, cause, ...(cause === 'UNKNOWN' ? { reason } : {}) })
    }
    if (result.error) fallback()
    if (result.status !== 0) {
      for (const line of (result.stderr ?? '').trim().split(/\r?\n/).reverse()) {
        let error
        try { error = JSON.parse(line)?.error } catch {}
        if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
          if (error.code === 'INVALID_CONNECT_RECORD') fail(error.code, error.message, { agent })
          fail('SETUP_FAILED', error.message, { agent, cause: error.code, ...(typeof error.reason === 'string' ? { reason: error.reason } : {}) })
        }
      }
      fallback()
    }
    try { return JSON.parse(result.stdout) } catch { fallback() }
  }
  const plans = selected.map(agent => run(agent, false))
  const available = selected.filter((agent, i) => !plans[i].conflicts.length)
  if (selected.length && !available.length) process.exitCode = 1
  const results = plans.map((plan, i) => {
    if (!isShowingApplied || plan.conflicts.length) return plan
    // An unchanged install still rewrites its manifest; keep a second run read-only.
    return plan.changes.length ? run(selected[i], true) : { ...plan, applied: true }
  })
  if (isJson) {
    process.stdout.write(`${JSON.stringify({ targets: selected, plans: results, applied: apply && available.length > 0 }, null, 2)}\n`)
    return
  }
  const shortPath = file => {
    const path = relative(resolve(home), file)
    return path === '' ? '~' : path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? join('~', path) : file
  }
  // Applying also rewrites the record of an installed agent that is not being set up, unselected or
  // skipped for a conflict, when it holds a shared file that changes, so the preview names it too.
  const filesByAgent = plans.map(plan => plan.conflicts.length ? [] : [
    ...plan.changes.map(change => change.file),
    ...(!isShowingApplied ? setupRecordChanges(plan, available) : []),
  ])
  const owners = new Map()
  for (const [i, files] of filesByAgent.entries()) for (const file of files) {
    if (!owners.has(file)) owners.set(file, new Set())
    owners.get(file).add(i)
  }
  const shared = new Set([...owners].filter(([, agents]) => agents.size > 1).map(([file]) => file))
  const changesFor = (plan, isShared) => plan.changes.filter(change => shared.has(change.file) === isShared)
  const describe = changes => {
    if (isShowingApplied) {
      if (isRemove) return changes.length ? words('appliedRemove', { count: changes.length }) : ''
      return changes.length ? words('applied', { count: changes.length }) : ''
    }
    return [['create', 'previewCreate'], ['update', 'preview'], ['remove', 'previewRemove']]
      .flatMap(([action, key]) => {
        const count = changes.filter(change => change.action === action).length
        return count ? [words(key, { count })] : []
      }).join('; ')
  }
  const fileLine = (file, changes) => {
    const change = changes.find(one => one.file === file)
    return `  ${change?.action === 'remove' && !isRemove ? words('retire', { file: shortPath(file) }) : shortPath(file)}`
  }
  const sharedChanges = [...new Map(results.flatMap(plan => plan.conflicts.length ? [] : changesFor(plan, true)).map(change => [change.file, change])).values()]
  const sharedFiles = [...new Set(filesByAgent.flat().filter(file => shared.has(file)))]
  const lines = []
  let sharedLine = ''
  if (sharedFiles.length) {
    const status = describe(sharedChanges)
    sharedLine = `${words('shared')}:${status ? ` ${status}` : ''}`
    lines.push(sharedLine)
    if (!isShowingApplied) lines.push(...sharedFiles.map(file => fileLine(file, sharedChanges)))
  }
  const agentLines = selected.map((agent, i) => {
    const plan = results[i]
    const ownChanges = changesFor(plan, false)
    const changed = new Set(ownChanges.map(change => change.file))
    const alreadyCurrent = isShowingApplied && !plan.conflicts.length && plan.managedBy !== 'connector'
      ? changesFor(plans[i], false).filter(change => !changed.has(change.file)).length : 0
    const current = alreadyCurrent > 0 ? `; ${words('current', { count: alreadyCurrent })}` : ''
    const status = plan.managedBy === 'connector' ? words('connector', { progress: plan.progress }) : plan.conflicts.length ? words('skipped', { files: plan.conflicts.map(shortPath).join(', '), command: setupCommand([isRemove ? '--remove' : '', '--agent', agent, '--apply'].filter(Boolean)) })
      : describe(ownChanges) || (isRemove ? words('noInstalled') : words('ready'))
    const capability = !isRemove && plan.managedBy !== 'connector' && !plan.conflicts.length && plan.capabilities.lifecycle === 'adapter-pending' ? `; ${words('skillOnly')}` : ''
    // An install plan removes a file only to retire the old /board command (#868), so the preview says so.
    const files = !isShowingApplied && !plan.conflicts.length ? filesByAgent[i].filter(file => !shared.has(file)).map(file => fileLine(file, ownChanges)) : []
    // An old /board file the person edited stays; say so in the preview and after applying.
    const kept = plan.conflicts.length ? [] : (plan.keptEdited ?? []).map(file => `  ${words('keptEdited', { file: shortPath(file) })}`)
    return [`${names[agent]}: ${status}${current}${capability}`, ...files, ...kept].join('\n')
  })
  lines.push(...agentLines)
  if (hasClaude && !isRemove) lines.push(`Claude Code: ${words('claude')}`)
  if (isRemove && results.length) {
    const progress = results[0]?.progress || join(data, 'progress.md')
    const progressDir = dirname(progress)
    const keptDataFiles = []
    try {
      const names = readdirSync(progressDir)
      for (const name of names) {
        if (name === 'progress.md' || /^progress-(?:answered|answers|questions|journal|archive|sessions|seen|settings)(?:-[^.]+)?\.(?:json|md|log)$/.test(name) || name === 'progress-inbox') {
          keptDataFiles.push(join(progressDir, name))
        }
      }
    } catch {}
    if (keptDataFiles.length) {
      keptDataFiles.sort((a, b) => {
        if (basename(a) === 'progress.md') return -1
        if (basename(b) === 'progress.md') return 1
        return a.localeCompare(b)
      })
      lines.push(words('keptData', { progress: shortPath(progress) }))
      for (const file of keptDataFiles) lines.push(`  ${shortPath(file)}`)
    }
  }
  const steps = []
  const boardRun = (plan, agent, extra) => {
    const own = []
    for (let i = 0; i < common.length; i++) {
      if (common[i] === '--agent') i++
      else own.push(common[i])
    }
    return spawnSync(process.execPath, [plan.script ?? join(plan.data, 'agent-board.mjs'), ...own, '--agent', agent, ...extra], { encoding: 'utf8', windowsHide: true })
  }
  const isTrusted = (plan, agent, codex) => {
    const doctor = boardRun(plan, agent, ['--codex-doctor', '--json', ...(codex ? ['--codex-bin', codex] : [])])
    try { return doctor.status === 0 && JSON.parse(doctor.stdout).hooksTrusted === true } catch { return false }
  }
  const boardPlan = available.length ? results[selected.indexOf(available[0])] : null
  const boardFile = boardPlan ? boardPlan.script ?? join(boardPlan.data, 'agent-board.mjs') : ''
  // The package launcher cannot discover a custom install from the account's default locations.
  const boardDirectory = boardFile ? dirname(resolve(boardFile)) : ''
  const boardCommand = boardFile ? command
    ? [command.replace(/\s+setup\s*$/, ''), ...(boardDirectory !== resolve(homedir(), '.agent-board') ? ['--data-dir', quote(boardDirectory)] : [])].join(' ')
    : nodeCommand(boardFile) : ''
  if (isAsking) {
    const codex = flag('--codex-bin') || findOnPath(['codex'], ['.exe', '.cmd', '.ps1'])
    const approvals = available.filter(agent => ['codex', 'hermes'].includes(agent)).filter(agent => {
      const plan = plans[selected.indexOf(agent)]
      return plan.managedBy !== 'connector' && (plan.changes.length || !isTrusted(plan, agent, agent === 'codex' ? codex : undefined))
    })
    // Only what a yes would do: no skipped agent and no agent whose own files are already current.
    const will = [
      ...(sharedChanges.length ? [sharedLine] : []),
      ...agentLines.filter((line, i) => !plans[i].conflicts.length && changesFor(plans[i], false).length).map(line => line.split('\n')[0]),
      ...approvals.map(agent => words('trustPart', { host: names[agent] })),
      ...(isPluginNeeded ? [words('installPlugin')] : []),
    ]
    // With nothing to do there is nothing to ask; the plain preview below says so.
    let hasConsent = false
    if (will.length) {
      process.stdout.write(`${lines.join('\n')}\n\n${words('thisWill')}\n${will.map(line => `- ${line}`).join('\n')}\n`)
      hasConsent = askYes()
      process.stdout.write('\n')
    }
    if (hasConsent) {
      const completed = []
      const report = (part, isDone, next) => process.stdout.write(`${words(isDone ? 'partDone' : 'partFailed', { part, command: next })}\n`)
      for (const [i, agent] of selected.entries()) {
        const plan = plans[i]
        // A skipped agent's preview line already names its files and the command to apply it.
        if (plan.conflicts.length) continue
        let isDone = true
        try {
          if (plan.changes.length) {
            const applied = run(agent, true)
            isDone = applied.applied === true && !applied.conflicts.length
          }
          if (isDone) completed.push(agent)
        } catch { isDone = false }
        if (!isDone) process.exitCode = 1
        report(words('filesPart', { host: names[agent] }), isDone, setupCommand(['--agent', agent, '--apply']))
      }
      for (const agent of approvals) {
        const extra = [`--${agent}-trust`, ...(agent === 'codex' && codex ? ['--codex-bin', codex] : []), '--apply', '--json']
        const next = [boardCommand, ...common.map(quote), ...extra.filter(word => word !== '--json').map(quote), ...(agent === 'codex' && !codex ? ['--codex-bin <path-to-codex>'] : [])].join(' ')
        // Hooks whose files were not written cannot be approved; say so instead of leaving the part out.
        if (!completed.includes(agent)) {
          report(words('trustPart', { host: names[agent] }), false, next)
          continue
        }
        const result = boardRun(plans[selected.indexOf(agent)], agent, extra)
        report(words('trustPart', { host: names[agent] }), !result.error && result.status === 0, next)
      }
      let isPluginReady = !!claude && hasPlugin(claudeDirectory)
      if (isPluginNeeded) {
        let known = null
        try { known = JSON.parse(readFileSync(join(claudeDirectory, 'plugins', 'known_marketplaces.json'), 'utf8').replace(/^\uFEFF/, '')) } catch {}
        // A marketplace Claude Code already knows would make "marketplace add" fail; only the install is left.
        const isKnown = known !== null && typeof known === 'object' && Object.hasOwn(known, 'agent-board')
        for (const [part, argv] of [
          ...(isKnown ? [] : [['marketplacePart', ['plugin', 'marketplace', 'add', 'WenyuChiou/agent-board']]]),
          ['pluginPart', ['plugin', 'install', 'agent-board@agent-board']],
        ]) {
          const result = runProgram(claude, argv)
          // An install counts once Claude Code lists the plugin, not on its exit status alone.
          const isDone = !result.error && result.status === 0 && (part !== 'pluginPart' || hasPlugin(claudeDirectory))
          report(words(part), isDone, ['claude', ...argv].join(' '))
          if (part === 'pluginPart') isPluginReady = isDone
        }
      }
      const next = []
      const sessions = []
      for (const agent of completed) {
        const plan = plans[selected.indexOf(agent)]
        if (plan.managedBy === 'connector') continue
        if (plan.capabilities.lifecycle === 'adapter-pending') next.push(words('skill', { host: names[agent] }))
        else {
          if (['opencode', 'openclaw', 'deepseek'].includes(agent)) next.push(words(agent))
          // Started from Git Bash, cursor-agent hands its PowerShell hook commands to bash and none runs (#1159).
          if (agent === 'cursor' && process.platform === 'win32') next.push(words('cursorWindows'))
          sessions.push(names[agent])
        }
      }
      if (isPluginReady) sessions.push('Claude Code')
      if (sessions.length) {
        next.push(words(sessions.length === 1 ? 'openOne' : 'open', { agents: sessions.join(message(', ', '、', '、')) }))
        next.push(words(sessions.length === 1 ? 'thenBoardOne' : 'thenBoard'))
      }
      if (next.length) process.stdout.write(`\n${words('next')}\n${next.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n`)
      return
    }
    // A no: the preview is already on screen, so only the next steps follow.
    if (will.length) lines.length = 0
  }
  if (isRemove) {
    if (!apply && available.some(agent => plans[selected.indexOf(agent)].changes.length)) {
      const agentFlag = selector !== 'auto' ? ['--agent', available.join(',')] : []
      steps.push(words('applyRemove', { command: setupCommand(['--remove', ...agentFlag, '--apply']) }))
    } else if (apply && available.length) {
      const sessionAgents = available.map(agent => names[agent])
      steps.push(words(sessionAgents.length === 1 ? 'restartRemoveOne' : 'restartRemove', { agents: sessionAgents.join(message(', ', '、', '、')) }))
    }
  } else {
    if (!apply && available.some(agent => plans[selected.indexOf(agent)].changes.length)) steps.push(words('apply', { command: setupCommand(['--agent', available.join(','), '--apply']) }))
    const sessionAgents = []
    for (const agent of available) {
      const plan = results[selected.indexOf(agent)]
      if (plan.managedBy === 'connector') continue
      // Narrower than detection: this path goes to --codex-bin, which cannot start a .bat or .com.
      const codex = agent === 'codex' ? findOnPath(['codex'], ['.exe', '.cmd', '.ps1']) : undefined
      // A repeat run of an unchanged install asks Codex itself whether the board's hooks are trusted,
      // and leaves out the trust step only on its yes; no answer or any other answer keeps it (#808).
      if (codex && !plan.changes.length && isTrusted(plan, agent, codex)) continue
      if (agent === 'codex' && !codex) {
        steps.push(words('codexMissing'))
        continue
      }
      if (agent !== 'codex' && plan.capabilities.lifecycle === 'adapter-pending') {
        steps.push(words('skill', { host: names[agent] }))
        continue
      }
      if (['codex', 'hermes', 'opencode', 'openclaw', 'deepseek'].includes(agent)) {
        steps.push(words(agent, { command: boardCommand, codex: codex ? quote(codex) : '' }))
      }
      if (agent === 'cursor' && process.platform === 'win32') steps.push(words('cursorWindows'))
      sessionAgents.push(names[agent])
    }
    if (isPluginInstalled) sessionAgents.push('Claude Code')
    if (sessionAgents.length) steps.push(words(sessionAgents.length === 1 ? 'startOne' : 'start', { agents: sessionAgents.join(message(', ', '、', '、')) }))
    for (const agent of selected.filter((agent, i) => plans[i].conflicts.length)) steps.push(words('retry', { command: setupCommand(['--agent', agent, '--apply']) }))
    if (hasClaude && !isPluginInstalled) steps.push(words('plugin'))
    if (available.length) {
      steps.push(words('board', { command: boardCommand }))
    }
  }
  if (steps.length) lines.push('', words('next'), ...steps.map((step, i) => `${i + 1}. ${step}`))
  process.stdout.write(`${lines.join('\n')}\n`)
}

try { main() } catch (error) {
  process.exitCode = 1
  let failure
  if (error instanceof SetupFailure) {
    const { code, message, ...extra } = error
    failure = { code, message, ...extra }
  } else {
    const code = isCode(error?.code) ? error.code : 'UNKNOWN'
    const reason = typeof error?.message === 'string' && error.message.trim() ? error.message : 'Unknown error'
    failure = code === 'UNKNOWN' ? { code, message: unknownFailed, reason } : { code: 'UNKNOWN', cause: code, message: systemFailed(code) }
  }
  process.stderr.write(`${isJson ? JSON.stringify({ error: failure }) : failure.message}\n`)
}

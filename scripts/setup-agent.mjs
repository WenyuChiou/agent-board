// Preview every selected target before applying any of them. Each target keeps its own
// ownership record while sharing one script, skill and local progress file.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const targets = ['codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity', 'deepseek']
const args = process.argv.slice(2)
// The npm launcher supplies its package name for the setup command in guidance.
const command = process.env.AGENT_BOARD_SETUP_COMMAND || ''
const isJson = args.includes('--json')
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
    "preview": "would update {count} setup files",
    "applied": "updated {count} setup files",
    "ready": "already set up",
    "skipped": "skipped: setup cannot safely update {files}. Fix or move the conflicting files, then retry with {command}.",
    "retry": "Retry after fixing the conflicting files: {command}",
    "skillOnly": "board skill only; automatic reporting is unavailable",
    "claude": "connects through its plugin",
    "connector": "managed by the Claude Code plugin connector; keeps its board at {progress}",
    "next": "Next steps:",
    "apply": "Apply these changes: {command}",
    "codex": "Codex: approve the board's hooks for the Codex app and CLI: preview with {command} --codex-trust --codex-bin {codex}, then run it again with --apply (in the Codex CLI, /hooks also works). Then start a new session.",
    "codexMissing": "Codex: setup could not find Codex; run where.exe codex in PowerShell or command -v codex in bash, then pass its full path to --codex-bin.",
    "reload": "{host}: enable its reporting hooks or plugin, then start a new session.",
    "skill": "{host}: open the board with its agent-board skill; automatic reporting is unavailable.",
    "plugin": "Claude Code: run claude plugin marketplace add WenyuChiou/agent-board, then claude plugin install agent-board@agent-board.",
    "board": "Open the board: {command}"
  },
  {
    "preview": "將更新 {count} 個設定檔案",
    "applied": "已更新 {count} 個設定檔案",
    "ready": "已設定完成",
    "skipped": "已略過：無法安全更新 {files}。請修正或移開衝突的檔案，再執行 {command} 重試。",
    "retry": "修正衝突的檔案後重試：{command}",
    "skillOnly": "僅提供看板技能；尚無自動回報功能",
    "claude": "透過外掛接上看板",
    "connector": "由 Claude Code 外掛的連接器管理；保留看板 {progress}",
    "next": "接下來：",
    "apply": "套用這些變更：{command}",
    "codex": "Codex：為 Codex 應用程式和 CLI 核准看板的 hooks：先執行 {command} --codex-trust --codex-bin {codex} 預覽，再加上 --apply 重新執行同一命令（在 Codex CLI 中也可以使用 /hooks）。然後開始新的工作階段。",
    "codexMissing": "Codex：setup 找不到 Codex；請在 PowerShell 執行 where.exe codex 或在 bash 執行 command -v codex，再用 --codex-bin 傳入完整路徑。",
    "reload": "{host}：啟用回報 hooks 或外掛，再開始新的工作階段。",
    "skill": "{host}：使用 agent-board 技能開啟看板；尚無自動回報功能。",
    "plugin": "Claude Code：執行 claude plugin marketplace add WenyuChiou/agent-board，再執行 claude plugin install agent-board@agent-board。",
    "board": "開啟看板：{command}"
  },
  {
    "preview": "将更新 {count} 个设置文件",
    "applied": "已更新 {count} 个设置文件",
    "ready": "已设置完成",
    "skipped": "已跳过：无法安全更新 {files}。请修复或移走冲突的文件，再运行 {command} 重试。",
    "retry": "修复冲突的文件后重试：{command}",
    "skillOnly": "仅提供看板技能；暂无自动报告功能",
    "claude": "通过插件接上看板",
    "connector": "由 Claude Code 插件的连接器管理；保留看板 {progress}",
    "next": "接下来：",
    "apply": "应用这些更改：{command}",
    "codex": "Codex：为 Codex 应用程序和 CLI 批准看板的 hooks：先运行 {command} --codex-trust --codex-bin {codex} 预览，再加上 --apply 重新运行同一命令（在 Codex CLI 中也可以使用 /hooks）。然后开始新的会话。",
    "codexMissing": "Codex：setup 找不到 Codex；请在 PowerShell 运行 where.exe codex 或在 bash 运行 command -v codex，再用 --codex-bin 传入完整路径。",
    "reload": "{host}：启用报告 hooks 或插件，再开始新的会话。",
    "skill": "{host}：使用 agent-board 技能打开看板；暂无自动报告功能。",
    "plugin": "Claude Code：运行 claude plugin marketplace add WenyuChiou/agent-board，再运行 claude plugin install agent-board@agent-board。",
    "board": "打开看板：{command}"
  }
]
const summary = summaries[['en', 'zh-TW', 'zh-CN'].indexOf(language)]
const words = (key, values = {}) => summary[key].replace(/\{(\w+)\}/g, (text, name) => String(values[name] ?? text))
const names = { codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', gemini: 'Gemini CLI', grok: 'Grok Build', muse: 'Muse Code', hermes: 'Hermes Agent', openclaw: 'OpenClaw', antigravity: 'Antigravity', deepseek: 'DeepSeek' }
const missingValue = message(
  'agent-board: a setup option is missing its value. Options such as --agent, --home and --data-dir each take one; add it after the option and run setup again.',
  'agent-board：setup 有個選項後面沒有接值。--agent、--home、--data-dir 這類選項都要接一個值；請在選項後面補上，再執行一次 setup。',
  'agent-board：setup 有个选项后面没有接值。--agent、--home、--data-dir 这类选项都要接一个值；请在选项后面补上，再运行一次 setup。',
)
const noTarget = message(
  `agent-board: --agent named an agent setup does not know. Name one: ${command ? `${command} ` : ''}--agent codex (or cursor, opencode, gemini, grok, muse, hermes, openclaw, antigravity, deepseek, all).`,
  `agent-board：--agent 寫了 setup 不認得的 agent 名稱。指定一個：${command ? `${command} ` : ''}--agent codex（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。`,
  `agent-board：--agent 写了 setup 不认识的 agent 名称。指定一个：${command ? `${command} ` : ''}--agent codex（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。`,
)
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

// Detect installed commands without starting them during setup.
const findOnPath = (commands, extensions = ['.exe', '.cmd', '.ps1', '.bat']) => {
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path')
  const path = (pathKey ? process.env[pathKey] : '') || ''
  const filenames = process.platform === 'win32' ? commands.flatMap(command => extensions.map(extension => `${command}${extension}`)) : commands
  for (const entry of path.split(delimiter)) {
    const directory = process.platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry
    if (!isAbsolute(directory)) continue
    for (const name of filenames) {
      const file = resolve(directory, name)
      try {
        const stat = statSync(file)
        if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return file
      } catch {}
    }
  }
}

const main = () => {
  const at = args.indexOf('--agent')
  const selector = at < 0 ? 'auto' : args[at + 1]
  if (at >= 0) args.splice(at, 2)
  const homeAt = args.indexOf('--home')
  const home = homeAt < 0 ? homedir() : args[homeAt + 1]
  if (!home || home.startsWith('--') || !selector || selector.startsWith('--')) fail('MISSING_ARGUMENT', missingValue)
  const signs = {
    codex: ['.codex'], cursor: ['.cursor'], opencode: ['.config/opencode'],
    gemini: ['.gemini/settings.json'], grok: ['.grok/config.toml', '.grok/sessions'], muse: ['.config/muse'],
    hermes: ['.hermes'], openclaw: ['.openclaw'], antigravity: ['.gemini/antigravity-cli', '.gemini/antigravity', '.gemini/antigravity-ide'], deepseek: ['.dsh'],
  }
  const commands = {
    codex: ['codex'], cursor: ['cursor-agent', 'cursor'], opencode: ['opencode'], gemini: ['gemini'],
    grok: ['grok'], muse: ['muse'], hermes: ['hermes'], openclaw: ['openclaw'],
    antigravity: ['agy', 'antigravity'], deepseek: ['dsh'],
  }
  const apps = process.platform === 'win32'
    ? process.env.LOCALAPPDATA ? Object.fromEntries(Object.entries({ cursor: 'cursor', antigravity: 'Antigravity' }).map(([agent, folder]) => [agent, [join(process.env.LOCALAPPDATA, 'Programs', folder)]])) : {}
    : process.platform === 'darwin'
      ? Object.fromEntries(Object.entries({ codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity' }).map(([agent, name]) => [agent, [join('/Applications', `${name}.app`), join(home, 'Applications', `${name}.app`)]]))
      : {}
  const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
  const hostDirs = {
    codex: flag('--codex-dir') || process.env.CODEX_HOME,
    grok: flag('--grok-dir') || process.env.GROK_HOME,
    hermes: flag('--hermes-dir') || process.env.HERMES_HOME,
    opencode: flag('--opencode-dir') || process.env.OPENCODE_CONFIG_DIR || (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'opencode') : undefined),
    openclaw: flag('--openclaw-dir') || process.env.OPENCLAW_STATE_DIR,
    deepseek: flag('--deepseek-dir') || process.env.DSH_HOME,
  }
  const data = flag('--data-dir') || join(home, '.agent-board')
  // --home can name another account's home; PATH and apps belong to the running account.
  const selected = selector === 'all' ? targets : selector === 'auto' ? targets.filter(agent =>
    (hostDirs[agent] ? existsSync(hostDirs[agent]) : signs[agent].some(sign => existsSync(join(home, sign))))
    || existsSync(join(data, `install-${agent}.json`))
    || (homeAt < 0 && (findOnPath(commands[agent]) || apps[agent]?.some(app => existsSync(app)))),
  ) : selector.split(',')
  const hasClaude = existsSync(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')) || (homeAt < 0 && !!findOnPath(['claude']))
  const common = args.filter(arg => arg !== '--apply' && arg !== '--json')
  const quote = value => /^[\w./:@=-]+$/.test(value) ? value : process.platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
  const nodeCommand = script => `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`
  const setupCommand = extra => [command || nodeCommand(fileURLToPath(import.meta.url)), ...common.map(quote), ...extra.map(quote)].join(' ')
  if (selector === 'auto' && !selected.length) {
    const next = setupCommand(['--agent', 'codex'])
    const noAgent = message(
      `Setup found no agent on this computer. It looked for their folders in ${home}${homeAt < 0 ? ', their commands on the PATH and their apps' : ''}. Install an agent and run setup again, or name one: ${next} (or cursor, opencode, gemini, grok, muse, hermes, openclaw, antigravity, deepseek, all).`,
      `setup 在這台電腦沒有找到 agent。它找過 ${home} 裡的資料夾${homeAt < 0 ? '、PATH 上的命令和已安裝的應用程式' : ''}。請安裝一個 agent 再執行一次 setup，或指定一個：${next}（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。`,
      `setup 在这台电脑没有找到 agent。它找过 ${home} 里的文件夹${homeAt < 0 ? '、PATH 上的命令和已安装的应用程序' : ''}。请安装一个 agent 再运行一次 setup，或指定一个：${next}（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。`,
    )
    process.stdout.write(`${isJson ? JSON.stringify({ targets: [], plans: [], applied: false }, null, 2) : hasClaude ? `Claude Code: ${words('claude')}\n\n${words('next')}\n1. ${words('plugin')}` : noAgent}\n`)
    return
  }
  if (!selected.length || selected.some(agent => !targets.includes(agent)) || new Set(selected).size !== selected.length) fail('INVALID_TARGETS', noTarget)
  const apply = args.includes('--apply')
  const script = fileURLToPath(new URL('./setup-codex.mjs', import.meta.url))
  const run = (agent, isApplying) => {
    const result = spawnSync(process.execPath, [script, ...common, '--json', '--agent', agent, ...(isApplying ? ['--apply'] : [])], { encoding: 'utf8', windowsHide: true })
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
  if (!available.length) process.exitCode = 1
  const results = plans.map((plan, i) => {
    if (!apply || plan.conflicts.length) return plan
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
  const records = plan => targets.filter(other => !available.includes(other)).map(other => join(plan.data, `install-${other}.json`)).filter(file => {
    try {
      const held = JSON.parse(readFileSync(file, 'utf8')).files ?? {}
      return plan.changes.some(change => Object.hasOwn(held, change.file))
    } catch { return false }
  })
  const lines = selected.map((agent, i) => {
    const plan = results[i]
    const status = plan.managedBy === 'connector' ? words('connector', { progress: plan.progress }) : plan.conflicts.length ? words('skipped', { files: plan.conflicts.join(', '), command: setupCommand(['--agent', agent, '--apply']) })
      : !plan.changes.length ? words('ready') : words(apply ? 'applied' : 'preview', { count: plan.changes.length })
    const capability = plan.managedBy !== 'connector' && !plan.conflicts.length && plan.capabilities.lifecycle === 'adapter-pending' ? `; ${words('skillOnly')}` : ''
    const files = !apply && !plan.conflicts.length ? [...plan.changes.map(change => change.file), ...records(plan)].map(file => `  ${shortPath(file)}`) : []
    return [`${names[agent]}: ${status}${capability}`, ...files].join('\n')
  })
  if (hasClaude) lines.push(`Claude Code: ${words('claude')}`)
  const steps = []
  const boardPlan = available.length ? results[selected.indexOf(available[0])] : null
  const boardCommand = boardPlan ? nodeCommand(boardPlan.script ?? join(boardPlan.data, 'agent-board.mjs')) : ''
  if (!apply && available.some(agent => plans[selected.indexOf(agent)].changes.length)) steps.push(words('apply', { command: setupCommand(['--agent', available.join(','), '--apply']) }))
  for (const agent of available) {
    const plan = results[selected.indexOf(agent)]
    if (plan.managedBy === 'connector') continue
    const codex = agent === 'codex' ? findOnPath(['codex'], ['.exe', '.cmd', '.ps1']) : undefined
    steps.push(words(agent === 'codex' ? codex ? 'codex' : 'codexMissing' : plan.capabilities.lifecycle === 'adapter-pending' ? 'skill' : 'reload', { host: names[agent], command: boardCommand, codex: codex ? quote(codex) : '' }))
  }
  for (const agent of selected.filter((agent, i) => plans[i].conflicts.length)) steps.push(words('retry', { command: setupCommand(['--agent', agent, '--apply']) }))
  if (hasClaude) steps.push(words('plugin'))
  if (available.length) {
    steps.push(words('board', { command: `${boardCommand} --serve` }))
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

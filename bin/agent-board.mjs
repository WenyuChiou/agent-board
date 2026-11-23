#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleFromDir } from '../scripts/bundle-text.mjs'
import { setupAgents } from '../scripts/setup-discovery.mjs'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const { name, version: v } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
const args = process.argv.slice(2)
const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
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
// The options that open the board, each with the value it takes, against the board's own grammar in
// scripts/board-cli.ts (BOOL_FLAGS, VALUE_FLAGS, unknownFlag); tests/npm-package.test.mjs keeps the two in step. Every
// other option picks a board, reads data, presses keys or manages something (#1783).
const boardViews = new Map([
  ['--print', 'none'], ['--watch', 'none'], ['--html', 'none'], ['--serve', 'none'], ['--all', 'none'], ['--plain', 'none'],
  ['--no-color', 'none'], ['--no-open', 'none'], ['--quiet-board', 'none'],
  ['--port', 'digits'], ['--idle-minutes', 'minutes'],
  ['--lan', 'address'],
  ['--lang', 'language'],
  ['--theme', 'word'],
])
// Each value as the board reads it: minutes as `idleTimeout` in hooks/serve.ts takes them, a language `langOf` reads
// or `auto`, and the colour theme as any word (an unknown one leaves the board's own choice).
const viewValues = {
  digits: value => /^\d+$/.test(value),
  minutes: value => /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 525600,
  language: value => value === 'auto' || langOf(value) !== null,
  word: () => true,
}
// A value that is missing or starts with `-`, any other option, `--` and any other word make the list something else.
const isBoardView = list => {
  for (let i = 0; i < list.length; i++) {
    const kind = boardViews.get(list[i])
    const next = list[i + 1]
    if (kind === undefined) return false
    if (kind === 'none') continue
    // `--lan` takes the next word only when it is an address, as the board reads it.
    if (kind === 'address') { if (next !== undefined && /^[\d.]+$/.test(next)) i++; continue }
    if (next === undefined || next.startsWith('-')) return false
    if (!viewValues[kind](next)) return false
    i++
  }
  return true
}
// Windows usually has no LANG, so independent commands also check the system locale.
const systemLang = env => {
  const language = langOf(env)
  if (language !== null) return language
  try { return langOf(Intl.DateTimeFormat().resolvedOptions().locale) } catch { return null }
}
let language = langOf(flag('--lang')) ?? systemLang(process.env.LANG) ?? 'en'
const at = ['en', 'zh-TW', 'zh-CN'].indexOf(language)
const usage = [
  `agent-board ${v}: a local board for coding agents.

Set up, once per computer:
  agent-board setup            preview setup; in a terminal, confirm once to apply
  agent-board setup --apply    make those changes
  setup options: --agent <name>[,<name>] or all, --home <folder>, --data-dir <folder>

The board:
  agent-board                  open the terminal board over SSH or without a display; open the page otherwise
  agent-board stop             stop the board's page
  agent-board --json           read the board as JSON for an agent (--days N for finished)

All options: agent-board --help all (--watch, --print, --tidy, ...)

The board runs the board script that setup installed (~/.agent-board/agent-board.mjs, or the
Claude Code plugin's, beside its progress.md). Other options are passed to it unchanged.
Guide: https://github.com/WenyuChiou/agent-board/blob/main/docs/SETUP.md
Without installing: npx ${name} <the same options>`,
  `agent-board ${v}：給程式 agent 用的本機看板。

設定（每台電腦一次）：
  agent-board setup            預覽設定；在終端機確認一次即可套用
  agent-board setup --apply    套用這些變更
  setup 選項：--agent <名稱>[,<名稱>] 或 all、--home <資料夾>、--data-dir <資料夾>

看板：
  agent-board                  SSH 或無顯示器的終端機開終端看板，其他情況開網頁
  agent-board stop             停止看板網頁
  agent-board --json           供 agent 以 JSON 讀取看板（--days N 包含已完成工作）

所有選項：agent-board --help all（--watch、--print、--tidy...）

看板執行的是 setup 安裝的看板程式（~/.agent-board/agent-board.mjs，或 Claude Code
外掛放在 progress.md 旁的那份）。其他選項原樣交給它。
說明：https://github.com/WenyuChiou/agent-board/blob/main/docs/SETUP.md
不安裝也能用：npx ${name} <同樣的選項>`,
  `agent-board ${v}：给编程 agent 用的本机看板。

设置（每台电脑一次）：
  agent-board setup            预览设置；在终端确认一次即可应用
  agent-board setup --apply    应用这些更改
  setup 选项：--agent <名称>[,<名称>] 或 all、--home <文件夹>、--data-dir <文件夹>

看板：
  agent-board                  SSH 或无显示器的终端打开终端看板，其他情况打开网页
  agent-board stop             停止看板网页
  agent-board --json           供 agent 以 JSON 读取看板（--days N 包含已完成工作）

所有选项：agent-board --help all（--watch、--print、--tidy...）

看板运行的是 setup 安装的看板程序（~/.agent-board/agent-board.mjs，或 Claude Code
插件放在 progress.md 旁的那份）。其他选项原样交给它。
说明：https://github.com/WenyuChiou/agent-board/blob/main/docs/SETUP.md
不安装也能用：npx ${name} <同样的选项>`,
][at]
const usageAll = [
  `agent-board ${v}: a local board for coding agents.

Set up, once per computer:
  agent-board setup            preview setup; in a terminal, confirm once to apply
  agent-board setup --apply    make those changes
  setup options: --agent <name>[,<name>] or all, --home <folder>, --data-dir <folder>

The board:
  agent-board                  open the board where you are
  agent-board stop             stop the board's page
  agent-board --print          print the board as text
  agent-board --json           read the board as JSON for an agent (--days N [--project name])
  agent-board --status         one line for a status bar: needs you and working
  agent-board --watch          the board in this terminal, with keys
  agent-board --serve          old; the same as no option: the board's page in your browser
  agent-board --tidy           archive eligible completed tasks
  agent-board --no-open        start the server without opening a browser
  agent-board --lan            open the board to devices on your local network
  agent-board --port <port>    use this port for the page
  agent-board --lang <lang>    interface language (en, zh-TW, zh-CN)
  agent-board --idle-minutes <n> close the page after idle minutes
  agent-board --all            list idle and stopped tasks

The board runs the board script that setup installed (~/.agent-board/agent-board.mjs, or the
Claude Code plugin's, beside its progress.md). Other options are passed to it unchanged.
Guide: https://github.com/WenyuChiou/agent-board/blob/main/docs/SETUP.md
Without installing: npx ${name} <the same options>`,
  `agent-board ${v}：給程式 agent 用的本機看板。

設定（每台電腦一次）：
  agent-board setup            預覽設定；在終端機確認一次即可套用
  agent-board setup --apply    套用這些變更
  setup 選項：--agent <名稱>[,<名稱>] 或 all、--home <資料夾>、--data-dir <資料夾>

看板：
  agent-board                  在所在位置打開看板
  agent-board stop             停止看板網頁
  agent-board --print          印出純文字看板
  agent-board --json           供 agent 以 JSON 讀取看板（--days N [--project 名稱]）
  agent-board --status         狀態列的一行摘要：等你與進行中項目
  agent-board --watch          在這個終端機開看板，可用按鍵操作
  agent-board --serve          舊用法，同不加選項：在瀏覽器開看板網頁
  agent-board --tidy           封存符合條件的已完成工作
  agent-board --no-open        啟動伺服器但不打開瀏覽器
  agent-board --lan            開放區域網路連線
  agent-board --port <埠號>    指定看板網頁的連接埠
  agent-board --lang <語言>    介面語言（en、zh-TW、zh-CN）
  agent-board --idle-minutes <分> 閒置指定分鐘後自動關閉
  agent-board --all            列出閒置和已停止項目

看板執行的是 setup 安裝的看板程式（~/.agent-board/agent-board.mjs，或 Claude Code
外掛放在 progress.md 旁的那份）。其他選項原樣交給它。
說明：https://github.com/WenyuChiou/agent-board/blob/main/docs/SETUP.md
不安裝也能用：npx ${name} <同樣的選項>`,
  `agent-board ${v}：给编程 agent 用的本机看板。

设置（每台电脑一次）：
  agent-board setup            预览设置；在终端确认一次即可应用
  agent-board setup --apply    应用这些更改
  setup 选项：--agent <名称>[,<名称>] 或 all、--home <文件夹>、--data-dir <文件夹>

看板：
  agent-board                  在所在位置打开看板
  agent-board stop             停止看板网页
  agent-board --print          打印纯文本看板
  agent-board --json           供 agent 以 JSON 读取看板（--days N [--project 名称]）
  agent-board --status         状态栏的一行摘要：等你与进行中项目
  agent-board --watch          在这个终端打开看板，可用按键操作
  agent-board --serve          旧用法，同不加选项：在浏览器打开看板网页
  agent-board --tidy           归档符合条件的已完成工作
  agent-board --no-open        启动服务器但不打开浏览器
  agent-board --lan            开放局域网连接
  agent-board --port <端口>    指定看板网页的端口
  agent-board --lang <语言>    界面语言（en、zh-TW、zh-CN）
  agent-board --idle-minutes <分> 闲置指定分钟后自动关闭
  agent-board --all            列出闲置和已停止项目

看板运行的是 setup 安装的看板程序（~/.agent-board/agent-board.mjs，或 Claude Code
插件放在 progress.md 旁的那份）。其他选项原样交给它。
说明：https://github.com/WenyuChiou/agent-board/blob/main/docs/SETUP.md
不安装也能用：npx ${name} <同样的选项>`,
][at]
const message = (en, tw, cn) => [en, tw, cn][['en', 'zh-TW', 'zh-CN'].indexOf(language)]
const isChat = args.includes('--chat')
// Management commands return their own JSON (doctor, removal, setup, trust, recovery):
// the older-script guard ends JSON board reads only, as scripts/board-cli.ts isJsonBoard does (#1304).
const managing = ['--recover-hooks', '--codex-setup', '--codex-doctor', '--codex-remove', '--remove', '--codex-trust', '--hermes-trust']
const isJsonBoard = args.includes('--json') && !args.some(arg => managing.includes(arg))
const home = homedir()
const isWin = process.platform === 'win32'
// --chat output may be pasted into a chat app, so it shows the home folder as ~, as the board's own --chat does.
const shown = path => isChat && home && (isWin ? path.toLowerCase().startsWith(home.toLowerCase()) : path.startsWith(home)) ? `~${path.slice(home.length)}` : path
const code = error => error?.code ?? error?.name ?? 'UNKNOWN'
const run = (path, passed, { isSetup = false, isRemove = false, env = process.env } = {}) => {
  const setupCmd = isRemove ? `npx ${name} remove` : `npx ${name} setup`
  const result = spawnSync(process.execPath, [path, ...passed], { stdio: isSetup ? ['inherit', 'inherit', 'pipe'] : 'inherit', encoding: 'utf8', env: isSetup ? { ...env, AGENT_BOARD_SETUP_COMMAND: setupCmd } : env, windowsHide: true })
  if (result.error) {
    console.error(message(`agent-board: could not start ${shown(path)} (${code(result.error)}).`, `agent-board：無法啟動 ${shown(path)}（${code(result.error)}）。`, `agent-board：无法启动 ${shown(path)}（${code(result.error)}）。`))
    process.exit(1)
  }
  if (isSetup && result.stderr) {
    process.stderr.write(result.status === 0 ? result.stderr : result.stderr.replaceAll(resolve(pkg), '<agent-board package>').replaceAll(resolve(pkg).replaceAll('\\', '/'), '<agent-board package>'))
  }
  if (result.signal) {
    process.kill(process.pid, result.signal)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}
const unknown = word => {
  console.error(message(`agent-board: unknown command "${word}". The board takes options such as --print or --json; run agent-board --help.`, `agent-board：不認得的指令「${word}」。看板用的是 --print、--json 這類選項；請執行 agent-board --help。`, `agent-board：不认识的命令「${word}」。看板用的是 --print、--json 这类选项；请运行 agent-board --help。`))
  process.exit(2)
}
const isHelp = args.includes('--help') || args.includes('-h')
const showHelp = () => {
  const isAll = args.includes('all')
  console.log(isAll ? usageAll : usage)
  process.exit(0)
}
if (args[0] === 'setup' || args[0] === 'remove') {
  if (isHelp) showHelp()
  const isRemove = args[0] === 'remove'
  const forwarded = isRemove ? ['--remove', ...args.slice(1)] : args.slice(1)
  run(join(pkg, 'scripts/setup-agent.mjs'), forwarded, { isSetup: true, isRemove })
}
if (args.includes('--version') || args.includes('-v')) { console.log(`agent-board ${v}`); process.exit(0) }
if (args[0] === 'help' || isHelp) showHelp()
if (args[0] && !args[0].startsWith('-') && args[0] !== 'stop') unknown(args[0])

const passArgs = []
let dataDir
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--data-dir') { passArgs.push(args[i]); continue }
  const value = args[++i]
  if (!value || value.startsWith('--')) {
    console.error(message('agent-board: --data-dir needs a folder.', 'agent-board：--data-dir 後面要接資料夾。', 'agent-board：--data-dir 后面要接文件夹。'))
    process.exit(2)
  }
  dataDir = value
}
const beside = path => join(dirname(resolve(path)), 'agent-board.mjs')
const connectorProgress = (() => {
  try {
    const record = JSON.parse(readFileSync(join(home, '.agent-board', 'legacy-connect.json'), 'utf8'))
    return record.version === 1 && record.disabled === false && typeof record.connectedProgress === 'string' && isAbsolute(record.connectedProgress) ? record.connectedProgress : undefined
  } catch { return undefined }
})()
const candidates = [
  ...(dataDir ? [join(resolve(dataDir), 'agent-board.mjs')] : [
    ...(flag('--progress-file') ? [beside(flag('--progress-file'))] : []),
    ...(process.env.CLAUDE_PROGRESS_FILE ? [beside(process.env.CLAUDE_PROGRESS_FILE)] : []),
    ...(connectorProgress ? [beside(connectorProgress)] : []),
    join(home, '.agent-board', 'agent-board.mjs'),
    join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'agent-board.mjs'),
  ]),
]
let installed = candidates.find(path => { try { return statSync(path).isFile() } catch { return false } })
// Setup owns the preview and the single consent question for both entry points.
if (!installed && args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  const setup = [join(pkg, 'scripts/setup-agent.mjs')]
  const setupEnv = { ...process.env, AGENT_BOARD_SETUP_COMMAND: `npx ${name} setup` }
  const result = spawnSync(process.execPath, setup, { stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf8', env: setupEnv, windowsHide: true })
  process.stderr.write(result.stderr ?? (result.error ? `${result.error.message}\n` : ''))
  if (result.status !== 0) process.exit(result.status ?? 1)
  installed = candidates.find(path => { try { return statSync(path).isFile() } catch { return false } })
  // A plugin-only setup opens its board in the next Claude session; a declined preview also ends here.
  if (!installed) process.exit(0)
}
if (!installed) {
  const list = candidates.map(path => `  ${shown(path)}`).join('\n')
  console.error(message(`Agent Board is not set up for this account yet. No board script at:\n${list}\nSee what setup would change: npx ${name} setup\nThen apply it:               npx ${name} setup --apply`, `這個帳號還沒設定 Agent Board。以下位置都沒有看板程式：\n${list}\n先看設定會改什麼：npx ${name} setup\n再套用：          npx ${name} setup --apply`, `这个账号还没设置 Agent Board。以下位置都没有看板程序：\n${list}\n先看设置会改什么：npx ${name} setup\n再应用：          npx ${name} setup --apply`))
  process.exit(1)
}
let prelude = {}
try { prelude = JSON.parse(readFileSync(installed, 'utf8').split('\n', 1)[0].replace(/^globalThis\.AGENT_BOARD = /, '')) ?? {} } catch {}
language = langOf(flag('--lang')) ?? langOf(prelude.lang) ?? systemLang(process.env.LANG) ?? 'en'
// The first line holds account settings, so it must not affect build comparisons.
const hash = text => createHash('sha256').update(text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '').digest('hex')
// --chat and --status read the board through the installed script, so on their own they skip
// this comparison. With --json they read it as data, and the older-script guard covers them
// too: a mixed --json --chat or --json --status through an older script must fail the same
// way plain --json does (#1304).
if ((!isChat && !args.includes('--status')) || args.includes('--json')) {
  try {
    // The bundle is kept in hooks/board-script.ts and its parts; the shared reader joins them.
    const bundled = bundleFromDir(pkg)
    const digest = hash(readFileSync(installed, 'utf8'))
    // Setup prepends account settings to the raw bundle; align that header here.
    if (digest !== hash(`\n${bundled}`)) {
      const releases = readFileSync(join(pkg, 'hooks/released.ts'), 'utf8')
      let old
      for (const match of releases.matchAll(/version:\s*'([^']+)'\s*,\s*board:\s*\[([^\]]*)\]/g)) {
        if ([...match[2].matchAll(/'([a-f0-9]{64})'/g)].some(one => one[1] === digest)) old = match[1]
      }
      // Same version number, different bytes: a build from untagged source, not an older release.
      if (old === v) old = undefined
      const path = shown(installed)
      if (old && typeof prelude.codexRoot === 'string') {
        let root = resolve(prelude.codexRoot)
        // The agents setup installs: another install-*.json (a backup copy, or a retired agent's record, which setup
        // refuses by name) is not one (#1783).
        const listed = folder => { try { return readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && /^install-.+\.json$/.test(entry.name)).map(entry => entry.name.slice(8, -5)).filter(agent => setupAgents.includes(agent)).sort() } catch { return undefined } }
        let agents = listed(root)
        // A moved data folder: the board script's own folder is where the board is now.
        if (!agents) { root = dirname(installed); agents = listed(root) ?? [] }
        const folder = shown(root)
        const opts = (agents.length ? ` --agent ${agents.join(',')}` : '') + (root !== join(home, '.agent-board') ? ` --data-dir ${/[^\w.:\\/~@+,=-]/.test(folder) ? `"${folder}"` : folder}` : '')
        const notice = message(`agent-board ${v}: the board script at ${path} is from ${old}. To update it, preview: npx ${name}@${v} setup${opts}, then add --apply.`, `agent-board ${v}：${path} 的看板程式是 ${old} 版。更新前先預覽：npx ${name}@${v} setup${opts}，再加上 --apply。`, `agent-board ${v}：${path} 的看板程序是 ${old} 版。更新前先预览：npx ${name}@${v} setup${opts}，再加上 --apply。`)
        // A person opening the board in a terminal gets the update itself, with setup's one question, in the install root
        // the script names (#1314). Declined or failed, the board still opens on the script that is there. Only opening
        // the board does this: stop, reports, hook events and management commands run as they are, with the notice (#1783).
        // The whole list must read as a board view (boardViews), each value option with its value: a flag after a value
        // option is still acted on by the board, which reads it as that value too, so it must not count (#1783).
        if (process.stdin.isTTY && process.stdout.isTTY && isBoardView(passArgs)) {
          // The board is chosen already, so a progress file the environment names may be another board's: setup keeps
          // the one the install's own record names (#1783).
          const setupEnv = { ...process.env, AGENT_BOARD_SETUP_COMMAND: `npx ${name}@${v} setup` }
          for (const key of Object.keys(setupEnv)) if (key.toUpperCase() === 'CLAUDE_PROGRESS_FILE') delete setupEnv[key]
          // Codex and Grok keep their hooks in the folder setup was given, which their record names: a CODEX_HOME or
          // GROK_HOME naming another folder now must not move the install there (#1783). The usual folder needs no flag.
          const same = (one, other) => process.platform === 'win32' ? resolve(one).toLowerCase() === resolve(other).toLowerCase() : resolve(one) === resolve(other)
          const hostFolders = [['codex', 'CODEX_HOME', '.codex', 1], ['grok', 'GROK_HOME', '.grok', 2]].flatMap(([agent, variable, usual, depth]) => {
            if (!agents.includes(agent)) return []
            let config
            try { config = JSON.parse(readFileSync(join(root, `install-${agent}.json`), 'utf8')).config } catch { return [] }
            if (typeof config !== 'string' || !isAbsolute(config)) return []
            const folder = depth === 1 ? dirname(config) : dirname(dirname(config))
            return same(folder, process.env[variable] || join(home, usual)) ? [] : [`--${agent}-dir`, folder]
          })
          // `--lang auto` keeps the board's own language choice, so setup gets no language for it.
          const setupLang = langOf(flag('--lang'))
          const update = spawnSync(process.execPath, [join(pkg, 'scripts/setup-agent.mjs'), '--update', ...(agents.length ? ['--agent', agents.join(',')] : []), ...(root !== join(home, '.agent-board') ? ['--data-dir', root] : []), ...hostFolders, ...(setupLang ? ['--lang', setupLang] : [])], { stdio: 'inherit', env: setupEnv, windowsHide: true })
          if (update.signal) { process.kill(process.pid, update.signal); process.exit(1) }
          // A setup that could not start printed nothing, so the notice names the command instead (#1783).
          if (update.error) console.error(notice)
        } else console.error(notice)
      } else {
        console.error(old
          ? message(`agent-board ${v}: the board script at ${path} is from ${old}; the Claude Code plugin wrote it. To update it, update the agent-board plugin in Claude Code, then run /progress connect.`, `agent-board ${v}：${path} 的看板程式是 ${old} 版，由 Claude Code 外掛寫入。更新：先在 Claude Code 更新 agent-board 外掛，再執行 /progress connect。`, `agent-board ${v}：${path} 的看板程序是 ${old} 版，由 Claude Code 插件写入。更新：先在 Claude Code 更新 agent-board 插件，再运行 /progress connect。`)
          : message(`agent-board ${v}: the board script at ${path} is a different build (newer, or edited). It runs as it is.`, `agent-board ${v}：${path} 的看板程式是另一個版本（較新，或被改過），照原樣執行。`, `agent-board ${v}：${path} 的看板程序是另一个版本（较新，或被改过），照原样运行。`))
      }
      // --json through an older script must not hand its text board to an agent that expects JSON:
      // the notice above is the whole answer, and the run ends here (#1304). Management
      // commands return their own JSON, so they still run: only a JSON board read ends here.
      if (old !== undefined && isJsonBoard) process.exit(1)
    }
  } catch (error) {
    console.error(message(`agent-board ${v}: could not compare the board script at ${installed} with this package (${code(error)}). It runs as it is.`, `agent-board ${v}：無法比對 ${installed} 的看板程式與這個套件（${code(error)}），照原樣執行。`, `agent-board ${v}：无法比对 ${installed} 的看板程序与这个包（${code(error)}），照原样运行。`))
  }
}
// A separate process preserves argv[1], which the installed page server identifies.
const env = dataDir ? { ...process.env } : process.env
if (dataDir) delete env.CLAUDE_PROGRESS_FILE
// An explicit install root selects both the program and its records; progress may belong to another board.
run(installed, [...passArgs, ...(dataDir ? ['--data-dir', dataDir] : [])], { env: { ...env, AGENT_BOARD_PACKAGE_VERSION: v } })

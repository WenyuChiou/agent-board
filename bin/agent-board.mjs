#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  if (/^en\b|english|英文|英語|英语/.test(text)) return 'en'
  return null
}
let language = langOf(flag('--lang')) ?? langOf(process.env.LANG) ?? 'en'
const at = ['en', 'zh-TW', 'zh-CN'].indexOf(language)
const usage = [
  `agent-board ${v}: a local board for coding agents.

Set up, once per computer:
  agent-board setup            preview what setup would change; writes nothing
  agent-board setup --apply    make those changes
  setup options: --agent <name>[,<name>] or all, --home <folder>, --data-dir <folder>

The board:
  agent-board                  print the board
  agent-board --watch          the board in this terminal, with keys
  agent-board --serve          the board's page in your browser
  agent-board --chat           the board as plain text, for a chat app
  agent-board --html           write the board as a page and open it

The board runs the board script that setup installed (~/.agent-board/agent-board.mjs, or the
Claude Code plugin's, beside its progress.md). Other options are passed to it unchanged.
Guide: https://github.com/WenyuChiou/agent-board/blob/main/docs/SETUP.md
Without installing: npx ${name} <the same options>`,
  `agent-board ${v}：給程式 agent 用的本機看板。

設定（每台電腦一次）：
  agent-board setup            先看設定會改什麼，不寫入任何東西
  agent-board setup --apply    套用這些變更
  setup 選項：--agent <名稱>[,<名稱>] 或 all、--home <資料夾>、--data-dir <資料夾>

看板：
  agent-board                  印出看板
  agent-board --watch          在這個終端機開看板，可用按鍵操作
  agent-board --serve          在瀏覽器開看板網頁
  agent-board --chat           純文字看板，給聊天 app 用
  agent-board --html           把看板寫成網頁並打開

看板執行的是 setup 安裝的看板程式（~/.agent-board/agent-board.mjs，或 Claude Code
外掛放在 progress.md 旁的那份）。其他選項原樣交給它。
說明：https://github.com/WenyuChiou/agent-board/blob/main/docs/SETUP.md
不安裝也能用：npx ${name} <同樣的選項>`,
  `agent-board ${v}：给编程 agent 用的本机看板。

设置（每台电脑一次）：
  agent-board setup            先看设置会改什么，不写入任何东西
  agent-board setup --apply    应用这些更改
  setup 选项：--agent <名称>[,<名称>] 或 all、--home <文件夹>、--data-dir <文件夹>

看板：
  agent-board                  打印看板
  agent-board --watch          在这个终端打开看板，可用按键操作
  agent-board --serve          在浏览器打开看板网页
  agent-board --chat           纯文本看板，给聊天 app 用
  agent-board --html           把看板写成网页并打开

看板运行的是 setup 安装的看板程序（~/.agent-board/agent-board.mjs，或 Claude Code
插件放在 progress.md 旁的那份）。其他选项原样交给它。
说明：https://github.com/WenyuChiou/agent-board/blob/main/docs/SETUP.md
不安装也能用：npx ${name} <同样的选项>`,
][at]
const message = (en, tw, cn) => [en, tw, cn][['en', 'zh-TW', 'zh-CN'].indexOf(language)]
const isChat = args.includes('--chat')
const home = homedir()
const isWin = process.platform === 'win32'
// --chat output may be pasted into a chat app, so it shows the home folder as ~, as the board's own --chat does.
const shown = path => isChat && home && (isWin ? path.toLowerCase().startsWith(home.toLowerCase()) : path.startsWith(home)) ? `~${path.slice(home.length)}` : path
const code = error => error?.code ?? error?.name ?? 'UNKNOWN'
const run = (path, passed, { isSetup = false, env = process.env } = {}) => {
  const result = spawnSync(process.execPath, [path, ...passed], { stdio: isSetup ? ['inherit', 'inherit', 'pipe'] : 'inherit', encoding: 'utf8', env: isSetup ? { ...env, AGENT_BOARD_SETUP_COMMAND: `npx ${name} setup` } : env, windowsHide: true })
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
  console.error(message(`agent-board: unknown command "${word}". The board takes options such as --serve; run agent-board --help.`, `agent-board：不認得的指令「${word}」。看板用的是 --serve 這類選項；請執行 agent-board --help。`, `agent-board：不认识的命令「${word}」。看板用的是 --serve 这类选项；请运行 agent-board --help。`))
  process.exit(2)
}
const isHelp = args.includes('--help') || args.includes('-h')
if (args[0] === 'setup') {
  if (isHelp) { console.log(usage); process.exit(0) }
  run(join(pkg, 'scripts/setup-agent.mjs'), args.slice(1), { isSetup: true })
}
if (args.includes('--version') || args.includes('-v')) { console.log(`agent-board ${v}`); process.exit(0) }
if (args[0] === 'help' || isHelp) { console.log(usage); process.exit(0) }
if (args[0] && !args[0].startsWith('-')) unknown(args[0])

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
const candidates = [
  ...(flag('--progress-file') ? [beside(flag('--progress-file'))] : []),
  ...(dataDir ? [join(resolve(dataDir), 'agent-board.mjs')] : [
    ...(process.env.CLAUDE_PROGRESS_FILE ? [beside(process.env.CLAUDE_PROGRESS_FILE)] : []),
    join(home, '.agent-board', 'agent-board.mjs'),
    join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'agent-board.mjs'),
  ]),
]
const installed = candidates.find(path => { try { return statSync(path).isFile() } catch { return false } })
if (!installed) {
  const list = candidates.map(path => `  ${shown(path)}`).join('\n')
  console.error(message(`Agent Board is not set up for this account yet. No board script at:\n${list}\nSee what setup would change: npx ${name} setup\nThen apply it:               npx ${name} setup --apply`, `這個帳號還沒設定 Agent Board。以下位置都沒有看板程式：\n${list}\n先看設定會改什麼：npx ${name} setup\n再套用：          npx ${name} setup --apply`, `这个账号还没设置 Agent Board。以下位置都没有看板程序：\n${list}\n先看设置会改什么：npx ${name} setup\n再应用：          npx ${name} setup --apply`))
  process.exit(1)
}
let prelude = {}
try { prelude = JSON.parse(readFileSync(installed, 'utf8').split('\n', 1)[0].replace(/^globalThis\.AGENT_BOARD = /, '')) ?? {} } catch {}
language = langOf(flag('--lang')) ?? langOf(prelude.lang) ?? langOf(process.env.LANG) ?? 'en'
// The first line holds account settings, so it must not affect build comparisons.
const hash = text => createHash('sha256').update(text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '').digest('hex')
if (!isChat) {
  try {
    const source = readFileSync(join(pkg, 'hooks/board-script.ts'), 'utf8')
    const marker = 'export const BOARD_SCRIPT = '
    const bundled = JSON.parse(source.slice(source.indexOf(marker) + marker.length))
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
        // The agents scripts/setup-agent.mjs knows; another install-*.json (a backup copy) is not one.
        const targets = ['codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity', 'deepseek']
        const listed = folder => { try { return readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && /^install-.+\.json$/.test(entry.name)).map(entry => entry.name.slice(8, -5)).filter(agent => targets.includes(agent)).sort() } catch { return undefined } }
        let agents = listed(root)
        // A moved data folder: the board script's own folder is where the board is now.
        if (!agents) { root = dirname(installed); agents = listed(root) ?? [] }
        const folder = shown(root)
        const opts = (agents.length ? ` --agent ${agents.join(',')}` : '') + (root !== join(home, '.agent-board') ? ` --data-dir ${/[^\w.:\\/~@+,=-]/.test(folder) ? `"${folder}"` : folder}` : '')
        console.error(message(`agent-board ${v}: the board script at ${path} is from ${old}. To update it, preview: npx ${name}@${v} setup${opts}, then add --apply.`, `agent-board ${v}：${path} 的看板程式是 ${old} 版。更新前先預覽：npx ${name}@${v} setup${opts}，再加上 --apply。`, `agent-board ${v}：${path} 的看板程序是 ${old} 版。更新前先预览：npx ${name}@${v} setup${opts}，再加上 --apply。`))
      } else {
        console.error(old
          ? message(`agent-board ${v}: the board script at ${path} is from ${old}; the Claude Code plugin wrote it. To update it, update the agent-board plugin in Claude Code, then run /progress connect.`, `agent-board ${v}：${path} 的看板程式是 ${old} 版，由 Claude Code 外掛寫入。更新：先在 Claude Code 更新 agent-board 外掛，再執行 /progress connect。`, `agent-board ${v}：${path} 的看板程序是 ${old} 版，由 Claude Code 插件写入。更新：先在 Claude Code 更新 agent-board 插件，再运行 /progress connect。`)
          : message(`agent-board ${v}: the board script at ${path} is a different build (newer, or edited). It runs as it is.`, `agent-board ${v}：${path} 的看板程式是另一個版本（較新，或被改過），照原樣執行。`, `agent-board ${v}：${path} 的看板程序是另一个版本（较新，或被改过），照原样运行。`))
      }
    }
  } catch (error) {
    console.error(message(`agent-board ${v}: could not compare the board script at ${installed} with this package (${code(error)}). It runs as it is.`, `agent-board ${v}：無法比對 ${installed} 的看板程式與這個套件（${code(error)}），照原樣執行。`, `agent-board ${v}：无法比对 ${installed} 的看板程序与这个包（${code(error)}），照原样运行。`))
  }
}
// A separate process preserves argv[1], which the installed page server identifies.
const env = dataDir ? { ...process.env } : process.env
if (dataDir) delete env.CLAUDE_PROGRESS_FILE
run(installed, passArgs, { env: { ...env, AGENT_BOARD_PACKAGE_VERSION: v } })

// Preview every selected target before applying any of them. Each target keeps its own
// ownership record while sharing one script, skill and local progress file.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  if (/^en\b|english|英文|英語|英语/.test(text)) return 'en'
  return null
}
const langAt = args.indexOf('--lang')
const language = langOf(langAt < 0 ? undefined : args[langAt + 1]) ?? langOf(process.env.LANG) ?? 'en'
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
    "next": "Next steps:",
    "apply": "Apply these changes: {command}",
    "codex": "Codex: trust the hooks with /hooks, then start a new session.",
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
    "next": "接下來：",
    "apply": "套用這些變更：{command}",
    "codex": "Codex：透過 /hooks 信任 hooks，再開始新的工作階段。",
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
    "next": "接下来：",
    "apply": "应用这些更改：{command}",
    "codex": "Codex：通过 /hooks 信任 hooks，再开始新的会话。",
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
  `agent-board: setup found no agent to set up on this computer, or --agent named one it does not know. Name one: ${command ? `${command} ` : ''}--agent codex (or cursor, opencode, gemini, grok, muse, hermes, openclaw, antigravity, deepseek, all).`,
  `agent-board：setup 在這台電腦找不到要設定的 agent，或 --agent 寫了它不認得的名稱。指定一個：${command ? `${command} ` : ''}--agent codex（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。`,
  `agent-board：setup 在这台电脑找不到要设置的 agent，或 --agent 写了它不认识的名称。指定一个：${command ? `${command} ` : ''}--agent codex（或 cursor、opencode、gemini、grok、muse、hermes、openclaw、antigravity、deepseek、all）。`,
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
class SetupFailure extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}
const fail = (code, message, extra = {}) => { throw new SetupFailure(code, message, extra) }

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
  const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
  const hostDirs = {
    codex: flag('--codex-dir') || process.env.CODEX_HOME,
    grok: flag('--grok-dir') || process.env.GROK_HOME,
    hermes: flag('--hermes-dir') || process.env.HERMES_HOME,
    opencode: flag('--opencode-dir') || process.env.OPENCODE_CONFIG_DIR || (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'opencode') : undefined),
    openclaw: flag('--openclaw-dir') || process.env.OPENCLAW_STATE_DIR,
    deepseek: flag('--deepseek-dir') || process.env.DSH_HOME,
  }
  const selected = selector === 'all' ? targets : selector === 'auto' ? targets.filter(agent => hostDirs[agent] ? existsSync(hostDirs[agent]) : signs[agent].some(sign => existsSync(join(home, sign)))) : selector.split(',')
  const hasClaude = existsSync(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'))
  if (selector === 'auto' && !selected.length && hasClaude) {
    process.stdout.write(`${isJson ? JSON.stringify({ targets: [], plans: [], applied: false }, null, 2) : `Claude Code: ${words('claude')}\n\n${words('next')}\n1. ${words('plugin')}`}\n`)
    return
  }
  if (!selected.length || selected.some(agent => !targets.includes(agent)) || new Set(selected).size !== selected.length) fail('INVALID_TARGETS', noTarget)
  const apply = args.includes('--apply')
  const common = args.filter(arg => arg !== '--apply' && arg !== '--json')
  const script = fileURLToPath(new URL('./setup-codex.mjs', import.meta.url))
  const run = (agent, isApplying) => {
    const result = spawnSync(process.execPath, [script, ...common, '--json', '--agent', agent, ...(isApplying ? ['--apply'] : [])], { encoding: 'utf8', windowsHide: true })
    const fallback = () => fail('SETUP_FAILED', childFailed(names[agent]), { agent, cause: result.error?.code ?? 'UNKNOWN' })
    if (result.error) fallback()
    if (result.status !== 0) {
      for (const line of (result.stderr ?? '').trim().split(/\r?\n/).reverse()) {
        let error
        try { error = JSON.parse(line)?.error } catch {}
        if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') fail('SETUP_FAILED', error.message, { agent, cause: error.code })
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
  const quote = value => /^[\w./:@=-]+$/.test(value) ? value : process.platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
  const nodeCommand = script => `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`
  const setupCommand = extra => [command || nodeCommand(fileURLToPath(import.meta.url)), ...common.map(quote), ...extra.map(quote)].join(' ')
  const lines = selected.map((agent, i) => {
    const plan = results[i]
    const status = plan.conflicts.length ? words('skipped', { files: plan.conflicts.join(', '), command: setupCommand(['--agent', agent, '--apply']) })
      : !plan.changes.length ? words('ready') : words(apply ? 'applied' : 'preview', { count: plan.changes.length })
    const capability = !plan.conflicts.length && plan.capabilities.lifecycle === 'adapter-pending' ? `; ${words('skillOnly')}` : ''
    return `${names[agent]}: ${status}${capability}`
  })
  if (hasClaude) lines.push(`Claude Code: ${words('claude')}`)
  const steps = []
  if (!apply && available.some(agent => plans[selected.indexOf(agent)].changes.length)) steps.push(words('apply', { command: setupCommand(['--agent', available.join(','), '--apply']) }))
  for (const agent of available) {
    const plan = results[selected.indexOf(agent)]
    steps.push(words(agent === 'codex' ? 'codex' : plan.capabilities.lifecycle === 'adapter-pending' ? 'skill' : 'reload', { host: names[agent] }))
  }
  for (const agent of selected.filter((agent, i) => plans[i].conflicts.length)) steps.push(words('retry', { command: setupCommand(['--agent', agent, '--apply']) }))
  if (hasClaude) steps.push(words('plugin'))
  if (available.length) {
    const script = join(results[selected.indexOf(available[0])].data, 'agent-board.mjs')
    const boardCommand = `${nodeCommand(script)} --serve`
    steps.push(words('board', { command: boardCommand }))
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
    const cause = error?.code
    failure = { code: 'UNKNOWN', message: unknownFailed, ...(typeof cause === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause) ? { cause } : {}) }
  }
  process.stderr.write(`${isJson ? JSON.stringify({ error: failure }) : failure.message}\n`)
}

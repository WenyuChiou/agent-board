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
  if (selector === 'auto' && !selected.length && existsSync(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'))) {
    const guidance = message(
      'agent-board: only Claude Code was found on this computer, and it connects through its plugin instead of setup. Run claude plugin marketplace add WenyuChiou/agent-board, then claude plugin install agent-board@agent-board.',
      'agent-board：這台電腦只找到 Claude Code，它透過外掛接上，不用 setup。請執行 claude plugin marketplace add WenyuChiou/agent-board，再執行 claude plugin install agent-board@agent-board。',
      'agent-board：这台电脑只找到 Claude Code，它通过插件接上，不用 setup。请运行 claude plugin marketplace add WenyuChiou/agent-board，再运行 claude plugin install agent-board@agent-board。',
    )
    process.stdout.write(`${isJson ? JSON.stringify({ targets: [], plans: [], applied: false }, null, 2) : guidance}\n`)
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
  if (plans.some(plan => plan.conflicts.length)) {
    process.stdout.write(`${JSON.stringify({ targets: selected, plans, applied: false }, null, 2)}\n`)
    process.exitCode = 1
    if (!isJson) {
      const conflicted = selected.filter((agent, i) => plans[i].conflicts.length).map(agent => names[agent])
      const hosts = language === 'en' && conflicted.length > 1 ? `${conflicted.slice(0, -1).join(', ')} and ${conflicted[conflicted.length - 1]}` : conflicted.join(language === 'en' ? ', ' : '、')
      process.stderr.write(`${message(
        `agent-board: setup stopped without changing anything, because it cannot safely update the files for ${hosts}. Fix or move the files listed under "conflicts" in the output above, then run setup again.`,
        `agent-board：setup 沒有改動任何東西就停下來了，因為無法安全更新 ${hosts} 的檔案。請修正或移開上面輸出「conflicts」列出的檔案，再執行一次 setup。`,
        `agent-board：setup 没有改动任何内容就停下来了，因为无法安全更新 ${hosts} 的文件。请修正或移开上面输出「conflicts」列出的文件，再运行一次 setup。`,
      )}\n`)
    }
  } else {
    const results = apply ? selected.map(agent => run(agent, true)) : plans
    process.stdout.write(`${JSON.stringify({ targets: selected, plans: results, applied: apply }, null, 2)}\n`)
  }
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

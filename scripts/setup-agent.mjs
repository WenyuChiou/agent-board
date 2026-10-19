// Preview every selected target before applying any of them. Each target keeps its own
// ownership record while sharing one script, skill and local progress file.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const targets = ['codex', 'cursor', 'opencode', 'gemini', 'grok', 'muse', 'hermes', 'openclaw', 'antigravity']
const args = process.argv.slice(2)
const at = args.indexOf('--agent')
const selector = at < 0 ? 'auto' : args[at + 1]
if (at >= 0) args.splice(at, 2)
const homeAt = args.indexOf('--home')
const home = homeAt < 0 ? homedir() : args[homeAt + 1]
if (!home || !selector) throw new Error('MISSING_ARGUMENT')
const signs = {
  codex: ['.codex'], cursor: ['.cursor'], opencode: ['.config/opencode'],
  gemini: ['.gemini/settings.json'], grok: ['.grok/config.toml', '.grok/sessions'], muse: ['.config/muse'],
  hermes: ['.hermes'], openclaw: ['.openclaw'], antigravity: ['.gemini/antigravity-cli', '.gemini/antigravity', '.gemini/antigravity-ide'],
}
const selected = selector === 'all' ? targets : selector === 'auto' ? targets.filter(agent => signs[agent].some(sign => existsSync(join(home, sign)))) : selector.split(',')
if (!selected.length || selected.some(agent => !targets.includes(agent)) || new Set(selected).size !== selected.length) throw new Error('INVALID_TARGETS')
const apply = args.includes('--apply')
const common = args.filter(arg => arg !== '--apply')
const script = fileURLToPath(new URL('./setup-codex.mjs', import.meta.url))
const run = (agent, isApplying) => {
  const result = spawnSync(process.execPath, [script, ...common, '--agent', agent, ...(isApplying ? ['--apply'] : [])], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`SETUP_FAILED:${agent}:${result.stderr}`)
  return JSON.parse(result.stdout)
}
const plans = selected.map(agent => run(agent, false))
if (plans.some(plan => plan.conflicts.length)) {
  process.stdout.write(`${JSON.stringify({ targets: selected, plans, applied: false }, null, 2)}\n`)
  process.exitCode = 1
} else {
  const results = apply ? selected.map(agent => run(agent, true)) : plans
  process.stdout.write(`${JSON.stringify({ targets: selected, plans: results, applied: apply }, null, 2)}\n`)
}

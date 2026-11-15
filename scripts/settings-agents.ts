import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { boardRun } from '../hooks/board-commands'
import { scanBlocks } from '../hooks/blocks'
import { hermesHome } from '../hooks/hermes-home'
import type { Strings } from '../hooks/i18n'
import { settingsAgentState } from '../hooks/settings-agents'
import type { SettingsAgentRow } from '../hooks/settings-agents'
import { discoverCodexBinary } from './codex-host'
import { runCodexLocal, setupFailure } from './codex-local'
import type { LocalPlan } from './codex-local'
import { ConnectTransaction } from './connect-transaction'
import { discoverSetupAgents, findOnPath, hasBoardPlugin, isBoardPluginDisabled, retiredAgents, setupAgents, setupRecordChanges } from './setup-discovery.mjs'

type AgentPlan = LocalPlan & { data: string; installed?: boolean; hooksTrusted?: boolean | 'unknown'; managedBy?: string }
type AgentResult = { status: number; note: string; count?: number }
export type SettingsAgentControl = {
  rows: () => Promise<SettingsAgentRow[]>
  preview: (agent: unknown, action: unknown) => Promise<AgentResult>
  change: (agent: unknown, action: 'setup' | 'remove') => Promise<AgentResult>
}

export const createSettingsAgents = (o: { args: string[]; progress: string; script: string; words: () => Strings; readProgress: () => string }): SettingsAgentControl => {
  const flag = (name: string): string | undefined => {
    const at = o.args.indexOf(name)
    return at < 0 ? undefined : o.args[at + 1]
  }
  const baked = (globalThis as { AGENT_BOARD?: { codexRoot?: string } }).AGENT_BOARD
  const home = resolve(flag('--home') ?? homedir())
  const data = resolve(flag('--data-dir') ?? baked?.codexRoot ?? join(home, '.agent-board'))
  const context = ['--home', home, '--data-dir', data, '--progress-file', o.progress, '--json']
  for (const name of ['--codex-dir', '--grok-dir', '--hermes-dir', '--opencode-dir', '--openclaw-dir', '--deepseek-dir']) {
    const value = flag(name)
    if (value !== undefined) context.push(name, value)
  }
  const record = (agent: string): string => join(data, `install-${agent}.json`)
  // A retired agent (Gemini CLI, #1327) is never offered for setup, but an install an earlier
  // release wrote still counts as an install: Settings shows its row with Remove only, and it
  // keeps the board needed when another agent is removed.
  const recorded: readonly string[] = [...setupAgents, ...retiredAgents]
  const isKnown = (agent: unknown, action: unknown): agent is string => typeof agent === 'string'
    && (agent === 'claude' || setupAgents.some(one => one === agent) || action === 'remove' && retiredAgents.some(one => one === agent))
  const execute = async (agent: string, mode: string, isApplying = false): Promise<AgentPlan> => {
    let result: unknown
    const binary = agent === 'codex' && mode === '--codex-trust'
      ? flag('--codex-bin') ?? discoverCodexBinary() ?? findOnPath(['codex'], ['.exe', '.cmd', '.ps1']) : undefined
    const extra = binary === undefined ? [] : ['--codex-bin', binary]
    await runCodexLocal([...context, mode, '--agent', agent, ...extra, ...(isApplying ? ['--apply'] : [])], o.progress, o.words(), undefined, {
      output: value => { result = value },
      // This guard runs inside the installer's lock, after it checks its observed files.
      beforeApply: mode === '--codex-remove' ? plan => protectRemoval(agent, plan) : undefined,
    })
    if (result === undefined) throw new Error('UNKNOWN')
    return result as AgentPlan
  }
  const terminalRemoval = (agent: string): string => agent === 'claude'
    ? 'claude plugin uninstall agent-board@agent-board --scope user'
    : `${boardRun(o.script)} ${['--codex-remove', ...context.filter(arg => arg !== '--json'), '--agent', agent, '--apply'].map(value => /^[\w./:@=-]+$/.test(value) ? value : process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`).join(' ')}`
  const refusal = (agent: string): string => o.words().settingsAgentCloseFirst(terminalRemoval(agent))
  const identity = (file: string): string => {
    let path = resolve(file)
    try { path = realpathSync(path) } catch {}
    return process.platform === 'win32' ? path.toLowerCase() : path
  }
  const protectRemoval = (agent: string, plan: LocalPlan): void => {
    const isLast = !recorded.some(other => other !== agent && existsSync(record(other)))
    const needed = [o.script, join(dirname(o.progress), 'agent-board.mjs'), o.progress].map(identity)
    const removesNeeded = plan.changes.some(change => change.action === 'remove' && needed.some(file => {
      const from = relative(identity(change.file), file)
      return from === '' || from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from)
    }))
    if (isLast || removesNeeded) throw Object.assign(new Error('BOARD_RUNNING'), { note: refusal(agent) })
  }
  let cached: { at: number; installed: Set<string>; broken: Set<string>; connected: Set<string>; found: Set<string>; hasClaude: boolean; isUntrusted: boolean } | null = null
  let reading: Promise<void> | null = null
  let isBusy = false
  let generation = 0
  const detect = async (): Promise<void> => {
    if (cached !== null && Date.now() - cached.at < 10_000) return
    if (reading !== null) return reading
    const observed = generation
    reading = (async () => {
      const installed = new Set<string>()
      // A record that cannot be read, or is damaged, marks only its own row: the other agents still
      // show. The row counts as set up, since setup itself refuses to touch that agent until the
      // record is moved away, and its note says so.
      const broken = new Set<string>()
      for (const agent of recorded) if (existsSync(record(agent))) {
        installed.add(agent)
        try {
          const manifest = JSON.parse(readFileSync(record(agent), 'utf8')) as { files?: unknown }
          if (manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('INVALID_INSTALL_RECORD')
        } catch { broken.add(agent) }
      }
      // A damaged connect record must not hide the agents either. A press still reads it and reports it.
      let connector: ConnectTransaction['state'] | undefined
      try { connector = new ConnectTransaction(home, undefined).state } catch {}
      const connected = new Set<string>()
      if (connector !== undefined && !connector.disabled) for (const agent of connector.setup?.agents ?? []) if (agent.hook === 'configured') connected.add(agent.agent)
      const found = new Set<string>(discoverSetupAgents(home, data, {
        codex: flag('--codex-dir') || process.env.CODEX_HOME,
        grok: flag('--grok-dir') || process.env.GROK_HOME,
        hermes: flag('--hermes-dir') || hermesHome(home, sep, process.env, process.platform),
        opencode: flag('--opencode-dir') || process.env.OPENCODE_CONFIG_DIR || (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'opencode') : undefined),
        openclaw: flag('--openclaw-dir') || process.env.OPENCLAW_STATE_DIR,
        deepseek: flag('--deepseek-dir') || process.env.DSH_HOME,
      }, !o.args.includes('--home')))
      const claudeDirectory = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')
      // Installed and not turned off, as setup reads it: copied settings alone are not an install (#1203).
      const hasClaude = hasBoardPlugin(claudeDirectory) && !isBoardPluginDisabled(claudeDirectory) && connector?.disabled !== true
      let isUntrusted = false
      if (installed.has('codex') || connected.has('codex')) {
        // An unavailable Codex check must not hide the other agents.
        try { isUntrusted = (await execute('codex', '--codex-doctor')).hooksTrusted === false } catch { isUntrusted = false }
      }
      if (observed === generation) cached = { at: Date.now(), installed, broken, connected, found, hasClaude, isUntrusted }
    })().finally(() => { reading = null })
    return reading
  }
  const rows = async (): Promise<SettingsAgentRow[]> => {
    do { await detect() } while (cached === null)
    const snapshot = cached!
    const lines = o.readProgress().split('\n')
    const onBoard = new Set(scanBlocks(lines).map(span => span.agent))
    const setUp = new Set([...snapshot.installed, ...snapshot.connected])
    const agents: string[] = [...setupAgents, ...retiredAgents.filter(agent => setUp.has(agent)), ...(snapshot.hasClaude ? ['claude'] : [])]
    return agents.map(agent => {
      const isSetUp = agent === 'claude' || setUp.has(agent)
      const state = settingsAgentState(isSetUp, onBoard.has(agent), agent === 'codex' && snapshot.isUntrusted, snapshot.found.has(agent), o.words())
      const name = o.words().agentNames[agent] ?? agent
      const note = snapshot.broken.has(agent) ? setupFailure(Object.assign(new Error('INVALID_INSTALL_RECORD'), { record: `install-${agent}.json` }), agent, o.words()).message
        : snapshot.connected.has(agent) && !snapshot.installed.has(agent) ? o.words().settingsAgentConnector(name)
        : isSetUp && (agent === 'claude' || setUp.size === 1) ? refusal(agent) : undefined
      return { agent, name, ...state, ...(note === undefined ? {} : { note }) }
    })
  }
  const failed = (error: unknown, agent: string): AgentResult => ({ status: 409, note: (error as { note?: string })?.note ?? setupFailure(error, agent, o.words()).message })
  const preview = async (agent: unknown, action: unknown): Promise<AgentResult> => {
    if (!isKnown(agent, action) || action !== 'setup' && action !== 'remove') return { status: 400, note: o.words().settingsAgentInvalid }
    if (isBusy) return { status: 409, note: o.words().settingsAgentsBusy }
    if (agent === 'claude') return { status: 409, note: refusal(agent) }
    try {
      const plan = await checkedPlan(agent, action)
      const count = new Set([...plan.changes.map(change => change.file), ...(action === 'setup' ? setupRecordChanges(plan, [agent]) : [])]).size
      const name = o.words().agentNames[agent] ?? agent
      return { status: 200, count, note: action === 'setup' ? o.words().settingsAgentSetupConfirm(name, count, agent === 'codex' || agent === 'hermes') : o.words().settingsAgentRemoveConfirm(name) }
    } catch (error) { return failed(error, agent) }
  }
  const change = async (agent: unknown, action: 'setup' | 'remove'): Promise<AgentResult> => {
    if (!isKnown(agent, action)) return { status: 400, note: o.words().settingsAgentInvalid }
    if (isBusy) return { status: 409, note: o.words().settingsAgentsBusy }
    if (agent === 'claude') return { status: 409, note: refusal(agent) }
    isBusy = true
    try {
      const plan = await checkedPlan(agent, action)
      if (action === 'remove' || plan.changes.length) await execute(agent, action === 'setup' ? '--codex-setup' : '--codex-remove', true)
      if (action === 'setup' && (agent === 'codex' || agent === 'hermes')) await execute(agent, agent === 'codex' ? '--codex-trust' : '--hermes-trust', true)
      const name = o.words().agentNames[agent] ?? agent
      return { status: 200, note: action === 'setup' ? o.words().settingsAgentSetupDone(name) : o.words().settingsAgentRemoved(name) }
    } catch (error) { return failed(error, agent) }
    finally { generation++; cached = null; isBusy = false }
  }
  const checkedPlan = async (agent: string, action: 'setup' | 'remove'): Promise<AgentPlan> => {
    const connector = new ConnectTransaction(home, undefined).state
    const note = o.words().settingsAgentConnector(o.words().agentNames[agent] ?? agent)
    if (!connector.disabled && connector.setup?.agents.some(one => one.agent === agent && one.hook === 'configured') && !existsSync(record(agent))) throw Object.assign(new Error('BOARD_RUNNING'), { note })
    const plan = await execute(agent, action === 'setup' ? '--codex-setup' : '--codex-remove')
    if (plan.managedBy === 'connector') throw Object.assign(new Error('BOARD_RUNNING'), { note })
    if (plan.conflicts.length) throw new Error('INSTALL_CONFLICT')
    if (action === 'remove') protectRemoval(agent, plan)
    return plan
  }
  return { rows, preview, change }
}

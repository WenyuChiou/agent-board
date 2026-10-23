import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Lang, Strings } from '../hooks/i18n'
import { BOARD_FOR, agentHooks, connectDataRoots, connectPath, isNodeSupported, isSetupState, nodeVersionOf, setupSeed, setupProblemText, withoutSection } from '../hooks/connect-pure'
import { managedCommandLines } from '../hooks/codex-fallback'
import { codexBinaryOf, codexConfigHash, findCodexExecutable, inspectCodexHooks } from './codex-host'
import { codexApproval } from './codex-approval'
import type { CodexApproval, CodexCheck, CodexFound } from './codex-approval'
import type { ConnectContext, SetupState } from '../hooks/connect-pure'
import { langOf, STRINGS } from '../hooks/strings'
import { installControlRoot, withInstallLock } from './install-control'
import { connectLegacy } from './legacy-connect'

export type LegacyConnectRequest = {
  mode: 'auto' | 'connect' | 'remove' | 'status' | 'ack' | 'language'
  home: string
  progress: string
  lang: Lang
  node: string | null
  openclawVersion?: string
  codexExecutable?: string
  boardLang?: Lang
  acknowledgement?: { revision: number; keys: string[] }
  dirs?: Partial<Record<'codex' | 'grok' | 'hermes' | 'openclaw' | 'opencode', string>>
  seed?: { owned?: Record<string, string>; disabled?: boolean; notified?: string[]; boardLang?: Lang; setup?: SetupState }
}
type Step = { file: string; before: string | null; after: string | null; generated: boolean }
type Pending = { request: LegacyConnectRequest; bundle: string; step?: Step }
export type ConnectState = {
  version: 1
  revision: number
  disabled: boolean
  owned: Record<string, string>
  notified: string[]
  boardLang?: Lang
  setup?: SetupState
  codexApproval?: CodexApproval
  connectedProgress?: string
  pending?: Pending
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
export const readLocal = (file: string): string => {
  try { return readFileSync(file, 'utf8') } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return ''
    throw error
  }
}
export const readMaybe = (file: string): string | null => {
  try { return readLocal(file) } catch { return null }
}
const fingerprint = (file: string): string | null => existsSync(file) ? hash(readLocal(file)) : null
const atomic = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600
  const fd = openSync(temporary, 'wx', mode)
  try { writeFileSync(fd, text) } finally { closeSync(fd) }
  try { renameSync(temporary, file) } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

export class ConnectTransaction {
  readonly file: string
  readonly state: ConnectState
  private readonly observed = new Map<string, string | null>()

  constructor(home: string, seed: LegacyConnectRequest['seed']) {
    this.file = join(installControlRoot(home), 'legacy-connect.json')
    const authority = join(installControlRoot(home), 'legacy-connect-authority')
    if (existsSync(authority) && readLocal(authority) !== '1\n') throw new Error('INVALID_CONNECT_AUTHORITY')
    if (existsSync(authority) && !existsSync(this.file)) throw new Error('MISSING_CONNECT_STATE')
    if (existsSync(this.file)) {
      const state = JSON.parse(readLocal(this.file)) as ConnectState
      if (state.codexApproval !== undefined && (state.codexApproval === null || typeof state.codexApproval !== 'object' || Array.isArray(state.codexApproval) || typeof state.codexApproval.source !== 'string' || !isAbsolute(state.codexApproval.source) || typeof state.codexApproval.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(state.codexApproval.sourceHash) || state.codexApproval.configHash !== undefined && state.codexApproval.configHash !== null && (typeof state.codexApproval.configHash !== 'string' || !/^[a-f0-9]{64}$/.test(state.codexApproval.configHash)))) throw new Error('INVALID_CONNECT_STATE')
      const binary = state.codexApproval?.binary
      if (binary !== undefined && (binary === null || typeof binary !== 'object' || Array.isArray(binary) || typeof binary.path !== 'string' || !isAbsolute(binary.path) || !Number.isSafeInteger(binary.size) || binary.size < 0 || typeof binary.mtime !== 'number' || !Number.isFinite(binary.mtime))) throw new Error('INVALID_CONNECT_STATE')
      if (state.connectedProgress !== undefined && (typeof state.connectedProgress !== 'string' || !isAbsolute(state.connectedProgress))) throw new Error('INVALID_CONNECT_STATE')
      if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.disabled !== 'boolean' || state.owned === null || typeof state.owned !== 'object' || Array.isArray(state.owned) || Object.entries(state.owned).some(([file, value]) => !isAbsolute(file) || typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) || !Array.isArray(state.notified) || state.notified.some(value => typeof value !== 'string') || state.boardLang !== undefined && langOf(state.boardLang) !== state.boardLang || state.setup !== undefined && !isSetupState(state.setup)) throw new Error('INVALID_CONNECT_STATE')
      if (state.pending !== undefined) {
        if (state.pending === null || typeof state.pending !== 'object' || typeof state.pending.bundle !== 'string' || !/^[a-f0-9]{64}$/.test(state.pending.bundle)) throw new Error('INVALID_CONNECT_STATE')
        const pending = checkedRequest(state.pending.request)
        if (pending.mode === 'status' || pending.mode === 'ack' || pending.mode === 'language') throw new Error('INVALID_CONNECT_STATE')
        const step = state.pending.step
        if (step !== undefined && (step === null || typeof step !== 'object' || typeof step.file !== 'string' || !isAbsolute(step.file) || typeof step.generated !== 'boolean' || [step.before, step.after].some(value => value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))))) throw new Error('INVALID_CONNECT_STATE')
      }
      this.state = state
    } else {
      const owned = Object.fromEntries(Object.entries(seed?.owned ?? {}).filter(([file, value]) => isAbsolute(file) && /^[a-f0-9]{64}$/.test(value)))
      this.state = { version: 1, revision: 0, disabled: seed?.disabled === true, owned, notified: seed?.notified?.filter(value => typeof value === 'string') ?? [], ...(seed?.boardLang !== undefined && langOf(seed.boardLang) === seed.boardLang ? { boardLang: seed.boardLang } : {}) }
      const setup = setupSeed(seed?.setup)
      if (setup !== undefined) this.state.setup = setup
    }
  }

  save(): void { atomic(this.file, `${JSON.stringify(this.state, null, 2)}\n`) }

  read(file: string): string {
    const text = readLocal(file)
    if (!this.observed.has(file)) this.observed.set(file, existsSync(file) ? hash(text) : null)
    return text
  }

  exists(file: string): boolean { return existsSync(file) }

  maybe(file: string): string | null { try { return this.read(file) } catch { return null } }

  previous(file: string): string | undefined {
    const text = this.read(file)
    return hash(text) === this.state.owned[file] ? text : undefined
  }

  own(file: string, text: string): void {
    if (fingerprint(file) !== hash(text)) throw new Error('INSTALL_CHANGED')
    this.state.owned[file] = hash(text)
    this.save()
  }

  // Only fingerprints and ownership metadata enter the journal. Host config and
  // credential bodies are read and merged in this process, never staged in a plan.
  change(file: string, text: string | null, generated = false): void {
    const pending = this.state.pending
    if (pending === undefined) throw new Error('NO_CONNECT_TRANSACTION')
    const before = this.observed.has(file) ? this.observed.get(file)! : fingerprint(file)
    if (fingerprint(file) !== before) throw new Error('INSTALL_CHANGED')
    pending.step = { file, before, after: text === null ? null : hash(text), generated }
    this.save()
    try {
      if (fingerprint(file) !== before) throw new Error('INSTALL_CHANGED')
      if (text === null) { if (existsSync(file)) unlinkSync(file) }
      else atomic(file, text)
      if (fingerprint(file) !== pending.step.after) throw new Error('RECOVERY_CONFLICT')
    } catch (error) {
      this.recoverStep()
      throw error
    }
    this.recoverStep()
    this.observed.set(file, text === null ? null : hash(text))
  }

  recoverStep(): void {
    const step = this.state.pending?.step
    if (step === undefined) return
    const current = fingerprint(step.file)
    if (current !== step.before && current !== step.after) throw new Error('RECOVERY_CONFLICT')
    if (current === step.after) {
      if (step.after === null) delete this.state.owned[step.file]
      else if (step.generated) this.state.owned[step.file] = step.after
    }
    delete this.state.pending!.step
    this.save()
  }

  tidy(folder: string): boolean {
    if (!existsSync(folder)) return true
    try { rmdirSync(folder); return true } catch { return readdirSync(folder).length > 0 }
  }

  dropSection(agent: string, home: string, codexHome: string, opencodeHome: string, sep: string): void {
    const files: Record<string, string[]> = { codex: [[codexHome, 'AGENTS.md'].join(sep), [codexHome, 'AGENTS.override.md'].join(sep)], gemini: [[home, '.gemini', 'GEMINI.md'].join(sep)], opencode: [[opencodeHome, 'AGENTS.md'].join(sep)] }
    for (const file of files[agent] ?? []) {
      const before = this.read(file)
      const after = withoutSection(before)
      if (after !== before) this.change(file, after)
    }
  }
}

const checkedRequest = (value: unknown): LegacyConnectRequest => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CONNECT_REQUEST')
  const request = value as LegacyConnectRequest
  if (!['auto', 'connect', 'remove', 'status', 'ack', 'language'].includes(request.mode) || typeof request.home !== 'string' || !isAbsolute(request.home) || typeof request.progress !== 'string' || !isAbsolute(request.progress) || langOf(request.lang) !== request.lang || request.node !== null && typeof request.node !== 'string' || request.boardLang !== undefined && langOf(request.boardLang) !== request.boardLang || request.openclawVersion !== undefined && typeof request.openclawVersion !== 'string' || request.dirs !== undefined && (request.dirs === null || typeof request.dirs !== 'object' || Array.isArray(request.dirs) || Object.values(request.dirs).some(path => typeof path !== 'string' || !isAbsolute(path)))) throw new Error('INVALID_CONNECT_REQUEST')
  if (request.mode === 'ack' && (request.acknowledgement === undefined || !Number.isSafeInteger(request.acknowledgement.revision) || !Array.isArray(request.acknowledgement.keys) || request.acknowledgement.keys.some(key => typeof key !== 'string'))) throw new Error('INVALID_CONNECT_REQUEST')
  if (request.codexExecutable !== undefined && (typeof request.codexExecutable !== 'string' || !isAbsolute(request.codexExecutable))) throw new Error('INVALID_CONNECT_REQUEST')
  return { mode: request.mode, home: resolve(request.home), progress: resolve(request.progress), lang: request.lang, node: request.node, ...(request.codexExecutable === undefined ? {} : { codexExecutable: request.codexExecutable }), ...(request.openclawVersion === undefined ? {} : { openclawVersion: request.openclawVersion }), ...(request.boardLang === undefined ? {} : { boardLang: request.boardLang }), ...(request.dirs === undefined ? {} : { dirs: request.dirs }), ...(request.seed === undefined ? {} : { seed: request.seed }), ...(request.acknowledgement === undefined ? {} : { acknowledgement: request.acknowledgement }) }
}

const codexBinary = (): string | undefined => findCodexExecutable(process.env.PATH ?? '', process.platform, process.arch)
const mtimeOf = (file: string): number | undefined => { try { return statSync(file).mtimeMs } catch { return undefined } }

// The connect worker has a 10 s process.run limit in register.tsx. On Windows,
// other connect work takes 0.4–1.1 s and app-server startup takes 0.25 s to over 1 s.
const CODEX_CHECK_BUDGET_MS = 5000
const CODEX_CHECK_REQUEST_MS = 2000
// A cold app-server start can take over 2 s; the first answer may use more of the budget.
const CODEX_CHECK_INITIALIZE_MS = 3500

const codexObservation = async (request: LegacyConnectRequest, executable: string | undefined): Promise<CodexCheck | undefined> => {
  if (executable === undefined) return undefined
  const deadline = performance.now() + CODEX_CHECK_BUDGET_MS
  const home = request.home, folder = dirname(request.progress), codexHome = request.dirs?.codex ?? join(home, '.codex')
  const hook = agentHooks({ home, sep: process.platform === 'win32' ? '\\' : '/', isWindows: process.platform === 'win32', script: join(folder, process.platform === 'win32' ? 'progress-report.ps1' : 'progress-report.sh'), inbox: join(folder, 'progress-inbox'), codexHome, grokHome: '', hermesHome: '', openclawHome: '' }).find(one => one.agent === 'codex' && one.label !== '')!
  try {
    const config = JSON.parse(hook.edit('{}', false) as string) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
    const expected = Object.entries(config.hooks).map(([event, groups]) => ({ event: event[0]!.toLowerCase() + event.slice(1), command: groups[0]!.hooks[0]!.command }))
    const before = readFileSync(hook.file)
    // An answer counts only for the config.toml Codex read; codexApproval compares it again at the decision.
    const configHash = codexConfigHash(codexHome)
    if (configHash === undefined) return undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return { ...await inspectCodexHooks(executable, hook.file, expected, CODEX_CHECK_REQUEST_MS, deadline, CODEX_CHECK_INITIALIZE_MS), configHash } } catch (error) {
        // Codex answered, but our hooks are turned off in /hooks or are not the ones it lists:
        // that is a no, not a failed look, so a remembered approval must not outlive it.
        // A hash format Codex has changed is not a no (HOOK_FORMAT_UNSUPPORTED).
        if (error instanceof Error && ['HOOK_DISABLED', 'OWNED_HOOKS_NOT_FOUND'].includes(error.message)) {
          return before.equals(readFileSync(hook.file)) ? { source: resolve(hook.file), sourceHash: createHash('sha256').update(before).digest('hex'), trusted: false, hooks: [], configHash } : undefined
        }
        if (!(error instanceof Error) || !['CODEX_CONTROL_TIMEOUT', 'CODEX_CONTROL_UNAVAILABLE'].includes(error.message) || deadline - performance.now() < 1000) return undefined
      }
    }
  } catch { return undefined }
  return undefined
}

export const connectContext = (request: LegacyConnectRequest): ConnectContext => {
  const isWindows = process.platform === 'win32'
  const folder = dirname(request.progress)
  return {
    home: request.home,
    sep: isWindows ? '\\' : '/',
    isWindows,
    script: join(folder, isWindows ? 'progress-report.ps1' : 'progress-report.sh'),
    inbox: join(folder, 'progress-inbox'),
    board: join(folder, 'agent-board.mjs'),
    codexHome: request.dirs?.codex ?? join(request.home, '.codex'),
    grokHome: request.dirs?.grok ?? join(request.home, '.grok'),
    hermesHome: request.dirs?.hermes ?? join(request.home, '.hermes'),
    openclawHome: request.dirs?.openclaw ?? join(request.home, '.openclaw'),
    opencodeHome: request.dirs?.opencode ?? join(request.home, '.config', 'opencode'),
  }
}

export const unreadableProblem = (label: string): SetupState['problems'][number] => ({
  key: `checkUnreadable:${label}`, message: 'connectCheckUnreadable', args: [label],
})

// Read command data without evaluating any of the host's JavaScript or shell.
const boardCommandPaths = (text: string): string[] => {
  const strings = [text]
  const collect = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect)
  }
  try { collect(JSON.parse(text)) } catch {}
  // Gemini stores its command inside a JSON-quoted TOML prompt.
  for (const match of text.matchAll(/^prompt\s*=\s*(".*")\s*$/gm)) {
    try { collect(JSON.parse(match[1]!)) } catch {}
  }
  const paths = new Set<string>()
  for (const value of strings) {
    for (const match of value.matchAll(/(?:\bnode(?:\.exe)?|["'][^"'\r\n]*[\\/]node(?:\.exe)?["'])\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)')/g)) {
      const path = match[1] ?? match[2]!
      // A relative, ~ or variable path depends on where the session started, and
      // Agent Board never writes one, so only literal absolute paths are checked.
      if (/[\\/]agent-board\.mjs$/.test(path) && isAbsolute(path) && !/[$%]|^~/.test(path)) paths.add(path)
    }
    for (const match of value.matchAll(/const p=String\.fromCodePoint\(([\d,]+)\);process\.argv\.splice\(1,0,p\)/g)) {
      try {
        const path = match[1]!.split(',').map(point => String.fromCodePoint(Number(point))).join('')
        if (/[\\/]agent-board\.mjs$/.test(path) && isAbsolute(path)) paths.add(path)
      } catch {}
    }
  }
  return [...paths]
}

const missingBoardHosts = (transaction: ConnectTransaction, context: ConnectContext): string[] => {
  const hooks = agentHooks(context)
  const installed = [...new Set(hooks.filter(hook => BOARD_FOR.skills!.includes(hook.agent)
    && (hook.dirs ?? [hook.dir]).some(dir => transaction.exists(dir))).map(hook => hook.agent))]
  // Codex reads one instructions file (legacy-connect.ts picks it the same way), and a
  // reconnect refreshes only the generated command lines in its managed block there,
  // so nothing else in either file can raise a warning that reconnecting never clears.
  const [main, override] = ['AGENTS.md', 'AGENTS.override.md'].map(name => join(context.codexHome, name))
  const effective = transaction.exists(override!) && transaction.maybe(override!)?.trim() !== '' ? override! : main!
  const texts = [
    ...hooks.flatMap(hook => [hook.file, ...(hook.old === undefined ? [] : [hook.old])]
      .map(file => ({ text: transaction.maybe(file) ?? '', agents: hook.agent === 'skills' ? installed : [hook.agent] }))),
    { text: managedCommandLines(transaction.maybe(effective) ?? '').join('\n'), agents: ['codex'] },
  ]
  const missing = new Set<string>()
  for (const { text, agents } of texts) {
    if (boardCommandPaths(text).some(path => !transaction.exists(path))) agents.forEach(agent => missing.add(agent))
  }
  return [...missing].filter(agent => agent in STRINGS.en.agentNames)
}

export const foreignHostCheck = (transaction: ConnectTransaction, context: ConnectContext, folder: string, s: Strings = STRINGS.en) => {
  const hooks = agentHooks(context)
  const labels = new Map(hooks.filter(hook => hook.label !== '').map(hook => [hook.agent, hook.label]))
  labels.set('antigravity', 'Antigravity')
  const skillLabels = [...new Set(hooks
    .filter(hook => BOARD_FOR.skills!.includes(hook.agent) && hook.label !== ''
      && (hook.dirs ?? [hook.dir]).some(dir => existsSync(dir)))
    .map(hook => hook.label))]
  const checks = hooks.filter(hook => (hook.dirs ?? [hook.dir]).some(dir => existsSync(dir))).flatMap(hook => {
    const names = hook.agent === 'skills'
      ? skillLabels.length > 0 ? skillLabels : ['Codex']
      : [labels.get(hook.agent) ?? s.setupAgentUnknown]
    return [hook.file, ...(hook.old === undefined ? [] : [hook.old])]
      .flatMap(file => names.map(label => ({ file, label })))
  })
  if (existsSync(context.codexHome)) {
    checks.push(...['AGENTS.md', 'AGENTS.override.md'].map(name => ({
      file: join(context.codexHome, name), label: labels.get('codex') ?? 'Codex',
    })))
  }
  const unreadable = new Set<string>()
  const other = checks.flatMap(({ file, label }) => {
    const text = transaction.maybe(file)
    if (text === null) unreadable.add(label)
    return connectDataRoots(text ?? '')
      .filter(root => connectPath(root, context.isWindows) !== connectPath(folder, context.isWindows))
      .map(root => ({ root, label }))
  })
  const mayExist = (file: string): boolean => {
    try { statSync(file); return true } catch (error) {
      return !['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EINVAL'].includes((error as { code?: string }).code ?? '')
    }
  }
  const live = other.filter(one => mayExist(join(one.root, 'progress-report.ps1')) || mayExist(join(one.root, 'progress-report.sh')))
  const state = transaction.state
  const hasForeignRecovery = state.pending !== undefined
    && connectPath(dirname(state.pending.request.progress), context.isWindows) !== connectPath(folder, context.isWindows)
  const hasLiveRecovery = hasForeignRecovery && mayExist(dirname(state.pending!.request.progress))
  const problems: SetupState['problems'] = [
    ...[...new Set(live.map(one => one.label))].map(label => ({
      key: `otherData:${label}`, message: 'connectOtherData' as const, args: [label] as [string],
    })),
    ...(hasLiveRecovery ? [{ key: 'otherData:recovery', message: 'connectOtherRecovery' as const, args: [] as [] }] : []),
    ...[...unreadable].map(unreadableProblem),
  ]
  return { live, unreadable, problems, hasForeignRecovery, hasLiveRecovery }
}

export const legacyConnect = async (value: unknown, bundle: string): Promise<{ state: ConnectState; result: ReturnType<typeof connectLegacy> | null }> => {
  const request = checkedRequest(value)
  if (request.node === null || nodeVersionOf(request.node) === null || !isNodeSupported(request.node) || !isNodeSupported(`v${process.versions.node}`)) throw new Error('NODE_REQUIRED')
  const executable = ['connect', 'auto', 'status'].includes(request.mode) ? request.codexExecutable ?? codexBinary() : undefined
  // Read before Codex is asked, so an approval names the executable that answered.
  const binary = codexBinaryOf(executable)
  const observation = await codexObservation(request, executable)
  return withInstallLock(request.home, () => {
    // A 0.23 approval cannot have seen an untrust in /hooks (it writes config.toml) or a
    // Codex upgrade made after legacy-connect.json was last written. An ack or language
    // save also writes it without a check, so a change before one of those is missed.
    // With no saved state the SDK seed carries no codexTrusted, so nothing is seeded anyway.
    const savedAt = mtimeOf(join(installControlRoot(request.home), 'legacy-connect.json'))
    const changedAt = [mtimeOf(join(request.dirs?.codex ?? join(request.home, '.codex'), 'config.toml')), binary?.mtime]
    const found: CodexFound = { binary, isSeedStale: changedAt.some(time => time !== undefined && (savedAt === undefined || time > savedAt)) }
    const transaction = new ConnectTransaction(request.home, request.seed)
    const state = transaction.state
    // Check the host's current path before creating authority, staging writes, or
    // replaying a journal from another data folder. A skipped auto is read-only.
    const folder = dirname(request.progress)
    const context = connectContext(request)
    const { isWindows } = context
    const { problems, hasForeignRecovery, hasLiveRecovery } = foreignHostCheck(transaction, context, folder, STRINGS[request.lang])
    const checkedSetup = (stored: SetupState | undefined): SetupState => {
      const missing = request.mode === 'status' ? missingBoardHosts(transaction, context) : []
      const s = STRINGS[request.lang]
      const source = join(context.codexHome, 'hooks.json')
      // A missing hooks.json has no hash, so the 0.23 upgrade path cannot remember an empty one.
      const text = transaction.exists(source) ? transaction.maybe(source) : null
      const sourceHash = text === null ? null : hash(text)
      const trusted = request.mode === 'ack' ? stored?.codexTrusted === true
        : codexApproval(observation, resolve(source), sourceHash, codexConfigHash(context.codexHome), state.codexApproval, stored?.codexTrusted === true && !found.isSeedStale, sourceHash, found.binary).trusted
      const setup: SetupState = {
        ...(stored ?? { agents: [], node: request.node }),
        codexTrusted: trusted,
        problems: [
          ...(stored?.problems ?? []).filter(one => one.key !== 'codex:approval' && !one.key.startsWith('missingBoard:')
            && !/^(?:otherData|checkUnreadable):/.test(one.key)
            && !problems.some(problem => problem.key === one.key)),
          ...problems,
        ],
      }
      for (const agent of missing) setup.problems.push({ key: `missingBoard:${agent}`, text: s.setupMissingBoardScript(s.agentNames[agent] ?? agent) })
      setup.agents = setup.agents.map(one => missing.includes(one.agent) ? { ...one, board: 'failed' } : one)
      if (setup.agents.some(one => one.agent === 'codex') && !trusted) {
        setup.problems.push({ key: 'codex:approval', message: 'setupCodexApproval', args: [] })
      }
      return setup
    }
    // A blocked automatic run does not save; acknowledgement reuses the last saved Codex result.
    const setup = checkedSetup(state.setup)
    const hasBlockedAuto = problems.length > 0
    if (['auto', 'status'].includes(request.mode) && hasBlockedAuto) {
      const lines = setup.problems.map(problem => setupProblemText(problem, STRINGS[request.lang]))
      const result = request.mode === 'auto'
        ? { text: lines.join('\n'), lines, problems: setup.problems, done: [] }
        : null
      return { state: { ...state, setup }, result }
    }
    // A new remove supersedes an unfinished connect before recovery can write
    // anything. This durable bit also fences a later auto after this process dies.
    if (request.mode === 'remove') {
      state.disabled = true
      delete state.codexApproval
      transaction.save()
    } else if (!existsSync(transaction.file)) transaction.save()
    const authority = join(installControlRoot(request.home), 'legacy-connect-authority')
    if (!existsSync(authority)) writeFileSync(authority, '1\n', { flag: 'wx', mode: 0o600 })
    if (request.mode === 'status') {
      const hasSetup = state.setup !== undefined || setup.problems.length > 0
      return { state: { ...state, ...(hasSetup ? { setup } : {}) }, result: null }
    }
    if (request.mode === 'ack') {
      if (request.acknowledgement?.revision === state.revision) {
        if (state.setup !== undefined || setup.problems.length > 0) state.setup = setup
        const current = new Set(state.setup?.problems.map(problem => problem.key) ?? [])
        state.notified = request.acknowledgement.keys.filter(key => current.has(key))
        transaction.save()
      }
      return { state, result: null }
    }
    if (request.mode === 'language') {
      if (request.boardLang === undefined) throw new Error('INVALID_CONNECT_REQUEST')
      state.boardLang = request.boardLang
      state.revision += 1
      transaction.save()
      return { state, result: null }
    }
    const run = (one: LegacyConnectRequest): ReturnType<typeof connectLegacy> => {
      // Previous local scripts remain in place for in-flight hooks, but a new
      // scope must not claim them as its own or later remove them.
      const hosts = new Set(agentHooks(context).map(hook => connectPath(hook.file, isWindows)))
      for (const file of Object.keys(state.owned)) {
        const isOtherFolder = connectPath(dirname(file), isWindows) !== connectPath(dirname(one.progress), isWindows)
        const isReporter = /^(?:agent-board\.mjs|progress-report\.(?:sh|ps1))$/.test(file.split(/[\\/]/).at(-1) ?? '')
        if (!hosts.has(connectPath(file, isWindows)) && isOtherFolder && isReporter) delete state.owned[file]
      }
      state.disabled = one.mode === 'remove' ? true : one.mode === 'connect' ? false : state.disabled
      if (one.boardLang !== undefined) state.boardLang = one.boardLang
      const { seed: _seed, ...metadata } = one
      state.pending = { request: metadata, bundle: hash(bundle) }
      transaction.save()
      const result = connectLegacy(transaction, one, bundle, process.platform === 'win32', observation, found)
      state.revision += 1
      delete state.pending
      transaction.save()
      return result
    }
    if (state.pending !== undefined) {
      const step = state.pending.step
      let hasConflict = false
      if (hasForeignRecovery && state.disabled && hasLiveRecovery && state.pending.bundle === hash(bundle) && step !== undefined) {
        try {
          const current = fingerprint(step.file)
          hasConflict = current !== step.before && current !== step.after
        } catch (error) {
          const code = (error as { code?: string }).code ?? ''
          // A busy or locked file may be read later: keep the journal and name the error.
          if (/^E[A-Z]{2,15}$/.test(code) && !['EISDIR', 'ENOTDIR'].includes(code)) throw new Error(`RECOVERY_UNREADABLE_${code}`)
          if (!['EISDIR', 'ENOTDIR'].includes(code)) throw error
          // A path that changed its file kind cannot be replayed into this connection.
          hasConflict = true
        }
      }
      if (hasForeignRecovery && (!state.disabled || !hasLiveRecovery || state.pending.bundle !== hash(bundle) || hasConflict)) {
        // Superseding a different folder never replays or validates its discarded
        // file step: that file may have changed or disappeared with the folder.
        delete state.pending
        transaction.save()
      }
    }
    if (state.pending !== undefined) {
      if (state.pending.bundle !== hash(bundle)) throw new Error('RECOVERY_BUNDLE_CHANGED')
      const previous = state.pending.request
      transaction.recoverStep()
      // Read back any applied step into ownership, then clean the original scope
      // instead of replaying a connect that the person has since disabled.
      const recovery: LegacyConnectRequest = state.disabled ? { ...previous, mode: 'remove', lang: request.lang } : previous
      const result = run(recovery)
      const scope = (one: LegacyConnectRequest): string => JSON.stringify([one.home, one.progress, ...(['codex', 'grok', 'hermes', 'openclaw', 'opencode'] as const).map(agent => one.dirs?.[agent] ?? null)])
      if (request.mode === 'remove' && recovery.mode === 'remove' && scope(request) === scope(recovery)) return { state, result }
    }
    if (request.mode === 'auto' && state.disabled) return { state, result: null }
    return { state, result: run(request) }
  }, true)
}

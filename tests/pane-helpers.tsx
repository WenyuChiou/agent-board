import type { On, PromptOrigin, RenderPropsOf } from 'claude-code'
import { expect, mock, test as pluginTest } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ProgressMirror, ProgressMirrorTask } from '../types'
import { agentHooks, boardScript, isNodeSupported, isSetupState, NODE_MIN, openclawPlugin, RELEASE_PATHS } from '../hooks/connect'
import { STRINGS } from '../hooks/strings'

import { ZH_TW } from '../hooks/i18n'
import { EN } from '../hooks/strings-en'
import { paletteFor } from '../hooks/palette'
import { ZH_CN } from '../hooks/strings-zh-cn'
import { pressTarget } from '../hooks/pane'
import { dashboardHtml } from '../hooks/dashboard'
import { buildView, IDLE_MS, OLDER_SHOWN, parseSeen, relativeTime, seenJson, seenPath, SWEEP_ARMED_KEY, withSeen } from '../hooks/view'
import type { TaskRow, View } from '../hooks/view'
import { doneKey, parseProgress } from '../hooks/parse'
import { chatText, peekInbox } from '../hooks/board'
import { answerAgentPrompt, blockId, CLAIM_MS, isInboxFile, takenName, withAgentPrompts } from '../hooks/inbox'
import { applyTaskCreate, applyTaskUpdate, completionKey, completionOverlay, emptyMirror } from '../hooks/mirror'
import { applyDigest, startBackgroundJob } from '../hooks/digest'
import { upsertAutoBlock } from '../hooks/blocks'

import { emptyQuestions, migrationKey, observeQuestions, questionProofPath, questionsJson } from '../hooks/questions'
import { sha256 } from '../hooks/sha256'
import { RELEASE_0_18_1, RELEASE_0_20_5 } from './fixtures/released'
import { memoryConnect } from './fixtures/connect-memory'
import { CONNECT_BOOTSTRAP, CONNECT_EXECUTE } from '../hooks/connect-worker'
import { LEDGER_LINK, LINK_EXISTS, LINK_KEPT_SOURCE, LINK_UNSUPPORTED } from '../hooks/ledger-move'
import { hasOwnConnectData, connectDataRoots } from '../hooks/connect-pure'
import type { ConnectState, LegacyConnectRequest } from '../scripts/connect-transaction'

type TestBody = ($: Engine, on: On) => void | Promise<void>
type TestConfig = Exclude<Parameters<typeof pluginTest>[1], TestBody>
const automaticSetup = new WeakSet<On>()

// Most pane tests need only the in-memory board. Setup tests opt in so every
// unrelated session does not stage and hash the whole native worker twice.
const test = (name: string, configOrBody: TestConfig | TestBody, body?: TestBody): void => {
  const config = typeof configOrBody === 'function' ? {} : configOrBody
  const run = typeof configOrBody === 'function' ? configOrBody : body!
  const options = { autoConnect: false, ...config.options }
  pluginTest(name, { ...config, options }, async ($, on) => {
    if (options.autoConnect) automaticSetup.add(on)
    await run($, on)
  })
}

const FILE = '/home/me/.claude/progress.md'
const QUESTIONS = '/home/me/.claude/progress-questions.json'
const INBOX = '/home/me/.claude/progress-inbox'
const LIVE_SCRIPT = '/home/me/.claude/agent-board.mjs'
const installedBoard = (path = FILE): string => boardScript(path, 'en')
const SESSION = '2be48af2-6193-5040-aacc-e0546d6784f1'
const PANE = { plugin: 'agent-board', component: 'Pane', requestId: 'agent-board' } as const
const CONNECT = { home: '/home/me', sep: '/', isWindows: false, script: '/home/me/.claude/progress-report.sh', inbox: '/home/me/.claude/progress-inbox', codexHome: '/home/me/.codex', grokHome: '/home/me/.grok', hermesHome: '/home/me/.hermes', openclawHome: '/home/me/.openclaw', board: '/home/me/.claude/agent-board.mjs' }
const grokHook = (): string => String(agentHooks(CONNECT).find(hook => hook.agent === 'grok')?.edit('', false))

const PROPS: RenderPropsOf['Pane'] = {
  title: '進度',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type World = {
  files: Map<string, string>
  dirs?: Set<string>
  unlistable?: Set<string>
  mtime: number
  hasTasks: boolean
  hasNoSurface?: boolean
  hasBrokenSurfaces?: boolean
  surfaceCalls?: number
  paneReason?: string
  paneOpenCalls?: number
  registered?: string[]
  registeredDescriptions?: string[]
  liveOutput?: string
  liveFailure?: 'exit' | 'timeout' | 'truncated'
  liveCalls?: Array<{ argv: string[]; init: unknown }>
  liveHold?: { reached: () => void; release: Promise<void> }
  isArchiveClockOnly?: boolean
  at?: number
  clockOffset?: number
  env?: Record<string, string>
  stats?: string[]
  reads?: string[]
  written?: string[]
  beforeRead?: (path: string) => void
  afterRead?: (path: string) => void
  mtimes?: Record<string, number>
  // Paths that exist but refuse to be read (too big, locked).
  unreadable?: Set<string>
  // When set, the next write to progress.md waits here; `reached` resolves once it does.
  hold?: { reached: () => void; release: Promise<void> }
  // What the store holds at the start.
  store?: Record<string, unknown>
  storeReads?: string[]
  // In place of `store`: the store every session on the machine shares, which the test
  // changes mid-way as another session would.
  shared?: Record<string, unknown>
  // Every command the mod ran, when set.
  ran?: string[][]
  // What the model answers when asked to name the task.
  named?: string
  // What the model answers to a prompt, when the answer depends on what was asked.
  reply?: (prompt: string) => string | undefined
  // The transcript $.session.messages() returns.
  messages?: Array<{ role: 'user' | 'assistant'; text: string; toolUses: Array<{ tool_use_id: string; tool: string; input: Record<string, unknown> }> }>
  messageReads?: number
  holdBackground?: { reached: () => void; release: Promise<void> }
  // Answers `gh`; other commands (git) answer the branch.
  gh?: () => { exitCode: number; stdout: string; stderr: string }
  // A move of this file fails, as when another session renamed it first.
  isMoveRefused?: (path: string) => boolean
  // A delete of this file fails, as with a file another program holds open.
  isRemoveRefused?: (path: string) => boolean
  // What the model answers asynchronously; a promise that never settles is a hung call.
  hang?: (prompt: string) => boolean
  holdComplete?: { reached: () => void; release: Promise<void> }
  // Every prompt the model was given.
  asked?: string[]
  // What the conversation was handed by $.session.append.
  appended?: unknown[]
  // Another session's stale write to progress.md, landing right after the next one.
  afterWrite?: () => string
  // A synthetic read-back failure after a journal write has already saved its bytes.
  afterJournalWrite?: () => void
  holdJournalRead?: { reached: () => void; release: Promise<void> }
  // What `openclaw --version` prints.
  openclaw?: string
  // What `node --version` prints; null when there is no node to run. Unset, a supported one.
  node?: string | null
  browserExitCode?: number
  hasNoHardLinks?: boolean
  nodeGate?: { reached: () => void; release: Promise<void> }
  workerGate?: { reached: () => void; release: Promise<void> }
  workerFailure?: string
  bootstrapFailure?: boolean
  setupDone?: Promise<void>
  finishSetup?: () => void
  // Paths a write to fails (a read-only file, a folder that is not there).
  unwritable?: Set<string>
  writeDeny?: string
  ignoreQuestionWrites?: boolean
  failQuestionCapture?: 'read' | 'write'
  failStore?: (operation: 'get' | 'set' | 'delete', key: string) => boolean
  holdStore?: { key: string; reached: () => void; release: Promise<void> }
  beforeStoreSet?: (key: string) => void
  ignoreStore?: (key: string) => boolean
  afterMove?: (from: string, to: string) => boolean
  // A removal that fails, or reports success while the file still exists.
  unremovable?: Set<string>
  retainedOnRemove?: Set<string>
  rejectedOnRemove?: Set<string>
}

// On Windows the engine resolves /home/me/... to X:\home\me\... before fs.* reaches these
// handlers; map it back so the in-memory files are found on every host.
const posix = (path: string): string => path.replace(/^[A-Za-z]:\\/, '/').replace(/\\/g, '/')
const settledSetup = async ($: Engine, world: World): Promise<void> => { await world.setupDone; await $.command.run({ ...TIDY, args: 'connect status' }) }

const beneathButton = (node: unknown, key: string, text: string): boolean => {
  if (typeof node !== 'object' || node === null) return false
  const element = node as { props?: { key?: string }; children?: Array<{ props?: { key?: string }; children?: unknown[] }> }
  const children = element.children ?? []
  const index = children.findIndex(child => child?.props?.key === `${key}::resolve`)
  return (element.props?.key === `${key}::question` && index >= 0 && children[index + 1]?.children?.includes(text) === true) || children.some(child => beneathButton(child, key, text))
}
const controlFile = '/home/me/.agent-board/legacy-connect.json'
const nativeState = (world: World): ConnectState => JSON.parse(world.files.get(controlFile) ?? '{"version":1,"revision":0,"disabled":false,"owned":{},"notified":[]}') as ConnectState
let workerStageSequence = 0

// Everything a session's engine answers beneath the plugin, with files kept in memory.
const engineBeneath = (on: On, world: World): MockClock => {
  const files = world.files
  Object.defineProperty(files, 'set', { configurable: true, writable: true, value: (path: string, text: string) => {
    // Reinstalling this fixture must not wrap an earlier instance override.
    Map.prototype.set.call(files, path, text)
    if (path !== FILE) (world.mtimes ??= {})[path] = Math.max(world.mtimes?.[path] ?? world.mtime, world.mtime) + 1
    return files
  } })
  world.setupDone = automaticSetup.has(on) ? new Promise<void>(done => { world.finishSetup = done }) : Promise.resolve()
  // Exercise the hourly archive without thousands of unrelated polls consuming
  // the mock hook's budget. Other tests retain every timer; the archive keeps its
  // native callback and exact interval.
  const clockOn = world.isArchiveClockOnly || world.clockOffset !== undefined ? ((...args: Parameters<On>) => {
    const callback = args.at(-1)
    if (typeof callback !== 'function') throw new Error('Invalid clock fixture')
    // Move the claim clock without replaying hundreds of unrelated polling callbacks.
    if (args[0] === 'clock.now' && world.clockOffset !== undefined) return on('clock.now', async ($, event, next) => {
      const result = await Reflect.apply(callback, undefined, [$, event, next])
      return { ...result, value: result.value + world.clockOffset! }
    })
    if (args[0] !== 'clock.every' || !world.isArchiveClockOnly) return Reflect.apply(on, undefined, args)
    return on('clock.every', ($, event, next) => Reflect.apply(callback, undefined, [$, { ...event, ms: event.ms === 3600000 ? event.ms : 7200000 }, next]))
  }) as On : on
  const clock = mock.clock(clockOn, { now: world.at ?? Date.parse('2026-10-16T12:00:00.000Z') })
  // The system says Traditional Chinese, so the pane speaks it unless a test says otherwise.
  mock.env(on, world.env ?? { HOME: '/home/me', LANG: 'zh_TW.UTF-8' })
  // A store that has looked at the inbox before, unless a test says otherwise.
  const shared = world.shared
  if (shared === undefined) {
    const store: Record<string, unknown> = world.store ?? { inboxDone: {} }
    on('store.get', ($, e) => {
      world.storeReads?.push(e.key)
      return world.failStore?.('get', e.key) ? { deny: 'EIO' } : { value: store[e.key] }
    })
    on('store.set', async ($, e) => {
      const hold = world.holdStore
      if (hold?.key === e.key) {
        world.holdStore = undefined
        hold.reached()
        await hold.release
      }
      world.beforeStoreSet?.(e.key)
      if (world.failStore?.('set', e.key)) return { deny: 'EIO' }
      if (world.ignoreStore?.(e.key)) return { value: undefined }
      store[e.key] = e.value
      return { value: undefined }
    })
    on('store.delete', ($, e) => {
      if (world.failStore?.('delete', e.key)) return { deny: 'EIO' }
      delete store[e.key]
      return { value: undefined }
    })
    on('store.keys', () => ({ value: Object.keys(store) }))
  } else {
    on('store.get', ($, e) => ({ value: structuredClone(shared[e.key]) }))
    on('store.set', ($, e) => {
      shared[e.key] = structuredClone(e.value)
      return { value: undefined }
    })
    on('store.delete', ($, e) => {
      delete shared[e.key]
      return { value: undefined }
    })
    on('store.keys', () => ({ value: Object.keys(shared) }))
  }
  on('session.start', ($, e) => {
    world.setupDone = automaticSetup.has(on) ? new Promise<void>(done => { world.finishSetup = done }) : Promise.resolve()
    return { cwd: e.cwd }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: SESSION }))
  on('session.surfaces', () => {
    world.surfaceCalls = (world.surfaceCalls ?? 0) + 1
    if (world.hasBrokenSurfaces) throw new TypeError('session.surfaces is not a function')
    return { value: world.hasNoSurface ? [] : ['terminal' as const] }
  })
  on('session.root', () => ({ value: '/work/persona_framework' }))
  on('session.repo', () => ({
    value: {
      root: '/work/persona_framework',
      remote: 'https://github.com/jhk482001/persona_framework.git',
      internal: false,
      name: null,
    },
  }))
  on('command.register', ($, e) => {
    world.registered?.push(e.name)
    world.registeredDescriptions?.push(e.description ?? '')
    return { value: { command: e.name } }
  })
  on('ui.open', () => {
    world.paneOpenCalls = (world.paneOpenCalls ?? 0) + 1
    return { value: world.paneReason === undefined ? { isPlaced: true as const } : { isPlaced: false as const, reason: world.paneReason } }
  })
  on('tool.list', () => ({
    value: world.hasTasks ? [{ name: 'TaskCreate', description: '', mcp: false }] : [{ name: 'Read', description: '', mcp: false }],
  }))
  on('process.run', async ($, e) => {
    if (world.browserExitCode !== undefined && e.argv.some(arg => /\.html$/.test(arg))) {
      world.ran?.push([...e.argv])
      return { value: { exitCode: world.browserExitCode, stdout: '', stderr: 'synthetic browser refusal', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'node' && e.argv.includes('--serve')) {
      world.ran?.push([...e.argv])
      // The whole options object, so a test proves no environment or other setting is passed.
      world.liveCalls?.push({ argv: [...e.argv], init: (e as typeof e & { init?: unknown }).init })
      if (world.liveHold !== undefined) {
        const hold = world.liveHold
        world.liveHold = undefined
        hold.reached()
        await hold.release
      }
      if (world.node === null) return { deny: 'ENOENT' }
      if (world.liveFailure === 'timeout') return { deny: 'ETIMEDOUT' }
      return { value: { exitCode: world.liveFailure === 'exit' ? 1 : 0, stdout: world.liveOutput ?? '', stderr: 'SYNTHETIC_STARTUP_DETAIL', isStdoutTruncated: world.liveFailure === 'truncated', isStderrTruncated: false } }
    }
    if (e.argv[0] === 'node' && e.argv[2] === LEDGER_LINK && e.argv[3] === '--') {
      world.ran?.push([...e.argv])
      const from = posix(e.argv[4] ?? '')
      const to = posix(e.argv[5] ?? '')
      const text = world.files.get(from)
      let exitCode = 0
      if (world.node === null) exitCode = 127
      else if (world.hasNoHardLinks || text === undefined || world.isMoveRefused?.(from) === true || world.unwritable?.has(to) === true) exitCode = LINK_UNSUPPORTED
      else if (world.files.has(to)) exitCode = LINK_EXISTS
      else if (world.ignoreQuestionWrites && to.endsWith('-questions.json')) world.files.delete(from)
      // The link is made but the source stays, as when another program holds it open.
      else if (world.isRemoveRefused?.(from) === true) {
        world.files.set(to, text)
        exitCode = LINK_KEPT_SOURCE
      } else {
        world.files.delete(from)
        world.files.set(to, text)
        if (world.afterMove?.(from, to)) exitCode = 1
      }
      return { value: { exitCode, stdout: '', stderr: exitCode === 127 ? 'node: command not found' : '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'node' && e.argv[1] === '--version' && world.nodeGate !== undefined) {
      const gate = world.nodeGate
      world.nodeGate = undefined
      gate.reached()
      await gate.release
    }
    if (e.argv[0] === 'node' && e.argv[2] === CONNECT_BOOTSTRAP) {
      if (world.bootstrapFailure) return { value: { exitCode: 1, stdout: '', stderr: 'BOOTSTRAP_FAILED', isStdoutTruncated: false, isStderrTruncated: false } }
      const directory = `/tmp/agent-board-worker-fixture-${workerStageSequence += 1}`
      return { value: { exitCode: 0, stdout: JSON.stringify({ protocol: 1, directory, file: directory + '/' + e.argv[3] + '.mjs', token: 'a'.repeat(32) }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'node' && e.argv[3] === CONNECT_EXECUTE) {
      world.ran?.push([...e.argv])
      if (world.workerGate !== undefined) {
        const gate = world.workerGate
        world.workerGate = undefined
        gate.reached()
        await gate.release
      }
      try {
        if (world.workerFailure !== undefined) throw new Error(world.workerFailure)
        const stage = JSON.parse(e.argv[5] ?? '{}') as { file: string }
        const request = JSON.parse(e.argv[6] ?? '{}') as LegacyConnectRequest
        const reply = memoryConnect(world.files, world.dirs, request, world.files.get(posix(stage.file)) ?? '', world)
        world.files.delete(posix(stage.file))
        if (request.mode === 'ack' || request.mode === 'auto' && reply.result === null) world.finishSetup?.()
        return { value: { exitCode: 0, stdout: JSON.stringify(reply), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      } catch (error) {
        return { value: { exitCode: 1, stdout: '', stderr: String(error), isStdoutTruncated: false, isStderrTruncated: false } }
      }
    }
    if (e.argv[0] === 'rmdir') {
      world.ran?.push([...e.argv])
      const dir = posix(e.argv[1] ?? '')
      if (world.rejectedOnRemove?.has(dir)) return { deny: 'EACCES' }
      const hasEntries = [...world.files.keys()].some(path => path.startsWith(`${dir}/`))
      const exitCode = world.unremovable?.has(dir) || hasEntries ? 1 : 0
      if (exitCode === 0 && !world.retainedOnRemove?.has(dir)) world.dirs?.delete(dir)
      return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // mv and rm act on the files in memory: a move of a file that is gone fails, as it does.
    if (e.argv[0] === 'mv' || e.argv[0] === 'rm') {
      world.ran?.push([...e.argv])
      let exitCode = 0
      if (e.argv[0] === 'mv') {
        const rest = e.argv.slice(e.argv[1] === '-n' || e.argv[1] === '-f' ? 2 : 1)
        const from = posix(rest[0] ?? '')
        const to = posix(rest[1] ?? '')
        const text = world.files.get(from)
        // A move onto a file that refuses writes fails as the write itself would.
        if (text === undefined || world.isMoveRefused?.(from) === true || world.unwritable?.has(to) === true) exitCode = 1
        // GNU and BSD `mv -n` skip a move onto a file that is already there and still answer 0.
        else if (e.argv[1] === '-n' && world.files.has(to)) exitCode = 0
        else if (world.ignoreQuestionWrites && to.endsWith('-questions.json')) world.files.delete(from)
        else {
          world.files.delete(from)
          world.files.set(to, text)
          if (world.afterMove?.(from, to)) exitCode = 1
        }
      } else {
        for (const path of e.argv.slice(1)) {
          if (path === '-f') continue
          const target = posix(path)
          if (world.unremovable?.has(target)) exitCode = 1
          else if (!world.retainedOnRemove?.has(target) && world.isRemoveRefused?.(target) !== true) world.files.delete(target)
        }
      }
      return { value: { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'No such file or directory', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const ran =
      e.argv[0] === 'gh' && world.gh !== undefined
        ? world.gh()
        : e.argv.includes('openclaw') && world.openclaw !== undefined
          ? { exitCode: 0, stdout: world.openclaw, stderr: '' }
          : e.argv[0] === 'node'
            ? world.node === null
              ? { exitCode: 127, stdout: '', stderr: 'node: command not found' }
              : { exitCode: 0, stdout: world.node ?? 'v24.1.0\n', stderr: '' }
          : { exitCode: e.argv[0] === 'gh' ? 1 : 0, stdout: e.argv[0] === 'gh' ? '' : 'claude/progress-mod\n', stderr: '' }
    world.ran?.push([...e.argv])
    return { value: { ...ran, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.messages', () => {
    world.messageReads = (world.messageReads ?? 0) + 1
    return { value: world.messages ?? [] }
  })
  on('session.append', ($, e, next) => {
    world.appended?.push(e)
    return next(e)
  })
  on('model.complete', ($, e) => {
    const prompt = typeof e.prompt === 'string' ? e.prompt : ''
    world.asked?.push(prompt)
    if (world.holdComplete !== undefined) {
      const hold = world.holdComplete
      world.holdComplete = undefined
      hold.reached()
      return hold.release.then(() => answerOf(prompt))
    }
    return world.hang?.(prompt) === true ? new Promise<never>(() => undefined) : answerOf(prompt)
  })
  const answerOf = (prompt: string) => ({
    value: {
      isAnswered: true as const,
      text: world.reply?.(prompt) ?? world.named ?? '「重做進度面板」',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })
  on('fs.stat', ($, e) => {
    world.stats?.push(e.path)
    const path = posix(e.path)
    const text = world.files.get(path)
    const isDir = [...world.files.keys()].some(file => file.startsWith(`${path}/`))
    const mtimeMs = path === FILE ? world.mtime : world.mtimes?.[path] ?? world.mtime
    if (text === undefined && isDir) return { value: { kind: 'dir' as const, size: 0, mtimeMs, isLink: false } }
    return text === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file' as const, size: text.length, mtimeMs, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: world.dirs?.has(posix(e.path)) || world.files.has(posix(e.path)) || [...world.files.keys()].some(path => path.startsWith(`${posix(e.path)}/`)) }))
  on('fs.list', ($, e) => {
    if (world.unlistable?.has(posix(e.path ?? ''))) return { deny: 'EACCES' }
    const dir = `${posix(e.path ?? '').replace(/\/$/, '')}/`
    const names = [...world.files.keys()].filter(path => path.startsWith(dir) && !path.slice(dir.length).includes('/'))
    return {
      value: names.map(path => ({ name: path.slice(dir.length), kind: 'file' as const, size: (world.files.get(path) ?? '').length, mtimeMs: world.mtimes?.[path] ?? world.mtime, isLink: false })),
    }
  })
  on('fs.read', async ($, e) => {
    const path = posix(e.path)
    world.reads?.push(path)
    world.beforeRead?.(path)
    const hold = world.holdJournalRead
    if (path.includes('-journal-') && hold !== undefined) {
      world.holdJournalRead = undefined
      hold.reached()
      await hold.release
      return { deny: 'EIO' }
    }
    const text = world.files.get(path)
    world.afterRead?.(path)
    if (world.unreadable?.has(path) || (world.failQuestionCapture === 'read' && path.includes('-questions-source-'))) return { deny: 'EFBIG' }
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', async ($, e) => {
    const path = posix(e.path)
    world.written?.push(path)
    if (world.unwritable?.has(path) || (world.failQuestionCapture === 'write' && path.includes('-questions-source-'))) return { deny: world.writeDeny ?? 'EACCES' }
    if (world.ignoreQuestionWrites && path.endsWith('-questions.json')) return { value: undefined }
    const hold = world.hold
    if (hold !== undefined && path === FILE) {
      world.hold = undefined
      hold.reached()
      await hold.release
    }
    world.files.set(path, e.text)
    if (path === FILE) world.mtime += 1
    if (path.includes('-journal-')) world.afterJournalWrite?.()
    // Another session's write, made from what it read before this one, lands right after.
    const stale = world.afterWrite
    if (stale !== undefined && path === FILE) {
      world.afterWrite = undefined
      world.files.set(path, stale())
      world.mtime += 1
    }
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'SyntheticBackground' }, async () => {
    const held = world.holdBackground
    world.holdBackground = undefined
    if (held !== undefined) {
      held.reached()
      await held.release
    }
    return { result: {} }
  })
  let nextId = 0
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => {
    nextId += 1
    return { result: { task: { id: String(nextId), subject: e.subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({
    result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
  }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({
    result: { success: true },
  }))

  return clock
}

const start = async ($: Engine, text: string): Promise<void> => {
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text, turnId: 't1' })
}

const PROBE_NAME = 'codex-turn-1792216380-10.json'
const PROBE_BODY = JSON.stringify({ session_id: 'pr53-fixture', cwd: '/work/synthetic', prompt: 'Preserve the report', last_assistant_message: 'Implemented a fixture.' })
const PROBE_REPLY = 'TITLE: fixture\nCONTEXT: synthetic\nDONE: Saved first result\nNEXT: Verify recovery\nASK: -'
const probeWorld = (): World => ({ files: new Map([[FILE, '# Progress\n'], [`${INBOX}/${PROBE_NAME}`, PROBE_BODY]]), mtime: 1, hasTasks: true, asked: [], store: { inboxDone: {}, autoConnectOff: true }, reply: () => PROBE_REPLY })
const probeStart = async ($: Engine): Promise<void> => { await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true }) }
const confirmStep = (subject: string, id = '1'): ProgressMirrorTask => ({ id, subject, status: 'pending', activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] })

const PROMPT_AT = Date.parse('2026-10-16T11:59:00Z')
const PROMPT_SESSION = 'prompt-owner'
const PROMPT_ID = blockId('codex', PROMPT_SESSION)
const questionWorld = () => {
  const mirror = { ...applyDigest(emptyMirror(PROMPT_ID, 'demo', PROMPT_AT, '/demo', 'codex'), { title: 'Migration', context: '', done: '', next: 'Continue migration', ask: 'Database', why: 'Use staging?' }, PROMPT_AT), resume: PROMPT_SESSION, firstPrompt: 'Original request', turnOrder: PROMPT_AT * 2 }
  const world: World = { files: new Map([[FILE, upsertAutoBlock('# Progress\n', mirror, ZH_TW)]]), mtime: 1, hasTasks: true, asked: [], reads: [], store: { inboxDone: {}, autoConnectOff: true, [`agent:${PROMPT_ID}`]: mirror }, reply: () => 'TITLE: Migration\nCONTEXT: fixture\nDONE: -\nNEXT: Continue\nASK: Old decision — OLD_QUESTION?' }
  return { world, mirror }
}
const addPrompt = (world: World, at: number, session = PROMPT_SESSION): string => {
  const name = `codex-prompt-${at}-77.json`
  world.files.set(`${INBOX}/${name}`, JSON.stringify({ session_id: session, prompt: 'PRIVATE_NEW_INPUT', last_assistant_message: 'PRIVATE_FAKE_REPLY?', transcript_path: '/home/me/.codex/sessions/2026/10/16/rollout-prompt.jsonl' }))
  world.mtime += 1
  return name
}

const effectivePromptMirror = (world: World) => withAgentPrompts(world.store![`agent:${PROMPT_ID}`] as ReturnType<typeof emptyMirror>, Object.entries(world.store!).filter(([key]) => key.startsWith(`agentPrompt:${PROMPT_ID}:`)).map(([, value]) => value), Date.parse('2026-10-16T13:00:00Z'))!

const JOBS = `# 專案進度

## 求職
### Google 暑期實習
> 截止 12-20
- [x] 改履歷
- [?] 推薦信 — 等教授回覆
- [ ] 投遞

## persona_framework
<!-- auto session=a81d0c42 state=ended updated=2026-10-16T10:00:00.000Z -->
### 修 CI
- [x] 看 log
- [ ] 修測試
<!-- /auto session=a81d0c42 -->
`

const ARCHIVE = '/home/me/.claude/progress-archive-2026-10.md'
const TIDY = {
  command: 'progress',
  args: '整理',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}
const OLD_DONE = `# 專案進度

## ai-research-skills
<!-- auto session=c55e2f10 state=done updated=2026-10-15T09:00:00.000Z -->
### 發佈 1.7.4
> 完成
- [x] 打 tag
<!-- /auto session=c55e2f10 -->
`

const JOURNAL = '/home/me/.claude/progress-journal-2026-10.md'

// The engine's side of what the mod shows outside its pane, written down for the tests.
const outside = (on: On, world?: World) => {
  const seen = { notified: [] as string[], copied: [] as string[], status: [] as Array<string | undefined> }
  on('ui.notify', ($, e) => {
    seen.notified.push(e.text)
    if (world !== undefined && (world.node === null || world.node !== undefined && !isNodeSupported(world.node) || world.bootstrapFailure || world.workerFailure !== undefined)) world.finishSetup?.()
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('ui.copy', ($, e) => {
    seen.copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })

  return seen
}

const LIVE_PRESS = '# Progress\n\n## Demo\n<!-- auto session=a1b2c3d4 agent=claude state=working updated=2026-10-16T11:59:00Z resume=a1b2c3d4-1111-2222-3333 -->\n### Worktree removal\n- [?] Remove the old worktree, OK?\n<!-- /auto session=a1b2c3d4 -->\n'
const LIVE_PRESS_KEY = 'Demo::Worktree removal::0'

type PressNode = { type: string; key?: string; props?: { key?: string }; text?: string; children?: readonly (PressNode | string)[] }
const pressChildren = (node: PressNode): readonly (PressNode | string)[] => node.children ?? []
const pressNodes = (node: PressNode): PressNode[] => [node, ...pressChildren(node).flatMap(child => typeof child === 'string' ? [] : pressNodes(child))]
const pressTexts = (node: PressNode): string[] => node.type === 'Text'
  ? [node.text ?? pressChildren(node).filter(child => typeof child === 'string').join('')]
  : pressChildren(node).flatMap(child => typeof child === 'string' ? [] : pressTexts(child))
// The engine retains keys on controls, but strips them from Text and Box nodes.
// Only a container whose controls all belong to this card can prove feedback placement.
const besideButton = (nodes: readonly unknown[], key: string, needsButton = true): string[] => {
  const controls = (nodes as readonly PressNode[]).flatMap(node => pressNodes(node).filter(child => child.type === 'Button' || child.type === 'Input').map(child => child.key ?? child.props?.key ?? ''))
  const cards = controls.flatMap(control => control.startsWith('ask::') ? [control.slice(5)]
    : /::(?:copy|resume|hide|unhide|reply|tick|hand|archive|done|did|revise)$/.test(control) ? [control.replace(/::[^:]+$/, '')]
      : controls.some(other => other.startsWith(`${control}::`)) ? [control] : [])
  const card = cards.sort((a, b) => b.length - a.length).find(card => key === card || key === `ask::${card}` || key.startsWith(`${card}::`))
    ?? key
  const belongs = (button: string) => button === card || button === `ask::${card}` || button.startsWith(`${card}::`) || card === 'continue' && button === 'section::steps'
  const candidates = (nodes as readonly PressNode[]).filter(node => {
    const keys = pressNodes(node).filter(child => child.type === 'Button').map(child => child.key ?? child.props?.key ?? '')
    return keys.length > 0 && (!needsButton || keys.includes(key)) && keys.every(belongs)
  })
  return candidates.length === 0 ? [] : pressTexts(candidates.sort((a, b) => pressTexts(b).length - pressTexts(a).length)[0]!)
}

const besideLabel = (nodes: readonly unknown[], label: string, text: string): boolean => (nodes as readonly PressNode[]).some(node =>
  !pressNodes(node).some(child => child.type === 'Button') && pressTexts(node).includes(label) && pressTexts(node).includes(text))

const resultAfterControl = (nodes: readonly unknown[], key: string, text: string): boolean => (nodes as readonly PressNode[]).some(node => {
  const children = pressChildren(node).filter((child): child is PressNode => typeof child !== 'string')
  const at = children.findIndex(child => pressNodes(child).some(one => (one.type === 'Button' || one.type === 'Input') && (one.key ?? one.props?.key) === key))
  return at >= 0 && children[at + 1] !== undefined && pressTexts(children[at + 1]!).includes(text)
})

type MatrixKind = 'needs-you' | 'live-ask' | 'stopped' | 'unknown-session' | 'blocked' | 'done' | 'hidden' | 'own-block' | 'ended' | 'hand-kept' | 'retained' | 'inbox'
type MatrixSource = 'this-session' | 'another-session'
type MatrixCell = { agent: string; source: MatrixSource; kind: MatrixKind; name: string; askKind?: 'choose' | 'review' | 'wait' | 'text' }

const MATRIX_AGENTS = ['claude', 'codex', 'antigravity', 'hermes', 'openclaw', 'grok', 'opencode', 'cursor'] as const
const MATRIX_KINDS: readonly MatrixKind[] = ['needs-you', 'live-ask', 'stopped', 'unknown-session', 'blocked', 'done', 'hidden', 'own-block', 'ended', 'hand-kept', 'retained', 'inbox']
const PANE_MATRIX: readonly MatrixCell[] = MATRIX_AGENTS.flatMap(agent => (['this-session', 'another-session'] as const).flatMap(source =>
  MATRIX_KINDS.map(kind => ({ agent, source, kind, name: `${kind} / ${agent} / ${source}` }))))

const MATRIX_AT = Date.parse('2026-10-16T12:00:00Z')
const MATRIX_OPEN = ['waiting', 'others', 'recent', 'hidden', 'stopped', 'idle', 'steps', 'older', 'reminder']
type MatrixFixture = { world: World; view: View; target: string; opener: string | null; buttons: string[]; resume: string | null; mirror: ProgressMirror | null }

// Each action gets a fresh engine. A successful reply, hide or archive cannot remove the
// control before another action is tested, and no loop walks a changing render tree.
const paneEngineFixture = (cell: MatrixCell): MatrixFixture => {
  const isOwn = cell.source === 'this-session'
  const session = isOwn ? SESSION : 'a1b2c3d4-1111-2222-3333'
  const isAsk = ['needs-you', 'live-ask', 'hidden', 'retained'].includes(cell.kind)
  const subject = cell.askKind === 'choose' ? 'First or Second?' : cell.askKind === 'review' ? 'Review the synthetic result' : cell.askKind === 'wait' ? 'waiting for the synthetic result' : cell.askKind === 'text' ? 'What should happen next?' : cell.kind === 'live-ask' ? 'Run `echo matrix`' : isAsk ? 'Keep the synthetic result, OK?' : 'Synthetic next step'
  let producer = { ...emptyMirror(session, 'persona_framework', MATRIX_AT, '/work/persona_framework', cell.agent), title: cell.name, isTitleFinal: true }
  producer = applyTaskCreate(producer, { subject, metadata: isAsk ? { waiting: 'you', ask: cell.askKind ?? (cell.kind === 'live-ask' ? 'do' : 'confirm'), options: cell.askKind === 'choose' ? ['First', 'Second'] : undefined, command: cell.kind === 'live-ask' ? 'echo matrix' : undefined } : cell.kind === 'blocked' ? { blocked: 'Synthetic dependency' } : {} }, '1', MATRIX_AT)
  producer = { ...producer, state: cell.kind === 'done' ? 'done' : cell.kind === 'ended' ? 'ended' : 'waiting' }
  if (cell.kind === 'done') producer = applyTaskUpdate(producer, { taskId: '1', status: 'completed' }, MATRIX_AT)
  if (cell.kind === 'stopped') producer = { ...producer, updated: MATRIX_AT - 86400000 }
  let text = cell.kind === 'hand-kept'
    ? `# Progress\n\n## persona_framework\n### ${cell.name}\n- [ ] Synthetic next step\n- [ ] Later step\n`
    : upsertAutoBlock('# Progress\n', producer, EN)
  if (cell.kind === 'unknown-session') text = text.replace(/ resume=[^\s>]+/g, '').replace(/ dir="[^"]*"/g, '')
  let mirror = isOwn && cell.kind !== 'hand-kept' && cell.kind !== 'inbox' ? producer : null
  const files = new Map([[FILE, text]])
  const pendingFiles = cell.kind === 'inbox' ? [{ name: `${cell.agent}-turn-1792152000-211.json`, body: JSON.stringify({ session_id: session, cwd: '/work/persona_framework', last_assistant_message: 'Keep the inbox result, OK?' }), at: 1 }] : []
  const pending = peekInbox(pendingFiles)
  for (const file of pendingFiles) files.set(`${INBOX}/${file.name}`, file.body)
  if (cell.kind === 'inbox') { text = '# Progress\n'; files.set(FILE, text) }
  const projects = parseProgress(text)
  const ledger = observeQuestions(emptyQuestions(), projects, mirror, [], MATRIX_AT, true, 'matrix', { retired: [], consumed: [] }, pending).ledger
  if (cell.kind === 'retained') { text = '# Progress\n'; files.set(FILE, text); mirror = null }
  let view = buildView(parseProgress(text), ['persona_framework'], mirror, MATRIX_AT, 0, {}, EN, [], {}, ledger, { retired: [], consumed: [] }, pending)
  const hidden = cell.kind === 'hidden' ? view.waiting.map(ask => ask.hideKey) : []
  if (hidden.length) files.set(FILE.replace('.md', '-answered.json'), JSON.stringify({ answered: hidden }))
  files.set(QUESTIONS, questionsJson(ledger))
  view = buildView(parseProgress(text), ['persona_framework'], mirror, MATRIX_AT, 0, {}, EN, hidden, {}, ledger, { retired: [], consumed: [] }, pending)
  const store: Record<string, unknown> = { autoConnectOff: true, inboxDone: {}, lang: 'en', opened: MATRIX_OPEN }
  if (mirror !== null) store[`mirror:${SESSION}`] = mirror
  const world: World = { files, mtime: 1, hasTasks: true, store }
  const ask = [...view.waiting, ...view.hidden, ...(view.reminder ?? []), ...(view.older ?? [])][0]
  const rows = [...view.active, ...view.idle, ...view.stopped, ...view.groups.flatMap(group => group.rows)]
  const row = rows.find(one => one.title === cell.name)
  const buttons: string[] = []
  let target = '', opener: string | null = null, resume: string | null = null
  if (ask !== undefined) {
    target = ask.key
    if (cell.kind === 'hidden') buttons.push(`${target}::unhide`)
    else {
      opener = `ask::${target}`
      buttons.push(opener)
      if (ask.where === 'here') {
        if (ask.kind === 'do') { if (ask.command !== null) buttons.push(`${target}::copy`); buttons.push(`${target}::did`) }
        else if (ask.kind === 'choose') buttons.push(...ask.options.map(option => `${target}::${option}`))
        else if (ask.kind === 'review') buttons.push(`${target}::${EN.looksGood}`, `${target}::revise`)
        else if (ask.kind === 'wait') buttons.push(`${target}::${EN.ready}`)
        else if (ask.kind === 'confirm') buttons.push(`${target}::${EN.yes}`, `${target}::${EN.no}`)
      } else if (ask.where === 'manual') buttons.push(`${target}::done`)
      else {
        if (ask.kind === 'do' && ask.command !== null) buttons.push(`${target}::copy`)
        if (ask.reopen !== null) { buttons.push(`${target}::resume`); resume = ask.reopen }
      }
      if (ask.hideKey !== '' && ask.canHide !== false) buttons.push(`${target}::hide`)
    }
  } else if (row !== undefined) {
    target = row.key; opener = row.key; buttons.push(row.key)
    if (row.auto === 'ended') {
      if (row.isHere) buttons.push(`${target}::take`)
      if (row.resume !== null) { buttons.push(`${target}::resume`); resume = row.resume }
      if (row.archive !== null) buttons.push(`${target}::archive`)
      if (row.confirm != null) buttons.push(`${target}::done`)
    } else if (row.auto === null && row.next !== null) {
      buttons.push(`${target}::tick`, `${target}::hand`)
      if (row.archive !== null) buttons.push(`${target}::archive`)
      if (row.confirm != null) buttons.push(`${target}::done`)
    }
  }
  if (view.current !== null) {
    buttons.push('section::steps')
    if (view.current.state === 'waiting') buttons.push('continue')
  }
  if (cell.kind === 'done' && view.current === null) buttons.push('archive')
  if (buttons.length === 0) throw new Error(`Matrix cell has no card or reason: ${cell.name}`)
  return { world, view, target, opener, buttons: [...new Set(buttons)], resume, mirror }
}

type EngineMatrixCase = { cell: MatrixCell; button: string; isFailing: boolean; title?: string }
const PANE_ASK_VARIANTS: readonly MatrixCell[] = MATRIX_AGENTS.flatMap(agent => (['this-session', 'another-session'] as const).flatMap(source => (['choose', 'review', 'wait', 'text'] as const).map(askKind => ({ agent, source, kind: 'needs-you' as const, askKind, name: `needs-you ${askKind} / ${agent} / ${source}` }))))
const ENGINE_CELLS = [...PANE_MATRIX, ...PANE_ASK_VARIANTS]
const paneMatrixGroup = (cell: MatrixCell, fixture: MatrixFixture): string => JSON.stringify([
  cell.kind, cell.askKind, cell.source,
  fixture.buttons.map(button => fixture.target === '' ? button : button.replace(fixture.target, '<card>')),
  fixture.resume !== null,
])
const ENGINE_GROUPS = new Map<string, MatrixCell>()
for (const cell of ENGINE_CELLS) {
  const group = paneMatrixGroup(cell, paneEngineFixture(cell))
  if (!ENGINE_GROUPS.has(group)) ENGINE_GROUPS.set(group, cell)
}
// Full control inventories stay in the pure matrices; the engine exercises one
// representative press per behaviour group in both normal and refused modes.
const ENGINE_MATRIX: readonly EngineMatrixCase[] = [...ENGINE_GROUPS.values()].flatMap(cell => {
  const fixture = paneEngineFixture(cell)
  let verb = 'hide'
  if (cell.kind === 'hand-kept') verb = 'tick'
  else if (cell.kind === 'hidden') verb = 'unhide'
  else if (cell.kind === 'ended') verb = cell.source === 'this-session' ? 'take' : 'archive'
  else if (cell.kind === 'live-ask') verb = cell.source === 'this-session' ? 'copy' : 'resume'
  else if (cell.kind === 'needs-you' && cell.source === 'this-session') {
    const answers = { choose: 'First', review: EN.looksGood, wait: EN.ready, text: 'hide', confirm: EN.yes }
    verb = answers[cell.askKind ?? 'confirm']
  }
  const button = fixture.buttons.find(button => button.endsWith(`::${verb}`))
    ?? fixture.buttons.find(button => button !== fixture.opener && button !== 'section::steps')
    ?? fixture.buttons[0]!
  return [false, true].map(isFailing => ({ cell, button, isFailing }))
}).concat([
  { kind: 'hand-kept', verb: 'hand', title: 'handing a task to this session shows its result next to its row' },
  { kind: 'hand-kept', verb: 'done', title: 'completing a hand-kept row shows its result next to that row' },
  { kind: 'live-ask', verb: 'did', title: 'did it sends the answer from its own pane card' },
  { kind: 'needs-you', verb: EN.no, title: 'no sends the answer from its own pane card' },
  { kind: 'needs-you', askKind: 'choose', verb: 'Second', title: 'the second choice sends the answer from its own pane card' },
  { kind: 'needs-you', askKind: 'review', verb: 'revise', title: 'needs changes opens the reply box on its own pane card' },
].map(({ kind, askKind, verb, title }) => {
  const cell: MatrixCell = { agent: 'claude', source: 'this-session', kind: kind as MatrixKind, askKind: askKind as MatrixCell['askKind'], name: title }
  const fixture = paneEngineFixture(cell)
  const button = fixture.buttons.find(button => button.endsWith(`::${verb}`))
  if (button === undefined) throw new Error(`The engine fixture does not offer ${verb}: ${title}`)
  return { cell, button, isFailing: false, title }
}))
const NORMAL_MATRIX_TITLE = 'every button on every card kind from every agent, in this session or another, does its job or shows a reason'
const FAILING_MATRIX_TITLE = 'every button still shows a reason when the engine refuses copy, writes or the session is gone'

const engineMatrixTest = ({ cell, button, isFailing }: EngineMatrixCase) => async ($: Engine, on: On) => {
  const fixture = paneEngineFixture(cell)
  const { world } = fixture
  const clock = engineBeneath(on, world)
  on('ui.status', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'terminal_bell' as const } }))
  on('ui.copy', () => isFailing ? { deny: 'synthetic clipboard refusal' } : { value: { isCopied: true as const } })
  on('prompt.submit', ($, event) => isFailing ? { drop: 'synthetic session gone' } : { text: event.text })
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    if (fixture.opener !== null && !fixture.opener.startsWith('ask::')) await ui.press({ key: fixture.opener })
    else if (fixture.opener !== null && fixture.view.focus?.type !== 'ask') await ui.press({ key: fixture.opener })
    const isCard = (key: string) => fixture.buttons.includes(key) || fixture.target !== '' && (key === fixture.target || key === `ask::${fixture.target}` || key.startsWith(`${fixture.target}::`))
    const offered = (await ui.findAll({ type: 'Button' })).map(node => node.key ?? '').filter(isCard)
    expect([...new Set(offered)].sort()).toEqual([...fixture.buttons].sort())
    expect(await ui.find({ type: 'Button', key: button })).toBeDefined()
    const before = JSON.stringify(await ui.findAll({ type: 'Text' }))
    if (isFailing) world.unwritable = new Set([FILE, FILE.replace('.md', '-answered.json'), FILE.replace('.md', '-archive-2026-10.md')])
    await ui.press({ key: button })
    const isToggle = button === fixture.opener || button === 'section::steps'
    if (button.endsWith('::revise')) {
      expect(await ui.find({ type: 'Input', key: `${fixture.target}::reply` })).toBeDefined()
      return
    }
    if (isToggle) {
      const after = JSON.stringify(await ui.findAll({ type: 'Text' }))
      expect(after).not.toBe(before)
      expect(await ui.find({ type: 'Button', key: button })).toBeDefined()
      return
    }
    let expected: string
    if (button.endsWith('::copy') || button.endsWith('::resume')) expected = isFailing ? EN.pressCopyFallback : EN.copied
    else if (button.endsWith('::hide')) expected = isFailing ? EN.hideFailed : EN.pressHidden
    else if (button.endsWith('::unhide')) expected = isFailing ? EN.hideFailed : EN.pressShown
    else if (button === 'continue' || button.endsWith('::take') || button.endsWith('::hand') || button.endsWith(`::${EN.yes}`) || button.endsWith(`::${EN.no}`) || button.endsWith('::did') || button.endsWith('::First') || button.endsWith('::Second') || button.endsWith(`::${EN.looksGood}`) || button.endsWith(`::${EN.ready}`)) expected = isFailing ? EN.pressSessionGone : EN.pressSent
    else if (button.endsWith('::tick')) expected = isFailing ? EN.boardWriteFailed : EN.boardTicked('Synthetic next step')
    else if (button.endsWith('::archive')) expected = isFailing ? EN.boardWriteFailed : EN.archivedOne(cell.name)
    else if (button.endsWith('::done')) expected = isFailing ? EN.boardWriteFailed : EN.confirmedDone(cell.name)
    else expected = isFailing ? EN.boardWriteFailed : EN.tidyMoved(1)
    const hasButton = await ui.find({ type: 'Button', key: button })
    if (hasButton !== undefined) expect(besideButton(await ui.findAll({ type: 'Box' }), button)).toContain(expected)
    else {
      const nodes = await ui.findAll({ type: 'Box' })
      expect(besideButton(nodes, button, false).includes(expected) || besideLabel(nodes, cell.name, expected)).toBe(true)
    }
    expect(await ui.find({ type: 'Text', text: EN.pressPending })).toBeUndefined()
    if (isFailing && (button.endsWith('::copy') || button.endsWith('::resume'))) {
      const text = button.endsWith('::copy') ? 'echo matrix' : fixture.resume
      expect((await ui.find({ type: 'Input', key: `${fixture.target}::copy-text` }))?.props.value).toBe(text)
    }
    await clock.advance(2100)
    if (await ui.find({ type: 'Button', key: button }) !== undefined) expect(besideButton(await ui.findAll({ type: 'Box' }), button)).toContain(expected)
    else {
      const nodes = await ui.findAll({ type: 'Box' })
      expect(besideButton(nodes, button, false).includes(expected) || besideLabel(nodes, cell.name, expected)).toBe(true)
    }
  } finally { await ui.unmount() }
}

const namedEngineMatrixTest = (title: string) => {
  const one = ENGINE_MATRIX.find(one => one.title === title)
  if (one === undefined) throw new Error(`The engine matrix does not contain ${title}`)
  return engineMatrixTest(one)
}

const engineMatrixSummary = (isFailing: boolean) => () => {
  const started = performance.now()
  expect(ENGINE_GROUPS.size).toBe(40)
  expect(ENGINE_MATRIX.length).toBe(86)
  const agents = new Set<string>()
  for (const cell of ENGINE_CELLS) {
    const fixture = paneEngineFixture(cell)
    const group = paneMatrixGroup(cell, fixture)
    const representative = ENGINE_GROUPS.get(group)
    expect(representative).toBeDefined()
    const expected = paneEngineFixture(representative!)
    expect(paneMatrixGroup(cell, fixture)).toBe(paneMatrixGroup(representative!, expected))
    expect(ENGINE_MATRIX.some(one => one.isFailing === isFailing && one.cell === representative)).toBe(true)
    if (fixture.resume !== null) {
      const ask = [...fixture.view.waiting, ...fixture.view.hidden, ...(fixture.view.older ?? [])].find(one => one.key === fixture.target)
      const row = [...fixture.view.active, ...fixture.view.stopped, ...fixture.view.idle, ...fixture.view.groups.flatMap(group => group.rows)].find(one => one.key === fixture.target)
      expect(fixture.resume).toBe(ask?.reopen ?? row?.resume)
      expect(fixture.resume).toContain(cell.agent === 'claude' ? 'claude' : cell.agent)
    }
    agents.add(cell.agent)
  }
  expect([...agents].sort()).toEqual([...MATRIX_AGENTS].sort())
  console.log(`pane fixture matrix: ${ENGINE_CELLS.length} cells, ${ENGINE_GROUPS.size} engine groups, ${(performance.now() - started).toFixed(1)} ms`)
}

// An idle row: a hand-kept task first seen ten days before the test clock. An ended session's
// block that old is set aside at session start, so it cannot stand in for one.
const idleFiles = (board: string, idle: string): [string, string][] => [[FILE, board], [seenPath(FILE), seenJson(withSeen({}, parseProgress(idle), Date.parse('2026-10-06T12:00:00Z')))]]

const ANSWERED = '/home/me/.claude/progress-answered.json'
const storedQuestion = (world: World, words: string): string =>
  (JSON.parse(world.files.get(QUESTIONS) ?? '{"records":[]}').records as Array<{ id: string; words: string; isWaiting: boolean }>).find(row => row.words === words && row.isWaiting)?.id ?? ''

// progress.html lists what needs you in its Needs you sheet, before Working now (#546).
const inNeeds = (page: string, text: string): boolean => { const at = page.indexOf(text); return at > page.indexOf('id="dash-needs"') && at < page.indexOf('id="dash-working"') }
// An unprocessed inbox turn's copy; a Needs you item also uses class="ask", but starts with its kind.
const INBOX_ASK = /<div class="ask" data-agent="[^"]*"><div class="where">/

const ASKED = (text: string): string => `# 專案進度

## FLOODABM
<!-- auto session=dddddddd agent=codex state=waiting updated=2026-10-16T11:59:00.000Z -->
### 跑實驗
- [?] ${text}
<!-- /auto session=dddddddd -->
`

const DUE = '# 專案進度\n\n## 求職\n### Google 暑期實習\n> 截止 10-16\n- [ ] 投遞\n'


const EDITED = [
  { role: 'user' as const, text: '幫我把限流加到 API', toolUses: [] },
  { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Edit', input: {} }] },
]

const DIGEST = (prompt: string): string | undefined =>
  prompt.includes('TITLE:')
    ? 'TITLE: 幫 API 加上限流\nCONTEXT: 公開端點被刷爆，要擋掉濫用\nDONE: 加好限流中介層\nNEXT: 寫限流測試\nASK: 每把金鑰的上限 — 一分鐘 100 還是 300？'
    : undefined

const BACKGROUND_MESSAGES: NonNullable<World['messages']> = [
  { role: 'user', text: 'Run the tests', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'background-1', tool: 'Bash', input: { command: 'synthetic-tests', run_in_background: true } }] },
]

const launchBackground = ($: Engine, id = 'background-1') =>
  $.tool.call({ tool: 'SyntheticBackground', tool_use_id: id, run_in_background: true })

// The person's message reaching this session: through prompt.submit, stamped with where it
// came from, then the turn it starts.
const say = async ($: Engine, text: string, turnId: string, origin: PromptOrigin = { kind: 'composer' }): Promise<void> => {
  await $.prompt.submit({ text, origin, wait: false })
  await $.turn.start({ text, turnId })
}



const QUESTION_TURN = 'codex-turn-1792152000-213.json'
const QUESTION_TEXT = 'Added the middleware. Keep the complete question, OK?'
const pendingQuestionWorld = (): World => ({
  files: new Map([[FILE, '# Progress\n'], [`${INBOX}/${QUESTION_TURN}`, JSON.stringify({ session_id: 'demo-question', cwd: '/work/api-gateway', last_assistant_message: QUESTION_TEXT })]]),
  mtime: 1,
  hasTasks: true,
  store: { inboxDone: {}, autoConnectOff: true, lang: 'en' },
  reply: prompt => prompt.includes('TITLE:') ? 'TITLE: Add the limiter\nDONE: Added the middleware\nNEXT: Write the tests\nASK: Keep the complete question, OK?' : undefined,
})
const breakQuestionFile = (world: World): void => {
  world.files.set(QUESTIONS, (world.files.get(QUESTIONS) ?? '') + '\0'.repeat(32))
  world.isMoveRefused = path => path === QUESTIONS
}
const pendingQuestionEntries = (world: World): unknown[] => Object.entries(world.store ?? {}).filter(([key]) => key.startsWith('pendingInboxQuestion:')).map(([, value]) => value)

const seedPendingQuestion = (world: World, age = 0): string => {
  const turn = peekInbox([{ name: QUESTION_TURN, body: world.files.get(`${INBOX}/${QUESTION_TURN}`)!, at: Date.parse('2026-10-16T12:00:00Z') }])[0]!
  turn.sourceAt = Date.parse('2026-10-16T12:00:00Z') - age
  turn.at = turn.sourceAt
  const key = `pendingInboxQuestion:${sha256(FILE)}:${sha256(JSON.stringify([turn.id, turn.sourceRevisions]))}`
  world.store![key] = turn
  world.files.delete(`${INBOX}/${QUESTION_TURN}`)
  return key
}

// What Codex 0.163.0 handed its Stop and SessionEnd hooks, and the lines of its session log the
// pane reads, from a real `codex exec` turn (home directory renamed to /home/me).
const CODEX_STOP = "{\"session_id\":\"01a1486b-b48b-7621-8c35-f8c0c2e2d4f6\",\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"transcript_path\":\"/home/me/.codex/sessions/2026/10/17/rollout-2026-10-17T05-53-00-01a1486b-b48b-7621-8c35-f8c0c2e2d4f6.jsonl\",\"cwd\":\"/home/me/work/api-gateway\",\"hook_event_name\":\"Stop\",\"model\":\"mock-model\",\"permission_mode\":\"bypassPermissions\",\"stop_hook_active\":false,\"last_assistant_message\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\"}"
const CODEX_END = "{\"session_id\":\"01a1486b-b48b-7621-8c35-f8c0c2e2d4f6\",\"transcript_path\":\"/home/me/.codex/sessions/2026/10/17/rollout-2026-10-17T05-53-00-01a1486b-b48b-7621-8c35-f8c0c2e2d4f6.jsonl\",\"cwd\":\"/home/me/work/api-gateway\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
const CODEX_ROLLOUT = "{\"timestamp\":\"2026-10-17T05:53:00.625Z\",\"ordinal\":3,\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg_01a1486b-b4cb-7423-9bc1-70f09cad585f\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>\\n  <cwd>/home/me/work/api-gateway</cwd>\\n  <shell>bash</shell>\\n  <current_date>2026-10-17</current_date>\\n  <timezone>Etc/UTC</timezone>\\n  <filesystem><workspace_roots><root>/home/me/work/api-gateway</root></workspace_roots><permission_profile type=\\\"managed\\\"><file_system type=\\\"restricted\\\"><entry access=\\\"read\\\"><special>:root</special></entry></file_system></permission_profile></filesystem>\\n</environment_context>\"}],\"internal_chat_message_metadata_passthrough\":{\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"create_time\":1792216380.6198695,\"content_item_kinds\":[\"environments.environment_context\"]}}}\n{\"timestamp\":\"2026-10-17T05:53:00.644Z\",\"ordinal\":7,\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg_01a1486b-b4e4-7b50-a7d0-331c8e1059ec\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Add rate limiting to the public endpoints\"}],\"internal_chat_message_metadata_passthrough\":{\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"create_time\":1792216380.6447554,\"content_item_kinds\":[\"user.text\"]}},\"metadata\":{\"retained_source\":{\"id\":{\"message_id\":\"msg_01a1486b-b4e4-7b50-a7d0-331c8e1059ec\",\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"role\":\"user\"},\"revision\":\"retained_01a1486b-b4e4-7b50-a7d0-333ccd7ec592\",\"complete\":true},\"client_authored\":false,\"user_input_order\":0,\"mcp_attribution\":{\"status\":\"none\"}}}\n{\"timestamp\":\"2026-10-17T05:53:00.664Z\",\"ordinal\":10,\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg_1\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\"}],\"internal_chat_message_metadata_passthrough\":{\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"content_item_kinds\":[\"unknown\"]}},\"metadata\":{\"retained_source\":{\"id\":{\"message_id\":\"msg_1\",\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"role\":\"assistant\"},\"revision\":\"retained_01a1486b-b4f8-7542-ab8c-2860525eccd1\",\"complete\":true},\"client_authored\":false,\"user_input_order\":1}}\n{\"timestamp\":\"2026-10-17T05:53:00.708Z\",\"ordinal\":13,\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"root_turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"turn_id\":\"01a1486b-b4a4-71c3-9f5f-5c50844a08ba\",\"last_agent_message\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\",\"started_at\":1792216380,\"completed_at\":1792216380,\"duration_ms\":123,\"time_to_first_token_ms\":76}}\n"

// Real payloads from Gemini CLI 0.64.0, OpenCode 1.19.3, Hermes Agent 0.19.0, Grok Build
// 1.0.62 and OpenClaw 2026.10.4, each run once against a mock model; only the home folder is renamed.
const GEMINI_TURN = "{\"session_id\":\"1f482f61-a6df-4dcb-96cc-b949340956b7\",\"transcript_path\":\"/home/me/.gemini/tmp/api-gateway/chats/session-2026-10-17T06-24-1f482f61.jsonl\",\"cwd\":\"/home/me/work/api-gateway\",\"hook_event_name\":\"AfterAgent\",\"timestamp\":\"2026-10-17T06:24:57.946Z\",\"prompt\":\"Add rate limiting to the public endpoints\",\"prompt_response\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\",\"stop_hook_active\":false}"
const GEMINI_END = "{\"session_id\":\"1f482f61-a6df-4dcb-96cc-b949340956b7\",\"transcript_path\":\"/home/me/.gemini/tmp/api-gateway/chats/session-2026-10-17T06-24-1f482f61.jsonl\",\"cwd\":\"/home/me/work/api-gateway\",\"hook_event_name\":\"SessionEnd\",\"timestamp\":\"2026-10-17T06:24:57.967Z\",\"reason\":\"exit\"}"
const OPENCODE_TURN = "{\"session_id\":\"ses_eb75cd77affeN3SUn9NJonlKvA\",\"cwd\":\"/home/me/work/api-gateway\",\"prompt\":\"\\\"Add rate limiting to the public endpoints\\\"\",\"last_assistant_message\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\"}"
const HERMES_TURN = "{\"hook_event_name\": \"post_llm_call\", \"tool_name\": null, \"tool_input\": null, \"session_id\": \"20261017_065228_82992a\", \"cwd\": \"/home/me/work/api-gateway\", \"extra\": {\"task_id\": \"d480bffd-5115-4d30-8b71-7f2fd19b4a4e\", \"turn_id\": \"20261017_065228_82992a:d480bffd-5115-4d30-8b71-7f2fd19b4a4e:89152e5f\", \"user_message\": \"Add rate limiting to the public endpoints\", \"assistant_response\": \"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\", \"conversation_history\": [{\"role\": \"user\", \"content\": \"Add rate limiting to the public endpoints\", \"_db_persisted\": true}, {\"role\": \"assistant\", \"content\": \"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\", \"reasoning\": null, \"finish_reason\": \"stop\", \"_db_persisted\": true}], \"model\": \"mock-model\", \"platform\": \"cli\", \"telemetry_schema_version\": \"hermes.observer.v1\"}}"
const GROK_STOP = "{\"hookEventName\":\"stop\",\"sessionId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"cwd\":\"/home/me/work/api-gateway\",\"workspaceRoot\":\"/home/me/work/api-gateway\",\"timestamp\":\"2026-10-17T07:00:07.211798674+00:00\",\"transcriptPath\":\"/home/me/.grok/sessions/%2Fhome%2Fme%2Fwork%2Fapi-gateway/01a148a9-24e5-7ff2-8b96-237d7daf0923/updates.jsonl\",\"promptId\":\"46159f6e-bf07-40de-96f9-e001b03ffeed\",\"permissionMode\":\"default\",\"reason\":\"end_turn\",\"stopHookActive\":false,\"lastAssistantMessage\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\",\"backgroundTasks\":[],\"sessionCrons\":[],\"hook_event_name\":\"Stop\",\"session_id\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"transcript_path\":\"/home/me/.grok/sessions/%2Fhome%2Fme%2Fwork%2Fapi-gateway/01a148a9-24e5-7ff2-8b96-237d7daf0923/updates.jsonl\",\"permission_mode\":\"default\",\"stop_hook_active\":false,\"last_assistant_message\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\"}\n"
const GROK_SHUTDOWN = "{\"hookEventName\":\"stop\",\"sessionId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"cwd\":\"/home/me/work/api-gateway\",\"workspaceRoot\":\"/home/me/work/api-gateway\",\"timestamp\":\"2026-10-17T07:00:07.293629986+00:00\",\"transcriptPath\":\"/home/me/.grok/sessions/%2Fhome%2Fme%2Fwork%2Fapi-gateway/01a148a9-24e5-7ff2-8b96-237d7daf0923/updates.jsonl\",\"permissionMode\":\"default\",\"reason\":\"shutdown\",\"stopHookActive\":false,\"hook_event_name\":\"Stop\",\"session_id\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"transcript_path\":\"/home/me/.grok/sessions/%2Fhome%2Fme%2Fwork%2Fapi-gateway/01a148a9-24e5-7ff2-8b96-237d7daf0923/updates.jsonl\",\"permission_mode\":\"default\",\"stop_hook_active\":false}\n"
const GROK_END = "{\"hookEventName\":\"session_end\",\"sessionId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"cwd\":\"/home/me/work/api-gateway\",\"workspaceRoot\":\"/home/me/work/api-gateway\",\"timestamp\":\"2026-10-17T07:00:07.278036235+00:00\",\"transcriptPath\":\"/home/me/.grok/sessions/%2Fhome%2Fme%2Fwork%2Fapi-gateway/01a148a9-24e5-7ff2-8b96-237d7daf0923/updates.jsonl\",\"permissionMode\":\"default\",\"reason\":\"shutdown\",\"hook_event_name\":\"SessionEnd\",\"session_id\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"transcript_path\":\"/home/me/.grok/sessions/%2Fhome%2Fme%2Fwork%2Fapi-gateway/01a148a9-24e5-7ff2-8b96-237d7daf0923/updates.jsonl\",\"permission_mode\":\"default\"}\n"
const GROK_UPDATES = "{\"timestamp\":1792220407,\"method\":\"session/update\",\"params\":{\"sessionId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"update\":{\"sessionUpdate\":\"user_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"Add rate limiting to the public endpoints\"},\"_meta\":{\"modelId\":\"grok-code-fast-1\",\"promptIndex\":0}},\"_meta\":{\"eventId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923-2\",\"agentTimestampMs\":1792220407173}}}\n{\"timestamp\":1792220407,\"method\":\"session/update\",\"params\":{\"sessionId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\"}},\"_meta\":{\"totalTokens\":1282,\"requestTrimmedTokens\":0,\"eventId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923-4\",\"agentTimestampMs\":1792220407201,\"promptId\":\"46159f6e-bf07-40de-96f9-e001b03ffeed\",\"streamStartMs\":1792220407198,\"turnStartMs\":1792220407167,\"updateType\":\"AgentMessageChunk\",\"chunkId\":1}}}\n{\"timestamp\":1792220407,\"method\":\"_x.ai/session/update\",\"params\":{\"sessionId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"update\":{\"sessionUpdate\":\"hook_execution\",\"event_name\":\"stop\",\"prompt_id\":\"46159f6e-bf07-40de-96f9-e001b03ffeed\",\"runs\":[{\"name\":\"global/agent-board:stop[0].hooks[0]\",\"status\":{\"status\":\"success\",\"elapsed_ms\":26}}]},\"_meta\":{\"eventId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923-8\",\"agentTimestampMs\":1792220407242}}}\n{\"timestamp\":1792220407,\"method\":\"_x.ai/session/update\",\"params\":{\"sessionId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"update\":{\"sessionUpdate\":\"turn_completed\",\"prompt_id\":\"46159f6e-bf07-40de-96f9-e001b03ffeed\",\"stop_reason\":\"end_turn\",\"usage\":{\"inputTokens\":1,\"outputTokens\":1,\"totalTokens\":2,\"cachedReadTokens\":0,\"cacheCreationTokens\":0,\"reasoningTokens\":0,\"modelCalls\":1,\"apiDurationMs\":11,\"modelUsage\":{\"grok-code-fast-1\":{\"inputTokens\":1,\"outputTokens\":1,\"totalTokens\":2,\"cachedReadTokens\":0,\"cacheCreationTokens\":0,\"reasoningTokens\":0,\"modelCalls\":1,\"apiDurationMs\":11}},\"numTurns\":1},\"elapsed_ms\":96},\"_meta\":{\"eventId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923-9\",\"agentTimestampMs\":1792220407263}}}\n{\"timestamp\":1792220407,\"method\":\"_x.ai/session/update\",\"params\":{\"sessionId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"update\":{\"sessionUpdate\":\"hook_execution\",\"event_name\":\"session_end\",\"runs\":[{\"name\":\"global/agent-board:session_end[0].hooks[0]\",\"status\":{\"status\":\"success\",\"elapsed_ms\":11}}]},\"_meta\":{\"eventId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923-10\",\"agentTimestampMs\":1792220407290}}}\n{\"timestamp\":1792220407,\"method\":\"_x.ai/session/update\",\"params\":{\"sessionId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923\",\"update\":{\"sessionUpdate\":\"hook_execution\",\"event_name\":\"stop\",\"runs\":[{\"name\":\"global/agent-board:stop[0].hooks[0]\",\"status\":{\"status\":\"success\",\"elapsed_ms\":12}}]},\"_meta\":{\"eventId\":\"01a148a9-24e5-7ff2-8b96-237d7daf0923-11\",\"agentTimestampMs\":1792220407306}}}\n"
const OPENCLAW_TURN = "{\"session_id\":\"174e82e2-caf4-4bf7-ab73-ae4a2c9c1b31\",\"cwd\":\"/home/me/.openclaw/workspace\",\"prompt\":\"Add rate limiting to the API\",\"last_assistant_message\":\"Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?\"}"
const RATE_LIMIT = 'TITLE: Rate-limit the public endpoints\nCONTEXT: Keep the public API up under abuse\nDONE: Added the token bucket middleware\nNEXT: -\nASK: Per-key limit — 100 or 300 a minute?'

// Runs a session over these inbox files and hands back the file and what the model was asked.
const takeInbox = async ($: Engine, on: On, files: Array<[string, string]>) => {
  const asked: string[] = []
  const world: World = {
    files: new Map([[FILE, '# Progress\n'], ...files]),
    mtime: 1,
    hasTasks: true,
    reply: (prompt: string) => {
      asked.push(prompt)
      return prompt.includes('TITLE:') ? RATE_LIMIT : undefined
    },
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  return { text: world.files.get(FILE) ?? '', asked }
}

// Cursor's afterAgentResponse and Muse's Stop, with the fields readTurn takes from them.
const CURSOR_TURN = JSON.stringify({ conversation_id: '5d0c9b7e-31a4-4f0e-9d62-7c1e8f2a4b90', generation_id: 'f3a1c2d4-0b5e-4c6f-8a7d-9e0f1a2b3c4d', hook_event_name: 'afterAgentResponse', workspace_roots: ['/home/me/work/api-gateway'], text: 'Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?' })
const MUSE_TURN = JSON.stringify({ session_id: 'c81f2e64-7a3b-4d95-b0e2-5f6a7b8c9d01', cwd: '/home/me/work/api-gateway', hook_event_name: 'Stop', last_assistant_message: 'Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?' })
// The same session's next turn, after the person answered.
const NEXT_TURN = (turn: string): string =>
  turn.replaceAll('Added the token bucket middleware. Should the per-key limit be 100 or 300 a minute?', 'Set the per-key limit to 300 a minute.').replace(/Add rate limiting to (?:the public endpoints|the API)/g, '300 a minute')
const SETTLED = 'TITLE: Rate-limit the public endpoints\nCONTEXT: Keep the public API up under abuse\nDONE: Set the per-key limit to 300 a minute\nNEXT: -\nASK: -'
const AGENT_TURNS = [
  ['codex', CODEX_STOP],
  ['gemini', GEMINI_TURN],
  ['cursor', CURSOR_TURN],
  ['grok', GROK_STOP],
  ['muse', MUSE_TURN],
  ['hermes', HERMES_TURN],
  ['openclaw', OPENCLAW_TURN],
  ['opencode', OPENCODE_TURN],
] as const

const RATE_LIMIT_REPLY = (prompt: string): string | undefined => (prompt.includes('TITLE:') ? RATE_LIMIT : undefined)

const takenOf = (world: World): string[] => [...world.files.keys()].filter(path => path.endsWith('.taking'))
const expireTaken = (world: World): void => {
  const at = world.at ?? Date.parse('2026-10-16T12:00:00Z')
  for (const path of takenOf(world)) {
    const expired = path.replace(/\.[^/.]+\.taking$/, `.deadbeef-${(at - 16 * 60 * 1000).toString(36)}-1.taking`)
    world.files.set(expired, world.files.get(path)!)
    world.files.delete(path)
  }
}

// Every agent the plugin connects, installed: Codex, Cursor, Grok Build, Gemini CLI with
// Antigravity beside it, OpenCode, Muse Code, Hermes Agent and OpenClaw.
const EVERY_AGENT: [string, string][] = [
  ['/home/me/.codex/config.toml', ''],
  ['/home/me/.cursor/hooks.json', '{}'],
  ['/home/me/.grok/config.toml', ''],
  ['/home/me/.gemini/settings.json', '{}'],
  ['/home/me/.gemini/antigravity/config.json', '{}'],
  ['/home/me/.config/opencode/opencode.json', '{}'],
  ['/home/me/.config/muse/settings.json', '{}'],
  ['/home/me/.hermes/config.yaml', ''],
  ['/home/me/.openclaw/openclaw.json', '{}'],
]
const BOARD_SCRIPT_FILE = '/home/me/.claude/agent-board.mjs'
const REPORTER_FILE = '/home/me/.claude/progress-report.sh'
const BOARD_FILES = [
  '/home/me/.agents/skills/agent-board/SKILL.md',
  '/home/me/.gemini/commands/board.toml',
  '/home/me/.config/opencode/commands/board.md',
  '/home/me/.hermes/skills/agent-board/SKILL.md',
  '/home/me/.gemini/config/skills/agent-board/SKILL.md',
]
// What an earlier release wrote (tests/fixtures/released.ts), with this machine's paths.
const here = (text: string): string => text.split(RELEASE_PATHS.board).join(CONNECT.board).split(RELEASE_PATHS.inbox).join(CONNECT.inbox)
const releasedBoard = (text: string): string => `globalThis.AGENT_BOARD = ${JSON.stringify({ path: '/home/me/.claude/progress.md', lang: 'zh-TW' })}\n${text}`
// The agents' files, the board script and the reporter: everything a connect writes.
const agentFiles = (world: World): Map<string, string> => new Map([...world.files].filter(([file]) => !file.startsWith('/home/me/.agent-board/') && (file === REPORTER_FILE || !file.startsWith('/home/me/.claude/progress'))))
// The plugin connects every agent; then `put` turns the files back into an earlier release's
// and the record of what was written is forgotten, as before the plugin kept one. Returns
// what this version wrote, and how many notices the first connect gave.
const fromEarlierRelease = async ($: Engine, on: On, put: (world: World, written: Map<string, string>) => void) => {
  const shared: Record<string, unknown> = { inboxDone: {} }
  const world: World = { files: new Map(EVERY_AGENT), mtime: 1, hasTasks: true, shared, ran: [] }
  engineBeneath(on, world)
  const seen = outside(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  const written = agentFiles(world)
  for (const file of [BOARD_SCRIPT_FILE, REPORTER_FILE, ...BOARD_FILES]) expect(written.has(file)).toBe(true)
  put(world, written)
  for (const key of Object.keys(shared)) if (key.startsWith('generated:')) delete shared[key]
  const before = seen.notified.length
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await settledSetup($, world)
  return { world, shared, written, notices: seen.notified.slice(before) }
}

const stoppedPaneBoard = (count: number, at: number): string => '## Synthetic\n' + Array.from({ length: count }, (_, index) => {
  const session = (0x40000000 + index).toString(16)
  return `<!-- auto session=${session} agent=codex state=ended updated=${new Date(at - 13 * 3600000).toISOString()} -->\n### Plan ${index}\n- [?] Synthetic question ${index}, OK?\n<!-- /auto session=${session} -->\n`
}).join('\n')

export {
  AGENT_TURNS,
  ANSWERED,
  ARCHIVE,
  ASKED,
  BACKGROUND_MESSAGES,
  BOARD_FILES,
  BOARD_SCRIPT_FILE,
  CLAIM_MS,
  CODEX_END,
  CODEX_ROLLOUT,
  CODEX_STOP,
  CONNECT,
  CONNECT_BOOTSTRAP,
  CONNECT_EXECUTE,
  CURSOR_TURN,
  DIGEST,
  DUE,
  EDITED,
  EN,
  ENGINE_CELLS,
  ENGINE_GROUPS,
  ENGINE_MATRIX,
  EVERY_AGENT,
  FAILING_MATRIX_TITLE,
  FILE,
  GEMINI_END,
  GEMINI_TURN,
  GROK_END,
  GROK_SHUTDOWN,
  GROK_STOP,
  GROK_UPDATES,
  HERMES_TURN,
  IDLE_MS,
  INBOX,
  INBOX_ASK,
  JOBS,
  JOURNAL,
  LEDGER_LINK,
  LINK_EXISTS,
  LINK_KEPT_SOURCE,
  LINK_UNSUPPORTED,
  LIVE_PRESS,
  LIVE_PRESS_KEY,
  LIVE_SCRIPT,
  MATRIX_AGENTS,
  MATRIX_AT,
  MATRIX_KINDS,
  MATRIX_OPEN,
  MUSE_TURN,
  NEXT_TURN,
  NODE_MIN,
  NORMAL_MATRIX_TITLE,
  OLDER_SHOWN,
  OLD_DONE,
  OPENCLAW_TURN,
  OPENCODE_TURN,
  PANE,
  PANE_ASK_VARIANTS,
  PANE_MATRIX,
  PROBE_BODY,
  PROBE_NAME,
  PROBE_REPLY,
  PROMPT_AT,
  PROMPT_ID,
  PROMPT_SESSION,
  PROPS,
  QUESTIONS,
  QUESTION_TEXT,
  QUESTION_TURN,
  RATE_LIMIT,
  RATE_LIMIT_REPLY,
  RELEASE_0_18_1,
  RELEASE_0_20_5,
  RELEASE_PATHS,
  REPORTER_FILE,
  SESSION,
  SETTLED,
  STRINGS,
  SWEEP_ARMED_KEY,
  TIDY,
  ZH_CN,
  ZH_TW,
  addPrompt,
  agentFiles,
  agentHooks,
  answerAgentPrompt,
  applyDigest,
  applyTaskCreate,
  applyTaskUpdate,
  automaticSetup,
  beneathButton,
  besideButton,
  besideLabel,
  blockId,
  boardScript,
  breakQuestionFile,
  buildView,
  chatText,
  completionKey,
  completionOverlay,
  confirmStep,
  connectDataRoots,
  controlFile,
  dashboardHtml,
  doneKey,
  effectivePromptMirror,
  emptyMirror,
  emptyQuestions,
  engineBeneath,
  engineMatrixSummary,
  engineMatrixTest,
  expect,
  expireTaken,
  fromEarlierRelease,
  grokHook,
  hasOwnConnectData,
  here,
  idleFiles,
  inNeeds,
  installedBoard,
  isInboxFile,
  isNodeSupported,
  isSetupState,
  launchBackground,
  memoryConnect,
  migrationKey,
  mock,
  namedEngineMatrixTest,
  nativeState,
  observeQuestions,
  openclawPlugin,
  outside,
  paletteFor,
  paneEngineFixture,
  paneMatrixGroup,
  parseProgress,
  parseSeen,
  peekInbox,
  pendingQuestionEntries,
  pendingQuestionWorld,
  pluginTest,
  posix,
  pressChildren,
  pressNodes,
  pressTarget,
  pressTexts,
  probeStart,
  probeWorld,
  questionProofPath,
  questionWorld,
  questionsJson,
  relativeTime,
  releasedBoard,
  resultAfterControl,
  say,
  seedPendingQuestion,
  seenJson,
  seenPath,
  settledSetup,
  sha256,
  start,
  startBackgroundJob,
  stoppedPaneBoard,
  storedQuestion,
  takeInbox,
  takenName,
  takenOf,
  test,
  upsertAutoBlock,
  withAgentPrompts,
  withSeen,
  workerStageSequence,
}

export type {
  ConnectState,
  Engine,
  EngineMatrixCase,
  LegacyConnectRequest,
  MatrixCell,
  MatrixFixture,
  MatrixKind,
  MatrixSource,
  MockClock,
  On,
  PressNode,
  ProgressMirror,
  ProgressMirrorTask,
  PromptOrigin,
  RenderPropsOf,
  TaskRow,
  TestBody,
  TestConfig,
  View,
  World,
}

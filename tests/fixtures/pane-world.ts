import type { On, RenderPropsOf } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import { CONNECT_BOOTSTRAP, CONNECT_EXECUTE } from '../../hooks/connect-worker'
import { LEDGER_LINK, LINK_EXISTS, LINK_KEPT_SOURCE, LINK_UNSUPPORTED } from '../../hooks/ledger-move'
import { memoryConnect } from './connect-memory'
import type { LegacyConnectRequest } from '../../scripts/connect-transaction'

export { PANE_MS } from '../e2e/lib/budget'

export const visiblePaneText = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(visiblePaneText).join(' ')
  if (node === null || typeof node !== 'object') return ''
  const element = node as { type?: string; props?: { label?: string }; children?: unknown[] }
  return [element.type === 'Button' || element.type === 'Link' ? element.props?.label ?? '' : '', ...(element.children ?? []).map(visiblePaneText)].join(' ')
}

export const FILE = '/home/me/.claude/progress.md'
export const INBOX = '/home/me/.claude/progress-inbox'
const SESSION = '2be48af2-6193-5040-aacc-e0546d6784f1'
export const PANE = { plugin: 'agent-board', component: 'Pane', requestId: 'agent-board' } as const

export const PROPS: RenderPropsOf['Pane'] = {
  title: '進度',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

export type World = {
  files: Map<string, string>
  dirs?: Set<string>
  unlistable?: Set<string>
  mtime: number
  hasTasks: boolean
  isArchiveClockOnly?: boolean
  at?: number
  clockOffset?: number
  isInboxClockOnly?: boolean
  inboxLookMs?: number
  completeDelayMs?: number
  completeDue?: (at: number) => void
  env?: Record<string, string>
  stats?: string[]
  reads?: string[]
  // Every file call, as `<call> <path>`: stat, exists, list, read and write.
  fileOps?: string[]
  // A read of a path it gives a promise for waits on that promise, then answers with the text the
  // file held when it was asked: a promise that never settles is a drive that went away.
  holdRead?: (path: string) => Promise<unknown> | undefined
  written?: string[]
  beforeRead?: (path: string) => void
  pauseRead?: { when: (path: string) => boolean; reached: () => void; release: Promise<void> }
  readValue?: (path: string) => unknown
  beforeExists?: (path: string) => void
  mtimes?: Record<string, number>
  unreadable?: Set<string>
  hold?: { reached: () => void; release: Promise<void> }
  store?: Record<string, unknown>
  storeReads?: string[]
  shared?: Record<string, unknown>
  ran?: string[][]
  named?: string
  reply?: (prompt: string) => string | undefined
  messages?: Array<{ role: 'user' | 'assistant'; text: string; toolUses: Array<{ tool_use_id: string; tool: string; input: Record<string, unknown> }> }>
  gh?: () => { exitCode: number; stdout: string; stderr: string }
  isMoveRefused?: (path: string) => boolean
  isRemoveRefused?: (path: string) => boolean
  missingRemoveExitCode?: number
  failNextRemove?: boolean
  hang?: (prompt: string) => boolean
  holdComplete?: { reached: () => void; release: Promise<void> }
  asked?: string[]
  appended?: unknown[]
  afterWrite?: () => string
  afterJournalWrite?: () => void
  holdJournalRead?: { reached: () => void; release: Promise<void> }
  openclaw?: string
  node?: string | null
  nodeGate?: { reached: () => void; release: Promise<void> }
  workerFailure?: string
  bootstrapFailure?: boolean
  setupDone?: Promise<void>
  finishSetup?: () => void
  unwritable?: Set<string>
  ignoreQuestionWrites?: boolean
  failQuestionCapture?: 'read' | 'write'
  failStore?: (operation: 'get' | 'set', key: string) => boolean
  beforeStoreGet?: (key: string) => void | Promise<void>
  beforeStoreSet?: (key: string) => void
  afterStoreSet?: (key: string, value: unknown) => void
  ignoreStore?: (key: string) => boolean
  afterMove?: (from: string, to: string) => boolean
  unremovable?: Set<string>
  retainedOnRemove?: Set<string>
  rejectedOnRemove?: Set<string>
}

export const makeWorld = (files: Array<[string, string]> = []): World => ({
  files: new Map(files),
  mtime: 1,
  hasTasks: true,
  store: { inboxDone: {}, autoConnectOff: true },
})

const posix = (path: string): string => path.replace(/^[A-Za-z]:\\/, '/').replace(/\\/g, '/')
let workerStageSequence = 0

export const engineBeneath = (on: On, world: World): MockClock => {
  let modelNow = world.at ?? Date.parse('2026-10-16T12:00:00.000Z')
  const delayed: Array<{ at: number; finish: () => void }> = []
  if (world.completeDelayMs !== undefined) world.completeDue = at => {
    for (const one of delayed.filter(one => one.at <= at)) {
      delayed.splice(delayed.indexOf(one), 1)
      one.finish()
    }
  }
  const files = world.files
  Object.defineProperty(files, 'set', { configurable: true, writable: true, value: (path: string, text: string) => {
    Map.prototype.set.call(files, path, text)
    if (path !== FILE) (world.mtimes ??= {})[path] = Math.max(world.mtimes?.[path] ?? world.mtime, world.mtime) + 1
    return files
  } })
  world.setupDone = new Promise<void>(done => { world.finishSetup = done })
  const clockOn = world.isArchiveClockOnly || world.isInboxClockOnly || world.completeDelayMs !== undefined || world.clockOffset !== undefined ? ((...args: Parameters<On>) => {
    const callback = args.at(-1)
    if (typeof callback !== 'function') throw new Error('Invalid clock fixture')
    // Move the claim clock without running fifteen minutes of unrelated timers.
    if (args[0] === 'clock.now' && (world.clockOffset !== undefined || world.completeDelayMs !== undefined)) return on('clock.now', async ($, event, next) => {
      const result = await Reflect.apply(callback, undefined, [$, event, next])
      modelNow = result.value + (world.clockOffset ?? 0)
      return { ...result, value: modelNow }
    })
    // An answer at the deadline wins the tie in delayed-answer tests.
    if (args[0] === 'clock.after' && world.completeDelayMs !== undefined) return on('clock.after', ($, event, next) => Reflect.apply(callback, undefined, [$, { ...event, ms: event.ms === world.completeDelayMs ? event.ms + 1 : event.ms }, next]))
    if (args[0] === 'clock.every' && world.isInboxClockOnly) return on('clock.every', ($, event, next) => Reflect.apply(callback, undefined, [$, { ...event, ms: event.ms === 5000 ? world.inboxLookMs ?? 5000 : 24 * 60 * 60 * 1000 }, next]))
    if (args[0] !== 'clock.every' || !world.isArchiveClockOnly) return Reflect.apply(on, undefined, args)
    return on('clock.every', ($, event, next) => Reflect.apply(callback, undefined, [$, { ...event, ms: event.ms === 3600000 ? event.ms : 7200000 }, next]))
  }) as On : on
  const clock = mock.clock(clockOn, { now: world.at ?? Date.parse('2026-10-16T12:00:00.000Z') })
  mock.env(on, world.env ?? { HOME: '/home/me', LANG: 'zh_TW.UTF-8' })
  const shared = world.shared
  if (shared === undefined) {
    const store: Record<string, unknown> = world.store ?? { inboxDone: {} }
    on('store.get', async ($, e) => {
      world.storeReads?.push(e.key)
      const pending = world.beforeStoreGet?.(e.key)
      const value = store[e.key]
      await pending
      return world.failStore?.('get', e.key) ? { deny: 'EIO' } : { value }
    })
    on('store.set', ($, e) => {
      world.beforeStoreSet?.(e.key)
      if (world.failStore?.('set', e.key)) return { deny: 'EIO' }
      if (world.ignoreStore?.(e.key)) return { value: undefined }
      store[e.key] = e.value
      world.afterStoreSet?.(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', ($, e) => { delete store[e.key]; return { value: undefined } })
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
    world.setupDone = new Promise<void>(done => { world.finishSetup = done })
    return { cwd: e.cwd }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: '/work/persona_framework' }))
  on('session.repo', () => ({
    value: {
      root: '/work/persona_framework',
      remote: 'https://github.com/jhk482001/persona_framework.git',
      internal: false,
      name: null,
    },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('tool.list', () => ({
    value: world.hasTasks ? [{ name: 'TaskCreate', description: '', mcp: false }] : [{ name: 'Read', description: '', mcp: false }],
  }))
  on('process.run', async ($, e) => {
    // The pane's hard-link ledger move acts on the files in memory as the real Node child would.
    if (e.argv[0] === 'node' && e.argv[2] === LEDGER_LINK && e.argv[3] === '--') {
      world.ran?.push([...e.argv])
      const from = posix(e.argv[4] ?? '')
      const to = posix(e.argv[5] ?? '')
      const text = world.files.get(from)
      let exitCode = 0
      if (world.node === null) exitCode = 127
      else if (text === undefined || world.isMoveRefused?.(from) === true || world.unwritable?.has(to) === true) exitCode = LINK_UNSUPPORTED
      else if (world.files.has(to)) exitCode = LINK_EXISTS
      else if (world.ignoreQuestionWrites && to.endsWith('-questions.json')) world.files.delete(from)
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
    // PowerShell's Remove-Item over a list of paths: with -ErrorAction Stop the first path that is
    // not there ends the command (exit 1) and the paths after it stay; otherwise it goes on.
    if (e.argv[0] === 'powershell' && /^Remove-Item /.test(e.argv[3] ?? '')) {
      world.ran?.push([...e.argv])
      const command = e.argv[3] ?? ''
      const paths = [...command.matchAll(/'((?:[^']|'')*)'/g)].map(found => posix((found[1] ?? '').replace(/''/g, "'")))
      const isStop = command.includes('-ErrorAction Stop')
      let exitCode = 0
      for (const path of paths) {
        if (!world.files.has(path)) {
          if (!isStop) {
            exitCode = world.missingRemoveExitCode ?? exitCode
            continue
          }
          exitCode = 1
          break
        }
        if (world.unremovable?.has(path)) {
          if (isStop) {
            exitCode = 1
            break
          }
        } else if (!world.retainedOnRemove?.has(path) && world.isRemoveRefused?.(path) !== true) world.files.delete(path)
      }
      return { value: { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'Cannot find path', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'mv' || e.argv[0] === 'rm') {
      world.ran?.push([...e.argv])
      if (e.argv[0] === 'rm' && world.failNextRemove) {
        world.failNextRemove = false
        return { value: { exitCode: 1, stdout: '', stderr: 'EACCES', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      let exitCode = 0
      if (e.argv[0] === 'mv') {
        const rest = e.argv.slice(e.argv[1] === '-n' || e.argv[1] === '-f' ? 2 : 1)
        const from = posix(rest[0] ?? '')
        const to = posix(rest[1] ?? '')
        const text = world.files.get(from)
        if (text === undefined || world.isMoveRefused?.(from) === true || world.unwritable?.has(to) === true) exitCode = 1
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
  on('session.messages', () => ({ value: world.messages ?? [] }))
  on('session.append', ($, e, next) => {
    world.appended?.push(e)
    return next(e)
  })
  const answerOf = (prompt: string) => ({
    value: {
      isAnswered: true as const,
      text: world.reply?.(prompt) ?? world.named ?? '這是正在做的進度面板。',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
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
    if (world.completeDelayMs !== undefined) return new Promise(resolve => {
      delayed.push({ at: modelNow + world.completeDelayMs!, finish: () => resolve(answerOf(prompt)) })
    })
    return world.hang?.(prompt) === true ? new Promise<never>(() => undefined) : answerOf(prompt)
  })
  on('fs.stat', ($, e) => {
    world.stats?.push(e.path)
    world.fileOps?.push(`stat ${posix(e.path)}`)
    const path = posix(e.path)
    const text = world.files.get(path)
    const isDir = [...world.files.keys()].some(file => file.startsWith(`${path}/`))
    const mtimeMs = path === FILE ? world.mtime : world.mtimes?.[path] ?? world.mtime
    if (text === undefined && isDir) return { value: { kind: 'dir' as const, size: 0, mtimeMs, isLink: false } }
    return text === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file' as const, size: text.length, mtimeMs, isLink: false } }
  })
  on('fs.exists', ($, e) => {
    world.fileOps?.push(`exists ${posix(e.path)}`)
    world.beforeExists?.(posix(e.path))
    return { value: world.dirs?.has(posix(e.path)) || world.files.has(posix(e.path)) || [...world.files.keys()].some(path => path.startsWith(`${posix(e.path)}/`)) }
  })
  on('fs.list', ($, e) => {
    world.fileOps?.push(`list ${posix(e.path ?? '')}`)
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
    world.fileOps?.push(`read ${path}`)
    const held = world.holdRead?.(path)
    if (held !== undefined) {
      const asked = world.files.get(path)
      await held
      return asked === undefined ? { deny: 'ENOENT' } : { value: asked }
    }
    world.beforeRead?.(path)
    const paused = world.pauseRead
    if (paused !== undefined && paused.when(path)) {
      world.pauseRead = undefined
      paused.reached()
      await paused.release
    }
    const hold = world.holdJournalRead
    if (path.includes('-journal-') && hold !== undefined) {
      world.holdJournalRead = undefined
      hold.reached()
      await hold.release
      return { deny: 'EIO' }
    }
    const text = world.files.get(path)
    if (world.unreadable?.has(path) || (world.failQuestionCapture === 'read' && path.includes('-questions-source-'))) return { deny: 'EFBIG' }
    if (world.readValue !== undefined && path.endsWith('.taking')) return { value: world.readValue(path) as string }
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', async ($, e) => {
    const path = posix(e.path)
    world.written?.push(path)
    world.fileOps?.push(`write ${path}`)
    if (world.unwritable?.has(path) || (world.failQuestionCapture === 'write' && path.includes('-questions-source-'))) return { deny: 'EACCES' }
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
  let nextId = 0
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => {
    nextId += 1
    return { result: { task: { id: String(nextId), subject: e.subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({
    result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
  }))

  return clock
}

export const start = async ($: Engine, text: string): Promise<void> => {
  await $.session.start({ cwd: '/work/persona_framework', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text, turnId: 't1' })
}

export const knownFailure = async (issue: number | `hold:${string}`, fn: () => unknown | Promise<unknown>): Promise<void> => {
  const label = typeof issue === 'number' ? `#${issue}` : issue
  try {
    await fn()
  } catch (error) {
    console.log(`known failure ${label}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const call = typeof issue === 'number' ? `knownFailure(${issue})` : `knownFailure('${issue}')`
  throw new Error(`${label} looks fixed: remove ${call} from this test`)
}

export const noSilentPress = ({
  surface,
  card,
  button,
  before,
  after,
}: {
  surface: string
  card: string
  button: string
  before: string
  after: string
}): void => {
  if (after === before) throw new Error(`pressed ${button} on ${card} on ${surface}: nothing happened`)
}

export const noMachineIds = (text: string, world: World, allow: readonly string[] = []): void => {
  let visible = text
  for (const value of allow) visible = visible.split(value).join('')
  const file = world.files.get(FILE) ?? ''
  const ids = [...file.matchAll(/\b(?:session|resume)=([^\s>]+)/g)].map(match => match[1] ?? '')
  for (const value of ids) {
    if (value !== '' && visible.includes(value)) throw new Error(`Machine id exposed: ${value}`)
  }
  if (/\b[\da-f]{8}\b|\b[\da-f]{40}\b|\b[\da-f]{64}\b|(?<![A-Za-z])[A-Za-z]:[\\/]|\/home\/|\/Users\//i.test(visible)) {
    throw new Error(`Machine id/path exposed: ${visible}`)
  }
}

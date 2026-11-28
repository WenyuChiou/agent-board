import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { registerHooks, createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleFromDir } from '../scripts/bundle-text.mjs'

const importTs = async path => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  try { return await import(path) } finally { resolver.deregister() }
}

const fixture = async fn => {
  const home = mkdtempSync(join(tmpdir(), 'agent-board-deepseek-'))
  const root = join(home, 'repo')
  const save = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text) }
  try {
    return await fn({ home, root, save })
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
}

test('deepseekLocalPlugin holds delivery when a root becomes busy during take and delivers at the next idle (#1198)', () => fixture(async f => {
  const portable = await importTs('../hooks/portable-agents.ts')
  const { defaultMessagesDirectory } = await importTs('../scripts/runtime-folder.ts')
  const { enrollMailbox, mailboxId } = await importTs('../hooks/hook-messages.ts')
  const { queueMessage } = await importTs('../hooks/messaging.ts')
  const board = join(f.home, 'deepseek-board.mjs')
  f.save(board, bundleFromDir(new URL('..', import.meta.url)))
  const progress = join(f.home, 'deepseek-progress.md')
  f.save(progress, '')
  const directory = defaultMessagesDirectory(progress, f.home, process.env, process.platform)
  const file = join(directory, 'messages.json')
  const store = () => JSON.parse(readFileSync(file, 'utf8'))
  const status = id => store().messages.find(one => one.id === id)?.status
  const queue = (state, session, id, text) => {
    const now = Date.now()
    const enrolled = enrollMailbox(state, 'deepseek', session, 'dsh', now, 43_200_000)
    const target = enrolled.mailboxes.find(one => one.id === mailboxId('deepseek', session))
    f.save(file, JSON.stringify({ version: 2, ...queueMessage(enrolled, { id, target: target.id, turn: 'session', text }, 'board', target, now).state }))
  }
  queue({ messages: [] }, 'deepseek-busy-session', 'busy-message-1', 'Synthetic answer for busy root')

  const children = []
  let onTakeSpawn = null
  const spawnMailbox = (...args) => {
    const child = spawn(...args)
    children.push(child)
    child.on('close', () => { child.isClosed = true })
    if (args[1]?.includes('take') && onTakeSpawn) onTakeSpawn(child)
    return child
  }
  const settled = () => children.every(child => child.isClosed)
  const until = async (check, label) => {
    for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(done => setTimeout(done, 50))) if (check()) return
    assert.fail(label)
  }
  const source = portable.deepseekLocalPlugin(process.execPath, join(f.root, 'agent-board-hook.mjs'), progress, f.home, board)
  const names = ['createRequire', 'spawnSync', 'spawn', 'spawnMailbox', 'randomUUID', 'readFileSync', 'existsSync', 'watch', 'join']
  const { apply } = new Function(...names, `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace(/^export /gm, '')}\nreturn { apply }`)(createRequire, () => ({ status: 0, stdout: '', stderr: '' }), () => { throw new Error('UNUSED') }, spawnMailbox, randomUUID, readFileSync, existsSync, watch, join)
  const fake = (id, header = {}) => {
    const agent = { session: { header: { id, ...header } }, status: 'idle', received: [], followup(message) { agent.received.push(message); agent.status = 'running' } }
    return agent
  }
  const root = fake('deepseek-busy-session')
  const hooks = new Map()
  const plugin = { on: (event, handler) => hooks.set(event, handler) }

  try {
    // When take spawns, simulate the session starting a turn (becoming busy).
    onTakeSpawn = () => { root.status = 'running' }
    apply(plugin)
    hooks.get('agent/created')({ agent: root })
    await until(settled, 'the take call finished while root was running')
    // Delivery was held: followup was not called, message was not accepted.
    assert.equal(root.received.length, 0)
    assert.notEqual(status('busy-message-1'), 'accepted')

    // Next idle handoff delivers the held message.
    onTakeSpawn = null
    root.status = 'idle'
    hooks.get('agent/status')({ agent: root, status: 'idle' })
    await until(() => status('busy-message-1') === 'accepted' && settled(), 'the message was accepted after root returned to idle')
    assert.equal(root.received.length, 1)
    assert.match(root.received[0].content[0].text, /Synthetic answer for busy root/)
    assert.equal(status('busy-message-1'), 'accepted')

    hooks.get('agent/disposed')({ agent: root })
    await until(settled, 'the session disposed cleanly')
  } finally {
    for (const child of children) if (!child.isClosed) child.kill()
    for (const end = Date.now() + 10_000; !settled() && Date.now() < end;) await new Promise(done => setTimeout(done, 50))
  }
}))

test('deepseekLocalPlugin drops stashed message when dismissed while busy and does not followup (#1198)', () => fixture(async f => {
  const portable = await importTs('../hooks/portable-agents.ts')
  const { defaultMessagesDirectory } = await importTs('../scripts/runtime-folder.ts')
  const { enrollMailbox, mailboxId } = await importTs('../hooks/hook-messages.ts')
  const { dismissMessage, queueMessage } = await importTs('../hooks/messaging.ts')
  const board = join(f.home, 'deepseek-board.mjs')
  f.save(board, bundleFromDir(new URL('..', import.meta.url)))
  const progress = join(f.home, 'deepseek-progress.md')
  f.save(progress, '')
  const directory = defaultMessagesDirectory(progress, f.home, process.env, process.platform)
  const file = join(directory, 'messages.json')
  const store = () => JSON.parse(readFileSync(file, 'utf8'))
  const status = id => store().messages.find(one => one.id === id)?.status
  const queue = (state, session, id, text) => {
    const now = Date.now()
    const enrolled = enrollMailbox(state, 'deepseek', session, 'dsh', now, 43_200_000)
    const target = enrolled.mailboxes.find(one => one.id === mailboxId('deepseek', session))
    f.save(file, JSON.stringify({ version: 2, ...queueMessage(enrolled, { id, target: target.id, turn: 'session', text }, 'board', target, now).state }))
  }
  queue({ messages: [] }, 'deepseek-dismiss-session', 'dismiss-message-1', 'Synthetic dismissed text')

  const children = []
  let onTakeSpawn = null
  const spawnMailbox = (...args) => {
    const child = spawn(...args)
    children.push(child)
    child.on('close', () => { child.isClosed = true })
    if (args[1]?.includes('take') && onTakeSpawn) onTakeSpawn(child)
    return child
  }
  const settled = () => children.every(child => child.isClosed)
  const until = async (check, label) => {
    for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(done => setTimeout(done, 50))) if (check()) return
    assert.fail(label)
  }
  const source = portable.deepseekLocalPlugin(process.execPath, join(f.root, 'agent-board-hook.mjs'), progress, f.home, board)
  const names = ['createRequire', 'spawnSync', 'spawn', 'spawnMailbox', 'randomUUID', 'readFileSync', 'existsSync', 'watch', 'join']
  const { apply } = new Function(...names, `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace(/^export /gm, '')}\nreturn { apply }`)(createRequire, () => ({ status: 0, stdout: '', stderr: '' }), () => { throw new Error('UNUSED') }, spawnMailbox, randomUUID, readFileSync, existsSync, watch, join)
  const fake = (id, header = {}) => {
    const agent = { session: { header: { id, ...header } }, status: 'idle', received: [], followup(message) { agent.received.push(message); agent.status = 'running' } }
    return agent
  }
  const root = fake('deepseek-dismiss-session')
  const hooks = new Map()
  const plugin = { on: (event, handler) => hooks.set(event, handler) }

  try {
    // When take spawns, root becomes running.
    onTakeSpawn = () => { root.status = 'running' }
    apply(plugin)
    hooks.get('agent/created')({ agent: root })
    await until(settled, 'the take call finished while root was running')
    assert.equal(root.received.length, 0)

    // User dismisses the message while root is still busy.
    const current = store()
    f.save(file, JSON.stringify(dismissMessage(current, 'dismiss-message-1', Date.now())))

    // Root returns to idle.
    onTakeSpawn = null
    root.status = 'idle'
    hooks.get('agent/status')({ agent: root, status: 'idle' })
    await new Promise(done => setTimeout(done, 300))

    // Message must be dropped: no followup was given, and no acceptance was recorded.
    assert.equal(root.received.length, 0)
    assert.notEqual(status('dismiss-message-1'), 'accepted')

    hooks.get('agent/disposed')({ agent: root })
    await until(settled, 'the session disposed cleanly')
  } finally {
    for (const child of children) if (!child.isClosed) child.kill()
    for (const end = Date.now() + 10_000; !settled() && Date.now() < end;) await new Promise(done => setTimeout(done, 50))
  }
}))

test('the DeepSeek receiver stops watching the board folder once it is removed, so its host is not kept busy', () => fixture(async f => {
  const portable = await importTs('../hooks/portable-agents.ts')
  const directory = join(f.home, 'board-messages')
  const board = join(f.home, 'board.mjs')
  mkdirSync(directory)
  f.save(board, `process.stdout.write(JSON.stringify({ watch: ${JSON.stringify(directory)}, message: null }))`)
  const children = []
  const watchers = []
  const spawnMailbox = (...args) => {
    const child = spawn(...args)
    children.push(child)
    child.on('close', () => { child.isClosed = true })
    return child
  }
  const watchBoard = (...args) => {
    const current = watch(...args)
    current.on('close', () => { current.isClosed = true })
    watchers.push(current)
    return current
  }
  const until = async (check, label) => {
    for (const end = Date.now() + 2000; Date.now() < end; await new Promise(done => setTimeout(done, 20))) if (check()) return
    assert.fail(label)
  }
  const source = portable.deepseekLocalPlugin(process.execPath, join(f.root, 'hook.mjs'), join(f.home, 'progress.md'), f.home, board)
  const names = ['createRequire', 'spawnSync', 'spawn', 'spawnMailbox', 'randomUUID', 'readFileSync', 'existsSync', 'watch', 'join']
  const { apply } = new Function(...names, `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace(/^export /gm, '')}\nreturn { apply }`)(createRequire, () => ({ status: 0, stdout: '', stderr: '' }), () => { throw new Error('UNUSED') }, spawnMailbox, randomUUID, readFileSync, existsSync, watchBoard, join)
  const root = { session: { header: { id: 'deepseek-removed-session' } }, status: 'idle', followup() {} }
  const hooks = new Map()
  apply({ on: (event, handler) => hooks.set(event, handler) })
  try {
    hooks.get('agent/created')({ agent: root })
    await until(() => watchers.length === 1, 'the board folder was watched')
    assert.notEqual(watchers[0].isClosed, true)
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
    await until(() => watchers[0].isClosed === true, 'the watcher of the removed board folder was closed')
  } finally {
    hooks.get('agent/disposed')({ agent: root })
    for (const current of watchers) current.close()
    for (const child of children) if (!child.isClosed) child.kill()
    for (const end = Date.now() + 2000; children.some(child => !child.isClosed) && Date.now() < end;) await new Promise(done => setTimeout(done, 20))
  }
}))

test('a late DeepSeek watcher event or error cannot close its replacement', () => fixture(async f => {
  const portable = await importTs('../hooks/portable-agents.ts')
  const first = join(f.home, 'first')
  const second = join(f.home, 'second')
  mkdirSync(first)
  mkdirSync(second)
  const watchers = []
  let takes = 0
  const spawnMailbox = (_node, args) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.kill = () => {}
    const directory = args[2] === 'take' && ++takes === 1 ? first : second
    setImmediate(() => {
      child.stdout.end(JSON.stringify({ watch: directory, message: null }))
      child.emit('close', 0)
    })
    return child
  }
  const watchBoard = (_directory, _options, listener) => {
    const current = new EventEmitter()
    current.on('change', listener)
    current.close = () => { current.isClosed = true }
    watchers.push(current)
    return current
  }
  const until = async (check, label) => {
    for (const end = Date.now() + 2000; Date.now() < end; await new Promise(done => setTimeout(done, 20))) if (check()) return
    assert.fail(label)
  }
  const source = portable.deepseekLocalPlugin(process.execPath, join(f.root, 'hook.mjs'), join(f.home, 'progress.md'), f.home, join(f.home, 'board.mjs'))
  const names = ['createRequire', 'spawnSync', 'spawn', 'spawnMailbox', 'randomUUID', 'readFileSync', 'existsSync', 'watch', 'join']
  const { apply } = new Function(...names, `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace(/^export /gm, '')}\nreturn { apply }`)(createRequire, () => ({ status: 0, stdout: '', stderr: '' }), () => { throw new Error('UNUSED') }, spawnMailbox, randomUUID, readFileSync, existsSync, watchBoard, join)
  const root = { session: { header: { id: 'deepseek-replacement-session' } }, status: 'idle', followup() {} }
  const hooks = new Map()
  apply({ on: (event, handler) => hooks.set(event, handler) })
  try {
    hooks.get('agent/created')({ agent: root })
    await until(() => watchers.length === 1, 'the first folder was watched')
    hooks.get('agent/status')({ agent: root, status: 'idle' })
    await until(() => watchers.length === 2, 'the replacement folder was watched')
    rmSync(first, { recursive: true, force: true })
    watchers[0].emit('change', 'rename', 'first')
    watchers[0].emit('error', new Error('late old watcher error'))
    assert.notEqual(watchers[1].isClosed, true)
    hooks.get('agent/status')({ agent: root, status: 'idle' })
    await until(() => takes === 3, 'the replacement was checked again')
    await new Promise(done => setImmediate(done))
    assert.equal(watchers.length, 2)
  } finally {
    hooks.get('agent/disposed')({ agent: root })
    await new Promise(done => setImmediate(done))
  }
}))

// A DeepSeek receiver wired to a real board script, for the give-back tests (#1870). `onSpawn(action, args)` may answer a
// call itself with another command, as a board that refuses it would.
const giveBackRig = async (f, session, id, text) => {
  const portable = await importTs('../hooks/portable-agents.ts')
  const { defaultMessagesDirectory } = await importTs('../scripts/runtime-folder.ts')
  const { enrollMailbox, mailboxId } = await importTs('../hooks/hook-messages.ts')
  const messaging = await importTs('../hooks/messaging.ts')
  const board = join(f.home, 'deepseek-board.mjs')
  f.save(board, bundleFromDir(new URL('..', import.meta.url)))
  const progress = join(f.home, 'deepseek-progress.md')
  f.save(progress, '')
  const directory = defaultMessagesDirectory(progress, f.home, process.env, process.platform)
  const file = join(directory, 'messages.json')
  const store = () => JSON.parse(readFileSync(file, 'utf8'))
  const message = () => store().messages.find(one => one.id === id)
  const write = state => f.save(file, JSON.stringify({ version: 2, ...state }))
  const now = Date.now()
  const enrolled = enrollMailbox({ messages: [] }, 'deepseek', session, 'dsh', now, 43_200_000)
  const target = enrolled.mailboxes.find(one => one.id === mailboxId('deepseek', session))
  write(messaging.queueMessage(enrolled, { id, target: target.id, turn: 'session', text }, 'board', target, now).state)
  const children = [], calls = []
  const rig = { onSpawn: null }
  const spawnMailbox = (node, args, options) => {
    calls.push(args[2])
    const child = rig.onSpawn?.(args[2], args) ?? spawn(node, args, options)
    children.push(child)
    child.on('close', () => { child.isClosed = true })
    return child
  }
  const settled = () => children.every(child => child.isClosed)
  const until = async (check, label) => {
    for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(done => setTimeout(done, 50))) if (check()) return
    assert.fail(label)
  }
  const source = portable.deepseekLocalPlugin(process.execPath, join(f.root, 'agent-board-hook.mjs'), progress, f.home, board)
  const names = ['createRequire', 'spawnSync', 'spawn', 'spawnMailbox', 'randomUUID', 'readFileSync', 'existsSync', 'watch', 'join']
  const { apply } = new Function(...names, `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace(/^export /gm, '')}\nreturn { apply }`)(createRequire, () => ({ status: 0, stdout: '', stderr: '' }), () => { throw new Error('UNUSED') }, spawnMailbox, randomUUID, readFileSync, existsSync, watch, join)
  const root = { session: { header: { id: session } }, status: 'idle', received: [], followup(one) { root.received.push(one); root.status = 'running' } }
  const hooks = new Map()
  apply({ on: (event, handler) => hooks.set(event, handler) })
  const close = async () => {
    hooks.get('agent/disposed')({ agent: root })
    for (const end = Date.now() + 10_000; !settled() && Date.now() < end;) await new Promise(done => setTimeout(done, 50))
    for (const child of children) if (!child.isClosed) child.kill()
  }
  return { ...rig, rig, root, hooks, calls, store, message, write, settled, until, close, messaging }
}

test('a DeepSeek session that works longer than the lease gets the message once, at its next idle, with no Unsure and no second copy: the receiver gives its claim back (#1870)', () => fixture(async f => {
  const run = await giveBackRig(f, 'deepseek-long-turn', 'long-turn-1', 'Synthetic answer for a long turn')
  try {
    // The session starts a turn while its take runs, so the take lands on a working session.
    run.rig.onSpawn = action => { if (action === 'take') run.root.status = 'running' }
    run.hooks.get('agent/created')({ agent: run.root })
    await run.until(() => run.calls.includes('take') && run.settled(), 'the take finished while the session worked')
    await run.until(() => run.settled() && run.message().status === 'queued', 'the claim was given back while the session worked')
    assert.equal(run.root.received.length, 0)
    // Given back: queued again with no claim on it, so no lease runs.
    assert.deepEqual([run.message().status, run.message().error, run.message().ref, run.message().claimed], ['queued', '', undefined, 0])
    // A write long after the lease leaves it queued: nothing reads Unsure (HOLDER_LOST).
    const later = run.messaging.pruneMessages(run.store(), Date.now() + 2 * run.messaging.MAILBOX_LEASE_MS)
    assert.deepEqual([later.messages[0].status, later.messages[0].error], ['queued', ''])
    run.write(later)
    // The turn ends: the next idle takes it again and hands it over once.
    run.rig.onSpawn = null
    run.root.status = 'idle'
    run.hooks.get('agent/status')({ agent: run.root, status: 'idle' })
    await run.until(() => run.message().status === 'accepted' && run.settled(), 'the message was accepted at the next idle')
    assert.equal(run.root.received.length, 1)
    assert.match(run.root.received[0].content[0].text, /Synthetic answer for a long turn/)
    assert.doesNotMatch(run.root.received[0].content[0].text, /Sent again/)
    assert.equal(run.message().redelivered, undefined)
    // Nothing more is handed over at a later idle.
    run.root.status = 'idle'
    run.hooks.get('agent/status')({ agent: run.root, status: 'idle' })
    await new Promise(done => setTimeout(done, 300))
    await run.until(run.settled, 'the later take finished')
    assert.equal(run.root.received.length, 1)
  } finally { await run.close() }
}))

test('a DeepSeek claim whose give-back fails is handed over at the next idle inside its lease, once (#1870)', () => fixture(async f => {
  const run = await giveBackRig(f, 'deepseek-give-back-fails', 'kept-claim-1', 'Synthetic answer kept by the plugin')
  try {
    // The board refuses the give-back: the command exits with no answer.
    run.rig.onSpawn = action => {
      if (action === 'take') { run.root.status = 'running'; return undefined }
      return action === 'release' ? spawn(process.execPath, ['-e', 'process.exit(1)']) : undefined
    }
    run.hooks.get('agent/created')({ agent: run.root })
    await run.until(() => run.calls.includes('release') && run.settled(), 'the receiver tried to give the claim back')
    assert.equal(run.message().status, 'uncertain')
    assert.equal(run.root.received.length, 0)
    run.root.status = 'idle'
    run.hooks.get('agent/status')({ agent: run.root, status: 'idle' })
    await run.until(() => run.message().status === 'accepted' && run.settled(), 'the kept claim was accepted at the next idle')
    assert.equal(run.root.received.length, 1)
    assert.match(run.root.received[0].content[0].text, /Synthetic answer kept by the plugin/)
  } finally { await run.close() }
}))

test('a DeepSeek claim whose give-back failed and whose lease ran out is not handed over at the next idle (#1870)', () => fixture(async f => {
  const run = await giveBackRig(f, 'deepseek-lease-out', 'lease-out-1', 'Synthetic answer past its lease')
  try {
    run.rig.onSpawn = action => {
      if (action === 'take') { run.root.status = 'running'; return undefined }
      return action === 'release' ? spawn(process.execPath, ['-e', 'process.exit(1)']) : undefined
    }
    run.hooks.get('agent/created')({ agent: run.root })
    await run.until(() => run.calls.includes('release') && run.settled(), 'the receiver tried to give the claim back')
    assert.equal(run.message().status, 'uncertain')
    // The lease runs out before any write prunes the store: the claim is no longer the plugin's to hand over.
    const state = run.store()
    run.write({ ...state, messages: state.messages.map(one => ({ ...one, claimed: Date.now() - run.messaging.MAILBOX_LEASE_MS - 1000 })) })
    run.rig.onSpawn = null
    run.root.status = 'idle'
    run.hooks.get('agent/status')({ agent: run.root, status: 'idle' })
    await new Promise(done => setTimeout(done, 300))
    await run.until(run.settled, 'the idle check finished')
    assert.equal(run.root.received.length, 0)
    assert.notEqual(run.message().status, 'accepted')
    // The next write makes it Unsure: HOLDER_LOST, never handed out again.
    const pruned = run.messaging.pruneMessages(run.store(), Date.now())
    assert.deepEqual([pruned.messages[0].status, pruned.messages[0].error], ['uncertain', 'HOLDER_LOST'])
  } finally { await run.close() }
}))

test('a DeepSeek give-back that fails once is tried again while the session works, so the message is queued again and handed over once at the next idle, never Unsure (#1870)', () => fixture(async f => {
  const run = await giveBackRig(f, 'deepseek-give-back-again', 'again-1', 'Synthetic answer given back on the second try')
  try {
    // The first give-back fails (the command exits with no answer); the board is back for the next one.
    let releases = 0
    run.rig.onSpawn = action => {
      if (action === 'take') { run.root.status = 'running'; return undefined }
      if (action === 'release' && ++releases === 1) return spawn(process.execPath, ['-e', 'process.exit(1)'])
      return undefined
    }
    run.hooks.get('agent/created')({ agent: run.root })
    await run.until(() => releases >= 2 && run.settled() && run.message().status === 'queued', 'the claim was given back again while the session worked')
    assert.equal(run.root.received.length, 0)
    assert.deepEqual([run.message().error, run.message().ref], ['', undefined])
    // A write past the lease leaves it queued: nothing reads Unsure.
    const later = run.messaging.pruneMessages(run.store(), Date.now() + 2 * run.messaging.MAILBOX_LEASE_MS)
    assert.deepEqual([later.messages[0].status, later.messages[0].error], ['queued', ''])
    run.write(later)
    run.rig.onSpawn = null
    run.root.status = 'idle'
    run.hooks.get('agent/status')({ agent: run.root, status: 'idle' })
    await run.until(() => run.message().status === 'accepted' && run.settled(), 'the message was accepted at the next idle')
    assert.equal(run.root.received.length, 1)
    assert.match(run.root.received[0].content[0].text, /Synthetic answer given back on the second try/)
  } finally { await run.close() }
}))

test('an older board\'s unnamed DeepSeek claim taken for a working session is still handed over at the next idle after its lease, once (#1870)', () => fixture(async f => {
  const run = await giveBackRig(f, 'deepseek-unnamed', 'unnamed-1', 'Synthetic answer from an older board')
  try {
    // An older board answers a take without naming the claim; the session started a turn meanwhile.
    run.rig.onSpawn = (action, args) => {
      if (action === 'take') {
        run.root.status = 'running'
        const script = `const out = require('node:child_process').spawnSync(process.execPath, ${JSON.stringify(args)}, { encoding: 'utf8' }).stdout.trim().split(/\\r?\\n/).pop(); const answer = JSON.parse(out); if (answer.message) delete answer.message.ref; process.stdout.write(JSON.stringify(answer) + '\\n')`
        return spawn(process.execPath, ['-e', script])
      }
      return undefined
    }
    run.hooks.get('agent/created')({ agent: run.root })
    await run.until(() => run.calls.includes('take') && run.settled() && run.message().status === 'uncertain', 'the unnamed claim was taken while the session worked')
    // Nothing to give back: no release is asked for.
    assert.equal(run.calls.includes('release'), false)
    // That board holds the claim with no name too. The turn outlasts the lease; that board keeps the claim for this plugin,
    // which hands it over at the next idle.
    const state = run.store()
    run.write({ ...state, messages: state.messages.map(({ ref: _ref, ...one }) => ({ ...one, claimed: Date.now() - run.messaging.MAILBOX_LEASE_MS - 1000 })) })
    run.rig.onSpawn = null
    run.root.status = 'idle'
    run.hooks.get('agent/status')({ agent: run.root, status: 'idle' })
    await run.until(() => run.root.received.length === 1 && run.settled(), 'the unnamed claim was handed over at the next idle')
    assert.match(run.root.received[0].content[0].text, /Synthetic answer from an older board/)
    await new Promise(done => setTimeout(done, 300))
    await run.until(run.settled, 'the accept finished')
    assert.equal(run.root.received.length, 1)
  } finally { await run.close() }
}))

test('a DeepSeek take answered with no name while the board holds a named claim is not handed over after its lease (#1870)', () => fixture(async f => {
  const run = await giveBackRig(f, 'deepseek-unnamed-answer', 'unnamed-answer-1', 'Synthetic answer whose take named no claim')
  try {
    // The take's answer leaves out the name the board stored; the session started a turn meanwhile.
    run.rig.onSpawn = (action, args) => {
      if (action === 'take') {
        run.root.status = 'running'
        const script = `const out = require('node:child_process').spawnSync(process.execPath, ${JSON.stringify(args)}, { encoding: 'utf8' }).stdout.trim().split(/\\r?\\n/).pop(); const answer = JSON.parse(out); if (answer.message) delete answer.message.ref; process.stdout.write(JSON.stringify(answer) + '\\n')`
        return spawn(process.execPath, ['-e', script])
      }
      return undefined
    }
    run.hooks.get('agent/created')({ agent: run.root })
    await run.until(() => run.calls.includes('take') && run.settled() && run.message().status === 'uncertain', 'the claim was taken while the session worked')
    assert.equal(typeof run.message().ref, 'string')
    // The named claim's lease runs out before the next idle: it is not handed over.
    const state = run.store()
    run.write({ ...state, messages: state.messages.map(one => ({ ...one, claimed: Date.now() - run.messaging.MAILBOX_LEASE_MS - 1000 })) })
    run.rig.onSpawn = null
    run.root.status = 'idle'
    run.hooks.get('agent/status')({ agent: run.root, status: 'idle' })
    await new Promise(done => setTimeout(done, 300))
    await run.until(run.settled, 'the idle check finished')
    assert.equal(run.root.received.length, 0)
    assert.notEqual(run.message().status, 'accepted')
  } finally { await run.close() }
}))

test('a DeepSeek session that goes idle while a give-back is tried again still gets the kept claim inside its lease, once (#1870)', () => fixture(async f => {
  const run = await giveBackRig(f, 'deepseek-idle-during-retry', 'idle-retry-1', 'Synthetic answer kept through a slow give-back')
  try {
    // The first give-back fails, with the board's claim made 14.4 s before it, so its lease ends 15.6 s later; the second
    // never answers, and the session goes idle while it runs.
    let releases = 0
    run.rig.onSpawn = action => {
      if (action === 'take') { run.root.status = 'running'; return undefined }
      if (action !== 'release') return undefined
      releases += 1
      if (releases === 1) {
        const state = run.store()
        run.write({ ...state, messages: state.messages.map(one => ({ ...one, claimed: Date.now() - run.messaging.MAILBOX_LEASE_MS + 15_600 })) })
        return spawn(process.execPath, ['-e', 'process.exit(1)'])
      }
      setTimeout(() => { run.root.status = 'idle'; run.hooks.get('agent/status')({ agent: run.root, status: 'idle' }) }, 200)
      return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
    }
    run.hooks.get('agent/created')({ agent: run.root })
    await run.until(() => releases >= 2, 'the give-back was tried again')
    await run.until(() => run.root.received.length === 1, 'the kept claim was handed over after the slow give-back')
    assert.match(run.root.received[0].content[0].text, /Synthetic answer kept through a slow give-back/)
    await run.until(() => run.message().status === 'accepted' && run.settled(), 'the kept claim was accepted')
    assert.equal(run.root.received.length, 1)
  } finally { await run.close() }
}))

test('a DeepSeek give-back the board saved but whose answer was lost is taken again at the next idle, once (#1870)', () => fixture(async f => {
  const run = await giveBackRig(f, 'deepseek-lost-answer', 'lost-answer-1', 'Synthetic answer whose give-back answer was lost')
  try {
    // The board saves the give-back, but its answer never reaches the receiver: the command exits with no output.
    run.rig.onSpawn = (action, args) => {
      if (action === 'take') { run.root.status = 'running'; return undefined }
      return action === 'release' ? spawn(process.execPath, ['-e', `require('node:child_process').spawnSync(process.execPath, ${JSON.stringify(args)}, { stdio: 'ignore' }); process.exit(1)`]) : undefined
    }
    run.hooks.get('agent/created')({ agent: run.root })
    await run.until(() => run.calls.includes('release') && run.settled(), 'the receiver tried to give the claim back')
    assert.equal(run.message().status, 'queued')
    assert.equal(run.root.received.length, 0)
    // The board folder's change from the give-back is seen while the session still works, so only the idle can take it.
    await new Promise(done => setTimeout(done, 1000))
    await run.until(run.settled, 'the check after the give-back finished')
    run.rig.onSpawn = null
    run.root.status = 'idle'
    run.hooks.get('agent/status')({ agent: run.root, status: 'idle' })
    await run.until(() => run.message().status === 'accepted' && run.settled(), 'the message queued again was taken and accepted at the next idle')
    assert.equal(run.root.received.length, 1)
    assert.match(run.root.received[0].content[0].text, /Synthetic answer whose give-back answer was lost/)
  } finally { await run.close() }
}))

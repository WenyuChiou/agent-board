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

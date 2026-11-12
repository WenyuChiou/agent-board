import { spawn } from 'node:child_process'
import { registerHooks, createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// A board script built from this checkout, a mailbox folder under a temporary home, and the plugin
// OpenCode would load, with a stand-in client. The stand-in records what the plugin asks of OpenCode.
const fixture = async fn => {
  const home = mkdtempSync(join(tmpdir(), 'agent-board-opencode-'))
  const exitListeners = process.listeners('exit')
  const children = []
  try {
    const local = await importTs('../hooks/local-agents.ts')
    const { defaultMessagesDirectory } = await importTs('../scripts/runtime-folder.ts')
    const { enrollMailbox, mailboxId } = await importTs('../hooks/hook-messages.ts')
    const { queueMessage } = await importTs('../hooks/messaging.ts')
    const save = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text) }
    const board = join(home, 'opencode-board.mjs')
    save(board, bundleFromDir(new URL('..', import.meta.url)))
    const progress = join(home, 'opencode-progress.md')
    save(progress, '')
    const directory = defaultMessagesDirectory(progress, home, process.env, process.platform)
    const file = join(directory, 'messages.json')
    const store = () => JSON.parse(readFileSync(file, 'utf8'))
    const message = id => store().messages.find(one => one.id === id)
    // The board queues a message for a session whose mailbox is open.
    const queue = (session, id, text) => {
      const now = Date.now()
      let state
      try { state = store() } catch { state = { messages: [] } }
      const enrolled = enrollMailbox(state, 'opencode', session, 'CLI', now, 43_200_000)
      const target = enrolled.mailboxes.find(one => one.id === mailboxId('opencode', session))
      save(file, JSON.stringify({ version: 2, ...queueMessage(enrolled, { id, target: target.id, turn: 'session', text }, 'board', target, now).state }))
    }
    const spawnBoard = (...args) => {
      const child = spawn(...args)
      children.push(child)
      child.on('close', () => { child.isClosed = true })
      return child
    }
    const settled = () => children.every(child => child.isClosed)
    const until = async (check, label) => {
      for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(done => setTimeout(done, 50))) if (check()) return
      assert.fail(label)
    }
    const calls = { promptAsync: [], status: [] }
    const sessions = new Map()
    const client = {
      session: {
        get: async ({ path }) => ({ data: { id: path.id, ...(sessions.get(path.id) ?? {}) } }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: calls.busy ?? {} }),
        promptAsync: async options => {
          calls.promptAsync.push(options)
          if (calls.fail) return { error: { name: 'Failed' } }
          return { data: undefined }
        },
      },
    }
    const worker = join(home, 'agent-board-hook.mjs')
    const source = local.opencodePlugin(process.execPath, worker, progress, 'Progress', home, undefined, board)
    const tool = Object.assign(value => value, { schema: { string: () => ({ describe: () => ({}) }), enum: () => ({}), array: () => ({}) } })
    // Each folder watcher the plugin starts, and whether it closed it.
    const watchers = []
    const watchBoard = (...args) => {
      const watcher = watch(...args)
      const close = watcher.close.bind(watcher)
      watcher.close = () => { watcher.isClosed = true; return close() }
      watchers.push(watcher)
      return watcher
    }
    const names = ['createRequire', 'spawnSync', 'tool', 'spawnBoard', 'readBoardStore', 'watchBoard', 'joinBoard', 'boardFolderExists']
    const factory = new Function(...names, `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace('export default', 'const plugin =').replace(/^export /gm, '')}\nreturn AgentBoardLocal`)(createRequire, () => ({ status: 0, stdout: '', stderr: '' }), tool, spawnBoard, readFileSync, watchBoard, join, existsSync)
    const hooks = await factory({ client, directory: home })
    const reported = state => hooks.event({ event: { type: 'session.status', properties: { sessionID: state.session, status: { type: state.type } } } })
    const idle = session => hooks.event({ event: { type: 'session.idle', properties: { sessionID: session } } })
    await fn({ home, directory, hooks, client, calls, sessions, queue, message, until, settled, reported, idle, save, watchers })
  } finally {
    for (const child of children) if (!child.isClosed) child.kill()
    for (const end = Date.now() + 10_000; !children.every(child => child.isClosed) && Date.now() < end;) await new Promise(done => setTimeout(done, 50))
    for (const listener of process.listeners('exit')) if (!exitListeners.includes(listener)) process.removeListener('exit', listener)
    delete globalThis[Symbol.for('agent-board.opencode-open-sessions')]
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
}

test('opencodePlugin wakes an idle session through client.session.promptAsync and binds send and ack to context.sessionID', () => fixture(async f => {
  f.queue('ses_idle', 'wake-message-1', 'Synthetic wake text')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_idle' } } } })
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('wake-message-1').status === 'accepted' && f.settled(), 'the idle session was woken and the message accepted')
  const wake = f.calls.promptAsync[0]
  assert.equal(wake.path.id, 'ses_idle')
  assert.equal(wake.body.parts.length, 1)
  assert.equal(wake.body.parts[0].type, 'text')
  assert.match(wake.body.parts[0].text, /Synthetic wake text/)
  const nonce = /ACK ([0-9a-f]{6})/.exec(wake.body.parts[0].text)[1]
  assert.equal(f.message('wake-message-1').nonce, nonce)

  // The two tools take no session argument: the host's context.sessionID is the only session they act for.
  const { agent_board_ack: ack, agent_board_send: send } = f.hooks.tool
  assert.deepEqual(Object.keys(ack.args).sort(), ['id', 'nonce', 'summary'])
  assert.deepEqual(Object.keys(send.args).sort(), ['agent', 'session', 'text'])
  await assert.rejects(ack.execute({ id: 'wake-message-1', nonce, session: 'ses_idle' }, { sessionID: 'ses_other' }), /NO_SESSION/)
  await assert.rejects(ack.execute({ id: 'wake-message-1', nonce, session: 'ses_idle' }, {}), /NO_SESSION/)
  await assert.rejects(ack.execute({ id: 'wake-message-1', nonce: 'zzzzzz' }, { sessionID: 'ses_idle' }), /INVALID_ARGUMENTS/)
  assert.equal(f.message('wake-message-1').status, 'accepted')
  await assert.rejects(send.execute({ agent: 'opencode', session: 'ses_target', text: 'hello' }, { sessionID: 'ses_other' }), /NO_SESSION/)

  // The board's own peer route is stood in for, to read who the send says it comes from.
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received.push({ url: req.url, token: req.headers['x-board-token'], body: JSON.parse(body) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'sent' }))
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    writeFileSync(join(f.directory, 'server.lock'), String(process.pid))
    writeFileSync(join(f.directory, 'server.owner'), JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.address().port}/?t=tok-1` }))
    assert.equal(await send.execute({ agent: 'opencode', session: 'ses_target', text: '--starts with hyphens' }, { sessionID: 'ses_idle' }), 'Sent.')
  } finally { await new Promise(done => server.close(done)) }
  assert.equal(received.length, 1)
  assert.equal(received[0].url, '/api/messages/peer-send')
  assert.equal(received[0].body.from, 'opencode:ses_idle')
  assert.equal(received[0].body.agent, 'opencode')
  assert.equal(received[0].body.session, 'ses_target')
  assert.equal(received[0].body.text, '--starts with hyphens')
  assert.match(received[0].body.folderDigest, /^[0-9a-f]{64}$/)
}))

test('in-process plugin receivers mark transport acceptance without re-queueing and upgrade to acknowledged on explicit ack', () => fixture(async f => {
  f.queue('ses_ack', 'ack-message-1', 'Synthetic ack text')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_ack' } } } })
  await f.until(() => f.message('ack-message-1').status === 'accepted' && f.settled(), 'the message was accepted by the transport')
  assert.equal(f.message('ack-message-1').awaitsAck, true)
  assert.equal(f.calls.promptAsync.length, 1)
  const nonce = f.message('ack-message-1').nonce

  // The turn it started ends, and the session is idle again: the accepted message is neither given nor queued again.
  await f.reported({ session: 'ses_ack', type: 'busy' })
  await f.idle('ses_ack')
  await f.hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_ack' } } })
  await new Promise(done => setTimeout(done, 400))
  await f.until(f.settled, 'no call is left running')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.message('ack-message-1').status, 'accepted')

  // Only the explicit acknowledgement upgrades it, with the nonce the board made.
  assert.equal(await f.hooks.tool.agent_board_ack.execute({ id: 'ack-message-1', nonce, summary: 'Synthetic summary' }, { sessionID: 'ses_ack' }), 'Acknowledged.')
  assert.equal(f.message('ack-message-1').status, 'acknowledged')
  assert.equal(f.message('ack-message-1').reply, `ACK ${nonce} Synthetic summary`)
  await f.idle('ses_ack')
  await new Promise(done => setTimeout(done, 300))
  assert.equal(f.calls.promptAsync.length, 1)

  // A wake that OpenCode refuses is not marked accepted: the claim stays open for the board to hand out again.
  f.calls.fail = true
  f.queue('ses_ack', 'ack-message-2', 'Synthetic second text')
  await f.reported({ session: 'ses_ack', type: 'busy' })
  await f.idle('ses_ack')
  await f.until(() => f.calls.promptAsync.length === 2 && f.settled(), 'the second wake was tried')
  assert.notEqual(f.message('ack-message-2').status, 'accepted')
  assert.notEqual(f.message('ack-message-2').status, 'acknowledged')
}))

test('opencodePlugin holds a message while the session is busy and wakes it at session.idle', () => fixture(async f => {
  f.queue('ses_busy', 'busy-message-1', 'Synthetic text for a busy session')
  await f.reported({ session: 'ses_busy', type: 'busy' })
  await new Promise(done => setTimeout(done, 500))
  // Held: nothing was woken, and the board's message was not even taken.
  assert.equal(f.calls.promptAsync.length, 0)
  assert.equal(f.message('busy-message-1').status, 'queued')

  await f.idle('ses_busy')
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('busy-message-1').status === 'accepted' && f.settled(), 'the message was given at session.idle')
  assert.match(f.calls.promptAsync[0].body.parts[0].text, /Synthetic text for a busy session/)

  // The board holds the next message for a session until the first is acknowledged, so it is acknowledged first.
  await f.hooks.tool.agent_board_ack.execute({ id: 'busy-message-1', nonce: f.message('busy-message-1').nonce }, { sessionID: 'ses_busy' })
  // The host's own status wins over a stale idle event: a session it reports as busy is not woken.
  f.queue('ses_busy', 'busy-message-2', 'Synthetic text while the host says busy')
  f.calls.busy = { ses_busy: { type: 'busy' } }
  await f.reported({ session: 'ses_busy', type: 'busy' })
  await new Promise(done => setTimeout(done, 300))
  await f.idle('ses_busy')
  await new Promise(done => setTimeout(done, 1000))
  await f.until(f.settled, 'no call is left running')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.message('busy-message-2').status, 'uncertain')
}))

test('opencodePlugin never registers a subagent session and never wakes a session it does not own', () => fixture(async f => {
  f.sessions.set('ses_child', { parentID: 'ses_parent' })
  f.queue('ses_child', 'child-message-1', 'Synthetic text for a subagent')
  f.queue('ses_other', 'other-message-1', 'Synthetic text for a session of another process')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_parent' } } } })
  await f.idle('ses_child')
  await new Promise(done => setTimeout(done, 500))
  await f.until(f.settled, 'no call is left running')
  assert.equal(f.calls.promptAsync.length, 0)
  assert.equal(f.message('child-message-1').status, 'queued')
  assert.equal(f.message('other-message-1').status, 'queued')
}))

test('opencodePlugin stops watching the board folder once it is removed, so OpenCode is not kept busy', () => fixture(async f => {
  f.queue('ses_gone', 'gone-message-1', 'Synthetic text before the folder goes')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_gone' } } } })
  await f.until(() => f.message('gone-message-1').status === 'accepted' && f.settled(), 'the message was given and the folder watched')
  assert.equal(f.watchers.length, 1)
  assert.notEqual(f.watchers[0].isClosed, true)
  // On Windows a watcher left on a removed folder reports it without end; the plugin must close it.
  rmSync(f.directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  await f.until(() => f.watchers[0].isClosed === true, 'the watcher of the removed folder was closed')
}))

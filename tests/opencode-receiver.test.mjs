import { spawn, spawnSync } from 'node:child_process'
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
    // A test can make the next calls of an action answer with a canned failure line instead of reaching the script.
    const spawnBoard = (...args) => {
      const action = args[1]?.[2]
      const isCanned = (calls.canned?.[action] ?? 0) > 0
      if (isCanned) calls.canned[action] -= 1
      const line = JSON.stringify({ ok: false, code: 'BOARD_NOT_RUNNING', watch: directory, message: null })
      const child = isCanned ? spawn(process.execPath, ['-e', 'process.stdout.write(process.argv[1] + "\n")', line], args[2]) : spawn(...args)
      children.push(child)
      child.on('close', () => { child.isClosed = true })
      return child
    }
    const settled = () => children.every(child => child.isClosed)
    const until = async (check, label) => {
      for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(done => setTimeout(done, 50))) if (check()) return
      assert.fail(label)
    }
    const calls = { promptAsync: [], status: [], sent: [], lookups: 0 }
    const sessions = new Map()
    const client = {
      session: {
        get: async ({ path }) => {
          if (calls.getFails) return { error: { name: 'Failed' } }
          const hold = calls.holdGet
          if (hold) { calls.holdGet = null; await hold }
          return { data: { id: path.id, ...(sessions.get(path.id) ?? {}) } }
        },
        messages: async () => {
          calls.lookups += 1
          if (calls.messagesFail) throw new Error('messages lookup failed')
          // With storeLag the host has the wake but does not list it yet.
          return { data: (calls.storeLag ? [] : calls.sent).map(text => ({ info: { role: 'user' }, parts: [{ type: 'text', text }] })) }
        },
        // OpenCode names a busy session; the stand-in reports every other session as idle unless a test says otherwise.
        status: async () => {
          calls.status.push(1)
          if (calls.gate) await calls.gate
          if (calls.afterStatus) { const run = calls.afterStatus; calls.afterStatus = null; setTimeout(run, 0) }
          if (calls.statusFails) throw new Error('status lookup failed')
          if (calls.statusError) return { error: { name: 'Failed' } }
          if (calls.noEntry) return { data: {} }
          return { data: new Proxy({}, { get: (_target, key) => calls.busy?.[key] ?? { type: 'idle' } }) }
        },
        promptAsync: async options => {
          calls.promptAsync.push(options)
          if (calls.fail) return { error: { name: 'Failed' } }
          if (calls.neverArrives) throw new Error('answer lost')
          // The wake reached the session, but its answer was lost on the way back.
          calls.sent.push(options.body.parts[0].text)
          if (calls.lostAnswer) throw new Error('answer lost')
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
    await fn({ home, board, progress, directory, hooks, client, calls, sessions, queue, message, until, settled, reported, idle, save, watchers })
  } finally {
    for (const child of children) if (!child.isClosed) child.kill()
    for (const end = Date.now() + 10_000; !children.every(child => child.isClosed) && Date.now() < end;) await new Promise(done => setTimeout(done, 50))
    for (const listener of process.listeners('exit')) if (!exitListeners.includes(listener)) process.removeListener('exit', listener)
    delete globalThis[Symbol.for('agent-board.opencode-open-sessions')]
    delete globalThis[Symbol.for('agent-board.opencode-sequence')]
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
  assert.equal(f.message('busy-message-2').status, 'queued')
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

test('opencodePlugin keeps no event order for a subagent session or a deleted session, so a long run does not grow it', () => fixture(async f => {
  f.sessions.set('ses_child', { parentID: 'ses_parent' })
  await f.reported({ session: 'ses_child', type: 'busy' })
  await f.idle('ses_child')
  await f.reported({ session: 'ses_gone', type: 'busy' })
  await f.hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_gone' } } } })
  await f.until(f.settled, 'no call is left running')
  const order = globalThis[Symbol.for('agent-board.opencode-sequence')]
  assert.equal(order.last.has('ses_child'), false)
  assert.equal(order.last.has('ses_gone'), false)
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

test('opencodePlugin puts the message id and the agent_board_ack instruction in the wake text', () => fixture(async f => {
  f.queue('ses_text', 'text-message-1', 'Synthetic text for the wake envelope')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_text' } } } })
  await f.until(() => f.calls.promptAsync.length === 1 && f.settled(), 'the session was woken')
  const text = f.calls.promptAsync[0].body.parts[0].text
  const nonce = f.message('text-message-1').nonce
  assert.match(text, /Synthetic text for the wake envelope/)
  assert.ok(text.includes('text-message-1'), 'the wake text names the message id')
  assert.ok(text.includes('agent_board_ack'), 'the wake text names the ack tool')
  assert.ok(text.includes(nonce))
}))

test('--mailbox accept for OpenCode reports a refused acceptance and only a saved one as ok', () => fixture(async f => {
  f.queue('ses_accept', 'accept-message-1', 'Synthetic text for acceptance')
  const call = (action, extra) => {
    const result = spawnSync(process.execPath, [f.board, '--mailbox', action, '--agent', 'opencode', '--home', f.home, '--progress-file', f.progress, '--session', 'ses_accept', '--surface', 'CLI', ...extra], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    return JSON.parse(result.stdout.trim().split('\n').pop())
  }
  const taken = call('take', [])
  assert.equal(taken.message.id, 'accept-message-1')
  assert.equal(call('accept', ['--id', 'accept-message-1', '--nonce', 'ffffff', '--awaits-ack']).ok, false)
  assert.equal(f.message('accept-message-1').status, 'uncertain')
  assert.equal(call('accept', ['--id', 'accept-message-1', '--nonce', taken.message.nonce, '--awaits-ack']).ok, true)
  assert.equal(f.message('accept-message-1').status, 'accepted')
}))

test('opencodePlugin does not wake a session that turned busy while the host status was pending', () => fixture(async f => {
  f.queue('ses_late', 'late-message-1', 'Synthetic text for a late status')
  let release
  f.calls.gate = new Promise(done => { release = done })
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_late' } } } })
  await f.until(() => f.calls.status.length === 1, 'the host status was asked')
  // A newer event arrives while the older answer is still on its way; the older answer says idle.
  await f.reported({ session: 'ses_late', type: 'busy' })
  release()
  await new Promise(done => setTimeout(done, 500))
  assert.equal(f.calls.promptAsync.length, 0)
  // The message is kept for the next session.idle.
  f.calls.gate = null
  await f.idle('ses_late')
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('late-message-1').status === 'accepted' && f.settled(), 'the message was given at the next idle')
}))

test('opencodePlugin keeps a session idle when a busy lookup returns after a newer idle event', () => fixture(async f => {
  await f.reported({ session: 'ses_order', type: 'busy' })
  // The busy event's lookup is slow; the idle event that follows it finishes first.
  let release
  f.calls.holdGet = new Promise(done => { release = done })
  const slowBusy = f.reported({ session: 'ses_order', type: 'busy' })
  await f.idle('ses_order')
  release()
  await slowBusy
  // A message queued now is taken: the late busy answer did not make the session busy again.
  f.queue('ses_order', 'order-message-1', 'Synthetic text after a late busy answer')
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('order-message-1').status === 'accepted' && f.settled(), 'the idle session was woken')
}))

test('opencodePlugin holds the message when the host status lookup fails', () => fixture(async f => {
  f.queue('ses_unknown', 'unknown-message-1', 'Synthetic text while the status is unknown')
  // A thrown lookup and an SDK error answer leave the state unknown.
  let asked = 0
  for (const failure of ['statusFails', 'statusError']) {
    f.calls[failure] = true
    await f.idle('ses_unknown')
    asked += 1
    await f.until(() => f.calls.status.length >= asked, `the host status was asked (${failure})`)
    await new Promise(done => setTimeout(done, 300))
    await f.until(f.settled, 'no call is left running')
    f.calls[failure] = false
    assert.equal(f.calls.promptAsync.length, 0, failure)
    assert.equal(f.message('unknown-message-1').status, 'queued', failure)
  }
  // A lookup that answers with no entry for the session is idle: OpenCode lists only sessions that are not
  // (F9, docs/validation/2026-11-12-opencode-f9-wake.md: `{}` for an idle session). The message is given.
  f.calls.noEntry = true
  await f.idle('ses_unknown')
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('unknown-message-1').status === 'accepted' && f.settled(), 'the message was given when the host listed no entry')
}))

test('opencodePlugin does not wake a session twice when the wake answer was lost but the message reached the session', () => fixture(async f => {
  f.calls.lostAnswer = true
  f.queue('ses_lost', 'lost-message-1', 'Synthetic text whose wake answer is lost')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_lost' } } } })
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('lost-message-1').status === 'accepted' && f.settled(), 'the message that reached the session was accepted')
  // A lookup of the session's messages that fails holds the next one instead of waking it again.
  await f.hooks.tool.agent_board_ack.execute({ id: 'lost-message-1', nonce: f.message('lost-message-1').nonce }, { sessionID: 'ses_lost' })
  f.queue('ses_lost', 'lost-message-2', 'Synthetic second text whose answer is lost')
  f.calls.messagesFail = true
  await f.reported({ session: 'ses_lost', type: 'busy' })
  await f.idle('ses_lost')
  await f.until(() => f.calls.promptAsync.length === 2 && f.settled(), 'the second wake was tried')
  await new Promise(done => setTimeout(done, 400))
  assert.notEqual(f.message('lost-message-2').status, 'accepted')
  f.calls.messagesFail = false
  await f.reported({ session: 'ses_lost', type: 'busy' })
  await f.idle('ses_lost')
  await f.until(() => f.message('lost-message-2').status === 'accepted' && f.settled(), 'the second message was accepted after the lookup worked')
  assert.equal(f.calls.promptAsync.length, 2)
}))

test('opencodePlugin gives a message back to the board when the session turns busy during the take, so a long turn does not expire it', () => fixture(async f => {
  const { pruneMessages, OPEN_LIMIT_MS } = await importTs('../hooks/messaging.ts')
  f.queue('ses_take', 'take-message-1', 'Synthetic text taken as the session turns busy')
  // The session turns busy right after the host status was read, while the board is still taking the message.
  f.calls.afterStatus = () => { f.reported({ session: 'ses_take', type: 'busy' }) }
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_take' } } } })
  await f.until(() => f.calls.status.length === 1, 'the host status was asked')
  await new Promise(done => setTimeout(done, 1500))
  await f.until(f.settled, 'no call is left running')
  assert.equal(f.calls.promptAsync.length, 0)
  // A busy turn longer than the board's limit does not expire what was given back.
  const stored = JSON.parse(readFileSync(join(f.directory, 'messages.json'), 'utf8'))
  const later = pruneMessages(stored, Date.now() + OPEN_LIMIT_MS + 60_000)
  const kept = later.messages.find(one => one.id === 'take-message-1')
  assert.equal(kept.status, 'queued')
  assert.equal(kept.error, '')
  // At the end of the turn it is given.
  await f.idle('ses_take')
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('take-message-1').status === 'accepted' && f.settled(), 'the message was given at the next idle')
}))

test('the OpenCode tool words and replies come from the string tables', async () => {
  const { STRINGS } = await importTs('../hooks/strings.ts')
  const local = await importTs('../hooks/local-agents.ts')
  for (const [lang, strings] of Object.entries(STRINGS)) for (const key of ['opencodeSendTool', 'opencodeAckTool', 'opencodeSent', 'opencodeAcknowledged', 'opencodeAckNote']) assert.equal(typeof strings[key], 'string', `${lang} ${key}`)
  const source = local.opencodePlugin(process.execPath, 'worker.mjs', 'progress.md', 'Progress', 'home', undefined, 'board.mjs', STRINGS['zh-TW'])
  assert.ok(source.includes(JSON.stringify(STRINGS['zh-TW'].opencodeAcknowledged)))
  assert.ok(source.includes(JSON.stringify(STRINGS['zh-TW'].opencodeAckTool)))
  assert.ok(!source.includes('Acknowledged.'))
})

// Delivery that does not depend on the receiver's own guesses (#724): the host's status and the board's store decide.
const wait = ms => new Promise(done => setTimeout(done, ms))

test('opencodePlugin accepts a message whose wake answer was lost when the host lists the wake late, and wakes the session once', () => fixture(async f => {
  f.calls.lostAnswer = true
  f.calls.storeLag = true
  f.queue('ses_lag', 'lag-message-1', 'Synthetic text whose wake is listed late')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_lag' } } } })
  await f.until(() => f.calls.promptAsync.length === 1 && f.settled(), 'the session was woken')
  await wait(400)
  // The host lists the wake before the receiver looks again.
  f.calls.storeLag = false
  await f.until(() => f.message('lag-message-1').status === 'accepted' && f.settled(), 'the message was accepted once the wake was listed')
  assert.equal(f.calls.promptAsync.length, 1)
}))

test('opencodePlugin wakes a message whose wake never arrived again only after the claim lease, and the second text says it may be a repeat', () => fixture(async f => {
  const { STRINGS } = await importTs('../hooks/strings.ts')
  f.calls.neverArrives = true
  f.queue('ses_never', 'never-message-1', 'Synthetic text whose wake never arrives')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_never' } } } })
  await f.until(() => f.calls.promptAsync.length === 1 && f.settled(), 'the session was woken')
  // One lookup right away and one about two seconds later; neither miss is taken as proof.
  await f.until(() => f.calls.lookups >= 2, 'the messages of the session were looked up a second time')
  f.calls.neverArrives = false
  await f.idle('ses_never')
  await wait(800)
  assert.equal(f.calls.promptAsync.length, 1, 'the claim is still held, so the board hands out nothing')
  // The lease passes: the board hands the message out again, and only now is the wake sent again.
  const lapsed = JSON.parse(readFileSync(join(f.directory, 'messages.json'), 'utf8'))
  for (const one of lapsed.messages) if (one.id === 'never-message-1') one.claimed -= 31_000
  f.save(join(f.directory, 'messages.json'), JSON.stringify(lapsed))
  await f.idle('ses_never')
  await f.until(() => f.calls.promptAsync.length === 2 && f.message('never-message-1').status === 'accepted' && f.settled(), 'the message was woken again after the lease')
  const text = f.calls.promptAsync[1].body.parts[0].text
  assert.ok(Object.values(STRINGS).some(one => text.includes(one.messagesDeliveryRepeat)), 'the second text carries the repeat line')
}))

test('opencodePlugin tries a failed take again within seconds, with no board write and no tick, and then wakes the session', () => fixture(async f => {
  f.calls.canned = { take: 1 }
  f.queue('ses_retake', 'retake-message-1', 'Synthetic text after a failed take')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_retake' } } } })
  await f.until(() => f.calls.canned.take === 0 && f.settled(), 'the first take answered with a failure')
  assert.equal(f.calls.promptAsync.length, 0)
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('retake-message-1').status === 'accepted' && f.settled(), 'the take was tried again and the session woken')
}))

test('--mailbox take for OpenCode answers ok false with a code while the store is held, and plain message null for an empty mailbox', () => fixture(async f => {
  const { claimMessageStore } = await importTs('../scripts/message-store-claim.ts')
  f.queue('ses_take_cli', 'take-cli-message-1', 'Synthetic text for the take answers')
  const call = action => {
    const result = spawnSync(process.execPath, [f.board, '--mailbox', action, '--agent', 'opencode', '--home', f.home, '--progress-file', f.progress, '--session', 'ses_take_cli', '--surface', 'CLI'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout.trim().split('\n').pop())
  }
  const claim = claimMessageStore(f.directory)
  const nonce = 'b'.repeat(32)
  const pending = join(f.directory, `.message-pending-${process.pid}-${nonce}.json`)
  f.save(pending, JSON.stringify({ version: 1, pid: process.pid, nonce }) + '\n')
  let failed
  try { failed = call('take') } finally { claim.release(); rmSync(pending, { force: true }) }
  assert.equal(failed.ok, false)
  assert.match(failed.code, /^[A-Z][A-Z0-9_]*$/)
  assert.equal(failed.message, null)
  assert.equal(typeof failed.watch, 'string')
  assert.equal(f.message('take-cli-message-1').status, 'queued')
  // With the store free the message is taken, and what is left is an empty mailbox, which is not a failure.
  assert.equal(call('take').message.id, 'take-cli-message-1')
  const empty = call('take')
  assert.equal(empty.message, null)
  assert.equal('ok' in empty, false)
  assert.equal(typeof empty.watch, 'string')
}))

test('opencodePlugin tries a failed release again while the session is busy, so the message is queued again before the turn ends', () => fixture(async f => {
  f.calls.canned = { release: 1 }
  f.queue('ses_release', 'release-message-1', 'Synthetic text whose release fails once')
  // The session turns busy while the board is taking the message, and the host keeps saying it is busy.
  f.calls.afterStatus = () => { f.calls.busy = { ses_release: { type: 'busy' } }; f.reported({ session: 'ses_release', type: 'busy' }) }
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_release' } } } })
  await f.until(() => f.calls.canned.release === 0 && f.settled(), 'the first release answered with a failure')
  assert.equal(f.message('release-message-1').status, 'uncertain')
  await f.until(() => f.message('release-message-1').status === 'queued' && f.settled(), 'the release was tried again and the message is queued')
  assert.equal(f.calls.promptAsync.length, 0)
  // At the end of the turn it is given.
  f.calls.busy = null
  await f.idle('ses_release')
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('release-message-1').status === 'accepted' && f.settled(), 'the message was given at the next idle')
}))

test('opencodePlugin takes an idle event a second after its wake as the end of the turn, so the next message is woken without another event', () => fixture(async f => {
  f.queue('ses_quick', 'quick-message-1', 'Synthetic first text')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_quick' } } } })
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('quick-message-1').status === 'accepted' && f.settled(), 'the first message was given')
  // A very short turn: it ends a second after the wake.
  await wait(1000)
  await f.idle('ses_quick')
  // The take that follows the idle event finds nothing to give; the ack waits for it so the two do not hold the store together.
  await wait(500)
  await f.until(f.settled, 'no call is left running')
  await f.hooks.tool.agent_board_ack.execute({ id: 'quick-message-1', nonce: f.message('quick-message-1').nonce }, { sessionID: 'ses_quick' })
  f.queue('ses_quick', 'quick-message-2', 'Synthetic second text')
  await f.until(() => f.calls.promptAsync.length === 2 && f.message('quick-message-2').status === 'accepted' && f.settled(), 'the second message was woken with no further event')
}))

test('opencodePlugin does not wake twice when a second idle event follows right after a wake', () => fixture(async f => {
  f.queue('ses_twice', 'twice-message-1', 'Synthetic text for a double idle')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_twice' } } } })
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('twice-message-1').status === 'accepted' && f.settled(), 'the message was given')
  await f.idle('ses_twice')
  await f.idle('ses_twice')
  await wait(800)
  await f.until(f.settled, 'no call is left running')
  assert.equal(f.calls.promptAsync.length, 1)
}))

test('opencodePlugin wakes a session whose idle event was lost at the next tick, because the host lists no entry for it', () => fixture(async f => {
  // The plugin's one-minute tick is captured so the test can run it.
  const ticks = []
  const real = globalThis.setInterval
  globalThis.setInterval = (run, ms, ...rest) => { ticks.push(run); return real(run, ms, ...rest) }
  try {
    await f.reported({ session: 'ses_lost_idle', type: 'busy' })
  } finally { globalThis.setInterval = real }
  assert.equal(ticks.length, 1)
  f.queue('ses_lost_idle', 'lost-idle-message-1', 'Synthetic text after a lost idle event')
  // The idle event is dropped: its session lookup fails.
  f.calls.getFails = true
  await f.idle('ses_lost_idle').catch(() => {})
  f.calls.getFails = false
  await wait(500)
  assert.equal(f.calls.promptAsync.length, 0)
  ticks[0]()
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('lost-idle-message-1').status === 'accepted' && f.settled(), 'the tick found the session idle and gave the message')
}))

test('opencodePlugin still wakes the session within the wait after one failed take', () => fixture(async f => {
  f.calls.canned = { take: 1 }
  f.queue('ses_first', 'first-message-1', 'Synthetic text of the first test with a failed take')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_first' } } } })
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('first-message-1').status === 'accepted' && f.settled(), 'the idle session was woken and the message accepted')
  assert.equal(f.calls.promptAsync[0].path.id, 'ses_first')
  assert.match(f.calls.promptAsync[0].body.parts[0].text, /Synthetic text of the first test/)
}))

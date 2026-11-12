import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
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

const wait = ms => new Promise(done => setTimeout(done, ms))
const TIMING_KEY = Symbol.for('agent-board.opencode-timing')
// Short deadlines for the receiver's own clocks, so a test that waits out a hung call or a backoff takes
// milliseconds. The board script's own calls are not run in this mode, so none of them is cut short.
const FAST = { hostMs: 120, boardMs: 200, backoffMs: 25, backoffMaxMs: 200, settleMs: 300, leaseMs: 80 }

// The plugin OpenCode would load, with a stand-in client that records what the plugin asks of OpenCode, and a
// mailbox folder under a temporary home. By default the board is stood in for by the board's own mailbox
// functions, called in this process on the same messages.json (so there is no process per call, and a test can
// delay, lose or refuse an answer, and move the board's clock). With { spawn: true } every call runs the real
// board script, as OpenCode's plugin does.
const fixture = async (fn, { spawn: isSpawn = false } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'agent-board-opencode-'))
  const exitListeners = process.listeners('exit')
  const children = []
  const running = new Set()
  try {
    const local = await importTs('../hooks/local-agents.ts')
    const { defaultMessagesDirectory } = await importTs('../scripts/runtime-folder.ts')
    const { enrollMailbox, mailboxId } = await importTs('../hooks/hook-messages.ts')
    const { queueMessage, pruneMessages, deliveryText } = await importTs('../hooks/messaging.ts')
    const { STRINGS } = await importTs('../hooks/strings.ts')
    const { mailboxAction } = isSpawn ? {} : await importTs('../scripts/board-messaging.ts')
    const save = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text) }
    const board = join(home, 'opencode-board.mjs')
    save(board, isSpawn ? bundleFromDir(new URL('..', import.meta.url)) : '')
    const progress = join(home, 'opencode-progress.md')
    save(progress, '')
    const directory = defaultMessagesDirectory(progress, home, process.env, process.platform)
    const file = join(directory, 'messages.json')
    const store = () => JSON.parse(readFileSync(file, 'utf8'))
    const message = id => store().messages.find(one => one.id === id)
    const clock = { skew: 0, now: () => Date.now() + clock.skew }
    const readState = () => { try { return pruneMessages(store(), clock.now()) } catch { return { messages: [] } } }
    const writeState = state => save(file, JSON.stringify({ version: 2, ...pruneMessages(state, clock.now()) }))
    // The board queues a message for a session whose mailbox is open.
    const queue = (session, id, text) => {
      const now = clock.now()
      const enrolled = enrollMailbox(readState(), 'opencode', session, 'CLI', now, 43_200_000)
      const target = enrolled.mailboxes.find(one => one.id === mailboxId('opencode', session))
      writeState(queueMessage(enrolled, { id, target: target.id, turn: 'session', text }, 'board', target, now).state)
    }
    // The board's clock moves on, and its store is pruned as it would be by the next call.
    const advance = ms => { clock.skew += ms; writeState(readState()) }
    const calls = { promptAsync: [], status: [], sent: [], lookups: 0, board: [], atWake: [], faults: {}, prompts: [], answers: [] }
    const sessions = new Map()
    const code = error => error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'BOARD_NOT_RUNNING'
    // The board script's answer to one --mailbox call, worked out from the same functions the script runs.
    const answerOf = (action, args) => {
      const at = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
      const base = { agent: 'opencode', session: at('--session') }
      const now = clock.now()
      const run = (name, body) => { const out = mailboxAction(readState(), name, body, now); writeState(out.state); return out.result }
      try {
        if (action === 'take') {
          const taken = run('mailbox-turn', { ...base, surface: 'CLI', ref: at('--ref') }).message
          return { watch: directory, message: taken === null ? null : { id: taken.id, nonce: taken.nonce, text: deliveryText(taken, STRINGS.en), summary: '' } }
        }
        if (action === 'attempt') run('mailbox-attempt', { ...base, ref: at('--ref') })
        else if (action === 'release') run('mailbox-release', { ...base, ref: at('--ref'), ...(args.includes('--unsent') ? { unsent: true } : {}) })
        else if (action === 'accept') run('mailbox-accept', { ...base, id: at('--id'), nonce: at('--nonce'), awaitsAck: args.includes('--awaits-ack') })
        else if (action === 'ack') {
          const summary = at('--summary-b64')
          run('mailbox-ack', { ...base, id: at('--id'), nonce: at('--nonce'), reply: `ACK ${at('--nonce')}${summary ? ` ${Buffer.from(summary, 'base64').toString('utf8')}` : ''}` })
        } else if (action === 'end') run('mailbox-end', base)
        else return { ok: false, code: 'INVALID_MAILBOX_CALL' }
        return { ok: true }
      } catch (error) { return { ok: false, code: code(error), ...(action === 'take' ? { watch: directory, message: null } : {}) } }
    }
    const spawnBoard = (...args) => {
      const action = args[1]?.[2]
      const canned = (calls.canned?.[action] ?? 0) > 0
      if (canned) calls.canned[action] -= 1
      calls.board.push(action)
      if (isSpawn) {
        const line = JSON.stringify({ ok: false, code: 'BOARD_NOT_RUNNING', watch: directory, message: null })
        const child = canned ? spawn(process.execPath, ['-e', 'process.stdout.write(process.argv[1] + "\n")', line], args[2]) : spawn(...args)
        children.push(child)
        child.on('close', () => { child.isClosed = true })
        running.add(child)
        child.on('close', () => running.delete(child))
        return child
      }
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.kill = () => { running.delete(child) }
      running.add(child)
      const finish = (code, line) => {
        if (!running.delete(child)) return
        if (line !== undefined) child.stdout.emit('data', `${JSON.stringify(line)}\n`)
        child.emit('close', code)
      }
      setImmediate(() => {
        const fault = canned ? 'fail' : calls.faults[action]?.shift()
        if (fault === 'hang') return
        if (fault === 'fail') return finish(0, { ok: false, code: 'BOARD_NOT_RUNNING', watch: directory, message: null })
        // The board answers, but only after the session had time to change.
        if (fault === 'slow') return void setTimeout(() => finish(0, answerOf(action, args[1])), 40)
        const answer = answerOf(action, args[1])
        // The call was applied on the board, but its answer never reached the plugin.
        if (fault === 'lose') return finish(1)
        finish(0, answer)
      })
      return child
    }
    const settled = () => running.size === 0
    // Sessions that must never be left with a message waiting and nothing running or timed to take it.
    const guarded = new Set()
    const busyNow = new Set()
    let receiverOf = () => null
    const stalled = () => {
      for (const session of guarded) {
        if (busyNow.has(session) || running.size > 0) continue
        let isOpen
        try { isOpen = store().messages.some(one => one.to === `opencode:${session}` && (one.status === 'queued' || one.status === 'uncertain' && one.attempted === undefined && one.error === '')) } catch { continue }
        if (isOpen && !receiverOf()?.holds(session)) return session
      }
      return null
    }
    const until = async (check, label) => {
      for (const end = Date.now() + 15_000; Date.now() < end; await wait(10)) {
        if (check()) return
        const lost = stalled()
        if (lost !== null) assert.fail(`${label}: a message for ${lost} waits and nothing is running or timed`)
      }
      assert.fail(label)
    }
    const client = {
      session: {
        get: async ({ path }) => {
          if (calls.getFails) return { error: { name: 'Failed' } }
          const hold = calls.holdGet
          if (hold) { calls.holdGet = null; await hold }
          return { data: { id: path.id, ...(sessions.get(path.id) ?? {}) } }
        },
        // The idle event's own reply capture (not the receiver) is the only caller; a count of zero means no idle event ran.
        messages: async () => {
          calls.lookups += 1
          return { data: [] }
        },
        // OpenCode names a busy session; the stand-in reports every other session as idle unless a test says otherwise.
        status: async () => {
          calls.status.push(1)
          const forced = calls.answers.shift()
          if (calls.gate) await calls.gate
          if (forced === 'hang') await new Promise(() => {})
          if (calls.afterStatus) { const run = calls.afterStatus; calls.afterStatus = null; setTimeout(run, 0) }
          if (forced === 'fail' || calls.statusFails) throw new Error('status lookup failed')
          if (calls.statusError) return { error: { name: 'Failed' } }
          if (calls.noEntry) return { data: {} }
          if (forced === 'busy') return { data: new Proxy({}, { get: () => ({ type: 'busy' }) }) }
          return { data: new Proxy({}, { get: (_target, key) => calls.busy?.[key] ?? { type: 'idle' } }) }
        },
        promptAsync: async options => {
          calls.promptAsync.push(options)
          try { calls.atWake.push(store().messages) } catch { calls.atWake.push(null) }
          const next = calls.prompts.shift()
          if (next) return next(options)
          if (calls.fail) return { error: { name: 'Failed' } }
          if (calls.neverArrives) throw new Error('answer lost')
          // The wake reached the session, but its answer was lost on the way back.
          calls.sent.push(options.body.parts[0].text)
          if (calls.lostAnswer) throw new Error('answer lost')
          return { data: undefined }
        },
      },
    }
    const prompts = {
      // The host refuses the wake: proof it was not sent.
      refuse: () => ({ error: { name: 'Failed' } }),
      // The wake arrived, but its answer was lost.
      arrivedThenLost: options => { calls.sent.push(options.body.parts[0].text); throw new Error('answer lost') },
      // The wake never arrived and the call failed.
      lost: () => { throw new Error('answer lost') },
      // The wake arrives, but only after the gate opens (after the plugin's own deadline).
      late: gate => async options => { await gate; calls.sent.push(options.body.parts[0].text); return { data: undefined } },
    }
    const worker = join(home, 'agent-board-hook.mjs')
    const source = local.opencodePlugin(process.execPath, worker, progress, 'Progress', home, undefined, board)
    const tool = Object.assign(value => value, { schema: { string: () => ({ describe: () => ({}), optional: () => ({ isOptional: true }) }), enum: () => ({}), array: () => ({}) } })
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
    const build = async () => {
      if (!isSpawn) globalThis[TIMING_KEY] = FAST
      try {
        const factory = new Function(...names, `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace('export default', 'const plugin =').replace(/^export /gm, '')}\nreturn { plugin: AgentBoardLocal, receiver: () => receiver }`)(createRequire, () => ({ status: 0, stdout: '', stderr: '' }), tool, spawnBoard, readFileSync, watchBoard, join, existsSync)
        const hooks = await factory.plugin({ client, directory: home })
        receiverOf = factory.receiver
        return { hooks, receiver: factory.receiver }
      } finally { delete globalThis[TIMING_KEY] }
    }
    let { hooks } = await build()
    const reported = state => { if (state.type === 'busy') busyNow.add(state.session); else busyNow.delete(state.session); return hooks.event({ event: { type: 'session.status', properties: { sessionID: state.session, status: { type: state.type } } } }) }
    const idle = session => { busyNow.delete(session); return hooks.event({ event: { type: 'session.idle', properties: { sessionID: session } } }) }
    const created = session => hooks.event({ event: { type: 'session.created', properties: { info: { id: session } } } })
    const deleted = session => hooks.event({ event: { type: 'session.deleted', properties: { info: { id: session } } } })
    // The receiver's own state change, with no event handler (and so no reply capture) around it.
    const note = (session, state) => { if (state === 'working') busyNow.add(session); else busyNow.delete(session); receiverOf().note(session, state) }
    const rebuild = async () => { ({ hooks } = await build()); return hooks }
    const f = { home, board, progress, directory, calls, sessions, queue, message, store, until, settled, reported, idle, created, deleted, note, save, watchers, advance, clock, prompts, guard: session => guarded.add(session), rebuild, receiver: () => receiverOf(), count: action => calls.board.filter(one => one === action).length }
    Object.defineProperty(f, 'hooks', { get: () => hooks })
    await fn(f)
  } finally {
    for (const child of children) if (!child.isClosed) child.kill()
    for (const end = Date.now() + 10_000; !children.every(child => child.isClosed) && Date.now() < end;) await wait(50)
    for (const listener of process.listeners('exit')) if (!exitListeners.includes(listener)) process.removeListener('exit', listener)
    delete globalThis[Symbol.for('agent-board.opencode-open-sessions')]
    delete globalThis[Symbol.for('agent-board.opencode-sequence')]
    delete globalThis[TIMING_KEY]
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
}

test('opencodePlugin wakes an idle session through client.session.promptAsync and binds send and ack to context.sessionID', () => fixture(async f => {
  f.queue('ses_idle', 'wake-message-1', 'Synthetic wake text')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_idle' } } } })
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('wake-message-1').status === 'accepted' && f.settled(), 'the idle session was woken and the message accepted')
  const wake = f.calls.promptAsync[0]
  assert.equal(typeof f.calls.atWake[0].find(one => one.id === 'wake-message-1').attempted, 'number', 'the real script saved the mark before the host was called')
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
}, { spawn: true }))

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
  await f.until(() => f.calls.promptAsync.length >= 2 && f.settled(), 'the second wake was tried')
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
}, { spawn: true }))

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

test('opencodePlugin tries a failed take again within seconds, with no board write and no tick, and then wakes the session', () => fixture(async f => {
  f.calls.canned = { take: 1 }
  f.queue('ses_retake', 'retake-message-1', 'Synthetic text after a failed take')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_retake' } } } })
  await f.until(() => f.calls.canned.take === 0 && f.settled(), 'the first take answered with a failure')
  assert.equal(f.calls.promptAsync.length, 0)
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('retake-message-1').status === 'accepted' && f.settled(), 'the take was tried again and the session woken')
}))

test('opencodePlugin gives up a host status lookup that never answers, so the session is not left locked and its message is woken later (#1366 review)', () => fixture(async f => {
  f.queue('ses_hung', 'hung-message-1', 'Synthetic text while the host does not answer')
  // The first lookup never settles; the ones after it answer.
  f.calls.gate = new Promise(() => {})
  await f.idle('ses_hung')
  await f.until(() => f.calls.status.length >= 1, 'the host status was asked')
  f.calls.gate = null
  assert.equal(f.calls.promptAsync.length, 0)
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('hung-message-1').status === 'accepted' && f.settled(), 'the hung lookup was given up and the session woken on the retry clock')
}))

test('opencodePlugin looks again within seconds after a failed host status lookup, with no further event or board write', () => fixture(async f => {
  f.queue('ses_status_retry', 'status-retry-message-1', 'Synthetic text after a failed status lookup')
  f.calls.statusFails = true
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_status_retry' } } } })
  await f.idle('ses_status_retry')
  await f.until(() => f.calls.status.length >= 1 && f.settled(), 'the host status was asked and failed')
  f.calls.statusFails = false
  assert.equal(f.calls.promptAsync.length, 0)
  assert.equal(f.message('status-retry-message-1').status, 'queued')
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('status-retry-message-1').status === 'accepted' && f.settled(), 'the status was asked again on its own and the session woken')
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
}, { spawn: true }))

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

// The board's side of an OpenCode wake (#1366): one wake at most for a message, and "sent, not confirmed" when the
// outcome of a wake cannot be known. These are the board's own functions with the time passed in.
const T0 = 1_800_000_000_000
const SEC = 1000
const MIN = 60 * SEC
const refOf = n => String(n).padStart(12, '0')

const mailbox = async () => {
  const { mailboxAction } = await importTs('../scripts/board-messaging.ts')
  const { enrollMailbox, mailboxId } = await importTs('../hooks/hook-messages.ts')
  const messaging = await importTs('../hooks/messaging.ts')
  const { STRINGS } = await importTs('../hooks/strings.ts')
  // One message from the board to a session whose mailbox is open.
  const seed = (agent, session, id = 'm1', text = 'Synthetic text for the board cases') => {
    const enrolled = enrollMailbox({ messages: [] }, agent, session, 'CLI', T0, 43_200_000)
    const target = enrolled.mailboxes.find(one => one.id === mailboxId(agent, session))
    return messaging.queueMessage(enrolled, { id, target: target.id, turn: 'session', text }, 'board', target, T0).state
  }
  const act = (state, action, body, now) => mailboxAction(state, action, body, now)
  const take = (state, agent, session, ref, now) => {
    const out = act(state, 'mailbox-turn', { agent, session, surface: 'CLI', ref }, now)
    return { state: out.state, message: out.result.message }
  }
  const prune = (state, now) => messaging.pruneMessages(state, now)
  return { seed, act, take, prune, messaging, STRINGS }
}

test('B1 an OpenCode claim nobody marked as a wake goes back to queued at each lease, with no repeat count or line, and is never expired', async () => {
  const b = await mailbox()
  let state = b.seed('opencode', 's1')
  let now = T0
  let taken = b.take(state, 'opencode', 's1', refOf(1), now)
  state = taken.state
  assert.equal(taken.message.id, 'm1')
  for (let round = 1; round <= 5; round++) {
    now += 31 * SEC
    state = b.prune(state, now)
    assert.deepEqual([state.messages[0].status, state.messages[0].ref, state.messages[0].redelivered, state.messages[0].text], ['queued', undefined, undefined, 'Synthetic text for the board cases'])
    taken = b.take(state, 'opencode', 's1', refOf(round + 1), now)
    state = taken.state
    assert.equal(taken.message.id, 'm1')
    assert.equal(taken.message.redelivered, undefined)
    assert.ok(!b.messaging.deliveryText(taken.message, b.STRINGS.en).includes(b.STRINGS.en.messagesDeliveryRepeat), 'no repeat line')
  }
  now += 31 * MIN
  state = b.prune(state, now)
  assert.deepEqual([state.messages[0].status, state.messages[0].error, state.messages[0].text], ['queued', '', 'Synthetic text for the board cases'])
})

test('B2 attempt marks the current claim, answers the same again, and says CLAIM_LOST for a claim whose lease passed or was taken again', async () => {
  const b = await mailbox()
  const claimed = b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0).state
  const marked = b.act(claimed, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + SEC)
  assert.equal(marked.result.ok, true)
  assert.equal(marked.state.messages[0].attempted, T0 + SEC)
  const again = b.act(marked.state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + 2 * SEC)
  assert.equal(again.state.messages[0].attempted, T0 + SEC)
  // The lease passed: the claim is the board's again, even before anyone took it again.
  assert.throws(() => b.act(claimed, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + 31 * SEC), /CLAIM_LOST/)
  // Taken again under another ref: the first ref is no longer the claim, and nothing changed.
  const second = b.take(b.prune(claimed, T0 + 31 * SEC), 'opencode', 's1', refOf(2), T0 + 31 * SEC).state
  const before = JSON.stringify(second)
  assert.throws(() => b.act(second, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + 32 * SEC), /CLAIM_LOST/)
  assert.equal(JSON.stringify(second), before)
  assert.equal(b.act(second, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(2) }, T0 + 32 * SEC).result.ok, true)
  // A ref nobody holds.
  assert.throws(() => b.act(second, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(9) }, T0 + 32 * SEC), /CLAIM_LOST/)
})

test('B3 a message marked as a wake is never handed out again, at 31 seconds or at 31 minutes', async () => {
  const b = await mailbox()
  let state = b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0).state
  state = b.act(state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + SEC).state
  for (const at of [31 * SEC, 31 * MIN]) {
    const out = b.take(b.prune(state, T0 + at), 'opencode', 's1', refOf(7), T0 + at)
    assert.equal(out.message, null, `at ${at} ms`)
  }
})

test('B4 a marked message with no receipt reads "sent, not confirmed" at 30 minutes, keeps its text, and still takes an accept or an ack', async () => {
  const b = await mailbox()
  const taken = b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0)
  const marked = b.act(taken.state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + SEC).state
  assert.equal(b.prune(marked, T0 + 25 * MIN).messages[0].error, '')
  const late = b.prune(marked, T0 + 31 * MIN)
  assert.deepEqual([late.messages[0].status, late.messages[0].error, late.messages[0].text], ['uncertain', 'UNCONFIRMED', 'Synthetic text for the board cases'])
  const nonce = taken.message.nonce
  const accepted = b.act(late, 'mailbox-accept', { agent: 'opencode', session: 's1', id: 'm1', nonce, awaitsAck: true }, T0 + 32 * MIN).state
  assert.deepEqual([accepted.messages[0].status, accepted.messages[0].error], ['accepted', ''])
  const acked = b.act(late, 'mailbox-ack', { agent: 'opencode', session: 's1', id: 'm1', nonce, reply: `ACK ${nonce} done` }, T0 + 32 * MIN).state
  assert.equal(acked.messages[0].status, 'acknowledged')
})

test('B9 a started wake holds the next message to its session only until it reads "sent, not confirmed", as an open message did before (#1366 review)', async () => {
  const b = await mailbox()
  const taken = b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0)
  assert.equal(taken.message.id, 'm1')
  const marked = b.act(taken.state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + SEC).state
  const second = (state, now) => {
    const box = state.mailboxes.find(one => one.agent === 'opencode' && one.session === 's1')
    return b.messaging.queueMessage(state, { id: 'm2', target: box.id, turn: 'session', text: 'Synthetic second message' }, 'board', box, now).state
  }
  // While the wake may still be arriving, the session's next message waits, as before.
  assert.throws(() => second(b.prune(marked, T0 + 25 * MIN), T0 + 25 * MIN), /PAIR_BUSY/)
  // Once it reads "sent, not confirmed", the next message is queued and handed out; the first keeps its text.
  const late = b.prune(marked, T0 + 31 * MIN)
  const next = b.take(second(late, T0 + 31 * MIN), 'opencode', 's1', refOf(2), T0 + 31 * MIN)
  assert.equal(next.message?.id, 'm2')
  const first = next.state.messages.find(one => one.id === 'm1')
  assert.deepEqual([first.error, first.text], ['UNCONFIRMED', 'Synthetic text for the board cases'])
  // A day later it expires like any other open message and its text goes.
  const gone = b.prune(late, T0 + 31 * MIN + 1441 * MIN).messages.find(one => one.id === 'm1')
  assert.deepEqual([gone.status, gone.error, gone.text], ['uncertain', 'EXPIRED', ''])
})

test('B5 release --unsent takes a started wake back to queued; a plain release does not; an unknown ref is NOT_HELD', async () => {
  const b = await mailbox()
  const claimed = b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0).state
  const marked = b.act(claimed, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + SEC).state
  assert.throws(() => b.act(marked, 'mailbox-release', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + 2 * SEC), /WAKE_STARTED/)
  const back = b.act(marked, 'mailbox-release', { agent: 'opencode', session: 's1', ref: refOf(1), unsent: true }, T0 + 2 * SEC).state
  assert.deepEqual([back.messages[0].status, back.messages[0].ref, back.messages[0].attempted, back.messages[0].claimed], ['queued', undefined, undefined, 0])
  assert.throws(() => b.act(back, 'mailbox-release', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + 3 * SEC), /NOT_HELD/)
  assert.throws(() => b.act(claimed, 'mailbox-release', { agent: 'opencode', session: 's1', ref: refOf(5) }, T0 + 3 * SEC), /NOT_HELD/)
  // An unmarked claim is given back by a plain release, as before.
  assert.equal(b.act(claimed, 'mailbox-release', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + 3 * SEC).state.messages[0].status, 'queued')
})

test('B6 an ack on a marked message that was not accepted yet acknowledges it', async () => {
  const b = await mailbox()
  const taken = b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0)
  const marked = b.act(taken.state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + SEC).state
  const nonce = taken.message.nonce
  assert.throws(() => b.act(marked, 'mailbox-ack', { agent: 'opencode', session: 's1', id: 'm1', nonce: 'ffffff', reply: 'ACK ffffff x' }, T0 + 2 * SEC), /TARGET_MISMATCH/)
  const acked = b.act(marked, 'mailbox-ack', { agent: 'opencode', session: 's1', id: 'm1', nonce, reply: `ACK ${nonce} done` }, T0 + 2 * SEC).state
  assert.deepEqual([acked.messages[0].status, acked.messages[0].reply], ['acknowledged', `ACK ${nonce} done`])
})

test('B8 the claims of the other hook receivers behave as before: handed out again with a repeat count and line, expired at 30 minutes, an unknown release is still ok', async () => {
  const b = await mailbox()
  let state = b.seed('codex', 's1')
  state = b.take(state, 'codex', 's1', refOf(1), T0).state
  const again = b.take(b.prune(state, T0 + 31 * SEC), 'codex', 's1', refOf(2), T0 + 31 * SEC)
  assert.equal(again.message.redelivered, 1)
  assert.ok(b.messaging.deliveryText(again.message, b.STRINGS.en).includes(b.STRINGS.en.messagesDeliveryRepeat))
  const expired = b.prune(again.state, T0 + 31 * SEC + 31 * MIN)
  assert.deepEqual([expired.messages[0].status, expired.messages[0].error, expired.messages[0].text], ['uncertain', 'EXPIRED', ''])
  // Release of a ref nobody holds answers as before, and attempt is not a call for these agents.
  assert.equal(b.act(state, 'mailbox-release', { agent: 'codex', session: 's1', ref: refOf(9) }, T0 + SEC).result.ok, true)
  assert.throws(() => b.act(state, 'mailbox-attempt', { agent: 'codex', session: 's1', ref: refOf(1) }, T0 + SEC), /INVALID_MAILBOX_CALL/)
})

test('B7 the --mailbox calls of the script: attempt, release and end answer ok and a code, and end says so when its write fails', () => fixture(async f => {
  const { claimMessageStore } = await importTs('../scripts/message-store-claim.ts')
  f.queue('ses_cli', 'cli-message-1', 'Synthetic text for the call answers')
  const call = (action, extra = []) => {
    const result = spawnSync(process.execPath, [f.board, '--mailbox', action, '--agent', 'opencode', '--home', f.home, '--progress-file', f.progress, '--session', 'ses_cli', '--surface', 'CLI', ...extra], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout.trim().split('\n').pop())
  }
  const ref = 'a1b2c3d4e5f6'
  assert.equal(call('take', ['--ref', ref]).message.id, 'cli-message-1')
  assert.deepEqual(call('attempt', ['--ref', 'ffffffffffff']), { ok: false, code: 'CLAIM_LOST' })
  assert.deepEqual(call('attempt', ['--ref', ref]), { ok: true })
  assert.deepEqual(call('attempt', ['--ref', ref]), { ok: true })
  assert.equal(typeof f.message('cli-message-1').attempted, 'number')
  assert.deepEqual(call('release', ['--ref', ref]), { ok: false, code: 'WAKE_STARTED' })
  assert.deepEqual(call('release', ['--ref', 'ffffffffffff']), { ok: false, code: 'NOT_HELD' })
  assert.deepEqual(call('release', ['--ref', ref, '--unsent']), { ok: true })
  assert.equal(f.message('cli-message-1').status, 'queued')
  // The store is held by another process: the write fails, and the answer says so instead of ok true.
  const claim = claimMessageStore(f.directory)
  const nonce = 'b'.repeat(32)
  const pending = join(f.directory, `.message-pending-${process.pid}-${nonce}.json`)
  f.save(pending, JSON.stringify({ version: 1, pid: process.pid, nonce }) + '\n')
  let failed
  try { failed = call('end') } finally { claim.release(); rmSync(pending, { force: true }) }
  assert.equal(failed.ok, false)
  assert.match(failed.code, /^[A-Z][A-Z0-9_]*$/)
  assert.deepEqual(call('end'), { ok: true })
}, { spawn: true }))

// The receiver (#1366): the board records "wake started" before the host is called, and from then on nothing sends
// that message again on a timer. The board is stood in for in this process; the receiver's own deadlines are short.
test('R1 the wake is recorded on the board before the host is called, then woken once and accepted', () => fixture(async f => {
  f.guard('ses_r1')
  f.queue('ses_r1', 'r1-message', 'Synthetic text for the normal path')
  await f.created('ses_r1')
  await f.until(() => f.message('r1-message').status === 'accepted' && f.settled(), 'the message was woken and accepted')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(typeof f.calls.atWake[0].find(one => one.id === 'r1-message').attempted, 'number', 'the mark was saved when the host was called')
  assert.deepEqual(f.calls.board, ['take', 'attempt', 'accept'])
  assert.equal(f.calls.lookups, 0)
}))

test('R2 an attempt that answers ok false twice wakes nothing meanwhile, then wakes once', () => fixture(async f => {
  f.guard('ses_r2')
  f.calls.faults.attempt = ['fail', 'fail']
  f.queue('ses_r2', 'r2-message', 'Synthetic text while the attempt fails')
  await f.created('ses_r2')
  await f.until(() => f.count('attempt') >= 1 && f.settled(), 'the first attempt failed')
  assert.equal(f.calls.promptAsync.length, 0)
  await f.until(() => f.message('r2-message').status === 'accepted' && f.settled(), 'the message was woken after the third attempt')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.count('attempt'), 3)
  assert.equal(f.count('take'), 1, 'the same claim was asked again, not taken again')
}))

test('R3 an attempt the board applied but whose answer was lost wakes nothing until a repeat attempt answers ok', () => fixture(async f => {
  f.guard('ses_r3')
  f.calls.faults.attempt = ['lose']
  f.queue('ses_r3', 'r3-message', 'Synthetic text while the attempt answer is lost')
  await f.created('ses_r3')
  await f.until(() => f.count('attempt') >= 1 && f.settled(), 'the first attempt was made')
  assert.equal(typeof f.message('r3-message').attempted, 'number', 'the board applied it')
  assert.equal(f.calls.promptAsync.length, 0)
  await f.until(() => f.message('r3-message').status === 'accepted' && f.settled(), 'the repeat attempt answered ok and the message was woken')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.count('attempt'), 2)
}))

test('R4 a host that refuses the wake gives the message back as not sent, wakes it again after the backoff, and it arrives once', () => fixture(async f => {
  f.guard('ses_r4')
  f.calls.prompts.push(f.prompts.refuse)
  f.queue('ses_r4', 'r4-message', 'Synthetic text for a refused wake')
  await f.created('ses_r4')
  await f.until(() => f.calls.promptAsync.length === 1 && f.settled(), 'the first wake was refused')
  await f.until(() => f.message('r4-message').status === 'accepted' && f.settled(), 'the message was woken again and accepted')
  assert.equal(f.calls.promptAsync.length, 2)
  assert.equal(f.calls.sent.length, 1, 'it arrived once')
  assert.equal(f.count('release'), 1)
}))

test('R5 a wake that passes the deadline and completes after two leases is the only wake', () => fixture(async f => {
  let open
  const gate = new Promise(done => { open = done })
  f.calls.prompts.push(f.prompts.late(gate))
  f.queue('ses_r5', 'r5-message', 'Synthetic text for a late wake')
  await f.created('ses_r5')
  await f.until(() => f.calls.promptAsync.length === 1, 'the wake was started')
  await wait(250)
  // Two leases pass, and the session reports idle again each time: the board hands nothing out.
  for (let lease = 0; lease < 2; lease++) {
    f.advance(31_000)
    await f.idle('ses_r5')
    await wait(250)
  }
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.message('r5-message').status, 'uncertain')
  open()
  await wait(100)
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.calls.sent.length, 1)
  const nonce = f.message('r5-message').nonce
  await f.hooks.tool.agent_board_ack.execute({ id: 'r5-message', nonce }, { sessionID: 'ses_r5' })
  assert.equal(f.message('r5-message').status, 'acknowledged')
}))

test('R6 a wake whose answer was lost but arrived is acknowledged by the model, with one call', () => fixture(async f => {
  f.calls.prompts.push(f.prompts.arrivedThenLost)
  f.queue('ses_r6', 'r6-message', 'Synthetic text for a wake whose answer is lost')
  await f.created('ses_r6')
  await f.until(() => f.calls.promptAsync.length === 1 && f.settled(), 'the wake was made')
  await wait(300)
  assert.equal(f.message('r6-message').status, 'uncertain')
  await f.hooks.tool.agent_board_ack.execute({ id: 'r6-message', nonce: f.message('r6-message').nonce, summary: 'Synthetic summary' }, { sessionID: 'ses_r6' })
  assert.equal(f.message('r6-message').status, 'acknowledged')
  assert.equal(f.calls.promptAsync.length, 1)
}))

test('R7 a wake that failed and never arrived is not repeated: after 31 minutes the card reads sent, not confirmed, with its text, and the conversation was never read', () => fixture(async f => {
  f.calls.prompts.push(f.prompts.lost)
  f.queue('ses_r7', 'r7-message', 'Synthetic text for a wake that never arrives')
  await f.created('ses_r7')
  await f.until(() => f.calls.promptAsync.length === 1 && f.settled(), 'the wake was made')
  f.advance(31 * 60_000)
  // The session reports idle again and again; no event handler runs, so no reply capture reads the conversation either.
  for (let round = 0; round < 3; round++) { f.note('ses_r7', 'working'); f.note('ses_r7', 'waiting'); await wait(250) }
  assert.equal(f.calls.promptAsync.length, 1)
  const shown = f.message('r7-message')
  assert.deepEqual([shown.status, shown.error, shown.text], ['uncertain', 'UNCONFIRMED', 'Synthetic text for a wake that never arrives'])
  assert.equal(f.calls.lookups, 0)
}))

test('R8 an accept that fails three times after a 204 is retried until saved, with one wake', () => fixture(async f => {
  f.guard('ses_r8')
  f.calls.faults.accept = ['fail', 'fail', 'fail']
  f.queue('ses_r8', 'r8-message', 'Synthetic text while the accept fails')
  await f.created('ses_r8')
  await f.until(() => f.message('r8-message').status === 'accepted' && f.settled(), 'the accept was saved at last')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.count('accept'), 4)
  assert.equal(f.count('take'), 1)
}))

test('R9 a busy status answer that returns after a newer idle event is discarded and asked again, so the message is woken with no further event', () => fixture(async f => {
  f.guard('ses_r9')
  let open
  f.calls.gate = new Promise(done => { open = done })
  f.calls.answers.push('busy')
  f.queue('ses_r9', 'r9-message', 'Synthetic text for a stale busy answer')
  await f.created('ses_r9')
  await f.until(() => f.calls.status.length === 1, 'the status was asked')
  await f.idle('ses_r9')
  f.calls.gate = null
  open()
  await f.until(() => f.message('r9-message').status === 'accepted' && f.settled(), 'the status was asked again and the message woken')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.ok(f.calls.status.length >= 2)
}))

test('R10 an idle status answer that returns after a newer busy event takes nothing', () => fixture(async f => {
  let open
  f.calls.gate = new Promise(done => { open = done })
  f.queue('ses_r10', 'r10-message', 'Synthetic text for a stale idle answer')
  await f.created('ses_r10')
  await f.until(() => f.calls.status.length === 1, 'the status was asked')
  await f.reported({ session: 'ses_r10', type: 'busy' })
  f.calls.gate = null
  open()
  await wait(300)
  assert.equal(f.count('take'), 0)
  assert.equal(f.calls.promptAsync.length, 0)
  assert.equal(f.message('r10-message').status, 'queued')
  await f.idle('ses_r10')
  await f.until(() => f.message('r10-message').status === 'accepted' && f.settled(), 'the next idle woke it')
}))

test('R11 a status lookup that fails and then hangs takes nothing, keeps a timer armed and wakes the message later', () => fixture(async f => {
  f.guard('ses_r11')
  f.calls.answers.push('fail', 'hang')
  f.queue('ses_r11', 'r11-message', 'Synthetic text while the status fails and hangs')
  await f.created('ses_r11')
  await f.until(() => f.calls.status.length >= 1, 'the status was asked')
  assert.equal(f.count('take'), 0)
  await f.until(() => f.message('r11-message').status === 'accepted' && f.settled(), 'the message was woken after the status worked')
  assert.ok(f.calls.status.length >= 3)
  assert.equal(f.calls.promptAsync.length, 1)
}))

test('R12 a take that answers ok false and then hangs is tried again within the short wait, and the message is woken', () => fixture(async f => {
  f.guard('ses_r12')
  f.calls.faults.take = ['fail', 'hang']
  f.queue('ses_r12', 'r12-message', 'Synthetic text while the take fails and hangs')
  await f.created('ses_r12')
  await f.until(() => f.message('r12-message').status === 'accepted' && f.settled(), 'the message was woken after the third take')
  assert.equal(f.count('take'), 3)
  assert.equal(f.calls.promptAsync.length, 1)
}))

test('R13 a session that turns busy between the take and the attempt gets no attempt and no wake; the claim returns at the lease and is woken at the next idle', () => fixture(async f => {
  f.guard('ses_r13')
  f.calls.faults.release = ['fail']
  f.calls.faults.take = ['slow']
  f.queue('ses_r13', 'r13-message', 'Synthetic text taken as the session turns busy')
  f.calls.afterStatus = () => { f.calls.busy = { ses_r13: { type: 'busy' } }; f.reported({ session: 'ses_r13', type: 'busy' }) }
  await f.created('ses_r13')
  await f.until(() => f.count('release') === 1 && f.settled(), 'the release was tried and failed')
  assert.equal(f.count('attempt'), 0)
  assert.equal(f.calls.promptAsync.length, 0)
  assert.equal(f.message('r13-message').status, 'uncertain')
  // The lease passes on the board; the session is idle again.
  f.advance(31_000)
  assert.equal(f.message('r13-message').status, 'queued')
  f.calls.busy = null
  await f.idle('ses_r13')
  await f.until(() => f.message('r13-message').status === 'accepted' && f.settled(), 'the message was woken at the next idle')
  assert.equal(f.calls.promptAsync.length, 1)
}))

test('R14 an idle event right after a wake and before any busy event is not sent into the gap; it goes after busy then idle, or after the settle wait', () => fixture(async f => {
  f.queue('ses_r14', 'r14-first', 'Synthetic first text')
  await f.created('ses_r14')
  await f.until(() => f.message('r14-first').status === 'accepted' && f.settled(), 'the first message was woken')
  await f.hooks.tool.agent_board_ack.execute({ id: 'r14-first', nonce: f.message('r14-first').nonce }, { sessionID: 'ses_r14' })
  f.queue('ses_r14', 'r14-second', 'Synthetic second text')
  const takes = f.count('take')
  f.guard('ses_r14')
  await f.idle('ses_r14')
  await wait(80)
  assert.equal(f.count('take'), takes, 'nothing was taken into the gap')
  assert.equal(f.message('r14-second').status, 'queued')
  // The turn runs and ends: busy then idle.
  await f.reported({ session: 'ses_r14', type: 'busy' })
  await f.idle('ses_r14')
  await f.until(() => f.message('r14-second').status === 'accepted' && f.settled(), 'the second message was woken after busy then idle')
  // A turn so short that no busy event comes: the settle wait ends, the session is asked, and the next message goes.
  await f.hooks.tool.agent_board_ack.execute({ id: 'r14-second', nonce: f.message('r14-second').nonce }, { sessionID: 'ses_r14' })
  f.queue('ses_r14', 'r14-third', 'Synthetic third text')
  await f.idle('ses_r14')
  await f.until(() => f.message('r14-third').status === 'accepted' && f.settled(), 'the third message was woken after the settle wait')
  assert.equal(f.calls.promptAsync.length, 3)
}))

test('R15 a lost idle event is healed by the tick, which asks the host and wakes', () => fixture(async f => {
  const ticks = []
  const real = globalThis.setInterval
  globalThis.setInterval = (run, ms, ...rest) => { ticks.push(run); return real(run, ms, ...rest) }
  try { await f.reported({ session: 'ses_r15', type: 'busy' }) } finally { globalThis.setInterval = real }
  f.queue('ses_r15', 'r15-message', 'Synthetic text after a lost idle event')
  await wait(200)
  assert.equal(f.calls.promptAsync.length, 0)
  ticks[0]()
  await f.until(() => f.message('r15-message').status === 'accepted' && f.settled(), 'the tick found the session idle and woke it')
}))

test('R16 a new plugin instance on a board that holds a marked message wakes nothing for it', () => fixture(async f => {
  f.calls.prompts.push(f.prompts.lost)
  f.queue('ses_r16', 'r16-message', 'Synthetic text for a restart')
  await f.created('ses_r16')
  await f.until(() => f.calls.promptAsync.length === 1 && f.settled(), 'the first instance made the wake')
  await f.rebuild()
  await f.created('ses_r16')
  await f.idle('ses_r16')
  await wait(400)
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.message('r16-message').status, 'uncertain')
}))

test('R17 an end that fails once is tried again and reported once', () => fixture(async f => {
  f.calls.faults.end = ['fail']
  await f.created('ses_r17')
  await f.until(() => f.count('take') === 1 && f.settled(), 'the mailbox was opened')
  await f.deleted('ses_r17')
  await f.until(() => f.count('end') === 2 && f.settled(), 'the end was tried again')
  await wait(100)
  assert.equal(f.count('end'), 2)
  assert.ok(!(f.store().mailboxes ?? []).some(one => one.session === 'ses_r17'), 'the mailbox is closed')
  const log = join(f.home, '.agent-board', 'hook-errors.log')
  assert.equal((existsSync(log) ? readFileSync(log, 'utf8') : '').split('MAILBOX_FAILED').length - 1, 1)
}))

test('the card says sent, not confirmed in all three languages, and the page asks for it', async () => {
  const { STRINGS } = await importTs('../hooks/strings.ts')
  const texts = Object.values(STRINGS).map(one => one.messagesSentUnconfirmed)
  for (const text of texts) assert.ok(typeof text === 'string' && text.length > 8)
  assert.equal(new Set(texts).size, 3)
  const page = readFileSync(new URL('../hooks/serve.ts', import.meta.url), 'utf8')
  assert.ok(page.includes("'messagesSentUnconfirmed'") && page.includes("receipt.error === 'UNCONFIRMED'"))
})

test('the agent_board_ack tool takes no summary as well as one', () => fixture(async f => {
  const ack = f.hooks.tool.agent_board_ack
  assert.deepEqual(Object.keys(ack.args).sort(), ['id', 'nonce', 'summary'])
  assert.equal(ack.args.summary.isOptional, true)
  assert.equal(ack.args.id.isOptional, undefined)
  assert.equal(await ack.execute({ id: 'nobody', nonce: 'ffffff' }, { sessionID: 'ses_none' }).catch(error => error.message), 'AGENT_BOARD_ACK_FAILED: NO_SESSION')
}))

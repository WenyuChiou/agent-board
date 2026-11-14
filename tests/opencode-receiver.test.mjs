import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { registerHooks, createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
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
// Short deadlines for the receiver's own clocks, so a test that waits out a hung call or the settle wait takes
// milliseconds. The board script's own calls are not run in this mode, so none of them is cut short.
// The plugin's 30-second tick is never waited for: the plugin's setInterval is a stand-in here, and a test runs the tick itself.
const FAST = { hostMs: 120, boardMs: 200, settleMs: 300 }

// The plugin OpenCode would load, with a stand-in client that records what the plugin asks of OpenCode, and a
// mailbox folder under a temporary home. By default the board is stood in for by the board's own mailbox
// functions, called in this process on the same messages.json (so there is no process per call, and a test can
// delay, lose or refuse an answer, and move the board's clock). With { spawn: true } every call runs the real
// board script, as OpenCode's plugin does.
const fixture = async (fn, { spawn: isSpawn = false, timing = {}, watch: isWatching = true } = {}) => {
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
    // broken: faults that last until a test mends them (deletes the entry), by the name of the call: a host method, a board
    // action, or 'report' (the plugin's --agent-status report, which gives a session its card). reports: every call the plugin
    // made of its worker, with whether the report was saved.
    const calls = { promptAsync: [], status: [], sent: [], lookups: 0, board: [], atWake: [], faults: {}, prompts: [], answers: [], cwds: [], gets: 0, broken: {}, reports: [], hold: {}, noFolder: false, reached: [] }
    // The plugin's interval timers: nothing runs them but tick().
    const intervals = new Set()
    const fakeSetInterval = (run, ms) => { const one = { run, ms, unref() {} }; intervals.add(one); return one }
    const fakeClearInterval = one => { intervals.delete(one) }
    const tick = () => { for (const one of [...intervals]) one.run() }
    // Waits until no call is running and no call has started for a moment.
    const quiet = async () => {
      let last = ''
      for (const end = Date.now() + 15_000; Date.now() < end;) {
        await wait(70)
        const now = `${calls.board.length}/${calls.status.length}/${calls.promptAsync.length}/${calls.gets}/${calls.reports.length}`
        if (running.size === 0 && now === last) return
        last = now
      }
      assert.fail('the receiver did not go quiet')
    }
    const sessions = new Map()
    const code = error => error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'BOARD_NOT_RUNNING'
    // The board script's --mailbox actions, each worked out from the same functions the script runs. R33 gives every one of
    // them a row, so an action cannot be added here without one.
    const BOARD = {
      take: (run, base, at) => {
        const taken = run('mailbox-turn', { ...base, surface: 'CLI', ref: at('--ref') }).message
        return { watch: directory, message: taken === null ? null : { id: taken.id, nonce: taken.nonce, text: deliveryText(taken, STRINGS.en), summary: '' } }
      },
      attempt: (run, base, at) => run('mailbox-attempt', { ...base, ref: at('--ref') }),
      release: (run, base, at, args) => run('mailbox-release', { ...base, ref: at('--ref'), ...(args.includes('--unsent') ? { unsent: true } : {}) }),
      accept: (run, base, at, args) => run('mailbox-accept', { ...base, id: at('--id'), nonce: at('--nonce'), awaitsAck: args.includes('--awaits-ack') }),
      ack: (run, base, at) => {
        const summary = at('--summary-b64')
        return run('mailbox-ack', { ...base, id: at('--id'), nonce: at('--nonce'), reply: `ACK ${at('--nonce')}${summary ? ` ${Buffer.from(summary, 'base64').toString('utf8')}` : ''}` })
      },
      end: (run, base) => run('mailbox-end', base),
      open: (run, base) => run('mailbox-open', { ...base, surface: 'CLI' }),
    }
    // The board script's answer to one --mailbox call.
    const answerOf = (action, args) => {
      const at = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
      const base = { agent: 'opencode', session: at('--session') }
      const now = clock.now()
      const run = (name, body) => { const out = mailboxAction(readState(), name, body, now); writeState(out.state); return out.result }
      if (!Object.hasOwn(BOARD, action)) return { ok: false, code: 'INVALID_MAILBOX_CALL' }
      // A board that has not made its messages folder yet: an open enrolls nothing and a take finds nothing, as the board script answers.
      if (calls.noFolder && !existsSync(directory)) {
        if (action === 'open') return { ok: true, enrolled: false, watch: directory }
        if (action === 'take') return { watch: directory, message: null }
      }
      try {
        const answer = BOARD[action](run, base, at, args)
        return action === 'take' ? answer : action === 'open' ? { ok: true, enrolled: true, watch: directory } : { ok: true }
      } catch (error) { return { ok: false, code: code(error), ...(action === 'take' ? { watch: directory, message: null } : {}) } }
    }
    const spawnBoard = (...args) => {
      const action = args[1]?.[2]
      const canned = (calls.canned?.[action] ?? 0) > 0
      if (canned) calls.canned[action] -= 1
      calls.board.push(action)
      calls.cwds.push({ action, cwd: args[1][args[1].indexOf('--cwd') + 1] })
      const broken = calls.broken[action]
      if (broken !== undefined) calls.reached.push(`${action} ${broken}`)
      // The board script cannot even be started.
      if (!isSpawn && broken === 'throw') throw new Error('spawn failed')
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
        const fault = canned ? 'fail' : broken ?? calls.faults[action]?.shift()
        if (fault === 'hang') return
        if (fault === 'fail' || fault === 'error') return finish(0, { ok: false, code: 'BOARD_NOT_RUNNING', watch: directory, message: null })
        // The script ends without a line.
        if (fault === 'empty') return finish(0)
        // The board answers, but only after the session had time to change.
        if (fault === 'slow') return void setTimeout(() => finish(0, answerOf(action, args[1])), 40)
        const answer = answerOf(action, args[1])
        // The call was applied on the board, but its answer never reached the plugin.
        if (fault === 'lose') return finish(1)
        // The call was applied, and its answer comes only when a test opens the gate (calls.hold[action]); a test that holds a call
        // names a boardMs long enough to outlast it.
        const gate = calls.hold[action]
        if (gate) { calls.hold[action] = null; return void gate.then(() => finish(0, answer)) }
        finish(0, answer)
      })
      return child
    }
    const settled = () => running.size === 0
    let receiverOf = () => null
    const until = async (check, label) => {
      for (const end = Date.now() + 15_000; Date.now() < end; await wait(10)) if (check()) return
      assert.fail(label)
    }
    const client = {
      session: {
        get: async ({ path }) => {
          calls.gets += 1
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
          if (calls.fail) return { error: { name: 'Failed' }, response: { status: 400 } }
          if (calls.neverArrives) throw new Error('answer lost')
          // The wake reached the session, but its answer was lost on the way back.
          calls.sent.push(options.body.parts[0].text)
          if (calls.lostAnswer) throw new Error('answer lost')
          return { data: undefined }
        },
      },
    }
    // A host method given a lasting fault (calls.broken): throw fails at once; hang answers only after the plugin's own deadline
    // for that call (the hook's two seconds for a lookup, hostMs for the others); error is an error answer (400 for a wake);
    // empty is an answer with no data; lose, for a wake, reaches the session and loses the answer. A faulted call is counted
    // as any other and runs until it settles, so quiet() waits for it.
    const HANG_MS = { get: 2300, messages: 2300, status: 400, promptAsync: 400 }
    const late = { get: options => ({ data: { id: options.path.id, ...(sessions.get(options.path.id) ?? {}) } }), messages: () => ({ data: [] }), status: () => ({ data: {} }), promptAsync: () => ({ data: undefined }) }
    for (const [name, real] of Object.entries(client.session)) client.session[name] = async options => {
      const fault = calls.broken[name]
      if (fault === undefined) return real(options)
      calls.reached.push(`${name} ${fault}`)
      const token = {}
      running.add(token)
      try {
        if (name === 'get') calls.gets += 1
        else if (name === 'status') calls.status.push(1)
        else if (name === 'messages') calls.lookups += 1
        else calls.promptAsync.push(options)
        if (fault === 'hang') await wait(HANG_MS[name])
        if (name === 'promptAsync' && (fault === 'hang' || fault === 'lose')) calls.sent.push(options.body.parts[0].text)
        if (fault === 'throw' || fault === 'lose') throw new Error(`${name} failed`)
        if (fault === 'error') return { error: { name: 'Failed' }, response: { status: 400 } }
        if (fault === 'empty') return { data: name === 'status' ? null : undefined }
        return late[name](options)
      } finally { running.delete(token) }
    }
    // The plugin's worker: a progress report (--agent-status) is recorded, and given the fault calls.broken.report names.
    const reporter = (_node, args, options) => {
      const mode = args[3]
      let payload = {}
      try { payload = JSON.parse(options.input) } catch {}
      const fault = mode === '--agent-status' ? calls.broken.report : undefined
      if (fault !== undefined) calls.reached.push(`report ${fault}`)
      calls.reports.push({ mode, session: payload.session_id, state: payload.state, isSaved: fault === undefined })
      if (fault === 'throw') throw new Error('spawn failed')
      if (fault === 'hang') return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null, stdout: '', stderr: '' }
      if (fault === 'error') return { status: 1, stdout: '', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    }
    // The saved progress reports of a session, other than its end: a session with one has a card on the board.
    const cards = session => calls.reports.filter(one => one.mode === '--agent-status' && one.session === session && one.isSaved && one.state !== 'ended').length
    const prompts = {
      // The host refuses the wake: proof it was not sent.
      refuse: () => ({ error: { name: 'Failed' }, response: { status: 400 } }),
      // The host answered with an error that does not prove the message was not sent.
      http: status => () => ({ error: { name: 'Failed' }, response: { status } }),
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
      // A test of the tick alone watches nothing, so no board write of its own wakes the receiver.
      if (!isWatching) return { on() {}, close() {} }
      const watcher = watch(...args)
      const close = watcher.close.bind(watcher)
      watcher.close = () => { watcher.isClosed = true; return close() }
      watchers.push(watcher)
      return watcher
    }
    const names = ['createRequire', 'spawnSync', 'tool', 'spawnBoard', 'readBoardStore', 'watchBoard', 'joinBoard', 'boardFolderExists', 'setInterval', 'clearInterval']
    const build = async () => {
      if (!isSpawn) globalThis[TIMING_KEY] = { ...FAST, ...timing }
      try {
        const factory = new Function(...names, `${source.replace(/^import .*\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)).replace('export default', 'const plugin =').replace(/^export /gm, '')}\nreturn { plugin: AgentBoardLocal, receiver: () => typeof receivers === 'undefined' ? receiver : [...receivers.values()][0], hostCall: typeof hostCall === 'undefined' ? undefined : hostCall }`)(createRequire, reporter, tool, spawnBoard, readFileSync, watchBoard, join, existsSync, fakeSetInterval, fakeClearInterval)
        const hooks = await factory.plugin({ client, directory: home })
        receiverOf = factory.receiver
        return { hooks, receiver: factory.receiver, plugin: factory.plugin, hostCall: factory.hostCall }
      } finally { delete globalThis[TIMING_KEY] }
    }
    let { hooks, plugin, hostCall } = await build()
    const reported = state => hooks.event({ event: { type: 'session.status', properties: { sessionID: state.session, status: { type: state.type } } } })
    const idle = session => hooks.event({ event: { type: 'session.idle', properties: { sessionID: session } } })
    const created = session => hooks.event({ event: { type: 'session.created', properties: { info: { id: session } } } })
    const deleted = session => hooks.event({ event: { type: 'session.deleted', properties: { info: { id: session } } } })
    // A prompt submitted in the session: OpenCode's chat.message hook.
    const chat = session => hooks['chat.message']({ sessionID: session }, {})
    // The receiver's own state change, with no event handler (and so no reply capture) around it.
    const note = (session, state) => receiverOf().note(session, state)
    const rebuild = async () => { ({ hooks, plugin } = await build()); return hooks }
    // The calls a fault can be given: the stand-in host's methods and the stand-in board's actions.
    const methods = { host: Object.keys(client.session), board: Object.keys(BOARD) }
    // The board's store as a test reads and changes it: a session's mailbox entry, its time left, a folder that appears later.
    const mailbox = session => { try { return (store().mailboxes ?? []).find(one => one.agent === 'opencode' && one.session === session) } catch { return undefined } }
    const makeFolder = () => save(file, JSON.stringify({ version: 2, messages: [] }))
    const reshape = (session, change) => { const state = store(); writeFileSync(file, JSON.stringify({ ...state, mailboxes: change(state.mailboxes ?? [], session) })) }
    const shorten = (session, left) => reshape(session, (all, id) => all.map(one => one.session === id ? { ...one, expires: Date.now() + left } : one))
    const unmailbox = session => reshape(session, (all, id) => all.filter(one => one.session !== id))
    const f = { hostCall, mailbox, makeFolder, shorten, unmailbox, tick, quiet, home, board, progress, directory, calls, sessions, queue, message, store, until, settled, reported, idle, created, deleted, chat, note, save, watchers, advance, clock, prompts, rebuild, cards, methods, plugin: options => plugin(options), receiver: () => receiverOf(), count: action => calls.board.filter(one => one === action).length }
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

test('opencodePlugin wakes an idle session through client.session.promptAsync and binds ack to context.sessionID', () => fixture(async f => {
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
  const { agent_board_ack: ack } = f.hooks.tool
  assert.deepEqual(Object.keys(f.hooks.tool).filter(name => name.startsWith('agent_board_')).sort(), ['agent_board_ack', 'agent_board_progress'])
  assert.deepEqual(Object.keys(ack.args).sort(), ['id', 'nonce', 'summary'])
  await assert.rejects(ack.execute({ id: 'wake-message-1', nonce, session: 'ses_idle' }, { sessionID: 'ses_other' }), /NO_SESSION/)
  await assert.rejects(ack.execute({ id: 'wake-message-1', nonce, session: 'ses_idle' }, {}), /NO_SESSION/)
  await assert.rejects(ack.execute({ id: 'wake-message-1', nonce: 'zzzzzz' }, { sessionID: 'ses_idle' }), /INVALID_ARGUMENTS/)
  assert.equal(f.message('wake-message-1').status, 'accepted')
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
  f.tick()
  await f.until(() => f.calls.promptAsync.length >= 3 && f.settled(), 'the tick tried the second wake again')
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
  for (const [lang, strings] of Object.entries(STRINGS)) for (const key of ['opencodeAckTool', 'opencodeAcknowledged', 'opencodeAckNote']) assert.equal(typeof strings[key], 'string', `${lang} ${key}`)
  const source = local.opencodePlugin(process.execPath, 'worker.mjs', 'progress.md', 'Progress', 'home', undefined, 'board.mjs', STRINGS['zh-TW'])
  assert.ok(source.includes(JSON.stringify(STRINGS['zh-TW'].opencodeAcknowledged)))
  assert.ok(source.includes(JSON.stringify(STRINGS['zh-TW'].opencodeAckTool)))
  assert.ok(!source.includes('Acknowledged.'))
})

// Delivery that does not depend on the receiver's own guesses (#724): the host's status and the board's store decide.

test('opencodePlugin takes again at the next tick after a failed take, with no event and no board write, and then wakes the session', () => fixture(async f => {
  f.calls.canned = { take: 1 }
  f.queue('ses_retake', 'retake-message-1', 'Synthetic text after a failed take')
  await f.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_retake' } } } })
  await f.until(() => f.calls.canned.take === 0 && f.settled(), 'the first take answered with a failure')
  await f.quiet()
  assert.equal(f.calls.promptAsync.length, 0)
  f.tick()
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('retake-message-1').status === 'accepted' && f.settled(), 'the tick took again and the session was woken')
}, { watch: false }))

test('opencodePlugin gives up a host status lookup that never answers, so the session is not left locked and its message is woken at the next tick (#1366 review)', () => fixture(async f => {
  await f.created('ses_hung')
  await f.quiet()
  f.queue('ses_hung', 'hung-message-1', 'Synthetic text while the host does not answer')
  // The first lookup never settles; the ones after it answer.
  f.calls.gate = new Promise(() => {})
  await f.idle('ses_hung')
  await f.until(() => f.calls.status.length >= 2, 'the host status was asked')
  f.calls.gate = null
  await f.quiet()
  assert.equal(f.calls.promptAsync.length, 0)
  f.tick()
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('hung-message-1').status === 'accepted' && f.settled(), 'the hung lookup was given up and the session woken at a tick')
}, { watch: false }))

test('opencodePlugin looks again at the next tick after a failed host status lookup, with no further event or board write', () => fixture(async f => {
  await f.created('ses_status_retry')
  await f.quiet()
  f.queue('ses_status_retry', 'status-retry-message-1', 'Synthetic text after a failed status lookup')
  f.calls.statusFails = true
  await f.idle('ses_status_retry')
  await f.until(() => f.calls.status.length >= 2 && f.settled(), 'the host status was asked and failed')
  await f.quiet()
  f.calls.statusFails = false
  assert.equal(f.calls.promptAsync.length, 0)
  assert.equal(f.message('status-retry-message-1').status, 'queued')
  f.tick()
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('status-retry-message-1').status === 'accepted' && f.settled(), 'the status was asked again at the tick and the session woken')
}, { watch: false }))

test('--mailbox take for OpenCode answers ok false with a code while the store is held, and plain message null for an empty mailbox', () => fixture(async f => {
  const { claimMessageStore } = await importTs('../scripts/message-store-claim.ts')
  f.queue('ses_take_cli', 'take-cli-message-1', 'Synthetic text for the take answers')
  const call = (action, extra = []) => {
    const result = spawnSync(process.execPath, [f.board, '--mailbox', action, '--agent', 'opencode', '--home', f.home, '--progress-file', f.progress, '--session', 'ses_take_cli', '--surface', 'CLI', ...extra], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
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
  // With the store free the message is taken, and once its wake is marked what is left is an empty mailbox, which is not a failure.
  const ref = 'a1b2c3d4e5f6'
  assert.equal(call('take', ['--ref', ref]).message.id, 'take-cli-message-1')
  assert.deepEqual(call('attempt', ['--ref', ref]), { ok: true })
  const empty = call('take')
  assert.equal(empty.message, null)
  assert.equal('ok' in empty, false)
  assert.equal(typeof empty.watch, 'string')
}, { spawn: true }))

test('opencodePlugin wakes a session whose idle event was lost at the next tick, because the host lists no entry for it', () => fixture(async f => {
  await f.created('ses_lost_idle')
  await f.quiet()
  await f.reported({ session: 'ses_lost_idle', type: 'busy' })
  f.queue('ses_lost_idle', 'lost-idle-message-1', 'Synthetic text after a lost idle event')
  // The idle event is dropped: its session lookup fails.
  f.calls.getFails = true
  await f.idle('ses_lost_idle').catch(() => {})
  f.calls.getFails = false
  await wait(500)
  assert.equal(f.calls.promptAsync.length, 0)
  f.tick()
  await f.until(() => f.calls.promptAsync.length === 1 && f.message('lost-idle-message-1').status === 'accepted' && f.settled(), 'the tick found the session idle and gave the message')
}, { watch: false }))


// The board's side of an OpenCode wake (#1366): one wake at most for a message, and "sent, not confirmed" when the
// outcome of a wake cannot be known. These are the board's own functions with the time passed in.
const T0 = 1_800_000_000_000
const SEC = 1000
const MIN = 60 * SEC
// The board's mailbox lifetime (12 hours).
const LIFETIME = 12 * 60 * MIN
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
  // A late accept is recorded, and the message stays "sent, not confirmed": it does not hold the next message again (#1366 review).
  const accepted = b.act(late, 'mailbox-accept', { agent: 'opencode', session: 's1', id: 'm1', nonce, awaitsAck: true }, T0 + 32 * MIN).state
  assert.deepEqual([accepted.messages[0].status, accepted.messages[0].error, accepted.messages[0].hasAccepted, accepted.messages[0].updated], ['uncertain', 'UNCONFIRMED', true, late.messages[0].updated])
  const acked = b.act(late, 'mailbox-ack', { agent: 'opencode', session: 's1', id: 'm1', nonce, reply: `ACK ${nonce} done` }, T0 + 32 * MIN).state
  assert.equal(acked.messages[0].status, 'acknowledged')
})

test('B15 an accept saved after the wake read "sent, not confirmed" does not hold the next message of the session, which is handed out (#1366 review)', async () => {
  const b = await mailbox()
  const taken = b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0)
  const nonce = taken.message.nonce
  const marked = b.act(taken.state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + SEC).state
  const late = b.prune(marked, T0 + 31 * MIN)
  const accepted = b.act(late, 'mailbox-accept', { agent: 'opencode', session: 's1', id: 'm1', nonce, awaitsAck: true }, T0 + 32 * MIN).state
  const box = accepted.mailboxes.find(one => one.agent === 'opencode' && one.session === 's1')
  const queued = b.messaging.queueMessage(accepted, { id: 'm2', target: box.id, turn: 'session', text: 'Synthetic second message' }, 'board', box, T0 + 32 * MIN).state
  // The pruning that follows leaves it as it is, and the next message goes out.
  const next = b.take(b.prune(queued, T0 + 33 * MIN), 'opencode', 's1', refOf(2), T0 + 33 * MIN)
  assert.equal(next.message?.id, 'm2')
  const first = next.state.messages.find(one => one.id === 'm1')
  assert.deepEqual([first.status, first.error, first.hasAccepted, first.text], ['uncertain', 'UNCONFIRMED', true, 'Synthetic text for the board cases'])
  // A day after it read "sent, not confirmed" (not after the accept) it expires and its text goes.
  const gone = b.prune(next.state, T0 + 31 * MIN + 1441 * MIN).messages.find(one => one.id === 'm1')
  assert.deepEqual([gone.status, gone.error, gone.text], ['uncertain', 'EXPIRED', ''])
})

test('B16 a deletion that follows a saved attempt, before the reply reaches the receiver, keeps the wake as "sent, not confirmed" for the day (#1366 review)', async () => {
  const b = await mailbox()
  const taken = b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0)
  const marked = b.act(taken.state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + SEC).state
  const ended = b.act(marked, 'mailbox-end', { agent: 'opencode', session: 's1' }, T0 + 2 * SEC).state
  assert.equal((ended.mailboxes ?? []).length, 0)
  assert.deepEqual([ended.messages[0].status, ended.messages[0].error], ['uncertain', ''])
  // At the open limit it reads "sent, not confirmed" with its text, instead of expiring then.
  const late = b.prune(ended, T0 + 31 * MIN)
  assert.deepEqual([late.messages[0].status, late.messages[0].error, late.messages[0].text], ['uncertain', 'UNCONFIRMED', 'Synthetic text for the board cases'])
  assert.equal(b.prune(late, T0 + 31 * MIN + 1439 * MIN).messages[0].error, 'UNCONFIRMED')
  const gone = b.prune(late, T0 + 31 * MIN + 1441 * MIN).messages[0]
  assert.deepEqual([gone.status, gone.error, gone.text], ['uncertain', 'EXPIRED', ''])
  // One that already read "sent, not confirmed" when the session was deleted keeps its day as well.
  const after = b.act(late, 'mailbox-end', { agent: 'opencode', session: 's1' }, T0 + 32 * MIN).state
  assert.deepEqual([after.messages[0].error, after.messages[0].text], ['UNCONFIRMED', 'Synthetic text for the board cases'])
  assert.equal(b.prune(after, T0 + 31 * MIN + 1439 * MIN).messages[0].text, 'Synthetic text for the board cases')
  // A message nobody marked is still turned away by the deletion.
  const unmarked = b.act(b.take(b.seed('opencode', 's2'), 'opencode', 's2', refOf(3), T0).state, 'mailbox-end', { agent: 'opencode', session: 's2' }, T0 + SEC).state
  assert.deepEqual([unmarked.messages[0].status, unmarked.messages[0].error], ['uncertain', 'DISCONNECTED'])
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
  f.queue('ses_r1', 'r1-message', 'Synthetic text for the normal path')
  await f.created('ses_r1')
  await f.until(() => f.message('r1-message').status === 'accepted' && f.settled(), 'the message was woken and accepted')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(typeof f.calls.atWake[0].find(one => one.id === 'r1-message').attempted, 'number', 'the mark was saved when the host was called')
  assert.deepEqual(f.calls.board, ['take', 'attempt', 'accept'])
  assert.equal(f.calls.lookups, 0)
}))

test('R2 an attempt that answers ok false is followed at once by release --unsent and wakes nothing; each tick takes it again, and the third wakes once', () => fixture(async f => {
  f.calls.faults.attempt = ['fail', 'fail']
  f.queue('ses_r2', 'r2-message', 'Synthetic text while the attempt fails')
  await f.created('ses_r2')
  await f.quiet()
  assert.equal(f.calls.promptAsync.length, 0)
  assert.equal(f.count('release'), 1)
  assert.equal(f.message('r2-message').status, 'queued')
  f.tick()
  await f.quiet()
  assert.equal(f.calls.promptAsync.length, 0)
  assert.equal(f.count('release'), 2)
  f.tick()
  await f.until(() => f.message('r2-message').status === 'accepted' && f.settled(), 'the message was woken after the third attempt')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.count('attempt'), 3)
  assert.equal(f.count('take'), 3, 'each tick took the message again')
}, { watch: false }))

test('R3 an attempt the board applied but whose answer was lost is released as unsent at once, so no mark stays, and the next tick wakes it once', () => fixture(async f => {
  f.calls.faults.attempt = ['lose']
  f.queue('ses_r3', 'r3-message', 'Synthetic text while the attempt answer is lost')
  await f.created('ses_r3')
  await f.quiet()
  const back = f.message('r3-message')
  assert.deepEqual([back.status, back.attempted, back.ref], ['queued', undefined, undefined], 'the board applied the attempt and the release took it back')
  assert.equal(f.calls.promptAsync.length, 0)
  f.tick()
  await f.until(() => f.message('r3-message').status === 'accepted' && f.settled(), 'the next tick woke it')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.count('attempt'), 2)
}, { watch: false }))

test('R4 a host that refuses the wake gives the message back as not sent at once, wakes it again at the next tick, and it arrives once', () => fixture(async f => {
  f.calls.prompts.push(f.prompts.refuse)
  f.queue('ses_r4', 'r4-message', 'Synthetic text for a refused wake')
  await f.created('ses_r4')
  await f.until(() => f.calls.promptAsync.length === 1 && f.settled(), 'the first wake was refused')
  await f.quiet()
  assert.equal(f.count('release'), 1)
  assert.equal(f.message('r4-message').status, 'queued')
  f.tick()
  await f.until(() => f.message('r4-message').status === 'accepted' && f.settled(), 'the message was woken again and accepted')
  assert.equal(f.calls.promptAsync.length, 2)
  assert.equal(f.calls.sent.length, 1, 'it arrived once')
  assert.equal(f.count('release'), 1)
}, { watch: false }))

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

test('R8 an accept that fails three times after a 204 is saved at the ticks that follow, with one wake', () => fixture(async f => {
  f.calls.faults.accept = ['fail', 'fail', 'fail']
  f.queue('ses_r8', 'r8-message', 'Synthetic text while the accept fails')
  await f.created('ses_r8')
  await f.quiet()
  assert.equal(f.message('r8-message').status, 'uncertain', 'the accept was not saved yet')
  for (let round = 0; round < 4 && f.message('r8-message').status !== 'accepted'; round++) { f.tick(); await f.quiet() }
  assert.equal(f.message('r8-message').status, 'accepted', 'the accept was saved at last')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.count('accept'), 4)
}, { watch: false }))

test('R9 a busy status answer that returns after a newer idle event is discarded and asked again, so the message is woken with no further event', () => fixture(async f => {
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

test('R11 a status lookup that fails and then hangs takes nothing, and the next two ticks look again and wake the message', () => fixture(async f => {
  await f.created('ses_r11')
  await f.quiet()
  f.queue('ses_r11', 'r11-message', 'Synthetic text while the status fails and hangs')
  f.calls.answers.push('fail', 'hang')
  await f.idle('ses_r11')
  await f.quiet()
  assert.equal(f.count('take'), 1, 'only the take that opened the mailbox')
  f.tick()
  await f.quiet()
  assert.equal(f.count('take'), 1)
  assert.equal(f.calls.promptAsync.length, 0)
  f.tick()
  await f.until(() => f.message('r11-message').status === 'accepted' && f.settled(), 'the message was woken after the status worked')
  assert.ok(f.calls.status.length >= 4)
  assert.equal(f.calls.promptAsync.length, 1)
}, { watch: false }))

test('R12 a take that answers ok false and then hangs is taken again at the next two ticks, and the message is woken', () => fixture(async f => {
  await f.created('ses_r12')
  await f.quiet()
  f.queue('ses_r12', 'r12-message', 'Synthetic text while the take fails and hangs')
  f.calls.faults.take = ['fail', 'hang']
  await f.idle('ses_r12')
  await f.quiet()
  f.tick()
  await f.quiet()
  assert.equal(f.calls.promptAsync.length, 0)
  f.tick()
  await f.until(() => f.message('r12-message').status === 'accepted' && f.settled(), 'the message was woken after the fourth take')
  assert.equal(f.count('take'), 4)
  assert.equal(f.calls.promptAsync.length, 1)
}, { watch: false }))

test('R13 a session that turns busy between the take and the attempt gets no attempt and no wake; the claim returns at the lease and is woken at the next idle', () => fixture(async f => {
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
  await f.created('ses_r15')
  await f.quiet()
  await f.reported({ session: 'ses_r15', type: 'busy' })
  f.queue('ses_r15', 'r15-message', 'Synthetic text after a lost idle event')
  await wait(200)
  assert.equal(f.calls.promptAsync.length, 0)
  f.tick()
  await f.until(() => f.message('r15-message').status === 'accepted' && f.settled(), 'the tick found the session idle and woke it')
}, { watch: false }))

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

test('R17 an end that fails once is tried again at the next tick and reported once', () => fixture(async f => {
  f.calls.faults.end = ['fail']
  await f.created('ses_r17')
  await f.until(() => f.count('take') === 1 && f.settled(), 'the mailbox was opened')
  await f.deleted('ses_r17')
  await f.until(() => f.count('end') === 1 && f.settled(), 'the end was tried')
  await f.quiet()
  assert.equal(f.count('end'), 1, 'nothing asked again before the tick')
  f.tick()
  await f.until(() => f.count('end') === 2 && f.settled(), 'the end was tried again')
  f.tick()
  await wait(100)
  assert.equal(f.count('end'), 2)
  assert.ok(!(f.store().mailboxes ?? []).some(one => one.session === 'ses_r17'), 'the mailbox is closed')
  const log = join(f.home, '.agent-board', 'hook-errors.log')
  assert.equal((existsSync(log) ? readFileSync(log, 'utf8') : '').split('MAILBOX_FAILED').length - 1, 1)
}, { watch: false }))

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

// Round 2 of the #1366 review.
test('R18 a plugin loaded twice gives each instance its own receiver, so a session wakes through its own client and directory (round 2)', () => fixture(async f => {
  const second = { promptAsync: [] }
  const client2 = { session: {
    get: async ({ path }) => ({ data: { id: path.id } }),
    messages: async () => ({ data: [] }),
    status: async () => ({ data: {} }),
    promptAsync: async options => { second.promptAsync.push(options); return { data: undefined } },
  } }
  const other = join(f.home, 'second-workspace')
  const hooks2 = await f.plugin({ client: client2, directory: other })
  f.queue('ses_two', 'r18-two', 'Synthetic text for the second workspace')
  f.queue('ses_one', 'r18-one', 'Synthetic text for the first workspace')
  await hooks2.event({ event: { type: 'session.created', properties: { info: { id: 'ses_two' } } } })
  await f.until(() => second.promptAsync.length === 1 && f.settled(), 'the second instance woke its session through its own client')
  assert.equal(second.promptAsync[0].path.id, 'ses_two')
  assert.equal(f.calls.promptAsync.length, 0, 'the first client got no call for the second workspace')
  assert.ok(f.calls.cwds.filter(one => one.action === 'take').every(one => one.cwd === other), 'the second workspace asked the board with its own directory')
  await f.created('ses_one')
  await f.until(() => f.calls.promptAsync.length === 1 && f.settled(), 'the first instance woke its session through its own client')
  assert.equal(f.calls.promptAsync[0].path.id, 'ses_one')
  assert.equal(second.promptAsync.length, 1)
  assert.equal(f.calls.cwds.filter(one => one.action === 'take').at(-1).cwd, f.home)
}))

test('R19 an error answer that does not prove the wake was not sent leaves it a started wake with one call (round 2)', () => fixture(async f => {
  f.calls.prompts.push(f.prompts.http(500))
  f.queue('ses_r19', 'r19-message', 'Synthetic text for an error answer after the host may have started')
  await f.created('ses_r19')
  await f.until(() => f.calls.promptAsync.length === 1 && f.settled(), 'the wake was started')
  for (let lease = 0; lease < 2; lease++) {
    f.advance(31_000)
    await f.idle('ses_r19')
    await wait(250)
  }
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.count('release'), 0)
  const kept = f.message('r19-message')
  assert.deepEqual([kept.status, kept.error, kept.attempted !== undefined], ['uncertain', '', true])
}))

test('R20 a 400 answer from the host takes the wake back and the next tick wakes it again once (round 2)', () => fixture(async f => {
  f.calls.prompts.push(f.prompts.http(400))
  f.queue('ses_r20', 'r20-message', 'Synthetic text for a 400 answer')
  await f.created('ses_r20')
  await f.until(() => f.calls.promptAsync.length === 1 && f.settled(), 'the first wake was refused')
  await f.quiet()
  f.tick()
  await f.until(() => f.message('r20-message').status === 'accepted' && f.settled(), 'the message was woken again and accepted')
  assert.equal(f.calls.promptAsync.length, 2)
  assert.equal(f.calls.sent.length, 1)
  assert.equal(f.count('release'), 1)
}, { watch: false }))

test('R21 a session marked busy whose next lookup fails is looked at again at the next tick, and the message is woken with no further event (round 2)', () => fixture(async f => {
  await f.created('ses_r21')
  await f.quiet()
  f.queue('ses_r21', 'r21-message', 'Synthetic text for a busy answer and then a failed lookup')
  f.calls.answers.push('busy', 'fail')
  await f.idle('ses_r21')
  await f.quiet()
  assert.equal(f.calls.promptAsync.length, 0)
  f.tick()
  await f.quiet()
  assert.equal(f.calls.promptAsync.length, 0, 'the lookup at this tick failed')
  f.tick()
  await f.until(() => f.message('r21-message').status === 'accepted' && f.settled(), 'the message was woken after the lookup worked')
  assert.ok(f.calls.status.length >= 4)
  assert.equal(f.calls.promptAsync.length, 1)
}, { watch: false }))

test('R22 a wake the host refused whose release could not be saved for over 30 minutes is still taken back at a tick, and woken once (round 2)', () => fixture(async f => {
  f.calls.prompts.push(f.prompts.refuse)
  f.calls.faults.release = ['fail', 'fail']
  f.queue('ses_r22', 'r22-message', 'Synthetic text for a refused wake whose release failed')
  await f.created('ses_r22')
  await f.until(() => f.calls.promptAsync.length === 1, 'the first wake was refused')
  await f.quiet()
  f.tick()
  await f.quiet()
  assert.equal(f.count('release'), 2)
  f.advance(31 * 60_000)
  f.tick()
  await f.quiet()
  assert.equal(f.message('r22-message').status, 'queued', 'the release saved at last took it back')
  f.tick()
  await f.until(() => f.message('r22-message').status === 'accepted' && f.settled(), 'the message was woken again')
  assert.equal(f.calls.promptAsync.length, 2)
  assert.equal(f.calls.sent.length, 1)
  assert.equal(f.message('r22-message').error, '')
}, { watch: false }))

test('R23 an OpenCode message accepted after a 204 answer and acknowledged by the model after 31 minutes is acknowledged; meanwhile it reads sent, not confirmed (round 2)', () => fixture(async f => {
  f.queue('ses_r23', 'r23-message', 'Synthetic text for a late ack')
  await f.created('ses_r23')
  await f.until(() => f.message('r23-message').status === 'accepted' && f.settled(), 'the message was accepted')
  const nonce = f.message('r23-message').nonce
  f.advance(31 * 60_000)
  const waiting = f.message('r23-message')
  assert.deepEqual([waiting.status, waiting.error, waiting.hasAccepted, waiting.text], ['uncertain', 'UNCONFIRMED', true, 'Synthetic text for a late ack'])
  await f.hooks.tool.agent_board_ack.execute({ id: 'r23-message', nonce }, { sessionID: 'ses_r23' })
  assert.equal(f.message('r23-message').status, 'acknowledged')
  assert.equal(f.calls.promptAsync.length, 1)
}))

test('B10 a repeated attempt answers ok only while the message is an active started wake (round 2)', async () => {
  const b = await mailbox()
  const attempt = (state, now) => b.act(state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, now)
  const marked = attempt(b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0).state, T0 + SEC).state
  assert.equal(attempt(marked, T0 + 2 * SEC).result.ok, true)
  const late = b.prune(marked, T0 + 31 * MIN)
  assert.equal(late.messages[0].error, 'UNCONFIRMED')
  assert.throws(() => attempt(late, T0 + 32 * MIN), /CLAIM_LOST/)
  const dismissed = b.messaging.dismissMessage(marked, 'm1', T0 + 2 * MIN)
  assert.equal(dismissed.messages[0].error, 'DISMISSED')
  assert.throws(() => attempt(dismissed, T0 + 3 * MIN), /CLAIM_LOST/)
})

test('B11 release --unsent also takes back a wake that read "sent, not confirmed", and it is handed out again once (round 2)', async () => {
  const b = await mailbox()
  const marked = b.act(b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0).state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + SEC).state
  const late = b.prune(marked, T0 + 31 * MIN)
  assert.equal(late.messages[0].error, 'UNCONFIRMED')
  const back = b.act(late, 'mailbox-release', { agent: 'opencode', session: 's1', ref: refOf(1), unsent: true }, T0 + 32 * MIN).state
  assert.deepEqual([back.messages[0].status, back.messages[0].error, back.messages[0].ref, back.messages[0].attempted, back.messages[0].claimed], ['queued', '', undefined, undefined, 0])
  const next = b.take(back, 'opencode', 's1', refOf(2), T0 + 32 * MIN)
  assert.equal(next.message?.id, 'm1')
  // A plain release still leaves a message that read "sent, not confirmed" as it is.
  assert.throws(() => b.act(late, 'mailbox-release', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + 32 * MIN), /NOT_HELD/)
})

test('B12 a late ack on an expired message that had been accepted is taken for OpenCode only (round 2)', async () => {
  const b = await mailbox()
  for (const agent of ['opencode', 'codex']) {
    const taken = b.take(b.seed(agent, 's1'), agent, 's1', refOf(1), T0)
    let state = taken.state
    if (agent === 'opencode') state = b.act(state, 'mailbox-attempt', { agent, session: 's1', ref: refOf(1) }, T0 + SEC).state
    const nonce = taken.message.nonce
    state = b.act(state, 'mailbox-accept', { agent, session: 's1', id: 'm1', nonce, awaitsAck: true }, T0 + 2 * SEC).state
    const expired = b.prune(state, T0 + 33 * MIN)
    assert.deepEqual([expired.messages[0].status, expired.messages[0].error, expired.messages[0].hasAccepted], ['uncertain', agent === 'opencode' ? 'UNCONFIRMED' : 'EXPIRED', true])
    const ack = () => b.act(expired, 'mailbox-ack', { agent, session: 's1', id: 'm1', nonce, reply: `ACK ${nonce} done` }, T0 + 34 * MIN).state
    if (agent === 'opencode') assert.deepEqual([ack().messages[0].status, ack().messages[0].error], ['acknowledged', ''])
    else assert.throws(ack, /MESSAGE_EXPIRED/)
  }
})

// Round 3 of the #1366 review: one 30-second tick is the only recovery path, and it decides from the board's file.
test('B13 a new take from the same mailbox gets an OpenCode claim nobody marked at once, and the old ref attempt says CLAIM_LOST (round 3)', async () => {
  const b = await mailbox()
  const first = b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0)
  assert.equal(first.message.id, 'm1')
  // Two seconds later, well inside the lease, the same mailbox asks again.
  const second = b.take(first.state, 'opencode', 's1', refOf(2), T0 + 2 * SEC)
  assert.equal(second.message?.id, 'm1')
  assert.deepEqual([second.message.nonce, second.message.redelivered], [first.message.nonce, undefined])
  assert.ok(!b.messaging.deliveryText(second.message, b.STRINGS.en).includes(b.STRINGS.en.messagesDeliveryRepeat), 'no repeat line')
  assert.deepEqual([second.state.messages[0].ref, second.state.messages[0].status], [refOf(2), 'uncertain'])
  assert.throws(() => b.act(second.state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + 3 * SEC), /CLAIM_LOST/)
  const marked = b.act(second.state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(2) }, T0 + 3 * SEC)
  assert.equal(marked.result.ok, true)
  // A marked claim is never taken over, and another agent's claim keeps its lease.
  assert.equal(b.take(marked.state, 'opencode', 's1', refOf(3), T0 + 4 * SEC).message, null)
  const codex = b.take(b.seed('codex', 's1'), 'codex', 's1', refOf(1), T0)
  assert.equal(b.take(codex.state, 'codex', 's1', refOf(2), T0 + 2 * SEC).message, null)
})

test('B14 an OpenCode message accepted after a 204 with no ack reads "sent, not confirmed" at 30 minutes, keeps its text, and still takes a late ack (round 3)', async () => {
  const b = await mailbox()
  const taken = b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0)
  const nonce = taken.message.nonce
  const marked = b.act(taken.state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + SEC).state
  const accepted = b.act(marked, 'mailbox-accept', { agent: 'opencode', session: 's1', id: 'm1', nonce, awaitsAck: true }, T0 + 2 * SEC).state
  assert.equal(accepted.messages[0].status, 'accepted')
  assert.equal(b.prune(accepted, T0 + 25 * MIN).messages[0].status, 'accepted')
  const late = b.prune(accepted, T0 + 33 * MIN)
  assert.deepEqual([late.messages[0].status, late.messages[0].error, late.messages[0].hasAccepted, late.messages[0].text], ['uncertain', 'UNCONFIRMED', true, 'Synthetic text for the board cases'])
  // It no longer holds the session's next message, and a late ack is still taken.
  const box = late.mailboxes.find(one => one.agent === 'opencode' && one.session === 's1')
  b.messaging.queueMessage(late, { id: 'm2', target: box.id, turn: 'session', text: 'Synthetic second message' }, 'board', box, T0 + 33 * MIN)
  const acked = b.act(late, 'mailbox-ack', { agent: 'opencode', session: 's1', id: 'm1', nonce, reply: `ACK ${nonce} done` }, T0 + 34 * MIN).state
  assert.deepEqual([acked.messages[0].status, acked.messages[0].error], ['acknowledged', ''])
  // A day later it expires like any other open message, and its text goes.
  const gone = b.prune(late, T0 + 33 * MIN + 1441 * MIN).messages[0]
  assert.deepEqual([gone.status, gone.error, gone.text], ['uncertain', 'EXPIRED', ''])
})

test('R24 a take the board saved whose answer was lost is woken at the next tick, with no event and no board write (round 3)', () => fixture(async f => {
  f.calls.faults.take = ['lose']
  f.queue('ses_r24', 'r24-message', 'Synthetic text for a lost take answer')
  await f.created('ses_r24')
  await f.quiet()
  const claimed = f.message('r24-message')
  assert.deepEqual([claimed.status, claimed.attempted, typeof claimed.ref], ['uncertain', undefined, 'string'], 'the board saved the claim')
  assert.equal(f.calls.promptAsync.length, 0)
  assert.equal(f.count('take'), 1, 'nothing asked again before the tick')
  f.tick()
  await f.until(() => f.message('r24-message').status === 'accepted' && f.settled(), 'the tick took the claim over and woke the session')
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.count('take'), 2)
}, { watch: false }))

test('R25 an attempt saved with its answer lost is released as unsent at once; after 31 busy minutes the next idle wakes it once (round 3)', () => fixture(async f => {
  f.calls.faults.attempt = ['lose']
  f.queue('ses_r25', 'r25-message', 'Synthetic text for a lost attempt answer')
  await f.created('ses_r25')
  await f.quiet()
  const back = f.message('r25-message')
  assert.deepEqual([back.status, back.attempted, back.ref], ['queued', undefined, undefined], 'released as unsent, busy or not')
  assert.equal(f.count('release'), 1)
  assert.equal(f.calls.promptAsync.length, 0)
  await f.reported({ session: 'ses_r25', type: 'busy' })
  f.advance(31 * 60_000)
  assert.equal(f.message('r25-message').status, 'queued')
  await f.idle('ses_r25')
  await f.until(() => f.message('r25-message').status === 'accepted' && f.settled(), 'the next idle woke it')
  assert.equal(f.calls.promptAsync.length, 1)
}, { watch: false }))

test('R26 a failed status lookup at the end of the settle wait is looked at again at the next tick, and the follow-up is woken (round 3)', () => fixture(async f => {
  f.queue('ses_r26', 'r26-first', 'Synthetic first text')
  await f.created('ses_r26')
  await f.until(() => f.message('r26-first').status === 'accepted' && f.settled(), 'the first message was woken')
  await f.hooks.tool.agent_board_ack.execute({ id: 'r26-first', nonce: f.message('r26-first').nonce }, { sessionID: 'ses_r26' })
  // The next lookup is the one the settle wait ends with.
  f.calls.answers.push('fail')
  f.queue('ses_r26', 'r26-second', 'Synthetic follow-up text')
  const asked = f.calls.status.length
  await f.until(() => f.calls.status.length > asked && f.settled(), 'the settle wait ended with a status lookup that failed')
  await f.quiet()
  assert.equal(f.calls.promptAsync.length, 1)
  assert.equal(f.message('r26-second').status, 'queued')
  f.tick()
  await f.until(() => f.message('r26-second').status === 'accepted' && f.settled(), 'the tick looked again and woke the follow-up')
  assert.equal(f.calls.promptAsync.length, 2)
}, { watch: false }))

test('R29 with nothing owed a tick spawns no board call and asks the host nothing; a mailbox with less than its lifetime minus ten minutes left is renewed by a take at the next tick (round 3, round 6)', () => fixture(async f => {
  await f.created('ses_r29')
  await f.quiet()
  const board = f.calls.board.length
  const status = f.calls.status.length
  for (let round = 1; round <= 20; round++) { f.tick(); await wait(10) }
  await f.quiet()
  assert.equal(f.calls.board.length, board, 'twenty ticks with nothing owed')
  assert.equal(f.calls.status.length, status)
  f.shorten('ses_r29', 5 * MIN)
  f.tick()
  await f.quiet()
  assert.equal(f.calls.board.length, board + 1, 'the next tick renews the mailbox')
  assert.equal(f.calls.board.at(-1), 'take')
  assert.ok(f.mailbox('ses_r29').expires > Date.now() + LIFETIME - 10 * MIN)
}, { watch: false }))

// Round 4 of the #1366 review (the diagnosis's rules I1-I3): a session is written down before its lookup is awaited, one path
// makes a session known whether an event or the tick found it, and the tick acts unless it has proof there is nothing to do.
test('R30 a new session whose only lookup throws or never answers, or whose only event is chat.message, is looked up again at the next tick and woken with no further event; a subagent found then is let go (round 4)', async () => {
  for (const one of [{ fault: 'throw', start: 'created' }, { fault: 'hang', start: 'created' }, { fault: 'throw', start: 'chat' }]) {
    const name = `${one.fault}, ${one.start}`
    await fixture(async f => {
      f.queue('ses_r30', 'r30-message', 'Synthetic text for a session whose lookup failed')
      f.calls.broken.get = one.fault
      await (one.start === 'chat' ? f.chat('ses_r30') : f.created('ses_r30'))
      await f.quiet()
      delete f.calls.broken.get
      assert.equal(f.count('take'), 0, `${name}: nothing was taken before the tick`)
      const gets = f.calls.gets
      f.tick()
      await f.until(() => f.message('r30-message').status === 'accepted' && f.settled(), `${name}: the tick looked the session up again and woke the message`)
      assert.ok(f.calls.gets > gets, name)
      assert.equal(f.calls.promptAsync.length, 1, name)
    }, { watch: false })
  }
  await fixture(async f => {
    f.sessions.set('ses_r30_child', { parentID: 'ses_r30' })
    f.queue('ses_r30_child', 'r30-child', 'Synthetic text for a subagent')
    f.calls.broken.get = 'throw'
    await f.created('ses_r30_child')
    await f.quiet()
    delete f.calls.broken.get
    f.tick()
    await f.quiet()
    const gets = f.calls.gets
    f.tick()
    await f.quiet()
    assert.equal(f.calls.gets, gets, 'the subagent is not looked up again')
    assert.equal(f.count('take'), 0)
    assert.equal(f.message('r30-child').status, 'queued')
  }, { watch: false })
})

test('R31 a session learned at a tick gets its board card and its place in the open list, and a message queued after that is woken (round 4)', () => fixture(async f => {
  f.calls.broken.get = 'error'
  await f.created('ses_r31')
  await f.quiet()
  delete f.calls.broken.get
  assert.equal(f.cards('ses_r31'), 0)
  f.tick()
  await f.until(() => f.count('take') === 1 && f.settled(), 'the tick learned the session and opened its mailbox')
  assert.ok(f.cards('ses_r31') >= 1, 'the session learned at the tick was reported, so it has a card')
  assert.ok(globalThis[Symbol.for('agent-board.opencode-open-sessions')].has('ses_r31'), 'it is in the open list, so it is ended at exit')
  f.queue('ses_r31', 'r31-message', 'Synthetic text sent once the card is there')
  await f.until(() => f.message('r31-message').status === 'accepted' && f.settled(), 'the message queued after the card was woken')
  assert.equal(f.calls.promptAsync.length, 1)
}))

test('R32 on a new plugin instance, a first status lookup that fails, or that says busy against the idle event, is asked again at the first tick and the message is woken then (round 4)', async () => {
  for (const answer of ['fail', 'busy']) {
    await fixture(async f => {
      f.queue('ses_r32', 'r32-message', 'Synthetic text for a first status lookup')
      f.calls.answers.push(answer)
      await f.created('ses_r32')
      await f.quiet()
      assert.deepEqual([f.calls.status.length, f.count('take'), f.calls.promptAsync.length], [1, 0, 0], answer)
      f.tick()
      await f.until(() => f.message('r32-message').status === 'accepted' && f.settled(), `${answer}: the first tick asked again and woke the message`)
      assert.equal(f.calls.promptAsync.length, 1, answer)
    }, { watch: false })
  }
})

test('R33 for every call the receiver makes and every fault it can meet, with the session idle or busy and the board store holding no folder, no mailbox or a mailbox, the invariants V1 to V5 hold two ticks after the fault is mended (round 4, round 6)', async () => {
  // The faults each call can meet (see the fixture). Every call of the stand-in host and board, and the progress report, has a
  // row, or is ack, which the model calls after the wake, so a call cannot be added to them without one.
  // hang: the call never answers, and the receiver's own deadline for it ends the wait.
  const FAULTS = {
    get: ['throw', 'empty', 'hang'],
    messages: ['throw', 'hang'],
    status: ['throw', 'error', 'hang'],
    promptAsync: ['lose', 'error', 'hang'],
    take: ['throw', 'lose', 'hang'],
    attempt: ['error', 'lose', 'hang'],
    release: ['error', 'lose', 'hang'],
    accept: ['error', 'lose', 'hang'],
    open: ['throw', 'error', 'hang'],
    end: ['throw', 'error', 'hang'],
    report: ['throw', 'hang'],
  }
  const NOT_A_ROW = { ack: 'the model calls it after the wake (R6, R23, R35)' }
  // A call made only for a message waiting is run with a message; an end is made when the session is deleted, with its message waiting.
  const WITH_A_MESSAGE = ['promptAsync', 'attempt', 'release', 'accept', 'end']
  // The calls the receiver makes only in some states of the session, so a fault on them can be met only there: a busy session
  // takes nothing and is never woken (V2); only an idle event makes the plugin look up the reply (messages); only a busy session
  // with no mailbox in the file opens one (open); a busy session is asked about only while something is owed, which is not the
  // case when the board has no folder or the session's mailbox is open and nothing waits (status); an end is made when the
  // session is deleted, in either state. The host's get and messages hang for over two seconds, so they hang for the mailbox
  // store only: what a hang leaves the receiver is what a throw leaves it, which their throw rows check in every store. The
  // session is written down before the get is awaited; at the hook's deadline the hook stops as at a thrown get, and the late
  // answer is dropped by its own deadline check (current), so the tick looks the session up again either way. A messages hang
  // ends at the reply capture's own wait, after which the report goes as after a thrown messages call (#1366 review).
  const ALL = ['none', 'empty', 'mailbox']
  const WHERE = {
    messages: { idle: ALL }, take: { idle: ALL }, promptAsync: { idle: ALL }, attempt: { idle: ALL }, release: { idle: ALL }, accept: { idle: ALL },
    open: { busy: ['none', 'empty'] }, status: { idle: ALL, busy: ['mailbox'] },
    'get hang': { idle: ['mailbox'], busy: ['mailbox'] }, 'messages hang': { idle: ['mailbox'] },
  }
  // By design nobody can know whether these wakes arrived: the message stays a started wake, with one call, never repeated.
  const UNKNOWN = ['promptAsync lose', 'promptAsync hang']
  const session = 'ses_r33', id = 'r33-message'
  // V1 a known session's mailbox is in the board's file with its time left, V2 nothing wakes a busy session, V3 a message arrives
  // at most once, V4 a message waiting for an idle session is woken, V5 an owed accept or release is saved. Read from the board's
  // file and the call log alone.
  const assertInvariants = (f, { name, isBusy, hasMessage, isUnknown }) => {
    const problems = []
    if (!(f.mailbox(session)?.expires > Date.now() + LIFETIME - 10 * MIN)) problems.push(`${name}: V1 no mailbox with its time left`)
    if (isBusy && f.calls.promptAsync.length > 0) problems.push(`${name}: V2 woken while busy`)
    if (f.calls.sent.length > 1) problems.push(`${name}: V3 arrived ${f.calls.sent.length} times`)
    if (hasMessage && !isBusy) {
      const one = f.message(id)
      if (isUnknown) { if (f.calls.promptAsync.length !== 1 || one.attempted === undefined) problems.push(`${name}: V3 ${f.calls.promptAsync.length} wake calls, attempted ${one.attempted}`) }
      else if (one.status !== 'accepted' || f.calls.sent.length !== 1) problems.push(`${name}: V4 V5 not woken and accepted: ${JSON.stringify({ status: one.status, error: one.error, sent: f.calls.sent.length })}`)
    }
    return problems
  }
  let methods
  await fixture(async f => { methods = f.methods })
  for (const call of [...methods.host, ...methods.board, 'report']) assert.ok(call in FAULTS || call in NOT_A_ROW, `${call} has no row`)
  const problems = []
  const settle = async (f, ticks) => { for (let round = 0; round < ticks; round++) { f.tick(); await f.quiet() } }
  for (const [call, faults] of Object.entries(FAULTS)) for (const fault of faults) for (const state of ['idle', 'busy']) for (const start of WITH_A_MESSAGE.includes(call) ? ['mailbox'] : ['none', 'empty', 'mailbox']) {
    const where = { ...WHERE[call], ...WHERE[`${call} ${fault}`] }
    if (!(where[state] ?? (WHERE[call] === undefined ? ALL : [])).includes(start)) continue
    const name = `${call} ${fault}, ${state}, store ${start}`
    const isBusy = state === 'busy', hasMessage = start === 'mailbox', isEnd = call === 'end'
    await fixture(async f => {
      // none: the board has not made its folder; empty: it has, with no mailbox; mailbox: the session is known and its mailbox is open.
      if (start === 'none') f.calls.noFolder = true
      if (start === 'empty') f.makeFolder()
      if (hasMessage) { await f.created(session); await f.quiet(); f.queue(session, id, 'Synthetic text for the matrix') }
      // A release is called only for a wake the host refused.
      if (call === 'release' && !isBusy) f.calls.prompts.push(f.prompts.refuse)
      f.calls.broken[call] = fault
      if (isBusy) f.calls.busy = { [session]: { type: 'busy' } }
      // An end is made by deleting the session, once it is in the state under test; the reply lookup only by an idle event.
      if (isEnd && isBusy) { await f.reported({ session, type: 'busy' }); await f.quiet() }
      await (isEnd ? f.deleted(session) : isBusy ? f.reported({ session, type: 'busy' }) : hasMessage || call === 'messages' ? f.idle(session) : f.created(session))
      await f.quiet()
      // A tick while the fault lasts, then the fault is mended and the board's folder appears.
      await settle(f, 1)
      // The fault was injected: the call was made while it lasted (an unreached fault would leave the row testing nothing).
      if (!f.calls.reached.includes(`${call} ${fault}`)) problems.push(`${name}: the fault was never reached`)
      delete f.calls.broken[call]
      if (start === 'none') f.makeFolder()
      await settle(f, 2)
      if (isEnd) {
        // The deleted session's mailbox is gone, its waiting message is turned away, and nothing wakes it.
        if (f.mailbox(session) !== undefined) problems.push(`${name}: the deleted session's mailbox is still on the board`)
        if (f.message(id)?.status !== 'rejected' || f.calls.promptAsync.length > 0) problems.push(`${name}: the waiting message was not turned away, or a wake was made: ${JSON.stringify(f.message(id))}`)
        return
      }
      problems.push(...assertInvariants(f, { name, isBusy, hasMessage, isUnknown: UNKNOWN.includes(`${call} ${fault}`) }))
      if (isBusy) {
        delete f.calls.busy
        await f.idle(session)
        await f.quiet()
        await settle(f, 2)
        problems.push(...assertInvariants(f, { name: `${name}, then idle`, isBusy: false, hasMessage, isUnknown: false }))
      }
    }, { timing: { settleMs: 40 }, watch: false })
  }
  assert.deepEqual(problems, [])
})

test('R34 a session whose lookup keeps failing is looked up 20 times at the ticks, then let go, and that is logged once (round 4)', () => fixture(async f => {
  f.calls.getFails = true
  await f.created('ses_r34')
  await f.quiet()
  const first = f.calls.gets
  for (let round = 0; round < 25; round++) { f.tick(); await f.quiet() }
  assert.equal(f.calls.gets - first, 20)
  const log = join(f.home, '.agent-board', 'hook-errors.log')
  assert.equal((existsSync(log) ? readFileSync(log, 'utf8') : '').split('HOST_METADATA_FAILED').length - 1, 1)
}, { watch: false }))

test('R35 an agent_board_ack with a summary is saved through the real board script (round 4)', () => fixture(async f => {
  f.queue('ses_r35', 'r35-message', 'Synthetic text for an ack with a summary')
  await f.created('ses_r35')
  await f.until(() => f.message('r35-message').status === 'accepted' && f.settled(), 'the message was woken and accepted')
  const nonce = f.message('r35-message').nonce
  assert.equal(await f.hooks.tool.agent_board_ack.execute({ id: 'r35-message', nonce, summary: 'Synthetic summary' }, { sessionID: 'ses_r35' }).catch(error => error.message), 'Acknowledged.')
  assert.deepEqual([f.message('r35-message').status, f.message('r35-message').reply], ['acknowledged', `ACK ${nonce} Synthetic summary`])
}, { spawn: true }))

// Round 5 of the #1366 review: only a take opened or renewed a session's mailbox, and a busy session takes nothing. A session
// first seen busy had no mailbox until its turn ended, and a turn longer than the mailbox's 12 hours lost it and its messages.
test('R36 a session first seen busy, through chat.message or against its idle event, has its mailbox opened at once and takes nothing until it is idle (round 5)', async () => {
  for (const entry of ['chat.message', 'created']) {
    await fixture(async f => {
      f.calls.busy = { ses_r36: { type: 'busy' } }
      await (entry === 'chat.message' ? f.chat('ses_r36') : f.created('ses_r36'))
      await f.quiet()
      const box = () => { try { return (f.store().mailboxes ?? []).find(one => one.agent === 'opencode' && one.session === 'ses_r36') } catch { return undefined } }
      assert.ok(box()?.expires > f.clock.now(), `${entry}: the busy session's mailbox is open, so the board can queue a message for it`)
      assert.deepEqual([f.count('open'), f.count('take')], [1, 0], entry)
      f.queue('ses_r36', 'r36-message', 'Synthetic text for a session first seen busy')
      f.tick()
      await f.quiet()
      assert.deepEqual([f.count('take'), f.message('r36-message').status], [0, 'queued'], `${entry}: nothing is taken while the session is busy`)
      delete f.calls.busy
      await f.idle('ses_r36')
      await f.quiet()
      assert.deepEqual([f.message('r36-message').status, f.calls.promptAsync.length], ['accepted', 1], `${entry}: the message went out at session.idle`)
    }, { watch: false })
  }
})

test('R37 a session busy across a long turn has its mailbox renewed with open, not take, once less than its lifetime minus ten minutes is left, so a turn longer than 12 hours keeps its mailbox and its message (round 5, round 6)', () => fixture(async f => {
  await f.created('ses_r37')
  await f.quiet()
  assert.equal(f.count('take'), 1, 'the idle session opened its mailbox with a take')
  f.calls.busy = { ses_r37: { type: 'busy' } }
  await f.reported({ session: 'ses_r37', type: 'busy' })
  f.queue('ses_r37', 'r37-message', 'Synthetic text for a long turn')
  await f.quiet()
  for (let round = 1; round <= 20; round++) { f.tick(); await f.quiet() }
  assert.deepEqual([f.count('open'), f.count('take')], [0, 1], 'twenty ticks with the mailbox\'s time left ask for nothing')
  // The turn has run for nearly the mailbox's whole life.
  f.shorten('ses_r37', 5 * MIN)
  f.tick()
  await f.quiet()
  assert.deepEqual([f.count('open'), f.count('take')], [1, 1], 'the next tick opened the mailbox again and took nothing')
  assert.ok(f.mailbox('ses_r37').expires > Date.now() + LIFETIME - 10 * MIN, 'the mailbox was renewed')
  f.tick()
  await f.quiet()
  assert.equal(f.count('open'), 1, 'and it is not asked again')
  delete f.calls.busy
  await f.idle('ses_r37')
  await f.quiet()
  assert.deepEqual([f.message('r37-message').status, f.calls.promptAsync.length], ['accepted', 1])
}, { watch: false }))

// Round 6 of the #1366 review (the diagnosis's rules V1-V8): what a session owes is read from the board's store at each tick, never
// remembered from an answer, and an event reaches the receiver before anything is awaited. Each test below holds a call with a gate.
test('T1 a session busy before the board folder exists has its mailbox at the first tick after the folder appears, also when it was idle first', async () => {
  for (const first of ['busy', 'idle']) {
    await fixture(async f => {
      f.calls.noFolder = true
      const session = 'ses_t1'
      if (first === 'busy') f.calls.busy = { [session]: { type: 'busy' } }
      await f.created(session)
      await f.quiet()
      if (first === 'idle') {
        assert.equal(f.count('take'), 1, 'the idle session took, and found no folder')
        f.calls.busy = { [session]: { type: 'busy' } }
        await f.reported({ session, type: 'busy' })
        await f.quiet()
      }
      assert.equal(f.mailbox(session), undefined, `${first}: no folder, so no mailbox yet`)
      f.makeFolder()
      f.tick()
      await f.quiet()
      assert.ok(f.mailbox(session)?.expires > Date.now() + LIFETIME - 10 * MIN, `${first}: the first tick after the folder appeared opened the mailbox`)
      assert.equal(f.count('take'), first === 'idle' ? 1 : 0, `${first}: a busy session still takes nothing`)
    }, { watch: false })
  }
})

test('T2 a renewal that fails is asked again at the next tick, and the store then shows the new time', () => fixture(async f => {
  const session = 'ses_t2'
  f.calls.busy = { [session]: { type: 'busy' } }
  await f.chat(session)
  await f.quiet()
  const opened = f.count('open')
  f.tick()
  await f.quiet()
  assert.equal(f.count('open'), opened, 'a mailbox with its time left is not renewed')
  f.shorten(session, 5 * MIN)
  f.calls.faults.open = ['fail']
  f.tick()
  await f.quiet()
  assert.equal(f.count('open'), opened + 1, 'the tick asked for a renewal, and it failed')
  assert.ok(f.mailbox(session).expires < Date.now() + 6 * MIN, 'the store still shows the short time')
  f.tick()
  await f.quiet()
  assert.equal(f.count('open'), opened + 2, 'the next tick asked again')
  assert.ok(f.mailbox(session).expires > Date.now() + LIFETIME - 10 * MIN, 'the store shows the new time')
  f.tick()
  await f.quiet()
  assert.equal(f.count('open'), opened + 2, 'and nothing more is asked')
}, { watch: false }))

test('T3 for each of status, take and attempt held open, a busy event whose lookup is held starts no wake; the claim goes back and the next idle wakes it once', async () => {
  for (const held of ['status', 'take', 'attempt']) {
    await fixture(async f => {
      const session = 'ses_t3'
      await f.created(session)
      await f.quiet()
      f.queue(session, 't3-message', 'Synthetic text for a busy event during a call')
      let open, lookup
      const gate = new Promise(done => { open = done })
      const before = held === 'status' ? f.calls.status.length : f.count(held)
      if (held === 'status') f.calls.gate = gate
      else f.calls.hold[held] = gate
      await f.idle(session)
      await f.until(() => (held === 'status' ? f.calls.status.length : f.count(held)) > before, `${held} is held open`)
      // The busy event's own lookup stays held, so the receiver has only the event's first statement to go by.
      // The host's own answer stays idle, as a status answered just before the turn began would be.
      f.calls.holdGet = new Promise(done => { lookup = done })
      const gets = f.calls.gets
      const busy = f.reported({ session, type: 'busy' })
      await f.until(() => f.calls.gets > gets, 'the busy event reached its lookup')
      open()
      await f.quiet()
      assert.equal(f.calls.promptAsync.length, 0, `${held}: no wake is started once a busy event has reached the plugin`)
      assert.equal(f.message('t3-message').status, 'queued', `${held}: the claim went back`)
      lookup()
      await busy
      await f.quiet()
      await f.idle(session)
      await f.until(() => f.message('t3-message').status === 'accepted' && f.settled(), `${held}: the next idle woke it`)
      assert.equal(f.calls.promptAsync.length, 1, held)
    }, { timing: { hostMs: 20000, boardMs: 20000 }, watch: false })
  }
})

test('T4 a mailbox removed from the store under a known session is opened again at the next tick: a late end, a store made new, an entry that ran out', async () => {
  const CASES = {
    'a late end': (f, session) => f.unmailbox(session),
    'a store made new': f => f.makeFolder(),
    'an entry that ran out': (f, session) => f.shorten(session, -1000),
  }
  for (const [name, change] of Object.entries(CASES)) for (const state of ['idle', 'busy']) {
    await fixture(async f => {
      const session = 'ses_t4'
      if (state === 'busy') f.calls.busy = { [session]: { type: 'busy' } }
      await (state === 'busy' ? f.chat(session) : f.created(session))
      await f.quiet()
      assert.ok(f.mailbox(session), `${name}, ${state}: the session has its mailbox first`)
      change(f, session)
      assert.ok(!(f.mailbox(session)?.expires > Date.now()), `${name}, ${state}: the mailbox is gone from the store`)
      f.tick()
      await f.quiet()
      assert.ok(f.mailbox(session)?.expires > Date.now() + LIFETIME - 10 * MIN, `${name}, ${state}: the next tick opened it again`)
    }, { watch: false })
  }
})

test('T5 a session deleted while its take is running leaves no mailbox: the end waits for the take, and a take the board applies after it does not enrol the mailbox again (#1366 review)', () => fixture(async f => {
  const session = 'ses_t5'
  await f.created(session)
  await f.quiet()
  assert.ok(f.mailbox(session), 'the session has a mailbox')
  // The board applies the next take only after a moment, as a script that started first but ran later would.
  f.calls.faults.take = ['slow']
  const takes = f.count('take')
  await f.idle(session)
  await f.until(() => f.count('take') > takes, 'a take is running')
  await f.deleted(session)
  await f.until(() => f.count('end') >= 1 && f.settled(), 'the end was made')
  await f.quiet()
  assert.equal(f.mailbox(session), undefined, 'no mailbox is left on the board')
  assert.equal(f.count('end'), 1)
  // Nothing is owed: a tick asks the board for nothing more.
  const calls = f.calls.board.length
  f.tick()
  await f.quiet()
  assert.equal(f.calls.board.length, calls)
}, { watch: false }))

test('R38 a session deleted during its turn stays gone: the busy, retry and idle events OpenCode sends for it after the deletion open no mailbox, take nothing and wake nothing (live record 2026-11-14, #1366 review)', () => fixture(async f => {
  await f.reported({ session: 'ses_r38', type: 'busy' })
  f.tick()
  await f.until(() => f.mailbox('ses_r38') !== undefined && f.settled(), 'the busy session has its mailbox')
  await f.deleted('ses_r38')
  await f.until(() => f.mailbox('ses_r38') === undefined && f.settled(), 'the deletion ended its mailbox')
  const before = [f.count('open'), f.count('take'), f.count('end')]
  // The events the live run recorded after the deletion, in that order.
  for (const type of ['retry', 'busy', 'retry', 'idle']) await f.reported({ session: 'ses_r38', type })
  await f.idle('ses_r38')
  for (let round = 0; round < 3; round++) { f.tick(); await f.quiet() }
  assert.deepEqual([f.count('open'), f.count('take'), f.count('end')], before)
  assert.equal(f.mailbox('ses_r38'), undefined)
  assert.equal(f.calls.promptAsync.length, 0)
}))

test('R39 the host is asked in the same run as the last check before the call, so no event can come between them (#1366 review)', () => fixture(async f => {
  let isCalled = false
  const asked = f.hostCall(() => { isCalled = true; return 'answer' })
  assert.equal(isCalled, true, 'the call started before the caller went on')
  assert.equal(await asked, 'answer')
  // A call that throws at once is a rejected answer, never a throw out of the step.
  await assert.rejects(f.hostCall(() => { throw new Error('host failed') }), /host failed/)
}))

test('B17 a disconnection after the host accepted a wake keeps the time of the accept, so it reads "sent, not confirmed" 30 minutes after it and the next message goes out (#1366 review)', async () => {
  const b = await mailbox()
  const taken = b.take(b.seed('opencode', 's1'), 'opencode', 's1', refOf(1), T0)
  const marked = b.act(taken.state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref: refOf(1) }, T0 + SEC).state
  const accepted = b.act(marked, 'mailbox-accept', { agent: 'opencode', session: 's1', id: 'm1', nonce: taken.message.nonce, awaitsAck: true }, T0 + 2 * SEC).state
  assert.equal(accepted.messages[0].status, 'accepted')
  const box = accepted.mailboxes.find(one => one.agent === 'opencode' && one.session === 's1')
  // The receiver's connection is lost 29 minutes after the accept: the accepted wake is left as it was.
  const lost = b.messaging.disconnectMessages(accepted, box.id, T0 + 2 * SEC + 29 * MIN)
  assert.deepEqual([lost.messages[0].status, lost.messages[0].error, lost.messages[0].updated], ['accepted', '', accepted.messages[0].updated])
  // 31 minutes after the accept it reads "sent, not confirmed", keeps its text, and no longer holds the session's next message.
  const late = b.prune(lost, T0 + 2 * SEC + 31 * MIN)
  assert.deepEqual([late.messages[0].status, late.messages[0].error, late.messages[0].text], ['uncertain', 'UNCONFIRMED', 'Synthetic text for the board cases'])
  const queued = b.messaging.queueMessage(late, { id: 'm2', target: box.id, turn: 'session', text: 'Synthetic second message' }, 'board', box, T0 + 2 * SEC + 31 * MIN).state
  assert.equal(b.take(queued, 'opencode', 's1', refOf(2), T0 + 2 * SEC + 32 * MIN).message?.id, 'm2')
})

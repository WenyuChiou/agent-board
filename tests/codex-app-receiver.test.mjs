// The Codex desktop app receiver (#557): a board reply to an idle Codex app conversation runs that conversation's next
// turn in the background with Codex's own resume command, once the app no longer holds it. Synthetic data only: a stand-in
// board client and a stand-in run, so no Codex program, Codex home or board server is touched.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  },
})

const { EN } = await import('../hooks/strings-en.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')
const { ZH_CN } = await import('../hooks/strings-zh-cn.ts')
const { SURFACE_IDS, isRoute, routeLine, sendDecision } = await import('../hooks/messaging.ts')
const { RECEIVER_ROUTES } = await import('../hooks/receiver-routes.ts')
const { routeText } = await import('../hooks/serve.ts')
const { checkLiveResumeRecord, disallowedPermissionFlag } = await import('../scripts/background-resume.ts')
const { CODEX_APP_ORIGINATOR, isWriterHeld, startCodexAppReceiver } = await import('../scripts/codex-app-receiver.ts')
const { messagingReceiver } = await import('../hooks/receivers/codex-app.ts')

const THREAD = '11111111-2222-4333-8444-555555555555'
const OTHER = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const DIR = process.cwd()
const NONCE = 'AB12CD'
const EXE = process.platform === 'win32' ? 'C:\\synthetic\\codex.exe' : '/synthetic/codex'
const message = { id: 'AB-APP-1', nonce: NONCE, prompt: `Synthetic board reply: Blue.\nReply with the line ACK ${NONCE} first.` }
const writerHeld = { started: true, exitCode: 1, timedOut: false, spawnErrorCode: null, spawnErrorMessage: null, stdout: '', stderr: `Error: thread-store conflict: thread ${THREAD} already has an active writer\n` }
const answered = { started: true, exitCode: 0, timedOut: false, spawnErrorCode: null, spawnErrorMessage: null, stdout: `ACK ${NONCE}\nBlue it is.\n`, stderr: '' }

// A stand-in board client: attach() keeps what the receiver gave it, so a test can deliver a message the way the board would.
const fakeClient = () => {
  const attached = new Map()
  return {
    attached,
    attach: async options => {
      if (!await options.verify()) throw new Error('HOST_NOT_CONNECTED')
      let isClosed = false
      const one = { options, closed: [], close: async how => { isClosed = true; one.closed.push(how ?? {}) }, isClosed: () => isClosed, isContested: () => false }
      attached.set(options.session, one)
      return one
    },
  }
}
// The four callbacks the board client hands a delivery, each counting its calls.
const callbacks = () => {
  const said = []
  return {
    said,
    accept: async () => { said.push('accepted') },
    begin: () => { said.push('begin') },
    unsent: async () => { said.push('unsent') },
    starting: async () => { said.push('starting') },
  }
}
const deliverWith = (one, cb) => one.options.deliver(message, cb.accept, cb.begin, cb.unsent, cb.starting)

const receiver = (over = {}) => {
  const client = fakeClient(), runs = []
  let clock = 0
  const state = new Map([[THREAD, 'idle']])
  const results = over.results ?? [answered]
  const app = startCodexAppReceiver({
    boardUrl: 'http://127.0.0.1:9/?t=synthetic', client, executable: EXE, tickMs: 60_000, retryMs: 30_000,
    sessions: over.sessions ?? (() => [{ id: THREAD, dir: DIR }]),
    stateOf: id => state.get(id),
    isTaken: over.isTaken ?? (() => false),
    now: () => clock,
    run: async (program, options) => { runs.push({ program, options }); return results[Math.min(runs.length - 1, results.length - 1)] },
    env: { PATH: 'synthetic', AGENT_BOARD_TOKEN_SYNTHETIC: 'x', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: CODEX_APP_ORIGINATOR, CODEX_HOME: 'synthetic-home' },
  })
  return { app, client, runs, state, advance: ms => { clock += ms } }
}

test('the Codex desktop app has its own surface, and its idle route reopens the conversation while the daemon\'s stays "now" (#557)', () => {
  assert.equal(SURFACE_IDS.codexApp, 'Codex desktop app')
  assert.equal(CODEX_APP_ORIGINATOR, 'Codex Desktop')
  const live = RECEIVER_ROUTES.find(one => one.agent === 'codex' && one.kind === 'live')
  assert.equal(routeLine(live.routes.idle, SURFACE_IDS.codexApp), 'reopen')
  assert.equal(routeLine(live.routes.idle, SURFACE_IDS.codexDaemon), 'now')
  const connection = surface => ({ id: 'c-' + surface, agent: 'codex', session: THREAD, surface, turn: 'session', scope: 'session', expires: Date.now() + 60_000 })
  for (const [surface, line] of [[SURFACE_IDS.codexApp, 'reopen'], [SURFACE_IDS.codexDaemon, 'now']]) {
    const one = connection(surface)
    const idle = sendDecision(one.id, [one], [], () => 'idle', RECEIVER_ROUTES, Date.now())
    assert.equal(idle.canSend, true, surface)
    assert.equal(idle.line, line, surface)
  }
  // Never mid-turn: a running conversation refuses the app's route.
  const one = connection(SURFACE_IDS.codexApp)
  assert.equal(sendDecision(one.id, [one], [], () => 'working', RECEIVER_ROUTES, Date.now()).canSend, false)
  // The shared background-resume check reads the same per-surface line and note.
  assert.equal(checkLiveResumeRecord('codex', 'idle', RECEIVER_ROUTES, SURFACE_IDS.codexApp, 'live').ok, true)
  assert.equal(checkLiveResumeRecord('codex', 'idle', RECEIVER_ROUTES, SURFACE_IDS.codexDaemon, 'live').ok, false)
  assert.equal(checkLiveResumeRecord('codex', 'working', RECEIVER_ROUTES, SURFACE_IDS.codexApp, 'live').ok, false)
})

test('a per-surface line must name a surface of its route and a known line', () => {
  const base = { line: 'now', record: 'docs/validation/synthetic.md', surfaces: ['CLI', 'Web'] }
  assert.equal(isRoute({ ...base, surfaceLines: { Web: 'reopen' } }), true)
  assert.equal(isRoute({ ...base, surfaceLines: { TUI: 'reopen' } }), false, 'surface outside the route')
  assert.equal(isRoute({ ...base, surfaceLines: { Web: 'soon' } }), false, 'unknown line')
  assert.equal(isRoute({ ...base, surfaceLines: ['reopen'] }), false, 'a list')
  assert.equal(isRoute({ ...base, surfaceLines: null }), false, 'null')
  assert.equal(routeLine({ ...base, surfaceLines: { Web: 'reopen' } }, 'CLI'), 'now')
  // A surface named like a property every object inherits reads the route's own line.
  assert.equal(routeLine({ ...base, surfaceLines: { Web: 'reopen' } }, 'constructor'), 'now')
})

test('the card for a Codex app conversation says the turn runs in the background once the app is quit, in every language', () => {
  for (const s of [EN, ZH_TW, ZH_CN]) {
    const text = routeText('reopen', true, 'codex', s, 'idle', undefined, SURFACE_IDS.codexApp)
    assert.equal(text, s.serveLineReopenCodexApp)
    assert.notEqual(text, s.serveLineReopen('Codex'))
    assert.ok(text.length > 20)
  }
  assert.match(EN.serveLineReopenCodexApp, /background/)
  assert.match(EN.serveLineReopenCodexApp, /quit/i)
  // Other surfaces keep the shared wording.
  assert.equal(routeText('reopen', true, 'codex', EN, 'idle', undefined, SURFACE_IDS.codexDaemon), EN.serveLineReopen('Codex'))
})

// Live run 2026-11-22: a reply sent while the app still held the conversation sat queued, and the card said the turn was
// already running. Until the app lets go, the card says the reply waits here for the app to be quit.
test('a Codex app card says a sent reply waits here until the app is fully quit, and that the turn runs only once it is taken, in every language', async () => {
  const { buildView } = await import('../hooks/view.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { serveModel, servePage } = await import('../hooks/serve.ts')
  const { shownMessages } = await import('../hooks/queued-store.ts')
  const { pageDom } = await import('./e2e/lib/surfaces.mjs')
  for (const s of [EN, ZH_TW, ZH_CN]) {
    const now = Date.now()
    const file = `## Synthetic\n<!-- auto session=abcdef01 agent=codex resume=${THREAD} state=waiting updated=${new Date(now).toISOString()} -->\n### App wording\n- [?] Orange or teal?\n<!-- /auto session=abcdef01 -->\n`
    const view = buildView(parseProgress(file), [], null, now, 0, {}, s)
    const connections = [{ id: 'conn-app', agent: 'codex', session: THREAD, surface: SURFACE_IDS.codexApp, turn: 'session', scope: 'session', expires: now + 60_000 }]
    const group = { now, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] }
    const sent = status => [{ id: 'AB-APP-2', target: 'conn-app', turn: 'session', from: 'board', to: `codex:${THREAD}`, text: 'Teal', hash: '0'.repeat(64), origin: 'local', status, updated: now, reply: '', error: '', hops: 1, claimed: 0, line: 'reopen', surface: SURFACE_IDS.codexApp }]
    // The page gets the store's messages as the board shows them (hooks/queued-store.ts), which leave the surface out.
    const model = messages => serveModel(view, [], s, new Set(), false, { connections, mailboxes: [], messages: shownMessages({ messages, mailboxes: [] }) }, false, group, RECEIVER_ROUTES)
    const ok = async () => ({ ok: true, json: async () => ({ ok: true }) })
    // The press itself: the words shown while the board takes the message, and after it answers with no note of its own.
    let release
    const press = await pageDom(servePage(s, 'synthetic-nonce'), model([]), () => new Promise(done => { release = done }))
    press.cards().flatMap(card => press.buttons(card)).find(one => one.textContent === s.pgWriteOwn).click()
    press.inputs(press.cards()[0])[0].value = 'Teal'
    press.cards().flatMap(card => press.buttons(card)).find(one => one.textContent.startsWith(s.serveSend('Codex'))).click()
    await new Promise(done => setImmediate(done))
    assert.ok(press.text().includes(s.serveReopenWaitingCodexApp), press.text())
    assert.ok(!press.text().includes(s.serveReopenRunning('Codex')), press.text())
    release({ ok: true, json: async () => ({ ok: true, receipt: { id: 'AB-APP-2', status: 'queued', line: 'reopen', isMailbox: false } }) })
    await press.flush()
    assert.ok(press.text().includes(s.serveReopenWaitingCodexApp), press.text())
    // The receipt after a redraw: queued waits for the app; taken (accepted) runs in the background.
    const queued = (await pageDom(servePage(s, 'synthetic-nonce'), model(sent('queued')), ok)).text()
    assert.ok(queued.includes(s.serveReopenWaitingCodexApp), queued)
    assert.ok(!queued.includes(s.serveReopenRunning('Codex')), queued)
    assert.ok((await pageDom(servePage(s, 'synthetic-nonce'), model(sent('accepted')), ok)).text().includes(s.serveReopenRunning('Codex')))
    assert.ok(s.serveReopenWaitingCodexApp.length > 20)
  }
  assert.match(EN.serveReopenWaitingCodexApp, /quit/i)
})

test('while the receiver runs a Codex app turn past the handoff window, the card says it runs, not that no reply was confirmed, until the receiver lets go', async () => {
  const { buildView } = await import('../hooks/view.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { serveModel, servePage, CLAIM_HANDOFF_MS } = await import('../hooks/serve.ts')
  const { shownMessages } = await import('../hooks/queued-store.ts')
  const { pageDom } = await import('./e2e/lib/surfaces.mjs')
  const ok = async () => ({ ok: true, json: async () => ({ ok: true }) })
  for (const s of [EN, ZH_TW, ZH_CN]) {
    const now = Date.now()
    const file = `## Synthetic\n<!-- auto session=abcdef01 agent=codex resume=${THREAD} state=waiting updated=${new Date(now).toISOString()} -->\n### App wording\n- [?] Orange or teal?\n<!-- /auto session=abcdef01 -->\n`
    const view = buildView(parseProgress(file), [], null, now, 0, {}, s)
    const group = { now, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] }
    // A model turn takes longer than the board's 15-second handoff window: the receiver said `starting` and runs it.
    const claimed = now - CLAIM_HANDOFF_MS - 5_000
    const taken = (over = {}) => [{ id: 'AB-APP-3', target: 'conn-app', turn: 'session', from: 'board', to: `codex:${THREAD}`, text: 'Teal', hash: '0'.repeat(64), origin: 'local', status: 'uncertain', updated: claimed, reply: '', error: '', hops: 1, claimed, line: 'reopen', surface: SURFACE_IDS.codexApp, ...over }]
    const card = async (messages, expires = now + 60_000) => {
      const connections = [{ id: 'conn-app', agent: 'codex', session: THREAD, surface: SURFACE_IDS.codexApp, turn: 'session', scope: 'session', expires }]
      const model = serveModel(view, [], s, new Set(), false, { connections, mailboxes: [], messages: shownMessages({ messages, mailboxes: [] }) }, false, group, RECEIVER_ROUTES)
      return (await pageDom(servePage(s, 'synthetic-nonce'), model, ok)).text()
    }
    const running = await card(taken())
    assert.ok(running.includes(s.serveReopenRunning('Codex')), running)
    assert.ok(!running.includes(s.messagesUncertain), running)
    // A claim the receiver never said `starting` for was not run here, and a receiver that let go no longer vouches for the turn.
    for (const text of [await card(taken({ awaitsStart: true })), await card(taken(), now - 1)]) {
      assert.ok(!text.includes(s.serveReopenRunning('Codex')), text)
      assert.ok(text.includes(s.messagesUncertain), text)
    }
  }
})

test('the receiver\'s own record names the app surface and the reopen route the board ships', () => {
  assert.equal(messagingReceiver.agent, 'codex')
  assert.equal(messagingReceiver.kind, 'live')
  assert.deepEqual(messagingReceiver.surfaces.map(one => one.id), [SURFACE_IDS.codexApp])
  assert.equal(messagingReceiver.routes.idle.line, 'reopen')
  assert.deepEqual(messagingReceiver.routes.idle.surfaces, [SURFACE_IDS.codexApp])
  assert.equal(messagingReceiver.routes.working.line, 'stepEnd')
  assert.equal(messagingReceiver.routes.working.record, null)
})

test('a reply runs Codex\'s own resume command in the conversation\'s folder, in its default permission mode, and its ACK is the receipt', async () => {
  const { app, client, runs } = receiver()
  await app.tick()
  const one = client.attached.get(THREAD)
  assert.ok(one, 'attached')
  assert.equal(one.options.agent, 'codex')
  assert.equal(one.options.surface, SURFACE_IDS.codexApp)
  assert.equal(one.options.scope, 'session')
  assert.equal(one.options.marksStart, true)
  assert.equal(await one.options.canReceive(), true)
  const cb = callbacks()
  const reply = await deliverWith(one, cb)
  assert.equal(reply, `ACK ${NONCE} Blue it is.`)
  assert.deepEqual(cb.said, ['starting', 'begin'])
  assert.equal(runs.length, 1)
  const { program, options } = runs[0]
  assert.equal(program.isShell, false)
  const args = program.command === EXE ? program.args : program.args.slice(1)
  assert.deepEqual(args, ['exec', 'resume', '--skip-git-repo-check', THREAD, '-'])
  assert.equal(disallowedPermissionFlag(args), null)
  assert.equal(options.cwd, DIR)
  assert.equal(options.stdin, message.prompt)
  // The board's address, token and the app's own name stay out of the Codex program's environment; its Codex home does not.
  assert.equal(options.env.AGENT_BOARD_TOKEN_SYNTHETIC, undefined)
  assert.equal(options.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined)
  assert.equal(options.env.CODEX_HOME, 'synthetic-home')
  // One mark is added, for the board's own hooks in that run: its SessionEnd ends the run, not the conversation.
  assert.equal(options.env.AGENT_BOARD_BACKGROUND_TURN, '1')
  app.kill()
})

test('while the app still holds the conversation, nothing was sent: the message goes back to the queue and waits 30 seconds', async () => {
  const { app, client, runs, advance } = receiver({ results: [writerHeld, answered] })
  await app.tick()
  const one = client.attached.get(THREAD)
  const cb = callbacks()
  assert.equal(await deliverWith(one, cb), undefined)
  assert.deepEqual(cb.said, ['starting', 'unsent'], 'given back, never begun')
  assert.equal(await one.options.canReceive(), false)
  advance(29_999)
  assert.equal(await one.options.canReceive(), false)
  advance(1)
  assert.equal(await one.options.canReceive(), true)
  const again = callbacks()
  assert.equal(await deliverWith(one, again), `ACK ${NONCE} Blue it is.`)
  assert.deepEqual(again.said, ['starting', 'begin'])
  assert.equal(runs.length, 2)
  app.kill()
})

test('only Codex\'s own writer refusal reads as nothing sent', () => {
  assert.equal(isWriterHeld(writerHeld), true)
  assert.equal(isWriterHeld({ ...writerHeld, stderr: `Error: thread ${THREAD} already has an active writer` }), true)
  assert.equal(isWriterHeld({ ...writerHeld, exitCode: 0 }), false, 'a run that ended well')
  assert.equal(isWriterHeld({ ...writerHeld, stdout: `ACK ${NONCE}\n` }), false, 'a run that answered')
  assert.equal(isWriterHeld({ ...writerHeld, stdout: 'Some reply text' }), false, 'a run that said something')
  assert.equal(isWriterHeld({ ...writerHeld, timedOut: true }), false, 'a run that timed out')
  assert.equal(isWriterHeld({ ...writerHeld, stderr: 'Error: model request failed' }), false, 'another failure')
  assert.equal(isWriterHeld({ ...writerHeld, started: false }), false, 'never started')
})

test('a run that may have reached the model and gives no ACK is uncertain, never given back or tried again', async () => {
  for (const [result, code] of [
    [{ ...answered, stdout: 'Blue it is.\n' }, 'ACK_REQUIRED'],
    [{ ...answered, exitCode: 1, stdout: '', stderr: 'Error: model request failed' }, 'EXIT_FAILED'],
    [{ ...answered, exitCode: null, timedOut: true, stdout: '' }, 'EXIT_TIMEOUT'],
  ]) {
    const { app, client } = receiver({ results: [result] })
    await app.tick()
    const cb = callbacks()
    await assert.rejects(deliverWith(client.attached.get(THREAD), cb), new RegExp(code))
    assert.deepEqual(cb.said, ['starting', 'begin'], code)
    app.kill()
  }
})

test('a conversation whose folder is gone is refused before Codex is asked for anything', async () => {
  const { app, client, runs } = receiver({ sessions: () => [{ id: THREAD, dir: DIR + '-synthetic-gone' }] })
  await app.tick()
  const cb = callbacks()
  await assert.rejects(deliverWith(client.attached.get(THREAD), cb), /FOLDER_GONE/)
  assert.deepEqual(cb.said, [])
  assert.equal(runs.length, 0)
  app.kill()
})

test('a Codex program that cannot start is refused before anything began', async () => {
  const { app, client } = receiver({ results: [{ started: false, exitCode: null, timedOut: false, spawnErrorCode: 'ENOENT', spawnErrorMessage: 'not found', stdout: '', stderr: '' }] })
  await app.tick()
  const cb = callbacks()
  await assert.rejects(deliverWith(client.attached.get(THREAD), cb), /COMMAND_MISSING/)
  assert.deepEqual(cb.said, ['starting'])
  app.kill()
})

test('never mid-turn: a conversation that runs a turn takes nothing, and a claim that finds one gives it back unrun', async () => {
  const { app, client, runs, state } = receiver()
  await app.tick()
  const one = client.attached.get(THREAD)
  state.set(THREAD, 'working')
  assert.equal(await one.options.canReceive(), false)
  const cb = callbacks()
  assert.equal(await deliverWith(one, cb), undefined)
  assert.deepEqual(cb.said, ['unsent'])
  state.set(THREAD, undefined)
  assert.equal(await one.options.canReceive(), false, 'a state the board cannot read')
  assert.equal(runs.length, 0)
  app.kill()
})

test('a starting receipt the board does not take runs nothing and gives the claim back', async () => {
  const { app, client, runs } = receiver()
  await app.tick()
  const cb = callbacks()
  cb.starting = async () => { cb.said.push('starting'); throw new Error('DELIVERY_STARTED') }
  assert.equal(await deliverWith(client.attached.get(THREAD), cb), undefined)
  assert.deepEqual(cb.said, ['starting', 'unsent'])
  assert.equal(runs.length, 0)
  app.kill()
})

test('a board that stops during a run lets go of its connections, leaves the Codex turn to finish, and counts it as sending until it does', async () => {
  let release
  const client = fakeClient()
  const app = startCodexAppReceiver({
    boardUrl: 'http://127.0.0.1:9/?t=synthetic', client, executable: EXE, tickMs: 60_000, sessions: () => [{ id: THREAD, dir: DIR }], stateOf: () => 'idle', env: {},
    run: () => new Promise(done => { release = () => done(answered) }),
  })
  await app.tick()
  const one = client.attached.get(THREAD)
  const cb = callbacks()
  const reply = deliverWith(one, cb)
  await new Promise(done => setImmediate(done))
  app.kill()
  await new Promise(done => setImmediate(done))
  assert.equal(one.isClosed(), true)
  // The turn has the person's words already: stopping it could lose the turn, so it runs on and the board counts it.
  assert.equal(app.sending(), 1)
  release()
  assert.equal(await reply, `ACK ${NONCE} Blue it is.`)
  assert.equal(app.sending(), 0)
  assert.deepEqual(cb.said, ['starting', 'begin'])
})

test('a conversation that leaves the board\'s list with no run in flight is let go, not read as ended', async () => {
  let listed = [{ id: THREAD, dir: DIR }]
  const { app, client } = receiver({ sessions: () => listed })
  await app.tick()
  const one = client.attached.get(THREAD)
  listed = []
  await app.tick()
  assert.equal(one.isClosed(), true)
  // Not `ended`: a reply still queued for it keeps its leave stamp and is refused only after the board's wait (#318).
  assert.deepEqual(one.closed, [{}])
  app.kill()
})

test('a connection lost during a run is attached again, and the new one takes nothing until the run is over', async () => {
  let release
  const client = fakeClient()
  const app = startCodexAppReceiver({
    boardUrl: 'http://127.0.0.1:9/?t=synthetic', client, executable: EXE, tickMs: 60_000, sessions: () => [{ id: THREAD, dir: DIR }], stateOf: () => 'idle', env: {},
    run: () => new Promise(done => { release = () => done(answered) }),
  })
  await app.tick()
  const first = client.attached.get(THREAD)
  const reply = deliverWith(first, callbacks())
  await new Promise(done => setImmediate(done))
  await first.close()
  await app.tick()
  const again = client.attached.get(THREAD)
  assert.notEqual(again, first)
  assert.equal(await again.options.canReceive(), false)
  release()
  await reply
  assert.equal(await again.options.canReceive(), true)
  app.kill()
})

test('one reply at a time per conversation', async () => {
  let release
  const client = fakeClient(), runs = []
  const app = startCodexAppReceiver({
    boardUrl: 'http://127.0.0.1:9/?t=synthetic', client, executable: EXE, tickMs: 60_000, sessions: () => [{ id: THREAD, dir: DIR }], stateOf: () => 'idle', env: {},
    run: program => { runs.push(program); return new Promise(done => { release = () => done(answered) }) },
  })
  await app.tick()
  const one = client.attached.get(THREAD)
  const first = deliverWith(one, callbacks())
  await new Promise(done => setImmediate(done))
  assert.equal(await one.options.canReceive(), false)
  release()
  assert.equal(await first, `ACK ${NONCE} Blue it is.`)
  assert.equal(await one.options.canReceive(), true)
  app.kill()
})

test('a conversation that leaves the board\'s list while its run is in flight keeps its connection until the receipt is in', async () => {
  // Live run (#557): the run's own SessionEnd read the conversation as ended mid-run, and a closed connection left the board
  // a claim it had lost (`uncertain`) for a turn that had answered.
  let release, listed = [{ id: THREAD, dir: DIR }]
  const client = fakeClient()
  const app = startCodexAppReceiver({
    boardUrl: 'http://127.0.0.1:9/?t=synthetic', client, executable: EXE, tickMs: 60_000, sessions: () => listed, stateOf: () => 'idle', env: {},
    run: () => new Promise(done => { release = () => done(answered) }),
  })
  await app.tick()
  const one = client.attached.get(THREAD)
  const reply = deliverWith(one, callbacks())
  await new Promise(done => setImmediate(done))
  listed = []
  await app.tick()
  assert.equal(await one.options.verify(), true)
  assert.equal(one.isClosed(), false)
  release()
  assert.equal(await reply, `ACK ${NONCE} Blue it is.`)
  // Once the receipt is in, a conversation the board no longer lists is let go.
  assert.equal(await one.options.verify(), false)
  await app.tick()
  assert.equal(one.isClosed(), true)
  app.kill()
})

test('the receiver attaches only to app conversations the board lists, leaves the ones the daemon receiver has, and lets go of gone ones', async () => {
  let listed = [{ id: THREAD, dir: DIR }, { id: OTHER, dir: DIR }, { id: 'not-a-thread', dir: DIR }, { id: '22222222-3333-4444-8555-666666666666', dir: '' }]
  const taken = new Set([OTHER])
  const { app, client } = receiver({ sessions: () => listed, isTaken: id => taken.has(id) })
  await app.tick()
  assert.deepEqual([...client.attached.keys()], [THREAD])
  assert.deepEqual(app.attached(), [THREAD])
  // The daemon receiver attaches to it later: this receiver lets go, so the two never contest the card.
  taken.add(THREAD)
  assert.equal(await client.attached.get(THREAD).options.verify(), false)
  await app.tick()
  assert.equal(client.attached.get(THREAD).isClosed(), true)
  assert.deepEqual(app.attached(), [])
  taken.delete(THREAD)
  listed = []
  await app.tick()
  assert.deepEqual(app.attached(), [])
  app.kill()
})

test('a board address off this computer is refused before anything is attached', () => {
  assert.throws(() => startCodexAppReceiver({ boardUrl: 'http://192.168.1.9:9/?t=synthetic', executable: EXE, sessions: () => [], stateOf: () => 'idle' }), /LOCAL_BOARD_URL_REQUIRED/)
  assert.throws(() => startCodexAppReceiver({ boardUrl: 'http://127.0.0.1:9/?t=synthetic', executable: 'codex', sessions: () => [], stateOf: () => 'idle' }), /EXPLICIT_EXECUTABLE_REQUIRED/)
})

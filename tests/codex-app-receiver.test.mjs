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
const { checkLiveResumeRecord, disallowedPermissionFlag, runBackgroundProcess } = await import('../scripts/background-resume.ts')
const { CODEX_APP_ORIGINATOR, isWriterHeld, startCodexAppReceiver } = await import('../scripts/codex-app-receiver.ts')
const { messagingReceiver } = await import('../hooks/receivers/codex-app.ts')

const THREAD = '11111111-2222-4333-8444-555555555555'
const OTHER = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const DIR = process.cwd()
const NONCE = 'AB12CD'
const EXE = process.platform === 'win32' ? 'C:\\synthetic\\codex.exe' : '/synthetic/codex'
const message = { id: 'AB-APP-1', nonce: NONCE, prompt: `Synthetic board reply: Blue.\nReply with the line ACK ${NONCE} first.` }
const writerHeld = { started: true, exitCode: 1, timedOut: false, spawnErrorCode: null, spawnErrorMessage: null, stdout: '', stderr: `Error: thread-store conflict: thread ${THREAD} already has an active writer\n`, hasStdout: false, isStderrCut: false, isOutputOpen: false }
const answered = { started: true, exitCode: 0, timedOut: false, spawnErrorCode: null, spawnErrorMessage: null, stdout: `ACK ${NONCE}\nBlue it is.\n`, stderr: '', hasStdout: true, isStderrCut: false, isOutputOpen: false }

// A stand-in board client: attach() keeps what the receiver gave it, so a test can deliver a message the way the board would.
const fakeClient = () => {
  const attached = new Map()
  return {
    attached,
    attach: async options => {
      if (!await options.verify()) throw new Error('HOST_NOT_CONNECTED')
      let isClosed = false
      const one = { options, closed: [], sending: 0, close: async how => { isClosed = true; one.closed.push(how ?? {}) }, isClosed: () => isClosed, isContested: () => false, isSending: () => one.sending > 0 }
      attached.set(options.session, one)
      return one
    },
  }
}
// The five callbacks the board client hands a delivery, each counting its calls.
const callbacks = () => {
  const said = []
  return {
    said,
    accept: async () => { said.push('accepted') },
    begin: () => { said.push('begin') },
    unsent: async () => { said.push('unsent') },
    starting: async () => { said.push('starting') },
    held: async () => { said.push('held') },
  }
}
const deliverWith = (one, cb) => one.options.deliver(message, cb.accept, cb.begin, cb.unsent, cb.starting, cb.held)
// As the board client does it: the delivery counts as in flight until its receipt has been sent, after the run is over.
const processWith = async (one, cb, receipt) => {
  one.sending += 1
  try {
    const reply = await deliverWith(one, cb)
    await receipt()
    return reply
  } finally { one.sending -= 1 }
}

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
    giveBackWaitMs: 0, onError: over.onError,
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
    // The message's own limit: an app left open does not keep the reply waiting for ever.
    assert.match(s.serveReopenWaitingCodexApp, /30/)
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

test('while the app still holds the conversation, nothing was sent: the message goes back to the queue and waits 30 seconds, each time it is refused', async () => {
  const { app, client, runs, advance } = receiver({ results: [writerHeld, writerHeld, answered] })
  await app.tick()
  const one = client.attached.get(THREAD)
  for (const time of ['first', 'second']) {
    const cb = callbacks()
    assert.equal(await deliverWith(one, cb), undefined, time)
    // `held`, not `unsent`: only Codex's refusal starts the board's 30 minutes (hooks/messaging.ts).
    assert.deepEqual(cb.said, ['starting', 'held'], `given back as held, never begun (${time} refusal)`)
    assert.equal(await one.options.canReceive(), false, time)
    advance(29_999)
    assert.equal(await one.options.canReceive(), false, time)
    advance(1)
    assert.equal(await one.options.canReceive(), true, time)
  }
  const again = callbacks()
  assert.equal(await deliverWith(one, again), `ACK ${NONCE} Blue it is.`)
  assert.deepEqual(again.said, ['starting', 'begin'])
  assert.equal(runs.length, 3)
  app.kill()
})

test('a refusal the app repeats past 30 minutes is still given back as held: the board, not the receiver, counts the message\'s time', async () => {
  const { app, client, runs, advance } = receiver({ results: [writerHeld] })
  await app.tick()
  const one = client.attached.get(THREAD)
  for (const after of [0, 31 * 60 * 1000]) {
    advance(after)
    const cb = callbacks()
    assert.equal(await deliverWith(one, cb), undefined)
    assert.deepEqual(cb.said, ['starting', 'held'], `given back as held, never begun (${after / 60_000} minutes on)`)
  }
  assert.equal(runs.length, 2)
  app.kill()
})

test('only Codex\'s own writer refusal reads as nothing sent', () => {
  // Codex 0.167's own words: `thread <id> already has an active writer`, inside a thread-store conflict, after `Error: `.
  const held = result => isWriterHeld(result, THREAD)
  assert.equal(held(writerHeld), true)
  assert.equal(held({ ...writerHeld, stderr: `Error: thread ${THREAD} already has an active writer` }), true, 'without the thread-store prefix')
  assert.equal(held({ ...writerHeld, stderr: `warning: synthetic notice\r\nthread-store conflict: thread ${THREAD} already has an active writer.\r\n` }), true, 'after another line, with a full stop')
  assert.equal(held({ ...writerHeld, exitCode: 0 }), false, 'a run that ended well')
  assert.equal(held({ ...writerHeld, stdout: `ACK ${NONCE}\n` }), false, 'a run that answered')
  assert.equal(held({ ...writerHeld, stdout: 'Some reply text' }), false, 'a run that said something')
  assert.equal(held({ ...writerHeld, timedOut: true }), false, 'a run that timed out')
  assert.equal(held({ ...writerHeld, stderr: 'Error: model request failed' }), false, 'another failure')
  assert.equal(held({ ...writerHeld, stderr: `Error: thread-store conflict: thread ${THREAD} could not be read` }), false, 'a thread-store conflict that names no writer')
  assert.equal(held({ ...writerHeld, stderr: 'Error: thread-store conflict: no active writer' }), false, 'a conflict that says there is no writer')
  assert.equal(held({ ...writerHeld, stderr: `Error: thread-store conflict: thread ${OTHER} already has an active writer` }), false, 'another conversation\'s writer')
  assert.equal(held({ ...writerHeld, stderr: `Error: retried after thread ${THREAD} already has an active writer, then failed` }), false, 'inside a longer line')
  assert.equal(held({ ...writerHeld, stderr: `Error: thread ${THREAD} already has an active writer\nError: turn failed after writing` }), false, 'not the last line')
  assert.equal(held({ ...writerHeld, started: false }), false, 'never started')
  assert.equal(held({ ...writerHeld, hasStdout: true }), false, 'a run that printed something before the output kept')
  assert.equal(held({ ...writerHeld, isStderrCut: true }), false, 'an error output too long to keep whole')
  assert.equal(held({ ...writerHeld, isOutputOpen: true }), false, 'a run read before its output had closed')
  for (const field of ['hasStdout', 'isStderrCut', 'isOutputOpen']) {
    const { [field]: _said, ...unsaid } = writerHeld
    assert.equal(held(unsaid), false, `a result that does not say ${field}`)
  }
})

// A stand-in Codex: this Node, printing what a test asks for, then failing.
const standIn = (stdout, stderr) => ({ command: process.execPath, isShell: false, args: ['-e', `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1`] })
const sentence = `Error: thread-store conflict: thread ${THREAD} already has an active writer\n`

test('a run that printed anything, however far back, is never read as unsent', async () => {
  const quiet = await runBackgroundProcess(standIn('', sentence), { maxWaitMs: 20_000 })
  assert.deepEqual([quiet.exitCode, quiet.hasStdout, quiet.isStderrCut, quiet.isOutputOpen, isWriterHeld(quiet, THREAD)], [1, false, false, false, true], 'the refusal alone')
  // An answer, then more blanks than the 8,000 characters of output kept: the kept part is blank, the run is not.
  const answer = await runBackgroundProcess(standIn(`ACK ${NONCE}\nBlue it is.\n${' '.repeat(8001)}`, sentence), { maxWaitMs: 20_000 })
  assert.equal(answer.stdout.trim(), '', 'the kept output is blank')
  assert.deepEqual([answer.hasStdout, isWriterHeld(answer, THREAD)], [true, false])
})

test('an error output too long to keep whole is never read as unsent', async () => {
  const long = await runBackgroundProcess(standIn('', `${'warning: synthetic notice\n'.repeat(100)}${sentence}`), { maxWaitMs: 20_000 })
  assert.deepEqual([long.hasStdout, long.isStderrCut, isWriterHeld(long, THREAD)], [false, true, false])
})

test('a refusal read while a child of the run still holds its output is uncertain, never held', async () => {
  // The program writes the refusal and exits, but a program it started still holds the output open and writes later: the
  // runner reads the run two seconds after the exit, before the output has closed, so it cannot know nothing more came.
  // The later program is started detached: on Windows a Node program ends the programs it started, unless detached, when
  // it exits, which Codex does not do to the programs it starts.
  const late = 'setTimeout(() => process.stdout.write("late answer"), 3000)'
  const parent = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(late)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref(); process.stderr.write(${JSON.stringify(sentence)}); process.exitCode = 1`
  const open = await runBackgroundProcess({ command: process.execPath, isShell: false, args: ['-e', parent] }, { maxWaitMs: 20_000 })
  assert.deepEqual([open.exitCode, open.hasStdout, open.isOutputOpen, isWriterHeld(open, THREAD)], [1, false, true, false])
})

// The board client's error for an answer that saved nothing because the message store was busy (scripts/message-client.mjs).
const busy = () => Object.assign(new Error('MESSAGE_STORE_BUSY'), { isBusy: true, isRefused: true, isRetryable: true })

test('a busy store is asked for the held give-back again until it saves it', async () => {
  const errors = []
  const { app, client, runs } = receiver({ results: [writerHeld], onError: error => errors.push(error.message) })
  await app.tick()
  const cb = callbacks()
  let asks = 0
  cb.held = async () => { cb.said.push('held'); asks += 1; if (asks <= 2) throw busy() }
  assert.equal(await deliverWith(client.attached.get(THREAD), cb), undefined)
  assert.deepEqual(cb.said, ['starting', 'held', 'held', 'held'], 'asked again, never begun')
  assert.deepEqual(errors, ['MESSAGE_STORE_BUSY'], 'a store that stays busy is reported once')
  assert.equal(runs.length, 1)
  app.kill()
})

test('a store that stays busy is asked for a give-back five times at most, and an answer that may have saved it is never asked again', async () => {
  for (const [name, failure, asked] of [['busy', busy, 5], ['server error', () => Object.assign(new Error('BOARD_UNAVAILABLE'), { isRetryable: true, isRefused: false }), 1], ['no answer', () => new Error('fetch failed'), 1]]) {
    const errors = []
    const { app, client, runs } = receiver({ results: [writerHeld], onError: error => errors.push(error.message) })
    await app.tick()
    const cb = callbacks()
    cb.held = async () => { cb.said.push('held'); throw failure() }
    assert.equal(await deliverWith(client.attached.get(THREAD), cb), undefined, name)
    assert.deepEqual(cb.said, ['starting', ...Array(asked).fill('held')], name)
    assert.equal(errors.length, 1, name)
    assert.equal(runs.length, 1, name)
    app.kill()
  }
  // An `unsent` give-back is asked again the same way: here the conversation runs a turn when the claim comes.
  const { app, client, state } = receiver()
  await app.tick()
  state.set(THREAD, 'working')
  const cb = callbacks()
  let asks = 0
  cb.unsent = async () => { cb.said.push('unsent'); asks += 1; if (asks === 1) throw busy() }
  assert.equal(await deliverWith(client.attached.get(THREAD), cb), undefined)
  assert.deepEqual(cb.said, ['unsent', 'unsent'])
  app.kill()
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

test('a turn that starts while the starting receipt is on its way runs nothing and gives the claim back', async () => {
  for (const change of ['working', 'taken']) {
    let isTaken = false
    const { app, client, runs, state } = receiver({ isTaken: () => isTaken })
    await app.tick()
    const cb = callbacks()
    cb.starting = async () => {
      cb.said.push('starting')
      // The person typed in the conversation (or the daemon receiver took it) while the board was answering.
      if (change === 'working') state.set(THREAD, 'working')
      else isTaken = true
    }
    assert.equal(await deliverWith(client.attached.get(THREAD), cb), undefined, change)
    assert.deepEqual(cb.said, ['starting', 'unsent'], change)
    assert.equal(runs.length, 0, change)
    app.kill()
  }
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
  // Closed without `ended`, by an automatic receiver (`unclaimed`): the board then keeps a reply still queued for it, with its
  // leave stamp, and refuses it only after its wait (#318; the board's own rule, tests/delivery-states.test.mjs, queued on leave).
  assert.deepEqual(one.closed, [{}])
  assert.equal(one.options.unclaimed, true)
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
  // The first delivery as the board client runs it: in flight until its receipt has been sent, after the run is over.
  let sent
  const receipt = new Promise(done => { sent = done })
  const first = processWith(one, callbacks(), () => receipt)
  await new Promise(done => setImmediate(done))
  assert.equal(await one.options.canReceive(), false, 'while the first run lasts')
  release()
  await new Promise(done => setImmediate(done))
  assert.equal(runs.length, 1)
  assert.equal(app.sending(), 1, 'the run is over; its receipt is on its way')
  assert.equal(await one.options.canReceive(), false, 'while the first receipt is on its way')
  sent()
  assert.equal(await first, `ACK ${NONCE} Blue it is.`)
  assert.equal(await one.options.canReceive(), true)
  app.kill()
})

// A receipt the test holds: the delivery stays in flight, as the board client counts it, until the test lets the receipt go.
const heldReceipt = () => { let sent; const receipt = new Promise(done => { sent = done }); return { receipt: () => receipt, sent: () => sent() } }

test('a new connection takes nothing while an earlier one\'s receipt is on its way', async () => {
  const { app, client, runs } = receiver()
  await app.tick()
  const first = client.attached.get(THREAD)
  const pending = heldReceipt()
  const reply = processWith(first, callbacks(), pending.receipt)
  await new Promise(done => setImmediate(done))
  assert.equal(runs.length, 1)
  // The run is over and its ACK is on its way when the connection goes; the next tick attaches again.
  await first.close()
  await app.tick()
  const again = client.attached.get(THREAD)
  assert.notEqual(again, first)
  assert.equal(app.sending(), 1, 'the earlier receipt still counts')
  assert.equal(await again.options.canReceive(), false, 'while the earlier receipt is on its way')
  pending.sent()
  assert.equal(await reply, `ACK ${NONCE} Blue it is.`)
  await app.tick()
  assert.equal(app.sending(), 0)
  assert.equal(await again.options.canReceive(), true)
  app.kill()
})

test('a stopped board counts a receipt still on its way', async () => {
  const { app, client } = receiver()
  await app.tick()
  const one = client.attached.get(THREAD)
  const pending = heldReceipt()
  const reply = processWith(one, callbacks(), pending.receipt)
  await new Promise(done => setImmediate(done))
  app.kill()
  assert.equal(app.sending(), 1)
  pending.sent()
  await reply
  assert.equal(app.sending(), 0)
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
  let receiptIn
  const receipt = new Promise(done => { receiptIn = done })
  const reply = processWith(one, callbacks(), () => receipt)
  await new Promise(done => setImmediate(done))
  listed = []
  await app.tick()
  assert.equal(await one.options.verify(), true)
  assert.equal(one.isClosed(), false)
  release()
  await new Promise(done => setImmediate(done))
  // The run is over and its ACK receipt is still on its way: the connection stays, and the board counts it as sending.
  await app.tick()
  assert.equal(await one.options.verify(), true)
  assert.equal(one.isClosed(), false)
  assert.equal(app.sending(), 1)
  receiptIn()
  assert.equal(await reply, `ACK ${NONCE} Blue it is.`)
  // Once the receipt is in, a conversation the board no longer lists is let go.
  assert.equal(await one.options.verify(), false)
  assert.equal(app.sending(), 0)
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

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// The board half of the Antigravity sidecar wake (#1396): the three calls the sidecar makes (the contract in
// hooks/antigravity-sidecar.ts), the desktop app's idle route that sends at once only while the sidecar polls,
// and the 10 seconds the board waits after a turn's Stop. The clock is passed in; every id and text is synthetic.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })
const { createMessaging } = await import('../scripts/board-messaging.ts')
const { RECEIVER_ROUTES } = await import('../hooks/receiver-routes.ts')
const { mailboxId, SIDECAR_ALIVE_MS, WAKE_IDLE_MS } = await import('../hooks/hook-messages.ts')
const { ANTIGRAVITY_POLL_MS } = await import('../hooks/antigravity-sidecar.ts')
const { serveModel, servePage } = await import('../hooks/serve.ts')
const { parseProgress } = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { EN } = await import('../hooks/strings-en.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')
const { ZH_CN } = await import('../hooks/strings-zh-cn.ts')
const { pageDom } = await import('./e2e/lib/surfaces.mjs')

const IDE = 'IDE', TUI = 'agy TUI'
const APP = '0b6d6e0e-6f43-4c0b-9a58-3f1a7e3a1c11', APP_2 = '2d8f8a2a-8165-4e2d-9c7a-5a3c9a5c3e33', TERMINAL = '1c7e7f1f-7054-4d1c-8b69-4f2b8f4b2d22'
const T = Date.UTC(2026, 10, 16, 12)
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

// A board's message store with its gate. `reports` holds when each conversation's progress rows last read waiting; a
// conversation missing from it is working. The gate also offers that time as `idleSince`, which only the board before
// #1602's first review read (as its turn's end): this board ignores it, so these tests also run against that board.
const world = (reports = { [APP]: T - 20_000, [APP_2]: T - 20_000, [TERMINAL]: T - 20_000 }) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-wake-'))
  const hub = createMessaging(join(dir, 'messages'), false, {
    routes: RECEIVER_ROUTES,
    stateOfSession: (_agent, session) => reports[session] === undefined ? 'working' : 'idle',
    idleSince: (_agent, session) => reports[session],
  })
  // The turn-start hook's take, with the claim name a hook gives it when one is passed.
  const enroll = (session, surface, now, ref) => hub.act('mailbox-turn', { agent: 'antigravity', session, surface, ...(ref === undefined ? {} : { ref }) }, now).message
  // A turn's Stop: its progress row reads waiting and its hook tells the board. A board before #1602's first review
  // has no mailbox-idle (it answers UNKNOWN_FIELD) and reads the Stop from the progress row alone. This board never
  // answers mailbox-idle so, and every wake below needs the call to work here.
  const stop = (session, now) => {
    reports[session] = now
    try { hub.act('mailbox-idle', { agent: 'antigravity', session }, now) } catch (error) { if (error.message !== 'UNKNOWN_FIELD') throw error }
  }
  // A conversation whose last turn started 30 s ago and stopped 20 s ago.
  const ready = (session, surface = IDE) => { enroll(session, surface, T - 30_000); stop(session, T - 20_000) }
  const send = (session, id, now) => hub.act('send', { id, target: mailboxId('antigravity', session), turn: 'session', text: `Synthetic note ${id}` }, now)
  const poll = now => hub.act('wake-poll', { agent: 'antigravity' }, now)
  const shown = (id, now) => hub.snapshot(now).messages.find(one => one.id === id)
  const saved = id => JSON.parse(readFileSync(join(dir, 'messages', 'messages.json'), 'utf8')).messages.find(one => one.id === id)
  return { hub, reports, enroll, stop, ready, send, poll, shown, saved, close: () => { hub.close(); rmSync(dir, { recursive: true, force: true }) } }
}
const using = async fn => {
  const w = world()
  try { await fn(w) } finally { w.close() }
}

test('wake-poll lists only a queued message on the app\'s now route, one per poll, without its text, and each poll marks the sidecar alive', () => using(w => {
  w.ready(APP); w.ready(TERMINAL, TUI)
  assert.equal(w.hub.snapshot(T).sidecar, false)
  // Before any poll the app keeps the next-turn route it has today.
  assert.equal(w.send(APP, 'm-before', T).line, 'nextTurn')
  w.hub.act('dismiss', { id: 'm-before' }, T)
  assert.deepEqual(w.poll(T), { wakes: [] })
  assert.equal(w.hub.snapshot(T).sidecar, true)
  assert.equal(w.send(APP, 'm-app', T).line, 'now')
  // agy TUI runs no sidecar, so its idle route stays the next turn.
  assert.equal(w.send(TERMINAL, 'm-terminal', T).line, 'nextTurn')
  const { wakes } = w.poll(T + 1000)
  assert.equal(wakes.length, 1)
  assert.deepEqual(Object.keys(wakes[0]).sort(), ['conversation', 'id', 'nonce'])
  assert.equal(wakes[0].id, 'm-app')
  assert.equal(wakes[0].conversation, APP)
  assert.match(wakes[0].nonce, TOKEN)
  assert.doesNotMatch(JSON.stringify(wakes), /Synthetic note/)
  // The same wake until it is attempted; once the turn-start hook has the message, none.
  assert.deepEqual(w.poll(T + 2000), { wakes })
  assert.equal(w.enroll(APP, IDE, T + 3000).id, 'm-app')
  assert.deepEqual(w.poll(T + 4000), { wakes: [] })
  assert.throws(() => w.hub.act('wake-poll', { agent: 'codex' }, T + 5000))
  assert.throws(() => w.hub.act('wake-poll', { agent: 'antigravity', extra: 1 }, T + 5000))
}))

test('wake-attempt answers ok once per message after saving the start, and any other attempt is refused with a code', () => using(w => {
  w.ready(APP)
  w.poll(T)
  w.send(APP, 'm-app', T)
  const [wake] = w.poll(T + 1000).wakes
  assert.deepEqual(w.hub.act('wake-attempt', { id: 'm-unknown', nonce: wake.nonce }, T + 1500), { ok: false, code: 'NOT_HELD' })
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: 'wrong-nonce' }, T + 1500), { ok: false, code: 'NOT_HELD' })
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 2000), { ok: true })
  // The start is on disk before the sidecar runs anything, in a field of its own: OpenCode's attempt mark stays unset.
  assert.equal(w.saved('m-app').woke, T + 2000)
  assert.equal(w.saved('m-app').attempted, undefined)
  assert.equal(w.saved('m-app').status, 'queued')
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 2500), { ok: false, code: 'WAKE_STARTED' })
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  assert.throws(() => w.hub.act('wake-attempt', { id: wake.id, nonce: 'not a token' }, T + 3000))
  // The turn-start hook still hands the message over, as it does for any hook mailbox.
  assert.equal(w.enroll(APP, IDE, T + 61_000).text, 'Synthetic note m-app')
}))

test('wake-report keeps sent or failed, a repeated report is the same report, a failed wake is not tried again and its message waits for the next turn', () => using(w => {
  w.ready(APP); w.ready(APP_2)
  w.poll(T)
  w.send(APP, 'm-fail', T)
  const [failing] = w.poll(T + 1000).wakes
  assert.deepEqual(w.hub.act('wake-report', { id: failing.id, nonce: failing.nonce, status: 'failed', error: 'EXIT_1' }, T + 1100), { ok: false, code: 'NOT_STARTED' })
  w.hub.act('wake-attempt', { id: failing.id, nonce: failing.nonce }, T + 1200)
  assert.equal(w.shown('m-fail', T + 1200).wake, 'started')
  assert.deepEqual(w.hub.act('wake-report', { id: failing.id, nonce: failing.nonce, status: 'failed', error: 'EXIT_1' }, T + 1300), { ok: true })
  assert.deepEqual(w.hub.act('wake-report', { id: failing.id, nonce: failing.nonce, status: 'failed', error: 'EXIT_1' }, T + 2300), { ok: true })
  // Another status for a wake already reported does not change it.
  assert.deepEqual(w.hub.act('wake-report', { id: failing.id, nonce: failing.nonce, status: 'sent' }, T + 3300), { ok: true })
  assert.equal(w.saved('m-fail').wake, 'failed')
  assert.equal(w.shown('m-fail', T + 3300).status, 'queued')
  assert.equal(w.shown('m-fail', T + 3300).wake, 'failed')
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  assert.deepEqual(w.hub.act('wake-attempt', { id: failing.id, nonce: failing.nonce }, T + 60_000), { ok: false, code: 'WAKE_STARTED' })
  assert.equal(w.enroll(APP, IDE, T + 61_000).id, 'm-fail')
  // A sent report reads as woken on the card.
  w.poll(T + 61_000)
  w.send(APP_2, 'm-sent', T + 61_000)
  const [sending] = w.poll(T + 62_000).wakes
  w.hub.act('wake-attempt', { id: sending.id, nonce: sending.nonce }, T + 62_000)
  assert.deepEqual(w.hub.act('wake-report', { id: sending.id, nonce: sending.nonce, status: 'sent' }, T + 62_500), { ok: true })
  assert.deepEqual(w.hub.act('wake-report', { id: sending.id, nonce: sending.nonce, status: 'sent' }, T + 63_500), { ok: true })
  assert.equal(w.shown('m-sent', T + 63_500).wake, 'sent')
  assert.throws(() => w.hub.act('wake-report', { id: sending.id, nonce: sending.nonce, status: 'done' }, T + 64_000))
}))

test('the app\'s idle route sends at once only while the sidecar has polled within its window, and the card follows', () => using(w => {
  // One slow wait after a poll that got no answer, plus two fast polls: a lost answer does not take Send away.
  assert.equal(SIDECAR_ALIVE_MS, ANTIGRAVITY_POLL_MS.slow + 2 * ANTIGRAVITY_POLL_MS.fast)
  w.enroll(APP, IDE, T)
  w.poll(T)
  assert.equal(w.send(APP, 'm-alive', T + SIDECAR_ALIVE_MS).line, 'now')
  w.hub.act('dismiss', { id: 'm-alive' }, T + SIDECAR_ALIVE_MS)
  assert.equal(w.hub.snapshot(T + SIDECAR_ALIVE_MS + 1).sidecar, false)
  assert.equal(w.send(APP, 'm-stopped', T + SIDECAR_ALIVE_MS + 1).line, 'nextTurn')
  const file = `## Synthetic\n<!-- auto session=abcdef01 agent=antigravity resume=${APP} state=waiting updated=${new Date(T - 20_000).toISOString()} -->\n### App card\n- [?] Pick one?\n<!-- /auto session=abcdef01 -->\n`
  const view = buildView(parseProgress(file), [], null, T, 0, {}, EN)
  const card = (messaging, now) => serveModel(view, [], EN, new Set(), false, messaging, false, { now, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] }, RECEIVER_ROUTES).asks[0]
  const box = w.hub.snapshot(T).mailboxes
  assert.equal(card({ connections: [], mailboxes: box, messages: [], sidecar: true }, T).line, 'now')
  assert.equal(card({ connections: [], mailboxes: box, messages: [], sidecar: false }, T).line, 'nextTurn')
  assert.equal(card({ connections: [], mailboxes: box, messages: [] }, T).line, 'nextTurn')
}))

test('no wake while a turn runs, none within 10 s of its Stop, and none while a wake\'s turn runs until that turn\'s Stop', () => using(w => {
  assert.equal(WAKE_IDLE_MS, 10_000)
  // A turn has started and has not stopped: nothing is woken however long it runs.
  w.enroll(APP, IDE, T - 30_000)
  w.poll(T)
  w.send(APP, 'm-first', T)
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  w.stop(APP, T + 60_000)
  assert.deepEqual(w.poll(T + 60_000 + WAKE_IDLE_MS - 1), { wakes: [] })
  const [first] = w.poll(T + 60_000 + WAKE_IDLE_MS).wakes
  assert.equal(first.id, 'm-first')
  w.hub.act('wake-attempt', { id: first.id, nonce: first.nonce }, T + 70_001)
  w.hub.act('wake-report', { id: first.id, nonce: first.nonce, status: 'sent' }, T + 70_002)
  // The wake's turn starts: its hook takes the message, and the next message waits for that turn's Stop.
  const handed = w.enroll(APP, IDE, T + 70_500)
  w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: handed.id, nonce: handed.nonce }, T + 70_600)
  w.send(APP, 'm-second', T + 71_000)
  assert.deepEqual(w.poll(T + 200_000), { wakes: [] })
  w.stop(APP, T + 200_000)
  assert.deepEqual(w.poll(T + 200_000 + WAKE_IDLE_MS - 1), { wakes: [] })
  assert.equal(w.poll(T + 200_000 + WAKE_IDLE_MS).wakes[0]?.id, 'm-second')
}))

test('a progress report that reads waiting before the turn\'s Stop starts no wake, and one wake follows 10 s after the Stop', () => using(w => {
  // The turn starts with nothing queued, and the sidecar is on.
  delete w.reports[APP]
  w.enroll(APP, IDE, T)
  w.poll(T)
  // The model's own report reads waiting while the turn still runs; the board sends on the idle route.
  w.reports[APP] = T + 1000
  assert.equal(w.send(APP, 'm-early', T + 1000).line, 'now')
  assert.deepEqual(w.poll(T + 1000 + 2 * WAKE_IDLE_MS), { wakes: [] })
  w.stop(APP, T + 25_000)
  assert.deepEqual(w.poll(T + 25_000 + WAKE_IDLE_MS - 1), { wakes: [] })
  const { wakes } = w.poll(T + 25_000 + WAKE_IDLE_MS)
  assert.deepEqual(wakes.map(one => one.id), ['m-early'])
  assert.deepEqual(w.hub.act('wake-attempt', { id: wakes[0].id, nonce: wakes[0].nonce }, T + 36_000), { ok: true })
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
}))

test('a turn start whose board call failed starts no wake while its progress row reads working', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  w.stop(APP, T)
  w.poll(T)
  // Sent within 10 s of the Stop, on the idle route.
  assert.equal(w.send(APP, 'm-mid', T + 2000).line, 'now')
  // A new turn starts: its hook writes the progress row as working, but its take never reaches the board, so the
  // mailbox still holds the last Stop as its newest event.
  delete w.reports[APP]
  assert.deepEqual(w.poll(T + 15_000), { wakes: [] })
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  assert.equal(w.shown('m-mid', T + 60_000).wake, undefined)
  // That turn's Stop reaches the board; 10 s later the message is woken.
  w.stop(APP, T + 60_000)
  assert.deepEqual(w.poll(T + 60_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-mid'])
}))

test('a peer message queued before the board message starts no wake while the next turn would take the peer message', () => using(w => {
  w.ready(APP)
  w.poll(T)
  const peer = w.hub.act('register', { agent: 'gemini', session: 'peer-session', surface: 'CLI', turn: 'peer-turn' }, T)
  w.hub.act('send', { id: 'm-peer', target: mailboxId('antigravity', APP), turn: 'session', text: 'Synthetic peer note', source: peer.id, secret: peer.secret }, T)
  assert.equal(w.send(APP, 'm-board', T).line, 'now')
  // The next turn's hook takes the peer message first, so a wake would leave the board message queued under a woken card.
  assert.deepEqual(w.poll(T + 1000), { wakes: [] })
  assert.equal(w.shown('m-board', T + 1000).wake, undefined)
  // The person's next turn takes the peer message; after that turn's Stop the board message is the one to wake.
  const handed = w.enroll(APP, IDE, T + 2000)
  assert.equal(handed.id, 'm-peer')
  w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: handed.id, nonce: handed.nonce }, T + 2100)
  w.stop(APP, T + 5000)
  assert.equal(w.poll(T + 5000 + WAKE_IDLE_MS).wakes[0]?.id, 'm-board')
}))

test('a woken message whose turn\'s claim is handed back goes back to the queue at once', () => using(w => {
  const REF = '0123456789ab'
  w.ready(APP)
  w.poll(T)
  w.send(APP, 'm-woken', T)
  const [wake] = w.poll(T + 1000).wakes
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1000), { ok: true })
  // The woken turn's hook claims the message, stops waiting before it could show it, and hands the claim back.
  assert.equal(w.enroll(APP, IDE, T + 1500, REF).id, 'm-woken')
  assert.deepEqual(w.hub.act('mailbox-release', { agent: 'antigravity', session: APP, ref: REF }, T + 1600), { ok: true })
  assert.equal(w.saved('m-woken').status, 'queued')
  assert.equal(w.saved('m-woken').ref, undefined)
  // The next take has it at once, not after the claim's lease; it is never woken a second time.
  w.stop(APP, T + 2000)
  assert.deepEqual(w.poll(T + 2000 + WAKE_IDLE_MS), { wakes: [] })
  assert.equal(w.enroll(APP, IDE, T + 2000 + WAKE_IDLE_MS).id, 'm-woken')
}))

test('Antigravity\'s Stop hook tells a running board its turn ended, its other events do not, and with no board running it writes nothing', async () => {
  const { createServer } = await import('node:http')
  const { deliverTurnEvent } = await import('../scripts/hook-delivery.ts')
  const { defaultMessagesDirectory } = await import('../scripts/runtime-folder.ts')
  const home = mkdtempSync(join(tmpdir(), 'agy-stop-'))
  // The hook finds the messages folder from the environment; without XDG_RUNTIME_DIR it is under this home on every system.
  const runtime = process.env.XDG_RUNTIME_DIR
  delete process.env.XDG_RUNTIME_DIR
  const calls = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push([req.url, JSON.parse(body)])
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const progress = join(home, 'progress.md')
    const folder = defaultMessagesDirectory(progress, home, process.env, process.platform)
    mkdirSync(folder, { recursive: true })
    const hook = event => deliverTurnEvent({
      mode: '--agent-status', agent: 'antigravity', event, session: APP, report: {}, raw: {}, folder: home, base: null, progress, home, root: home,
      hookDeadline: Date.now() + 3000, s: EN, hash: text => text, readLocal: () => null, atomic: () => {}, checkDeadline: () => {}, hereNames: () => [],
    })
    // No board running: the hook writes nothing, so the store is the same bytes.
    const store = JSON.stringify({ version: 2, messages: [], mailboxes: [{ id: mailboxId('antigravity', APP), agent: 'antigravity', session: APP, surface: IDE, turn: 'session', scope: 'mailbox', expires: Date.now() + 60_000, origin: 'local' }] })
    writeFileSync(join(folder, 'messages.json'), store)
    assert.equal(await hook('Stop'), false)
    assert.equal(readFileSync(join(folder, 'messages.json'), 'utf8'), store)
    writeFileSync(join(folder, 'server.lock'), String(process.pid))
    writeFileSync(join(folder, 'server.owner'), JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.address().port}/?t=synthetic-token` }))
    assert.equal(await hook('PostInvocation'), false)
    assert.equal(await hook('Stop'), false)
    assert.deepEqual(calls, [['/api/messages/mailbox-idle', { agent: 'antigravity', session: APP }]])
  } finally {
    if (runtime !== undefined) process.env.XDG_RUNTIME_DIR = runtime
    await new Promise(done => server.close(done))
    rmSync(home, { recursive: true, force: true })
  }
  // The board takes the Stop only from Antigravity, and only for a mailbox it has.
  await using(w => {
    assert.throws(() => w.hub.act('mailbox-idle', { agent: 'codex', session: APP }, T), /INVALID_MAILBOX_CALL/)
    assert.deepEqual(w.hub.act('mailbox-idle', { agent: 'antigravity', session: APP }, T), { ok: true })
    assert.deepEqual(w.hub.snapshot(T).mailboxes, [])
    w.enroll(APP, IDE, T)
    w.stop(APP, T + 1000)
    const [box] = w.hub.snapshot(T + 1000).mailboxes
    assert.deepEqual([box.busyAt, box.idleAt], [T, T + 1000])
  })
})

test('the card says woken, wake failed, waking or sidecar not on in en, zh-TW and zh-CN', async () => {
  const file = `## Synthetic\n<!-- auto session=abcdef01 agent=antigravity resume=${APP} state=waiting updated=${new Date(T - 20_000).toISOString()} -->\n### App card\n- [?] Pick one?\n<!-- /auto session=abcdef01 -->\n`
  const target = mailboxId('antigravity', APP)
  const mailboxes = [{ id: target, agent: 'antigravity', session: APP, surface: IDE, turn: 'session', scope: 'mailbox', expires: T + 60_000, origin: 'local' }]
  for (const s of [EN, ZH_TW, ZH_CN]) for (const [wake, key] of [['sent', 'agyWoken'], ['failed', 'agyWakeFailed'], ['started', 'agyWaking'], ['off', 'agySidecarOff']]) {
    const message = { id: 'm-card', target, turn: 'session', from: 'board', to: `antigravity:${APP}`, text: 'Synthetic', origin: 'local', status: 'queued', updated: T, reply: '', error: '', hops: 1, claimed: 0, line: 'now', surface: IDE, wake }
    const view = buildView(parseProgress(file), [], null, T, 0, {}, s)
    const model = serveModel(view, [], s, new Set(), false, { connections: [], mailboxes, messages: [message], sidecar: wake !== 'off' }, false, { now: T, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] }, RECEIVER_ROUTES)
    const page = await pageDom(servePage(s, 'synthetic-nonce'), model, async () => ({ ok: true, json: async () => ({ ok: true }) }))
    assert.equal(typeof s[key], 'string', key)
    assert.ok(page.text().includes(s[key]), `${key}: ${page.text()}`)
  }
})

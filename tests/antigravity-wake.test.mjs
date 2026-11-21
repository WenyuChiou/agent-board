import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
const { createMessaging, readTurnOrder } = await import('../scripts/board-messaging.ts')
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

// A board's message store with its gate, and beside it each conversation's turn order file, by the name Antigravity's
// hooks give it, written here as they write it: a turn start adds one to `started` and sends that number with its take, a
// Stop sets `stopped` to it. `reports` holds when each conversation's progress rows last read waiting (a conversation
// missing from it is working) and `written` when they were last written, in whole seconds as rows keep them: this board
// reads neither for a wake, the board at e8025827 read both. That board also took the Stop by a call (`mailbox-idle`, with
// the hook's time) and refuses a take's `seq`; this one refuses the call, so both answer UNKNOWN_FIELD and go on, as the
// hook does for `seq`.
const world = (reports = { [APP]: T - 20_000, [APP_2]: T - 20_000, [TERMINAL]: T - 20_000 }, written = { ...reports }, onTurns = () => {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-wake-'))
  const messages = join(dir, 'messages')
  const hub = createMessaging(messages, false, {
    routes: RECEIVER_ROUTES,
    stateOfSession: (_agent, session) => reports[session] === undefined ? 'working' : 'idle',
    writtenOfSession: (_agent, session) => written[session],
    turnsOfSession: (agent, session) => { onTurns(agent, session); return readTurnOrder(messages, agent, session) },
  })
  // A row is written again at each hook event and report, never back in time, and keeps whole seconds.
  const write = (session, now) => { written[session] = Math.max(written[session] ?? 0, Math.floor(now / 1000) * 1000) }
  const order = session => join(messages, `${mailboxId('antigravity', session)}.turns.json`)
  const turns = session => existsSync(order(session)) ? JSON.parse(readFileSync(order(session), 'utf8')) : { started: 0, stopped: 0, stoppedAt: 0 }
  const setTurns = (session, change) => writeFileSync(order(session), JSON.stringify({ ...turns(session), ...change }))
  // The turn-start hook: its order file write (unless it fails: the take still carries the number), its row write (unless
  // the event repeats the row's last one, which is not written again), then its take (unless it never reaches the board),
  // with the claim name a hook gives it when one is passed.
  const enroll = (session, surface, now, ref, { isFileLost = false, isRowKept = false, isTakeLost = false } = {}) => {
    const seq = turns(session).started + 1
    if (!isFileLost) setTurns(session, { started: seq })
    if (!isRowKept) write(session, now)
    if (isTakeLost) return null
    const body = { agent: 'antigravity', session, surface, ...(ref === undefined ? {} : { ref }) }
    try { return hub.act('mailbox-turn', { ...body, seq }, now).message } catch (error) {
      if (error.message !== 'UNKNOWN_FIELD') throw error
      return hub.act('mailbox-turn', body, now).message
    }
  }
  // The Stop's call as the board at e8025827 took it, with the hook's own time when it made the call.
  const stopCall = (session, at) => {
    try { hub.act('mailbox-idle', { agent: 'antigravity', session, at }, at) } catch (error) { if (error.message !== 'UNKNOWN_FIELD') throw error }
  }
  // A turn's Stop hook at `at`: it ends the turn last started in the order file and writes its row as waiting; its call
  // follows at once unless it is late (`stopCall` then sends it).
  const stop = (session, at, isCallLate = false) => {
    setTurns(session, { stopped: turns(session).started, stoppedAt: at })
    reports[session] = at
    write(session, at)
    if (!isCallLate) stopCall(session, at)
  }
  // The model reports it waits: its row reads waiting, written now.
  const report = (session, now) => { reports[session] = now; write(session, now) }
  // A conversation whose last turn started 30 s ago and stopped 20 s ago.
  const ready = (session, surface = IDE) => { enroll(session, surface, T - 30_000); stop(session, T - 20_000) }
  const send = (session, id, now) => hub.act('send', { id, target: mailboxId('antigravity', session), turn: 'session', text: `Synthetic note ${id}` }, now)
  const poll = now => hub.act('wake-poll', { agent: 'antigravity' }, now)
  const shown = (id, now) => hub.snapshot(now).messages.find(one => one.id === id)
  const saved = id => JSON.parse(readFileSync(join(dir, 'messages', 'messages.json'), 'utf8')).messages.find(one => one.id === id)
  return { hub, reports, written, order, enroll, stop, stopCall, report, ready, send, poll, shown, saved, close: () => { hub.close(); rmSync(dir, { recursive: true, force: true }) } }
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
  // The start is on disk before the sidecar runs anything, in a field of its own: OpenCode's attempt mark stays unset. It
  // names the turn whose Stop it followed, so that Stop starts no other wake.
  assert.equal(w.saved('m-app').woke, T + 2000)
  assert.equal(w.saved('m-app').wakeAfter, 1)
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
  // A new turn starts: its hook numbers it in the order file and writes the progress row as working, but its take never
  // reaches the board.
  assert.equal(w.enroll(APP, IDE, T + 3000, undefined, { isTakeLost: true }), null)
  delete w.reports[APP]
  assert.deepEqual(w.poll(T + 15_000), { wakes: [] })
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  assert.equal(w.shown('m-mid', T + 60_000).wake, undefined)
  // That turn's Stop; 10 s later the message is woken.
  w.stop(APP, T + 60_000)
  assert.deepEqual(w.poll(T + 60_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-mid'])
}))

// codex_478 on #1602: a model may report waiting in a turn whose take never reached the board.
test('a turn start whose board call failed starts no wake after the model reports waiting, until that turn\'s Stop', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  w.stop(APP, T)
  w.poll(T)
  assert.equal(w.send(APP, 'm-mid', T + 2000).line, 'now')
  assert.equal(w.enroll(APP, IDE, T + 3000, undefined, { isTakeLost: true }), null)
  delete w.reports[APP]
  w.report(APP, T + 5000)
  assert.deepEqual(w.poll(T + 15_000), { wakes: [] })
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  assert.equal(w.shown('m-mid', T + 60_000).wake, undefined)
  w.stop(APP, T + 60_000)
  assert.deepEqual(w.poll(T + 60_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-mid'])
}))

// codex_480 on #1602 and the Fable diagnosis on #1396: every mark the board kept was stamped when a handler ran or a call
// arrived, so one event broke each. Antigravity's own hooks number the turns instead. Each test below gives a wake on the
// board at e8025827.
test('a failed take and a waiting report in the Stop\'s own second start no wake', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  w.stop(APP, T + 100)
  w.poll(T + 200)
  assert.equal(w.send(APP, 'm-mid', T + 200).line, 'now')
  // The next turn starts within the Stop's second, and its take never reaches the board. The model reports waiting in
  // that same second, so its row reads waiting with the Stop's own second as its time.
  assert.equal(w.enroll(APP, IDE, T + 300, undefined, { isTakeLost: true }), null)
  delete w.reports[APP]
  w.report(APP, T + 600)
  assert.deepEqual(w.poll(T + 15_000), { wakes: [] })
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  // That turn's own Stop; 10 s later the message is woken.
  w.stop(APP, T + 60_000)
  assert.deepEqual(w.poll(T + 60_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-mid'])
}))

test('a Stop call that reaches the board after the next turn\'s take and report starts no wake', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  w.poll(T - 1000)
  // The Stop hook ends that turn at T, but its call (at e8025827) is made only after the next turn's take and report.
  w.stop(APP, T, true)
  assert.equal(w.enroll(APP, IDE, T + 1000), null)
  delete w.reports[APP]
  w.report(APP, T + 1500)
  assert.equal(w.send(APP, 'm-late', T + 1600).line, 'now')
  w.stopCall(APP, T + 2000)
  assert.deepEqual(w.poll(T + 15_000), { wakes: [] })
  // The running turn's own Stop; 10 s later the message is woken.
  w.stop(APP, T + 30_000)
  assert.deepEqual(w.poll(T + 30_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-late'])
}))

test('a repeated identical hook event after a failed take starts no wake', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  w.stop(APP, T + 100)
  w.poll(T + 200)
  assert.equal(w.send(APP, 'm-mid', T + 200).line, 'now')
  // A turn starts with an event that reads waiting (SessionStart) in the Stop's second, and its take never reaches the
  // board. The same event comes again: a row whose event and state are unchanged is not written again (the replay check
  // in scripts/codex-local.ts), so the row keeps the Stop's second, and that take is lost too. Each run counts a start.
  assert.equal(w.enroll(APP, IDE, T + 300, undefined, { isTakeLost: true }), null)
  assert.equal(w.enroll(APP, IDE, T + 4000, undefined, { isRowKept: true, isTakeLost: true }), null)
  assert.deepEqual(w.poll(T + 15_000), { wakes: [] })
  // The turn's Stop ends the last turn started, so the message is woken 10 s later.
  w.stop(APP, T + 60_000)
  assert.deepEqual(w.poll(T + 60_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-mid'])
}))

test('a wall clock set back between a Stop and the next take starts no wake', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  w.stop(APP, T)
  w.poll(T + 100)
  // The computer's clock goes back a minute. The next turn starts and its take reaches the board; the model reports
  // waiting and a message is sent, all by the clock set back.
  assert.equal(w.enroll(APP, IDE, T - 59_000), null)
  delete w.reports[APP]
  w.report(APP, T - 58_000)
  assert.equal(w.send(APP, 'm-back', T - 57_500).line, 'now')
  w.poll(T - 57_000)
  assert.deepEqual(w.poll(T + 15_000), { wakes: [] })
  w.stop(APP, T + 20_000)
  assert.deepEqual(w.poll(T + 20_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-back'])
}))

test('a failed order-file write with a take that reached the board starts no wake', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  w.poll(T - 1000)
  w.stop(APP, T, true)
  // The next turn's order file write fails, so the file still reads that turn's Stop as the last event; its take carries
  // the number the write would have saved, and reaches the board.
  assert.equal(w.enroll(APP, IDE, T + 1000, undefined, { isFileLost: true }), null)
  delete w.reports[APP]
  w.report(APP, T + 1500)
  assert.equal(w.send(APP, 'm-seq', T + 1600).line, 'now')
  w.stopCall(APP, T + 2000)
  assert.deepEqual(w.poll(T + 15_000), { wakes: [] })
  assert.equal(w.hub.snapshot(T + 15_000).mailboxes[0].busySeq, 2)
  // That turn's Stop reads only the file's number, so the numbers meet again after the next turn, whose take hands the
  // message over.
  w.stop(APP, T + 30_000)
  assert.deepEqual(w.poll(T + 30_000 + WAKE_IDLE_MS), { wakes: [] })
  assert.equal(w.enroll(APP, IDE, T + 50_000).id, 'm-seq')
  // The board keeps the highest number it saw, takes one only from Antigravity, and only a whole number above zero.
  w.hub.act('mailbox-turn', { agent: 'antigravity', session: APP, surface: IDE, seq: 1 }, T + 51_000)
  assert.equal(w.hub.snapshot(T + 51_000).mailboxes[0].busySeq, 2)
  for (const seq of [0, -1, 1.5, '3']) assert.throws(() => w.hub.act('mailbox-turn', { agent: 'antigravity', session: APP, surface: IDE, seq }, T + 52_000), /INVALID_MAILBOX_CALL/)
  assert.throws(() => w.hub.act('mailbox-turn', { agent: 'gemini', session: 'synthetic-gemini', surface: 'CLI', seq: 1 }, T + 52_000), /INVALID_MAILBOX_CALL/)
}))

test('no order file holds the wake', () => using(w => {
  w.ready(APP)
  w.poll(T)
  assert.equal(w.send(APP, 'm-file', T).line, 'now')
  const kept = readFileSync(w.order(APP), 'utf8')
  rmSync(w.order(APP))
  assert.deepEqual(w.poll(T + 1000), { wakes: [] })
  // One that cannot be read holds too, as does one whose numbers do not add up.
  for (const text of ['{', 'null', JSON.stringify({ started: 1, stopped: 1 }), JSON.stringify({ started: 1, stopped: 2, stoppedAt: T - 20_000 }), JSON.stringify({ started: 1.5, stopped: 1, stoppedAt: T - 20_000 })]) {
    writeFileSync(w.order(APP), text)
    assert.deepEqual(w.poll(T + 1000), { wakes: [] }, text)
  }
  writeFileSync(w.order(APP), kept)
  assert.equal(w.poll(T + 2000).wakes[0]?.id, 'm-file')
}))

test('an order file whose lock is there holds the wake', () => using(w => {
  w.ready(APP)
  w.poll(T)
  w.send(APP, 'm-lock', T)
  const [wake] = w.poll(T + 1000).wakes
  assert.equal(wake?.id, 'm-lock')
  // A hook is writing the next turn's number, or died holding the lock, so the file may be one turn behind: no wake
  // until the lock is gone, at the poll and at the attempt alike.
  const lock = `${w.order(APP)}.lock`
  writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, started: T, token: 'b'.repeat(32) }))
  assert.deepEqual(w.poll(T + 1500), { wakes: [] })
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1500), { ok: false, code: 'NOT_HELD' })
  rmSync(lock)
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 2000), { ok: true })
}))

test('a wake-attempt reads the order file while it holds the file\'s lock, so a turn start writes before that read or waits until the board has answered', async () => {
  const reads = []
  let lock
  const w = world(undefined, undefined, () => { if (lock !== undefined) reads.push(existsSync(lock)) })
  try {
    w.ready(APP)
    w.poll(T)
    w.send(APP, 'm-under', T)
    const [wake] = w.poll(T + 1000).wakes
    lock = `${w.order(APP)}.lock`
    assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1000), { ok: true })
    // Every read the attempt made was under the lock, which is gone again once it answers, with the start saved.
    assert.ok(reads.length > 0)
    assert.deepEqual(reads.filter(isHeld => !isHeld), [])
    assert.equal(existsSync(lock), false)
    assert.equal(w.saved('m-under').woke, T + 1000)
  } finally { w.close() }
})

// The two windows the owner accepted on 2026-11-18 (docs/dev/plan-0.25.1.md, M5b), pinned as the board meets them.
test('a turn whose start hook never ran is woken into, the first window the owner accepted on 2026-11-18, while a turn its hook marked is held', () => using(w => {
  w.ready(APP); w.ready(APP_2)
  w.poll(T)
  w.send(APP, 'm-marked', T)
  w.send(APP_2, 'm-unmarked', T)
  // Both people start a turn whose take never reaches the board. In APP the hook wrote the turn's number, which holds the
  // wake; in APP_2 the hook never ran, so nothing on disk or on the board says a turn runs, and the wake goes in.
  assert.equal(w.enroll(APP, IDE, T + 500, undefined, { isTakeLost: true }), null)
  assert.deepEqual(w.poll(T + 1000).wakes.map(one => one.id), ['m-unmarked'])
}))

test('a turn the person starts after the board\'s yes to a wake takes the message once, the second window the owner accepted on 2026-11-18, and the next wake waits for that turn\'s Stop', () => using(w => {
  w.ready(APP)
  w.poll(T)
  w.send(APP, 'm-yes', T)
  const [wake] = w.poll(T + 1000).wakes
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1000), { ok: true })
  // The person starts a turn before the sidecar's send-message lands. The board has said yes and cannot take it back: the
  // turn's hook hands the message to the person's turn, and the sidecar's send goes into that turn.
  const handed = w.enroll(APP, IDE, T + 1300)
  assert.equal(handed.id, 'm-yes')
  w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: handed.id, nonce: handed.nonce }, T + 1400)
  w.hub.act('wake-report', { id: wake.id, nonce: wake.nonce, status: 'sent' }, T + 1540)
  // The message went in once, and one sent during that turn waits for its Stop.
  w.send(APP, 'm-next', T + 2000)
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  w.stop(APP, T + 60_000)
  assert.deepEqual(w.poll(T + 60_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-next'])
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

// Antigravity's real hook (scripts/codex-local.ts) run in a process of its own, `AGY_COUNT` times for one conversation,
// writing after each run the `started` its order file reads. It waits for the processes named in `AGY_PEERS` to be ready
// first, so their hooks run at the same time.
const HOOKS = `
import { registerHooks } from 'node:module'
import { existsSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(specifier + '.ts', context)
  }
} })
const { AGY_REPO: repo, AGY_HOME: home, AGY_NAME: name, AGY_EVENT: event, AGY_COUNT: count, AGY_PEERS: peers, AGY_SESSION: session } = process.env
const load = file => import(new URL(file, repo).href)
const { runCodexLocal } = await load('scripts/codex-local.ts')
const { readTurnOrder } = await load('scripts/board-messaging.ts')
const { defaultMessagesDirectory } = await load('scripts/runtime-folder.ts')
const { EN } = await load('hooks/strings-en.ts')
const root = join(home, '.agent-board'), progress = join(root, 'progress.md')
const messages = defaultMessagesDirectory(progress, home, process.env, process.platform)
writeFileSync(join(home, 'ready-' + name), '')
const until = Date.now() + 20000
while (Date.now() < until && !peers.split(',').every(peer => existsSync(join(home, 'ready-' + peer)))) await new Promise(done => setTimeout(done, 10))
const seen = []
for (let index = 0; index < Number(count); index += 1) {
  await runCodexLocal(['--agent-status', '--agent', 'antigravity', '--state', event === 'Stop' ? 'waiting' : 'working', '--event', event, '--home', home, '--data-dir', root, '--progress-file', progress], progress, EN, { conversationId: session }, { output: () => {} })
  seen.push(readTurnOrder(messages, 'antigravity', session)?.started ?? null)
}
writeFileSync(join(home, 'seen-' + name + '.json'), JSON.stringify(seen))
`

test('two hooks of one conversation under the lock get increasing turn numbers', async () => {
  const { defaultMessagesDirectory } = await import('../scripts/runtime-folder.ts')
  const home = mkdtempSync(join(tmpdir(), 'agy-order-'))
  // The hooks find the messages folder from the environment; without XDG_RUNTIME_DIR it is under this home on every system.
  const env = { ...process.env }
  delete env.XDG_RUNTIME_DIR
  const root = join(home, '.agent-board'), progress = join(root, 'progress.md')
  const messages = defaultMessagesDirectory(progress, home, env, process.platform)
  const file = join(messages, `${mailboxId('antigravity', APP)}.turns.json`)
  // No time limit is passed, so a slow computer only makes the run slower.
  const hooks = (name, event, count, peers = name) => new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', HOOKS], {
      env: { ...env, AGY_REPO: new URL('../', import.meta.url).href, AGY_HOME: home, AGY_NAME: name, AGY_EVENT: event, AGY_COUNT: String(count), AGY_PEERS: peers, AGY_SESSION: APP },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', fail)
    child.on('exit', code => code === 0 ? done(JSON.parse(readFileSync(join(home, `seen-${name}.json`), 'utf8'))) : fail(new Error(`${name} exited ${code}: ${errors}`)))
  })
  try {
    mkdirSync(root, { recursive: true })
    // With no messages folder no board has run here: the hook makes none, since only a board makes it, private.
    assert.deepEqual(await hooks('none', 'PreInvocation', 1), [null])
    assert.equal(existsSync(messages), false)
    mkdirSync(messages, { recursive: true })
    const COUNT = 8
    const [first, second] = await Promise.all([hooks('a', 'PreInvocation', COUNT, 'a,b'), hooks('b', 'PreInvocation', COUNT, 'a,b')])
    // Each process reads a larger number after each of its hooks, and no start is lost between the two.
    for (const seen of [first, second]) {
      assert.equal(seen.length, COUNT)
      assert.ok(seen.every((number, index) => index === 0 || number > seen[index - 1]), JSON.stringify(seen))
    }
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { started: 2 * COUNT, stopped: 0, stoppedAt: 0 })
    // The conversation's Stop ends the last turn started, at its own time.
    const before = Date.now()
    assert.deepEqual(await hooks('stop', 'Stop', 1), [2 * COUNT])
    const { stopped, stoppedAt } = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(stopped, 2 * COUNT)
    assert.ok(stoppedAt >= before && stoppedAt <= Date.now(), String(stoppedAt))
    // The file is named by the mailbox id, so no session id is in a path a person sees.
    assert.ok(readdirSync(messages).every(name => !name.includes(APP)), readdirSync(messages).join(' '))
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

// The hook worker (hooks/hook-safety.ts) with a stand-in board script, which writes down the turn mark the worker handed
// it in AGY_SEEN and, with AGY_SLOW set, never ends, like a board script the worker stops at its deadline.
const standIn = version => `globalThis.AGENT_BOARD = {"hookVersion":${version},}
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.AGY_SEEN, JSON.stringify(process.env.AGENT_BOARD_TURN_MARK ?? null))
if (process.env.AGY_SLOW) setInterval(() => {}, 1000)
`

test('the hook worker marks an Antigravity turn before the board script runs, so a board script stopped at its deadline still leaves the mark', async () => {
  const { hookWorker, HOOK_VERSION } = await import('../hooks/hook-safety.ts')
  const { defaultMessagesDirectory } = await import('../scripts/runtime-folder.ts')
  const home = mkdtempSync(join(tmpdir(), 'agy-worker-'))
  const env = { ...process.env }
  delete env.XDG_RUNTIME_DIR
  delete env.AGENT_BOARD_TURN_MARK
  const root = join(home, '.agent-board'), progress = join(root, 'progress.md'), script = join(root, 'agent-board.mjs'), worker = join(root, 'agent-board-hook.mjs'), seen = join(home, 'seen.json')
  const messages = defaultMessagesDirectory(progress, home, env, process.platform)
  const file = join(messages, `${mailboxId('antigravity', APP)}.turns.json`)
  const hook = (event, extra = {}, deadline) => {
    rmSync(seen, { force: true })
    const args = ['--hook-version', String(HOOK_VERSION), '--hook-event', event, '--agent-status', '--agent', 'antigravity', '--state', event === 'Stop' ? 'waiting' : 'working', '--event', event, '--progress-file', progress]
    const result = spawnSync(process.execPath, [worker, ...args, ...(deadline === undefined ? [] : ['--hook-deadline', String(deadline)])], {
      env: { ...env, AGY_SEEN: seen, ...extra }, input: JSON.stringify({ conversationId: APP, hookEventName: event }), encoding: 'utf8', windowsHide: true, timeout: 10000,
    })
    assert.equal(result.status, 0, result.stderr)
    return existsSync(seen) ? JSON.parse(readFileSync(seen, 'utf8')) : undefined
  }
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(script, standIn(HOOK_VERSION))
    writeFileSync(worker, hookWorker(home, script, 'const isBoardRequest = () => false', root))
    // A queued event's replay is held, as a live worker's claim holds it, so no replay runs the stand-in again.
    const named = process.platform === 'win32' ? resolve(progress).toLowerCase() : resolve(progress)
    writeFileSync(join(root, `hook-recovery-${createHash('sha256').update(named).digest('hex')}.json`), JSON.stringify({ version: 1, pid: process.pid, token: createHash('sha256').update(root).digest('hex').slice(0, 32), created: Date.now() }))
    // No board has made the messages folder: the worker writes nothing, makes no folder, and hands on no mark, not
    // even one its own parent set.
    assert.equal(hook('PreInvocation', { AGENT_BOARD_TURN_MARK: JSON.stringify({ file, mark: 'start', count: 9 }) }), null)
    assert.equal(existsSync(messages), false)
    mkdirSync(messages, { recursive: true })
    // A board script that never ends is stopped at the worker's deadline and its event is queued; the turn's mark is there.
    hook('PreInvocation', { AGY_SLOW: '1' }, Date.now() + 1500)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { started: 1, stopped: 0, stoppedAt: 0 })
    assert.equal(readdirSync(join(root, 'pending')).filter(name => name.endsWith('.json')).length, 1)
    // A healthy board script is told which file the worker wrote, which mark and the number it holds.
    const before = Date.now()
    assert.deepEqual(JSON.parse(hook('Stop')), { file, mark: 'stop', count: 1 })
    const { stopped, stoppedAt } = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(stopped, 1)
    assert.ok(stoppedAt >= before && stoppedAt <= Date.now(), String(stoppedAt))
    assert.deepEqual(JSON.parse(hook('PreInvocation')), { file, mark: 'start', count: 2 })
    // A lock another process holds is waited for only briefly; the worker then leaves the lock and the mark to the
    // board script, which can wait longer and take over a dead owner's lock.
    const lock = `${file}.lock`, held = JSON.stringify({ version: 1, pid: process.pid, started: Math.round(performance.timeOrigin), token: 'a'.repeat(32) })
    writeFileSync(lock, held)
    assert.equal(hook('Stop'), null)
    assert.equal(readFileSync(lock, 'utf8'), held)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).stopped, 1)
    rmSync(lock)
    // Nothing is left beside the order file: no lock and no temporary file.
    assert.deepEqual(readdirSync(messages), [basename(file)])
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

test('the board script takes the turn number the hook worker handed it and does not mark the turn again', async () => {
  const { defaultMessagesDirectory } = await import('../scripts/runtime-folder.ts')
  const home = mkdtempSync(join(tmpdir(), 'agy-handed-'))
  const env = { ...process.env }
  delete env.XDG_RUNTIME_DIR
  const root = join(home, '.agent-board'), progress = join(root, 'progress.md')
  const messages = defaultMessagesDirectory(progress, home, env, process.platform)
  const file = join(messages, `${mailboxId('antigravity', APP)}.turns.json`)
  const hook = (name, event, handed) => new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', HOOKS], {
      env: { ...env, AGY_REPO: new URL('../', import.meta.url).href, AGY_HOME: home, AGY_NAME: name, AGY_EVENT: event, AGY_COUNT: '1', AGY_PEERS: name, AGY_SESSION: APP, AGENT_BOARD_TURN_MARK: handed },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', fail)
    child.on('exit', code => code === 0 ? done(JSON.parse(readFileSync(join(home, `seen-${name}.json`), 'utf8'))) : fail(new Error(`${name} exited ${code}: ${errors}`)))
  })
  try {
    mkdirSync(messages, { recursive: true })
    // The worker already counted turn 3 here.
    writeFileSync(file, JSON.stringify({ started: 3, stopped: 2, stoppedAt: T }))
    assert.deepEqual(await hook('a', 'PreInvocation', JSON.stringify({ file, mark: 'start', count: 3 })), [3])
    // A number for another file or for the other mark is not taken: the board script marks the turn itself.
    assert.deepEqual(await hook('b', 'PreInvocation', JSON.stringify({ file: `${file}.other`, mark: 'start', count: 3 })), [4])
    assert.deepEqual(await hook('c', 'PreInvocation', JSON.stringify({ file, mark: 'stop', count: 4 })), [5])
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { started: 5, stopped: 2, stoppedAt: T })
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

test('the app\'s idle route says a message sent just as the person starts a turn may join that turn, in en, zh-TW and zh-CN', () => {
  const file = `## Synthetic\n<!-- auto session=abcdef01 agent=antigravity resume=${APP} state=waiting updated=${new Date(T - 20_000).toISOString()} -->\n### App card\n- [?] Pick one?\n<!-- /auto session=abcdef01 -->\n`
  const mailboxes = [{ id: mailboxId('antigravity', APP), agent: 'antigravity', session: APP, surface: IDE, turn: 'session', scope: 'mailbox', expires: T + 60_000, origin: 'local' }]
  for (const s of [EN, ZH_TW, ZH_CN]) {
    const view = buildView(parseProgress(file), [], null, T, 0, {}, s)
    const card = sidecar => serveModel(view, [], s, new Set(), false, { connections: [], mailboxes, messages: [], sidecar }, false, { now: T, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] }, RECEIVER_ROUTES).asks[0]
    assert.equal(typeof s.agyMayJoin, 'string')
    // The owner accepted this window on 2026-11-18 (plan-0.25.1, M5b) on the condition that the card says so plainly.
    const idle = card(true)
    assert.equal(idle.line, 'now')
    assert.ok(idle.lineText.endsWith(` ${s.agyMayJoin}`), idle.lineText)
    // A message that waits for the next turn joins no running turn, so its line does not say it.
    const next = card(false)
    assert.equal(next.line, 'nextTurn')
    assert.ok(!next.lineText.includes(s.agyMayJoin), next.lineText)
  }
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

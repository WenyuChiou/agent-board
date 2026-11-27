import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
const { createMessaging, readTurnOrder, markTurnOrder, openTurnRecord } = await import('../scripts/board-messaging.ts')
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
  // A turn start's record (D1, #1612): the hook makes it before anything else and with no lock, named by a random token, never
  // by a date; the turn's Stop lists the records first, then writes its number with `closed`, the names it listed, and removes
  // exactly those. A start writes no `closed`.
  const opened = session => `${mailboxId('antigravity', session)}.turns.open.`
  const records = session => readdirSync(messages).filter(name => name.startsWith(opened(session)))
  let made = 0
  const openRecord = session => writeFileSync(join(messages, `${opened(session)}${(made += 1).toString(16).padStart(32, '0')}`), '')
  const withoutClosed = session => { const { closed: _closed, ...rest } = turns(session); return rest }
  // The turn-start hook: its start record (unless it cannot be made), its order file write (unless it fails: the take still
  // carries the number), its row write (unless the event repeats the row's last one, which is not written again), then its
  // take (unless it never reaches the board), with the claim name a hook gives it when one is passed.
  const enroll = (session, surface, now, ref, { isOpenLost = false, isFileLost = false, isRowKept = false, isTakeLost = false } = {}) => {
    if (!isOpenLost) openRecord(session)
    const seq = turns(session).started + 1
    if (!isFileLost) writeFileSync(order(session), JSON.stringify({ ...withoutClosed(session), started: seq }))
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
  // A turn's Stop hook at `at`: it lists the start records, ends the turn last started in the order file with `closed` naming
  // them and removes them, and writes its row as waiting; its call follows at once unless it is late (`stopCall` then sends
  // it). With `isOpenKept` it is a hook from before D1 that died after writing its number: no `closed`, no record removed.
  const stop = (session, at, isCallLate = false, { isOpenKept = false } = {}) => {
    const listed = records(session)
    writeFileSync(order(session), JSON.stringify({ ...withoutClosed(session), stopped: turns(session).started, stoppedAt: at, ...(isOpenKept ? {} : { closed: listed }) }))
    if (!isOpenKept) for (const name of listed) rmSync(join(messages, name))
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
  return { hub, reports, written, order, records, openRecord, enroll, stop, stopCall, report, ready, send, poll, shown, saved, close: () => { hub.close(); rmSync(dir, { recursive: true, force: true }) } }
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

// Design A (design diagnosis 4 on #1396; the owner's choice of 2026-11-20): a turn start's hook makes a record first, with
// no lock, so a start the order file does not show yet still holds the wake.
test('a turn start whose order-file write and take both fail is held by its start record until its Stop, and one whose record cannot be made is held by its count', () => using(w => {
  w.ready(APP); w.ready(APP_2)
  w.poll(T)
  w.send(APP, 'm-record', T)
  w.send(APP_2, 'm-count', T)
  const [wake] = w.poll(T + 1000).wakes
  assert.equal(wake?.id, 'm-record')
  // In APP only the record says a turn runs: the order file still reads the last turn's Stop, and no take came. In APP_2
  // the record could not be made, and the order file holds the turn's number.
  assert.equal(w.enroll(APP, IDE, T + 1200, undefined, { isFileLost: true, isTakeLost: true }), null)
  assert.equal(w.enroll(APP_2, IDE, T + 1200, undefined, { isOpenLost: true, isTakeLost: true }), null)
  assert.equal(w.records(APP).length, 1)
  assert.deepEqual(w.records(APP_2), [])
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1300), { ok: false, code: 'NOT_HELD' })
  assert.deepEqual(w.poll(T + 15_000), { wakes: [] })
  // Each turn's Stop ends the hold: APP's removes its record.
  w.stop(APP, T + 20_000); w.stop(APP_2, T + 20_000)
  assert.deepEqual(w.records(APP), [])
  const [first] = w.poll(T + 20_000 + WAKE_IDLE_MS).wakes
  assert.equal(first?.id, 'm-record')
  assert.deepEqual(w.hub.act('wake-attempt', { id: first.id, nonce: first.nonce }, T + 20_000 + WAKE_IDLE_MS), { ok: true })
  assert.deepEqual(w.poll(T + 21_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-count'])
}))

test('a turn start whose record is made while a wake-attempt decides undoes the saved start, so the attempt is refused and the turn takes the message', () => {
  let isStarting = false
  const w = world(undefined, undefined, (_agent, session) => { if (isStarting) { isStarting = false; w.openRecord(session, T + 1000) } })
  try {
    w.ready(APP)
    w.poll(T)
    w.send(APP, 'm-undo', T)
    const [wake] = w.poll(T + 1000).wakes
    // The person starts a turn as the attempt reads the order file: the hook's record comes after the attempt first looked,
    // and its order-file write waits for the attempt's lock.
    isStarting = true
    assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1000), { ok: false, code: 'NOT_HELD' })
    assert.equal(isStarting, false)
    assert.equal(w.saved('m-undo').woke, undefined)
    assert.deepEqual(w.poll(T + 1100), { wakes: [] })
    // The turn's hook goes on with its order-file write and its take, which hands the message over.
    assert.equal(w.enroll(APP, IDE, T + 1200, undefined, { isOpenLost: true }).id, 'm-undo')
  } finally { w.close() }
})

test('a Stop that wrote its number but died before removing its turn\'s record holds the wake until the next Stop', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  w.stop(APP, T - 20_000, false, { isOpenKept: true })
  w.poll(T)
  assert.equal(w.send(APP, 'm-kept', T).line, 'now')
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  // The next turn's take hands the message over. That turn's Stop removes both records, and a message sent after it
  // goes in at once.
  const handed = w.enroll(APP, IDE, T + 61_000)
  assert.equal(handed.id, 'm-kept')
  w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: handed.id, nonce: handed.nonce }, T + 61_500)
  w.stop(APP, T + 62_000)
  assert.deepEqual(w.records(APP), [])
  w.send(APP, 'm-after', T + 62_000)
  assert.deepEqual(w.poll(T + 62_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-after'])
}))

test('an order-file lock a dead hook left holds the wake while it is fresh, and the poll takes it over once 30 s old, so the wake goes in', () => using(w => {
  w.ready(APP)
  w.poll(T)
  w.send(APP, 'm-dead', T)
  // A Stop hook's worker wrote the order file and died before it removed its lock.
  const lock = `${w.order(APP)}.lock`
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid
  writeFileSync(lock, JSON.stringify({ version: 1, pid: dead, started: Date.now(), token: 'c'.repeat(32) }))
  assert.deepEqual(w.poll(T + 1000), { wakes: [] })
  const old = (Date.now() - 31_000) / 1000
  utimesSync(lock, old, old)
  const [wake] = w.poll(T + 2000).wakes
  assert.equal(wake?.id, 'm-dead')
  assert.equal(existsSync(lock), false)
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 2000), { ok: true })
}))

test('a wake-attempt whose undo cannot be saved answers with an error, so the sidecar sends nothing, and the saved start keeps the message to the turn\'s take', () => {
  const write = fs.writeFileSync
  let isArmed = false, saves = 0
  const w = world(undefined, undefined, (_agent, session) => {
    if (!isArmed) return
    isArmed = false
    w.openRecord(session, T + 1000)
    // The attempt's own save goes through; its undo finds the disk full.
    fs.writeFileSync = (path, ...rest) => {
      if (String(path).includes('messages.json.') && (saves += 1) === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      return write(path, ...rest)
    }
    syncBuiltinESMExports()
  })
  try {
    w.ready(APP)
    w.poll(T)
    w.send(APP, 'm-full', T)
    const [wake] = w.poll(T + 1000).wakes
    isArmed = true
    try {
      assert.throws(() => w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1000), /ENOSPC/)
    } finally { fs.writeFileSync = write; syncBuiltinESMExports() }
    assert.equal(saves, 2)
    // The sidecar runs nothing on an error. The start stays saved, so the card reads waking and no second wake is handed out.
    assert.equal(w.saved('m-full').woke, T + 1000)
    assert.equal(w.shown('m-full', T + 1000).wake, 'started')
    assert.deepEqual(w.poll(T + 1100), { wakes: [] })
    assert.equal(w.enroll(APP, IDE, T + 1200, undefined, { isOpenLost: true }).id, 'm-full')
  } finally { w.close() }
})

// The windows the owner accepted (docs/dev/plan-0.25.1.md, M5b), two on 2026-11-18 and one on 2026-11-20, pinned as the board
// meets them.
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

test('a turn the person starts just before the board\'s yes, whose hook makes its start record only after the attempt\'s last look, takes the message once, the third window the owner accepted on 2026-11-20', () => using(w => {
  w.ready(APP)
  w.poll(T)
  w.send(APP, 'm-blind', T)
  const [wake] = w.poll(T + 1000).wakes
  // The app has begun the person's turn and launched its hook, which has not made its record yet (58 to 94 ms in C3's
  // runs, plus the app's own delay before it launches the hook): nothing on disk says a turn runs, and the board says yes.
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1000), { ok: true })
  assert.equal(w.saved('m-blind').woke, T + 1000)
  // The record lands after the attempt's last look, so the start stands; the turn's take hands the message over, once.
  assert.equal(w.enroll(APP, IDE, T + 1090).id, 'm-blind')
  assert.deepEqual(w.poll(T + 1100), { wakes: [] })
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

// A lock a live process holds: the hook worker waits for it only briefly.
const liveLock = () => JSON.stringify({ version: 1, pid: process.pid, started: Math.round(performance.timeOrigin), token: 'a'.repeat(32) })
// The hook worker (hooks/hook-safety.ts) in a home of its own, with the stand-in board script above. `hook` runs it for one
// event of APP's conversation and returns the mark it handed the board script, null for none.
const workerHome = async () => {
  const { hookWorker, HOOK_VERSION } = await import('../hooks/hook-safety.ts')
  const { defaultMessagesDirectory } = await import('../scripts/runtime-folder.ts')
  const home = mkdtempSync(join(tmpdir(), 'agy-worker-'))
  const env = { ...process.env }
  delete env.XDG_RUNTIME_DIR
  delete env.AGENT_BOARD_TURN_MARK
  const root = join(home, '.agent-board'), progress = join(root, 'progress.md'), script = join(root, 'agent-board.mjs'), worker = join(root, 'agent-board-hook.mjs'), seen = join(home, 'seen.json')
  const messages = defaultMessagesDirectory(progress, home, env, process.platform)
  const file = join(messages, `${mailboxId('antigravity', APP)}.turns.json`)
  const opened = `${mailboxId('antigravity', APP)}.turns.open.`
  const records = () => readdirSync(messages).filter(name => name.startsWith(opened)).sort()
  mkdirSync(root, { recursive: true })
  writeFileSync(script, standIn(HOOK_VERSION))
  writeFileSync(worker, hookWorker(home, script, 'const isBoardRequest = () => false', root))
  // A queued event's replay is held, as a live worker's claim holds it, so no replay runs the stand-in again.
  const named = process.platform === 'win32' ? resolve(progress).toLowerCase() : resolve(progress)
  writeFileSync(join(root, `hook-recovery-${createHash('sha256').update(named).digest('hex')}.json`), JSON.stringify({ version: 1, pid: process.pid, token: createHash('sha256').update(root).digest('hex').slice(0, 32), created: Date.now() }))
  const hook = (event, extra = {}, { deadline, nodeArgs = [] } = {}) => {
    rmSync(seen, { force: true })
    const args = ['--hook-version', String(HOOK_VERSION), '--hook-event', event, '--agent-status', '--agent', 'antigravity', '--state', event === 'Stop' ? 'waiting' : 'working', '--event', event, '--progress-file', progress]
    const result = spawnSync(process.execPath, [...nodeArgs, worker, ...args, ...(deadline === undefined ? [] : ['--hook-deadline', String(deadline)])], {
      env: { ...env, AGY_SEEN: seen, ...extra }, input: JSON.stringify({ conversationId: APP, hookEventName: event }), encoding: 'utf8', windowsHide: true, timeout: 10000,
    })
    assert.equal(result.status, 0, result.stderr)
    if (!existsSync(seen)) return undefined
    const handed = JSON.parse(readFileSync(seen, 'utf8'))
    return handed === null ? null : JSON.parse(handed)
  }
  return { home, root, messages, file, opened, records, hook, close: () => rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
}
// Antigravity's real board script (scripts/codex-local.ts, through HOOKS) for one event of APP's conversation, given the mark
// a hook worker handed it; it answers what `started` reads after it.
const boardRun = (home, name, event, handed) => new Promise((done, fail) => {
  const env = { ...process.env }
  delete env.XDG_RUNTIME_DIR
  delete env.AGENT_BOARD_TURN_MARK
  const child = spawn(process.execPath, ['--input-type=module', '-e', HOOKS], {
    env: { ...env, AGY_REPO: new URL('../', import.meta.url).href, AGY_HOME: home, AGY_NAME: name, AGY_EVENT: event, AGY_COUNT: '1', AGY_PEERS: name, AGY_SESSION: APP, ...(handed === undefined ? {} : { AGENT_BOARD_TURN_MARK: handed }) },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  child.on('error', fail)
  child.on('exit', code => code === 0 ? done(JSON.parse(readFileSync(join(home, `seen-${name}.json`), 'utf8'))) : fail(new Error(`${name} exited ${code}: ${errors}`)))
})
const boardHome = async () => {
  const { defaultMessagesDirectory } = await import('../scripts/runtime-folder.ts')
  const home = mkdtempSync(join(tmpdir(), 'agy-handed-'))
  const env = { ...process.env }
  delete env.XDG_RUNTIME_DIR
  const progress = join(home, '.agent-board', 'progress.md')
  const messages = defaultMessagesDirectory(progress, home, env, process.platform)
  const file = join(messages, `${mailboxId('antigravity', APP)}.turns.json`)
  const opened = `${mailboxId('antigravity', APP)}.turns.open.`
  const records = () => readdirSync(messages).filter(name => name.startsWith(opened)).sort()
  return { home, messages, file, opened, records, run: (name, event, handed) => boardRun(home, name, event, handed), close: () => rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
}

test('the hook worker marks an Antigravity turn before the board script runs, so a board script stopped at its deadline still leaves the mark', async () => {
  const h = await workerHome()
  try {
    // No board has made the messages folder: the worker writes nothing, makes no folder, and hands on no mark, not
    // even one its own parent set.
    assert.equal(h.hook('PreInvocation', { AGENT_BOARD_TURN_MARK: JSON.stringify({ file: h.file, mark: 'start', count: 9 }) }), null)
    assert.equal(existsSync(h.messages), false)
    mkdirSync(h.messages, { recursive: true })
    // A board script that never ends is stopped at the worker's deadline and its event is queued; the turn's mark is there.
    h.hook('PreInvocation', { AGY_SLOW: '1' }, { deadline: Date.now() + 1500 })
    assert.deepEqual(JSON.parse(readFileSync(h.file, 'utf8')), { started: 1, stopped: 0, stoppedAt: 0 })
    // The start's record is there too, named by a random token: no date and no process id (D1, #1612).
    assert.equal(h.records().length, 1)
    assert.match(h.records()[0].slice(h.opened.length), /^[0-9a-f]{32}$/)
    assert.equal(readdirSync(join(h.root, 'pending')).filter(name => name.endsWith('.json')).length, 1)
    // A healthy board script is told which file the worker wrote, which mark and the number it holds. The Stop names the
    // record it listed in the same write as its number, then removes it.
    const before = Date.now(), listed = h.records()
    assert.deepEqual(h.hook('Stop'), { file: h.file, mark: 'stop', count: 1 })
    const { stopped, stoppedAt, closed } = JSON.parse(readFileSync(h.file, 'utf8'))
    assert.equal(stopped, 1)
    assert.ok(stoppedAt >= before && stoppedAt <= Date.now(), String(stoppedAt))
    assert.deepEqual(closed, listed)
    assert.deepEqual(h.records(), [])
    assert.deepEqual(h.hook('PreInvocation'), { file: h.file, mark: 'start', count: 2 })
    // A lock another process holds is waited for only briefly; the worker then leaves the lock and the mark to the
    // board script, which can wait longer and take over a dead owner's lock. A start's record is made before the lock, so
    // it is there when the lock is not taken.
    const lock = `${h.file}.lock`
    writeFileSync(lock, liveLock())
    assert.equal(h.hook('PreInvocation'), null)
    assert.equal(h.records().length, 2)
    rmSync(lock)
    // Nothing else is left beside the order file and the records: no lock and no temporary file.
    assert.deepEqual(readdirSync(h.messages).sort(), [basename(h.file), ...h.records()].sort())
  } finally { h.close() }
})

test('a turn start whose record cannot be made still writes its number at once and hands on that no record was made', async () => {
  const h = await workerHome()
  // A stand-in for a disk that refuses the start's record, every time it is tried, and nothing else.
  const refuse = join(h.home, 'refuse.cjs')
  writeFileSync(refuse, `const fs = require('node:fs'), write = fs.writeFileSync
fs.writeFileSync = (target, ...rest) => { if (String(target).includes(${JSON.stringify(h.opened)})) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return write(target, ...rest) }
`)
  try {
    mkdirSync(h.messages, { recursive: true })
    // The number is then the start's first sign that lands (gemini_731 P1 1): once it is written a wake reads the turn as
    // running. The board script is told to make the record.
    assert.deepEqual(h.hook('PreInvocation', {}, { nodeArgs: ['--require', refuse] }), { file: h.file, mark: 'start', count: 1, record: false })
    assert.deepEqual(h.records(), [])
    const order = readTurnOrder(h.messages, 'antigravity', APP)
    assert.ok(order !== undefined && order.started > order.stopped, JSON.stringify(order))
  } finally { h.close() }
})

test('the board script makes the start record when the hook worker handed it a number and no record', async () => {
  const b = await boardHome()
  try {
    mkdirSync(b.messages, { recursive: true })
    // The worker counted turn 3 but could not make its record.
    writeFileSync(b.file, JSON.stringify({ started: 3, stopped: 2, stoppedAt: T }))
    assert.deepEqual(await b.run('a', 'PreInvocation', JSON.stringify({ file: b.file, mark: 'start', count: 3, record: false })), [3])
    // The board script makes the record and does not count the turn again.
    assert.equal(b.records().length, 1)
    assert.deepEqual(JSON.parse(readFileSync(b.file, 'utf8')), { started: 3, stopped: 2, stoppedAt: T })
  } finally { b.close() }
})

test('a Stop whose worker cannot take the lock hands its list of start records to the board script, which closes exactly those', async () => {
  const h = await workerHome()
  try {
    mkdirSync(h.messages, { recursive: true })
    assert.deepEqual(h.hook('PreInvocation'), { file: h.file, mark: 'start', count: 1 })
    const listed = h.records()
    // Another process holds the order file's lock through the worker's short wait: the worker writes nothing, removes
    // nothing, and hands its list on.
    const lock = `${h.file}.lock`
    writeFileSync(lock, liveLock())
    const handed = h.hook('Stop')
    assert.deepEqual(handed, { file: h.file, mark: 'stop', list: listed })
    assert.equal(JSON.parse(readFileSync(h.file, 'utf8')).stopped, 0)
    assert.deepEqual(h.records(), listed)
    rmSync(lock)
    // The next turn's record comes after the worker's list. The board script closes exactly the names it was handed.
    const later = `${h.opened}${'f'.repeat(32)}`
    writeFileSync(join(h.messages, later), '')
    assert.deepEqual(await boardRun(h.home, 'stop', 'Stop', JSON.stringify(handed)), [1])
    assert.deepEqual(h.records(), [later])
    const order = JSON.parse(readFileSync(h.file, 'utf8'))
    assert.equal(order.stopped, 1)
    assert.deepEqual(order.closed, listed)
  } finally { h.close() }
})

test('the board script\'s Stop removes only this conversation\'s start records from a handed list, never another name', async () => {
  const b = await boardHome()
  try {
    mkdirSync(b.messages, { recursive: true })
    writeFileSync(b.file, JSON.stringify({ started: 1, stopped: 0, stoppedAt: 0 }))
    const own = `${b.opened}${'a'.repeat(32)}`, other = `${mailboxId('antigravity', APP_2)}.turns.open.${'b'.repeat(32)}`
    const outside = join(dirname(b.messages), 'outside')
    for (const name of [own, other]) writeFileSync(join(b.messages, name), '')
    writeFileSync(outside, '')
    // A handed list comes through the environment: only names of this conversation's records, with no path in them, count.
    const list = [own, other, '../outside', `${b.opened}x/../../outside`, `${b.opened}x\\..\\..\\outside`, 7]
    assert.deepEqual(await b.run('stop', 'Stop', JSON.stringify({ file: b.file, mark: 'stop', list })), [1])
    assert.deepEqual(readdirSync(b.messages).filter(name => name.includes('.turns.open.')), [other])
    assert.equal(existsSync(outside), true)
    assert.deepEqual(JSON.parse(readFileSync(b.file, 'utf8')).closed, [own])
  } finally { b.close() }
})

// A Stop that died after writing its number and before removing its records leaves the records (and its lock).
const deadLock = (w, session, age = 31_000) => {
  const lock = `${w.order(session)}.lock`
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid
  writeFileSync(lock, JSON.stringify({ version: 1, pid: dead, started: Date.now(), token: 'c'.repeat(32) }))
  const old = (Date.now() - age) / 1000
  utimesSync(lock, old, old)
  return lock
}
const diedStop = (w, session, order) => writeFileSync(w.order(session), JSON.stringify({ started: 1, stopped: 1, stoppedAt: T - 20_000, ...order }))
// Antigravity's real start and Stop (scripts/board-messaging.ts) in a world's messages folder; the start's take goes to the
// board as the hook sends it.
const folderOf = w => dirname(w.order(APP))
const realStart = (w, session, now) => {
  openTurnRecord(folderOf(w), 'antigravity', session)
  const seq = markTurnOrder(folderOf(w), 'antigravity', session, 'start', now, 0)
  return w.hub.act('mailbox-turn', { agent: 'antigravity', session, surface: IDE, seq }, now).message
}
const realStop = (w, session, at, listed) => {
  markTurnOrder(folderOf(w), 'antigravity', session, 'stop', at, 0, listed)
  w.report(session, at)
}
const accept = (w, handed, now) => w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: handed.id, nonce: handed.nonce }, now)

test('a turn start whose record cannot be made while a wake-attempt holds the lock takes the message once, the third window\'s write-fault case the owner accepted on 2026-11-26', () => using(w => {
  w.ready(APP)
  w.poll(T)
  w.send(APP, 'm-fault', T)
  const [wake] = w.poll(T + 1000).wakes
  // The person starts a turn while the attempt holds the lock: the record cannot be made and the number waits for the lock,
  // so the attempt sees no sign of the turn and answers yes. The window lasts until the number lands, at most 2 s.
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1000), { ok: true })
  // The turn's take hands the message over once, and no second wake follows for that Stop.
  const handed = w.enroll(APP, IDE, T + 1200, undefined, { isOpenLost: true })
  assert.equal(handed.id, 'm-fault')
  accept(w, handed, T + 1250)
  w.send(APP, 'm-next', T + 1300)
  assert.deepEqual(w.poll(T + 1400 + WAKE_IDLE_MS), { wakes: [] })
  // The next wake waits for that turn's Stop.
  w.stop(APP, T + 20_000)
  assert.deepEqual(w.poll(T + 20_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-next'])
}))

test('a Stop writes its turn number and the names of the start records it listed in one file write, then removes exactly those records', () => using(w => {
  w.ready(APP)
  realStart(w, APP, T - 9_000)
  // A second model call of the same turn makes a second record.
  openTurnRecord(folderOf(w), 'antigravity', APP)
  const listed = w.records(APP).sort()
  assert.equal(listed.length, 2)
  realStop(w, APP, T - 8_000)
  const order = readTurnOrder(folderOf(w), 'antigravity', APP)
  assert.equal(order.stopped, order.started)
  assert.deepEqual(order.closed?.slice().sort(), listed)
  assert.deepEqual(w.records(APP), [])
  // No order-file lock and no temporary file is left (the board's own server lock is not the Stop's).
  assert.deepEqual(readdirSync(folderOf(w)).filter(name => name.endsWith('.turns.json.lock') || name.endsWith('.tmp')), [])
}))

test('a Stop removes every start record it listed, whatever date is in its name, so a clock set back inside the Stop\'s run keeps no record', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  const folder = folderOf(w), opened = `${mailboxId('antigravity', APP)}.turns.open.`, now = Date.now()
  // Names an older hook gave its records: one dated inside the Stop's own run (the clock set back by a small step), one in
  // the future, one long ago.
  for (const name of [`${opened}${now - 500}.1`, `${opened}${now + 3_600_000}.2`, `${opened}${now - 3_600_000}.3`]) writeFileSync(join(folder, name), '')
  const listed = w.records(APP).sort()
  markTurnOrder(folder, 'antigravity', APP, 'stop', T - 20_000, 0)
  w.report(APP, T - 20_000)
  assert.deepEqual(w.records(APP), [])
  assert.deepEqual(readTurnOrder(folder, 'antigravity', APP).closed?.slice().sort(), listed)
  // The wake goes in 10 s after this Stop, not after the next one.
  w.poll(T)
  w.send(APP, 'm-set-back', T)
  assert.deepEqual(w.poll(T + 1000).wakes.map(one => one.id), ['m-set-back'])
}))

test('a start record made after a Stop took its list stays and holds the wake, whatever date its name holds', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  const folder = folderOf(w), listed = w.records(APP)
  // The next turn's record comes after the Stop took its list and before the Stop writes; an older hook would have dated it
  // long before the Stop.
  const later = `${mailboxId('antigravity', APP)}.turns.open.${T - 3_600_000}.1`
  writeFileSync(join(folder, later), '')
  realStop(w, APP, T - 20_000, listed)
  assert.deepEqual(w.records(APP), [later])
  assert.deepEqual(readTurnOrder(folder, 'antigravity', APP).closed, listed)
  w.poll(T)
  w.send(APP, 'm-later', T)
  assert.deepEqual(w.poll(T + 1000), { wakes: [] })
}))

test('a start record named in the closed list of a Stop that died after writing its number holds no wake, and the wake goes in once the poll has taken the dead Stop\'s lock over', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  diedStop(w, APP, { closed: w.records(APP) })
  const lock = deadLock(w, APP, 0)
  w.report(APP, T - 20_000)
  w.poll(T)
  w.send(APP, 'm-closed', T)
  // The dead Stop's lock holds the wake while it is fresh.
  assert.deepEqual(w.poll(T + 2000), { wakes: [] })
  const old = (Date.now() - 31_000) / 1000
  utimesSync(lock, old, old)
  assert.deepEqual(w.poll(T + 3000).wakes.map(one => one.id), ['m-closed'])
  assert.equal(existsSync(lock), false)
  assert.equal(w.records(APP).length, 1)
}))

test('a start record the dead Stop\'s closed list does not name still holds the wake, whatever date its name holds', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  const listed = w.records(APP)
  // An older hook's record, dated long before that Stop, beside the Stop's start time an older board read.
  const unlisted = `${mailboxId('antigravity', APP)}.turns.open.${T - 3_600_000}.1`
  writeFileSync(join(folderOf(w), unlisted), '')
  diedStop(w, APP, { closed: listed, stopBegan: T - 20_000 })
  deadLock(w, APP)
  w.report(APP, T - 20_000)
  w.poll(T)
  w.send(APP, 'm-unlisted', T)
  assert.deepEqual(w.poll(T + 2000), { wakes: [] })
  rmSync(join(folderOf(w), unlisted))
  assert.deepEqual(w.poll(T + 3000).wakes.map(one => one.id), ['m-unlisted'])
}))

test('start records left by a turn whose Stop never wrote its number hold the wake across a restart until the next turn\'s Stop removes them', () => using(w => {
  w.ready(APP)
  // A turn starts; the app closes, or the computer restarts, before its Stop writes anything.
  realStart(w, APP, T - 15_000)
  w.poll(T)
  w.send(APP, 'm-left', T)
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  // The next turn's take hands the message over; that turn's Stop lists and removes every record left.
  const handed = realStart(w, APP, T + 61_000)
  assert.equal(handed?.id, 'm-left')
  accept(w, handed, T + 61_500)
  realStop(w, APP, T + 62_000)
  assert.deepEqual(w.records(APP), [])
  w.send(APP, 'm-after', T + 62_000)
  assert.deepEqual(w.poll(T + 62_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-after'])
}))

test('a Stop whose number cannot be written leaves its start records, and the wake waits for the next Stop', () => using(w => {
  w.ready(APP)
  w.enroll(APP, IDE, T - 15_000)
  // Neither the worker nor the board script could write the Stop's number: the row reads waiting, nothing else changed.
  w.report(APP, T - 14_000)
  w.poll(T)
  w.send(APP, 'm-unwritten', T)
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  assert.equal(w.records(APP).length, 1)
  // The next turn's take hands the message over; no wake ever goes into a turn.
  const handed = w.enroll(APP, IDE, T + 61_000)
  assert.equal(handed?.id, 'm-unwritten')
  accept(w, handed, T + 61_500)
  w.stop(APP, T + 62_000)
  assert.deepEqual(w.records(APP), [])
}))

test('a Stop that cannot list the folder removes no start record, so the records hold the wake until the next Stop', () => using(w => {
  w.ready(APP)
  realStart(w, APP, T - 15_000)
  // The worker could not take its list, so it hands on an empty one.
  realStop(w, APP, T - 14_000, [])
  assert.equal(w.records(APP).length, 1)
  assert.deepEqual(readTurnOrder(folderOf(w), 'antigravity', APP).closed ?? [], [])
  w.poll(T)
  w.send(APP, 'm-unlisted', T)
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  // The next turn's Stop lists the record and removes it.
  const handed = realStart(w, APP, T + 61_000)
  assert.equal(handed?.id, 'm-unlisted')
  accept(w, handed, T + 61_500)
  realStop(w, APP, T + 62_000)
  assert.deepEqual(w.records(APP), [])
}))

test('two Stops that listed the same start records close them once, and a record made after both lists still holds the wake', () => using(w => {
  w.ready(APP)
  realStart(w, APP, T - 30_000)
  const folder = folderOf(w), listed = w.records(APP)
  // The first Stop writes and removes; a new turn then makes its record and takes its number; the second Stop, with the
  // same list, writes the new turn's number.
  markTurnOrder(folder, 'antigravity', APP, 'stop', T - 25_000, 0, listed)
  realStart(w, APP, T - 24_000)
  const next = w.records(APP)
  assert.equal(next.length, 1)
  assert.notDeepEqual(next, listed)
  realStop(w, APP, T - 20_000, listed)
  assert.deepEqual(w.records(APP), next)
  w.poll(T)
  w.send(APP, 'm-overlap', T)
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  // That turn's own Stop closes its record, and the wake goes in 10 s later.
  realStop(w, APP, T + 61_000)
  assert.deepEqual(w.poll(T + 61_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-overlap'])
}))

test('an order file with no closed list keeps every start record holding the wake, and one whose list names the record does not', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  diedStop(w, APP, {})
  deadLock(w, APP)
  w.report(APP, T - 20_000)
  w.poll(T)
  w.send(APP, 'm-bare', T)
  assert.deepEqual(w.poll(T + 2000), { wakes: [] })
  // A `closed` that is not a list of names counts as none.
  diedStop(w, APP, { closed: w.records(APP)[0] })
  assert.deepEqual(w.poll(T + 2500), { wakes: [] })
  // The same file with the record named reads it as closed.
  diedStop(w, APP, { closed: w.records(APP) })
  assert.deepEqual(w.poll(T + 3000).wakes.map(one => one.id), ['m-bare'])
}))

test('after an upgrade a date-named start record holds the wake until the next Stop removes it, and stopBegan is not read', () => using(w => {
  w.ready(APP)
  // A development copy of design A left a record named by its date, and a Stop's start time later than that date.
  const dated = `${mailboxId('antigravity', APP)}.turns.open.${T - 25_000}.1`
  writeFileSync(join(folderOf(w), dated), '')
  diedStop(w, APP, { stopBegan: T - 20_000 })
  w.poll(T)
  w.send(APP, 'm-upgrade', T)
  assert.deepEqual(w.poll(T + 1000), { wakes: [] })
  // The next Stop lists it and removes it; the wake goes in 10 s later.
  realStop(w, APP, T + 2000)
  assert.deepEqual(w.records(APP), [])
  assert.deepEqual(w.poll(T + 2000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-upgrade'])
}))

test('the board script takes the turn number the hook worker handed it and does not mark the turn again', async () => {
  const { defaultMessagesDirectory } = await import('../scripts/runtime-folder.ts')
  const home = mkdtempSync(join(tmpdir(), 'agy-handed-'))
  const env = { ...process.env }
  delete env.XDG_RUNTIME_DIR
  const root = join(home, '.agent-board'), progress = join(root, 'progress.md')
  const messages = defaultMessagesDirectory(progress, home, env, process.platform)
  const file = join(messages, `${mailboxId('antigravity', APP)}.turns.json`)
  const records = () => readdirSync(messages).filter(name => name.startsWith(`${mailboxId('antigravity', APP)}.turns.open.`))
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
    // A worker that marked the turn made its record first, so the board script makes none.
    assert.deepEqual(records(), [])
    // A number for another file or for the other mark is not taken: the board script marks the turn itself.
    assert.deepEqual(await hook('b', 'PreInvocation', JSON.stringify({ file: `${file}.other`, mark: 'start', count: 3 })), [4])
    assert.deepEqual(await hook('c', 'PreInvocation', JSON.stringify({ file, mark: 'stop', count: 4 })), [5])
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { started: 5, stopped: 2, stoppedAt: T })
    // A start it marks itself it also makes a record for, in case the worker could not; a Stop it marks itself lists the
    // records, then closes exactly those.
    assert.equal(records().length, 2)
    assert.deepEqual(await hook('d', 'Stop', 'null'), [5])
    assert.deepEqual(records(), [])
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

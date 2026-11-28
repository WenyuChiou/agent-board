import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, truncateSync, writeFileSync } from 'node:fs'
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
const { createMessaging, readTurnLog, startSeq, appendTurnStop } = await import('../scripts/board-messaging.ts')
const { RECEIVER_ROUTES } = await import('../hooks/receiver-routes.ts')
const { mailboxId, SIDECAR_ALIVE_MS, WAKE_IDLE_MS, turnsOfLog } = await import('../hooks/hook-messages.ts')
const { sha256 } = await import('../hooks/sha256.ts')
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
// A line of the turn log is written whole with a newline on each side (D2, #1396): a start is 36 bytes, a Stop at most 67.
const START_LINE = /^\nS [0-9a-f]{32}\n$/
const STOP_LINE = /^\nE \d+ \d+ [0-9a-f]{32}\n$/

// A board's message store with its gate, and beside it each conversation's turn log, by the name Antigravity's hooks give
// it, written here as they write it (D2, #1396): a turn start appends one line `S <token>` and sends its number, the
// line's place among the starts, with its take; a Stop reads the log's size first and later appends `E <size> <at> <token>`,
// which ends every start that begins before that size. `reports` holds when each conversation's progress rows last read
// waiting (a conversation missing from it is working) and `written` when they were last written, in whole seconds as rows
// keep them: this board reads neither for a wake, the board at e8025827 read both. That board also took the Stop by a call
// (`mailbox-idle`, with the hook's time) and refuses a take's `seq`; this one refuses the call, so both answer
// UNKNOWN_FIELD and go on, as the hook does for `seq`.
const world = (reports = { [APP]: T - 20_000, [APP_2]: T - 20_000, [TERMINAL]: T - 20_000 }, written = { ...reports }, onTurns = () => {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-wake-'))
  const messages = join(dir, 'messages')
  const hub = createMessaging(messages, false, {
    routes: RECEIVER_ROUTES,
    stateOfSession: (_agent, session) => reports[session] === undefined ? 'working' : 'idle',
    writtenOfSession: (_agent, session) => written[session],
    // The log is read first, then `onTurns` runs, so a line it appends comes after the read, as a hook's does.
    turnsOfSession: (agent, session) => { const turns = readTurnLog(messages, agent, session); onTurns(agent, session); return turns },
  })
  // A row is written again at each hook event and report, never back in time, and keeps whole seconds.
  const write = (session, now) => { written[session] = Math.max(written[session] ?? 0, Math.floor(now / 1000) * 1000) }
  const log = session => join(messages, `${mailboxId('antigravity', session)}.turns.log`)
  const text = session => existsSync(log(session)) ? readFileSync(log(session), 'latin1') : ''
  const sizeOf = session => existsSync(log(session)) ? statSync(log(session)).size : 0
  // A start is any line that is not blank and does not begin with E; this count is the test's own, apart from the board's.
  const startsIn = session => text(session).split('\n').filter(line => line !== '' && !line.startsWith('E')).length
  let made = 0
  const token = () => (made += 1).toString(16).padStart(32, '0')
  const append = (session, line) => appendFileSync(log(session), line, 'latin1')
  // A start's line, appended whole; it answers the start's number.
  const appendStart = session => { append(session, `\nS ${token()}\n`); return startsIn(session) }
  // The turn-start hook: its start line (unless it cannot be appended: the take still carries the count plus one), its row
  // write (unless the event repeats the row's last one, which is not written again), then its take (unless it never reaches
  // the board), with the claim name a hook gives it when one is passed. `seq` names a line the hook appended already.
  const enroll = (session, surface, now, ref, { isAppendLost = false, isRowKept = false, isTakeLost = false, seq: given } = {}) => {
    const before = startsIn(session)
    if (given === undefined && !isAppendLost) append(session, `\nS ${token()}\n`)
    const seq = given ?? before + 1
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
  // A turn's Stop hook at `at`: it reads the log's size as its first act (`size` passes one read earlier), appends its one
  // line `E <size> <at> <token>`, which ends every start that begins before that size, and writes its row as waiting; its
  // call follows at once unless it is late (`stopCall` then sends it).
  const stop = (session, at, isCallLate = false, { size } = {}) => {
    append(session, `\nE ${size ?? sizeOf(session)} ${at} ${token()}\n`)
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
  // The sidecar's nonce for a message, worked out from the message as the board does (the board keeps none).
  const nonceOf = id => sha256(`wake:${id}:${saved(id).hash}`).slice(0, 16)
  return { hub, reports, written, log, text, sizeOf, startsIn, append, appendStart, enroll, stop, stopCall, report, ready, send, poll, shown, saved, nonceOf, close: () => { hub.close(); rmSync(dir, { recursive: true, force: true }) } }
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
  // A new turn starts: its hook appends its line to the turn log and writes the progress row as working, but its take never
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

test('a turn start whose line cannot be appended but whose take reached the board starts no wake', () => using(w => {
  w.enroll(APP, IDE, T - 30_000)
  w.poll(T - 1000)
  w.stop(APP, T, true)
  // The next turn's line cannot be appended, so the log still reads that turn's Stop as the last event; its take carries
  // the start count plus one, and reaches the board.
  assert.equal(w.enroll(APP, IDE, T + 1000, undefined, { isAppendLost: true }), null)
  delete w.reports[APP]
  w.report(APP, T + 1500)
  assert.equal(w.send(APP, 'm-seq', T + 1600).line, 'now')
  w.stopCall(APP, T + 2000)
  assert.deepEqual(w.poll(T + 15_000), { wakes: [] })
  assert.equal(w.hub.snapshot(T + 15_000).mailboxes[0].busySeq, 2)
  // That turn's Stop can end only the one start the log holds, so the numbers meet again after the next turn, whose take
  // hands the message over.
  w.stop(APP, T + 30_000)
  assert.deepEqual(w.poll(T + 30_000 + WAKE_IDLE_MS), { wakes: [] })
  assert.equal(w.enroll(APP, IDE, T + 50_000).id, 'm-seq')
  // The board keeps the highest number it saw, takes one only from Antigravity, and only a whole number above zero.
  w.hub.act('mailbox-turn', { agent: 'antigravity', session: APP, surface: IDE, seq: 1 }, T + 51_000)
  assert.equal(w.hub.snapshot(T + 51_000).mailboxes[0].busySeq, 2)
  for (const seq of [0, -1, 1.5, '3']) assert.throws(() => w.hub.act('mailbox-turn', { agent: 'antigravity', session: APP, surface: IDE, seq }, T + 52_000), /INVALID_MAILBOX_CALL/)
  assert.throws(() => w.hub.act('mailbox-turn', { agent: 'gemini', session: 'synthetic-gemini', surface: 'CLI', seq: 1 }, T + 52_000), /INVALID_MAILBOX_CALL/)
}))

test('no turn log, or one that cannot be read, holds the wake', () => using(w => {
  w.ready(APP)
  w.poll(T)
  assert.equal(w.send(APP, 'm-file', T).line, 'now')
  const kept = readFileSync(w.log(APP))
  rmSync(w.log(APP))
  assert.deepEqual(w.poll(T + 1000), { wakes: [] })
  // A directory in its place holds too.
  mkdirSync(w.log(APP))
  assert.deepEqual(w.poll(T + 1000), { wakes: [] })
  rmdirSync(w.log(APP))
  // So does a log over the 16 MB the board reads (a sparse file of that size, written only in its first bytes).
  writeFileSync(w.log(APP), kept)
  truncateSync(w.log(APP), 16 * 1024 * 1024 + 1)
  assert.deepEqual(w.poll(T + 1000), { wakes: [] })
  writeFileSync(w.log(APP), kept)
  assert.equal(w.poll(T + 2000).wakes[0]?.id, 'm-file')
}))

test('a Stop that read the log\'s size before the next turn\'s take does not end that turn, whose line could not be appended (codex_786)', () => using(w => {
  // The turn's start line is in the log, and a Stop hook reads the log's size as its first act, before its input.
  w.enroll(APP, IDE, T - 40_000)
  const size = w.sizeOf(APP)
  assert.equal(size, 36)
  // The next turn starts while that Stop is still working: its line cannot be appended, and its take sends the count plus one.
  delete w.reports[APP]
  assert.equal(w.enroll(APP, IDE, T - 30_000, undefined, { isAppendLost: true }), null)
  assert.equal(w.hub.snapshot(T - 30_000).mailboxes[0].busySeq, 2)
  // The Stop appends its line with the size it read first, then the model reports waiting and a message is sent.
  w.stop(APP, T - 20_000, false, { size })
  assert.match(w.text(APP).slice(36), STOP_LINE)
  assert.deepEqual(turnsOfLog(w.text(APP)), { started: 1, stopped: 1, stoppedAt: T - 20_000, size: w.sizeOf(APP) })
  w.poll(T)
  assert.equal(w.send(APP, 'm-786', T).line, 'now')
  // Ten seconds on: one stopped against a take that sent two, so no wake is listed and an attempt is refused.
  assert.deepEqual(w.poll(T + 15_000), { wakes: [] })
  assert.deepEqual(w.hub.act('wake-attempt', { id: 'm-786', nonce: w.nonceOf('m-786') }, T + 15_000), { ok: false, code: 'NOT_HELD' })
  // That turn's own Stop ends no line of its own, so the hold stays until the next turn's take hands the message over.
  w.stop(APP, T + 30_000)
  assert.deepEqual(w.poll(T + 30_000 + WAKE_IDLE_MS), { wakes: [] })
  const handed = w.enroll(APP, IDE, T + 50_000)
  assert.equal(handed?.id, 'm-786')
  w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: handed.id, nonce: handed.nonce }, T + 50_500)
  w.stop(APP, T + 60_000)
  w.send(APP, 'm-after', T + 60_000)
  assert.deepEqual(w.poll(T + 60_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-after'])
}))

test('a start appended after a Stop read the log\'s size stays open and holds the wake', () => using(w => {
  w.enroll(APP, IDE, T - 40_000)
  const size = w.sizeOf(APP)
  // The next turn's line lands after the Stop read the size and before its line: it begins at or after that size.
  w.enroll(APP, IDE, T - 25_000)
  w.stop(APP, T - 20_000, false, { size })
  assert.equal(w.text(APP).indexOf('\nS ', 1) >= size, true)
  assert.deepEqual(turnsOfLog(w.text(APP)), { started: 2, stopped: 1, stoppedAt: T - 20_000, size: w.sizeOf(APP) })
  w.poll(T)
  assert.equal(w.send(APP, 'm-open', T).line, 'now')
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  // That turn's own Stop reads the log's size after both lines, and the wake follows it by 10 s.
  w.stop(APP, T + 61_000)
  assert.deepEqual(w.poll(T + 61_000 + WAKE_IDLE_MS - 1), { wakes: [] })
  assert.deepEqual(w.poll(T + 61_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-open'])
}))

test('two Stops that read the same size end the same turns, and a start appended after both reads still holds the wake', () => using(w => {
  w.enroll(APP, IDE, T - 40_000)
  const size = w.sizeOf(APP)
  // The first Stop appends; a new turn's line lands; the second Stop, with the same size, appends after it.
  w.stop(APP, T - 30_000, false, { size })
  w.enroll(APP, IDE, T - 24_000)
  w.stop(APP, T - 20_000, false, { size })
  assert.deepEqual(turnsOfLog(w.text(APP)), { started: 2, stopped: 1, stoppedAt: T - 20_000, size: w.sizeOf(APP) })
  w.poll(T)
  w.send(APP, 'm-overlap', T)
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  // That turn's own Stop ends it, and the wake goes in 10 s later.
  w.stop(APP, T + 61_000)
  assert.deepEqual(w.poll(T + 61_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-overlap'])
}))

test('a Stop ends every start that begins before the size it read, in one appended line', () => using(w => {
  // Two model calls of one turn each appended a start line.
  w.enroll(APP, IDE, T - 40_000)
  w.enroll(APP, IDE, T - 39_000)
  const before = w.text(APP)
  assert.equal(before.length, 72)
  w.stop(APP, T - 20_000)
  const added = w.text(APP).slice(before.length)
  assert.equal(w.text(APP).startsWith(before), true)
  assert.equal(added.startsWith(`\nE 72 ${T - 20_000} `), true)
  assert.match(added, STOP_LINE)
  assert.deepEqual(turnsOfLog(w.text(APP)), { started: 2, stopped: 2, stoppedAt: T - 20_000, size: w.sizeOf(APP) })
  // The standing edge: a next turn whose line landed before the size was read is ended by that Stop too.
  w.enroll(APP, IDE, T - 10_000)
  w.stop(APP, T - 9_000)
  assert.deepEqual(turnsOfLog(w.text(APP)), { started: 3, stopped: 3, stoppedAt: T - 9_000, size: w.sizeOf(APP) })
  // No lock and no temporary file is left (the board's own server lock is not the Stop's).
  assert.deepEqual(readdirSync(dirname(w.log(APP))).filter(name => name.includes('.turns.') && !name.endsWith('.turns.log')), [])
}))

test('a line appended while a wake-attempt decides undoes the saved start, so the attempt is refused and the turn takes the message', () => {
  let isStarting = false, seq
  const w = world(undefined, undefined, (_agent, session) => { if (isStarting) { isStarting = false; seq = w.appendStart(session) } })
  try {
    w.ready(APP)
    w.poll(T)
    w.send(APP, 'm-undo', T)
    const [wake] = w.poll(T + 1000).wakes
    // The person starts a turn as the attempt reads the log: the hook's line lands after the attempt's read, before its
    // second look at the log's size.
    isStarting = true
    assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1000), { ok: false, code: 'NOT_HELD' })
    assert.equal(isStarting, false)
    assert.equal(w.saved('m-undo').woke, undefined)
    assert.deepEqual(w.poll(T + 1100), { wakes: [] })
    // The turn's hook goes on with its take, which hands the message over.
    assert.equal(w.enroll(APP, IDE, T + 1200, undefined, { seq }).id, 'm-undo')
  } finally { w.close() }
})

test('a wake-attempt whose undo cannot be saved answers with an error, so the sidecar sends nothing, and the saved start keeps the message to the turn\'s take', () => {
  const write = fs.writeFileSync
  let isArmed = false, saves = 0, seq
  const w = world(undefined, undefined, (_agent, session) => {
    if (!isArmed) return
    isArmed = false
    seq = w.appendStart(session)
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
    assert.equal(w.enroll(APP, IDE, T + 1200, undefined, { seq }).id, 'm-full')
  } finally { w.close() }
})

test('a wake-attempt takes no lock and reads the log\'s size again after saving the start', () => using(w => {
  w.ready(APP)
  w.poll(T)
  w.send(APP, 'm-nolock', T)
  const [wake] = w.poll(T + 1000).wakes
  // A lock file an older hook left stays as it is: no lock is read, waited for or made.
  const lock = join(dirname(w.log(APP)), `${mailboxId('antigravity', APP)}.turns.json.lock`)
  const held = JSON.stringify({ version: 1, pid: process.pid, started: T, token: 'b'.repeat(32) })
  writeFileSync(lock, held)
  // Each time the board looks at the turn log, whether the attempt's start is saved yet.
  const looks = [], look = fs.lstatSync
  fs.lstatSync = (path, ...rest) => { if (String(path).endsWith('.turns.log')) looks.push(w.saved('m-nolock').woke !== undefined); return look(path, ...rest) }
  syncBuiltinESMExports()
  try {
    assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1000), { ok: true })
  } finally { fs.lstatSync = look; syncBuiltinESMExports() }
  assert.equal(readFileSync(lock, 'utf8'), held)
  assert.equal(w.saved('m-nolock').woke, T + 1000)
  assert.ok(looks.length >= 2, JSON.stringify(looks))
  assert.equal(looks[0], false)
  assert.equal(looks.at(-1), true)
}))

// The windows the owner accepted (docs/dev/plan-0.25.1.md, M5b), two on 2026-11-18 and one on 2026-11-20, pinned as the board
// meets them.
test('a turn whose start hook never ran is woken into, the first window the owner accepted on 2026-11-18, while a turn its hook marked is held', () => using(w => {
  w.ready(APP); w.ready(APP_2)
  w.poll(T)
  w.send(APP, 'm-marked', T)
  w.send(APP_2, 'm-unmarked', T)
  // Both people start a turn whose take never reaches the board. In APP the hook's line is in the log, which holds the
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

test('a turn the person starts just before the board\'s yes, whose hook appends its start only after the attempt\'s second size read, takes the message once, the third window the owner accepted on 2026-11-20', () => using(w => {
  w.ready(APP)
  w.poll(T)
  w.send(APP, 'm-blind', T)
  const [wake] = w.poll(T + 1000).wakes
  // The app has begun the person's turn and launched its hook, which has not appended its line yet (58 to 94 ms in C3's
  // runs, plus the app's own delay before it launches the hook): nothing on disk says a turn runs, and the board says yes.
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1000), { ok: true })
  assert.equal(w.saved('m-blind').woke, T + 1000)
  // The line lands after the attempt's second look, so the start stands; the turn's take hands the message over, once.
  assert.equal(w.enroll(APP, IDE, T + 1090).id, 'm-blind')
  assert.deepEqual(w.poll(T + 1100), { wakes: [] })
}))

test('a turn start whose line cannot be appended before the board\'s yes takes the message once, the third window\'s write-fault case the owner accepted on 2026-11-26', () => using(w => {
  w.ready(APP)
  w.poll(T)
  w.send(APP, 'm-fault', T)
  const [wake] = w.poll(T + 1000).wakes
  // The person starts a turn and neither the worker nor the board script can append its line, so the attempt sees no sign of
  // it and answers yes. The window lasts until the take lands, at most 2 s.
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 1000), { ok: true })
  // The turn's take hands the message over once, and no second wake follows for that Stop.
  const handed = w.enroll(APP, IDE, T + 1200, undefined, { isAppendLost: true })
  assert.equal(handed.id, 'm-fault')
  w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: handed.id, nonce: handed.nonce }, T + 1250)
  w.send(APP, 'm-next', T + 1300)
  assert.deepEqual(w.poll(T + 1400 + WAKE_IDLE_MS), { wakes: [] })
  // That turn left no line, so its Stop ends nothing new and the take's count keeps the wake held: a delay, never a wake into
  // a turn. The next turn's take hands the next message over, and the wake follows that turn's Stop.
  w.stop(APP, T + 20_000)
  assert.deepEqual(w.poll(T + 20_000 + WAKE_IDLE_MS), { wakes: [] })
  const next = w.enroll(APP, IDE, T + 40_000)
  assert.equal(next.id, 'm-next')
  w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: next.id, nonce: next.nonce }, T + 40_100)
  w.stop(APP, T + 41_000)
  w.send(APP, 'm-after', T + 41_000)
  assert.deepEqual(w.poll(T + 41_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-after'])
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
// writing after each run what its turn log reads (null for no log). It waits for the processes named in `AGY_PEERS` to be
// ready first, so their hooks run at the same time.
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
const { readTurnLog } = await load('scripts/board-messaging.ts')
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
  const turns = readTurnLog(messages, 'antigravity', session)
  seen.push(turns === undefined ? null : { started: turns.started, stopped: turns.stopped })
}
writeFileSync(join(home, 'seen-' + name + '.json'), JSON.stringify(seen))
`

test('two hooks of one conversation with no lock get increasing turn numbers', async () => {
  const { defaultMessagesDirectory } = await import('../scripts/runtime-folder.ts')
  const home = mkdtempSync(join(tmpdir(), 'agy-order-'))
  // The hooks find the messages folder from the environment; without XDG_RUNTIME_DIR it is under this home on every system.
  const env = { ...process.env }
  delete env.XDG_RUNTIME_DIR
  const root = join(home, '.agent-board'), progress = join(root, 'progress.md')
  const messages = defaultMessagesDirectory(progress, home, env, process.platform)
  const file = join(messages, `${mailboxId('antigravity', APP)}.turns.log`)
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
      assert.ok(seen.every((turns, index) => index === 0 || turns.started > seen[index - 1].started), JSON.stringify(seen))
    }
    // Sixteen whole start lines, each token once, and no lock or temporary file beside the log.
    const lines = readFileSync(file, 'latin1').split('\n').filter(line => line !== '')
    assert.equal(lines.length, 2 * COUNT)
    assert.ok(lines.every(line => /^S [0-9a-f]{32}$/.test(line)), lines.join(' '))
    assert.equal(new Set(lines).size, 2 * COUNT)
    assert.deepEqual(readdirSync(messages).filter(name => name.includes('.turns.') && name !== basename(file)), [])
    // The conversation's Stop ends the last turn started, at its own time, with the size the log had.
    const before = Date.now(), size = statSync(file).size
    assert.deepEqual(await hooks('stop', 'Stop', 1), [{ started: 2 * COUNT, stopped: 2 * COUNT }])
    const text = readFileSync(file, 'latin1')
    const [, b, at] = /\nE (\d+) (\d+) [0-9a-f]{32}\n$/.exec(text)
    assert.equal(Number(b), size)
    assert.ok(Number(at) >= before && Number(at) <= Date.now(), at)
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
  const file = join(messages, `${mailboxId('antigravity', APP)}.turns.log`)
  const text = () => existsSync(file) ? readFileSync(file, 'latin1') : ''
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
  // A preload that refuses the worker's appends to the turn log, every time it is tried, and nothing else.
  const refuse = join(home, 'refuse.cjs')
  writeFileSync(refuse, `const fs = require('node:fs'), open = fs.openSync
fs.openSync = (target, flags, ...rest) => { if (String(target).endsWith('.turns.log') && flags === 'a') throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return open(target, flags, ...rest) }
`)
  return { home, root, messages, file, text, hook, refuse, close: () => rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
}
// Antigravity's real board script (scripts/codex-local.ts, through HOOKS) for one event of APP's conversation, given the mark
// a hook worker handed it; it answers what the turn log reads after it.
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
  const file = join(messages, `${mailboxId('antigravity', APP)}.turns.log`)
  const text = () => existsSync(file) ? readFileSync(file, 'latin1') : ''
  return { home, messages, file, text, run: (name, event, handed) => boardRun(home, name, event, handed), close: () => rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
}

test('the hook worker appends an Antigravity turn\'s start before the board script runs, so a board script stopped at its deadline still leaves it', async () => {
  const h = await workerHome()
  try {
    // No board has made the messages folder: the worker writes nothing, makes no folder, and hands on no mark, not
    // even one its own parent set.
    assert.equal(h.hook('PreInvocation', { AGENT_BOARD_TURN_MARK: JSON.stringify({ file: h.file, mark: 'start', token: 'a'.repeat(32) }) }), null)
    assert.equal(existsSync(h.messages), false)
    mkdirSync(h.messages, { recursive: true })
    // A board script that never ends is stopped at the worker's deadline and its event is queued; the turn's line is there:
    // 36 bytes, whole, named by a random token and no date.
    h.hook('PreInvocation', { AGY_SLOW: '1' }, { deadline: Date.now() + 1500 })
    assert.match(h.text(), START_LINE)
    assert.equal(readdirSync(join(h.root, 'pending')).filter(name => name.endsWith('.json')).length, 1)
    // A Stop reads the log's size as its first act, before its input: a start that lands right after that read (a preload
    // that wraps the read appends one) begins at or after the size the Stop's line names, so it stays open.
    const late = join(h.home, 'late.cjs')
    writeFileSync(late, `const fs = require('node:fs'), look = fs.lstatSync
let isDone = false
fs.lstatSync = (target, ...rest) => {
  const found = look(target, ...rest)
  if (!isDone && String(target).endsWith('.turns.log')) { isDone = true; fs.appendFileSync(target, '\\nS ' + 'e'.repeat(32) + '\\n') }
  return found
}
`)
    const before = Date.now()
    const stopped = h.hook('Stop', {}, { nodeArgs: ['--require', late] })
    assert.deepEqual(Object.keys(stopped).sort(), ['file', 'mark', 'token'])
    assert.equal(stopped.file, h.file)
    assert.equal(stopped.mark, 'stop')
    assert.match(stopped.token, /^[0-9a-f]{32}$/)
    const [, b, at, token] = /\nE (\d+) (\d+) ([0-9a-f]{32})\n$/.exec(h.text())
    assert.equal(Number(b), 36)
    assert.ok(Number(at) >= before && Number(at) <= Date.now(), at)
    assert.equal(token, stopped.token)
    assert.deepEqual(turnsOfLog(h.text()), { started: 2, stopped: 1, stoppedAt: Number(at), size: h.text().length })
    // A healthy board script is told which file the worker wrote, which mark and the token of its line.
    const started = h.hook('PreInvocation')
    assert.deepEqual(Object.keys(started).sort(), ['file', 'mark', 'token'])
    assert.equal(started.mark, 'start')
    assert.ok(h.text().endsWith(`\nS ${started.token}\n`))
    assert.equal(startSeq(h.messages, 'antigravity', APP, started.token), 3)
    // Nothing else is left beside the log: no lock, no record and no temporary file.
    assert.deepEqual(readdirSync(h.messages), [basename(h.file)])
  } finally { h.close() }
})

test('a turn start the hook worker could not append is appended by the board script, once', async () => {
  const h = await workerHome()
  try {
    mkdirSync(h.messages, { recursive: true })
    // The log refuses each of the worker's three appends: it hands on nothing and writes nothing.
    assert.equal(h.hook('PreInvocation', {}, { nodeArgs: ['--require', h.refuse] }), null)
    assert.equal(existsSync(h.file), false)
    // The board script appends one line and sends its number.
    assert.deepEqual(await boardRun(h.home, 'a', 'PreInvocation', undefined), [{ started: 1, stopped: 0 }])
    assert.match(h.text(), START_LINE)
  } finally { h.close() }
})

test('the board script takes the start the hook worker appended and does not append the turn again', async () => {
  const b = await boardHome()
  try {
    mkdirSync(b.messages, { recursive: true })
    const one = 'a'.repeat(32), two = 'b'.repeat(32)
    // Turn one has started and stopped; the worker appended turn two's line, so the board script counts the turn once.
    writeFileSync(b.file, `\nS ${one}\n\nE 36 5 ${'c'.repeat(32)}\n\nS ${two}\n`)
    const kept = b.text()
    assert.equal(startSeq(b.messages, 'antigravity', APP, one), 1)
    assert.equal(startSeq(b.messages, 'antigravity', APP, two), 2)
    // A token the log does not hold takes the number of starts plus one.
    assert.equal(startSeq(b.messages, 'antigravity', APP, 'd'.repeat(32)), 3)
    assert.deepEqual(await b.run('a', 'PreInvocation', JSON.stringify({ file: b.file, mark: 'start', token: two })), [{ started: 2, stopped: 1 }])
    assert.equal(b.text(), kept)
    // A token for another file or for the other mark is not taken: the board script appends the turn itself.
    assert.deepEqual(await b.run('b', 'PreInvocation', JSON.stringify({ file: `${b.file}.other`, mark: 'start', token: 'd'.repeat(32) })), [{ started: 3, stopped: 1 }])
    assert.deepEqual(await b.run('c', 'PreInvocation', JSON.stringify({ file: b.file, mark: 'stop', token: 'd'.repeat(32) })), [{ started: 4, stopped: 1 }])
    assert.equal(b.text().split('\n').filter(line => /^S [0-9a-f]{32}$/.test(line)).length, 4)
    // A Stop with no mark at all reads the log's size itself and appends its one line, which ends all four.
    assert.deepEqual(await b.run('d', 'Stop', 'null'), [{ started: 4, stopped: 4 }])
    // With no log, a start's number is one.
    rmSync(b.file)
    assert.equal(startSeq(b.messages, 'antigravity', APP, undefined), 1)
  } finally { b.close() }
})

test('a Stop whose worker cannot append hands the size it read to the board script, which ends exactly the turns before it', async () => {
  const h = await workerHome()
  try {
    mkdirSync(h.messages, { recursive: true })
    assert.equal(h.hook('PreInvocation').mark, 'start')
    const size = h.text().length
    // The log refuses the worker's three appends: it hands on the size it read first and writes nothing.
    const handed = h.hook('Stop', {}, { nodeArgs: ['--require', h.refuse] })
    assert.deepEqual(handed, { file: h.file, mark: 'stop', size })
    assert.equal(h.text().length, size)
    // The next turn's start lands after the worker's read; the board script appends the size it was handed, so that start stays open.
    appendFileSync(h.file, `\nS ${'f'.repeat(32)}\n`)
    assert.deepEqual(await boardRun(h.home, 'stop', 'Stop', JSON.stringify(handed)), [{ started: 2, stopped: 1 }])
    assert.match(h.text(), new RegExp(`\\nE ${size} \\d+ [0-9a-f]{32}\\n$`))
  } finally { h.close() }
})

test('a turn log that is a link or has a second name is never written through, by the hook worker or the board script', async () => {
  const h = await workerHome()
  try {
    mkdirSync(h.messages, { recursive: true })
    const outside = join(h.home, 'outside.txt'), missing = join(h.home, 'made-through-a-link.txt')
    writeFileSync(outside, 'kept')
    const cases = [['a second name', () => fs.linkSync(outside, h.file)], ['a link', () => fs.symlinkSync(outside, h.file, 'file')], ['a link to no file yet', () => fs.symlinkSync(missing, h.file, 'file')]]
    let tried = 0
    for (const [index, [what, make]] of cases.entries()) {
      rmSync(h.file, { force: true })
      try { make() } catch (error) {
        // Windows makes a link only in Developer Mode or for an administrator; CI's Ubuntu run covers links there.
        if (process.platform === 'win32' && error.code === 'EPERM') continue
        throw error
      }
      tried += 1
      // The worker refuses the log for a start and hands on nothing; its Stop, and the board script's own start and Stop,
      // refuse it too. Nothing reaches the file the log points at, and no file is made through a link.
      assert.equal(h.hook('PreInvocation'), null, what)
      h.hook('Stop')
      await boardRun(h.home, `start${index}`, 'PreInvocation', 'null')
      await boardRun(h.home, `stop${index}`, 'Stop', 'null')
      assert.equal(readFileSync(outside, 'utf8'), 'kept', what)
      assert.equal(existsSync(missing), false, what)
    }
    assert.ok(tried >= 1)
    // A plain log in its place is appended to again.
    rmSync(h.file, { force: true })
    assert.equal(h.hook('PreInvocation').mark, 'start')
    assert.match(h.text(), START_LINE)
  } finally { h.close() }
})

test('a Stop size larger than the log is never appended, and a stop line that names a size past itself ends no turn', () => using(async w => {
  const b = await boardHome()
  try {
    mkdirSync(b.messages, { recursive: true })
    writeFileSync(b.file, `\nS ${'a'.repeat(32)}\n`)
    // A size handed on counts only when it is a whole number no larger than the log: nothing is appended otherwise.
    for (const size of [10_000, 37, -1, 1.5, '36', null, Number.NaN]) {
      assert.equal(appendTurnStop(b.messages, 'antigravity', APP, size), false, String(size))
      assert.equal(b.text().length, 36)
    }
    assert.deepEqual(await b.run('a', 'Stop', JSON.stringify({ file: b.file, mark: 'stop', size: 10_000 })), [{ started: 1, stopped: 0 }])
    assert.equal(b.text().length, 36)
    // A hand-on that names this log and its Stop but no usable size reads as none: the board script appends nothing, and does
    // not read the size itself, which would come after the worker's first read (codex_788).
    for (const [index, size] of [-1, 1.5, '36', null, undefined, {}].entries()) {
      assert.deepEqual(await b.run(`m${index}`, 'Stop', JSON.stringify({ file: b.file, mark: 'stop', size })), [{ started: 1, stopped: 0 }], String(size))
      assert.equal(b.text().length, 36)
    }
    assert.equal(appendTurnStop(b.messages, 'antigravity', APP, 36), true)
    assert.deepEqual(turnsOfLog(b.text()).stopped, 1)
  } finally { b.close() }
  // A line in the log that names a size past its own place is a forgery or a fault: it is ignored, and holds the wake.
  w.enroll(APP, IDE, T - 30_000)
  w.append(APP, `\nE 99999 ${T - 20_000} ${'e'.repeat(32)}\n`)
  w.append(APP, `\nE ${w.sizeOf(APP) + 1} ${T - 20_000} ${'e'.repeat(32)}\n`)
  assert.deepEqual(turnsOfLog(w.text(APP)), { started: 1, stopped: 0, stoppedAt: 0, size: w.sizeOf(APP) })
  w.poll(T)
  w.send(APP, 'm-forged', T)
  assert.deepEqual(w.poll(T + 1000), { wakes: [] })
  // A line that names exactly its own place is whole: a Stop that read the size just before it.
  w.append(APP, `\nE ${w.sizeOf(APP)} ${T - 20_000} ${'e'.repeat(32)}\n`)
  assert.equal(turnsOfLog(w.text(APP)).stopped, 1)
  assert.deepEqual(w.poll(T + 1000).wakes.map(one => one.id), ['m-forged'])
}))

test('a Stop whose line cannot be appended leaves the turn open, and the wake waits for the next Stop', () => using(w => {
  w.ready(APP)
  w.enroll(APP, IDE, T - 15_000)
  // Neither the worker nor the board script could append the Stop's line: the row reads waiting, nothing else changed.
  w.report(APP, T - 14_000)
  w.poll(T)
  w.send(APP, 'm-unwritten', T)
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  assert.equal(turnsOfLog(w.text(APP)).started, 2)
  assert.equal(turnsOfLog(w.text(APP)).stopped, 1)
  // The next turn's take hands the message over; no wake ever goes into a turn.
  const handed = w.enroll(APP, IDE, T + 61_000)
  assert.equal(handed?.id, 'm-unwritten')
  w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: handed.id, nonce: handed.nonce }, T + 61_500)
  w.stop(APP, T + 62_000)
  assert.equal(turnsOfLog(w.text(APP)).stopped, 3)
  w.send(APP, 'm-after', T + 62_000)
  assert.deepEqual(w.poll(T + 62_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-after'])
}))

test('a Stop that cannot read the log\'s size appends nothing, so the turn stays open until the next Stop', async () => {
  const h = await workerHome()
  try {
    mkdirSync(h.messages, { recursive: true })
    assert.equal(h.hook('PreInvocation').mark, 'start')
    const kept = h.text()
    // The worker cannot read the messages folder: it appends nothing and tells the board script, which appends nothing.
    const blind = join(h.home, 'blind.cjs')
    writeFileSync(blind, `const fs = require('node:fs'), list = fs.readdirSync
fs.readdirSync = (target, ...rest) => { if (String(target).endsWith('-messages')) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return list(target, ...rest) }
`)
    const handed = h.hook('Stop', {}, { nodeArgs: ['--require', blind] })
    assert.deepEqual(handed, { file: h.file, mark: 'stop', none: true })
    assert.equal(h.text(), kept)
    assert.deepEqual(await boardRun(h.home, 'stop', 'Stop', JSON.stringify(handed)), [{ started: 1, stopped: 0 }])
    assert.equal(h.text(), kept)
  } finally { h.close() }
})

test('starts left by a turn whose Stop never wrote hold the wake across a restart until the next turn\'s Stop', () => using(w => {
  w.ready(APP)
  // A turn starts; the app closes, or the computer restarts, before its Stop appends anything.
  w.enroll(APP, IDE, T - 15_000)
  w.poll(T)
  w.send(APP, 'm-left', T)
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  // The next turn's take hands the message over; that turn's Stop reads the size after both starts and ends them all.
  const handed = w.enroll(APP, IDE, T + 61_000)
  assert.equal(handed?.id, 'm-left')
  w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: handed.id, nonce: handed.nonce }, T + 61_500)
  w.stop(APP, T + 62_000)
  assert.deepEqual(turnsOfLog(w.text(APP)).stopped, 3)
  w.send(APP, 'm-after', T + 62_000)
  assert.deepEqual(w.poll(T + 62_000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-after'])
}))

test('a cut or unknown line in the turn log holds the wake until the next Stop, and a cut stop line ends no turn', () => using(w => {
  w.ready(APP)
  w.poll(T)
  w.send(APP, 'm-cut', T)
  assert.equal(w.poll(T + 1000).wakes[0]?.id, 'm-cut')
  const whole = w.text(APP)
  // A cut stop line ends nothing, and reads as no start either: the log is as idle as it was.
  const tail = `\nE ${whole.length} ${T} abcd`
  w.append(APP, tail)
  assert.deepEqual(turnsOfLog(w.text(APP)), { ...turnsOfLog(whole), size: whole.length + tail.length })
  assert.equal(w.poll(T + 1000).wakes[0]?.id, 'm-cut')
  // A cut start, NUL bytes and an unterminated tail each read as a start, so each holds the wake.
  for (const [index, line] of ['\nS 0123', '\n\0\0\0\n', '\nxyz'].entries()) {
    w.append(APP, line)
    assert.equal(turnsOfLog(w.text(APP)).started, 2 + index, JSON.stringify(line))
    assert.deepEqual(w.poll(T + 2000 + index), { wakes: [] }, JSON.stringify(line))
  }
  // A whole Stop reads the size after all of them: they begin before it, so the next Stop releases the wake.
  w.stop(APP, T + 10_000)
  assert.equal(turnsOfLog(w.text(APP)).stopped, turnsOfLog(w.text(APP)).started)
  assert.deepEqual(w.poll(T + 10_000 + WAKE_IDLE_MS - 1), { wakes: [] })
  assert.equal(w.poll(T + 10_000 + WAKE_IDLE_MS).wakes[0]?.id, 'm-cut')
}))

test('after an upgrade the old order file and start records are not read, and the wake waits for one turn\'s Stop in the log', () => using(w => {
  const folder = dirname(w.log(APP)), id = mailboxId('antigravity', APP)
  // A development copy of D1 left its order file, with a closed list, its lock and a start record.
  const old = new Map([
    [join(folder, `${id}.turns.json`), JSON.stringify({ started: 1, stopped: 1, stoppedAt: T - 20_000, closed: [`${id}.turns.open.${'a'.repeat(32)}`] })],
    [join(folder, `${id}.turns.json.lock`), JSON.stringify({ version: 1, pid: process.pid, started: T, token: 'b'.repeat(32) })],
    [join(folder, `${id}.turns.open.${'c'.repeat(32)}`), ''],
  ])
  for (const [file, content] of old) writeFileSync(file, content)
  // A turn whose line could not be appended made the mailbox, so the board can be sent to; no log is written.
  w.enroll(APP, IDE, T - 30_000, undefined, { isAppendLost: true })
  w.poll(T)
  assert.equal(w.send(APP, 'm-old', T).line, 'now')
  // No log holds the wake, whatever the old file says.
  assert.deepEqual(w.poll(T + 1000), { wakes: [] })
  const handed = w.enroll(APP, IDE, T + 2000)
  assert.equal(handed.id, 'm-old')
  w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: handed.id, nonce: handed.nonce }, T + 2100)
  w.send(APP, 'm-new', T + 2500)
  assert.deepEqual(w.poll(T + 5000), { wakes: [] })
  // One turn's Stop in the log, and the wake follows it by 10 s.
  w.stop(APP, T + 6000)
  assert.deepEqual(w.poll(T + 6000 + WAKE_IDLE_MS - 1), { wakes: [] })
  assert.deepEqual(w.poll(T + 6000 + WAKE_IDLE_MS).wakes.map(one => one.id), ['m-new'])
  // The old files are neither read nor swept.
  for (const [file, content] of old) assert.equal(readFileSync(file, 'utf8'), content)
}))

// Eight processes appending to one log through the hook worker's own helper (`TURN_LOG_SOURCE` in hooks/hook-safety.ts),
// six writing start lines and two writing stop lines, each reading the log's size before each append.
const APPENDERS = `
import { registerHooks } from 'node:module'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(specifier + '.ts', context)
  }
} })
const { AGY_REPO: repo, AGY_DIR: dir, AGY_LOG: log, AGY_ROLE: role, AGY_NAME: name, AGY_COUNT: count, AGY_PEERS: peers } = process.env
const { TURN_LOG_SOURCE } = await import(new URL('hooks/hook-safety.ts', repo).href)
const helper = new Function('fs', 'randomUUID', TURN_LOG_SOURCE + '\\nreturn { turnToken, startLine, stopLine, appendTurnLine }')(fs, randomUUID)
fs.writeFileSync(join(dir, 'ready-' + name), '')
const until = Date.now() + 20000
while (Date.now() < until && !peers.split(',').every(peer => fs.existsSync(join(dir, 'ready-' + peer)))) await new Promise(done => setTimeout(done, 10))
const sizeNow = () => { try { return fs.lstatSync(log).size } catch (error) { if (error.code === 'ENOENT') return 0; throw error } }
const done = []
for (let index = 0; index < Number(count); index += 1) {
  const size = sizeNow(), token = helper.turnToken()
  const line = role === 'S' ? helper.startLine(token) : helper.stopLine(size, Date.now(), token)
  helper.appendTurnLine(log, line)
  done.push({ token, size, length: line.length, role })
}
fs.writeFileSync(join(dir, 'done-' + name + '.json'), JSON.stringify(done))
`

test('eight processes appending to one turn log leave every line whole, each at or after the size its writer read first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-append-'))
  const log = join(dir, `${mailboxId('antigravity', APP)}.turns.log`)
  const names = ['s1', 's2', 's3', 's4', 's5', 's6', 'e1', 'e2'], COUNT = 500
  const run = name => new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', APPENDERS], {
      env: { ...process.env, AGY_REPO: new URL('../', import.meta.url).href, AGY_DIR: dir, AGY_LOG: log, AGY_ROLE: name.startsWith('s') ? 'S' : 'E', AGY_NAME: name, AGY_COUNT: String(COUNT), AGY_PEERS: names.join(',') },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', fail)
    child.on('exit', code => code === 0 ? done(JSON.parse(readFileSync(join(dir, `done-${name}.json`), 'utf8'))) : fail(new Error(`${name} exited ${code}: ${errors}`)))
  })
  try {
    const written = (await Promise.all(names.map(run))).flat()
    assert.equal(written.length, names.length * COUNT)
    const text = readFileSync(log, 'latin1')
    // One: the file's length is the sum of the lines' lengths, so no write was cut or overwritten.
    assert.equal(text.length, written.reduce((sum, one) => sum + one.length, 0))
    // Two: every line, between its newlines, is a whole start or stop line.
    const lines = text.split('\n').filter(line => line !== '')
    assert.equal(lines.length, written.length)
    assert.ok(lines.every(line => /^S [0-9a-f]{32}$/.test(line) || /^E \d+ \d+ [0-9a-f]{32}$/.test(line)))
    // Three: every token appears once.
    const tokens = new Set(lines.map(line => line.slice(-32)))
    assert.equal(tokens.size, written.length)
    assert.ok(written.every(one => tokens.has(one.token)))
    // Four: each line begins at or after the size its writer read before it, and a stop line names that size.
    for (const one of written) {
      const at = text.indexOf(`${one.token}\n`)
      const start = text.lastIndexOf('\n', at - 1)
      assert.ok(start >= one.size, `${one.role} ${one.token}: begins at ${start}, writer read ${one.size}`)
      if (one.role === 'E') assert.match(text.slice(start, at), new RegExp(`^\\nE ${one.size} \\d+ $`))
    }
    // The reader reads it whole: every start counted, and the largest size a stop named ends the starts before it.
    const read = turnsOfLog(text)
    assert.equal(read.started, 6 * COUNT)
    assert.equal(read.size, text.length)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
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

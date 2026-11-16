import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// The board half of the Antigravity sidecar wake (#1396): the three calls the sidecar makes (the contract in
// hooks/antigravity-sidecar.ts), the desktop app's idle route that sends at once only while the sidecar polls,
// and the 10 seconds the board waits after a turn's end. The clock is passed in; every id and text is synthetic.
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
const { idleSince, serveModel, servePage } = await import('../hooks/serve.ts')
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

// A board's message store with its gate. `since` holds when each conversation's turn last ended, as the board's own
// record reads it; a conversation missing from it is working.
const world = (since = { [APP]: T - 20_000, [APP_2]: T - 20_000, [TERMINAL]: T - 20_000 }) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-wake-'))
  const hub = createMessaging(join(dir, 'messages'), false, {
    routes: RECEIVER_ROUTES,
    stateOfSession: (_agent, session) => since[session] === undefined ? 'working' : 'idle',
    idleSince: (_agent, session) => since[session],
  })
  const enroll = (session, surface, now) => hub.act('mailbox-turn', { agent: 'antigravity', session, surface }, now).message
  const send = (session, id, now) => hub.act('send', { id, target: mailboxId('antigravity', session), turn: 'session', text: `Synthetic note ${id}` }, now)
  const poll = now => hub.act('wake-poll', { agent: 'antigravity' }, now)
  const shown = (id, now) => hub.snapshot(now).messages.find(one => one.id === id)
  const saved = id => JSON.parse(readFileSync(join(dir, 'messages', 'messages.json'), 'utf8')).messages.find(one => one.id === id)
  return { hub, since, enroll, send, poll, shown, saved, close: () => { hub.close(); rmSync(dir, { recursive: true, force: true }) } }
}
const using = async fn => {
  const w = world()
  try { await fn(w) } finally { w.close() }
}

test('wake-poll lists only a queued message on the app\'s now route, one per poll, without its text, and each poll marks the sidecar alive', () => using(w => {
  w.enroll(APP, IDE, T); w.enroll(TERMINAL, TUI, T)
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
  w.enroll(APP, IDE, T)
  w.poll(T)
  w.send(APP, 'm-app', T)
  const [wake] = w.poll(T + 1000).wakes
  assert.deepEqual(w.hub.act('wake-attempt', { id: 'm-unknown', nonce: wake.nonce }, T + 1500), { ok: false, code: 'NOT_HELD' })
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: 'wrong-nonce' }, T + 1500), { ok: false, code: 'NOT_HELD' })
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 2000), { ok: true })
  // The start is on disk before the sidecar runs anything, as OpenCode's attempt is.
  assert.equal(w.saved('m-app').attempted, T + 2000)
  assert.equal(w.saved('m-app').status, 'queued')
  assert.deepEqual(w.hub.act('wake-attempt', { id: wake.id, nonce: wake.nonce }, T + 2500), { ok: false, code: 'WAKE_STARTED' })
  assert.deepEqual(w.poll(T + 60_000), { wakes: [] })
  assert.throws(() => w.hub.act('wake-attempt', { id: wake.id, nonce: 'not a token' }, T + 3000))
  // The turn-start hook still hands the message over, as it does for any hook mailbox.
  assert.equal(w.enroll(APP, IDE, T + 61_000).text, 'Synthetic note m-app')
}))

test('wake-report keeps sent or failed, a repeated report is the same report, a failed wake is not tried again and its message waits for the next turn', () => using(w => {
  w.enroll(APP, IDE, T); w.enroll(APP_2, IDE, T)
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

test('no wake within 10 s of a turn\'s end, none for a working conversation, and none while a wake turn runs', () => using(w => {
  assert.equal(WAKE_IDLE_MS, 10_000)
  w.since[APP] = T - WAKE_IDLE_MS + 1
  w.enroll(APP, IDE, T)
  w.poll(T)
  w.send(APP, 'm-first', T)
  assert.deepEqual(w.poll(T), { wakes: [] })
  delete w.since[APP]
  assert.deepEqual(w.poll(T + 1), { wakes: [] })
  w.since[APP] = T - WAKE_IDLE_MS + 1
  const [first] = w.poll(T + 1).wakes
  assert.equal(first.id, 'm-first')
  w.hub.act('wake-attempt', { id: first.id, nonce: first.nonce }, T + 2)
  w.hub.act('wake-report', { id: first.id, nonce: first.nonce, status: 'sent' }, T + 3)
  const handed = w.enroll(APP, IDE, T + 500)
  w.hub.act('mailbox-accept', { agent: 'antigravity', session: APP, id: handed.id, nonce: handed.nonce }, T + 600)
  w.send(APP, 'm-second', T + 1000)
  // The app has no running field: until the board's record shows a turn end after the wake, the conversation is not idle.
  assert.deepEqual(w.poll(T + 120_000), { wakes: [] })
  w.since[APP] = T + 30_000
  assert.deepEqual(w.poll(T + 30_000 + WAKE_IDLE_MS - 1), { wakes: [] })
  assert.equal(w.poll(T + 30_000 + WAKE_IDLE_MS).wakes[0]?.id, 'm-second')
}))

test('the board\'s own record of a turn\'s end is the time an idle conversation last reported, and nothing while it works', () => {
  const block = (state, updated) => `## Synthetic\n<!-- auto session=abcdef01 agent=antigravity resume=${APP} state=${state} updated=${new Date(updated).toISOString()} -->\n### App card\n- [?] Pick one?\n<!-- /auto session=abcdef01 -->\n`
  const at = state => idleSince(buildView(parseProgress(block(state, T - 20_000)), [], null, T, 0, {}, EN), 'antigravity', APP)
  assert.equal(at('waiting'), T - 20_000)
  assert.equal(at('working'), undefined)
  assert.equal(idleSince(buildView(parseProgress(block('waiting', T - 20_000)), [], null, T, 0, {}, EN), 'antigravity', APP_2), undefined)
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

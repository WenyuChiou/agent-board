import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { request } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
let parseProgress, buildView, serveModel, handledOnly, cardSendKey, sendKey, boardCounts, boardStatus, boardText, boardDocument, readQueuedMessaging, queueMessage, mailboxId, BOARD_SCRIPT, EN, ZH_TW, STRINGS
try {
  ;({ parseProgress } = await import('../hooks/parse.ts'))
  ;({ buildView } = await import('../hooks/view.ts'))
  ;({ serveModel, handledOnly, cardSendKey, sendKey } = await import('../hooks/serve.ts'))
  ;({ boardCounts, boardStatus } = await import('../hooks/board-status.ts'))
  ;({ boardText } = await import('../hooks/board.ts'))
  ;({ boardDocument } = await import('../hooks/board-json.ts'))
  ;({ readQueuedMessaging } = await import('../scripts/board-messaging.ts'))
  ;({ queueMessage } = await import('../hooks/messaging.ts'))
  ;({ mailboxId } = await import('../hooks/hook-messages.ts'))
  ;({ BOARD_SCRIPT } = await import('../hooks/board-script.ts'))
  ;({ EN } = await import('../hooks/strings-en.ts'))
  ;({ ZH_TW } = await import('../hooks/i18n.ts'))
  ;({ STRINGS } = await import('../hooks/strings.ts'))
} finally { loader.deregister() }

// 1296: after Queue for next turn the page counted the question as handled, but --status, --json and the
// terminal board counted it. Every surface now counts a queued answer as handled and shows it as queued.
const now = Date.now()
const first = '11111111-2222-4333-8444-555555555555'
const second = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const block = (session, text, id) => `## Synthetic project ${id}
<!-- auto session=${id} agent=codex resume=${session} state=waiting updated=${new Date(now).toISOString()} -->
### Synthetic task ${id}
- [?] ${text}
<!-- /auto session=${id} -->
`
const source = `${block(first, 'Blue or green?', 'abcdef01')}\n${block(second, 'Keep the draft?', 'abcdef02')}`
const mailbox = session => ({ id: mailboxId('codex', session), agent: 'codex', session, surface: 'synthetic', turn: 'session', scope: 'mailbox', expires: now + 3_600_000 })
const stored = () => {
  const box = mailbox(first)
  const queued = queueMessage({ messages: [], mailboxes: [mailbox(first), mailbox(second)] }, { id: 'SYNTHETIC-QUEUED-1', text: 'Blue', target: box.id, turn: 'session' }, 'board', box, now)
  return { version: 2, ...queued.state }
}
const view = (s = EN) => buildView(parseProgress(source), [], null, now, 0, {}, s)
const group = { now, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] }
const shown = state => ({ connections: [], mailboxes: state.mailboxes, messages: state.messages.map(({ nonce: _nonce, hash: _hash, ...one }) => one) })
const folderWithStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'queued-count-'))
  const messages = join(dir, 'messages')
  mkdirSync(messages)
  writeFileSync(join(messages, 'messages.json'), JSON.stringify(stored()))
  writeFileSync(join(dir, 'progress.md'), source)
  return { dir, messages }
}

// The receivers' records as tests/messaging.test.mjs reads them: since #1354 a card offers Send, and so shows its
// answer as being sent, only on a route a record has shown live.
const recorded = JSON.parse(readFileSync(new URL('./helpers/recorded-routes.json', import.meta.url), 'utf8'))

test('the page model lists the queued question as handled and keeps it on the sheet', () => {
  const model = serveModel(view(), [], EN, new Set(), false, shown(stored()), false, group, recorded)
  assert.equal(model.view.needs.n, 2)
  assert.equal(model.view.needs.cards.length, 2)
  assert.equal(model.view.needs.handled.length, 1)
  const queued = model.asks.find(ask => ask.isSending === true)
  assert.ok(queued)
  assert.equal(queued.send, 'mailbox')
  assert.ok(model.view.needs.cards.some(card => card.key === model.view.needs.handled[0]))
  const none = serveModel(view(), [], EN, new Set(), false, undefined, false, group)
  assert.deepEqual(none.view.needs.handled, [])
})

test('--status, the terminal board and --json count the queued answer as the page does', () => {
  const messaging = shown(stored())
  const counts = boardCounts(view(), [], EN, now, messaging)
  assert.deepEqual({ needs: counts.needs, queued: counts.queued }, { needs: 1, queued: 1 })
  assert.equal(boardCounts(view(), [], EN, now).needs, 2)
  assert.equal(boardCounts(view(), [], EN, now).queued, 0)

  const status = boardStatus(source, now, EN, undefined, '', '', [], messaging)
  assert.equal(status, `${EN.boardStatusLine(1, 0)} · ${EN.boardQueuedCount(1)}`)
  assert.equal(boardStatus(source, now, EN), EN.boardStatusLine(2, 0))

  const terminal = boardText(view(), [], EN, { width: 100, isColor: false, messaging }).split('\n')[0]
  assert.match(terminal, new RegExp(`● 1 ${EN.countWaiting}`))
  assert.ok(terminal.includes(`◌ ${EN.boardQueuedCount(1)}`), terminal)
  assert.match(boardText(view(), [], EN, { width: 100, isColor: false }).split('\n')[0], new RegExp(`● 2 ${EN.countWaiting}`))

  const document = boardDocument(view(), [], [], EN, '/synthetic-home', false, now, group, undefined, messaging)
  assert.equal(document.counts.needs, 1)
  assert.equal(document.counts.queued, 1)
  assert.equal(document.needs.length, 1)
  assert.equal(document.queued.length, 1)
  assert.equal(document.queued[0].text, 'Blue or green?')
  assert.equal(document.needs[0].text, 'Keep the draft?')
  const without = boardDocument(view(), [], [], EN, '/synthetic-home', false, now, group)
  assert.deepEqual([without.counts.needs, without.counts.queued, without.queued.length], [2, 0, 0])
})

test('the store file is read as the page reads it, without a lock, and an unreadable one counts nothing as queued', () => {
  const { dir, messages } = folderWithStore()
  try {
    const read = readQueuedMessaging(messages, Date.now())
    assert.equal(read.messages.length, 1)
    assert.equal(boardCounts(view(), [], EN, now, read).queued, 1)
    assert.equal(readQueuedMessaging(join(dir, 'no-such-folder'), Date.now()), undefined)
    writeFileSync(join(messages, 'messages.json'), '{"version":')
    assert.equal(readQueuedMessaging(messages, Date.now()), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('one file fed to the CLI gives the same count on --status, --json and the terminal board', () => {
  const { dir, messages } = folderWithStore()
  try {
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: join(dir, 'progress.md'), lang: 'en' })}\n${BOARD_SCRIPT}`)
    const env = { ...process.env, CLAUDE_PROGRESS_FILE: '', HOME: dir, USERPROFILE: dir, NO_COLOR: '1', LANG: 'en' }
    const run = args => spawnSync(process.execPath, [script, ...args, '--messages-dir', messages], { cwd: dir, env, timeout: 20_000, encoding: 'utf8' })
    assert.equal(run(['--status']).stdout.trim(), `${EN.boardStatusLine(1, 0)} · ${EN.boardQueuedCount(1)}`)
    const json = JSON.parse(run(['--json']).stdout)
    assert.equal(json.counts.needs, 1)
    assert.equal(json.counts.queued, 1)
    assert.equal(json.queued.length, 1)
    const terminal = run(['--print']).stdout.split('\n')[0]
    assert.match(terminal, new RegExp(`● 1 ${EN.countWaiting}`))
    assert.ok(terminal.includes(EN.boardQueuedCount(1)), terminal)
    // The three tables carry the new line in the same place.
    assert.equal(ZH_TW.boardQueuedCount(2), '2 項排隊中')
    assert.equal(STRINGS['zh-CN'].boardQueuedCount(2), '2 项排队中')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Codex P1 on #1339: one queued answer handed over every question of its session. An answer is bound to the question
// it answers, and only that question counts as handled; the others still need the person.
const twoInOne = `## Synthetic project aaaaaaa1
<!-- auto session=aaaaaaa1 agent=codex resume=${first} state=waiting updated=${new Date(now).toISOString()} -->
### Synthetic task aaaaaaa1
- [?] Blue or green?
- [?] Keep the draft?
<!-- /auto session=aaaaaaa1 -->
`
const twoView = () => {
  const one = buildView(parseProgress(twoInOne), [], null, now, 0, {}, EN)
  // The page names each question by the ledger's id; the test names them by hand.
  one.waiting.forEach((ask, index) => { ask.questionId = `Q-${index + 1}` })
  return one
}
const storedFor = (questionId, box) => {
  const queued = queueMessage({ messages: [], mailboxes: box.scope === 'mailbox' ? [box] : [] }, { id: 'SYNTHETIC-QUEUED-2', text: 'Blue', target: box.id, turn: box.turn, answers: questionId }, 'board', box, now)
  return { version: 2, ...queued.state }
}

test('one queued answer hands over its own question only: 1 needs you, 1 queued, on the page and on every other surface', () => {
  const messaging = shown(storedFor('Q-1', mailbox(first)))
  const model = serveModel(twoView(), [], EN, new Set(), false, messaging, false, group)
  assert.equal(model.view.needs.n, 2)
  assert.equal(model.view.needs.handled.length, 1)
  const handled = model.view.needs.cards.find(card => card.key === model.view.needs.handled[0])
  assert.ok(model.asks.find(ask => ask.key === handled.key).text === 'Blue or green?')
  const counts = boardCounts(twoView(), [], EN, now, messaging)
  assert.deepEqual({ needs: counts.needs, queued: counts.queued }, { needs: 1, queued: 1 })
  const terminal = boardText(twoView(), [], EN, { width: 100, isColor: false, messaging }).split('\n')[0]
  assert.match(terminal, new RegExp(`● 1 ${EN.countWaiting}`))
  assert.ok(terminal.includes(`◌ ${EN.boardQueuedCount(1)}`), terminal)
  const document = boardDocument(twoView(), [], [], EN, '/synthetic-home', false, now, group, undefined, messaging)
  assert.deepEqual([document.counts.needs, document.counts.queued, document.queued.length, document.needs.length], [1, 1, 1, 1])
  assert.equal(document.queued[0].text, 'Blue or green?')
  assert.equal(document.needs[0].text, 'Keep the draft?')
})

test('an answer bound to another question hands over neither of these', () => {
  const messaging = shown(storedFor('Q-OTHER', mailbox(first)))
  const counts = boardCounts(twoView(), [], EN, now, messaging)
  assert.deepEqual({ needs: counts.needs, queued: counts.queued }, { needs: 2, queued: 0 })
})

test('a question-bound message to a live connection the store file holds is counted by the page and by the file readers alike', () => {
  const live = { id: 'conn_live', agent: 'codex', session: first, surface: 'synthetic', turn: 'turn-1', scope: 'turn', expires: now + 3_600_000 }
  // The message is held for a live connection (not a mailbox): the store file holds the message, not the connection.
  const messages = storedFor('Q-2', live).messages.map(({ nonce: _nonce, hash: _hash, ...one }) => one)
  const page = serveModel(twoView(), [], EN, new Set(), false, { connections: [live], mailboxes: [], messages }, false, group)
  const file = serveModel(twoView(), [], EN, new Set(), false, { connections: [], mailboxes: [], messages }, false, group)
  for (const model of [page, file]) {
    assert.equal(model.view.needs.handled.length, 1)
    const handled = model.view.needs.cards.find(card => card.key === model.view.needs.handled[0])
    assert.equal(model.asks.find(ask => ask.key === handled.key).text, 'Keep the draft?')
  }
  const counts = boardCounts(twoView(), [], EN, now, { connections: [], mailboxes: [], messages })
  assert.deepEqual({ needs: counts.needs, queued: counts.queued }, { needs: 1, queued: 1 })
})

// Codex 102 P1 on #1339: a message bound to no question marked every question of its session handled.
const unboundFor = box => {
  const queued = queueMessage({ messages: [], mailboxes: [box] }, { id: 'SYNTHETIC-QUEUED-3', text: 'Blue', target: box.id, turn: box.turn }, 'board', box, now)
  return shown({ version: 2, ...queued.state })
}

test('a message bound to no question hands over the session\'s only question', () => {
  const model = serveModel(view(), [], EN, new Set(), false, unboundFor(mailbox(first)), false, group)
  assert.equal(model.view.needs.handled.length, 1)
  const handled = model.view.needs.cards.find(card => card.key === model.view.needs.handled[0])
  assert.equal(model.asks.find(ask => ask.key === handled.key).text, 'Blue or green?')
})

test('a message bound to no question hands over none of two questions in one session, and a bound one only its own', () => {
  const unbound = unboundFor(mailbox(first))
  const model = serveModel(twoView(), [], EN, new Set(), false, unbound, false, group)
  assert.deepEqual(model.view.needs.handled, [])
  const counts = boardCounts(twoView(), [], EN, now, unbound)
  assert.deepEqual({ needs: counts.needs, queued: counts.queued }, { needs: 2, queued: 0 })
  const bound = serveModel(twoView(), [], EN, new Set(), false, shown(storedFor('Q-2', mailbox(first))), false, group)
  assert.equal(bound.view.needs.handled.length, 1)
  assert.equal(bound.asks.find(ask => ask.key === bound.view.needs.handled[0]).text, 'Keep the draft?')
})

// Review of #1339 (codex_128), findings 7 to 9. One rule on every surface: only an answer from the board hands a
// question over; a message with no question id hands over the session's only question whether or not its target is
// connected at the moment; the card being sent is the one handed over, not every question of its session.
const live = { id: 'conn_live', agent: 'codex', session: first, surface: 'synthetic', turn: 'turn-1', scope: 'turn', expires: now + 3_600_000 }
const messagesFrom = (from, input = {}) => {
  const queued = queueMessage({ messages: [] }, { id: `SYNTHETIC-${from.replace(/\W/g, '')}`, text: 'Blue', target: live.id, turn: live.turn, ...input }, from, live, now)
  return queued.state.messages.map(({ nonce: _nonce, hash: _hash, ...one }) => one)
}

test('a message from another agent is not an answer: the question still needs the person, on the page and on the file readers', () => {
  const messages = messagesFrom('claude:peer-session')
  for (const connections of [[live], []]) {
    const messaging = { connections, mailboxes: [], messages }
    const model = serveModel(view(), [], EN, new Set(), false, messaging, false, group)
    assert.deepEqual(model.view.needs.handled, [], `connections: ${connections.length}`)
    const counts = boardCounts(view(), [], EN, now, messaging)
    assert.deepEqual({ needs: counts.needs, queued: counts.queued }, { needs: 2, queued: 0 })
  }
})

test('a board message to a live target with no question id is counted alike by the page and by the file readers', () => {
  const messages = messagesFrom('board')
  const page = serveModel(view(), [], EN, new Set(), false, { connections: [live], mailboxes: [], messages }, false, group)
  const file = serveModel(view(), [], EN, new Set(), false, { connections: [], mailboxes: [], messages }, false, group)
  assert.equal(page.view.needs.handled.length, 1)
  assert.deepEqual(file.view.needs.handled, page.view.needs.handled)
  const counts = boardCounts(view(), [], EN, now, { connections: [], mailboxes: [], messages })
  assert.deepEqual({ needs: counts.needs, queued: counts.queued }, { needs: 1, queued: 1 })
})

test('a reply being sent hands over its own card, not the other question of the same session', () => {
  const resumable = twoView()
  const [one, two] = resumable.waiting
  assert.ok(one.target && two.target, 'both questions carry the session to resume')
  const plain = serveModel(resumable, [], EN, new Set(), false, undefined, true, group)
  const [keyOne] = plain.asks.map(ask => ask.key)
  const sending = new Set([sendKey(one.target), cardSendKey(keyOne)])
  const model = serveModel(resumable, [], EN, sending, false, undefined, true, group)
  assert.deepEqual(model.view.needs.handled, [keyOne])
  assert.equal(model.view.needs.n, 2)
})

test('a message store folder that is a link is not read: every question waits, as the server refuses that folder', () => {
  const { dir, messages } = folderWithStore()
  try {
    const linked = join(dir, 'linked')
    // A junction is the folder link a Windows user can make without rights; lstat reports it as a link too.
    symlinkSync(messages, linked, 'junction')
    assert.equal(readQueuedMessaging(messages, Date.now()).messages.length, 1)
    assert.equal(readQueuedMessaging(linked, Date.now()), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Codex 182 P1 on #1339 (finding 1): the card took the receipt of the session's latest message, so an unrelated peer
// message rejected on disconnect made a queued board answer count as unanswered. The answer being counted decides.
test('a peer message rejected after a queued board answer does not make that answer count as unanswered', () => {
  const [queued] = shown(stored()).messages
  const rejected = { ...queued, id: 'SYNTHETIC-PEER-1', from: 'claude:peer-session', answers: undefined, status: 'rejected', error: 'TARGET_DISCONNECTED', updated: now + 1 }
  const messaging = { connections: [], mailboxes: [mailbox(first), mailbox(second)], messages: [queued, rejected] }
  const model = serveModel(view(), [], EN, new Set(), false, messaging, false, group)
  assert.equal(model.view.needs.handled.length, 1)
  assert.equal(model.asks.find(ask => ask.key === model.view.needs.handled[0]).text, 'Blue or green?')
  const counts = boardCounts(view(), [], EN, now, messaging)
  assert.deepEqual({ needs: counts.needs, queued: counts.queued }, { needs: 1, queued: 1 })
  // The board's own answer failing still puts the question back.
  const failed = { ...queued, status: 'rejected', error: 'TARGET_DISCONNECTED', updated: now + 2 }
  const back = serveModel(view(), [], EN, new Set(), false, { ...messaging, messages: [queued, failed] }, false, group)
  assert.deepEqual(back.view.needs.handled, [])
})

// Codex 182 P1 on #1339 (finding 2): the network page was given no messaging state, so it counted 1 needs you where
// the local page and the CLI counted 0 needs you, 1 queued. It gets the state that decides handled, never a message's content.
const SECRET = 'SYNTHETIC-SECRET-ANSWER-777'
const secretStore = () => {
  const box = mailbox(first)
  const queued = queueMessage({ messages: [], mailboxes: [mailbox(first), mailbox(second)] }, { id: 'SYNTHETIC-QUEUED-9', text: SECRET, target: box.id, turn: 'session' }, 'board', box, now)
  return { version: 2, ...queued.state }
}

test('the network page model counts a queued answer as handled, from state that holds no message content', () => {
  const messaging = shown(secretStore())
  const local = serveModel(view(), [], EN, new Set(), false, messaging, false, group)
  const phone = serveModel(view(), [], EN, new Set(), true, handledOnly(messaging), false, group)
  assert.equal(local.view.needs.handled.length, 1)
  assert.deepEqual(phone.view.needs.handled, local.view.needs.handled)
  assert.equal(phone.view.needs.n, local.view.needs.n)
  const kept = JSON.stringify(handledOnly(messaging))
  assert.ok(!kept.includes(SECRET), kept)
  assert.ok(!JSON.stringify(phone).includes(SECRET))
  assert.deepEqual(handledOnly(messaging).connections, [])
})

// Greptile P1 on #1339 (round 2 of the same class, R6): a stuck card's handled decision came from the reachable
// mailbox and the page's `isSending`, which the network page does not have. The decision now comes from the board's
// own message for the card, so the local page, the network page and the CLI agree for every kind of card.
const stuckSource = `## Synthetic project abcdef03
<!-- auto session=abcdef03 agent=codex resume=${first} state=waiting updated=${new Date(now).toISOString()} -->
### Synthetic task abcdef03
- [!] Config file is missing — need the sample
<!-- /auto session=abcdef03 -->
`
const kindsTable = [
  { kind: 'question', source: block(first, 'Blue or green?', 'abcdef01'), text: 'Blue or green?', failed: false, handled: 1 },
  { kind: 'question, answer failed', source: block(first, 'Blue or green?', 'abcdef01'), text: 'Blue or green?', failed: true, handled: 0 },
  { kind: 'stuck card', source: stuckSource, text: 'Config file is missing', failed: false, handled: 1 },
  { kind: 'stuck card, answer failed', source: stuckSource, text: 'Config file is missing', failed: true, handled: 0 },
]
for (const row of kindsTable) {
  test(`one queued board answer counts alike on the local page, the network page and the CLI: ${row.kind}`, () => {
    const box = mailbox(first)
    const queued = queueMessage({ messages: [], mailboxes: [box] }, { id: 'SYNTHETIC-KIND-1', text: SECRET, target: box.id, turn: 'session' }, 'board', box, now)
    const messaging = shown({ version: 2, ...queued.state })
    if (row.failed) Object.assign(messaging.messages[0], { status: 'rejected', error: 'TARGET_DISCONNECTED', updated: now + 1 })
    const one = buildView(parseProgress(row.source), [], null, now, 0, {}, EN)
    const local = serveModel(one, [], EN, new Set(), false, messaging, false, group)
    const phone = serveModel(one, [], EN, new Set(), true, handledOnly(messaging), false, group)
    assert.equal(local.view.needs.cards.length, 1, row.kind)
    assert.equal(local.view.needs.handled.length, row.handled, `local ${row.kind}`)
    assert.deepEqual(phone.view.needs.handled, local.view.needs.handled, `network ${row.kind}`)
    const counts = boardCounts(one, [], EN, now, messaging)
    assert.deepEqual([counts.needs, counts.queued], [1 - row.handled, row.handled], `CLI ${row.kind}`)
    assert.ok(!JSON.stringify(phone).includes(SECRET) && !JSON.stringify(handledOnly(messaging)).includes(SECRET), 'the network page holds no message text')
  })
}

const getBoard = (port, token, host) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/api/board', headers: { host: `${host}:${port}`, 'x-board-token': token } }, res => {
    let data = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { data += chunk })
    res.on('end', () => resolve({ status: res.statusCode, body: data }))
  })
  req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')))
  req.on('error', reject)
  req.end()
})
const postJson = (port, token, path, body) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'x-board-token': token } }, res => {
    let data = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { data += chunk })
    res.on('end', () => resolve({ status: res.statusCode, body: data }))
  })
  req.on('error', reject)
  req.end(JSON.stringify(body))
})

test('the local page, the network page and the CLI agree on one queued answer, and the network page shows no message text', { timeout: 40_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queued-lan-'))
  const messages = join(dir, 'messages')
  mkdirSync(messages)
  mkdirSync(join(dir, 'run'), { mode: 0o700 })
  writeFileSync(join(messages, 'messages.json'), JSON.stringify(secretStore()))
  writeFileSync(join(dir, 'progress.md'), source)
  const script = join(dir, 'agent-board.mjs')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: join(dir, 'progress.md'), lang: 'en' })}\n${BOARD_SCRIPT}`)
  // The network address is a made-up one that listens on the loopback, as the settings tests do.
  const preload = join(dir, 'preload.cjs')
  writeFileSync(preload, `const os = require('node:os'), { Server } = require('node:net')
os.networkInterfaces = () => ({ synthetic: [{ address: '192.168.42.2', family: 'IPv4', internal: false }] })
const listen = Server.prototype.listen
Server.prototype.listen = function (...args) { if (args[1] === '192.168.42.2') args[1] = '127.0.0.1'; return Reflect.apply(listen, this, args) }
`)
  const env = { ...process.env, CLAUDE_PROGRESS_FILE: '', HOME: dir, USERPROFILE: dir, TEMP: dir, TMP: dir, APPDATA: dir, LOCALAPPDATA: dir, NO_COLOR: '1', XDG_RUNTIME_DIR: join(dir, 'run'), LANG: 'en' }
  const child = spawn(process.execPath, ['--require', preload, script, '--serve-child', '--messages-dir', messages], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(done => child.once('exit', code => done(code)))
  try {
    const url = await new Promise((done, fail) => {
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { out += chunk; if (out.includes('\n')) done(new URL(out.split('\n')[0].trim())) })
      exited.then(code => fail(new Error(`server exited with ${code}: ${stderr}`)))
    })
    const port = Number(url.port)
    const token = url.searchParams.get('t')
    const opened = await postJson(port, token, '/api/lan', { address: '192.168.42.2' })
    assert.equal(opened.status, 200, opened.body)
    const phone = new URL(JSON.parse(opened.body).url)
    const local = await getBoard(port, token, '127.0.0.1')
    const remote = await getBoard(Number(phone.port), phone.searchParams.get('t'), phone.hostname)
    assert.equal(local.status, 200, local.body)
    assert.equal(remote.status, 200, remote.body)
    const localNeeds = JSON.parse(local.body).model.view.needs
    const remoteNeeds = JSON.parse(remote.body).model.view.needs
    assert.equal(localNeeds.handled.length, 1)
    assert.deepEqual(remoteNeeds.handled, localNeeds.handled)
    assert.equal(remoteNeeds.n, localNeeds.n)
    assert.ok(!remote.body.includes(SECRET), 'the network page holds no message text')
    assert.equal(JSON.parse(remote.body).messaging, undefined)
    const cli = spawnSync(process.execPath, [script, '--json', '--messages-dir', messages], { cwd: dir, env, timeout: 20_000, encoding: 'utf8' })
    const counts = JSON.parse(cli.stdout).counts
    assert.deepEqual([counts.needs, counts.queued], [localNeeds.n - localNeeds.handled.length, localNeeds.handled.length])
  } finally {
    child.kill()
    await Promise.race([exited, delay(1000)])
    rmSync(dir, { recursive: true, force: true })
  }
})

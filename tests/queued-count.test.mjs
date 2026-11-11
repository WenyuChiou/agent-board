import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
let parseProgress, buildView, serveModel, boardCounts, boardStatus, boardText, boardDocument, readQueuedMessaging, queueMessage, mailboxId, BOARD_SCRIPT, EN, ZH_TW, STRINGS
try {
  ;({ parseProgress } = await import('../hooks/parse.ts'))
  ;({ buildView } = await import('../hooks/view.ts'))
  ;({ serveModel } = await import('../hooks/serve.ts'))
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

test('the page model lists the queued question as handled and keeps it on the sheet', () => {
  const model = serveModel(view(), [], EN, new Set(), false, shown(stored()), false, group)
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

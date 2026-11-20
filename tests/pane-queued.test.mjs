import assert from 'node:assert/strict'
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
let parseProgress, buildView, statusLine, boardCounts, withQueuedAnswers, readQueuedMessaging, queuedMessagingOf, messagesFolder, defaultMessagesDirectory, queueMessage, mailboxId, EN
try {
  ;({ parseProgress } = await import('../hooks/parse.ts'))
  ;({ buildView, statusLine } = await import('../hooks/view.ts'))
  ;({ boardCounts, withQueuedAnswers } = await import('../hooks/board-status.ts'))
  ;({ readQueuedMessaging } = await import('../scripts/board-messaging.ts'))
  ;({ queuedMessagingOf, messagesFolder } = await import('../hooks/queued-store.ts'))
  ;({ defaultMessagesDirectory } = await import('../scripts/runtime-folder.ts'))
  ;({ queueMessage } = await import('../hooks/messaging.ts'))
  ;({ mailboxId } = await import('../hooks/hook-messages.ts'))
  ;({ EN } = await import('../hooks/strings-en.ts'))
} finally { loader.deregister() }

// 1296: the Claude Code pane counted a question whose answer is queued for the session's next turn as waiting,
// while the page, --status and --json count it as handled and say it is queued (#1339). The pane now reads the
// page's message store and counts the same question cards as queued. Synthetic data only.
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
const mailbox = session => ({ id: mailboxId('codex', session), agent: 'codex', session, surface: 'CLI', turn: 'session', scope: 'mailbox', expires: now + 3_600_000 })
const stored = () => {
  const box = mailbox(first)
  const queued = queueMessage({ messages: [], mailboxes: [mailbox(first), mailbox(second)] }, { id: 'SYNTHETIC-QUEUED-1', text: 'Blue', target: box.id, turn: 'session' }, 'board', box, now)
  return { version: 2, ...queued.state }
}
const view = () => buildView(parseProgress(source), [], null, now, 0, {}, EN)

test('the pane names the messages folder the page uses for the same progress.md', () => {
  const isWin = process.platform === 'win32'
  const progress = isWin ? 'C:\\Synthetic\\work\\progress.md' : '/synthetic/work/progress.md'
  const home = isWin ? 'C:\\Synthetic\\home' : '/synthetic/home'
  assert.equal(messagesFolder(isWin, progress, home, undefined, false), defaultMessagesDirectory(progress, home, {}, process.platform))
  // The same file named two ways is one board, as the page resolves it.
  const twice = isWin ? 'C:\\Synthetic\\work\\.\\x\\..\\progress.md' : '/synthetic/work/./x/../progress.md'
  assert.equal(messagesFolder(isWin, twice, home, undefined, false), defaultMessagesDirectory(progress, home, {}, process.platform))
  if (isWin) {
    const runtime = 'C:\\Synthetic\\runtime'
    assert.equal(messagesFolder(true, progress, home, runtime, false), defaultMessagesDirectory(progress, home, { XDG_RUNTIME_DIR: runtime }, 'win32'))
  } else {
    assert.equal(messagesFolder(false, progress, home, '/synthetic/run', true), join('/synthetic/run', defaultMessagesDirectory(progress, home, {}, 'linux').split('/').at(-1)))
  }
  assert.equal(messagesFolder(isWin, 'progress.md', home, undefined, false), null)
  assert.equal(messagesFolder(isWin, progress, '', undefined, false), null)
})

test('the pane reads the store text as the CLI reads the store file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pane-queued-'))
  try {
    const messages = join(dir, 'messages')
    mkdirSync(messages)
    const text = JSON.stringify(stored())
    writeFileSync(join(messages, 'messages.json'), text)
    assert.deepEqual(queuedMessagingOf(text, now), readQueuedMessaging(messages, now))
    assert.throws(() => queuedMessagingOf('{"version":2,"messages":"no"}', now))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the pane counts a queued answer as handled and queued, as the page, --status and --json do', () => {
  const messaging = queuedMessagingOf(JSON.stringify(stored()), now)
  const before = view()
  assert.equal(before.overview.waiting, 2)
  const shown = withQueuedAnswers(before, [], EN, messaging)
  const counts = boardCounts(before, [], EN, now, messaging)
  assert.equal(shown.overview.waiting, counts.needs)
  assert.equal(shown.overview.waiting, 1)
  assert.equal(shown.overview.queued, counts.queued)
  assert.equal(shown.overview.queued, 1)
  // The cards stay listed; only the count moves.
  assert.equal(shown.waiting.length, 2)
  const line = statusLine(shown, EN)
  assert.ok(line.includes(EN.statusWaiting(1)), line)
  assert.ok(line.includes(EN.boardQueuedCount(1)), line)
  // No store, or no message from the board: the view is the one built.
  assert.equal(withQueuedAnswers(before, [], EN, undefined), before)
  assert.equal(withQueuedAnswers(before, [], EN, { connections: [], mailboxes: [], messages: [] }), before)
})

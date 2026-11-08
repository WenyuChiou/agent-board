// The server notification (#1014): the server hands a page only the
// questions it actually notified, not ones it merely marked told because a
// page that opted in was present. A question delegated to a present page
// stays notifiable by that page; a question the server told while the
// browser was closed is merged into the page's told set, not notified again.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const loader = registerHooks({ resolve(specifier, context, next) {
  if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.startsWith(new URL('../', import.meta.url).href)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { parseProgress } = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { STRINGS } = await import('../hooks/strings.ts')
const { startServer } = await import('../scripts/board-serve.ts')
loader.deregister()

const firstText = 'Publish the synthetic plan, OK?'
const secondText = 'Ship the synthetic release, OK?'
const thirdText = 'Archive the synthetic draft, OK?'
const questionBlock = (session, question) => `## Synthetic\n<!-- auto session=${session} agent=codex state=waiting updated=${new Date().toISOString()} -->\n### Synthetic question\n- [?] ${question}\n<!-- /auto session=${session} -->\n`
const oneQuestion = questionBlock('abcd1234', firstText)
const twoQuestions = oneQuestion + questionBlock('1234abcd', secondText)
const threeQuestions = twoQuestions + questionBlock('deadbeef', thirdText)
// The notifyKey the server and the page use for a question comes from the
// model itself: read it off the ask with the matching text instead of
// recomputing the key format.
const keyOf = (model, text) => {
  const ask = (model.asks || []).find(one => one.text === text)
  assert.ok(ask, `no ask with text ${text}`)
  return ask.notifyKey || ask.key
}

const sleep = ms => new Promise(done => setTimeout(done, ms))
const waitFor = async (check, timeoutMs = 20_000) => {
  const until = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() >= until) throw new Error('timed out waiting for the server notification')
    await new Promise(done => setTimeout(done, 100))
  }
}

test('the server hands a page only the questions it actually notified', { timeout: 60_000 }, async () => {
  const s = STRINGS['zh-TW']
  const root = mkdtempSync(join(tmpdir(), 'agent-board-1014-'))
  const progress = join(root, 'progress.md')
  const messages = join(root, 'messages')
  const serverNotes = []
  writeFileSync(progress, oneQuestion)
  let url
  await new Promise(resolve => {
    startServer({
      s,
      port: 0,
      ping: {},
      messagesDirectory: messages,
      isDefaultMessagesDirectory: false,
      view: () => buildView(parseProgress(readFileSync(progress, 'utf8')), [], null, Date.now(), 0, {}, s, [], {}, undefined),
      pending: () => [],
      act: () => '',
      tidy: () => '',
      clean: () => '',
      sweep: () => {},
      sweepMs: 3_600_000,
      paste: () => ({ isAdded: false, note: 'synthetic' }),
      failure: () => null,
      onReady: readyUrl => { url = readyUrl; resolve(readyUrl); return true },
      onStop: () => {},
      idleMs: 20_000,
      notify: (title, body) => { serverNotes.push({ title, body }) },
    })
  })
  assert.ok(url, 'the server did not start')
  const token = new URL(url).searchParams.get('t')
  assert.ok(token, 'the server url has no token')
  const poll = async () => {
    const res = await fetch(`${url.split('?')[0]}api/board`, { headers: { 'x-board-token': token, 'x-board-page': 'p-test-page', 'x-board-notify': '1' } })
    if (res.status === 304) return null
    assert.equal(res.status, 200)
    return res.json()
  }
  // An opted-in page is present. A second question arrives: the server stays
  // quiet, and must not hand the question to the page as told — the page
  // still has to notify for it itself.
  const first = await poll()
  assert.ok(first && first.model, 'the first poll did not return a model')
  writeFileSync(progress, twoQuestions)
  await sleep(100)
  const second = await poll()
  assert.ok(second && second.model, 'the poll after the second question did not return a model')
  assert.deepEqual(serverNotes, [], 'the server notified while a page that opted in was present')
  const secondKey = keyOf(second.model, secondText)
  assert.ok(!(second.serverTold || []).includes(secondKey), 'the server handed a merely delegated question to the page as told')
  // No page polls any more. The server notifies for the third question once,
  // and a later page merges it as told instead of notifying again.
  writeFileSync(progress, threeQuestions)
  await waitFor(() => serverNotes.length >= 1)
  assert.equal(serverNotes.length, 1)
  assert.equal(serverNotes[0].title, s.notifyTitle('Synthetic'))
  assert.equal(serverNotes[0].body, s.noticeAsked('codex', thirdText))
  const third = await poll()
  assert.ok(third && third.model, 'the poll after the server notification did not return a model')
  const thirdKey = keyOf(third.model, thirdText)
  assert.ok((third.serverTold || []).includes(thirdKey), 'the server did not hand a question it actually notified to the page as told')
  assert.ok(!(third.serverTold || []).includes(secondKey), 'the server handed a merely delegated question to the page as told')
})

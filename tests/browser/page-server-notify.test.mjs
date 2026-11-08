// The server system notification (#1014): a real browser and a real server,
// two tabs together and then none. One notification per new waiting question
// across both surfaces, never one per tab.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from './fixture.mjs'

const loader = registerHooks({ resolve(specifier, context, next) {
  if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.startsWith(new URL('../../', import.meta.url).href)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { parseProgress } = await import('../../hooks/parse.ts')
const { buildView } = await import('../../hooks/view.ts')
const { STRINGS } = await import('../../hooks/strings.ts')
const { startServer } = await import('../../scripts/board-serve.ts')
loader.deregister()

const firstText = 'Publish the synthetic plan, OK?'
const secondText = 'Ship the synthetic release, OK?'
const thirdText = 'Archive the synthetic draft, OK?'
const questionBlock = (session, question) => `## Synthetic\n<!-- auto session=${session} agent=codex state=waiting updated=${new Date().toISOString()} -->\n### Synthetic question\n- [?] ${question}\n<!-- /auto session=${session} -->\n`
const oneQuestion = questionBlock('abcd1234', firstText)
const twoQuestions = oneQuestion + questionBlock('1234abcd', secondText)
const threeQuestions = twoQuestions + questionBlock('deadbeef', thirdText)

// The OS-level notification cannot be asserted from Playwright, so the journey stubs
// window.Notification with a spy and drives focus the same way as
// tests/browser/page-notify.test.mjs. The server's own notification is the
// `notify` spy the test hands to the server: a real spawn would ring the
// machine the test runs on.
const installNotificationSpy = async context => {
  await context.addInitScript(() => {
    window.__notifications = []
    window.__permissionRequests = 0
    window.Notification = function (title, options) { window.__notifications.push({ title, options }) }
    Object.defineProperty(window.Notification, 'permission', {
      get: function () {
        try { return window.localStorage.getItem('agent-board.test-notify-permission') || 'default' } catch (e) { return 'default' }
      },
      configurable: true,
    })
    window.Notification.requestPermission = function () {
      window.__permissionRequests += 1
      var grant = 'granted'
      try { grant = window.localStorage.getItem('agent-board.test-notify-grant') || 'granted' } catch (e) {}
      try { window.localStorage.setItem('agent-board.test-notify-permission', grant) } catch (e) {}
      return Promise.resolve(grant)
    }
    Object.defineProperty(document, 'hasFocus', {
      value: function () {
        try { return window.localStorage.getItem('agent-board.test-notify-focus') !== 'off' } catch (e) { return true }
      },
      configurable: true,
    })
    Object.defineProperty(document, 'visibilityState', {
      get: function () {
        try { return window.localStorage.getItem('agent-board.test-notify-visibility') || 'visible' } catch (e) { return 'visible' }
      },
      configurable: true,
    })
  })
}
const notesOf = page => page.evaluate(() => window.__notifications)
const waitFor = async (check, timeoutMs = 20_000) => {
  const until = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() >= until) throw new Error('timed out waiting for the notification')
    await new Promise(done => setTimeout(done, 100))
  }
}
const sleep = ms => new Promise(done => setTimeout(done, ms))

test('two tabs and the server together notify once; with no tab the server notifies once', { timeout: 180_000 }, async () => {
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
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    try {
      await context.grantPermissions(['notifications'])
      await installNotificationSpy(context)
      const page = await context.newPage()
      await page.goto(url)
      await page.getByText(firstText, { exact: true }).first().waitFor({ state: 'visible' })
      // The tab is focused while the test drives it, and a focused tab skips the
      // notification, so unfocus it before expecting one.
      await page.evaluate(() => window.localStorage.setItem('agent-board.test-notify-focus', 'off'))
      const toggle = page.locator('#notify-toggle')
      await toggle.click()
      assert.equal(await toggle.innerText(), s.notifyOnButton)
      assert.deepEqual(await notesOf(page), [])
      assert.deepEqual(serverNotes, [])
      const second = await context.newPage()
      await second.goto(url)
      await second.getByText(firstText, { exact: true }).first().waitFor({ state: 'visible' })
      assert.deepEqual(await notesOf(second), [])
      // A second question notifies exactly once across both tabs, with the
      // plugin's words and no sound, and the server stays quiet while a page
      // that opted in is open.
      writeFileSync(progress, twoQuestions)
      await waitFor(async () => (await notesOf(page)).length + (await notesOf(second)).length >= 1)
      const total = (await notesOf(page)).length + (await notesOf(second)).length
      assert.equal(total, 1)
      const note = [...await notesOf(page), ...await notesOf(second)][0]
      assert.equal(note.title, s.notifyTitle('Synthetic'))
      assert.equal(note.options.body, s.noticeAsked('codex', secondText))
      assert.equal(note.options.silent, true)
      await sleep(7000)
      assert.equal((await notesOf(page)).length + (await notesOf(second)).length, 1)
      assert.deepEqual(serverNotes, [])
      // Both tabs closed: the next question notifies exactly once from the
      // server, and it does not repeat.
      await page.close()
      await second.close()
      await sleep(1000)
      writeFileSync(progress, threeQuestions)
      await waitFor(() => serverNotes.length >= 1)
      assert.equal(serverNotes.length, 1)
      assert.equal(serverNotes[0].title, s.notifyTitle('Synthetic'))
      assert.equal(serverNotes[0].body, s.noticeAsked('codex', thirdText))
      await sleep(7000)
      assert.equal(serverNotes.length, 1)
    } finally { await context.close() }
  } finally { await browser.close() }
})

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { chromium } from './fixture.mjs'

const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(new URL('../../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { parseProgress } = await import('../../hooks/parse.ts')
const { buildView } = await import('../../hooks/view.ts')
const { serveModel, servePage } = await import('../../hooks/serve.ts')
const { STRINGS } = await import('../../hooks/strings.ts')
loader.deregister()

const NOW = Date.parse('2026-10-30T12:00:00Z')
const firstText = 'Publish the synthetic plan, OK?'
const secondText = 'Ship the synthetic release, OK?'
const thirdText = 'Archive the synthetic draft, OK?'
const fourthText = 'File the synthetic summary, OK?'
const questionBlock = (session, at, question) => `## Synthetic\n<!-- auto session=${session} agent=codex state=waiting updated=${at} -->\n### Synthetic question\n- [?] ${question}\n<!-- /auto session=${session} -->\n`
const oneQuestion = questionBlock('abcd1234', '2026-10-30T11:59:00Z', firstText)
const twoQuestions = oneQuestion + questionBlock('1234abcd', '2026-10-30T11:59:30Z', secondText)
const threeQuestions = twoQuestions + questionBlock('deadbeef', '2026-10-30T11:59:45Z', thirdText)
const fourQuestions = threeQuestions + questionBlock('beefdead', '2026-10-30T11:59:55Z', fourthText)
const modelOf = (source, s) => serveModel(buildView(parseProgress(source), [], null, NOW, 0, {}, s, [], {}, undefined), [], s, new Set(), false, undefined, false, {
  now: NOW, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [],
})

// The OS-level notification cannot be asserted from Playwright, so the journey stubs
// window.Notification with a spy: it records every construction and exposes a
// controllable permission. The permission and the grant live in localStorage, the
// store the tabs of one origin share, so a second tab sees the permission the first
// tab was granted — the way a real browser shares one permission per origin.
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
    // Focus is controllable the same way, so the journey can pin both cases of
    // the focus gate: a focused tab skips the notification, an unfocused one
    // fires it. A real tab is focused unless another tab is in front.
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
const requestsOf = page => page.evaluate(() => window.__permissionRequests)
const waitFor = async (check, timeoutMs = 10_000) => {
  const until = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() >= until) throw new Error('timed out waiting for the board to poll')
    await new Promise(done => setTimeout(done, 100))
  }
}

// Exercise the shipped page in a real browser; only HTTP responses are synthetic.
// Every request is intercepted, and no real host, board service or user profile is opened.
test('the page notifies once per new waiting question, in every language, and a second tab fires nothing twice', { timeout: 180_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    for (const [lang, s] of Object.entries(STRINGS)) {
      const context = await browser.newContext()
      try {
        await context.grantPermissions(['notifications'])
        await installNotificationSpy(context)
        let model = modelOf(oneQuestion, s)
        let polls = 0
        await context.route('**/*', async route => {
          const path = new URL(route.request().url()).pathname
          if (path === '/api/board') { polls += 1; await route.fulfill({ json: { model } }) } else if (path === '/') await route.fulfill({ contentType: 'text/html', body: servePage(s, 'synthetic') })
          else await route.fulfill({ status: 404, body: '' })
        })
        const page = await context.newPage()
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto('https://agent-board.example.test/?t=synthetic')
        await page.getByText(firstText, { exact: true }).first().waitFor({ state: 'visible' })
        const toggle = page.locator('#notify-toggle')
        assert.equal(await toggle.innerText(), s.notifyOffButton)
        assert.deepEqual(await notesOf(page), [])
        // The footer moves into the main column under 560px, so the toggle stays reachable on a phone.
        await page.setViewportSize({ width: 375, height: 900 })
        assert.ok(await toggle.isVisible(), `${lang}: the notify toggle is reachable at phone width`)
        await page.setViewportSize({ width: 1440, height: 900 })
        // Opting in asks the browser once and seeds the already-waiting question: it is told, not notified.
        await toggle.click()
        assert.equal(await requestsOf(page), 1)
        assert.equal(await toggle.innerText(), s.notifyOnButton)
        assert.equal(await page.locator('#note').innerText(), s.notifyOn)
        assert.deepEqual(await notesOf(page), [])
        // The tab is focused while the test drives it, and a focused tab skips the
        // notification, so unfocus it before expecting one.
        await page.evaluate(() => window.localStorage.setItem('agent-board.test-notify-focus', 'off'))
        // A second waiting question notifies exactly once, with the plugin's words and no sound,
        // and the next poll with the same model notifies nothing again.
        model = modelOf(twoQuestions, s)
        await page.waitForFunction(() => window.__notifications.length >= 1, undefined, { timeout: 10_000 })
        const notes = await notesOf(page)
        assert.equal(notes.length, 1)
        assert.equal(notes[0].title, s.notifyTitle('Synthetic'))
        assert.equal(notes[0].options.body, s.noticeAsked('codex', secondText))
        assert.equal(notes[0].options.silent, true)
        const seen = polls
        await waitFor(() => polls > seen)
        assert.deepEqual(await notesOf(page), notes)
        // A second tab on the same origin shares the told set: it fires nothing for the
        // questions already told, and a third question notifies exactly once across both tabs.
        const second = await context.newPage()
        await second.goto('https://agent-board.example.test/?t=synthetic')
        await second.getByText(secondText, { exact: true }).first().waitFor({ state: 'visible' })
        assert.deepEqual(await notesOf(second), [])
        model = modelOf(threeQuestions, s)
        await waitFor(async () => (await notesOf(page)).length + (await notesOf(second)).length >= 2, 10_000)
        const total = (await notesOf(page)).length + (await notesOf(second)).length
        assert.equal(total, 2)
        const third = [...await notesOf(page), ...await notesOf(second)].find(note => note.options.body === s.noticeAsked('codex', thirdText))
        assert.ok(third, 'the third question notified once')
        assert.equal(third.title, s.notifyTitle('Synthetic'))
        assert.equal(third.options.silent, true)
        const after = polls
        await waitFor(() => polls >= after + 2)
        assert.equal((await notesOf(page)).length + (await notesOf(second)).length, 2)
        await second.close()
        await page.close()
      } finally { await context.close() }
    }
  } finally { await browser.close() }
})

test('a denied notification permission is never asked again and says how to re-enable it', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const s = STRINGS['zh-TW']
    const context = await browser.newContext()
    try {
      await context.grantPermissions(['notifications'])
      await installNotificationSpy(context)
      const model = modelOf(oneQuestion, s)
      await context.route('**/*', async route => {
        const path = new URL(route.request().url()).pathname
        if (path === '/api/board') await route.fulfill({ json: { model } })
        else if (path === '/') await route.fulfill({ contentType: 'text/html', body: servePage(s, 'synthetic') })
        else await route.fulfill({ status: 404, body: '' })
      })
      const page = await context.newPage()
      await page.goto('https://agent-board.example.test/?t=synthetic')
      await page.getByText(firstText, { exact: true }).first().waitFor({ state: 'visible' })
      const toggle = page.locator('#notify-toggle')
      // The browser refuses the request: one request, the denied message, the label stays off.
      await page.evaluate(() => window.localStorage.setItem('agent-board.test-notify-grant', 'denied'))
      await toggle.click()
      assert.equal(await requestsOf(page), 1)
      assert.equal(await toggle.innerText(), s.notifyOffButton)
      assert.equal(await page.locator('#note').innerText(), s.notifyDenied)
      assert.equal(await page.evaluate(() => window.localStorage.getItem('agent-board.notify')), null)
      assert.deepEqual(await notesOf(page), [])
      // The permission is denied now, so a second press does not ask again.
      await toggle.click()
      assert.equal(await requestsOf(page), 1)
      assert.equal(await page.locator('#note').innerText(), s.notifyDenied)
      assert.equal(await toggle.innerText(), s.notifyOffButton)
      await page.close()
    } finally { await context.close() }
  } finally { await browser.close() }
})

test('a focused tab skips the notification and marks the question told; an unfocused or hidden tab fires it', { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const s = STRINGS['zh-TW']
    const context = await browser.newContext()
    try {
      await context.grantPermissions(['notifications'])
      await installNotificationSpy(context)
      let model = modelOf(oneQuestion, s)
      let polls = 0
      await context.route('**/*', async route => {
        const path = new URL(route.request().url()).pathname
        if (path === '/api/board') { polls += 1; await route.fulfill({ json: { model } }) } else if (path === '/') await route.fulfill({ contentType: 'text/html', body: servePage(s, 'synthetic') })
        else await route.fulfill({ status: 404, body: '' })
      })
      const page = await context.newPage()
      await page.goto('https://agent-board.example.test/?t=synthetic')
      await page.getByText(firstText, { exact: true }).first().waitFor({ state: 'visible' })
      const toggle = page.locator('#notify-toggle')
      await toggle.click()
      assert.equal(await toggle.innerText(), s.notifyOnButton)
      assert.deepEqual(await notesOf(page), [])
      // Focused: the person is looking at the board, so a new question is seen
      // on the page and not notified — and it is marked told, not left to ping later.
      model = modelOf(twoQuestions, s)
      const focusedPolls = polls
      await waitFor(() => polls > focusedPolls + 1)
      assert.deepEqual(await notesOf(page), [])
      // Unfocused: the second question stays told, so only the third question notifies.
      await page.evaluate(() => window.localStorage.setItem('agent-board.test-notify-focus', 'off'))
      model = modelOf(threeQuestions, s)
      await page.waitForFunction(() => window.__notifications.length >= 1, undefined, { timeout: 10_000 })
      const notes = await notesOf(page)
      assert.equal(notes.length, 1)
      assert.equal(notes[0].options.body, s.noticeAsked('codex', thirdText))
      // Hidden: even with focus, a tab behind another window still notifies.
      await page.evaluate(() => {
        window.localStorage.setItem('agent-board.test-notify-focus', 'on')
        window.localStorage.setItem('agent-board.test-notify-visibility', 'hidden')
      })
      model = modelOf(fourQuestions, s)
      await page.waitForFunction(() => window.__notifications.length >= 2, undefined, { timeout: 10_000 })
      const notesAfter = await notesOf(page)
      assert.equal(notesAfter.length, 2)
      assert.equal(notesAfter[1].options.body, s.noticeAsked('codex', fourthText))
      await page.close()
    } finally { await context.close() }
  } finally { await browser.close() }
})

test('the LAN page offers no notify toggle', () => {
  for (const s of Object.values(STRINGS)) {
    assert.equal(servePage(s, 'synthetic', true).includes('id="notify-toggle"'), false)
    assert.ok(servePage(s, 'synthetic', false).includes('id="notify-toggle"'))
  }
})

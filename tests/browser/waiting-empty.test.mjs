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
const { emptyQuestions, observeQuestions } = await import('../../hooks/questions.ts')
loader.deregister()

const NOW = Date.parse('2026-10-30T12:00:00Z')
const block = (state, at, question) => `## Synthetic\n<!-- auto session=abcd1234 agent=codex state=${state} updated=${at} -->\n### Synthetic question\n- [?] ${question}\n<!-- /auto session=abcd1234 -->\n`
const stopped = block('ended', '2026-10-26T12:00:00Z', 'Keep the synthetic report, OK?')
const current = block('waiting', '2026-10-30T11:59:00Z', 'Publish the synthetic plan, OK?')
const noQuestions = current.replace('state=waiting', 'state=working').replace('- [?] Publish the synthetic plan, OK?', '- [~] Check the synthetic plan')
const modelOf = (source, s) => {
  // The question was captured while this session was live, before it stopped.
  const ledger = source === stopped ? observeQuestions(emptyQuestions(), parseProgress(stopped.replace('state=ended', 'state=waiting')), null, [], Date.parse('2026-10-26T12:00:00Z'), true, 'synthetic-capture').ledger : undefined
  return serveModel(buildView(parseProgress(source), [], null, NOW, 0, {}, s, [], {}, ledger), [], s, new Set(), false, undefined, false, {
    now: NOW, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [],
  })
}

// Exercise the shipped page in a real browser; only HTTP responses are synthetic.
// Every request is intercepted, and no real host, board service or user profile is opened.
test('the default page scopes empty Waiting wording and preserves older-question navigation in every language and viewport', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    for (const [lang, expected] of [
      ['en', 'Nothing in the current Needs you list.'],
      ['zh-TW', '目前「需要你」清單沒有項目。'],
      ['zh-CN', '当前“需要你”列表没有项目。'],
    ]) {
      const s = STRINGS[lang]
      const context = await browser.newContext()
      try {
        let model = modelOf(stopped, s)
        assert.equal(model.view.needs.n, 0)
        assert.equal(model.view.needs.older.length, 1)
        const page = await context.newPage()
        await page.route('**/*', async route => {
          const path = new URL(route.request().url()).pathname
          if (path === '/api/board') await route.fulfill({ json: { model } })
          else if (path === '/') await route.fulfill({ contentType: 'text/html', body: servePage(s, 'synthetic') })
          else await route.fulfill({ status: 404, body: '' })
        })
        for (const width of [1440, 375]) {
          await page.setViewportSize({ width, height: 900 })
          model = modelOf(stopped, s)
          await page.goto('https://agent-board.example.test/?t=synthetic')
          const empty = page.locator('#needs .empty').first()
          await empty.waitFor({ state: 'visible' })
          assert.ok((await empty.innerText()).includes(expected), lang)
          const agent = page.locator('[data-agent="codex"]:visible').first()
          await agent.click()
          assert.ok((await empty.innerText()).includes(s.pgNoQuestions('Codex')))
          await agent.click()
          assert.ok((await empty.innerText()).includes(expected))
          const older = page.locator('#needs .older-line')
          await older.waitFor({ state: 'visible' })
          assert.match(await older.innerText(), /1/)
          const toggle = older.getByRole('button')
          await toggle.click()
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
          await page.getByText('Keep the synthetic report, OK?', { exact: true }).first().waitFor({ state: 'visible' })
          assert.ok(model.older.every(ask => ask.send !== 'send'))
          await toggle.click()
          assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
          assert.ok((await empty.innerText()).includes(expected))
          // Reload keeps the older question discoverable without moving it into Needs you.
          await page.reload()
          await page.locator('#needs .older-line').waitFor({ state: 'visible' })
          assert.equal(model.view.needs.n, 0)
          model = modelOf(noQuestions, s)
          await page.reload()
          await empty.waitFor({ state: 'visible' })
          assert.ok((await empty.innerText()).includes(expected))
          assert.equal(await page.locator('#needs .older-line').count(), 0)
          model = modelOf(current, s)
          await page.reload()
          await page.getByText('Publish the synthetic plan, OK?', { exact: true }).first().waitFor({ state: 'visible' })
          const hidden = await empty.evaluate(node => { const wrapper = node.closest('.fx'); return { inert: wrapper.inert, opacity: getComputedStyle(wrapper).opacity, height: wrapper.getBoundingClientRect().height } })
          assert.equal(hidden.inert, true)
          assert.equal(hidden.opacity, '0')
          assert.ok(hidden.height <= 1)
          assert.equal(model.view.needs.n, 1)
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${lang}/${width}`)
        }
        await page.close()
      } finally { await context.close() }
    }
  } finally { await browser.close() }
})

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { artifacts, chromium } from './fixture.mjs'

const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(new URL('../../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { parseProgress } = await import('../../hooks/parse.ts')
const { buildView } = await import('../../hooks/view.ts')
const { serveModel, servePage } = await import('../../hooks/serve.ts')
const { STRINGS } = await import('../../hooks/strings.ts')
loader.deregister()

const now = Date.parse('2026-11-15T12:00:00Z')
const title = 'Synthetic reopened Codex conversation'
const source = `## Synthetic\n<!-- auto session=abcdef01 agent=codex resume=11111111-2222-4333-8444-555555555555 dir=%2Fsynthetic-project state=ended updated=2026-11-15T12:00:00Z -->\n### ${title}\n- [~] Await the next message\n<!-- /auto session=abcdef01 -->\n`

// Real page rendering with synthetic HTTP only; this does not open or resume a native Codex session.
test('a stopped Codex card shows the reconnect prompt beside its resume action in every language and viewport (#1505)', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    for (const [lang, s] of Object.entries(STRINGS)) {
      const model = serveModel(buildView(parseProgress(source), [], null, now, 0, {}, s), [], s, new Set(), false, undefined, false, {
        now, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [],
      })
      for (const width of [1440, 375]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 } })
        try {
          const page = await context.newPage()
          const errors = []
          page.on('pageerror', error => errors.push(error.message))
          await page.route('**/*', async route => {
            const path = new URL(route.request().url()).pathname
            if (path === '/') await route.fulfill({ contentType: 'text/html', body: servePage(s, 'synthetic-resume') })
            else if (path === '/api/board') await route.fulfill({ json: { ok: true, model } })
            else await route.fulfill({ status: 404, body: '' })
          })
          await page.goto('https://agent-board.example.test/?t=synthetic')
          await page.locator('.shelf-head').first().waitFor({ state: 'visible' })
          assert.deepEqual(errors, [], 'the synthetic page runs without script errors')
          await page.locator('.shelf-head').filter({ hasText: s.pgStopped }).click()
          const row = page.locator('.row').filter({ has: page.getByText(title, { exact: true }) })
          await row.locator('.row-btn').click()
          const detail = width >= 1440 ? page.locator('#detail-rail') : row
          await detail.getByText(s.serveCodexResumePrompt, { exact: true }).waitFor({ state: 'visible' })
          await detail.getByRole('button', { name: s.serveCopyResume, exact: true }).waitFor({ state: 'visible' })
          for (const name of [s.serveSend('Codex'), s.serveQueueNextTurn('Codex'), s.serveQueueNextOpen('Codex')]) {
            assert.equal(await detail.getByRole('button', { name, exact: true }).count(), 0, 'an ended task does not offer an unverified send action')
          }
          await detail.getByRole('button', { name: s.pgCopyAnswer, exact: true }).waitFor({ state: 'visible' })
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${lang}/${width}: the instruction fits`)
          await page.screenshot({ path: join(artifacts, `synthetic-codex-resume-${lang}-${width}.png`), fullPage: true, animations: 'disabled' })
        } finally { await context.close() }
      }
    }
  } finally { await browser.close() }
})

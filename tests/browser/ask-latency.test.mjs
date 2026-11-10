import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { chromium } from './fixture.mjs'
import { PANE_MS } from '../e2e/lib/budget.mjs'

const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(new URL('../../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { parseProgress } = await import('../../hooks/parse.ts')
const { buildView } = await import('../../hooks/view.ts')
const { serveModel, servePage } = await import('../../hooks/serve.ts')
const { EN } = await import('../../hooks/strings-en.ts')
loader.deregister()

const now = Date.parse('2026-11-09T12:00:00Z')
const question = 'Publish the synthetic latency report, OK?'
const modelOf = isWaiting => {
  const source = `## Synthetic latency\n<!-- auto session=abcd1234 agent=codex state=${isWaiting ? 'waiting' : 'working'} updated=2026-11-09T11:59:00Z -->\n### Synthetic latency task\n- [${isWaiting ? '?' : '~'}] ${isWaiting ? question : 'Prepare the synthetic report'}\n<!-- /auto session=abcd1234 -->\n`
  return serveModel(buildView(parseProgress(source), [], null, now, 0, {}, EN), [], EN, new Set(), false, undefined, false, { now, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] })
}

const observeQuestion = async (responseMs, { isLegacyPoll = false } = {}) => {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.addInitScript(({ question }) => {
        window.syntheticLatency = { start: null, shown: null }
        const nativeFetch = window.fetch.bind(window)
        window.fetch = async (...args) => {
          const response = await nativeFetch(...args)
          if (new URL(args[0], location.href).pathname === '/api/board') {
            const json = response.json.bind(response)
            response.json = async () => {
              const data = await json()
              // Publishing the new model uses this same clock boundary: the route below
              // reads this marker, so the question cannot predate its measurement.
              if (window.syntheticLatency.start === null) window.syntheticLatency.start = performance.now()
              return data
            }
          }
          return response
        }
        const inspect = () => {
          const node = [...document.querySelectorAll('#board .q')].find(node => node.textContent === question)
          let isVisible = !!node && node.getBoundingClientRect().height > 0
          for (let parent = node; parent && isVisible; parent = parent.parentElement) {
            const style = getComputedStyle(parent)
            isVisible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) >= 0.9
          }
          if (isVisible && window.syntheticLatency.start !== null) window.syntheticLatency.shown = performance.now()
          else requestAnimationFrame(inspect)
        }
        document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(inspect), { once: true })
      }, { question })
      let reads = 0
      await page.route('**/*', async route => {
        const path = new URL(route.request().url()).pathname
        if (path === '/api/board') {
          const isFirst = ++reads === 1
          const isWaiting = await page.evaluate(() => window.syntheticLatency.start !== null)
          const model = modelOf(isWaiting)
          await new Promise(done => setTimeout(done, isFirst ? 100 : responseMs))
          await route.fulfill({ json: { model, now } })
        } else if (path === '/') {
          const original = servePage(EN, 'synthetic')
          const body = isLegacyPoll ? original.replace('setTimeout(refresh, 2000)', 'setTimeout(refresh, 3000)') : original
          if (isLegacyPoll) assert.notEqual(body, original, 'The causal control restores exactly the old poll delay')
          await route.fulfill({ contentType: 'text/html', body })
        } else await route.fulfill({ status: 404, body: '' })
      })
      await page.goto('https://agent-board.example.test/?t=synthetic')
      await page.waitForFunction(() => window.syntheticLatency.shown !== null, undefined, { timeout: 12_000 })
      const timing = await page.evaluate(() => window.syntheticLatency)
      assert.ok(reads >= 2, 'The shipped page fetched the newly available question')
      assert.ok(timing.shown >= timing.start)
      return timing.shown - timing.start
    } finally { await context.close() }
  } finally { await browser.close() }
}

test('the shipped page visibly draws a newly available question within three seconds including its response round trip', { concurrency: false, timeout: 30_000 }, async () => {
  const elapsed = await observeQuestion(100)
  assert.ok(elapsed <= PANE_MS, `Visible question took ${elapsed.toFixed(1)} ms; unchanged budget is ${PANE_MS} ms`)
})

test('a response that alone exceeds the three-second deadline is never reported as an in-budget question', { concurrency: false, timeout: 30_000 }, async () => {
  const elapsed = await observeQuestion(PANE_MS + 100)
  assert.ok(elapsed > PANE_MS, `Late response was counted inside ${PANE_MS} ms: ${elapsed}`)
})

test('restoring the legacy poll consumes the three-second deadline before a positive response can be shown', { concurrency: false, timeout: 30_000 }, async () => {
  const elapsed = await observeQuestion(100, { isLegacyPoll: true })
  assert.ok(elapsed > PANE_MS, `The legacy schedule unexpectedly met ${PANE_MS} ms: ${elapsed}`)
})

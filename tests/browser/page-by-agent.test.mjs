import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserFixture, writeProgress } from './fixture.mjs'

const block = (index, agent) => `## Synthetic phone project ${index}
<!-- auto session=${String(47710000 + index)} agent=${agent} state=waiting updated=${new Date().toISOString()} -->
### Synthetic phone task ${index}
- [?] Choose synthetic option ${index} A or B?
- [ ] Keep the page tall enough to scroll
<!-- /auto session=${String(47710000 + index)} -->
`

test('at 375 px the chip row scrolls sideways and the page does not', async () => {
  await browserFixture('page-by-agent-phone', async ({ page, progress, startServer }) => {
    const agents = ['claude', 'codex', 'cursor', 'gemini', 'grok', 'muse', 'hermes', 'opencode', 'antigravity', 'deepseek']
    writeProgress(progress, agents.map((agent, index) => block(index, agent)).join('\n'))
    await page.setViewportSize({ width: 375, height: 700 })
    const url = await startServer()
    await page.goto(`${url}&group=agent`, { waitUntil: 'domcontentloaded' })
    const picker = page.locator('#picker')
    await picker.waitFor({ state: 'visible' })
    await page.locator('#picker [data-pick]').first().waitFor({ state: 'visible' })

    const geometry = await picker.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrolled: (element.scrollLeft = element.scrollWidth, element.scrollLeft),
    }))
    assert.ok(geometry.scrollWidth > geometry.clientWidth, JSON.stringify(geometry))
    assert.ok(['auto', 'scroll'].includes(geometry.overflowX), JSON.stringify(geometry))
    assert.ok(geometry.scrolled > 0, JSON.stringify(geometry))
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))

    const heights = await page.locator('#picker [data-pick]').evaluateAll(entries => entries.map(entry => entry.getBoundingClientRect().height))
    assert.ok(heights.length >= agents.length + 1)
    assert.ok(heights.every(height => height >= 44), JSON.stringify(heights))

    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForFunction(() => scrollY > 0)
    const positions = await page.evaluate(() => ({
      header: document.querySelector('header').getBoundingClientRect().bottom,
      picker: document.querySelector('#picker').getBoundingClientRect().top,
    }))
    assert.ok(positions.picker >= positions.header - 1, JSON.stringify(positions))
    assert.ok(positions.picker <= positions.header + 2, JSON.stringify(positions))
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  })
})

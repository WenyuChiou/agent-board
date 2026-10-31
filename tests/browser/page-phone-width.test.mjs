import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoardPage } from './board-page.mjs'
import { browserFixture, writeProgress } from './fixture.mjs'

const block = (index, agent) => `## Synthetic phone project ${index}
<!-- auto session=${String(47710000 + index)} agent=${agent} state=waiting updated=${new Date().toISOString()} -->
### Synthetic phone task ${index} with a title long enough that it has to be cut to the width of the screen
- [?] Choose synthetic option ${index} A or B?
- [ ] Keep the page tall enough to scroll
<!-- /auto session=${String(47710000 + index)} -->
`

// Everything outside a box that scrolls on purpose (the icon row) has to end inside the screen.
const pastTheEdge = () => {
  const edge = document.documentElement.clientWidth
  const scrolls = node => { for (let up = node.parentElement; up && up !== document.body; up = up.parentElement) if (/(auto|scroll)/.test(getComputedStyle(up).overflowX) && up.scrollWidth > up.clientWidth) return true; return false }
  const out = []
  for (const node of document.querySelectorAll('body *')) {
    const box = node.getBoundingClientRect()
    if (!box.width || !box.height || getComputedStyle(node).visibility === 'hidden') continue
    if (box.right > edge + 1 && !scrolls(node) && !node.closest('svg')) out.push(`${node.tagName.toLowerCase()}${node.className && typeof node.className === 'string' ? '.' + node.className.split(' ')[0] : ''} ${Math.round(box.right)}>${edge}`)
  }
  return { page: document.documentElement.scrollWidth - edge, out: out.slice(0, 8) }
}

test('at phone widths nothing on the page runs past its edge', { timeout: 180_000 }, async () => {
  await browserFixture('page-phone-width', async ({ page, progress, startServer }) => {
    const agents = ['claude', 'codex', 'cursor', 'gemini', 'grok', 'muse', 'hermes', 'opencode', 'antigravity', 'deepseek']
    writeProgress(progress, agents.map((agent, index) => block(index, agent)).join('\n'))
    const board = new BoardPage(page)
    await page.setViewportSize({ width: 375, height: 700 })
    await board.open(await startServer())
    await page.locator('nav#agents [data-agent]').first().waitFor({ state: 'visible' })

    // Ten agents do not fit one phone row: the row scrolls sideways and the page does not.
    const row = await page.locator('nav#agents .agents-in').evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrolled: (element.scrollLeft = element.scrollWidth, element.scrollLeft),
    }))
    assert.ok(row.scrollWidth > row.clientWidth, JSON.stringify(row))
    assert.ok(['auto', 'scroll'].includes(row.overflowX), JSON.stringify(row))
    assert.ok(row.scrolled > 0, JSON.stringify(row))

    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme })
      for (const width of [320, 375, 414]) {
        await page.setViewportSize({ width, height: 700 })
        await page.waitForFunction(count => document.querySelectorAll('li.row, article.card').length >= count, 1)
        for (const where of ['top', 'bottom']) {
          await page.evaluate(place => scrollTo(0, place === 'top' ? 0 : document.documentElement.scrollHeight), where)
          const found = await page.evaluate(pastTheEdge)
          assert.equal(found.page <= 0, true, `${scheme} ${width}px ${where}: the page scrolls sideways by ${found.page}px`)
          assert.deepEqual(found.out, [], `${scheme} ${width}px ${where}: boxes end past the screen edge`)
        }
      }
    }

    // On a phone the header scrolls away and the icon row stays at the top of the screen.
    await page.setViewportSize({ width: 375, height: 700 })
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForFunction(() => scrollY > 0)
    const top = await page.locator('nav#agents').evaluate(element => element.getBoundingClientRect().top)
    assert.ok(Math.abs(top) <= 2, `the icon row is at ${top}px`)
  })
})

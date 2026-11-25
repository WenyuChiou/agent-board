import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoardPage } from './board-page.mjs'
import { browserFixture, writeProgress } from './fixture.mjs'

const FIXTURE_MD = () => {
  const updated = new Date().toISOString()
  return `## Alpha Project
<!-- auto session=48490001 agent=claude state=waiting updated=${updated} -->
### Fix flaky upload retry
- [x] Trace upload timeout
- [?] Retry upload with backoff or surface the error immediately?
  - Retry with backoff
  - Surface error immediately
<!-- /auto session=48490001 -->

## Beta Project
<!-- auto session=48490002 agent=codex state=working updated=${updated} -->
### Build export worker
- [x] Parse CSV schema
- [~] Stream rows to temporary file
- [ ] Upload export bundle
<!-- /auto session=48490002 -->
`
}

test('at 1280x800 there is one work column and no summary column', { timeout: 180_000 }, async () => {
  await browserFixture('one-column-1280', async ({ page, progress, startServer }) => {
    writeProgress(progress, FIXTURE_MD())
    const board = new BoardPage(page)
    await page.setViewportSize({ width: 1280, height: 800 })
    await board.open(await startServer())
    await board.question('Retry upload with backoff').waitFor({ state: 'visible' })
    await board.task('Build export worker').waitFor({ state: 'visible' })

    const layout = await page.evaluate(() => {
      const col = document.querySelector('main.col')
      const needs = document.getElementById('needs')
      const working = document.querySelector('[data-sec="working"]')
      const rail = document.getElementById('detail-rail')
      const board = document.getElementById('board')
      const needsRect = needs.getBoundingClientRect()
      const workingRect = working.getBoundingClientRect()
      return {
        colWidth: Math.round(col.getBoundingClientRect().width),
        boardDisplay: getComputedStyle(board).display,
        boardCols: getComputedStyle(board).gridTemplateColumns,
        needsBottom: Math.round(needsRect.bottom),
        workingTop: Math.round(workingRect.top),
        railVisible: rail ? getComputedStyle(rail).display !== 'none' && !rail.hidden : false,
      }
    })

    assert.ok(layout.colWidth <= 760, `expected work column width <= 760px, got ${layout.colWidth}px`)
    assert.ok(
      layout.workingTop >= layout.needsBottom - 1,
      `expected single stacked work column (no side-by-side summary column), got needsBottom=${layout.needsBottom}, workingTop=${layout.workingTop}, display=${layout.boardDisplay} cols=${layout.boardCols}`,
    )
    assert.equal(layout.railVisible, false, 'detail rail should stay hidden at 1280x800')

    // Below 1440 px, clicking a row opens it in place.
    const task = await board.openTask('Build export worker')
    await page.waitForFunction(() => Boolean(document.querySelector('li.row.open .row-open')))
    assert.equal(await task.locator('.row-open').isVisible(), true)
    assert.equal(await page.locator('#detail-rail').isVisible(), false)
  })
})

test('at 1440x900 a selected item opens in the rail', { timeout: 180_000 }, async () => {
  await browserFixture('one-column-1440-rail', async ({ page, progress, startServer }) => {
    writeProgress(progress, FIXTURE_MD())
    const board = new BoardPage(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await board.open(await startServer())
    await board.question('Retry upload with backoff').waitFor({ state: 'visible' })
    await board.task('Build export worker').waitFor({ state: 'visible' })

    const colWidthBefore = await page.evaluate(() => Math.round(document.querySelector('main.col').getBoundingClientRect().width))
    assert.ok(colWidthBefore <= 760, `expected work column width <= 760px at 1440x900, got ${colWidthBefore}px`)
    assert.equal(await page.locator('#detail-rail').isVisible(), false, 'rail should be hidden before selecting an item')

    const row = board.task('Build export worker')
    await board.openTask('Build export worker')
    await page.locator('#detail-rail').waitFor({ state: 'visible' })

    const railBox = await page.evaluate(() => {
      const rail = document.getElementById('detail-rail')
      const col = document.querySelector('main.col')
      const rect = rail.getBoundingClientRect()
      const colRect = col.getBoundingClientRect()
      const selectedRow = document.querySelector('li.row.selected')
      return {
        railWidth: Math.round(rect.width),
        railLeft: Math.round(rect.left),
        colRight: Math.round(colRect.right),
        railText: rail.textContent,
        rowInlineOpen: selectedRow ? selectedRow.classList.contains('open') : null,
      }
    })

    assert.ok(railBox.railWidth > 0 && railBox.railWidth <= 340, `expected rail width <= 340px, got ${railBox.railWidth}px`)
    assert.ok(railBox.railLeft >= railBox.colRight - 1, `expected rail to sit beside work column: railLeft=${railBox.railLeft}, colRight=${railBox.colRight}`)
    assert.match(railBox.railText, /Build export worker/)
    assert.match(railBox.railText, /Stream rows to temporary file/)
    assert.equal(railBox.rowInlineOpen, false, 'selected item should open in the rail, not inline')
    assert.equal(await row.locator('.row-open').isVisible(), false)

    // Esc closes the rail.
    await page.keyboard.press('Escape')
    await page.locator('#detail-rail').waitFor({ state: 'hidden' })

    // Selecting a waiting question card at 1440x900 also opens it in the rail and Esc closes it.
    await board.question('Retry upload with backoff').locator('.q').click()
    await page.locator('#detail-rail').waitFor({ state: 'visible' })
    const cardRail = await page.evaluate(() => {
      const rail = document.getElementById('detail-rail')
      return { width: Math.round(rail.getBoundingClientRect().width), text: rail.textContent }
    })
    assert.ok(cardRail.width > 0 && cardRail.width <= 340, `expected rail width <= 340px, got ${cardRail.width}px`)
    assert.match(cardRail.text, /Retry upload with backoff/)
    await page.keyboard.press('Escape')
    await page.locator('#detail-rail').waitFor({ state: 'hidden' })
  })
})

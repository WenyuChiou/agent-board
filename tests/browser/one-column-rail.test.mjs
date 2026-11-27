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

## Gamma Project
<!-- auto session=48490003 agent=grok state=ended updated=${updated} resume=11111111-2222-4333-8444-555555555555 dir=%2Ftmp -->
### Verify stopped draft persistence
- [ ] Reconnect grok session
<!-- /auto session=48490003 -->

## Delta Project
<!-- auto session=48490004 agent=codex state=ended updated=${updated} -->
### Audit archived format
- [?] Keep legacy archive format?
<!-- /auto session=48490004 -->
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
    const rowBtn = row.locator('.row-btn')
    await rowBtn.focus()
    await page.keyboard.press('Enter')
    await page.locator('#detail-rail').waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-close', 'opening row detail rail via keyboard should focus close button')

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
    assert.equal(await page.locator('#detail-rail .d-head .surf-pill.surf-cli').count(), 1, 'detail rail head renders CLI .surf-pill')
    assert.equal((await page.locator('#detail-rail .d-head .d-meta').innerText()).includes('Codex'), false, 'detail rail meta omits visible AI vendor name')

    // Esc closes the rail without manually focusing #detail-close and restores focus to the row trigger.
    await page.keyboard.press('Escape')
    await page.locator('#detail-rail').waitFor({ state: 'hidden' })
    assert.equal(await rowBtn.evaluate(node => document.activeElement === node), true, 'closing row rail should restore focus to the row trigger')

    // Expanding Older shows older cards without a details button and clicking one does not open the rail.
    await page.locator('.older-line button.link').click()
    const olderCard = page.locator('#needs .sheet-foot article.card').filter({ hasText: 'Keep legacy archive format?' })
    await olderCard.waitFor({ state: 'visible' })
    assert.equal(await olderCard.locator('.card-detail-btn').count(), 0, 'older cards should not render a details button')
    assert.equal(await olderCard.getAttribute('data-rail-item'), null, 'older cards should not be marked as rail items')
    await olderCard.locator('.q').click()
    assert.equal(await page.locator('#detail-rail').isVisible(), false, 'clicking an older card should not open the detail rail')

    // Card detail trigger is keyboard-accessible and restores focus on close without manual rail focus.
    const cardBtn = board.question('Retry upload with backoff').locator('.card-detail-btn')
    await cardBtn.focus()
    await page.keyboard.press('Enter')
    await page.locator('#detail-rail').waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-close', 'opening card detail rail via keyboard should focus close button')
    const cardRail = await page.evaluate(() => {
      const rail = document.getElementById('detail-rail')
      return { width: Math.round(rail.getBoundingClientRect().width), text: rail.textContent }
    })
    assert.ok(cardRail.width > 0 && cardRail.width <= 340, `expected rail width <= 340px, got ${cardRail.width}px`)
    assert.match(cardRail.text, /Retry upload with backoff/)
    assert.equal(await page.locator('#detail-rail .d-head .surf-pill.surf-cli').count(), 1, 'card detail rail head renders CLI .surf-pill')
    assert.equal((await page.locator('#detail-rail .d-head .d-meta').innerText()).includes('Claude'), false, 'card detail rail meta omits visible AI vendor name')
    await page.keyboard.press('Escape')
    await page.locator('#detail-rail').waitFor({ state: 'hidden' })
    assert.equal(await cardBtn.evaluate(node => document.activeElement === node), true, 'closing rail should restore focus to the card detail button')

    // Shrinking from 1440px to 1300px moves the selected task inline and preserves draft, focus, and caret.
    await page.locator('.shelf-head').filter({ hasText: 'Stopped' }).click()
    await board.openTask('Verify stopped draft persistence')
    await page.locator('#detail-rail textarea[data-key]').waitFor({ state: 'visible' })
    await page.locator('#detail-rail textarea[data-key]').fill('draft keep caret')
    await page.evaluate(() => {
      const box = document.querySelector('#detail-rail textarea[data-key]')
      box.focus()
      box.setSelectionRange(5, 5)
    })
    await page.setViewportSize({ width: 1300, height: 900 })
    await page.locator('#detail-rail').waitFor({ state: 'hidden' })
    const inlineRow = board.task('Verify stopped draft persistence')
    await inlineRow.locator('.row-open textarea[data-key]').waitFor({ state: 'visible' })
    const preserved = await page.evaluate(() => {
      const box = document.querySelector('li.row.open .row-open textarea[data-key]')
      return {
        value: box?.value,
        isFocused: document.activeElement === box,
        start: box?.selectionStart,
        end: box?.selectionEnd,
      }
    })
    assert.deepEqual(preserved, { value: 'draft keep caret', isFocused: true, start: 5, end: 5 })
  })
})

test('at 1440x900 sending a message from the detail rail clears its draft across redraws', { timeout: 180_000 }, async () => {
  await browserFixture('one-column-1440-rail-clear-draft', async ({ page, progress, startServer }) => {
    const md = FIXTURE_MD()
    writeProgress(progress, md)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.route('**/api/board', async route => {
      let response
      try { response = await route.fetch({ maxRetries: 0 }) } catch (error) {
        if (/disposed|closed|aborted/i.test(String(error?.message ?? error))) return
        throw error
      }
      if (response.status() === 304) { await route.fulfill({ response }).catch(() => undefined); return }
      const body = await response.json()
      for (const row of [...(body.model?.stopped ?? []), ...(body.model?.idle ?? []), ...(body.model?.groups ?? []).flatMap(group => group.rows)]) {
        if (row.title === 'Verify stopped draft persistence') row.send = 'send'
      }
      await route.fulfill({ response, json: body }).catch(() => undefined)
    })
    const sends = []
    await page.route('**/api/act', async route => {
      const payload = route.request().postDataJSON()
      if (payload.type !== 'send') { await route.continue(); return }
      sends.push(payload.text)
      await route.fulfill({ json: { ok: true, note: 'Synthetic send accepted.' } })
    })
    const board = new BoardPage(page)
    await board.open(await startServer())
    await page.locator('.shelf-head').filter({ hasText: 'Stopped' }).click()
    await board.openTask('Verify stopped draft persistence')
    const box = page.locator('#detail-rail textarea[data-key]')
    await box.waitFor({ state: 'visible' })
    await box.fill('Rail message once')
    await page.locator('#detail-rail button.primary').click()
    await page.waitForFunction(() => document.querySelector('#detail-rail textarea[data-key]')?.value === '')
    assert.deepEqual(sends, ['Rail message once'])
    const redraw = page.waitForResponse(async res => {
      if (new URL(res.url()).pathname !== '/api/board' || res.status() !== 200) return false
      const body = await res.json().catch(() => null)
      return JSON.stringify(body?.model ?? {}).includes('Parse updated CSV schema')
    })
    writeProgress(progress, md.replace('Parse CSV schema', 'Parse updated CSV schema'))
    await redraw
    await page.waitForFunction(() => document.body.textContent.includes('Build export worker'))
    assert.equal(await box.inputValue(), '')
  })
})

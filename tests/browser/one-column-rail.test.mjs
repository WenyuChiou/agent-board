import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

## Epsilon Project
### Hand-kept checklist
- [?] Confirm manual checklist?
- [ ] Verify release notes
- [ ] Check tag signature
- [ ] Repeat check
- [ ] Repeat check

## Zeta Project
<!-- auto session=48490005 agent=codex state=blocked updated=${updated} -->
### Blocked token sync
- [!] Waiting on upstream token
- [ ] Retry token sync
<!-- /auto session=48490005 -->
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
    await rowBtn.press('Enter')
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
    await cardBtn.press('Enter')
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
    assert.ok(await page.locator('#detail-rail .steps').count() >= 1, 'card detail rail renders card steps')
    const writeOwnInRail = page.locator('#detail-rail').getByRole('button', { name: 'Write your own' })
    await writeOwnInRail.focus()
    const beforeRedrawFocus = await writeOwnInRail.evaluate(node => document.activeElement === node)
    assert.equal(beforeRedrawFocus, true)
    // Advancing progress triggers a live redraw without dropping focus from the focused rail action button, and board triggers keep focus on poll redraw even while the rail is open.
    const movedMd = FIXTURE_MD().replace('- [~] Stream rows to temporary file', '- [~] Stream rows & ping')
    writeProgress(progress, movedMd)
    await page.locator('.r-step').filter({ hasText: 'Stream rows & ping' }).first().waitFor({ state: 'visible', timeout: 15_000 })
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Write your own', 'live redraw preserves focus on the active rail button')
    for (const [label, triggerLoc, updatedLine] of [
      ['row-btn', rowBtn, '- [~] Stream rows & ping row'],
      ['card-detail-btn', cardBtn, '- [~] Stream rows & ping card'],
      ['q-toggle', board.question('Retry upload with backoff').locator('.q-toggle'), '- [~] Stream rows & ping q'],
    ]) {
      await triggerLoc.focus()
      writeProgress(progress, FIXTURE_MD().replace('- [~] Stream rows to temporary file', updatedLine))
      await page.locator('.r-step').filter({ hasText: updatedLine.replace('- [~] ', '') }).first().waitFor({ state: 'visible', timeout: 15_000 })
      assert.equal(await triggerLoc.evaluate(node => document.activeElement === node), true, `board ${label} keeps focus across poll while rail is open`)
    }
    await page.locator('#detail-close').focus()
    await page.keyboard.press('Escape')
    await page.locator('#detail-rail').waitFor({ state: 'hidden' })
    assert.equal(await cardBtn.evaluate(node => document.activeElement === node), true, 'closing rail should restore focus to the card detail button')

    // Manual waiting card ticks real serveAction via its owning row key/tickFp, preserves duplicate-name step focus via data-step-line, falls back to #detail-close when blank line shifts duplicate steps or an action disappears.
    const manualCard = board.question('Confirm manual checklist?')
    await manualCard.locator('.card-detail-btn').click()
    await page.locator('#detail-rail').waitFor({ state: 'visible' })
    const manualBtns = page.locator('#detail-rail .steps li button')
    assert.equal(await manualBtns.count(), 4, 'manual card rail renders per-step Done controls')
    const secondRepeatLine = await manualBtns.nth(3).getAttribute('data-step-line')
    await manualBtns.nth(3).focus()
    writeProgress(progress, FIXTURE_MD().replace('- [~] Stream rows to temporary file', '- [~] Stream rows & ping 2'))
    await page.locator('.r-step').filter({ hasText: 'Stream rows & ping 2' }).first().waitFor({ state: 'visible', timeout: 15_000 })
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-step-line')), secondRepeatLine, 'live redraw preserves focus on matching duplicate step by data-step-line')
    // Inserting a blank line above both duplicate "Repeat check" steps shifts line numbers ambiguously: focus falls back to #detail-close rather than shifting onto the first occurrence.
    writeProgress(progress, FIXTURE_MD().replace('- [ ] Repeat check\n- [ ] Repeat check', '\n- [ ] Repeat check\n- [ ] Repeat check'))
    await page.waitForFunction((oldLine) => {
      const btns = document.querySelectorAll('#detail-rail .steps li button')
      return btns.length === 4 && btns[2].getAttribute('data-step-line') === oldLine && document.activeElement?.id === 'detail-close'
    }, secondRepeatLine, { timeout: 15_000 })
    await manualBtns.nth(1).focus()
    await manualBtns.nth(1).click()
    const tickDeadline = Date.now() + 10_000
    while (Date.now() < tickDeadline && !readFileSync(progress, 'utf8').includes('- [x] Check tag signature')) {
      await page.waitForTimeout(50)
    }
    const afterTick = readFileSync(progress, 'utf8')
    assert.ok(afterTick.includes('- [x] Check tag signature'), 'clicking second manual Done button marks step done on disk via real serveAction')
    assert.ok(afterTick.includes('- [ ] Verify release notes'), 'first manual step remains untouched')
    await page.waitForFunction(() => document.querySelectorAll('#detail-rail .steps li button').length === 3, undefined, { timeout: 10_000 })
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-close', 'when focused rail action disappears after tick redraw, focus falls back to #detail-close')
    await page.keyboard.press('Escape')
    await page.locator('#detail-rail').waitFor({ state: 'hidden' })

    const blockedCard = board.question('Waiting on upstream token')
    await blockedCard.locator('.card-detail-btn').click()
    await page.locator('#detail-rail').waitFor({ state: 'visible' })
    assert.match(await page.locator('#detail-rail .steps').innerText(), /Retry token sync/, 'blocked card detail rail renders follow-up step list')
    await page.keyboard.press('Escape')
    await page.locator('#detail-rail').waitFor({ state: 'hidden' })

    // Pressing the card question toggle at 1440px opens an interactive #detail-rail (suppressing inline fold) and keeps reply draft across resize to 1300px.
    const askCard = board.question('Retry upload with backoff')
    const qToggle = askCard.locator('.q-toggle')
    await qToggle.click()
    await page.locator('#detail-rail').waitFor({ state: 'visible' })
    assert.equal(await askCard.evaluate(node => node.classList.contains('open')), false, 'card stays collapsed inline while open in detail rail')
    await page.locator('#detail-rail').getByRole('button', { name: 'Write your own' }).click()
    const cardDraftBox = page.locator('#detail-rail textarea[data-key]')
    await cardDraftBox.waitFor({ state: 'visible' })
    await cardDraftBox.fill('Card rail draft')
    await page.evaluate(() => {
      const box = document.querySelector('#detail-rail textarea[data-key]')
      box.focus()
      box.setSelectionRange(4, 4)
    })
    await page.setViewportSize({ width: 1300, height: 900 })
    await page.locator('#detail-rail').waitFor({ state: 'hidden' })
    await askCard.locator('.card-fold .composer textarea[data-key]').waitFor({ state: 'visible' })
    const preservedCard = await page.evaluate(() => {
      const box = document.querySelector('article.card.open .composer textarea[data-key]')
      return {
        value: box?.value,
        isFocused: document.activeElement === box,
        start: box?.selectionStart,
        end: box?.selectionEnd,
      }
    })
    assert.deepEqual(preservedCard, { value: 'Card rail draft', isFocused: true, start: 4, end: 4 })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('#detail-rail').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.locator('#detail-rail').waitFor({ state: 'hidden' })
    assert.equal(await askCard.evaluate(node => node.classList.contains('open')), false, 'closing card rail after resize removes open class')
    assert.equal(await askCard.locator('.card-fold').evaluate(node => node.inert === true), true, 'closing card rail after resize marks inline fold inert')
    assert.equal(await askCard.locator('.card-fold > .fold-in').isVisible(), false, 'closing card rail after resize collapses inline fold height to zero')
    // Narrowing back to 1300px + live redraw after closing rail keeps card collapsed inline (write mode was reset to ask while keeping draft).
    await page.setViewportSize({ width: 1300, height: 900 })
    writeProgress(progress, FIXTURE_MD().replace('- [~] Stream rows to temporary file', '- [~] Stream rows & ping 3'))
    await page.locator('.r-step').filter({ hasText: 'Stream rows & ping 3' }).first().waitFor({ state: 'visible', timeout: 15_000 })
    assert.equal(await askCard.evaluate(node => node.classList.contains('open')), false, 'narrow live redraw after rail close keeps card collapsed')
    assert.equal(await askCard.locator('.card-fold > .fold-in').isVisible(), false, 'narrow live redraw after rail close keeps composer hidden')
    await page.setViewportSize({ width: 1440, height: 900 })
    // Entering write mode in card rail, switching selection to a Working row, closing rail, and narrowing keeps the original card collapsed while preserving its draft.
    await qToggle.click()
    await page.locator('#detail-rail').waitFor({ state: 'visible' })
    await page.locator('#detail-rail').getByRole('button', { name: 'Write your own' }).click()
    await page.locator('#detail-rail textarea[data-key]').fill('Switched rail draft')
    await rowBtn.click()
    await page.waitForFunction(() => {
      const text = document.getElementById('detail-rail')?.textContent || ''
      return !text.includes('Retry upload with backoff') && text.includes('Build export worker')
    })
    await page.keyboard.press('Escape')
    await page.locator('#detail-rail').waitFor({ state: 'hidden' })
    await page.setViewportSize({ width: 1300, height: 900 })
    writeProgress(progress, FIXTURE_MD().replace('- [~] Stream rows to temporary file', '- [~] Stream rows & ping 4'))
    await page.locator('.r-step').filter({ hasText: 'Stream rows & ping 4' }).first().waitFor({ state: 'visible', timeout: 15_000 })
    assert.equal(await askCard.evaluate(node => node.classList.contains('open')), false, 'switching rail away from write card then closing keeps card collapsed after narrow redraw')
    assert.equal(await askCard.locator('.card-fold > .fold-in').isVisible(), false, 'switching rail away from write card hides inline composer after narrow redraw')
    await askCard.locator('.q-toggle').click()
    await askCard.getByRole('button', { name: 'Write your own' }).click()
    assert.equal(await askCard.locator('.composer textarea[data-key]').inputValue(), 'Switched rail draft', 'switching rail away from write card still preserves typed draft')
    await askCard.getByRole('button', { name: 'Cancel' }).click()
    await askCard.locator('.q-toggle').click()
    await page.setViewportSize({ width: 1440, height: 900 })

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

test('at >640px with coarse pointer the top card checkbox keeps a 44px unclipped hit target', { timeout: 180_000 }, async () => {
  await browserFixture('coarse-chk-target', async ({ page, progress, startServer }) => {
    writeProgress(progress, '## Solo\n### Top manual\n- [?] First top check?\n')
    await page.setViewportSize({ width: 800, height: 900 })
    const board = new BoardPage(page)
    await board.open(await startServer())
    const topChk = page.locator('article.card').first().locator('button.chk')
    await topChk.waitFor({ state: 'visible' })
    const hitEdges = await topChk.evaluate(chk => {
      const r = chk.getBoundingClientRect()
      const cx = Math.round(r.left + r.width / 2)
      const cy = Math.round(r.top + r.height / 2)
      const cardStyle = getComputedStyle(chk.closest('article.card'))
      return {
        padTop: parseFloat(cardStyle.paddingTop),
        topHit: document.elementFromPoint(cx, cy - 20)?.closest('button.chk') === chk,
        bottomHit: document.elementFromPoint(cx, cy + 20)?.closest('button.chk') === chk,
      }
    })
    assert.ok(hitEdges.padTop >= 12, `expected coarse top padding >= 12px, got ${hitEdges.padTop}`)
    assert.equal(hitEdges.topHit, true, 'coarse-pointer checkbox outer top edge (-20px from center) is unclipped and hittable')
    assert.equal(hitEdges.bottomHit, true, 'coarse-pointer checkbox outer bottom edge (+20px from center) is hittable')
  }, { hasTouch: true })
})

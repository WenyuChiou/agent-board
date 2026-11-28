import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { boardClient } from '../../scripts/message-client.mjs'
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

    // On a phone, .ag, .surf-wrap, and .badge inside .chip never overlap.
    const chipOverlaps = await page.locator('nav#agents .chip').evaluateAll(chips => chips.flatMap(chip => {
      const ag = chip.querySelector('.ag')?.getBoundingClientRect()
      const surf = chip.querySelector('.surf-wrap')?.getBoundingClientRect()
      const badge = chip.querySelector('.badge')?.getBoundingClientRect()
      const problems = []
      if (ag && surf && surf.width > 0 && ag.right > surf.left + 0.5) problems.push(`${chip.dataset.agent}: ag overlaps surf`)
      if (surf && surf.width > 0 && badge && surf.right > badge.left + 0.5) problems.push(`${chip.dataset.agent}: surf overlaps badge`)
      if (ag && badge && ag.right > badge.left + 0.5) problems.push(`${chip.dataset.agent}: ag overlaps badge`)
      return problems
    }))
    assert.deepEqual(chipOverlaps, [])

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

    // Picking a view from the phone drawer closes the drawer and hides the other sections.
    await page.evaluate(() => scrollTo(0, 0))
    await page.locator('#drawer-btn').click()
    await page.locator('#view-done').waitFor({ state: 'visible' })
    await page.locator('#view-done').click()
    await page.locator('#drawer-btn[aria-expanded="false"]').waitFor({ state: 'attached' })
    await page.locator('[data-sec="needs"]').waitFor({ state: 'hidden' })
    await page.locator('#drawer-btn').click()
    await page.locator('#view-all').click()
    await page.locator('[data-sec="needs"]').waitFor({ state: 'visible' })
  })
})

test('an agent active on both CLI and App exposes CLI · App in aria-label and paints non-overlapping badges on desktop and phone', { timeout: 180_000 }, async () => {
  await browserFixture('page-multi-surface', async ({ page, progress, root, startServer }) => {
    const cliSession = '88888888-8888-4888-8888-888888888881'
    const appSession = '88888888-8888-4888-8888-888888888882'
    const cliOwner = createHash('sha256').update('codex:' + cliSession).digest('hex')
    const appOwner = createHash('sha256').update('codex:' + appSession).digest('hex')
    const dir = root.replaceAll('\\', '/')
    writeProgress(progress, [
      '## Synthetic CLI project',
      `<!-- auto session=${cliOwner.slice(0, 8)} agent=codex owner=${cliOwner} state=waiting updated=${new Date().toISOString()} resume=${cliSession} dir=${dir} -->`,
      '### Synthetic CLI branch',
      '- [?] Ship CLI patch?',
      `<!-- /auto session=${cliOwner.slice(0, 8)} -->`,
      '',
      '## Synthetic App project',
      `<!-- auto session=${appOwner.slice(0, 8)} agent=codex owner=${appOwner} state=working updated=${new Date().toISOString()} resume=${appSession} dir=${dir} -->`,
      '### Synthetic App build',
      '- [~] Running desktop check',
      `<!-- /auto session=${appOwner.slice(0, 8)} -->`,
      '',
      '## Synthetic Done project',
      `<!-- auto session=dd440011 agent=claude state=done updated=${new Date(Date.now() - 2 * 60_000).toISOString()} -->`,
      '### Freshly finished AI run',
      '- [x] Verified deploy',
      '<!-- /auto session=dd440011 -->',
      '',
    ].join('\n'))
    const url = await startServer({ messages: true })
    const attach = (session, surface, turn) => boardClient(url).attach({
      agent: 'codex', session, turn, surface,
      verify: async () => true, canReceive: () => true,
      deliver: async msg => 'ACK ' + (msg.nonce || msg.id),
      onError: () => {},
    })
    const cliRecv = await attach(cliSession, 'Codex CLI', 'cli-turn')
    const appRecv = await attach(appSession, 'Codex desktop app', 'app-turn')
    try {
      const board = new BoardPage(page)
      const checkRow = async selector => page.locator(selector).evaluate(node => {
        const label = node.getAttribute('aria-label') || ''
        const pills = [...node.querySelectorAll('.surf-pill')].map(p => ({
          cls: p.className,
          txt: (p.textContent || '').trim(),
          box: p.getBoundingClientRect(),
        }))
        const ag = node.querySelector('.ag')?.getBoundingClientRect()
        const badge = node.querySelector('.badge')?.getBoundingClientRect()
        const boxes = [ag, ...pills.map(p => p.box), badge].filter(Boolean)
        const overlaps = []
        for (let i = 0; i + 1 < boxes.length; i += 1) {
          if (boxes[i].right > boxes[i + 1].left + 0.5) overlaps.push(`${i}:${boxes[i].right}>${boxes[i + 1].left}`)
        }
        return { label, pills: pills.map(p => ({ cls: p.cls, txt: p.txt })), overlaps }
      })

      await page.setViewportSize({ width: 1440, height: 900 })
      await board.open(url)
      await page.waitForFunction(() => {
        const side = document.querySelector('#side-agents [data-agent="codex"]')
        return side && side.querySelector('.surf-cli') && side.querySelector('.surf-app')
      })
      const side = await checkRow('#side-agents [data-agent="codex"]')
      assert.ok(side.label.includes('Codex · CLI · App'), side.label)
      assert.deepEqual(side.overlaps, [])
      assert.ok(side.pills.some(p => p.cls.includes('surf-cli') && p.txt === 'CLI'))
      assert.ok(side.pills.some(p => p.cls.includes('surf-app') && p.txt === 'App'))

      await page.setViewportSize({ width: 375, height: 700 })
      await page.locator('nav#agents [data-agent="codex"]').waitFor({ state: 'visible' })
      const chip = await checkRow('nav#agents [data-agent="codex"]')
      assert.ok(chip.label.includes('Codex · CLI · App'), chip.label)
      assert.deepEqual(chip.overlaps, [])
      assert.ok(chip.pills.some(p => p.cls.includes('surf-cli') && p.cls.includes('surf-icon')))
      assert.ok(chip.pills.some(p => p.cls.includes('surf-app') && p.cls.includes('surf-icon')))
      const overflow = await page.evaluate(pastTheEdge)
      assert.equal(overflow.page <= 0, true, JSON.stringify(overflow))
      assert.deepEqual(overflow.out, [])

      // Right-1/4 cockpit widths (480px and 560px): idle filter bar and bulk archive collapse on narrow HUD and toggle open cleanly.
      await page.setViewportSize({ width: 480, height: 900 })
      await page.locator('#hud-filter-btn').waitFor({ state: 'visible' })
      assert.equal(await page.locator('#filter-bar').isVisible(), false, '480px HUD hides idle #filter-bar')
      assert.equal(await page.locator('#tidy-bulk').isVisible(), false, '480px HUD hides #tidy-bulk in Overview')
      await page.locator('[data-sec="done"] .shelf').waitFor({ state: 'visible' })
      assert.equal(await page.locator('[data-sec="done"] .shelf.open').count(), 0, '480px HUD keeps Done collapsed on initial load to preserve Working rows')
      await page.locator('[data-sec="done"] .shelf-head').click()
      await page.locator('[data-sec="done"] .shelf.open').waitFor({ state: 'visible' })
      await page.locator('#hud-filter-btn').click()
      await page.locator('#filter-bar').waitFor({ state: 'visible' })
      const hud480 = await page.evaluate(pastTheEdge)
      assert.equal(hud480.page <= 0, true, JSON.stringify(hud480))
      assert.deepEqual(hud480.out, [])
      await page.locator('#hud-filter-btn').click()
      await page.locator('#filter-bar').waitFor({ state: 'hidden' })
      // Unchecking the last filter while an AI dropdown is open, then pressing Escape, returns focus to #hud-filter-btn.
      await page.locator('nav#agents [data-agent="codex"]').click()
      await page.locator('#filter-bar').waitFor({ state: 'visible' })
      await page.locator('#filter-bar [data-filter-kind="agent"] button.f-chip').click()
      await page.locator('#filter-bar [data-filter-kind="agent"] .f-menu').getByRole('menuitemcheckbox', { name: /Codex/ }).click()
      await page.keyboard.press('Escape')
      await page.locator('#filter-bar').waitFor({ state: 'hidden' })
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'hud-filter-btn', 'Escape returns focus to #hud-filter-btn when idle filter bar collapses')

      await page.setViewportSize({ width: 560, height: 900 })
      await page.locator('#side').waitFor({ state: 'visible' })
      assert.equal(await page.locator('#tidy-bulk').isVisible(), false, '560px HUD hides #tidy-bulk in Overview')
      const hud560 = await page.evaluate(pastTheEdge)
      assert.equal(hud560.page <= 0, true, JSON.stringify(hud560))
      assert.deepEqual(hud560.out, [])
    } finally {
      await Promise.all([cliRecv.close(), appRecv.close()])
    }
  })
})

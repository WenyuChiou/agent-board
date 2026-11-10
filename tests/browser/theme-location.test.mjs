import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { BoardPage } from './board-page.mjs'
import { browserFixture, writeProgress } from './fixture.mjs'

const readmeLocations = [
  ['README.md', ['next to **Close the board**', 'bottom of the expanded sidebar', 'below the tasks on a narrow screen or when the sidebar is collapsed']],
  ['README.zh-TW.md', ['**關閉看板**旁邊', '展開的側欄底部', '窄螢幕或側欄收起時，則在工作清單下方']],
  ['README.zh-CN.md', ['**关闭看板**旁边', '展开的侧栏底部', '窄屏幕或侧栏收起时，则在任务列表下方']],
]

test('at 375 px Settings is beside Close the board, traps focus, and fits every language without sideways scrolling', { timeout: 60_000 }, async () => {
  for (const [file, locations] of readmeLocations) {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    for (const location of locations) assert.ok(text.includes(location), `${file}: missing theme location ${location}`)
  }

  await browserFixture('theme-location', async ({ page, progress, startServer, evidence }) => {
    writeProgress(progress, '## Synthetic project\n### Synthetic task\n- [ ] Check Settings\n')
    const board = new BoardPage(page)
    await page.setViewportSize({ width: 375, height: 700 })
    await board.open(await startServer({ language: null }))
    const footer = page.locator('main > #pfoot')
    const toggle = footer.locator('[data-settings-toggle]')
    assert.equal(await toggle.count(), 1)
    assert.equal(await footer.getByRole('button', { name: 'Close the board', exact: true }).count(), 1)
    const belowTasks = await footer.evaluate(element => element.getBoundingClientRect().top >= document.getElementById('board').getBoundingClientRect().bottom)
    assert.equal(belowTasks, true, 'the phone footer follows the tasks')
    await toggle.scrollIntoViewIfNeeded()
    assert.equal(await toggle.isVisible(), true)
    assert.equal((await toggle.boundingBox()).height >= 48, true)
    assert.equal(await page.locator('[data-theme-toggle]').count(), 0)
    await toggle.click()
    const panel = page.getByRole('dialog', { name: 'Settings', exact: true })
    await panel.waitFor({ state: 'visible' })
    // The agent rows arrive a moment after the panel opens. Check the trap once they are in it, so
    // the last control is the last row's button and not one the list then grows past.
    await page.waitForFunction(() => document.querySelector('#settings-agent-list li') !== null || document.getElementById('settings-result').textContent !== '')
    await page.getByRole('button', { name: 'Close settings', exact: true }).focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await panel.evaluate(element => element.contains(document.activeElement)), true)
    await page.keyboard.press('Tab')
    assert.equal(await page.getByRole('button', { name: 'Close settings', exact: true }).evaluate(element => element === document.activeElement), true)
    await page.keyboard.press('Escape')
    assert.equal(await toggle.evaluate(element => element === document.activeElement), true)
    for (const theme of ['dark', 'light']) {
      await board.chooseTheme(theme)
      assert.equal(await toggle.getAttribute('data-now'), theme)
    }

    for (const [lang, name] of [['zh-TW', '設定'], ['zh-CN', '设置'], ['en', 'Settings']]) {
      await toggle.click()
      await page.locator('#settings-lang').selectOption(lang)
      await page.getByRole('dialog', { name, exact: true }).waitFor({ state: 'visible' })
      await page.getByRole('heading', { name, exact: true }).waitFor({ state: 'visible' })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      assert.equal(await page.locator('#settings').evaluate(element => element.scrollWidth <= element.clientWidth), true)
      // Only controls on screen count: the agent confirm's Yes and Cancel stay hidden until a row's
      // button is pressed, and a hidden control has no box to measure.
      const shortTargets = await page.locator('#settings button, #settings select').evaluateAll(elements => elements.filter(element => element.getClientRects().length > 0 && element.getBoundingClientRect().height < 48).map(element => element.id || element.getAttribute('aria-label') || element.textContent.trim()))
      assert.deepEqual(shortTargets, [])
      await page.screenshot({ path: join(evidence, `settings-${lang}-375.png`), fullPage: true })
      await page.keyboard.press('Escape')
    }

    await page.setViewportSize({ width: 960, height: 700 })
    await page.locator('#side-foot > #pfoot [data-settings-toggle]').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await toggle.waitFor({ state: 'visible' })
    assert.equal(await footer.count(), 1, 'collapsing the sidebar returns its footer below the tasks')
  }, { hasTouch: true })
})

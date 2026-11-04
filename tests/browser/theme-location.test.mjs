import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BoardPage } from './board-page.mjs'
import { browserFixture, writeProgress } from './fixture.mjs'

const readmeLocations = [
  ['README.md', ['next to **Close the board**', 'bottom of the expanded sidebar', 'below the tasks on a narrow screen or when the sidebar is collapsed', 'In `progress.html`, it is at the top right.']],
  ['README.zh-TW.md', ['**關閉看板**旁邊', '展開的側欄底部', '窄螢幕或側欄收起時，則在工作清單下方', '`progress.html` 的開關在右上角。']],
  ['README.zh-CN.md', ['**关闭看板**旁边', '展开的侧栏底部', '窄屏幕或侧栏收起时，则在任务列表下方', '`progress.html` 的开关在右上角。']],
]

test('at 375 px the theme switch is beside Close the board where the README says', { timeout: 60_000 }, async () => {
  for (const [file, locations] of readmeLocations) {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    for (const location of locations) assert.ok(text.includes(location), `${file}: missing theme location ${location}`)
  }

  await browserFixture('theme-location', async ({ page, progress, startServer }) => {
    writeProgress(progress, '## Synthetic project\n### Synthetic task\n- [ ] Check the theme switch\n')
    const board = new BoardPage(page)
    await page.setViewportSize({ width: 375, height: 700 })
    await board.open(await startServer())
    const footer = page.locator('main > #pfoot')
    const toggle = footer.locator('[data-theme-toggle]')
    assert.equal(await toggle.count(), 1)
    assert.equal(await footer.getByRole('button', { name: 'Close the board', exact: true }).count(), 1)
    const belowTasks = await footer.evaluate(element => element.getBoundingClientRect().top >= document.getElementById('board').getBoundingClientRect().bottom)
    assert.equal(belowTasks, true, 'the phone footer follows the tasks')
    await toggle.scrollIntoViewIfNeeded()
    assert.equal(await toggle.isVisible(), true)
    for (const theme of ['dark', 'light']) {
      await board.chooseTheme(theme)
      assert.equal(await toggle.getAttribute('data-now'), theme)
    }

    await page.setViewportSize({ width: 960, height: 700 })
    await page.locator('#side-foot > #pfoot [data-theme-toggle]').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await toggle.waitFor({ state: 'visible' })
    assert.equal(await footer.count(), 1, 'collapsing the sidebar returns its footer below the tasks')
  })
})

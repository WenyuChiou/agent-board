import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoardPage } from './board-page.mjs'
import { browserFixture, writeProgress } from './fixture.mjs'

const block = (session, agent, state, project, title, steps) => `## ${project}
<!-- auto session=${session} agent=${agent} state=${state} updated=${new Date().toISOString()} -->
### ${title}
${steps.join('\n')}
<!-- /auto session=${session} -->`

const cardHidden = async (page, questionText) => page.waitForFunction(text => {
  const li = [...document.querySelectorAll('#needs ul.cards > li')].find(one => one.textContent.includes(text))
  const fx = li?.firstElementChild
  return !!fx && fx.classList.contains('gone') && fx.inert === true
}, questionText)

const cardShown = async (page, questionText) => page.waitForFunction(text => {
  const li = [...document.querySelectorAll('#needs ul.cards > li')].find(one => one.textContent.includes(text))
  const fx = li?.firstElementChild
  return !!fx && !fx.classList.contains('gone') && fx.inert !== true
}, questionText)

test('one word finds a card by project name', { concurrency: false, timeout: 120_000 }, async () => {
  await browserFixture('search-by-project', async ({ page, progress, startServer }) => {
    writeProgress(progress, [
      block('s1848001', 'codex', 'waiting', 'weather-model', 'Forecast calibration', ['- [x] Download station normals', '- [?] Use ECMWF or GFS grid?']),
      block('s1848002', 'claude', 'waiting', 'billing-api', 'Invoice tax audit', ['- [x] Verify VAT rounding rules', '- [?] Round totals per line or invoice?']),
      block('s1848003', 'gemini', 'working', 'search-index', 'Rebuild stemming cache', ['- [~] Tokenize UTF-8 phrases']),
    ].join('\n\n'))
    await page.setViewportSize({ width: 1280, height: 800 })
    const board = new BoardPage(page)
    await board.open(await startServer())
    await board.question('Use ECMWF or GFS grid?').waitFor({ state: 'visible' })
    await board.question('Round totals per line or invoice?').waitFor({ state: 'visible' })

    const search = page.locator('#side-search')
    await search.waitFor({ state: 'visible' })
    await page.keyboard.press('/')
    assert.equal(await search.evaluate(node => document.activeElement === node), true, '/ focuses the sidebar search box')

    await search.fill('weather')
    await cardShown(page, 'Use ECMWF or GFS grid?')
    await cardHidden(page, 'Round totals per line or invoice?')
    await page.locator('#filter-clear').waitFor({ state: 'visible' })

    await search.fill('UTF-8 phrases')
    await cardHidden(page, 'Use ECMWF or GFS grid?')
    await cardHidden(page, 'Round totals per line or invoice?')
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll('li.row')].find(one => one.textContent.includes('Rebuild stemming cache'))
      const fx = row?.firstElementChild
      return !!fx && !fx.classList.contains('gone') && fx.inert !== true
    })

    await search.fill('Invoice tax audit')
    await cardShown(page, 'Round totals per line or invoice?')
    await cardHidden(page, 'Use ECMWF or GFS grid?')

    await search.press('Escape')
    assert.equal(await search.inputValue(), '', 'Esc clears the search query')
    await cardShown(page, 'Use ECMWF or GFS grid?')
    await cardShown(page, 'Round totals per line or invoice?')
  })
})

test("the AI chip set to Codex hides the other AIs' cards", { concurrency: false, timeout: 120_000 }, async () => {
  await browserFixture('ai-chip-filter', async ({ page, progress, startServer }) => {
    writeProgress(progress, [
      block('s1848011', 'codex', 'waiting', 'alpha-cli', 'Ship Codex build', ['- [?] Deploy Codex artifacts?']),
      block('s1848012', 'claude', 'waiting', 'beta-repo', 'Check Claude PR', ['- [?] Approve Claude diff?']),
      block('s1848013', 'antigravity', 'waiting', 'gamma-app', 'Review Antigravity run', ['- [?] Merge Antigravity fix?']),
    ].join('\n\n'))
    await page.setViewportSize({ width: 1280, height: 800 })
    const board = new BoardPage(page)
    await board.open(await startServer())
    for (const q of ['Deploy Codex artifacts?', 'Approve Claude diff?', 'Merge Antigravity fix?']) {
      await board.question(q).waitFor({ state: 'visible' })
    }

    const aiChip = page.locator('#filter-bar [data-filter-kind="agent"] button.f-chip')
    await aiChip.click()
    const aiMenu = page.locator('#filter-bar [data-filter-kind="agent"] .f-menu')
    await aiMenu.waitFor({ state: 'visible' })
    const codexOpt = aiMenu.getByRole('menuitemcheckbox', { name: /Codex/ })
    await codexOpt.click()

    await cardShown(page, 'Deploy Codex artifacts?')
    await cardHidden(page, 'Approve Claude diff?')
    await cardHidden(page, 'Merge Antigravity fix?')
    assert.equal(await page.locator('#side-agents [data-agent="codex"]').getAttribute('aria-pressed'), 'true')
    await page.locator('#filter-clear').waitFor({ state: 'visible' })

    await aiMenu.getByRole('menuitemcheckbox', { name: /Claude/ }).click()
    await cardShown(page, 'Deploy Codex artifacts?')
    await cardShown(page, 'Approve Claude diff?')
    await cardHidden(page, 'Merge Antigravity fix?')

    const interfaceChip = page.locator('#filter-bar [data-filter-kind="interface"] button.f-chip')
    await interfaceChip.click()
    const ifaceMenu = page.locator('#filter-bar [data-filter-kind="interface"] .f-menu')
    await ifaceMenu.waitFor({ state: 'visible' })
    await ifaceMenu.getByRole('menuitemcheckbox', { name: /CLI/ }).waitFor()
    await ifaceMenu.getByRole('menuitemcheckbox', { name: /App/ }).waitFor()

    await page.locator('#filter-clear').click()
    await cardShown(page, 'Deploy Codex artifacts?')
    await cardShown(page, 'Approve Claude diff?')
    await cardShown(page, 'Merge Antigravity fix?')
    await page.locator('#filter-clear').waitFor({ state: 'hidden' })
  })
})

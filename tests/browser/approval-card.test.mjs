import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoardPage } from './board-page.mjs'
import { browserFixture, writeProgress } from './fixture.mjs'

const askBoard = async url => {
  const address = new URL(url)
  const answer = await fetch(new URL('/api/approvals/ask', address.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board-token': address.searchParams.get('t') },
    body: JSON.stringify({ agent: 'claude', session: 'synthetic-session', turn: 'synthetic-turn', tool: 'Bash', input: { command: 'npm run synthetic-approval-layout' }, isSubagent: false, mode: 'default', isCut: false }),
  })
  assert.equal(answer.status, 200)
  await answer.body?.cancel()
}

// The room inside the card's padding, and how much of it the card's text has.
const widths = () => {
  const card = document.querySelector('.approvals .card')
  const style = getComputedStyle(card)
  return {
    room: card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    body: card.querySelector('.c-body').getBoundingClientRect().width,
    command: card.querySelector('.approval-command').getBoundingClientRect().width,
  }
}

test('an approval card gives its command and buttons the full width of the card (#1700)', { timeout: 180_000 }, async () => {
  await browserFixture('approval-card', async ({ page, progress, startServer }) => {
    writeProgress(progress, '# Progress\n')
    const url = await startServer()
    const board = new BoardPage(page)
    await board.open(url)
    await askBoard(url)
    await page.locator('.approvals .approval-command').waitFor({ state: 'visible' })

    for (const width of [1440, 1024, 800, 375, 320]) {
      await page.setViewportSize({ width, height: 800 })
      const found = await page.evaluate(widths)
      assert.ok(found.room > 200, `${width}px: ${JSON.stringify(found)}`)
      assert.ok(Math.abs(found.body - found.room) <= 1, `${width}px: the card's text is narrower than the card: ${JSON.stringify(found)}`)
      assert.ok(Math.abs(found.command - found.room) <= 1, `${width}px: the command is narrower than the card: ${JSON.stringify(found)}`)
    }
  })
})

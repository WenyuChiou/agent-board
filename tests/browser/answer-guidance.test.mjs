import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoardPage } from './board-page.mjs'
import { browserFixture, writeProgress } from './fixture.mjs'

const progress = `## Synthetic answer guidance
<!-- auto session=a11ce201 agent=codex state=waiting updated=${new Date().toISOString()} -->
### Synthetic launch choice
- [?] Blue or green?
<!-- /auto session=a11ce201 -->
<!-- auto session=a11ce202 agent=codex state=waiting updated=${new Date().toISOString()} -->
### Independent synthetic choice
- [?] Small or large?
<!-- /auto session=a11ce202 -->
`

test('the page Hidden notice restores only its question at desktop and phone widths', { concurrency: false, timeout: 120_000 }, async () => {
  await browserFixture('hidden-notice-restore', async ({ page, progress: file, startServer }) => {
    writeProgress(file, progress)
    const board = new BoardPage(page)
    await board.open(await startServer())
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 })
      const card = page.locator('article.card').filter({ hasText: 'Blue or green?' })
      const more = card.getByRole('button', { name: 'More', exact: true })
      if (await more.getAttribute('aria-expanded') !== 'true') await more.click()
      await card.getByRole('button', { name: 'Already answered, hide', exact: true }).click()
      const notice = page.locator('article.lost > .press-result').filter({ hasText: 'Hidden:' })
      await notice.getByRole('button', { name: 'Show again', exact: true }).waitFor()
      await card.waitFor({ state: 'detached' })
      assert.equal(await board.question('Small or large?').count(), 1, 'another question changed')
      // The ordinary poll must keep the matching restore action in the notice.
      await page.waitForResponse(response => new URL(response.url()).pathname === '/api/board')
      await notice.getByRole('button', { name: 'Show again', exact: true }).focus()
      await page.keyboard.press('Enter')
      await card.waitFor()
      assert.equal(await board.question('Small or large?').count(), 1)
      assert.equal(await notice.count(), 0)
    }
  })
})

test('a sent question keeps its documented hide control visible on a phone', { concurrency: false, timeout: 120_000 }, async () => {
  await browserFixture('sent-hide-guidance', async ({ page, progress: file, startServer }) => {
    writeProgress(file, progress)
    await page.setViewportSize({ width: 375, height: 1000 })
    // Only the send result is synthetic: this tests the page's post-Send controls,
    // not a provider or native receiver. Hide and restore still use the real service.
    await page.route('**/api/board', async route => {
      const response = await route.fetch({ maxRetries: 0 })
      if (response.status() === 304) { await route.fulfill({ response }); return }
      const body = await response.json()
      for (const ask of body.model?.asks ?? []) {
        ask.send = 'send'
        if (ask.text === 'Blue or green?') ask.answers = ['Blue', 'Green', 'Red', 'Gold']
      }
      await route.fulfill({ response, json: body })
    })
    const sends = []
    await page.route('**/api/act', async route => {
      if (route.request().postDataJSON().type !== 'send') { await route.continue(); return }
      sends.push(route.request().postDataJSON().text)
      await route.fulfill({ json: { ok: true, note: 'Synthetic send accepted.' } })
    })
    page.on('dialog', dialog => dialog.accept())
    const board = new BoardPage(page)
    await board.open(await startServer())
    const card = page.locator('article.card').filter({ hasText: 'Blue or green?' })
    const send = card.getByRole('button', { name: 'Send', exact: true })
    const choices = card.locator('button.choice')
    assert.deepEqual(await choices.allTextContents(), ['Blue', 'Green', 'Red', 'Gold'])
    assert.equal(await send.textContent(), '↑')
    assert.equal(await send.isDisabled(), true)
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 })
      const picksBox = await card.locator('.answer-picks').boundingBox()
      const sendBox = await send.boundingBox()
      assert.ok(sendBox.x >= picksBox.x + picksBox.width - 1, `send stays to the right at ${width}px`)
    }
    const blue = card.getByRole('button', { name: 'Blue', exact: true })
    await blue.focus()
    await page.keyboard.press('Space')
    assert.equal(await blue.getAttribute('aria-pressed'), 'true')
    assert.equal(await send.isEnabled(), true)
    await card.getByRole('button', { name: 'More', exact: true }).click()
    const gold = card.getByRole('button', { name: 'Gold', exact: true })
    await gold.focus()
    await page.keyboard.press('Enter')
    assert.equal(await blue.getAttribute('aria-pressed'), 'false')
    assert.equal(await gold.getAttribute('aria-pressed'), 'true')
    assert.deepEqual(sends, [])
    await send.focus()
    await page.keyboard.press('Enter')
    const hide = card.locator('.state').getByRole('button', { name: 'Already answered, hide', exact: true })
    await hide.waitFor({ state: 'visible' })
    assert.deepEqual(sends, ['Gold'])
    assert.equal(await hide.evaluate(node => node.closest('.more') !== null), false, 'hide does not require opening More')
    await hide.click()
    await page.locator('article.lost > .press-result').filter({ hasText: 'Hidden:' }).getByRole('button', { name: 'Show again', exact: true }).waitFor()
  })
})

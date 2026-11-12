import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { boardClient } from '../../scripts/message-client.mjs'
import { BoardPage } from './board-page.mjs'
import { browserFixture, writeProgress } from './fixture.mjs'

const question = 'Use the blue plan?'
const withQuestion = async (name, run) => browserFixture(name, async fixture => {
  const { page, progress, root, startServer } = fixture
  const session = '77777777-7777-4777-8777-777777777777'
  const owner = createHash('sha256').update('codex:' + session).digest('hex')
  const block = context => `## Synthetic receipts
<!-- auto session=${owner.slice(0, 8)} agent=codex owner=${owner} state=waiting updated=${new Date().toISOString()} resume=${session} dir=${root.replaceAll('\\', '/')} -->
### Choose the synthetic plan
> Context: ${context}
- [?] ${question}
<!-- /auto session=${owner.slice(0, 8)} -->
`
  writeProgress(progress, block('Synthetic receipt context.'))
  const url = await startServer({ messages: true })
  let canReceive = false
  const deliveries = [], errors = []
  const receiver = await boardClient(url).attach({
    agent: 'codex', session, turn: 'synthetic-turn', surface: 'Codex local proxy',
    verify: async () => true, canReceive: () => canReceive,
    deliver: async message => {
      deliveries.push(message)
      return 'ACK ' + (message.nonce || message.id) + ' Synthetic reply.'
    },
    onError: error => errors.push(error.message),
  })
  try {
    const board = new BoardPage(page)
    await board.open(url)
    const card = board.question(question)
    const send = async () => {
      await card.getByRole('button', { name: 'Write your own', exact: true }).click()
      await card.getByRole('textbox', { name: 'Your answer…', exact: true }).fill('Use the synthetic blue plan.')
      await card.getByRole('button', { name: 'Send to Codex', exact: true }).click()
      // The durable paragraph distinguishes the receipt from the duplicate local status under test.
      await card.locator('p[role="status"]').filter({ hasText: /^Queued$/ }).waitFor()
    }
    await run({ ...fixture, card, send, deliveries, receive: () => { canReceive = true }, update: () => writeProgress(progress, block('Updated synthetic receipt context.')) })
    assert.deepEqual(errors, [])
  } finally {
    await receiver.close()
  }
})

test('a durable replied receipt supersedes a local queued hint without another action', { concurrency: false, timeout: 120_000 }, async () => {
  await withQuestion('receipt-replaces-hint', async ({ card, send, receive, deliveries }) => {
    await send()
    const queuedLines = await card.getByText('Queued', { exact: true }).count()
    receive()
    await card.getByText('Replied · Synthetic reply.', { exact: true }).waitFor()
    assert.equal(deliveries.length, 1)
    assert.equal(await card.getByText('Queued', { exact: true }).count(), 0, 'the earlier local enqueue result outlived its durable reply')
    assert.equal(queuedLines, 1, 'the queued receipt and local enqueue result were shown twice')
  })
})

test('an earlier receipt preserves a new send error on the same card', { concurrency: false, timeout: 120_000 }, async () => {
  await withQuestion('receipt-preserves-error', async ({ page, card, send, receive, deliveries, update }) => {
    await send()
    receive()
    await card.getByText('Replied · Synthetic reply.', { exact: true }).waitFor()
    await page.reload()
    await card.getByRole('button', { name: 'Write your own', exact: true }).click()
    await card.getByRole('button', { name: 'Send to Codex', exact: true }).click()
    await card.getByRole('alert').filter({ hasText: 'Type something first.' }).waitFor()
    update()
    // The context appears in both its one-line and full copies; either visible copy proves the redraw.
    await card.getByText('Updated synthetic receipt context.', { exact: true }).first().waitFor()
    assert.equal(await card.getByRole('alert').innerText(), 'Type something first.')
    assert.equal(await card.getByText('Replied · Synthetic reply.', { exact: true }).count(), 1)
    assert.equal(deliveries.length, 1)
  })
})

test('a delayed enqueue response cannot restore Queued after its receipt is already visible', { concurrency: false, timeout: 120_000 }, async () => {
  await withQuestion('receipt-before-response', async ({ page, card, send, receive, deliveries, evidence }) => {
    // Each UI wait must settle inside the existing overall test deadline, including on failure.
    page.setDefaultTimeout(15_000)
    const phases = []
    const phase = name => {
      phases.push({ name, at: new Date().toISOString() })
      writeFileSync(join(evidence, 'delayed-response-phases.json'), JSON.stringify(phases, null, 2))
    }
    let releaseResponse
    const responseGate = new Promise(done => { releaseResponse = done })
    await page.route('**/api/act', async route => {
      if (route.request().postDataJSON().type !== 'message') { await route.continue(); return }
      phase('forwarding one real POST')
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 15_000 })
      assert.equal(response.status(), 200)
      phase('real POST completed, return held')
      await responseGate
      await route.fulfill({ response })
      phase('real response released')
    })
    try {
      await send()
      phase('durable queued visible')
      receive()
      await card.getByText('Replied · Synthetic reply.', { exact: true }).waitFor()
      phase('durable reply visible before POST return')
      releaseResponse()
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="Your answer…"]')?.value === '', undefined, { timeout: 15_000 })
      phase('successful send completed in the page')
      assert.equal(deliveries.length, 1)
      assert.equal(await card.getByText('Queued', { exact: true }).count(), 0, 'a late enqueue response restored feedback superseded by its visible receipt')
      phase('no stale enqueue feedback')
    } finally {
      releaseResponse()
      await page.unroute('**/api/act')
    }
  })
})

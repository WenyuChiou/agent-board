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

const parseRgb = colour => {
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)\s*)?\)$/i.exec(colour)
  if (srgb) {
    assert.ok(srgb[4] === undefined || Number(srgb[4]) === 1, `expected opaque background, got ${colour}`)
    return [Math.round(Number(srgb[1]) * 255), Math.round(Number(srgb[2]) * 255), Math.round(Number(srgb[3]) * 255)]
  }
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+)\s*)?\)$/i.exec(colour)
  assert.ok(match, `expected opaque rgb colour, got ${colour}`)
  assert.ok(match[4] === undefined || Number(match[4]) === 1, `expected opaque background, got ${colour}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}
const contrastRatio = (fg, bg) => {
  const luminance = channels => channels.map(channel => {
    const srgb = channel / 255
    return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0)
  const a = luminance(parseRgb(fg)), b = luminance(parseRgb(bg))
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

test('receipt states show distinct >= 4.5:1 colours and icons in both themes and next-turn wording stays honest in flight (#1400)', { concurrency: false, timeout: 120_000 }, async () => {
  await browserFixture('receipt-contrast-and-next-turn', async ({ page, progress, root, startServer, evidence }) => {
    page.setDefaultTimeout(15_000)
    const sessionWait = '88888888-8888-4888-8888-888888888881'
    const sessionDone = '88888888-8888-4888-8888-888888888882'
    const sessionFail = '88888888-8888-4888-8888-888888888883'
    const owner = session => createHash('sha256').update('codex:' + session).digest('hex')
    const qWait = 'Deploy the synthetic build?'
    const qDone = 'Merge the synthetic branch?'
    const qFail = 'Run the synthetic clean?'
    const cardBlock = (session, title, questionText) => {
      const id = owner(session)
      return `<!-- auto session=${id.slice(0, 8)} agent=codex owner=${id} state=waiting updated=${new Date().toISOString()} resume=${session} dir=${root.replaceAll('\\', '/')} -->
### ${title}
- [?] ${questionText}
<!-- /auto session=${id.slice(0, 8)} -->`
    }
    writeProgress(progress, `## Synthetic receipt states\n${cardBlock(sessionWait, 'Wait card', qWait)}\n\n${cardBlock(sessionDone, 'Done card', qDone)}\n\n${cardBlock(sessionFail, 'Fail card', qFail)}\n`)
    const url = await startServer({ messages: true })
    const token = new URL(url).searchParams.get('t')
    const postMsg = async (action, body) => {
      const res = await fetch(new URL(`/api/messages/${action}`, url), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-board-token': token }, body: JSON.stringify(body),
      })
      assert.equal(res.status, 200)
      return res.json()
    }
    // Enroll wait + done cards on Codex CLI (idle route: nextTurn).
    await postMsg('mailbox-turn', { agent: 'codex', session: sessionWait, surface: 'CLI' })
    await postMsg('mailbox-turn', { agent: 'codex', session: sessionDone, surface: 'CLI' })
    const failReceiver = await boardClient(url).attach({
      agent: 'codex', session: sessionFail, turn: 'fail-turn', surface: 'Codex local proxy',
      verify: async () => true,
      deliver: async (_msg, _accept, _begin) => { throw new Error('SYNTHETIC_REJECT') },
    })
    try {
      const board = new BoardPage(page)
      await board.open(url)
      await board.chooseTheme('light')
      await page.waitForFunction(() => !document.documentElement.classList.contains('theming'))
      const waitCard = board.question(qWait)
      const doneCard = board.question(qDone)
      const failCard = board.question(qFail)

      // Next-turn route card hint uses plain words.
      await waitCard.getByText('Codex reads this when you next type in its window.', { exact: true }).waitFor()
      await waitCard.getByRole('button', { name: 'Write your own', exact: true }).click()
      await waitCard.getByRole('textbox', { name: 'Your answer…', exact: true }).fill('Queue this answer.')

      // Hold the first enqueue POST to verify in-flight wording, button label and contrast.
      let releaseAct = () => {}, finishRoute = () => {}, holdAct = true
      const actHeld = new Promise(done => { releaseAct = done })
      const routeDone = new Promise(done => { finishRoute = done })
      const actRoute = async route => {
        if (holdAct && route.request().postDataJSON().type === 'message') {
          holdAct = false
          await actHeld
          await route.continue()
          finishRoute()
          return
        }
        await route.fallback()
      }
      await page.route('**/api/act', actRoute)
      const queueBtn = waitCard.locator('button.primary')
      await queueBtn.click()
      const inFlight = waitCard.locator('.press-result.wait')
      await inFlight.waitFor()
      const inFlightText = await inFlight.innerText()
      assert.ok(inFlightText.includes("Queuing for Codex's next turn…"), inFlightText)
      assert.ok(!inFlightText.includes('waiting for its reply'), inFlightText)
      assert.equal(await queueBtn.isDisabled(), true)
      assert.ok((await queueBtn.innerText()).startsWith("Queue for Codex's next turn"))
      // Let --dur-fast (120ms) hover-to-disabled transition settle while cursor remains over button and request stays in flight.
      await page.waitForTimeout(160)
      const btnStyles = await queueBtn.evaluate(node => {
        const s = getComputedStyle(node)
        return { color: s.color, backgroundColor: s.backgroundColor }
      })
      assert.ok(contrastRatio(btnStyles.color, btnStyles.backgroundColor) >= 4.5, `disabled Queue button contrast too low: ${JSON.stringify(btnStyles)}`)
      await page.screenshot({ path: join(evidence, 'receipt-in-flight-light.png'), fullPage: true })
      releaseAct()
      await routeDone
      await page.unroute('**/api/act', actRoute)

      // Card 1 settles in queued (waiting) state.
      const waitReceipt = waitCard.locator('p.receipt.t-wait')
      await waitReceipt.filter({ hasText: 'Queued for next turn · Codex reads this when you next type in its window.' }).waitFor()

      // Card 2 settles in handed-over (delivered) state.
      await doneCard.getByRole('button', { name: 'Write your own', exact: true }).click()
      await doneCard.getByRole('textbox', { name: 'Your answer…', exact: true }).fill('Hand over this answer.')
      await doneCard.getByRole('button', { name: "Queue for Codex's next turn", exact: true }).click()
      await doneCard.locator('p.receipt.t-wait').waitFor()
      const taken = await postMsg('mailbox-turn', { agent: 'codex', session: sessionDone, surface: 'CLI' })
      assert.ok(taken.message?.id)
      await postMsg('mailbox-accept', { agent: 'codex', session: sessionDone, id: taken.message.id, nonce: taken.message.nonce })
      const doneReceipt = doneCard.locator('p.receipt.t-done')
      await doneReceipt.filter({ hasText: 'Handed to the session at its turn start. No reply is confirmed.' }).waitFor()

      // Card 3 settles in failed/rejected state.
      await failCard.getByRole('button', { name: 'Write your own', exact: true }).click()
      await failCard.getByRole('textbox', { name: 'Your answer…', exact: true }).fill('Trigger failure.')
      await failCard.getByRole('button', { name: 'Send to Codex', exact: true }).click()
      const failReceipt = failCard.locator('p.receipt.t-alert')
      await failReceipt.filter({ hasText: 'Rejected / not sent' }).waitFor()

      const report = {}
      for (const theme of ['light', 'dark']) {
        await board.chooseTheme(theme)
        await page.waitForFunction(() => !document.documentElement.classList.contains('theming'))
        await page.waitForTimeout(50)
        const measured = {}
        for (const [group, loc] of [['wait', waitReceipt], ['done', doneReceipt], ['fail', failReceipt]]) {
          measured[group] = await loc.evaluate(node => {
            const s = getComputedStyle(node)
            const before = getComputedStyle(node, '::before')
            return {
              color: s.color,
              backgroundColor: s.backgroundColor,
              borderColor: s.borderTopColor,
              iconMask: before.maskImage || before.webkitMaskImage || '',
              content: before.content,
            }
          })
          const ratio = contrastRatio(measured[group].color, measured[group].backgroundColor)
          measured[group].contrast = Number(ratio.toFixed(2))
          assert.ok(ratio >= 4.5, `${theme} ${group} contrast ${ratio.toFixed(2)}:1 < 4.5:1`)
          assert.ok(measured[group].content !== 'none' && measured[group].iconMask && measured[group].iconMask !== 'none', `${theme} ${group} missing status icon`)
        }
        assert.equal(new Set(['wait', 'done', 'fail'].map(k => measured[k].color)).size, 3, `${theme}: foreground colours must differ`)
        assert.equal(new Set(['wait', 'done', 'fail'].map(k => measured[k].backgroundColor)).size, 3, `${theme}: background colours must differ`)
        report[theme] = measured
        await page.locator('.sheet').first().screenshot({ path: join(evidence, `receipts-${theme}.png`) })
      }
      writeFileSync(join(evidence, 'receipt-contrast-report.json'), JSON.stringify(report, null, 2))
    } finally {
      await failReceiver.close()
    }
  })
})

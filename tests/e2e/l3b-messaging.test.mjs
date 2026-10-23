import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import { performance } from 'node:perf_hooks'
import { CONNECTOR_POLL_MS, GAPS, NATIVE_RECEIVERS, RECEIVERS, SENDERS, receiptBudget, withHub } from './lib/hub.mjs'
import { knownFailure } from './lib/known.mjs'
import { noMachineIds, noSilentPress, seenWithin } from './lib/expect.mjs'
import { chat, terminal } from './lib/surfaces.mjs'
import { BLOCKS, LIVE_SESSIONS, PAGE_MS } from './lib/budget.mjs'
import { block } from './lib/writers.mjs'
import { finishedRecord, isFinishedRecord, readStore, seedStore } from './lib/hub-wire.mjs'

const text = 'Review route /health?mode=ready — 測試 intact\nKeep both lines.'
const nativeDelivery = async (hub, source, receiver, id = 'AB-synthetic-message', options) => {
  const sent = await hub.send(source, receiver, text, id)
  const result = await hub.receipt(receiver, sent, options)
  await hub.cleanPage(sent)
  return { ...result, sent }
}
const nativeOrFallback = async (hub, source, receiver, issue) => {
  if (receiver.connector) await nativeDelivery(hub, source, receiver)
  else {
    await hub.fallback(receiver, text)
    await hub.cleanPage()
  }
  if (issue) await knownFailure(issue, async () => {
    assert.ok(receiver.connector, `${source === 'page' ? 'page' : source.agent} → ${receiver.agent}: card says Copy; no native receiver`)
    // This assertion becomes a real transport/ACK check when its table row lands.
    assert.ok(receiver.received.length > 0, 'Native receiver did not observe the message')
  })
}

// The board at its scale budget (BLOCKS tasks, LIVE_SESSIONS of them live, the receiver's among them)
// and a message store that already holds the finished messages it keeps, as a long-running board would.
const FINISHED_KEPT = 1000
const PROJECTS = ['api-gateway', 'docs-site', 'research-hub', 'billing-core', 'mobile-app', 'infra-tools', 'data-pipeline', 'search-service']
const atSizeCap = ({ world, messages }) => {
  for (let number = 0; number < BLOCKS - 1; number += 1) {
    const isLive = number < LIVE_SESSIONS - 1
    block(world, {
      project: PROJECTS[number % PROJECTS.length], agent: 'gemini', session: (0xb2000000 + number).toString(16), state: isLive ? 'working' : 'done',
      title: `Scale task ${number + 1}`, steps: [isLive ? '- [~] Check the synthetic routes' : '- [x] Check the synthetic routes'],
    })
  }
  seedStore(messages, Array.from({ length: FINISHED_KEPT }, (_, index) => finishedRecord(index, Date.now())))
}

describe('L3b messages between sessions and agents', { timeout: 90000, concurrency: 2 }, () => {
  test("messages: a Codex session reaches its own other Codex session, which acknowledges, and the receipt shows on the sender's card", { timeout: 20000 }, async () => withHub([
    { agent: 'codex', title: 'Prepare gateway sender' },
    { agent: 'codex', title: 'Review gateway receiver', mode: 'proxy' },
  ], async hub => {
    const [sender, receiver] = hub.actors
    assert.notEqual(sender.session, receiver.session)
    await nativeDelivery(hub, sender, receiver)
    const card = (await hub.card(sender)).textContent
    await knownFailure('hold:sender-receipt', () => {
      assert.ok(card.includes('Replied'), 'Sender card has no outgoing receipt: ' + card)
    })
  }))

  test('messages: an Antigravity session reaches its own other Antigravity session and the receipt shows on the card', { timeout: 20000 }, async () => withHub([
    { agent: 'antigravity' }, { agent: 'antigravity' },
  ], async hub => {
    const [sender, receiver] = hub.actors
    assert.notEqual(sender.session, receiver.session)
    await nativeDelivery(hub, sender, receiver)
  }))

  test('messages: Codex to Antigravity and Antigravity to Codex each deliver, acknowledge and show the receipt', { timeout: 20000 }, async () => withHub([
    { agent: 'codex' }, { agent: 'antigravity' },
  ], async hub => {
    const [codex, antigravity] = hub.actors
    await nativeDelivery(hub, codex, antigravity, 'AB-outward')
    await nativeDelivery(hub, antigravity, codex, 'AB-return')
  }))

  for (const agent of Object.keys(NATIVE_RECEIVERS)) test(`messages: a message typed on the serve page reaches ${NATIVE_RECEIVERS[agent].label} card's live session and the card shows the receipt`, { timeout: 20000 }, async () => withHub([
    { agent },
  ], async hub => { await nativeDelivery(hub, 'page', hub.actors[0]) }))

  test("messages: an answer goes back to the sender as a second message and shows on the sender's card", { timeout: 20000 }, async () => withHub([
    { agent: 'codex' }, { agent: 'antigravity' },
  ], async hub => {
    const [sender, receiver] = hub.actors
    await nativeDelivery(hub, sender, receiver, 'AB-question')
    const sent = await hub.send(receiver, sender, 'The route is ready. Answer in a second message.', 'AB-answer')
    await hub.receipt(sender, sent)
    const messages = (await hub.snapshot()).messaging.messages
    assert.equal(messages.length, 2)
    assert.notEqual(messages[0].id, messages[1].id)
    assert.equal(messages[0].from, messages[1].to)
    assert.equal(messages[0].to, messages[1].from)
    await hub.cleanPage()
  }))

  test('messages: Codex to a Claude session is delivered natively or the card names the copy fallback in words', { timeout: 20000 }, async () => withHub([
    { agent: 'codex' }, { agent: 'claude' },
  ], async hub => { await nativeOrFallback(hub, hub.actors[0], hub.actors[1], 58) }))

  test('messages: Antigravity to a Hermes session is delivered natively or the card names the copy fallback in words', { timeout: 20000 }, async () => withHub([
    { agent: 'antigravity' }, { agent: 'hermes' },
  ], async hub => { await nativeOrFallback(hub, hub.actors[0], hub.actors[1], 233) }))

  test('messages: every sender-receiver pair either delivers with a receipt or names the fallback in words', { timeout: 80000, concurrency: 2 }, async t => {
    const pairs = SENDERS.flatMap(from => RECEIVERS.map(to => ({ from, to, relation: from === to ? 'own' : 'other' })))
    await Promise.all(pairs.map(({ from, to, relation }) => t.test(`${from} → ${to} (${relation})`, { timeout: 20000 }, async () => withHub([
      ...(from === 'page' ? [] : [{ agent: from, title: 'Prepare message sender' }]),
      { agent: to, title: 'Review message receiver' },
    ], async hub => {
      const receiver = hub.actors.at(-1)
      const source = from === 'page' ? 'page' : hub.actors[0]
      if (source !== 'page') assert.notEqual(source.session, receiver.session)
      await nativeOrFallback(hub, source, receiver, GAPS[to])
    }))))
  })

  test('messages: a delivered message shows on every surface, not only the serve page', { timeout: 20000 }, async () => withHub([
    { agent: 'codex' }, { agent: 'antigravity' },
  ], async hub => {
    const [, receiver] = hub.actors
    await nativeDelivery(hub, hub.actors[0], receiver)
    const surfaces = { terminal: (await terminal.screen(hub.world)), chat: (await chat(hub.world)) }
    assert.equal(surfaces.chat.status, 0, surfaces.chat.stderr)
    for (const [surface, output] of [['terminal', surfaces.terminal], ['--chat', surfaces.chat.stdout]]) {
      assert.ok(output.includes(receiver.title), `${surface}: receiver card missing`)
      noMachineIds(output, hub.world)
      await knownFailure(232, () => {
        assert.match(output, /Replied|message (?:arrived|answered)|ACK AB-synthetic-message/i, `${surface}: receiver card has no receipt: ${output}`)
      })
    }
  }))

  test('messages: a send to a session that just disconnected says so on the card instead of waiting forever', { timeout: 20000 }, async () => withHub([
    { agent: 'codex' },
  ], async hub => {
    const receiver = hub.actors[0]
    const draft = await hub.draft(receiver, text)
    await receiver.connector.close()
    const start = performance.now()
    const press = await hub.click(draft)
    noSilentPress(press)
    const visible = (await hub.page()).text()
    assert.match(visible, /Could not send|offline|binding changed/i)
    assert.ok(performance.now() - start <= 15000 + PAGE_MS)
    assert.equal((await hub.snapshot()).messaging.messages.length, 0)
    assert.equal(receiver.received.length, 0)
    await hub.fallback(receiver, text)
    const card = (await hub.card(receiver)).textContent
    assert.match(card, /Cannot send here|disconnected|offline|Could not send/i)
  }))

  test('messages: a message typed on the page reaches a live session while the board is at its size cap', { timeout: 40000 }, async () => withHub([
    { agent: 'codex' },
  ], async hub => {
    const receiver = hub.actors[0]
    // The page leaves finished tasks out of its groups, so the file is where all of them are counted.
    assert.equal((hub.world.read('progress.md').match(/^<!-- auto session=/gm) ?? []).length, BLOCKS)
    const rows = (await hub.snapshot()).model.groups.flatMap(group => group.rows)
    assert.ok(rows.length >= LIVE_SESSIONS, `The board shows ${rows.length} tasks, not the scale budget`)
    assert.equal(readStore(hub.messages).filter(isFinishedRecord).length, FINISHED_KEPT)
    assert.equal((await hub.snapshot()).messaging.messages.length, FINISHED_KEPT)
    // A delivery needs a claim, a receipt and the page poll that reads it: each is a full-store request.
    // Cap the allowance so a slowdown of every request still fails the budget.
    const snapshotTimes = []
    for (let index = 0; index < 3; index++) {
      const started = performance.now()
      await hub.snapshot()
      snapshotTimes.push(performance.now() - started)
    }
    const slowest = Math.max(...snapshotTimes)
    console.log(`size cap: ${Math.round(slowest)} ms per snapshot`)
    const { sent } = await nativeDelivery(hub, 'page', receiver, undefined, { extraMs: Math.min(Math.ceil(3 * slowest), 8000) })
    // The new message finishes into a full store: the oldest finished one goes, so the file stays at its cap.
    const store = readStore(hub.messages)
    assert.equal(store.filter(isFinishedRecord).length, FINISHED_KEPT)
    assert.equal(store.filter(one => !isFinishedRecord(one)).length, 0)
    assert.ok(!store.some(one => one.id === 'AB-seed-' + (FINISHED_KEPT - 1)), 'The oldest finished message is still kept')
    // The next oldest was handed out and then expired, so it may have arrived: it waits for its 24 hours.
    assert.ok(store.some(one => one.id === 'AB-seed-' + (FINISHED_KEPT - 2) && one.error === 'EXPIRED'), 'A message that may have arrived went by count')
    const kept = store.find(one => one.id === sent.id)
    assert.equal(kept?.status, 'acknowledged')
    assert.equal(kept.text, '')
    assert.equal(kept.hash, createHash('sha256').update(JSON.stringify(sent.text)).digest('hex'))
  }, { prepare: atSizeCap }))

  test('messages: a receiver that never acknowledges leaves the card saying the delivery is uncertain', { timeout: 20000 }, async () => withHub([
    { agent: 'codex', noAck: true },
  ], async hub => {
    const receiver = hub.actors[0]
    const sent = await hub.send('page', receiver, text)
    const budget = await receiptBudget(hub)
    let message
    await seenWithin(async () => {
      message = (await hub.snapshot()).messaging.messages.find(one => one.id === sent.id)
      return (await hub.card(receiver)).textContent
    }, card => message?.status === 'uncertain' && message.error === 'ACK_TIMEOUT' && /Reply timed out/.test(card), Math.max(1, budget.measuredMs - budget.pagePollMs - (performance.now() - sent.started)))
    const elapsed = performance.now() - sent.started + budget.pagePollMs
    assert.ok(elapsed <= budget.measuredMs, `${elapsed} ms including the page poll exceeds ${budget.measuredMs} ms`)
    assert.equal(receiver.received.length, 1)
    assert.equal(receiver.received[0].text, text)
    assert.equal(message.reply, '')
    assert.ok(receiver.errors.includes('ACK_TIMEOUT'))
    // An exact retry after uncertainty must not cause another native input.
    const retry = await hub.server.post('/api/messages/send', { id: sent.id, target: receiver.connector.id, turn: receiver.connector.turn, text })
    assert.equal(retry.json().status, 'uncertain')
    await new Promise(done => setTimeout(done, CONNECTOR_POLL_MS + 100))
    assert.equal(receiver.received.length, 1)
    await hub.cleanPage()
  }))
})

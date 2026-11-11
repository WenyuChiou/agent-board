import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
let parseProgress, buildView, serveModel, emptyQuestions, observeQuestions, parseMessageStore, messages, EN
try {
  ;({ parseProgress } = await import('../hooks/parse.ts'))
  ;({ buildView } = await import('../hooks/view.ts'))
  ;({ serveModel } = await import('../hooks/serve.ts'))
  ;({ emptyQuestions, observeQuestions } = await import('../hooks/questions.ts'))
  ;({ parseMessageStore } = await import('../scripts/board-messaging.ts'))
  messages = await import('../hooks/messaging.ts')
  ;({ EN } = await import('../hooks/strings-en.ts'))
} finally { loader.deregister() }

const now = Date.parse('2026-11-09T06:00:00Z')
const session = '11111111-2222-4333-8444-555555555555'
const target = { id: 'synthetic-binding', agent: 'codex', session, turn: 'synthetic-turn', surface: 'synthetic', expires: now + messages.OPEN_LIMIT_MS * 3 }
const block = step => `## Synthetic project
<!-- auto session=abcdef01 agent=codex resume=${session} state=waiting updated=${new Date(now).toISOString()} -->
### Synthetic answer
${step}
<!-- /auto session=abcdef01 -->
`
const fixture = () => {
  const initial = parseProgress(block('- [?] Blue or green?'))
  const ledger = observeQuestions(emptyQuestions(), initial, null, [], now, true).ledger
  const id = ledger.records[0].id
  const progress = parseProgress(block('- [~] Continue the synthetic work'))
  const retained = observeQuestions(ledger, progress, null, [], now + 3, true).ledger
  const view = buildView(progress, [], null, now + 4, 0, {}, EN, [], {}, retained)
  assert.ok(view.waiting.some(ask => ask.questionId === id && ask.key.startsWith('retained::')))
  const input = { id: 'SYNTHETIC-ANSWER-1', target: target.id, turn: target.turn, text: 'Blue', answers: id }
  const queued = messages.queueMessage({ messages: [] }, input, 'board', target, now).state
  const claimed = messages.claimMessages(queued, target, now + 1, 'abcdef').state
  const accepted = messages.messageReceipt(claimed, target, { id: input.id, nonce: 'abcdef', status: 'accepted' }, now + 2)
  const page = state => serveModel(view, [], EN, new Set(), false, { connections: [], messages: state.messages })
  assert.equal(page(accepted).asks.length, 0, 'accepted control must already hide its retained question')
  return { claimed, accepted, retained, id, input, page }
}

test('an accepted answer keeps its retained question out of Needs you after ordinary disconnect', () => {
  const f = fixture()
  const state = messages.disconnectMessages(f.accepted, target.id, now + 10)
  assert.equal(state.messages[0].status, 'accepted')
  assert.equal(state.messages[0].error, 'DISCONNECTED')
  assert.equal(state.messages[0].reply, '')
  assert.equal(f.page(state).asks.length, 0)
  assert.equal(f.retained.records[0].isUnresolved, true, 'transport acceptance is not a durable answer or model ACK')
})

test('expiry preserves acceptance evidence and never reoffers the retained question or replays its answer', () => {
  const f = fixture()
  const disconnected = messages.disconnectMessages(f.accepted, target.id, now + 10)
  const boundary = now + 10 + messages.OPEN_LIMIT_MS
  assert.equal(messages.pruneMessages(disconnected, boundary).messages[0].status, 'accepted')
  const expired = messages.pruneMessages(disconnected, boundary + 1)
  assert.equal(expired.messages[0].status, 'uncertain')
  assert.equal(expired.messages[0].error, 'EXPIRED')
  assert.equal(expired.messages[0].hasAccepted, true)
  assert.equal(expired.messages[0].text, '')
  const restored = parseMessageStore(JSON.stringify({ version: 2, ...expired }), boundary + 2)
  assert.equal(restored.messages[0].hasAccepted, true)
  assert.equal(f.page(restored).asks.length, 0)
  assert.equal(messages.claimMessages(restored, target, boundary + 2, 'fedcba').messages.length, 0)
  assert.throws(() => messages.messageReceipt(restored, target, { id: f.input.id, nonce: 'abcdef', status: 'acknowledged', reply: 'ACK abcdef' }, boundary + 2), /MESSAGE_EXPIRED/)
})

test('a never-accepted expired answer keeps its retained question available for recovery', () => {
  const f = fixture()
  const disconnected = messages.disconnectMessages(f.claimed, target.id, now + 10)
  const expired = messages.pruneMessages(disconnected, now + messages.OPEN_LIMIT_MS + 2)
  assert.equal(expired.messages[0].error, 'EXPIRED')
  assert.notEqual(expired.messages[0].hasAccepted, true)
  assert.deepEqual(f.page(expired).asks.map(ask => ask.questionId), [f.id])
})

test('a matching late ACK still acknowledges a disconnected accepted answer before expiry', () => {
  const f = fixture()
  const disconnected = messages.disconnectMessages(f.accepted, target.id, now + 10)
  const acknowledged = messages.messageReceipt(disconnected, target, { id: f.input.id, nonce: 'abcdef', status: 'acknowledged', reply: 'ACK abcdef' }, now + 11)
  assert.equal(acknowledged.messages[0].status, 'acknowledged')
  assert.equal(f.page(acknowledged).asks.length, 0)
})

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// The page modules use extensionless imports; resolve only those to their .ts files.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })

const { parseProgress } = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { serveModel, servePage } = await import('../hooks/serve.ts')
const { SURFACE_IDS, claimMessages, messageReceipt, queueMessage } = await import('../hooks/messaging.ts')
const { EN } = await import('../hooks/strings-en.ts')
const { pageDom } = await import('./e2e/lib/surfaces.mjs')

// #1579: a Claude session ends its turn on a question. On its card the person opens Write your own and sends a
// message; the board delivers it and Claude takes it in a turn of its own. The question stays open (#1334).
const now = Date.now()
const connection = { id: 'c1', agent: 'claude', session: 'claude-session', surface: SURFACE_IDS.claude, turn: 'session', scope: 'session', expires: now + 120_000 }
const file = state => `## Synthetic\n<!-- auto session=abcdef01 agent=claude resume=claude-session state=${state} updated=${new Date(now).toISOString()} -->\n### Synthetic port\n- [?] Port 3000 or 8080?\n<!-- /auto session=abcdef01 -->\n`
const group = { now, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] }
const modelOf = (messages, state = 'waiting') => serveModel(buildView(parseProgress(file(state)), [], null, now, 0, {}, EN), [], EN, new Set(), false, { connections: [connection], messages }, false, group)
const shown = (page, node) => {
  for (let one = node; one; one = one.parentNode) if (one.hidden === true || one.inert === true && one !== node) return false
  return true
}
const visibleLabels = page => page.cards().flatMap(card => page.buttons(card)).filter(one => shown(page, one)).map(one => one.textContent)

const sendOwnMessage = async () => {
  const model = modelOf([])
  assert.equal(model.asks.length, 1)
  assert.deepEqual(model.asks[0].answers.slice(0, 2), ['Port 3000', '8080'])
  const page = await pageDom(servePage(EN, 'synthetic'), model, async () => ({ ok: true, json: async () => ({ ok: true }) }))
  page.cards().flatMap(card => page.buttons(card)).find(one => one.textContent === EN.pgWriteOwn).click()
  page.inputs(page.cards()[0])[0].value = 'Message C'
  page.buttons(page.cards()[0]).find(one => one.textContent === EN.serveSend('Claude')).click()
  await page.flush()
  assert.equal(page.requests.length, 1)
  assert.equal(page.requests[0].body.type, 'message')
  const id = page.requests[0].body.id
  const sent = queueMessage({ messages: [] }, { id, target: connection.id, turn: connection.turn, text: 'Message C', answers: model.asks[0].questionId }, 'board', connection, now).state
  const claimed = claimMessages(sent, connection, now + 1, 'abcdef').state
  const accepted = messageReceipt(claimed, connection, { id, nonce: 'abcdef', status: 'accepted' }, now + 2)
  const acknowledged = messageReceipt(accepted, connection, { id, nonce: 'abcdef', status: 'acknowledged', reply: 'ACK abcdef' }, now + 3)
  return { page, accepted, acknowledged }
}

test('#1579 after a message from the card has been taken and the question is still open, the card offers its answers again', async () => {
  const { page, acknowledged } = await sendOwnMessage()
  const after = modelOf(acknowledged.messages)
  // The board counts the question as waiting again: the message is no longer on its way.
  assert.deepEqual(after.view.needs.handled, [])
  await page.redraw(after)
  const labels = visibleLabels(page)
  assert.ok(labels.includes('Port 3000') && labels.includes('8080'), labels.join(' | '))
  // Already answered, hide is not put forward while the board itself says the question waits for the person.
  const receiptHide = page.cards().flatMap(card => page.buttons(card)).filter(one => one.textContent === EN.answeredHide && shown(page, one) && one.parentNode?.parentNode?.className === 'receipt-box')
  assert.deepEqual(receiptHide, [])
})

test('#1579 while the message from the card is being taken, the page says why the question left the Needs you count', async () => {
  const { page, accepted, acknowledged } = await sendOwnMessage()
  const during = modelOf(accepted.messages, 'working')
  await page.redraw(during)
  // The working turn does not hide the question: the view still holds it. It leaves the count because the board
  // counts a message bound to it as an answer on its way (#1296), as --status and the terminal board do.
  assert.equal(during.view.needs.n, 1)
  assert.deepEqual(during.view.needs.handled, [during.asks[0].key])
  // The Needs you heading says why it reads 0, in the words the status line uses for the same count.
  const flag = page.text()
  assert.ok(flag.includes(EN.boardQueuedCount(1)), flag)
  // Once the message has been taken, nothing is on its way and the words go.
  await page.redraw(modelOf(acknowledged.messages))
  assert.ok(!page.text().includes(EN.boardQueuedCount(1)), page.text())
})

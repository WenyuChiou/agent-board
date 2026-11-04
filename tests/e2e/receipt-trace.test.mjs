import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { receiptTrace } from './lib/receipt-trace.mjs'
import { withHub } from './lib/hub.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('receipt diagnostics distinguish response headers from the completed body and retain no request secrets', async () => {
  const headers = deferred(), body = deferred()
  const server = createServer(async (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.flushHeaders()
    headers.resolve()
    await body.promise
    response.end('{}')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const address = `http://127.0.0.1:${server.address().port}`
  const trace = receiptTrace(address + '/?t=synthetic-secret')
  try {
    const request = fetch(address + '/api/messages/receipt', {
      method: 'POST', headers: { 'x-board-token': 'synthetic-secret' },
      body: JSON.stringify({ nonce: 'abcdef', secret: 'synthetic-secret', reply: 'synthetic private reply' }),
    })
    await headers.promise
    const response = await request
    const pending = trace.snapshot()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].action, 'receipt')
    assert.equal(pending[0].phase, 'headers')
    assert.equal(pending[0].status, 200)
    body.resolve()
    await response.json()
    assert.equal(trace.snapshot()[0].phase, 'complete')
    assert.equal(pending[0].phase, 'headers', 'a captured diagnostic must not change later')
    assert.doesNotMatch(JSON.stringify(trace.snapshot()), /abcdef|synthetic|127\.0\.0\.1|http|nonce|secret|reply|token/)
    trace.close()
    await (await fetch(address + '/api/messages/poll')).text()
    assert.equal(trace.snapshot().length, 1, 'closing removes the subscriptions')
  } finally {
    body.resolve()
    trace.close()
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
})

test('a failed synthetic ACK retains protocol and store diagnostics without changing the receipt failure', { timeout: 15000 }, async () => withHub([
  { agent: 'codex', noAck: true },
], async hub => {
  const [receiver] = hub.actors
  const sent = await hub.send('page', receiver, 'Synthetic diagnostic control')
  await assert.rejects(hub.receipt(receiver, sent), error => {
    assert.match(error.message, /Not seen within/)
    const diagnostic = error.receiptDiagnostics
    assert.equal(diagnostic.observedStatus, 'uncertain')
    assert.equal(diagnostic.durableStatus, 'uncertain')
    assert.equal(diagnostic.transportReceived, true)
    assert.equal(diagnostic.correlated, false)
    assert.deepEqual(diagnostic.errors, ['ACK_TIMEOUT'])
    assert.ok(diagnostic.requests.some(one => one.action === 'receipt' && one.phase === 'complete' && one.status === 200))
    assert.doesNotMatch(JSON.stringify(diagnostic), /abcdef|Synthetic|127\.0\.0\.1|http|nonce|secret|reply|token/)
    return true
  })
}, { traceReceipt: true }))

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { connectCodexProxy } from '../scripts/codex-message-connector.mjs'
import { createFrameDecoder, encodeClientFrame, isWebSocketUpgrade, openWebSocketStdio, webSocketHandshake, WS_MAX_BYTES } from '../scripts/ws-stdio.mjs'
import { proxyUpgrade, readClientFrame, serveWebSocketProxy, serverFrame } from './helpers/ws-proxy-mock.mjs'

const key = 'dGhlIHNhbXBsZSBub25jZQ=='
const upgrade = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n'
const streams = () => {
  const input = new PassThrough(), output = new PassThrough(), writes = [], messages = [], closed = []
  output.on('data', chunk => writes.push(chunk))
  const socket = openWebSocketStdio({ input, output, onMessage: message => messages.push(message), onClose: error => closed.push(error.message) })
  void socket.ready.catch(() => undefined)
  const request = Buffer.concat(writes).toString(), key = request.match(/Sec-WebSocket-Key: (.+)\r\n/)[1]
  writes.length = 0
  return {
    input, output, socket, writes, messages, closed, request, key,
    close: () => { socket.close(); input.destroy(); output.destroy() },
  }
}

test('the WebSocket handshake carries a key and accepts only the matching Sec-WebSocket-Accept', async t => {
  assert.equal(webSocketHandshake(key), 'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
  assert.equal(isWebSocketUpgrade(upgrade, key), true)
  assert.equal(isWebSocketUpgrade(upgrade.replace('Upgrade: websocket', 'uPgRaDe: WebSocket').replace('Connection: Upgrade', 'connection: keep-alive, Upgrade'), key), true)
  for (const response of [
    upgrade.replace('101', '200'),
    upgrade.replace('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'wrong'),
    upgrade.replace('Upgrade: websocket\r\n', ''),
    upgrade.replace('Connection: Upgrade', 'Connection: close'),
    upgrade.replace('\r\n\r\n', '\r\nSec-WebSocket-Accept: wrong\r\n\r\n'),
    upgrade.replace('Upgrade: websocket', 'invalid header'),
  ]) assert.equal(isWebSocketUpgrade(response, key), false, response)
  assert.equal(isWebSocketUpgrade(upgrade, 'AAAAAAAAAAAAAAAAAAAAAA=='), false)
  const one = streams(), two = streams()
  try {
    for (const transport of [one, two]) {
      assert.equal(Buffer.from(transport.key, 'base64').length, 16)
      assert.equal(transport.request, webSocketHandshake(transport.key))
      transport.input.write(proxyUpgrade(transport.key))
      await transport.socket.ready
    }
    assert.notEqual(one.key, two.key)
    t.diagnostic('Handshake request sent: ' + JSON.stringify(one.request))
  } finally { one.close(); two.close() }
})

test('a client text frame is masked and decodes back to the same JSON at every length class', () => {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  for (const length of [125, 126, 65536]) {
    const json = JSON.stringify('x'.repeat(length - 2)), source = Buffer.from(json)
    const frame = encodeClientFrame(source, mask)
    assert.equal(frame[0], 0x81)
    assert.equal(frame[1] & 0x80, 0x80)
    assert.equal(frame[1] & 0x7f, length === 125 ? 125 : length === 126 ? 126 : 127)
    const prefix = length === 125 ? 2 : length === 126 ? 4 : 10
    if (prefix === 4) assert.equal(frame.readUInt16BE(2), length)
    if (prefix === 10) assert.equal(frame.readBigUInt64BE(2), BigInt(length))
    assert.deepEqual(frame.subarray(prefix, prefix + 4), mask)
    assert.notDeepEqual(frame.subarray(prefix + 4), source)
    const decoded = readClientFrame(frame)
    assert.equal(decoded.opcode, 1)
    assert.equal(decoded.consumed, frame.length)
    assert.equal(decoded.payload.toString(), json)
    assert.equal(JSON.parse(decoded.payload.toString()), JSON.parse(json))
    assert.equal(source.toString(), json)
  }
})

test('the frame decoder joins split chunks, several frames in one chunk and continuation frames', () => {
  const expected = ['first', 'x'.repeat(126), 'y'.repeat(65536)]
  const frames = Buffer.concat(expected.map(text => serverFrame(text)))
  for (const boundary of [1, 2, 3, 7, 130, 136, 140, frames.length - 1]) {
    const decode = createFrameDecoder()
    const events = [...decode(frames.subarray(0, boundary)), ...decode(frames.subarray(boundary))]
    assert.deepEqual(events, expected.map(text => ({ type: 'text', text })))
  }
  const decode = createFrameDecoder(), payload = Buffer.from('split ☃ message')
  const first = serverFrame(payload.subarray(0, 7), { isFinal: false })
  const middle = serverFrame(payload.subarray(7, 8), { opcode: 0, isFinal: false })
  const last = serverFrame(payload.subarray(8), { opcode: 0 })
  assert.deepEqual(decode(first.subarray(0, 1)), [])
  assert.deepEqual(decode(first.subarray(1)), [])
  assert.deepEqual(decode(middle), [])
  assert.deepEqual(decode(Buffer.concat([last, serverFrame('next')])), [{ type: 'text', text: payload.toString() }, { type: 'text', text: 'next' }])
  for (const size of [126, 65536]) {
    const decoder = createFrameDecoder(), frame = serverFrame('x'.repeat(size)), header = size === 126 ? 4 : 10
    for (let offset = 0; offset < header; offset++) assert.deepEqual(decoder(frame.subarray(offset, offset + 1)), [])
    assert.deepEqual(decoder(frame.subarray(header)), [{ type: 'text', text: 'x'.repeat(size) }])
  }
})

test('a ping from the proxy is answered with a pong carrying the same payload', async () => {
  const transport = streams(), payload = Buffer.from([0, 1, 255, 13, 10])
  try {
    transport.input.write(proxyUpgrade(transport.key))
    await transport.socket.ready
    transport.input.write(serverFrame('part ', { isFinal: false }))
    transport.input.write(serverFrame(payload, { opcode: 9 }))
    transport.input.write(serverFrame('ignored', { opcode: 10 }))
    transport.input.write(serverFrame('two', { opcode: 0 }))
    const wire = Buffer.concat(transport.writes), pong = readClientFrame(wire)
    assert.equal(pong.opcode, 10)
    assert.equal(pong.consumed, wire.length)
    assert.deepEqual(pong.payload, payload)
    assert.deepEqual(transport.messages, ['part two'])
    assert.deepEqual(transport.closed, [])
  } finally { transport.close() }
})

test('split upgrade headers and the first frame in the same chunk preserve message boundaries', async () => {
  const transport = streams()
  try {
    assert.throws(() => transport.socket.send('{}'), /OWNER_DISCONNECTED/)
    const response = Buffer.from(proxyUpgrade(transport.key))
    transport.input.write(response.subarray(0, 11))
    assert.deepEqual(transport.messages, [])
    transport.input.write(Buffer.concat([response.subarray(11), serverFrame('{"id":1}'), serverFrame('{"id":2}')]))
    await transport.socket.ready
    assert.deepEqual(transport.messages, ['{"id":1}', '{"id":2}'])
    transport.socket.send('{"method":"initialized","params":{}}')
    const wire = Buffer.concat(transport.writes), frame = readClientFrame(wire)
    assert.equal(frame.payload.toString(), '{"method":"initialized","params":{}}')
    assert.equal(frame.consumed, wire.length)
  } finally { transport.close() }
})

test('a failed upgrade ends the connection with OWNER_HANDSHAKE_FAILED', async () => {
  for (const invalid of ['status', 'accept', 'end', 'header limit', 'error']) {
    const transport = streams()
    try {
      const rejected = assert.rejects(transport.socket.ready, { message: 'OWNER_HANDSHAKE_FAILED' })
      if (invalid === 'status') transport.input.write(proxyUpgrade(transport.key).replace('101', '403'))
      if (invalid === 'accept') transport.input.write(upgrade)
      if (invalid === 'end') { transport.input.write('HTTP/1.1 101'); transport.input.end() }
      if (invalid === 'header limit') transport.input.write('HTTP/' + 'x'.repeat(WS_MAX_BYTES))
      if (invalid === 'error') transport.output.emit('error', new Error('synthetic write failure'))
      await rejected
      assert.deepEqual(transport.closed, ['OWNER_HANDSHAKE_FAILED'])
      assert.throws(() => transport.socket.send('{}'), /OWNER_DISCONNECTED/)
      assert.equal(transport.writes.length, 0)
    } finally { transport.close() }
  }
})

test('the decoder bounds whole messages and rejects invalid frames before accepting their payloads', () => {
  const large = Buffer.alloc(10)
  large[0] = 0x81
  large[1] = 127
  large.writeBigUInt64BE(BigInt(WS_MAX_BYTES + 1), 2)
  assert.throws(() => createFrameDecoder()(large), /WEBSOCKET_TOO_LARGE/)
  large.writeBigUInt64BE(2n ** 63n, 2)
  assert.throws(() => createFrameDecoder()(large), /WEBSOCKET_TOO_LARGE/)
  assert.throws(() => encodeClientFrame('x'.repeat(WS_MAX_BYTES + 1), Buffer.alloc(4)), /WEBSOCKET_TOO_LARGE/)
  const decode = createFrameDecoder()
  assert.deepEqual(decode(serverFrame('x'.repeat(WS_MAX_BYTES / 2), { isFinal: false })), [])
  assert.throws(() => decode(serverFrame('x'.repeat(WS_MAX_BYTES / 2 + 1), { opcode: 0 })), /WEBSOCKET_TOO_LARGE/)
  assert.equal(createFrameDecoder()(serverFrame('x'.repeat(WS_MAX_BYTES)))[0].text.length, WS_MAX_BYTES)
  const malformed = [
    Buffer.from([0xc1, 0]),
    Buffer.from([0x81, 0x80]),
    Buffer.from([0x82, 0]),
    serverFrame('unexpected', { opcode: 0 }),
    serverFrame('ping', { opcode: 9, isFinal: false }),
    serverFrame('x'.repeat(126), { opcode: 9 }),
    serverFrame(Buffer.from([1]), { opcode: 8 }),
    serverFrame(Buffer.from([0xff])),
    Buffer.from([0x81, 126, 0, 1, 65]),
    Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 0, 0, 1, 65]),
    Buffer.concat([serverFrame('unfinished', { isFinal: false }), serverFrame('new message')]),
  ]
  for (const frame of malformed) assert.throws(() => createFrameDecoder()(frame))
})

test('close frames, stream loss and oversized frames end an upgraded connection once', async () => {
  for (const ending of ['close', 'end', 'oversized', 'error']) {
    const transport = streams()
    try {
      transport.input.write(proxyUpgrade(transport.key))
      await transport.socket.ready
      if (ending === 'close') {
        const payload = Buffer.from([3, 232])
        transport.input.write(Buffer.concat([serverFrame(payload, { opcode: 8 }), serverFrame('after close')]))
        const reply = readClientFrame(Buffer.concat(transport.writes))
        assert.equal(reply.opcode, 8)
        assert.deepEqual(reply.payload, payload)
      }
      if (ending === 'end') { transport.input.end(); await new Promise(done => transport.input.once('end', done)) }
      if (ending === 'oversized') transport.input.write(serverFrame('x'.repeat(WS_MAX_BYTES + 1)))
      if (ending === 'error') transport.input.emit('error', new Error('synthetic input failure'))
      assert.deepEqual(transport.closed, ['OWNER_DISCONNECTED'])
      assert.deepEqual(transport.messages, [])
      assert.throws(() => transport.socket.send('{}'), /OWNER_DISCONNECTED/)
      transport.socket.close()
      assert.equal(transport.closed.length, 1)
    } finally { transport.close() }
  }
})

test('the WebSocket-only proxy mock closes on plain JSON instead of accepting an initialize request', () => {
  const input = new PassThrough(), output = new PassThrough()
  let hasHandled = false
  const proxy = serveWebSocketProxy({ input, output, onMessage: () => { hasHandled = true } })
  try {
    input.write('{"id":1,"method":"initialize"}\n')
    assert.equal(input.destroyed, true)
    assert.equal(output.writableEnded, true)
    assert.equal(hasHandled, false)
  } finally { proxy.close(); input.destroy(); output.destroy() }
})

test('the WebSocket-only proxy mock exchanges framed JSON and closes when its input ends', async () => {
  const outgoing = new PassThrough(), incoming = new PassThrough(), messages = [], calls = []
  const proxy = serveWebSocketProxy({
    input: outgoing, output: incoming,
    onMessage: (value, send) => { calls.push(value); if (value.id) send({ id: value.id, result: {} }) },
  })
  const socket = openWebSocketStdio({ input: incoming, output: outgoing, onMessage: message => messages.push(JSON.parse(message)) })
  try {
    await socket.ready
    socket.send(JSON.stringify({ id: 1, method: 'initialize' }))
    socket.send(JSON.stringify({ method: 'initialized', params: {} }))
    assert.deepEqual(calls, [{ id: 1, method: 'initialize' }, { method: 'initialized', params: {} }])
    assert.deepEqual(messages, [{ id: 1, result: {} }])
    const ended = new Promise(done => outgoing.once('end', done))
    outgoing.end()
    await ended
    assert.equal(outgoing.destroyed, true)
    assert.equal(incoming.writableEnded, true)
  } finally { socket.close(); proxy.close(); outgoing.destroy(); incoming.destroy() }
})

test('a proxy that speaks only plain JSON lines is never sent a plain JSON line', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ab-ws-'))
  const executable = join(directory, 'proxy.mjs'), captured = join(directory, 'first-bytes')
  writeFileSync(executable, `import { writeFileSync } from 'node:fs'
process.stdin.once('data', chunk => {
  writeFileSync(${JSON.stringify(captured)}, chunk)
  process.stdout.end(JSON.stringify({ error: 'WEBSOCKET_REQUIRED' }) + '\\n')
  process.stdin.destroy()
})
`)
  try {
    let failure
    try {
      await connectCodexProxy({ boardUrl: 'http://127.0.0.1:1/', executable, thread: '11111111-2222-4333-8444-555555555555', turn: 'turn1' })
    } catch (error) { failure = error }
    const first = readFileSync(captured, 'utf8')
    assert.ok(first.startsWith('GET / HTTP/1.1\r\n'), first)
    assert.ok(first.endsWith('\r\n\r\n'))
    assert.ok(!first.includes('initialize'))
    assert.equal(failure?.message, 'OWNER_HANDSHAKE_FAILED')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

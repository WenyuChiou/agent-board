import { createHash } from 'node:crypto'

// Keep the mock's wire implementation independent of the client under test.
export const serverFrame = (data, { opcode = 1, isFinal = true } = {}) => {
  const payload = Buffer.from(data), size = payload.length
  const header = Buffer.alloc(size < 126 ? 2 : size <= 65535 ? 4 : 10)
  header[0] = (isFinal ? 0x80 : 0) | opcode
  header[1] = size < 126 ? size : size <= 65535 ? 126 : 127
  if (header.length === 4) header.writeUInt16BE(size, 2)
  if (header.length === 10) header.writeBigUInt64BE(BigInt(size), 2)
  return Buffer.concat([header, payload])
}

export const readClientFrame = buffer => {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f, kind = buffer[1] & 0x7f
  if (!(buffer[0] & 0x80) || (buffer[0] & 0x70) || !(buffer[1] & 0x80) || ![1, 8, 10].includes(opcode)) throw new Error('INVALID_CLIENT_FRAME')
  const prefix = kind < 126 ? 2 : kind === 126 ? 4 : 10
  if (buffer.length < prefix + 4) return null
  const length = kind < 126 ? BigInt(kind) : kind === 126 ? BigInt(buffer.readUInt16BE(2)) : buffer.readBigUInt64BE(2)
  if (length > 1048576n || (opcode >= 8 && length > 125n)) throw new Error('INVALID_CLIENT_FRAME')
  if ((kind === 126 && length < 126n) || (kind === 127 && length < 65536n)) throw new Error('INVALID_CLIENT_FRAME')
  const size = Number(length), consumed = prefix + 4 + size
  if (buffer.length < consumed) return null
  const payload = Buffer.from(buffer.subarray(prefix + 4, consumed)), mask = buffer.subarray(prefix, prefix + 4)
  for (let i = 0; i < size; i++) payload[i] ^= mask[i % 4]
  return { opcode, payload, consumed }
}

export const proxyUpgrade = key => [
  'HTTP/1.1 101 Switching Protocols',
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Accept: ' + createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'),
  '',
  '',
].join('\r\n')

export const serveWebSocketProxy = ({ onMessage, onHandshake, input = process.stdin, output = process.stdout }) => {
  let buffer = Buffer.alloc(0), isOpen = false, isClosed = false
  const close = () => {
    if (isClosed) return
    isClosed = true
    input.destroy()
    output.end()
  }
  const send = value => output.write(serverFrame(JSON.stringify(value)))
  input.on('error', close)
  output.on('error', close)
  input.once('end', close)
  input.on('data', chunk => {
    if (isClosed) return
    buffer = Buffer.concat([buffer, chunk])
    if (!isOpen) {
      if (buffer.length >= 4 && buffer.subarray(0, 4).toString() !== 'GET ') { close(); return }
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) { if (buffer.length > 16384) close(); return }
      const request = buffer.subarray(0, end + 4).toString('ascii')
      const key = request.match(/^Sec-WebSocket-Key: ([A-Za-z0-9+/]{22}==)\r$/m)?.[1]
      if (!request.startsWith('GET / HTTP/1.1\r\n') || !key || !request.includes('\r\nHost: localhost\r\n') || !request.includes('\r\nUpgrade: websocket\r\n') || !request.includes('\r\nConnection: Upgrade\r\n') || !request.includes('\r\nSec-WebSocket-Version: 13\r\n')) { close(); return }
      buffer = buffer.subarray(end + 4)
      isOpen = true
      onHandshake?.(request)
      output.write(proxyUpgrade(key))
    }
    try {
      for (;;) {
        const frame = readClientFrame(buffer)
        if (!frame) break
        buffer = buffer.subarray(frame.consumed)
        if (frame.opcode === 8) { close(); return }
        if (frame.opcode === 1) onMessage(JSON.parse(frame.payload.toString('utf8')), send)
      }
    } catch (error) { close(); throw error }
  })
  return { send, close }
}

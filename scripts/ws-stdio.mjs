import { createHash, randomBytes } from 'node:crypto'

export const WS_MAX_BYTES = 1024 * 1024

export const webSocketHandshake = key => [
  'GET / HTTP/1.1',
  'Host: localhost',
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Key: ' + key,
  'Sec-WebSocket-Version: 13',
  '',
  '',
].join('\r\n')

export const isWebSocketUpgrade = (response, key) => {
  const [status, ...lines] = response.split('\r\n')
  if (!/^HTTP\/1\.1 101(?:[ \t].*)?$/.test(status)) return false
  const headers = new Map()
  for (const line of lines) {
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 1) return false
    const name = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim()
    if (name === 'sec-websocket-accept' && headers.has(name)) return false
    headers.set(name, headers.has(name) ? headers.get(name) + ',' + value : value)
  }
  const hasToken = (name, token) => headers.get(name)?.toLowerCase().split(',').some(value => value.trim() === token)
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  return !!hasToken('upgrade', 'websocket') && !!hasToken('connection', 'upgrade') && headers.get('sec-websocket-accept') === accept
}

export const encodeClientFrame = (data, mask, opcode = 1) => {
  const payload = Buffer.from(data)
  if (payload.length > WS_MAX_BYTES) throw new Error('WEBSOCKET_TOO_LARGE')
  if (![1, 8, 10].includes(opcode) || (opcode >= 8 && payload.length > 125) || mask.length !== 4) throw new Error('INVALID_WEBSOCKET_FRAME')
  const lengthBytes = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8
  const header = Buffer.alloc(2 + lengthBytes + 4)
  header[0] = 0x80 | opcode
  header[1] = 0x80 | (lengthBytes === 0 ? payload.length : lengthBytes === 2 ? 126 : 127)
  if (lengthBytes === 2) header.writeUInt16BE(payload.length, 2)
  if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(payload.length), 2)
  Buffer.from(mask).copy(header, 2 + lengthBytes)
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  return Buffer.concat([header, payload])
}

export const createFrameDecoder = () => {
  let buffer = Buffer.alloc(0), fragments = [], messageBytes = 0, isFragmented = false, isClosed = false
  const text = payload => new TextDecoder('utf-8', { fatal: true }).decode(payload)
  return chunk => {
    if (isClosed) return []
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk)
    const events = []
    let offset = 0
    while (buffer.length - offset >= 2) {
      const first = buffer[offset], second = buffer[offset + 1]
      const isFinal = !!(first & 0x80), opcode = first & 0x0f, lengthKind = second & 0x7f
      if ((first & 0x70) || (second & 0x80) || ![0, 1, 8, 9, 10].includes(opcode)) throw new Error('INVALID_WEBSOCKET_FRAME')
      if (opcode >= 8 && (!isFinal || lengthKind > 125)) throw new Error('INVALID_WEBSOCKET_FRAME')
      if ((opcode === 0 && !isFragmented) || (opcode === 1 && isFragmented)) throw new Error('INVALID_WEBSOCKET_FRAME')
      const headerBytes = lengthKind < 126 ? 2 : lengthKind === 126 ? 4 : 10
      if (buffer.length - offset < headerBytes) break
      const length = lengthKind < 126 ? BigInt(lengthKind) : lengthKind === 126 ? BigInt(buffer.readUInt16BE(offset + 2)) : buffer.readBigUInt64BE(offset + 2)
      if (length > BigInt(WS_MAX_BYTES) || (opcode < 8 && length + BigInt(messageBytes) > BigInt(WS_MAX_BYTES))) throw new Error('WEBSOCKET_TOO_LARGE')
      if ((lengthKind === 126 && length < 126n) || (lengthKind === 127 && length < 65536n)) throw new Error('INVALID_WEBSOCKET_FRAME')
      const size = Number(length)
      if (buffer.length - offset - headerBytes < size) break
      const payload = buffer.subarray(offset + headerBytes, offset + headerBytes + size)
      offset += headerBytes + size
      if (opcode === 8) {
        if (size === 1) throw new Error('INVALID_WEBSOCKET_FRAME')
        events.push({ type: 'close', payload })
        isClosed = true
        break
      }
      if (opcode === 9) { events.push({ type: 'ping', payload }); continue }
      if (opcode === 10) continue
      if (opcode === 1 && isFinal) events.push({ type: 'text', text: text(payload) })
      else {
        fragments.push(payload)
        messageBytes += size
        isFragmented = !isFinal
        if (isFinal) {
          events.push({ type: 'text', text: text(Buffer.concat(fragments, messageBytes)) })
          fragments = []
          messageBytes = 0
        }
      }
    }
    buffer = isClosed ? Buffer.alloc(0) : Buffer.from(buffer.subarray(offset))
    return events
  }
}

export const openWebSocketStdio = ({ input, output, onMessage, onClose }) => {
  const key = randomBytes(16).toString('base64'), decode = createFrameDecoder()
  let headers = Buffer.alloc(0), isOpen = false, isClosed = false, resolveReady, rejectReady
  const ready = new Promise((done, reject) => { resolveReady = done; rejectReady = reject })
  const finish = error => {
    if (isClosed) return
    isClosed = true
    clearTimeout(timer)
    input.removeListener('data', read)
    headers = Buffer.alloc(0)
    rejectReady(error)
    onClose?.(error)
  }
  const ended = () => finish(new Error(isOpen ? 'OWNER_DISCONNECTED' : 'OWNER_HANDSHAKE_FAILED'))
  const writeFrame = (data, opcode = 1) => output.write(encodeClientFrame(data, randomBytes(4), opcode))
  const read = chunk => {
    if (isClosed) return
    try {
      if (!isOpen) {
        headers = Buffer.concat([headers, chunk])
        if (headers.length >= 5 && headers.subarray(0, 5).toString('ascii') !== 'HTTP/') { ended(); return }
        const end = headers.indexOf('\r\n\r\n')
        if (end < 0) { if (headers.length > WS_MAX_BYTES) ended(); return }
        if (end + 4 > WS_MAX_BYTES || !isWebSocketUpgrade(headers.subarray(0, end).toString('latin1'), key)) { ended(); return }
        chunk = headers.subarray(end + 4)
        headers = Buffer.alloc(0)
        isOpen = true
        clearTimeout(timer)
        resolveReady()
      }
      for (const event of decode(chunk)) {
        if (isClosed) break
        if (event.type === 'text') onMessage(event.text)
        if (event.type === 'ping') writeFrame(event.payload, 10)
        if (event.type === 'close') { writeFrame(event.payload, 8); ended() }
      }
    } catch { ended() }
  }
  const timer = setTimeout(() => finish(new Error('OWNER_TIMEOUT')), 5000)
  input.on('data', read)
  input.once('end', ended)
  input.once('close', ended)
  input.on('error', ended)
  output.on('error', ended)
  try { output.write(webSocketHandshake(key)) } catch { ended() }
  return {
    ready,
    send: message => {
      if (!isOpen || isClosed) throw new Error('OWNER_DISCONNECTED')
      try { writeFrame(message) } catch (error) { ended(); throw error }
    },
    close: () => finish(new Error('OWNER_DISCONNECTED')),
  }
}

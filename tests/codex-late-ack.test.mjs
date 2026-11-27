import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { messagingReceiver, startCodexReceiver } from '../scripts/codex-receiver.mjs'

// Fail-first acceptance tests for #1796: when a Codex session's board connection
// disconnects or is contested mid-turn, or a final ACK receipt hits a busy store (503),
// a completed ACK <nonce> still settles the message to acknowledged instead of remaining DISCONNECTED.
const importTs = async path => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  try { return await import(path) } finally { resolver.deregister() }
}

const tsMod = await (async () => ({
  ...await importTs('../scripts/board-messaging.ts'),
  ...await importTs('../hooks/message-status.ts'),
  ...await importTs('../hooks/messaging.ts'),
  ...await importTs('../hooks/strings-en.ts'),
}))()

const codexMock = fileURLToPath(new URL('./helpers/codex-daemon-mock.mjs', import.meta.url))
const THREAD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111'

const parseCodexLogCalls = text => {
  if (!text) return []
  const lines = text.split('\n')
  if (!text.endsWith('\n')) lines.pop()
  const entries = lines.map(line => line.trim()).filter(Boolean)
  const parsed = []
  for (let i = 0; i < entries.length; i += 1) {
    try { parsed.push(JSON.parse(entries[i])) } catch (error) {
      if (i === entries.length - 1) break
      throw error
    }
  }
  return parsed
}

const waitFor = async (fn, ms = 15_000, label = 'condition') => {
  const limit = Date.now() + ms
  while (Date.now() < limit) {
    const value = await fn()
    if (value) return value
    await new Promise(done => setTimeout(done, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const withHub = async (opts, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-late-ack-'))
  const messagesDir = join(dir, 'messages')
  mkdirSync(messagesDir, { recursive: true, mode: 0o700 })
  const token = 'synthetic-1796-token'
  const messaging = tsMod.createMessaging(messagesDir, false, { stateOfSession: () => 'idle', routes: [messagingReceiver] })
  let receiver = null
  const server = createServer((req, res) => {
    if (req.headers['x-board-token'] !== token) { res.writeHead(403); return res.end('{}') }
    if (req.url === '/api/board' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ messaging: messaging.snapshot(Date.now()) }))
    }
    if (req.url?.startsWith('/api/messages/') && req.method === 'POST') {
      const action = req.url.slice('/api/messages/'.length)
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        try {
          const body = JSON.parse(raw || '{}')
          const override = action === 'receipt'
            ? opts.onReceipt?.(body, {
                registerHolderSync: () => messaging.act('register', { agent: 'codex', session: THREAD_ID, surface: tsMod.SURFACE_IDS.cli, turn: 'session', scope: 'session' }, Date.now()),
              })
            : null
          if (override) {
            res.writeHead(override.status, { 'content-type': 'application/json' })
            return res.end(JSON.stringify(override.body))
          }
          const result = messaging.act(action, body, Date.now())
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          const message = err instanceof Error ? err.message : 'ERROR'
          res.writeHead(message === 'MESSAGE_STORE_BUSY' ? 503 : 409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: message }))
        }
      })
      return
    }
    res.writeHead(404); res.end('{}')
  })
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    const { port } = server.address()
    const address = `http://127.0.0.1:${port}/?t=${token}`
    const call = (action, body) => new Promise((resolve, reject) => {
      fetch(`http://127.0.0.1:${port}/api/messages/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-board-token': token }, body: JSON.stringify(body),
      }).then(async r => ({ status: r.status, body: await r.json() })).then(resolve, reject)
    })
    const snapshot = () => messaging.snapshot(Date.now())
    const messageOf = id => snapshot().messages.find(one => one.id === id)
    const connectionOf = () => waitFor(() => snapshot().connections.find(one => one.session === THREAD_ID && one.surface === tsMod.SURFACE_IDS.codexDaemon), 10_000, 'codexDaemon connection')
    const daemon = (subName, config = {}) => {
      const subDir = join(dir, subName)
      mkdirSync(subDir, { recursive: true })
      const file = join(subDir, 'mock.json'), log = join(subDir, 'rpc.log')
      writeFileSync(file, JSON.stringify({ log, loaded: [THREAD_ID], status: 'idle', start: 'ack', turn: 'turn-busy', ...config }))
      return {
        executable: codexMock,
        env: { ...process.env, CODEX_MOCK_CONFIG: file, AGENT_BOARD_TEST_PID: String(process.pid) },
        calls: () => parseCodexLogCalls(existsSync(log) ? readFileSync(log, 'utf8') : ''),
      }
    }
    const start = (d, extra = {}) => {
      receiver = startCodexReceiver({
        boardUrl: address, threads: () => [THREAD_ID], executable: d.executable, env: d.env,
        tickMs: 100, pollMs: 200, unloadMs: 400, unloadMarginMs: 400, ...extra,
      })
      return receiver
    }
    const stop = async () => { if (receiver) { await receiver.close(); receiver = null } }
    const send = (conn, id) => call('send', { id, target: conn.id, turn: 'session', text: 'Synthetic check for late ACK' })
    const registerHolder = async () => (await call('register', { agent: 'codex', session: THREAD_ID, surface: tsMod.SURFACE_IDS.cli, turn: 'session', scope: 'session' })).body
    const disconnectHolder = holder => call('disconnect', { connection: holder.id, secret: holder.secret, turn: 'session' })
    const starts = d => d.calls().filter(one => one.method === 'turn/start').length
    await fn({ dir, call, snapshot, messageOf, connectionOf, daemon, start, stop, send, registerHolder, disconnectHolder, starts })
  } finally {
    if (receiver) await receiver.close().catch(() => {})
    server.closeAllConnections?.()
    await new Promise(done => server.close(done))
    try { messaging.close?.() } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }) } catch {}
  }
}

test('a late Codex ACK after the board connection disconnects mid-turn acknowledges the message once the receiver re-attaches (#1796)', { timeout: 30_000 }, () => withHub({}, async f => {
  const ackFlag = join(f.dir, 'ack-now')
  const d = f.daemon('late-ack', { ackFlag })
  f.start(d)
  const conn = await f.connectionOf()
  assert.equal((await f.send(conn, 'AB-CX-1796-1')).status, 200)
  await waitFor(() => f.messageOf('AB-CX-1796-1')?.status === 'accepted', 10_000, 'accepted status')

  const holder = await f.registerHolder()
  await waitFor(() => !f.snapshot().connections.some(one => one.id === conn.id), 10_000, 'original connection disconnect')
  const mid = f.messageOf('AB-CX-1796-1')
  assert.equal(mid.status, 'accepted')
  assert.equal(mid.error, 'DISCONNECTED')
  assert.equal(tsMod.messageStatus(mid, Date.now(), tsMod.EN).state, 'unsure')

  writeFileSync(ackFlag, '')
  await waitFor(() => !existsSync(ackFlag), 10_000, 'daemon consumed ackFlag')
  await f.disconnectHolder(holder)

  const settled = await waitFor(() => {
    const one = f.messageOf('AB-CX-1796-1')
    return one?.status === 'acknowledged' ? one : null
  }, 10_000, 'late ACK acknowledgment')
  assert.equal(settled.error, '')
  assert.equal(tsMod.messageStatus(settled, Date.now(), tsMod.EN).state, 'read')
  assert.equal(f.starts(d), 1)
}))

test('a late Codex ACK after acceptance is refused as CONTESTED while turn/start is in flight still acknowledges once uncontested (#1796)', { timeout: 30_000 }, async () => {
  let holder = null
  await withHub({
    onReceipt: (body, helpers) => {
      if (body.status === 'accepted' && !holder) holder = helpers.registerHolderSync()
      return null
    },
  }, async f => {
    const ackFlag = join(f.dir, 'ack-contested')
    const d = f.daemon('contested-ack', { ackFlag })
    const errors = []
    f.start(d, { onError: error => errors.push(error.message) })
    const conn = await f.connectionOf()
    assert.equal((await f.send(conn, 'AB-CX-1796-2')).status, 200)

    await waitFor(() => errors.includes('CONTESTED'), 10_000, 'CONTESTED refusal on accepted')
    await waitFor(() => f.messageOf('AB-CX-1796-2')?.error === 'DISCONNECTED', 10_000, 'DISCONNECTED status after drop')

    writeFileSync(ackFlag, '')
    await waitFor(() => !existsSync(ackFlag), 10_000, 'daemon consumed ackFlag')
    assert.ok(holder)
    await f.disconnectHolder(holder)

    const settled = await waitFor(() => {
      const one = f.messageOf('AB-CX-1796-2')
      return one?.status === 'acknowledged' ? one : null
    }, 10_000, 'acknowledged after contested drop')
    assert.equal(settled.error, '')
    assert.equal(tsMod.messageStatus(settled, Date.now(), tsMod.EN).state, 'read')
    assert.equal(f.starts(d), 1)
  })
})

test('a Codex ACK receipt meeting a busy message store (503) retries via owed receipt to acknowledged, while a failed turn after disconnect is never acknowledged (#1796)', { timeout: 45_000 }, async () => {
  let ackAttempts = 0
  await withHub({
    onReceipt: body => {
      if (body.status === 'acknowledged') {
        ackAttempts += 1
        if (ackAttempts === 1) return { status: 503, body: { error: 'MESSAGE_STORE_BUSY' } }
      }
      return null
    },
  }, async f => {
    const d = f.daemon('busy-ack')
    f.start(d)
    const conn = await f.connectionOf()
    assert.equal((await f.send(conn, 'AB-CX-1796-3A')).status, 200)
    const settled = await waitFor(() => {
      const one = f.messageOf('AB-CX-1796-3A')
      return one?.status === 'acknowledged' ? one : null
    }, 10_000, 'acknowledged after 503 busy retry')
    assert.equal(ackAttempts, 2)
    assert.equal(settled.error, '')
    assert.equal(tsMod.messageStatus(settled, Date.now(), tsMod.EN).state, 'read')
    assert.equal(f.starts(d), 1)
  })

  await withHub({}, async f => {
    const ackFlag = join(f.dir, 'fail-turn')
    const d = f.daemon('failed-turn', { ackFlag, endStatus: 'failed' })
    f.start(d)
    const conn = await f.connectionOf()
    assert.equal((await f.send(conn, 'AB-CX-1796-3B')).status, 200)
    await waitFor(() => f.messageOf('AB-CX-1796-3B')?.status === 'accepted', 10_000, 'accepted before disconnect')

    const holder = await f.registerHolder()
    await waitFor(() => !f.snapshot().connections.some(one => one.id === conn.id), 10_000, 'connection disconnected')
    writeFileSync(ackFlag, '')
    await waitFor(() => !existsSync(ackFlag), 10_000, 'daemon consumed end flag')
    await f.disconnectHolder(holder)
    await waitFor(() => f.snapshot().connections.some(one => one.session === THREAD_ID && one.surface === tsMod.SURFACE_IDS.codexDaemon), 10_000, 'receiver re-attached')
    await new Promise(done => setTimeout(done, 400))

    const stays = f.messageOf('AB-CX-1796-3B')
    assert.equal(stays.status, 'accepted')
    assert.equal(stays.error, 'DISCONNECTED')
  })
})

test('a late Codex ACK that completes before a delayed turn/start answer arrives after board disconnect still acknowledges (#1796)', { timeout: 30_000 }, () => withHub({}, async f => {
  const ackFlag = join(f.dir, 'early-ack-delayed-start')
  const d = f.daemon('delayed-start-ack', { startDelay: 2000, ackFlag })
  const errors = []
  f.start(d, { pollMs: 150, tickMs: 100, onError: error => errors.push(error.message) })
  const conn = await f.connectionOf()
  assert.equal((await f.send(conn, 'AB-CX-1796-4')).status, 200)
  await waitFor(() => f.starts(d) === 1, 10_000, 'turn/start called')

  const holder = await f.registerHolder()
  await waitFor(() => !f.snapshot().connections.some(one => one.id === conn.id), 10_000, 'original connection disconnect')
  await waitFor(() => f.messageOf('AB-CX-1796-4')?.error === 'DISCONNECTED', 10_000, 'DISCONNECTED status after drop')

  writeFileSync(ackFlag, '')
  await waitFor(() => !existsSync(ackFlag), 10_000, 'daemon consumed ackFlag before delayed turn/start answered')
  await f.disconnectHolder(holder)

  const settled = await waitFor(() => {
    const one = f.messageOf('AB-CX-1796-4')
    return one?.status === 'acknowledged' ? one : null
  }, 10_000, 'acknowledged after delayed turn/start answer')
  assert.equal(settled.error, '')
  assert.equal(tsMod.messageStatus(settled, Date.now(), tsMod.EN).state, 'read')
  assert.equal(f.starts(d), 1)
  assert.equal(errors.includes('OWNER_DISCONNECTED'), false)
}))

test('closing the Codex receiver while leaving a thread after ACK still delivers the acknowledged receipt (#1796)', { timeout: 30_000 }, async () => {
  let ackAttempts = 0
  await withHub({
    onReceipt: body => {
      if (body.status === 'acknowledged') {
        ackAttempts += 1
        if (ackAttempts === 1) return { status: 503, body: { error: 'MESSAGE_STORE_BUSY' } }
      }
      return null
    },
  }, async f => {
    const d = f.daemon('close-while-leaving', { unsubscribeFaults: [400] })
    f.start(d)
    const conn = await f.connectionOf()
    assert.equal((await f.send(conn, 'AB-CX-1796-5')).status, 200)
    await waitFor(() => d.calls().some(one => one.method === 'thread/unsubscribe'), 10_000, 'thread/unsubscribe started')

    await f.stop()
    const settled = f.messageOf('AB-CX-1796-5')
    assert.equal(ackAttempts, 2)
    assert.equal(settled.status, 'acknowledged')
    assert.equal(settled.error, '')
    assert.equal(tsMod.messageStatus(settled, Date.now(), tsMod.EN).state, 'read')
    assert.equal(f.starts(d), 1)
  })
})

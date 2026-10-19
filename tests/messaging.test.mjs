import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { claimMessages, disconnectMessages, messageReceipt, queueMessage } from '../hooks/messaging.ts'
import { boardClient, connectionPrompt } from '../scripts/message-client.mjs'
import { observeSession } from '../hooks/messaging.ts'
import { connectCodexProxy } from '../scripts/codex-message-connector.mjs'
import { attachCodexSession } from '../scripts/codex-session-connector.mjs'
import { attachAntigravitySession } from '../scripts/antigravity-session-connector.mjs'

const pause = ms => new Promise(done => setTimeout(done, ms))
const boundedWait = async (promise, code) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(code)), 10000) })]) }
  finally { clearTimeout(timer) }
}
const target = { id: 'binding1', agent: 'codex', session: 'session1', turn: 'turn1', surface: 'fixture', expires: 2000 }
const input = { id: 'AB-TEST-001', target: target.id, turn: target.turn, text: '收到後請回覆 ACK AB-TEST-001，並回報目前任務狀態；不要修改檔案或執行其他動作。' }

test('messages require a live exact session and turn, and ignore no approval fields', () => {
  const state = { messages: [] }
  assert.throws(() => queueMessage(state, input, 'board', undefined, 1000), /OFFLINE/)
  assert.throws(() => queueMessage(state, input, 'board', target, 2000), /OFFLINE/)
  assert.throws(() => queueMessage(state, { ...input, turn: 'stale' }, 'board', target, 1000), /STALE_TURN/)
  assert.throws(() => queueMessage(state, { ...input, approve: true }, 'board', target, 1000), /UNKNOWN_FIELD/)
  assert.equal(state.messages.length, 0)
})

test('AB-TEST-001 deduplicates exact retries and rejects conflicting contents or sources', () => {
  const first = queueMessage({ messages: [] }, input, 'board', target, 1000)
  assert.equal(queueMessage(first.state, input, 'board', undefined, 5000).state, first.state)
  assert.throws(() => queueMessage(first.state, { ...input, text: 'Different' }, 'board', target, 1001), /ID_CONFLICT/)
  assert.throws(() => queueMessage(first.state, input, 'gemini:another', target, 1001), /ID_CONFLICT/)
  const claimed = claimMessages(first.state, target, 1001)
  assert.equal(claimed.messages.length, 1)
  assert.equal(claimed.state.messages[0].status, 'uncertain')
  assert.equal(claimMessages(claimed.state, target, 1002).messages.length, 0)
  assert.equal(disconnectMessages(claimed.state, target.id, 1003).messages[0].status, 'uncertain')
})

test('an idle or already claimed poll preserves the exact durable state', () => {
  const empty = { messages: [] }
  assert.equal(claimMessages(empty, target, 1000).state, empty)
  const queued = queueMessage(empty, input, 'board', target, 1000).state
  const claimed = claimMessages(queued, target, 1001)
  assert.notEqual(claimed.state, queued)
  assert.equal(claimMessages(claimed.state, target, 1002).state, claimed.state)
})

test('receive=false renews an authenticated lease without claiming queued work', async () => fixture(async (board, dir) => {
  const registered = (await board.call('/api/messages/register', { agent: 'fixture', session: 'busy-session', surface: 'Synthetic busy owner', turn: 'turn1' })).body
  const credentials = { connection: registered.id, secret: registered.secret, turn: 'turn1' }
  await board.call('/api/messages/send', { ...input, target: registered.id })
  const before = (await board.call('/api/board')).body.messaging.messages[0]
  const file = join(dir, 'messages', 'messages.json'), bytes = readFileSync(file), modified = statSync(file, { bigint: true }).mtimeNs
  writeFileSync(join(dir, 'message-clock-offset'), '10000')
  const deferred = await board.call('/api/messages/poll', { ...credentials, receive: false })
  assert.equal(deferred.status, 200)
  assert.deepEqual(deferred.body.messages, [])
  assert.ok(deferred.body.leaseMs > 0)
  assert.deepEqual((await board.call('/api/board')).body.messaging.messages[0], before)
  assert.deepEqual(readFileSync(file), bytes)
  assert.equal(statSync(file, { bigint: true }).mtimeNs, modified)
  // Advance only this disposable server's clock beyond the original lease.
  // Renewal must preserve the exact binding without consuming the queue.
  writeFileSync(join(dir, 'message-clock-offset'), '16000')
  assert.ok(Date.now() + 16000 > registered.expires)
  const renewed = (await board.call('/api/board')).body.messaging
  assert.ok(renewed.connections.some(one => one.id === registered.id))
  assert.equal(renewed.messages[0].status, 'queued')
  const invalid = await board.call('/api/messages/poll', { ...credentials, receive: 'yes' })
  assert.equal(invalid.body.error, 'INVALID_RECEIVE')
  const stale = await board.call('/api/messages/poll', { ...credentials, turn: 'stale', receive: false })
  assert.equal(stale.body.error, 'STALE_TURN')
  const forged = await board.call('/api/messages/poll', { ...credentials, receive: false, approve: true })
  assert.equal(forged.body.error, 'UNKNOWN_FIELD')
  const claimed = await board.call('/api/messages/poll', { ...credentials, receive: true })
  assert.equal(claimed.body.messages.length, 1)
  assert.equal((await board.call('/api/board')).body.messaging.messages[0].status, 'uncertain')
}, `const originalNow = Date.now
Date.now = () => originalNow() + (fs.existsSync(path.join(directory, 'message-clock-offset')) ? Number(fs.readFileSync(path.join(directory, 'message-clock-offset'), 'utf8')) : 0)
`))

for (const agent of ['codex', 'antigravity']) test(`busy native owners remain connected and can send: ${agent}`, async () => fixture(async board => {
  const session = '11111111-2222-4333-8444-555555555555'
  let current = agent === 'codex' ? { thread: session, status: 'idle', turn: null } : { session, status: 'idle', turns: 0, step: -1 }
  let listener, nativeCalls = 0, alive = true
  const transport = {
    listen: one => { listener = one; return () => { listener = null } },
    request: async (method, params) => {
      if (method === 'thread/loaded/list') return { data: [session] }
      assert.equal(method, 'turn/start'); nativeCalls++
      const id = 'codex-inbound'
      listener({ method: 'item/completed', params: { threadId: session, turnId: 'received-turn', item: { type: 'agentMessage', text: 'ACK ' + id } } })
      listener({ method: 'turn/completed', params: { threadId: session, turn: { id: 'received-turn', status: 'completed' } } })
      return { turn: { id: 'received-turn' } }
    },
    write: async () => {
      nativeCalls++
      const before = current.turns, step = current.step + 1
      listener({ event: 'step_update', step_update: { conversation_id: session, step_type: 'user_input', state: 'DONE', step_index: step } })
      current = { ...current, turns: before + 1, step }
      listener({ event: 'result', result: { conversation_id: session, num_turns: before + 1, status: 'SUCCESS', response: 'ACK antigravity-inbound' } })
    },
  }
  const options = { boardUrl: board.address, transport, state: () => current, verifyOwner: () => alive }
  const source = agent === 'codex' ? await attachCodexSession({ ...options, thread: session }) : await attachAntigravitySession({ ...options, session })
  const other = await boardClient(board.address).attach({ agent: 'fixture', session: 'target', surface: 'Synthetic receiver', turn: 'turn1', verify: async () => true, deliver: async message => 'ACK ' + message.id })
  try {
    current = agent === 'codex' ? { ...current, status: 'active', turn: 'native-user-turn' } : { ...current, status: 'active', step: 0 }
    await pause(2300) // An ordinary native turn crosses a real adapter poll.
    assert.ok((await board.call('/api/board')).body.messaging.connections.some(one => one.id === source.id))
    await source.send({ ...input, id: agent + '-outbound', target: other.id })
    await board.call('/api/messages/send', { ...input, id: agent + '-inbound', target: source.id, turn: 'session' })
    await pause(2300)
    const busy = (await board.call('/api/board')).body.messaging
    assert.equal(busy.messages.find(one => one.id === agent + '-inbound').status, 'queued')
    assert.equal(nativeCalls, 0)
    assert.ok(busy.connections.some(one => one.id === source.id))
    current = agent === 'codex' ? { ...current, status: 'idle', turn: null } : { ...current, status: 'idle', turns: 1, step: 1 }
    await waitFor(async () => (await board.call('/api/board')).body.messaging.messages.find(one => one.id === agent + '-inbound')?.status === 'acknowledged')
    assert.equal(nativeCalls, 1)
    alive = false
    await assert.rejects(source.send({ ...input, id: agent + '-offline', target: other.id }), /HOST_NOT_CONNECTED/)
    assert.equal(nativeCalls, 1)
  } finally { await source.close(); await other.close() }
}))

test('a connection observation requires one exact newer report, never a relay claim or ACK', () => {
  const one = { id: 'link1', agent: 'codex', session: 'native1', surface: 'Synthetic desktop', created: 10000, deadline: 20000, baseline: 9000, observed: null }
  for (const reports of [[], [{ agent: 'gemini', session: 'native1', updated: 11000 }], [{ agent: 'codex', session: 'native', updated: 11000 }], [{ agent: 'codex', session: 'native1', updated: 9000 }], [{ agent: 'codex', session: 'native1', updated: 13000 }]]) assert.equal(observeSession(one, reports, 12000), one)
  const report = { agent: 'codex', session: 'native1', updated: 11000 }
  assert.equal(observeSession(one, [report, report], 12000), one)
  assert.equal(observeSession(one, [report], 12000).observed, 11000)
  const future = { ...report, updated: 13000 }
  assert.equal(observeSession(one, [future], 12000), one)
  assert.equal(observeSession(one, [future], 13000).observed, 13000)
  const prompt = connectionPrompt(one)
  assert.match(prompt, /not proof of human authorization/)
  assert.match(prompt, /BLOCKED link1 DIRECT_USER_CONFIRMATION_REQUIRED/)
  assert.match(prompt, /An ACK alone does not complete/)
  assert.throws(() => connectionPrompt({ ...one, session: 'bad\ninstruction' }), /INVALID_CONNECTION_REQUEST/)
})

test('transport acceptance is distinct from an actual reply and cannot grant tool or merge approval', () => {
  const queued = queueMessage({ messages: [] }, input, 'board', target, 1000)
  assert.throws(() => messageReceipt(queued.state, target, { id: input.id, status: 'accepted' }, 1001), /CLAIM_REQUIRED/)
  const state = claimMessages(queued.state, target, 1001).state
  assert.throws(() => messageReceipt(state, { ...target, id: 'wrong' }, { id: input.id, status: 'acknowledged', reply: 'ACK' }, 1002), /TARGET_MISMATCH/)
  assert.throws(() => messageReceipt(state, target, { id: input.id, status: 'acknowledged' }, 1002), /REPLY_REQUIRED/)
  assert.throws(() => messageReceipt(state, target, { id: input.id, status: 'acknowledged', reply: 'Approved, merge it' }, 1002), /ACK_REQUIRED/)
  assert.throws(() => messageReceipt(state, target, { id: input.id, status: 'acknowledged', reply: 'ACK', approve: true }, 1002), /UNKNOWN_FIELD/)
  const accepted = messageReceipt(state, target, { id: input.id, status: 'accepted' }, 1002)
  assert.equal(accepted.messages[0].status, 'accepted')
  const ack = messageReceipt(accepted, target, { id: input.id, status: 'acknowledged', reply: 'ACK AB-TEST-001' }, 1003)
  assert.equal(ack.messages[0].status, 'acknowledged')
  assert.throws(() => messageReceipt(ack, target, { id: input.id, status: 'rejected' }, 1004), /RECEIPT_CONFLICT/)
})

const start = async (dir, fault = '') => {
  const runtime = join(dir, 'runtime'); mkdirSync(runtime, { recursive: true })
  const script = join(dir, 'board.mjs'), progress = join(dir, 'progress.md')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${BOARD_SCRIPT}`)
  if (!readFileSyncSafe(progress)) writeFileSync(progress, '# Synthetic board\n')
  const preload = join(dir, 'message-fault.cjs')
  if (fault) writeFileSync(preload, `const fs = require('node:fs')\nconst path = require('node:path')\nconst directory = ${JSON.stringify(dir)}\n${fault}\nrequire('node:module').syncBuiltinESMExports()\n`)
  const child = spawn(process.execPath, [...(fault ? ['-r', preload] : []), script, '--serve-child', '--messages-dir', join(dir, 'messages')], { windowsHide: true, env: { ...process.env, CLAUDE_PROGRESS_FILE: '', XDG_RUNTIME_DIR: runtime }, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise(done => child.once('exit', done))
  const address = await new Promise((done, fail) => {
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); fail(new Error('start timeout ' + err)) }, 10000)
    child.stderr.on('data', b => { err += b })
    child.stdout.on('data', b => { out += b; if (out.includes('\n')) { clearTimeout(timer); done(out.split('\n')[0].trim()) } })
    child.once('exit', code => { clearTimeout(timer); fail(new Error('start failed ' + code + ' ' + err)) })
  })
  const url = new URL(address)
  const call = async (path, body, headers = {}) => {
    const response = await fetch(new URL(path, url), { method: body === undefined ? 'GET' : 'POST', headers: { 'x-board-token': url.searchParams.get('t'), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const close = async () => { await call('/api/close', {}); await exited }
  return { address, call, close }
}
const readFileSyncSafe = file => { try { return readFileSync(file, 'utf8') } catch { return null } }
const fixture = async (fn, fault = '') => {
  const dir = mkdtempSync(join(tmpdir(), 'board-messages-'))
  const board = await start(dir, fault)
  try { await fn(board, dir) } finally { await board.close().catch(() => undefined); rmSync(dir, { recursive: true, force: true }) }
}
const waitFor = async fn => {
  // Poll + preflight + steer each have their own bounded request. The aggregate
  // must allow those deadlines on a busy Windows host without retrying delivery.
  const until = Date.now() + 20000
  while (Date.now() < until) { const found = await fn(); if (found) return found; await pause(100) }
  throw new Error('condition timed out')
}

test('installed Codex connect help and invalid bindings never start a host or reveal board secrets', async () => fixture(async (board, dir) => {
  const script = join(dir, 'board.mjs')
  const thread = '11111111-2222-4333-8444-555555555555'
  const env = { ...process.env, CODEX_THREAD_ID: thread }
  const help = spawnSync(process.execPath, [script, '--codex-connect', '--help'], { env, encoding: 'utf8', windowsHide: true, timeout: 5000 })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--codex-connect/)
  const base = { boardUrl: board.address, executable: join(dir, 'never-start-this.exe'), thread, turn: 'turn1' }
  for (const payload of [
    { ...base, thread: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    { ...base, approval: true },
    { ...base, boardUrl: 'https://example.com/?t=synthetic-secret' },
    { ...base, executable: 'relative-codex' },
    { ...base, endpoint: 'ws://example.com:4500' },
    { ...base, endpoint: 'ws://127.0.0.1:4500/?token=synthetic-secret' },
    { ...base, turn: '' },
    { ...base, joinLoaded: 'true' },
    'x'.repeat(16001),
  ]) {
    const result = spawnSync(process.execPath, [script, '--codex-connect'], { env, input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 5000 })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.ok(result.stderr.length < 200)
    assert.ok(!result.stdout.includes('connected'))
    assert.ok(!result.stderr.includes('OWNER_DISCONNECTED'), 'preflight must refuse before spawning a host')
    assert.ok(!result.stderr.includes(board.address))
    assert.ok(!result.stderr.includes('synthetic-secret'))
  }
  assert.deepEqual((await board.call('/api/board')).body.messaging.connections, [])
}))

test('a receiver publishes terminal close only after disconnecting and repeated close is harmless', async () => fixture(async board => {
  let owned = true, deliveries = 0
  const receiver = await boardClient(board.address).attach({ agent: 'fixture', session: 'close-lifecycle', turn: 'turn1', surface: 'Synthetic lifecycle', verify: async () => owned, deliver: async () => { deliveries++; return 'ACK NEVER' } })
  owned = false
  await boundedWait(receiver.closed, 'TERMINAL_CLOSE_NOT_PUBLISHED')
  assert.deepEqual((await board.call('/api/board')).body.messaging.connections, [])
  await Promise.all([receiver.close(), receiver.close()])
  assert.equal(deliveries, 0)
}))

test('installed Codex connect drives an exact synthetic proxy, records ACK once and exits on turn end', async () => fixture(async (board, dir) => {
  const thread = '11111111-2222-4333-8444-555555555555'
  const proxy = join(dir, 'synthetic-native.mjs'), log = join(dir, 'synthetic-rpc.log')
  writeFileSync(proxy, `import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';
const emit=v=>console.log(JSON.stringify(v));
createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);appendFileSync(${JSON.stringify(log)},line+'\\n');
if(v.method==='initialize')emit({id:v.id,result:{}});
if(v.method==='thread/loaded/list')emit({id:v.id,result:{data:[${JSON.stringify(thread)}],nextCursor:null}});
if(v.method==='thread/resume')emit({id:v.id,result:{thread:{id:${JSON.stringify(thread)},turns:[],status:{type:'active'}}}});
if(v.method==='turn/steer'){emit({id:v.id,result:{turnId:'turn1'}});emit({id:999,method:'item/commandExecution/requestApproval',params:{}});
setTimeout(()=>emit({method:'item/completed',params:{threadId:${JSON.stringify(thread)},turnId:'turn1',item:{type:'agentMessage',text:'ACK AB-TEST-001'}}}),150);
setTimeout(()=>emit({method:'turn/completed',params:{threadId:${JSON.stringify(thread)},turn:{id:'turn1',status:'completed'}}}),350);}
});`)
  const command = spawn(process.execPath, [join(dir, 'board.mjs'), '--codex-connect'], { env: { ...process.env, CODEX_THREAD_ID: thread }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  command.stdout.on('data', data => { stdout += data })
  command.stderr.on('data', data => { stderr += data })
  const exited = new Promise(done => command.once('exit', (code, signal) => done({ code, signal })))
  command.stdin.end(JSON.stringify({ boardUrl: board.address, executable: proxy, thread, turn: 'turn1', surface: 'Synthetic CLI command test' }))
  try {
    const receiver = await waitFor(async () => (await board.call('/api/board')).body.messaging.connections[0])
    const sent = { ...input, target: receiver.id }
    await board.call('/api/messages/send', sent)
    const receipt = await waitFor(async () => {
      const message = (await board.call('/api/board')).body.messaging.messages[0]
      return message?.status === 'acknowledged' && message
    })
    assert.equal(receipt.reply, 'ACK AB-TEST-001')
    const exit = await boundedWait(exited, 'CONNECT_COMMAND_DID_NOT_EXIT')
    assert.equal(exit.code, 0, stderr)
    assert.match(stdout, /connected/)
    assert.ok(!stdout.includes(thread))
    assert.ok(!stdout.includes(receiver.id))
    assert.ok(!stdout.includes(board.address))
    assert.deepEqual((await board.call('/api/board')).body.messaging.connections, [])
    assert.equal((await board.call('/api/messages/send', sent)).body.status, 'acknowledged')
    assert.equal((await board.call('/api/messages/send', { ...sent, text: 'Changed content' })).body.error, 'ID_CONFLICT')
    assert.equal((await board.call('/api/messages/send', { ...sent, id: 'AB-OFFLINE' })).body.error, 'OFFLINE')
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(calls.filter(value => value.method === 'turn/steer').length, 1)
    assert.equal(calls.find(value => value.method === 'turn/steer').params.expectedTurnId, 'turn1')
    assert.ok(calls.every(value => value.id !== 999))
    assert.deepEqual(calls.filter(value => value.method === 'thread/resume').map(value => value.params), [{ threadId: thread, excludeTurns: true }])
    assert.ok(calls.every(value => !['thread/start', 'thread/read'].includes(value.method)))
  } finally {
    if (command.exitCode === null && command.signalCode === null) command.kill()
    await exited
  }
}))

// A synthetic WebSocket owner, not an AI host. It accepts only the small text
// frames used by this test and never loads a native application or credential.
const websocketOwner = async (thread, { isLoaded = true, joined = {}, isSteerRejected = false } = {}) => {
  const server = createServer(), sockets = new Set(), calls = []
  let client
  const emit = value => {
    const payload = Buffer.from(JSON.stringify(value, null, 2))
    const header = Buffer.alloc(payload.length < 126 ? 2 : 4)
    header[0] = 0x81
    if (payload.length < 126) header[1] = payload.length
    else { header[1] = 126; header.writeUInt16BE(payload.length, 2) }
    client.write(Buffer.concat([header, payload]))
  }
  server.on('upgrade', (request, socket) => {
    client = socket; sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    const key = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + key + '\r\n\r\n')
    let buffered = Buffer.alloc(0)
    socket.on('data', data => {
      buffered = Buffer.concat([buffered, data])
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15, masked = (buffered[1] & 128) !== 0
        let length = buffered[1] & 127, offset = 2
        if (length === 127 || !masked) { socket.destroy(); return }
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4 }
        if (buffered.length < offset + 4 + length) return
        const mask = buffered.subarray(offset, offset + 4), payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length))
        buffered = buffered.subarray(offset + 4 + length)
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return }
        if (opcode !== 1) { socket.destroy(); return }
        const value = JSON.parse(payload.toString('utf8')); calls.push(value)
        if (value.method === 'initialize') emit({ id: value.id, result: {} })
        if (value.method === 'thread/loaded/list') emit({ id: value.id, result: { data: isLoaded ? [thread] : [] } })
        if (value.method === 'thread/resume') emit({ id: value.id, result: { thread: { id: thread, turns: [], status: { type: 'active' }, ...joined } } })
        if (value.method === 'turn/steer') {
          if (isSteerRejected) { emit({ id: value.id, error: { code: -32600, message: 'Synthetic stale turn' } }); continue }
          emit({ id: value.id, result: { turnId: 'turn1' } })
          emit({ id: 999, method: 'item/commandExecution/requestApproval', params: {} })
          emit({ method: 'item/completed', params: { threadId: thread, turnId: 'wrong-turn', item: { type: 'agentMessage', text: 'ACK AB-TEST-001' } } })
        }
      }
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { endpoint: `ws://127.0.0.1:${server.address().port}`, calls, emit, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)) } }
}

test('installed Codex connect joins only metadata on an explicit synthetic WebSocket owner', async () => fixture(async (board, dir) => {
  const thread = '11111111-2222-4333-8444-555555555555', owner = await websocketOwner(thread)
  const command = spawn(process.execPath, [join(dir, 'board.mjs'), '--codex-connect'], { env: { ...process.env, CODEX_THREAD_ID: thread }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  command.stdout.on('data', data => { stdout += data }); command.stderr.on('data', data => { stderr += data })
  const exited = new Promise(done => command.once('exit', done))
  command.stdin.end(JSON.stringify({ boardUrl: board.address, endpoint: owner.endpoint, thread, turn: 'turn1' }))
  try {
    const receiver = await waitFor(async () => (await board.call('/api/board')).body.messaging.connections[0])
    await board.call('/api/messages/send', { ...input, target: receiver.id })
    await waitFor(() => owner.calls.some(value => value.method === 'turn/steer'))
    assert.notEqual((await board.call('/api/board')).body.messaging.messages[0].status, 'acknowledged', 'a wrong-turn ACK cannot acknowledge delivery')
    owner.emit({ method: 'item/completed', params: { threadId: thread, turnId: 'turn1', item: { type: 'agentMessage', text: 'ACK AB-TEST-001' } } })
    assert.notEqual((await board.call('/api/board')).body.messaging.messages[0].status, 'acknowledged', 'native turn completion is required')
    owner.emit({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn1', status: 'completed' } } })
    await waitFor(async () => (await board.call('/api/board')).body.messaging.messages[0]?.status === 'acknowledged')
    assert.equal(await boundedWait(exited, 'WEBSOCKET_CONNECT_DID_NOT_EXIT'), 0, stderr)
    assert.deepEqual((await board.call('/api/board')).body.messaging.connections, [])
    assert.ok(!stdout.includes(thread) && !stdout.includes(owner.endpoint) && !stdout.includes(board.address))
    assert.deepEqual(owner.calls.filter(value => value.method === 'thread/resume').map(value => value.params), [{ threadId: thread, excludeTurns: true }])
    assert.ok(owner.calls.every(value => !['thread/start', 'thread/read'].includes(value.method) && value.id !== 999))
  } finally {
    if (command.exitCode === null && command.signalCode === null) command.kill()
    await exited; await owner.close()
  }
}))

test('Codex metadata joining refuses unloaded, idle, foreign or history-bearing targets before registration', async () => fixture(async (board, dir) => {
  const thread = '11111111-2222-4333-8444-555555555555'
  for (const options of [
    { isLoaded: false },
    { joined: { status: { type: 'idle' } } },
    { joined: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } },
    { joined: { turns: [{ id: 'synthetic-history' }] } },
  ]) {
    const owner = await websocketOwner(thread, options)
    const command = spawn(process.execPath, [join(dir, 'board.mjs'), '--codex-connect'], { env: { ...process.env, CODEX_THREAD_ID: thread }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    command.stdout.on('data', data => { stdout += data }); command.stderr.on('data', data => { stderr += data })
    const exited = new Promise(done => command.once('exit', done))
    command.stdin.end(JSON.stringify({ boardUrl: board.address, endpoint: owner.endpoint, thread, turn: 'turn1' }))
    try {
      assert.equal(await boundedWait(exited, 'INVALID_JOIN_DID_NOT_EXIT'), 1)
      assert.match(stderr, options.isLoaded === false ? /HOST_NOT_CONNECTED/ : /ACTIVE_THREAD_REQUIRED/)
      assert.ok(!stdout.includes('connected'))
      assert.deepEqual((await board.call('/api/board')).body.messaging.connections, [])
      const joins = owner.calls.filter(value => value.method === 'thread/resume')
      assert.equal(joins.length, options.isLoaded === false ? 0 : 1)
      if (joins.length) assert.deepEqual(joins[0].params, { threadId: thread, excludeTurns: true })
      assert.ok(!owner.calls.some(value => value.method === 'turn/steer' || value.method === 'thread/start'))
    } finally {
      if (command.exitCode === null && command.signalCode === null) command.kill()
      await exited; await owner.close()
    }
  }
}))

test('a rejected Codex steer keeps its uncertainty receipt before disconnecting and cannot replay', async () => fixture(async board => {
  const thread = '11111111-2222-4333-8444-555555555555', owner = await websocketOwner(thread, { isSteerRejected: true })
  const errors = []
  const receiver = await connectCodexProxy({ boardUrl: board.address, endpoint: owner.endpoint, thread, turn: 'turn1', joinLoaded: true, onError: error => { errors.push(error.message) } })
  try {
    const sent = { ...input, target: receiver.id }
    await board.call('/api/messages/send', sent)
    await boundedWait(receiver.closed, 'REJECTED_STEER_DID_NOT_CLOSE')
    const model = (await board.call('/api/board')).body.messaging
    assert.equal(model.messages[0].status, 'uncertain')
    assert.equal(model.messages[0].error, 'OWNER_REJECTED')
    assert.equal(model.messages[0].reply, '')
    assert.deepEqual(model.connections, [])
    assert.deepEqual(errors, ['OWNER_REJECTED'])
    assert.equal((await board.call('/api/messages/send', sent)).body.status, 'uncertain')
    assert.equal((await board.call('/api/messages/send', { ...sent, text: 'Changed content' })).body.error, 'ID_CONFLICT')
    assert.equal((await board.call('/api/messages/send', { ...sent, id: 'AB-OFFLINE' })).body.error, 'OFFLINE')
    assert.equal(owner.calls.filter(value => value.method === 'turn/steer').length, 1)
  } finally { await receiver.close(); await owner.close() }
}))

test('a proxy ACK in a failed native Codex turn remains uncertain', async () => fixture(async board => {
  const thread = '11111111-2222-4333-8444-555555555555', owner = await websocketOwner(thread)
  const receiver = await connectCodexProxy({ boardUrl: board.address, endpoint: owner.endpoint, thread, turn: 'turn1', joinLoaded: true })
  try {
    await board.call('/api/messages/send', { ...input, target: receiver.id })
    await waitFor(() => owner.calls.some(value => value.method === 'turn/steer'))
    owner.emit({ method: 'item/completed', params: { threadId: thread, turnId: 'turn1', item: { type: 'agentMessage', text: 'ACK AB-TEST-001' } } })
    owner.emit({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn1', status: 'failed' } } })
    await boundedWait(receiver.closed, 'FAILED_TURN_DID_NOT_CLOSE')
    const result = (await board.call('/api/board')).body.messaging.messages[0]
    assert.equal(result.status, 'uncertain')
    assert.equal(result.error, 'TURN_NOT_COMPLETED')
    assert.equal(result.reply, '')
  } finally { await receiver.close(); await owner.close() }
}))

test('a transient message-store rename failure recovers polling without replaying delivery', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EAGAIN']) await fixture(async (board, dir) => {
    const errors = [], deliveries = []
    const receiver = await boardClient(board.address).attach({
      agent: 'fixture', session: 'storage-recovery', turn: 'turn1', surface: 'Synthetic storage recovery', verify: async () => true,
      onError: error => errors.push(error), deliver: async message => { deliveries.push(message.id); return 'ACK ' + message.id },
    })
    try {
      const message = { ...input, target: receiver.id }
      writeFileSync(join(dir, 'fail-message-rename'), code)
      await board.call('/api/messages/send', message)
      const file = join(dir, 'messages', 'messages.json'), before = readFileSync(file, 'utf8')
      await waitFor(() => errors.length > 0)
      assert.equal(errors[0].message, 'MESSAGE_STORE_BUSY')
      assert.equal(errors[0].isRetryable, true)
      assert.equal(readFileSync(file, 'utf8'), before)
      assert.deepEqual(deliveries, [])
      const failed = (await board.call('/api/board')).body.messaging
      assert.ok(failed.connections.some(one => one.id === receiver.id))
      assert.equal(failed.messages[0].status, 'queued')
      assert.equal(failed.messages[0].reply, '')
      await waitFor(async () => (await board.call('/api/board')).body.messaging.messages[0]?.status === 'acknowledged')
      await board.call('/api/messages/send', message)
      assert.deepEqual(deliveries, [input.id])
    } finally { await receiver.close() }
  }, `const original = fs.renameSync
fs.renameSync = (from, to) => {
  const flag = path.join(directory, 'fail-message-rename')
  if (String(to) === path.join(directory, 'messages', 'messages.json') && fs.existsSync(flag) && JSON.parse(fs.readFileSync(from, 'utf8')).messages.some(one => one.status === 'uncertain')) {
    const code = fs.readFileSync(flag, 'utf8'); fs.unlinkSync(flag)
    throw Object.assign(new Error('synthetic message rename failure'), { code })
  }
  return original(from, to)
}`)
})

// A disposable loopback proxy faults only heartbeat responses. The real store still
// decides whether a message was durably claimed before the response was lost.
const pollingProxy = async (board, mode) => {
  const upstream = new URL(board.address)
  let faults = 0, polls = 0, registrations = 0
  const server = createServer(async (req, res) => {
    try {
      let body = ''
      for await (const chunk of req) body += chunk
      const isPoll = req.url === '/api/messages/poll'
      if (isPoll) polls += 1
      if (req.url === '/api/messages/register') registrations += 1
      const fail = code => {
        faults += 1
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'SYNTHETIC_POLL_FAILURE' }))
      }
      if (isPoll && (faults === 0 || mode === 'always') && mode !== 'after-claim') {
        if (mode === 'network' || mode === 'timeout') {
          faults += 1
          if (mode === 'network') req.socket.destroy()
          return
        }
        if (mode === 'malformed') { faults += 1; res.writeHead(200); res.end('{'); return }
        return fail(mode === 'forbidden' ? 403 : mode === 'stale' ? 409 : 503)
      }
      const answer = await fetch(new URL(req.url, upstream), {
        method: req.method, headers: { 'x-board-token': upstream.searchParams.get('t'), 'content-type': 'application/json' }, body,
      })
      const text = await answer.text()
      if (isPoll && faults === 0 && mode === 'after-claim' && JSON.parse(text).messages?.length) return fail(503)
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(text)
    } catch { res.writeHead(502); res.end('{}') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return {
    address: `http://127.0.0.1:${server.address().port}/?t=${upstream.searchParams.get('t')}`,
    faults: () => faults, polls: () => polls, registrations: () => registrations,
    close: () => new Promise(done => { server.close(done); server.closeAllConnections() }),
  }
}

test('a temporary poll failure preserves a verified connection and delivers a queued message once', async () => {
  for (const mode of ['before-claim', 'network', 'timeout']) await fixture(async board => {
    const proxy = await pollingProxy(board, mode)
    const errors = [], delivered = []
    const receiver = await boardClient(proxy.address).attach({
      agent: 'fixture', session: 'recovery', turn: 'turn1', surface: 'Synthetic recovery adapter', verify: async () => true,
      onError: error => errors.push(error), deliver: async one => { delivered.push(one.id); return 'ACK ' + one.id },
    })
    try {
      await waitFor(() => errors.length === 1)
      assert.ok((await board.call('/api/board')).body.messaging.connections.some(one => one.id === receiver.id))
      const sent = { ...input, target: receiver.id }
      await board.call('/api/messages/send', sent)
      await waitFor(async () => (await board.call('/api/board')).body.messaging.messages[0]?.status === 'acknowledged')
      await board.call('/api/messages/send', sent)
      await pause(2200)
      assert.deepEqual(delivered, [input.id])
      assert.equal(proxy.faults(), 1)
      assert.equal(proxy.registrations(), 1)
      assert.ok(proxy.polls() >= 2)
    } finally { await receiver.close(); await proxy.close() }
  })
})

test('a lost poll response after durable claiming is never replayed or turned into an ACK', async () => fixture(async board => {
  const proxy = await pollingProxy(board, 'after-claim')
  const errors = []
  let deliveries = 0
  const receiver = await boardClient(proxy.address).attach({
    agent: 'fixture', session: 'lost-claim', turn: 'turn1', surface: 'Synthetic lost-response adapter', verify: async () => true,
    onError: error => errors.push(error), deliver: async one => { deliveries += 1; return 'ACK ' + one.id },
  })
  try {
    const sent = { ...input, target: receiver.id }
    await board.call('/api/messages/send', sent)
    await waitFor(() => errors.length === 1)
    const failedPoll = proxy.polls()
    await waitFor(() => proxy.polls() > failedPoll)
    const snapshot = (await board.call('/api/board')).body.messaging
    assert.ok(snapshot.connections.some(one => one.id === receiver.id))
    assert.equal(snapshot.messages[0].status, 'uncertain')
    assert.equal(snapshot.messages[0].reply, '')
    assert.equal((await board.call('/api/messages/send', sent)).body.status, 'uncertain')
    assert.equal((await board.call('/api/messages/send', { ...sent, text: 'Conflict' })).body.error, 'ID_CONFLICT')
    assert.equal(deliveries, 0)
    assert.equal(proxy.registrations(), 1)
  } finally { await receiver.close(); await proxy.close() }
}))

test('a forbidden or stale heartbeat closes the connection instead of retrying authentication', async () => {
  for (const mode of ['forbidden', 'stale', 'malformed']) await fixture(async board => {
    const proxy = await pollingProxy(board, mode)
    const errors = []
    const receiver = await boardClient(proxy.address).attach({
      agent: 'fixture', session: 'forbidden', turn: 'turn1', surface: 'Synthetic forbidden adapter', verify: async () => true,
      onError: error => errors.push(error), deliver: async () => { throw Error('MUST_NOT_DELIVER') },
    })
    try {
      await waitFor(() => errors.length === 1)
      await waitFor(async () => !(await board.call('/api/board')).body.messaging.connections.some(one => one.id === receiver.id))
      await assert.rejects(receiver.send({ ...input, target: receiver.id }), /HOST_NOT_CONNECTED/)
      await pause(2200)
      assert.equal(proxy.polls(), 1)
      assert.equal(proxy.registrations(), 1)
    } finally { await receiver.close(); await proxy.close() }
  })
})

test('temporary board failures cannot keep an expired connection alive', async () => fixture(async board => {
  const proxy = await pollingProxy(board, 'always')
  const errors = []
  const receiver = await boardClient(proxy.address).attach({
    agent: 'fixture', session: 'expired', turn: 'turn1', surface: 'Synthetic expired adapter', verify: async () => true,
    onError: error => errors.push(error), deliver: async () => { throw Error('MUST_NOT_DELIVER') },
  })
  try {
    await waitFor(() => errors.some(error => error.message === 'CONNECTION_EXPIRED'))
    assert.equal((await board.call('/api/board')).body.messaging.connections.some(one => one.id === receiver.id), false)
    await assert.rejects(receiver.send({ ...input, target: receiver.id }), /HOST_NOT_CONNECTED/)
    const polls = proxy.polls()
    await pause(2200)
    assert.equal(proxy.polls(), polls)
  } finally { await receiver.close(); await proxy.close() }
}))

test('native ownership loss during poll recovery closes the exact binding', async () => {
  for (const failure of [false, new TypeError('SYNTHETIC_OWNER_UNAVAILABLE')]) await fixture(async board => {
    const proxy = await pollingProxy(board, 'before-claim')
    const errors = []
    let isOwned = true
    const receiver = await boardClient(proxy.address).attach({
      agent: 'fixture', session: 'owner-lost', turn: 'turn1', surface: 'Synthetic owner-loss adapter',
      verify: async () => { if (!isOwned && failure instanceof Error) throw failure; return isOwned },
      onError: error => errors.push(error), deliver: async () => { throw Error('MUST_NOT_DELIVER') },
    })
    try {
      await waitFor(() => errors.length === 1)
      isOwned = false
      await waitFor(async () => !(await board.call('/api/board')).body.messaging.connections.some(one => one.id === receiver.id))
      await assert.rejects(receiver.send({ ...input, target: receiver.id }), /HOST_NOT_CONNECTED/)
      assert.equal(proxy.polls(), 1)
    } finally { await receiver.close(); await proxy.close() }
  })
})

test('handoffs time out visibly until exact fresh progress appears, independently of a live receiver', async () => fixture(async (board, dir) => {
  const client = boardClient(board.address)
  const request = { id: 'link1', agent: 'antigravity', session: 'native1', surface: 'Synthetic CLI', timeoutMs: 1000 }
  const progress = updated => `## Synthetic\n<!-- auto session=12345678 agent=antigravity state=working updated=${new Date(updated).toISOString()} resume=native1 -->\n### Fixture\n- [~] Explicit report\n<!-- /auto session=12345678 -->\n`
  const old = Date.now() - 60000
  writeFileSync(join(dir, 'progress.md'), progress(old))
  const first = await client.expect(request)
  assert.deepEqual(await client.expect(request), first)
  assert.equal((await board.call('/api/messages/expect', { ...request, approve: true })).body.error, 'UNKNOWN_FIELD')
  assert.equal((await board.call('/api/messages/expect', request, { origin: new URL(board.address).origin })).status, 403)
  assert.equal((await board.call('/api/messages/expect', { ...request, session: 'native2' })).body.error, 'ID_CONFLICT')
  let row = (await board.call('/api/board')).body.messaging.sessions[0]
  assert.equal(row.status, 'waiting'); assert.equal(row.progress, true); assert.equal(row.receiving, false)
  const receiver = await client.attach({ agent: request.agent, session: request.session, surface: 'Synthetic CLI', scope: 'session', turn: 'session', verify: async () => true, deliver: async message => 'ACK ' + message.id })
  try {
    await client.send({ id: 'setup1', target: receiver.id, turn: 'session', text: 'Synthetic setup request' })
    await waitFor(async () => (await board.call('/api/board')).body.messaging.messages[0]?.status === 'acknowledged')
    row = (await board.call('/api/board')).body.messaging.sessions[0]
    assert.equal(row.status, 'timed_out'); assert.equal(row.receiving, true)
    writeFileSync(join(dir, 'progress.md'), progress(Date.now()).replace('resume=native1', 'resume=native10'))
    assert.equal((await board.call('/api/board')).body.messaging.sessions[0].status, 'timed_out')
    // Force the report briefly ahead of the server clock. Keep the future-time gate,
    // then observe through polling as the page does; a write is not an immediate ACK.
    writeFileSync(join(dir, 'progress.md'), progress(Date.now() + 250))
    await waitFor(async () => (await board.call('/api/board')).body.messaging.sessions[0].status === 'reported')
  } finally { await receiver.close() }
  row = (await board.call('/api/board')).body.messaging.sessions[0]
  assert.equal(row.status, 'reported'); assert.equal(row.receiving, false)
  // No expectation or live receiver survives a board restart as a false connection.
  await board.close(); Object.assign(board, await start(dir))
  assert.deepEqual((await board.call('/api/board')).body.messaging.sessions, [])
}))

test('a live receiver without a progress card is visible and disappears on disconnect', async () => fixture(async board => {
  const receiver = await boardClient(board.address).attach({ agent: 'antigravity', session: 'native1', surface: 'Synthetic owned stream', scope: 'session', turn: 'session', verify: async () => true, deliver: async () => '' })
  const row = (await board.call('/api/board')).body.messaging.sessions[0]
  assert.equal(row.agent, 'antigravity'); assert.equal(row.progress, false); assert.equal(row.receiving, true)
  await receiver.close()
  assert.deepEqual((await board.call('/api/board')).body.messaging.sessions, [])
}))

test('the served message API authenticates connectors and persists claims across a server restart', async () => fixture(async (board, dir) => {
  const registration = { agent: 'codex', session: 'synthetic-session', turn: 'turn1', surface: 'Synthetic adapter' }
  assert.equal((await board.call('/api/messages/register', registration, { origin: new URL(board.address).origin })).status, 403)
  const connected = (await board.call('/api/messages/register', registration)).body
  assert.equal((await board.call('/api/messages/register', registration)).status, 409)
  const sent = { ...input, target: connected.id }
  assert.equal((await board.call('/api/messages/send', sent)).body.status, 'queued')
  assert.equal((await board.call('/api/messages/send', sent)).body.status, 'queued')
  assert.equal((await board.call('/api/messages/send', { ...sent, text: 'conflict' })).body.error, 'ID_CONFLICT')
  const credentials = { connection: connected.id, secret: connected.secret, turn: 'turn1' }
  assert.equal((await board.call('/api/messages/poll', { ...credentials, secret: 'wrong' })).status, 409)
  assert.equal((await board.call('/api/messages/poll', { ...credentials, turn: 'old' })).body.error, 'STALE_TURN')
  assert.equal((await board.call('/api/messages/poll', credentials)).body.messages.length, 1)
  assert.equal((await board.call('/api/messages/poll', credentials)).body.messages.length, 0)
  const snapshot = (await board.call('/api/board')).body.messaging
  assert.equal(snapshot.messages[0].status, 'uncertain')
  assert.ok(!JSON.stringify(snapshot).includes(connected.secret))
  await board.close()
  const restarted = await start(dir)
  Object.assign(board, restarted)
  assert.equal((await board.call('/api/messages/send', sent)).body.status, 'uncertain')
  assert.equal((await board.call('/api/messages/poll', credentials)).status, 409)
  assert.equal((await board.call('/api/board')).body.messaging.connections.length, 0)
}))

test('synthetic Claude, Codex and Gemini adapters can route messages and lose availability when disconnected', async () => fixture(async board => {
  const received = []
  const client = boardClient(board.address)
  const attach = agent => client.attach({ agent, session: 'fixture-' + agent, surface: 'Synthetic adapter', turn: 'turn1', verify: async () => true, deliver: async (message, accepted) => { received.push(message); await accepted(); return 'ACK ' + message.id } })
  const claude = await attach('claude'), codex = await attach('codex'), gemini = await attach('gemini')
  try {
    await claude.send({ ...input, target: codex.id })
    await waitFor(async () => (await board.call('/api/board')).body.messaging.messages[0]?.status === 'acknowledged')
    await codex.send({ ...input, id: 'AB-TEST-002', target: gemini.id })
    await waitFor(() => received.length === 2)
    assert.equal(received[0].from, 'claude:fixture-claude')
    assert.equal(received[1].from, 'codex:fixture-codex')
    await gemini.close()
    assert.equal((await board.call('/api/messages/send', { ...input, id: 'AB-TEST-003', target: gemini.id })).body.error, 'OFFLINE')
  } finally { await Promise.all([claude.close(), codex.close(), gemini.close()]) }
}))

test('an inactive source is refused before polling notices it and cannot enqueue a delivery', async () => fixture(async board => {
  let isAlive = true, deliveries = 0
  const client = boardClient(board.address)
  const source = await client.attach({ agent: 'fixture', session: 'source', surface: 'Synthetic', turn: 'turn1', verify: async () => isAlive, deliver: async () => { deliveries++; return 'ACK' } })
  const target = await client.attach({ agent: 'fixture', session: 'target', surface: 'Synthetic', turn: 'turn1', verify: async () => true, deliver: async () => { deliveries++; return 'ACK' } })
  try {
    isAlive = false
    await assert.rejects(source.send({ ...input, target: target.id }), /HOST_NOT_CONNECTED/)
    await assert.rejects(source.send({ ...input, target: target.id }), /HOST_NOT_CONNECTED/)
    const state = (await board.call('/api/board')).body.messaging
    assert.equal(state.messages.length, 0)
    assert.ok(!state.connections.some(one => one.id === source.id))
    assert.equal(deliveries, 0)
  } finally { await source.close(); await target.close() }
}))

test('portable agents share one durable synthetic hub without implicit native delivery or expiry', async () => fixture(async (board, dir) => {
  const names = ['codex', 'openclaw', 'opencode', 'grok', 'deepseek']
  const client = boardClient(board.address)
  const live = new Map(names.map(name => [name, true]))
  const delivered = []
  const receivers = []
  try {
    for (const agent of names) receivers.push(await client.attach({
      agent, session: 'synthetic-' + agent, surface: 'Synthetic contract only', turn: 'turn1',
      verify: async () => live.get(agent),
      deliver: async (message, accepted) => { delivered.push(message); await accepted(); return 'ACK ' + message.id },
    }))
    for (let i = 1; i < receivers.length; i++) {
      const other = receivers[i]
      for (const [source, target, suffix] of [[receivers[0], other, 'out'], [other, receivers[0], 'back']]) {
        const message = { ...input, id: `AB-${other.agent}-${suffix}`, target: target.id }
        await source.send(message)
        await waitFor(async () => (await board.call('/api/board')).body.messaging.messages.find(one => one.id === message.id)?.status === 'acknowledged')
        const count = delivered.length
        await source.send(message)
        assert.equal(delivered.length, count)
        await assert.rejects(source.send({ ...message, text: 'Conflict' }), /ID_CONFLICT/)
      }
    }
    assert.equal(delivered.length, 8)
    assert.ok(delivered.every(one => names.some(name => one.from === name + ':synthetic-' + name)))
    live.set('deepseek', false)
    await assert.rejects(receivers[4].send({ ...input, id: 'offline-source', target: receivers[0].id }), /HOST_NOT_CONNECTED/)
    await assert.rejects(receivers[0].send({ ...input, id: 'offline-target', target: receivers[4].id }), /OFFLINE/)
  } finally { for (const receiver of receivers) await receiver.close() }
  const store = JSON.parse(readFileSync(join(dir, 'messages', 'messages.json'), 'utf8'))
  assert.equal(store.messages.length, 8)
  // Three-day task archiving must not expire message ids and permit replay.
  const original = store.messages[0]
  const retry = { id: original.id, target: original.target, turn: original.turn, text: original.text }
  assert.equal(queueMessage(store, retry, original.from, undefined, Date.now() + 4 * 86400000).state, store)
}))

test('an expired connector disappears and cannot take a queued message', { timeout: 40000 }, async () => fixture(async board => {
  const connected = (await board.call('/api/messages/register', { agent: 'claude', session: 'fixture', turn: 'turn1', surface: 'Synthetic adapter' })).body
  await board.call('/api/messages/send', { ...input, target: connected.id })
  await pause(15100)
  const model = (await board.call('/api/board')).body.messaging
  assert.equal(model.connections.length, 0)
  assert.equal(model.messages[0].status, 'rejected')
  assert.equal((await board.call('/api/messages/poll', { connection: connected.id, secret: connected.secret, turn: 'turn1' })).status, 409)
}))

test('an adapter timeout becomes explicit uncertainty and never triggers another delivery', async () => fixture(async board => {
  let deliveries = 0
  const receiver = await boardClient(board.address).attach({
    agent: 'fixture', session: 'timeout-session', turn: 'turn1', surface: 'Synthetic timeout adapter', verify: async () => true,
    deliver: async (_message, accepted) => { deliveries += 1; await accepted(); throw new Error('ACK_TIMEOUT') },
  })
  try {
    const sent = { ...input, target: receiver.id }
    await board.call('/api/messages/send', sent)
    const uncertain = await waitFor(async () => {
      const one = (await board.call('/api/board')).body.messaging.messages[0]
      return one?.status === 'uncertain' && one.error === 'ACK_TIMEOUT' && one
    })
    assert.equal(uncertain.error, 'ACK_TIMEOUT')
    await board.call('/api/messages/send', sent)
    await pause(2200)
    assert.equal(deliveries, 1)
  } finally { await receiver.close() }
}))

test('a mock Codex proxy keeps steering and native ACK separate and never answers approval RPCs', async () => fixture(async (board, dir) => {
  const thread = '11111111-2222-4333-8444-555555555555'
  const fake = join(dir, 'proxy.mjs'), log = join(dir, 'rpc.log')
  writeFileSync(fake, `import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';
const emit=v=>console.log(JSON.stringify(v));
createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);appendFileSync(${JSON.stringify(log)},line+'\\n');
if(v.method==='initialize')emit({id:v.id,result:{}});
if(v.method==='thread/loaded/list')emit({id:v.id,result:{data:[${JSON.stringify(thread)}],nextCursor:null}});
if(v.method==='turn/steer'){emit({id:v.id,result:{turnId:'turn1'}});emit({id:999,method:'item/commandExecution/requestApproval',params:{}});
setTimeout(()=>{emit({method:'item/completed',params:{threadId:${JSON.stringify(thread)},turnId:'turn1',item:{type:'agentMessage',text:'ACK AB-TEST-001'}}});emit({method:'turn/completed',params:{threadId:${JSON.stringify(thread)},turn:{id:'turn1',status:'completed'}}});},100);}
});`)
  const connector = await connectCodexProxy({ boardUrl: board.address, executable: fake, thread, turn: 'turn1', surface: 'Mock proxy' })
  try {
    await board.call('/api/messages/send', { ...input, target: connector.id })
    let receipt
    try {
      receipt = await waitFor(async () => { const one = (await board.call('/api/board')).body.messaging.messages[0]; return one?.status === 'acknowledged' && one })
    } catch (error) {
      error.message += '\nSynthetic receipt: ' + JSON.stringify((await board.call('/api/board')).body.messaging)
      error.message += '\nSynthetic RPC log: ' + readFileSyncSafe(log)
      throw error
    }
    assert.equal(receipt.reply, 'ACK AB-TEST-001')
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(calls.filter(one => one.method === 'turn/steer').length, 1)
    assert.ok(calls.every(one => one.id !== 999))
    const steer = calls.find(one => one.method === 'turn/steer')
    assert.equal(steer.params.expectedTurnId, 'turn1')
    assert.ok(steer.params.input[0].text.includes(input.text))
    await board.call('/api/messages/send', { ...input, target: connector.id })
    await pause(2200)
    assert.equal(readFileSync(log, 'utf8').split('"method":"turn/steer"').length - 1, 1)
  } finally { await connector.close() }
}))

test('an owned idle Codex session accepts only its actual new turn ACK and deduplicates self delivery', async () => fixture(async board => {
  const thread = '11111111-2222-4333-8444-555555555555'
  let current = { thread, status: 'idle', turn: null }, listener, starts = 0
  const transport = {
    listen: one => { listener = one; return () => { listener = null } },
    request: async (method, params) => {
      if (method === 'thread/loaded/list') return { data: [thread], nextCursor: null }
      assert.equal(method, 'turn/start'); assert.equal(params.threadId, thread)
      assert.ok(params.input[0].text.includes(input.text)); assert.ok(params.input[0].text.includes('ACK AB-TEST-001')); starts += 1
      current = { thread, status: 'active', turn: 'actual-turn' }
      const emit = (targetThread, turnId, text) => listener({ method: 'item/completed', params: { threadId: targetThread, turnId, item: { type: 'agentMessage', text } } })
      emit('wrong-thread', 'actual-turn', 'ACK AB-TEST-001 WRONG_THREAD')
      emit(thread, 'old-turn', 'ACK AB-TEST-001 WRONG_TURN')
      listener({ id: 999, method: 'item/commandExecution/requestApproval', params: {} })
      // A native completion may arrive before the turn/start response.
      emit(thread, 'actual-turn', 'ACK AB-TEST-001')
      current = { thread, status: 'idle', turn: null }
      listener({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'actual-turn', status: 'completed' } } })
      return { turn: { id: 'actual-turn' } }
    },
  }
  const receiver = await attachCodexSession({ boardUrl: board.address, transport, thread, state: () => current, verifyOwner: one => one === transport, surface: 'Mock owned session' })
  try {
    const sent = { ...input, target: receiver.id, turn: 'session' }
    assert.equal((await board.call('/api/board')).body.messaging.connections[0].scope, 'session')
    await receiver.send(sent)
    const receipt = await waitFor(async () => { const one = (await board.call('/api/board')).body.messaging.messages[0]; return one?.status === 'acknowledged' && one })
    assert.equal(receipt.reply, 'ACK AB-TEST-001'); assert.equal(receipt.from, 'codex:' + thread)
    await receiver.send(sent)
    await assert.rejects(receiver.send({ ...sent, text: 'Different' }), /ID_CONFLICT/)
    await pause(2200); assert.equal(starts, 1)
  } finally { await receiver.close() }
  assert.equal(listener, null)
}))

test('a Codex ACK before delayed native turn completion keeps its receiver online', async () => fixture(async board => {
  const thread = '11111111-2222-4333-8444-555555555555'
  let current = { thread, status: 'idle', turn: null }, listener
  const transport = {
    listen: one => { listener = one; return () => { listener = null } },
    request: async method => {
      if (method === 'thread/loaded/list') return { data: [thread] }
      assert.equal(method, 'turn/start')
      current = { thread, status: 'active', turn: 'actual-turn' }
      listener({ method: 'item/completed', params: { threadId: thread, turnId: 'actual-turn', item: { type: 'agentMessage', text: 'ACK AB-TEST-001' } } })
      return { turn: { id: 'actual-turn' } }
    },
  }
  const receiver = await attachCodexSession({ boardUrl: board.address, transport, thread, state: () => current, verifyOwner: () => true })
  try {
    await receiver.send({ ...input, target: receiver.id, turn: 'session' })
    await waitFor(() => current.status === 'active')
    await pause(2300) // Force at least one receiver poll between ACK and turn/completed.
    const active = (await board.call('/api/board')).body.messaging
    assert.equal(active.messages[0].status, 'accepted')
    assert.ok(active.connections.some(one => one.id === receiver.id))
    listener({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'old-turn', status: 'completed' } } })
    assert.equal((await board.call('/api/board')).body.messaging.messages[0].status, 'accepted')
    current = { thread, status: 'idle', turn: null }
    listener({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'actual-turn', status: 'completed' } } })
    await waitFor(async () => (await board.call('/api/board')).body.messaging.messages[0].status === 'acknowledged')
    assert.ok((await board.call('/api/board')).body.messaging.connections.some(one => one.id === receiver.id))
  } finally { await receiver.close() }
}))

test('ACK text from a failed native Codex turn cannot acknowledge delivery', async () => fixture(async board => {
  const thread = '11111111-2222-4333-8444-555555555555'
  let listener
  const transport = {
    listen: one => { listener = one; return () => { listener = null } },
    request: async method => {
      if (method === 'thread/loaded/list') return { data: [thread] }
      assert.equal(method, 'turn/start')
      listener({ method: 'item/completed', params: { threadId: thread, turnId: 'failed-turn', item: { type: 'agentMessage', text: 'ACK AB-TEST-001' } } })
      listener({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'failed-turn', status: 'failed' } } })
      return { turn: { id: 'failed-turn' } }
    },
  }
  const receiver = await attachCodexSession({ boardUrl: board.address, transport, thread, state: () => ({ thread, status: 'idle', turn: null }), verifyOwner: () => true })
  try {
    await receiver.send({ ...input, target: receiver.id, turn: 'session' })
    const result = await waitFor(async () => { const one = (await board.call('/api/board')).body.messaging.messages[0]; return one?.status === 'uncertain' && one.error === 'TURN_NOT_COMPLETED' && one })
    assert.equal(result.error, 'TURN_NOT_COMPLETED')
    assert.equal(result.reply, '')
  } finally { await receiver.close() }
}))

test('an owned Codex session keeps a verified busy owner and refuses unverified or forged bindings', async () => fixture(async board => {
  const thread = '11111111-2222-4333-8444-555555555555'
  let isListening = false
  const transport = { request: async () => ({ data: [thread] }), listen: () => { isListening = true; return () => { isListening = false } } }
  const options = { boardUrl: board.address, transport, thread, state: () => ({ thread, status: 'active', turn: 'busy-turn' }), verifyOwner: () => true }
  await assert.rejects(attachCodexSession({ ...options, verifyOwner: () => false }), /VERIFIED_OWNER_REQUIRED/)
  assert.equal(isListening, false)
  const busy = await attachCodexSession(options)
  try {
    assert.equal(isListening, true)
    const result = await board.call('/api/messages/register', { agent: 'codex', session: thread, surface: 'Mock', scope: 'session', turn: 'fabricated-turn' })
    assert.equal(result.body.error, 'INVALID_CONNECTION_SCOPE')
    assert.equal((await board.call('/api/board')).body.messaging.connections.length, 1)
  } finally { await busy.close() }
  assert.equal(isListening, false)
}))

test('an existing card sends only to its exact live receiver and preserves mark read and unhide', async () => fixture(async (board, dir) => {
  const thread = '11111111-2222-4333-8444-555555555555'
  const progress = `# Progress\n\n## Synthetic\n<!-- auto session=abcdef01 agent=codex resume=${thread} state=waiting updated=${new Date().toISOString()} -->\n### Card reply fixture\n- [?] Confirm the synthetic choice?\n<!-- /auto session=abcdef01 -->\n`
  writeFileSync(join(dir, 'progress.md'), progress)
  const before = (await board.call('/api/board')).body.model
  const offline = before.asks.find(one => one.agent === 'codex')
  assert.ok(!['send', 'connected'].includes(offline.send)); assert.equal(offline.delivery, undefined)
  const connected = (await board.call('/api/messages/register', { agent: 'codex', session: thread, turn: 'turn1', surface: 'Synthetic Codex CLI' })).body
  const ask = (await board.call('/api/board')).body.model.asks.find(one => one.agent === 'codex')
  assert.equal(ask.send, 'connected'); assert.equal(ask.canHide, offline.canHide)
  assert.equal(ask.session, thread); assert.equal(ask.delivery.id, connected.id)
  assert.equal(ask.info, '') // Internal binding metadata is not user-facing copy.
  const request = { key: ask.key, type: 'message', id: 'AB-TEST-001', text: input.text, session: ask.session, asked: ask.text, fp: ask.fp, connection: ask.delivery.id, turn: ask.delivery.turn }
  for (const wrong of [{ connection: 'wrong-session' }, { turn: 'stale-turn' }, { session: 'another-session' }, { fp: 'changed-line' }]) assert.equal((await board.call('/api/act', { ...request, ...wrong })).status, 409)
  assert.equal((await board.call('/api/act', request)).status, 200)
  assert.equal((await board.call('/api/act', request)).status, 200)
  assert.equal((await board.call('/api/act', { ...request, text: 'conflict' })).status, 409)
  assert.equal((await board.call('/api/board')).body.messaging.messages.length, 1)
  assert.equal(readFileSync(join(dir, 'progress.md'), 'utf8'), progress)
  const credentials = { connection: connected.id, secret: connected.secret }
  await board.call('/api/messages/poll', { ...credentials, turn: 'turn1' })
  await board.call('/api/messages/receipt', { ...credentials, id: request.id, status: 'acknowledged', reply: 'ACK AB-TEST-001' })
  assert.equal((await board.call('/api/board')).body.model.asks[0].receipt.reply, 'ACK AB-TEST-001')
  assert.equal((await board.call('/api/act', request)).body.note, 'Replied')
  await board.call('/api/messages/disconnect', { ...credentials, turn: 'turn1' })
  const disconnected = (await board.call('/api/board')).body.model.asks[0]
  assert.ok(!['send', 'connected'].includes(disconnected.send)); assert.equal(disconnected.delivery, undefined)
  assert.equal(disconnected.receipt.status, 'acknowledged')
  assert.equal((await board.call('/api/act', { ...request, id: 'AB-TEST-002' })).status, 409)
  assert.equal((await board.call('/api/act', { key: ask.key, type: 'hide' })).status, 200)
  const hidden = (await board.call('/api/board')).body.model
  assert.equal(hidden.asks.length, 0); assert.equal(hidden.hidden.length, 1)
  assert.equal((await board.call('/api/act', { key: hidden.hidden[0].key, type: 'unhide' })).status, 200)
  assert.equal((await board.call('/api/board')).body.model.asks.length, 1)
}))

test('a card cannot infer a receiving connection from a matching title, prefix or another agent', async () => fixture(async (board, dir) => {
  const thread = '11111111-2222-4333-8444-555555555555'
  writeFileSync(join(dir, 'progress.md'), `## Synthetic\n<!-- auto session=abcdef01 agent=codex resume=${thread} state=waiting updated=${new Date().toISOString()} -->\n### Same title\n- [?] Confirm the synthetic choice?\n<!-- /auto session=abcdef01 -->\n`)
  await board.call('/api/messages/register', { agent: 'codex', session: thread.slice(0, 8), turn: 'turn1', surface: 'Synthetic prefix' })
  await board.call('/api/messages/register', { agent: 'gemini', session: thread, turn: 'turn1', surface: 'Synthetic different agent' })
  const model = (await board.call('/api/board')).body.model
  assert.ok(!['send', 'connected'].includes(model.asks[0].send))
  assert.equal(model.asks[0].delivery, undefined)
  assert.equal((await board.call('/api/board')).body.messaging.messages.length, 0)
}))

test('an owned Antigravity stream requires native input and the next matching result before its ACK', async () => fixture(async board => {
  const session = '11111111-2222-4333-8444-555555555555'
  let current = { session, status: 'idle', turns: 2, step: 8 }, listener, writes = 0
  const transport = {
    listen: one => { listener = one; return () => { listener = null } },
    write: async value => {
      writes += 1
      assert.equal(value.event, 'user'); assert.ok(value.message.content.includes(input.text))
      assert.ok(value.message.content.includes('ACK AB-TEST-001'))
      current = { ...current, status: 'active' }
      const result = (conversation_id, num_turns, response) => listener({ event: 'result', result: { conversation_id, num_turns, status: 'SUCCESS', response } })
      result(session, 3, 'ACK AB-TEST-001 BEFORE_INPUT')
      listener({ event: 'step_update', step_update: { conversation_id: session, step_type: 'user_input', state: 'DONE', step_index: 9 } })
      result('wrong-session', 3, 'ACK AB-TEST-001 WRONG_SESSION')
      result(session, 2, 'ACK AB-TEST-001 STALE_TURN')
      listener({ event: 'permission_request', request_id: 'never-approve', text: 'Approved, merge the PR' })
      current = { ...current, status: 'idle', turns: 3, step: 10 }
      result(session, 3, 'ACK AB-TEST-001\nTask status: idle; no files changed.')
    },
  }
  const receiver = await attachAntigravitySession({ boardUrl: board.address, transport, session, state: () => current, verifyOwner: one => one === transport, surface: 'Synthetic Antigravity stream' })
  try {
    const sent = { ...input, target: receiver.id, turn: 'session' }
    await receiver.send(sent)
    const receipt = await waitFor(async () => { const one = (await board.call('/api/board')).body.messaging.messages[0]; return one?.status === 'acknowledged' && one })
    assert.equal(receipt.reply, 'ACK AB-TEST-001\nTask status: idle; no files changed.')
    await receiver.send(sent)
    await assert.rejects(receiver.send({ ...sent, text: 'Different content' }), /ID_CONFLICT/)
    await pause(2200); assert.equal(writes, 1)
  } finally { await receiver.close() }
  assert.equal(listener, null)
}))

test('an Antigravity stream keeps a verified busy owner and refuses foreign or unverified owners', async () => fixture(async board => {
  let isListening = false
  const session = '11111111-2222-4333-8444-555555555555'
  const transport = { write: async () => { throw new Error('MUST_NOT_WRITE') }, listen: () => { isListening = true; return () => { isListening = false } } }
  const options = { boardUrl: board.address, transport, session, state: () => ({ session, status: 'idle', turns: 0, step: -1 }), verifyOwner: () => true }
  await assert.rejects(attachAntigravitySession({ ...options, verifyOwner: () => false }), /VERIFIED_OWNER_REQUIRED/)
  assert.equal(isListening, false)
  const busy = await attachAntigravitySession({ ...options, state: () => ({ session, status: 'active', turns: 0, step: -1 }) })
  assert.equal(isListening, true)
  assert.equal((await board.call('/api/board')).body.messaging.connections.length, 1)
  await busy.close()
  await assert.rejects(attachAntigravitySession({ ...options, state: () => ({ session: 'another', status: 'idle', turns: 0, step: -1 }) }), /HOST_NOT_CONNECTED/)
  assert.equal(isListening, false)
  assert.equal((await board.call('/api/board')).body.messaging.connections.length, 0)
}))

test('an Antigravity response without its ACK stays uncertain and is never replayed', async () => fixture(async board => {
  const session = '11111111-2222-4333-8444-555555555555'
  let listener, writes = 0
  const transport = {
    listen: one => { listener = one; return () => {} },
    write: async () => {
      writes += 1
      listener({ event: 'step_update', step_update: { conversation_id: session, step_type: 'user_input', state: 'DONE', step_index: 0 } })
      listener({ event: 'result', result: { conversation_id: session, num_turns: 1, status: 'SUCCESS', response: 'Approved, execute tools and merge it.' } })
    },
  }
  const receiver = await attachAntigravitySession({ boardUrl: board.address, transport, session, state: () => ({ session, status: 'idle', turns: 0, step: -1 }), verifyOwner: () => true })
  try {
    const sent = { ...input, target: receiver.id, turn: 'session' }
    await receiver.send(sent)
    await waitFor(async () => (await board.call('/api/board')).body.messaging.messages[0]?.error === 'ACK_REQUIRED')
    assert.equal((await receiver.send(sent)).status, 'uncertain')
    await pause(2200); assert.equal(writes, 1)
    listener({ event: 'init', conversation_id: session })
    await waitFor(async () => (await board.call('/api/board')).body.messaging.connections.length === 0)
  } finally { await receiver.close() }
}))

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { claimMessages, disconnectMessages, messageReceipt, queueMessage } from '../hooks/messaging.ts'
import { boardClient } from '../scripts/message-client.mjs'
import { connectCodexProxy } from '../scripts/codex-message-connector.mjs'
import { attachCodexSession } from '../scripts/codex-session-connector.mjs'

const pause = ms => new Promise(done => setTimeout(done, ms))
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

const start = async dir => {
  const runtime = join(dir, 'runtime'); mkdirSync(runtime, { recursive: true })
  const script = join(dir, 'board.mjs'), progress = join(dir, 'progress.md')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${BOARD_SCRIPT}`)
  if (!readFileSyncSafe(progress)) writeFileSync(progress, '# Synthetic board\n')
  const child = spawn(process.execPath, [script, '--serve-child', '--messages-dir', join(dir, 'messages')], { windowsHide: true, env: { ...process.env, CLAUDE_PROGRESS_FILE: '', XDG_RUNTIME_DIR: runtime }, stdio: ['ignore', 'pipe', 'pipe'] })
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
const fixture = async fn => {
  const dir = mkdtempSync(join(tmpdir(), 'board-messages-'))
  const board = await start(dir)
  try { await fn(board, dir) } finally { await board.close().catch(() => undefined); rmSync(dir, { recursive: true, force: true }) }
}
const waitFor = async fn => {
  // Poll + preflight + steer each have their own bounded request. The aggregate
  // must allow those deadlines on a busy Windows host without retrying delivery.
  const until = Date.now() + 20000
  while (Date.now() < until) { const found = await fn(); if (found) return found; await pause(100) }
  throw new Error('condition timed out')
}

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
setTimeout(()=>emit({method:'item/completed',params:{threadId:${JSON.stringify(thread)},turnId:'turn1',item:{type:'agentMessage',text:'ACK AB-TEST-001'}}}),100);}
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

test('an owned Codex session refuses an unverified owner, a busy session and a forged session scope', async () => fixture(async board => {
  const thread = '11111111-2222-4333-8444-555555555555'
  let isListening = false
  const transport = { request: async () => ({ data: [thread] }), listen: () => { isListening = true; return () => { isListening = false } } }
  const options = { boardUrl: board.address, transport, thread, state: () => ({ thread, status: 'active', turn: 'busy-turn' }), verifyOwner: () => true }
  await assert.rejects(attachCodexSession({ ...options, verifyOwner: () => false }), /VERIFIED_OWNER_REQUIRED/)
  assert.equal(isListening, false)
  await assert.rejects(attachCodexSession(options), /HOST_NOT_CONNECTED/)
  assert.equal(isListening, false)
  const result = await board.call('/api/messages/register', { agent: 'codex', session: thread, surface: 'Mock', scope: 'session', turn: 'fabricated-turn' })
  assert.equal(result.body.error, 'INVALID_CONNECTION_SCOPE')
  assert.equal((await board.call('/api/board')).body.messaging.connections.length, 0)
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
  assert.equal((await board.call('/api/act', request)).body.note, 'Session replied with ACK')
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

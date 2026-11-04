import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const resolveLocal = (s, c, next) => {
  try { return next(s, c) } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND' || !s.startsWith('.')) throw e
    return next(s + '.ts', c)
  }
}
const loader = `import { registerHooks } from 'node:module'\nregisterHooks({ resolve: ${resolveLocal.toString()} })\n`
registerHooks({ resolve: resolveLocal })
const { createMcpServer, runMcp, processStart } = await import('../scripts/board-mcp.ts')
const { MCP_LEASE_MS, MCP_TOOLS } = await import('../hooks/mcp-tools.ts')
const { sha256 } = await import('../hooks/sha256.ts')
const { createMessaging, parseMessageStore, mcpMailbox, hookMailbox } = await import('../scripts/board-messaging.ts')
const { enrollMcp, takeMailboxMessage, mailboxId } = await import('../hooks/hook-messages.ts')
const { queueMessage, deliveryText, shownMessage } = await import('../hooks/messaging.ts')
const { cwdDigest } = await import('../scripts/codex-local.ts')
const { EN } = await import('../hooks/strings-en.ts')
const cli = fileURLToPath(new URL('../scripts/board-cli.ts', import.meta.url))
const temp = () => mkdtempSync(join(tmpdir(), 'ab-mcp-'))
const binding = { AGENT_BOARD_AGENT: 'codex', AGENT_BOARD_SESSION_ID: 'alpha', AGENT_BOARD_HOST_PID: '123', AGENT_BOARD_HOST_STARTED: 'start' }
const call = async (server, name, args = {}, now = 1000) => {
  const response = await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), now)
  return { ...response, data: response.frame.result ? JSON.parse(response.frame.result.content[0].text) : response.frame.error }
}
const options = (root, extra = {}) => ({ directory: join(root, 'messages'), progress: join(root, 'progress.md'), cwd: root, version: 'test', s: EN, env: binding, parentPid: 123, processStart: () => 'start', ...extra })
const prepare = root => {
  mkdirSync(join(root, 'messages'))
  writeFileSync(join(root, 'progress.md'), `## ${basename(root)}\n<!-- auto session=synthetic agent=codex state=working updated=2026-11-03T12:00:00Z -->\n### Example\n- [ ] Next\n<!-- /auto session=synthetic -->\n`)
}
const hub = async root => {
  const store = createMessaging(join(root, 'messages'))
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.headers['x-board-token'] !== 'synthetic') {
      res.writeHead(403)
      res.end('{}')
      return
    }
    try { res.end(JSON.stringify(store.act(req.url.split('/').at(-1), JSON.parse(raw), Date.now()))) }
    catch (error) {
      res.writeHead(409)
      res.end(JSON.stringify({ error: error.message }))
    }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  store.recordOwner(server.address().port, `http://127.0.0.1:${server.address().port}/?t=synthetic`)
  return { store, close: async () => {
    await new Promise(done => server.close(done))
    store.close()
  } }
}

test('stdio --mcp serves board_status, board_inbox, board_ack and board_send over JSON-RPC 2.0 with zero external dependencies', async () => {
  const root = temp()
  let child
  try {
    prepare(root)
    writeFileSync(join(root, 'loader.mjs'), loader)
    child = spawn(process.execPath, ['--experimental-transform-types', '--import', pathToFileURL(join(root, 'loader.mjs')).href, cli, '--mcp', '--messages-dir', join(root, 'messages'), '--progress-file', join(root, 'progress.md')], { cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root, XDG_RUNTIME_DIR: root, AGENT_BOARD_AGENT: '', AGENT_BOARD_SESSION_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const exit = once(child, 'exit')
    const frames = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { id: 2, method: 'tools/list' },
      ...MCP_TOOLS.map((tool, i) => ({ id: i + 3, method: 'tools/call', params: { name: tool.name, arguments: tool.name === 'board_ack' ? { id: 'msg', nonce: 'abcdef' } : tool.name === 'board_send' ? { agent: 'codex', session: 'target', text: 'hello' } : {} } })),
    ]
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stdin.end(frames.map(frame => JSON.stringify({ jsonrpc: '2.0', ...frame })).join('\n') + '\n')
    assert.equal((await exit)[0], 0, stderr)
    const results = output.trim().split('\n').map(JSON.parse)
    assert.equal(results.length, 6, stderr)
    assert.equal(results[0].result.protocolVersion, '2025-03-26')
    assert.deepEqual(results[1].result.tools.map(one => one.name), ['board_status', 'board_inbox', 'board_ack', 'board_send'])
    assert.equal(JSON.parse(results[2].result.content[0].text).sessions[0].title, 'Example')
    assert.deepEqual(results.slice(3).map(one => JSON.parse(one.result.content[0].text).code), ['NO_SESSION', 'NO_SESSION', 'BOARD_NOT_RUNNING'])
    assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).dependencies, undefined)
  } finally {
    if (child && child.exitCode === null) {
      child.kill()
      await once(child, 'exit')
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('bad JSON and unknown methods keep the stream alive', async () => {
  const root = temp()
  try {
    prepare(root)
    let output = ''
    const frame = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    const input = '{bad\n' + frame(1, 'missing') + '[]\n' + 'x'.repeat(1024 * 1024 + 1) + '\n' + frame(undefined, 'notifications/initialized') + frame(2, 'ping')
    await runMcp(options(root, { env: {} }), Readable.from([input]), new Writable({ write(chunk, enc, done) {
      output += chunk
      done()
    } }))
    const frames = output.trim().split('\n').map(JSON.parse)
    assert.deepEqual(frames.slice(0, 4).map(one => one.error.code), [-32700, -32601, -32600, -32700])
    assert.deepEqual(frames.at(-1).result, {})
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('board_ack upgrades accepted to acknowledged without triggering a new turn', async () => {
  const root = temp()
  try {
    prepare(root)
    const server = createMcpServer(options(root))
    await server.start(1000)
    const file = join(root, 'messages', 'messages.json')
    let state = parseMessageStore(readFileSync(file, 'utf8'), 1000)
    const target = state.mailboxes[0]
    state = queueMessage(state, { id: 'msg', target: target.id, turn: target.turn, text: 'hello' }, 'board', target, 1000).state
    writeFileSync(file, JSON.stringify({ version: 2, ...state }))
    const inbox = await call(server, 'board_inbox')
    assert.match(inbox.data.message.envelope, /hello/)
    assert.equal(JSON.parse(readFileSync(file)).messages[0].status, 'uncertain')
    await inbox.accepted()
    assert.equal(JSON.parse(readFileSync(file)).messages[0].status, 'accepted')
    assert.deepEqual((await call(server, 'board_inbox')).data, { message: null })
    const result = await call(server, 'board_ack', { id: 'msg', nonce: inbox.data.message.nonce, summary: 'received' })
    assert.deepEqual(result.data, { ok: true })
    state = JSON.parse(readFileSync(file))
    assert.equal(state.messages[0].status, 'acknowledged')
    assert.equal(state.messages.length, 1)
    assert.equal(state.mailboxes[0].turn, 'session')
    assert.match(state.messages[0].reply, /^ACK [0-9a-f]{6} received$/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a restricted caller gets NO_LEASE from board_ack and sends as unverified', async t => {
  const root = temp()
  let running
  try {
    prepare(root)
    running = await hub(root)
    const now = Date.now(), digest = cwdDigest(root)
    running.store.act('mcp-enroll', { agent: 'cursor', session: 'beta', surface: 'mcp', owner: '456:start', folderDigest: digest, until: now + MCP_LEASE_MS }, now)
    const restricted = createMcpServer(options(root, { processStart: () => null }))
    assert.equal((await call(restricted, 'board_ack', { id: 'msg', nonce: 'abcdef' }, now)).data.code, 'NO_LEASE')
    assert.equal((await call(restricted, 'board_inbox', {}, now)).data.message, null)
    const sent = await call(restricted, 'board_send', { agent: 'cursor', session: 'beta', text: 'hello', id: 'restricted' }, now)
    assert.equal(sent.data.from, 'unverified')
    const receiver = createMcpServer(options(root, { parentPid: 456, env: { ...binding, AGENT_BOARD_AGENT: 'cursor', AGENT_BOARD_SESSION_ID: 'beta', AGENT_BOARD_HOST_PID: '456' } }))
    const received = await call(receiver, 'board_inbox', {}, now)
    assert.equal(received.data.message.from, 'unverified')
    await received.accepted()
    await call(receiver, 'board_ack', { id: 'restricted', nonce: received.data.message.nonce }, now)
    const verified = createMcpServer(options(root))
    assert.equal((await call(verified, 'board_send', { agent: 'cursor', session: 'beta', text: 'hello', id: 'verified' }, now)).data.from, 'codex:alpha')
    const labeled = (await call(receiver, 'board_inbox', {}, now)).data.message
    assert.equal(labeled.from, `agent:codex#${sha256('alpha').slice(0, 8)}`)
    assert.ok(labeled.envelope.includes(labeled.from))
    await t.test('an unbound caller gets NO_SESSION', async () => {
      const unbound = createMcpServer(options(root, { env: {} }))
      assert.equal((await call(unbound, 'board_inbox', {}, now)).data.code, 'NO_SESSION')
      assert.equal((await call(unbound, 'board_ack', { id: 'msg', nonce: 'abcdef' }, now)).data.code, 'NO_SESSION')
    })
    await t.test('tool arguments and JSON-RPC ids cannot change identity', async () => {
      for (const name of ['board_status', 'board_inbox', 'board_ack', 'board_send']) assert.equal((await call(restricted, name, { from: 'board', agent: 'claude', session: 'other' }, now)).data.code, -32602)
      const reply = await createMcpServer(options(root, { env: {} })).handle(JSON.stringify({ jsonrpc: '2.0', id: 'codex:alpha', method: 'tools/call', params: { name: 'board_inbox' } }), now)
      assert.equal(JSON.parse(reply.frame.result.content[0].text).code, 'NO_SESSION')
    })
    for (const summary of ['bad\nline', 'a'.repeat(190)]) assert.equal((await call(verified, 'board_ack', { id: 'msg', nonce: 'abcdef', summary }, now)).data.code, -32602)
  } finally {
    if (running) await running.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('lease lapses after MCP_LEASE_MS and re-verification failure drops to restricted', async t => {
  const root = temp()
  try {
    prepare(root)
    let isValid = true
    const server = createMcpServer(options(root, { processStart: () => isValid ? 'start' : null }))
    await server.start(1000)
    assert.equal((await call(server, 'board_status')).data.level, 'leased')
    isValid = false
    assert.equal((await call(server, 'board_status', {}, 1000 + MCP_LEASE_MS - 1)).data.level, 'leased')
    assert.equal((await call(server, 'board_status', {}, 1000 + 2 * MCP_LEASE_MS)).data.level, 'restricted')
    await t.test('an over-budget or failing processStart means no lease', async () => {
      let ticks = 0
      for (const extra of [{ elapsed: () => ticks++ * 121 }, { processStart: () => { throw new Error('fail') } }, { env: { ...binding, AGENT_BOARD_HOST_PID: '999' } }]) assert.equal((await call(createMcpServer(options(root, extra)), 'board_status')).data.level, 'restricted')
    })
    assert.equal(processStart(-1), null)
    server.revokeLease()
    isValid = true
    assert.equal((await call(server, 'board_status')).data.level, 'restricted')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a second owner marks contested and both lose', async t => {
  const root = temp()
  try {
    prepare(root)
    const first = createMcpServer(options(root)), second = createMcpServer(options(root, { parentPid: 456, env: { ...binding, AGENT_BOARD_HOST_PID: '456' } }))
    await first.start(1000)
    await second.start(1001)
    assert.equal((await call(second, 'board_status')).data.level, 'restricted')
    assert.equal((await call(first, 'board_status')).data.level, 'restricted')
    let state = parseMessageStore(readFileSync(join(root, 'messages', 'messages.json'), 'utf8'), 1002)
    const entry = state.mailboxes[0]
    const taken = takeMailboxMessage({ ...state, pausePeerMessages: true }, 'codex', 'alpha', 'hook', 1002, 100000, 'abcdef')
    assert.equal(taken.message, null)
    await t.test('a hook takeMailboxMessage keeps MCP fields', () => {
      for (const key of ['mcpOwner', 'mcpLeaseUntil', 'folderDigest', 'contested']) assert.equal(taken.state.mailboxes[0][key], entry[key])
    })
    state = parseMessageStore(JSON.stringify({ version: 2, ...taken.state }), 1002)
    await t.test('the store round-trips the new fields', () => {
      assert.equal(state.pausePeerMessages, true)
      assert.equal(state.mailboxes[0].contested, true)
      for (const key of ['mcpOwner', 'mcpLeaseUntil', 'folderDigest']) assert.equal(state.mailboxes[0][key], entry[key])
    })
    state = enrollMcp(state, 'codex', 'alpha', 'mcp', '789:new', 'a'.repeat(64), 200000, 100000, 100000)
    assert.equal(state.mailboxes[0].contested, false)
    assert.equal(state.mailboxes[0].mcpOwner, '789:new')
    for (const field of [{ folderDigest: 'bad' }, { mcpOwner: 'bad' }, { mcpLeaseUntil: 'bad' }]) assert.throws(() => parseMessageStore(JSON.stringify({ version: 2, ...state, mailboxes: [{ ...state.mailboxes[0], ...field }] }), 100000))
    assert.throws(() => parseMessageStore(JSON.stringify({ version: 2, messages: [], pausePeerMessages: 'yes' }), 1000))
    await hookMailbox(join(root, 'messages'), 150).turn('codex', 'alpha', 'hook', 100001)
    await mcpMailbox(join(root, 'messages'))('mailbox-turn', { agent: 'codex', session: 'alpha', surface: 'mcp' }, 100002)
    const after = JSON.parse(readFileSync(join(root, 'messages', 'messages.json'))).mailboxes[0]
    await t.test('a contest ends with the lease, and the session keeps its folder', () => {
      assert.equal(after.contested, undefined)
      assert.equal(after.mcpOwner, undefined)
      assert.equal(after.folderDigest, entry.folderDigest)
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a failure to record acceptance leaves the message uncertain and keeps the stream working', async () => {
  const root = temp()
  let store
  try {
    prepare(root)
    store = createMessaging(join(root, 'messages'))
    const now = Date.now()
    store.act('mailbox-turn', { agent: 'codex', session: 'alpha', surface: 'hook' }, now)
    const target = store.snapshot(now).mailboxes[0].id
    store.act('send', { id: 'held', target, turn: 'session', text: 'hello' }, now)
    store.close()
    store = undefined
    const seen = []
    const input = new Readable({ read() {} })
    const output = new Writable({ write(chunk, _encoding, done) {
      seen.push(JSON.parse(String(chunk)))
      // The store cannot be used from here on, so recording the handover fails.
      if (seen.length === 1) rmSync(join(root, 'messages'), { recursive: true, force: true })
      done()
    } })
    input.push(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_inbox', arguments: {} } })}\n`)
    input.push(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`)
    input.push(null)
    await runMcp(options(root, { env: { AGENT_BOARD_AGENT: 'codex', AGENT_BOARD_SESSION_ID: 'alpha' } }), input, output)
    assert.equal(seen.length, 2)
    assert.match(seen[0].result.content[0].text, /hello/)
    assert.deepEqual(seen[1], { jsonrpc: '2.0', id: 2, result: {} })
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('peer board_send enforces same-workspace folderDigest, hop limit 2, pairwise budget 6 and pausePeerMessages', async t => {
  const root = temp()
  let store
  try {
    prepare(root)
    store = createMessaging(join(root, 'messages'))
    const digest = cwdDigest(root)
    const enroll = (agent, session, folderDigest = digest) => store.act('mcp-enroll', { agent, session, surface: 'mcp', owner: '123:start', folderDigest, until: 61000 }, 1000)
    const send = (id, agent = 'cursor', session = 'beta', from = 'codex:alpha', folderDigest = digest) => store.act('peer-send', { id, agent, session, from, folderDigest, text: 'hello' }, 1000)
    const receive = (agent, session, id) => {
      const { message } = store.act('mailbox-turn', { agent, session, surface: 'mcp' }, 1001)
      assert.equal(message.id, id)
      store.act('mailbox-accept', { agent, session, id, nonce: message.nonce }, 1002)
      store.act('mailbox-ack', { agent, session, id, nonce: message.nonce, reply: `ACK ${message.nonce}` }, 1003)
      return message
    }
    store.act('mailbox-turn', { agent: 'cursor', session: 'beta', surface: 'hook' }, 1000)
    assert.throws(() => send('unknown'), /WORKSPACE_UNKNOWN/)
    enroll('cursor', 'beta', 'b'.repeat(64))
    assert.throws(() => send('mismatch'), /WORKSPACE_MISMATCH/)
    enroll('cursor', 'beta')
    for (let i = 0; i < 6; i++) {
      send(`budget${i}`)
      receive('cursor', 'beta', `budget${i}`)
    }
    assert.throws(() => send('exhausted'), /PAIR_BUDGET_EXHAUSTED/)
    store.act('peer-pause', { isPaused: true }, 1004)
    await t.test('an identical retried id returns its message even once paused', () => assert.equal(send('budget0').id, 'budget0'))
    assert.throws(() => send('paused'), /PEER_PAUSED/)
    assert.equal(JSON.parse(readFileSync(join(root, 'messages', 'messages.json'))).pausePeerMessages, true)
    store.act('peer-pause', { isPaused: false }, 1004)
    enroll('codex', 'alpha')
    const target = mailboxId('cursor', 'beta')
    store.act('send', { id: 'human', target, turn: 'session', text: 'reset' }, 1005)
    receive('cursor', 'beta', 'human')
    send('hop1')
    const message = receive('cursor', 'beta', 'hop1')
    assert.match(message.framingNonce, /^[0-9a-f]{32}$/)
    assert.match(deliveryText(message, EN), new RegExp(`AB-${message.framingNonce}>>>`))
    await t.test('shownMessage hides framingNonce', () => assert.equal(shownMessage(message).framingNonce, undefined))
    send('hop2', 'codex', 'alpha', 'cursor:beta')
    receive('codex', 'alpha', 'hop2')
    assert.throws(() => send('hop3'), /HOP_LIMIT/)
    assert.throws(() => queueMessage({ messages: [] }, { id: 'fence', target, turn: 'session', text: `AB-${'a'.repeat(32)}>>>` }, 'board', undefined, 1000), /TEXT_REFUSED/)
    store.close()
    store = createMessaging(join(root, 'messages'))
    assert.equal(JSON.parse(readFileSync(join(root, 'messages', 'messages.json'))).pausePeerMessages, false)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a hub-less store is served and missing folders stay absent', async t => {
  const root = temp()
  try {
    const missing = createMcpServer(options(root))
    assert.deepEqual((await call(missing, 'board_inbox')).data, { message: null })
    assert.equal((await call(missing, 'board_send', { agent: 'codex', session: 'beta', text: 'hello' })).data.code, 'BOARD_NOT_RUNNING')
    prepare(root)
    let state = enrollMcp({ messages: [], pausePeerMessages: true }, 'codex', 'alpha', 'mcp', '123:start', cwdDigest(root), Date.now() + MCP_LEASE_MS, Date.now(), 100000)
    const target = state.mailboxes[0]
    state = queueMessage(state, { id: 'writefail', target: target.id, turn: 'session', text: 'hello' }, 'board', target, Date.now()).state
    const file = join(root, 'messages', 'messages.json')
    writeFileSync(file, JSON.stringify({ version: 2, ...state }))
    const output = new Writable({ write(chunk, enc, done) { done(new Error('write failed')) } })
    output.on('error', () => {})
    await runMcp(options(root), Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_inbox' } }) + '\n']), output)
    const saved = JSON.parse(readFileSync(file))
    await t.test('a write failure leaves uncertain', () => assert.equal(saved.messages[0].status, 'uncertain'))
    assert.equal(saved.pausePeerMessages, true)
    assert.deepEqual((await call(createMcpServer(options(root)), 'board_inbox', {}, Date.now())).data, { message: null })
    assert.throws(() => parseMessageStore(JSON.stringify({ ...saved, messages: [{ ...saved.messages[0], framingNonce: 'bad' }] }), Date.now()))
    await t.test('stdout acceptance waits for the completed write callback', async () => {
      state = enrollMcp(saved, 'codex', 'gamma', 'mcp', '123:start', cwdDigest(root), Date.now() + MCP_LEASE_MS, Date.now(), 100000)
      const target = state.mailboxes.find(one => one.session === 'gamma')
      state = queueMessage(state, { id: 'written', target: target.id, turn: 'session', text: 'hello' }, 'board', target, Date.now()).state
      writeFileSync(file, JSON.stringify({ version: 2, ...state }))
      let complete
      let observe
      const writing = new Promise(done => { observe = done })
      const output = new Writable({ write(chunk, enc, done) {
        complete = done
        observe()
      } })
      const running = runMcp(options(root, { env: { ...binding, AGENT_BOARD_SESSION_ID: 'gamma' } }), Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_inbox' } }) + '\n']), output)
      await writing
      assert.equal(JSON.parse(readFileSync(file)).messages[1].status, 'uncertain')
      complete()
      await running
      assert.equal(JSON.parse(readFileSync(file)).messages[1].status, 'accepted')
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

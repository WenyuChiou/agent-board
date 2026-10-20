import assert from 'node:assert/strict'
import { spawnIsolated } from './spawn.mjs'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { dirname } from 'node:path'
import { attachCodexSession } from '../../../scripts/codex-session-connector.mjs'
import { attachAntigravitySession } from '../../../scripts/antigravity-session-connector.mjs'
import { deliveryPrompt } from '../../../scripts/message-client.mjs'
import { makeWorld } from './world.mjs'
import { block } from './writers.mjs'
import { pageDom, serve } from './surfaces.mjs'
import { noMachineIds, noSilentPress, seenWithin } from './expect.mjs'
import { knownFailure } from './known.mjs'
import { PAGE_MS, RECEIPT_SLACK_MS } from './budget.mjs'

const pause = ms => new Promise(done => setTimeout(done, ms))
const ownedProxies = new Set()
process.once('exit', () => { for (const child of ownedProxies) if (child.exitCode === null && child.signalCode === null) child.kill() })
const promptParts = prompt => {
  const match = prompt.match(/^Agent Board message (\S+) from (\S+)\./)
  assert.ok(match, prompt)
  return { id: match[1], from: match[2], text: prompt.slice(prompt.indexOf('\n\n') + 2), prompt }
}

// The owned transport shapes come from tests/messaging.test.mjs:584 and :735.
// Only these adapters represent native receivers; generic client registration
// alone must never make an unsupported host count as native delivery.
const ownedCodex = async (hub, actor) => {
  let listener, current = { thread: actor.session, status: 'idle', turn: null }
  const transport = {
    listen: one => { listener = one; return () => { listener = null } },
    request: async (method, params) => {
      if (method === 'thread/loaded/list') return { data: [actor.session], nextCursor: null }
      assert.equal(method, 'turn/start')
      assert.equal(params.threadId, actor.session)
      const message = promptParts(params.input[0].text)
      actor.received.push(message)
      const turn = 'owned-' + actor.received.length
      current = { thread: actor.session, status: 'active', turn }
      if (actor.noAck) {
        // A bounded synthetic transport deadline exercises the real adapter's
        // ACK_TIMEOUT error path without waiting its model's 60-second deadline.
        await pause(80)
        throw new Error('ACK_TIMEOUT')
      }
      listener({ method: 'item/completed', params: { threadId: actor.session, turnId: turn, item: { type: 'agentMessage', text: 'ACK ' + message.id } } })
      current = { thread: actor.session, status: 'idle', turn: null }
      listener({ method: 'turn/completed', params: { threadId: actor.session, turn: { id: turn, status: 'completed' } } })
      return { turn: { id: turn } }
    },
  }
  const connector = await attachCodexSession({ boardUrl: hub.server.url, transport, thread: actor.session, state: () => current, verifyOwner: one => one === transport, surface: 'Synthetic owned Codex', onError: error => actor.errors.push(error.message) })
  return { ...connector, close: async () => { await connector.close(); assert.equal(listener, null) } }
}

const ownedAntigravity = async (hub, actor) => {
  let listener, current = { session: actor.session, status: 'idle', turns: 0, step: -1 }
  const transport = {
    listen: one => { listener = one; return () => { listener = null } },
    write: async value => {
      assert.equal(value.event, 'user')
      const message = promptParts(value.message.content)
      actor.received.push(message)
      const turns = current.turns + 1, step = current.step + 1
      listener({ event: 'step_update', step_update: { conversation_id: actor.session, step_type: 'user_input', state: 'DONE', step_index: step } })
      current = { session: actor.session, status: 'idle', turns, step }
      listener({ event: 'result', result: { conversation_id: actor.session, num_turns: turns, status: 'SUCCESS', response: 'ACK ' + message.id } })
    },
  }
  const connector = await attachAntigravitySession({ boardUrl: hub.server.url, transport, session: actor.session, state: () => current, verifyOwner: one => one === transport, surface: 'Synthetic Antigravity stream', onError: error => actor.errors.push(error.message) })
  return { ...connector, close: async () => { await connector.close(); assert.equal(listener, null) } }
}

// The proxy launches only inside a makeWorld child, because the production
// connector inherits its parent's environment when it starts the supplied proxy.
const proxyCodex = async (hub, actor) => {
  const log = hub.world.write('proxy-rpc.jsonl', '')
  const fake = hub.world.write('mock-proxy.mjs', `import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const emit = value => console.log(JSON.stringify(value))
process.stdin.once('end', () => process.exit(0))
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line)
  appendFileSync(${JSON.stringify(log)}, line + '\\n')
  if (value.method === 'initialize') emit({ id: value.id, result: {} })
  if (value.method === 'thread/loaded/list') emit({ id: value.id, result: { data: [${JSON.stringify(actor.session)}], nextCursor: null } })
  if (value.method === 'turn/steer') {
    emit({ id: value.id, result: { turnId: 'proxy-turn' } })
    const id = value.params.input[0].text.match(/^Agent Board message (\\S+)/)[1]
    emit({ method: 'item/completed', params: { threadId: ${JSON.stringify(actor.session)}, turnId: 'proxy-turn', item: { type: 'agentMessage', text: 'ACK ' + id } } })
  }
})
`)
  const module = new URL('../../../scripts/codex-message-connector.mjs', import.meta.url).href
  const runner = hub.world.write('proxy-owner.mjs', `import { connectCodexProxy } from ${JSON.stringify(module)}
const originalFetch = globalThis.fetch
let hasPolled = false
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args)
  if (!hasPolled && new URL(args[0]).pathname === '/api/messages/poll' && response.ok) {
    hasPolled = true
    console.log(JSON.stringify({ initialPollComplete: true }))
  }
  return response
}
const connector = await connectCodexProxy(${JSON.stringify({ boardUrl: hub.server.url, executable: fake, thread: actor.session, turn: 'proxy-turn' })})
console.log(JSON.stringify({ id: connector.id, turn: connector.turn }))
process.stdin.once('data', async () => { await connector.close(); process.stdin.destroy() })
`)
  const child = spawnIsolated(process.execPath, [runner], { cwd: hub.world.root, env: hub.world.env, stdio: ['pipe', 'pipe', 'pipe'] })
  ownedProxies.add(child)
  let output = '', errors = '', failure, isClosed = false
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  child.on('error', error => { failure = error })
  const exited = new Promise(done => child.once('close', () => { ownedProxies.delete(child); done() }))
  const stop = async () => {
    if (isClosed) return
    isClosed = true
    clearTimeout(timer)
    if (child.exitCode === null) child.stdin.end('close\n')
    await Promise.race([exited, pause(1000)])
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
    child.stdin.destroy()
    const pid = JSON.parse(readFileSync(log, 'utf8').split('\n')[0]).pid
    for (let n = 0; n < 20 && isAlive(pid); n++) await pause(50)
    // The proxy exits on its owned pipe's EOF; a stale log pid is never authority to kill.
    assert.ok(!isAlive(pid), 'Synthetic proxy survived teardown')
    assert.ok(!isAlive(child.pid), 'Synthetic connector survived teardown')
  }
  const timer = setTimeout(() => { child.kill() }, 20000)
  hub.world.cleanups.push(stop)
  await seenWithin(() => {
    if (failure) throw failure
    assert.equal(child.exitCode, null, errors)
    return output
  }, text => {
    const records = text.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return {} } })
    return records.some(one => one.id) && records.some(one => one.initialPollComplete)
  }, 8000)
  // Queue after the proxy's initial empty poll, so its receipt budget cannot
  // accidentally use the startup poll as an immediate-delivery fast path.
  const binding = output.trim().split('\n').map(JSON.parse).find(one => one.id)
  actor.refresh = () => {
    actor.received = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(one => one.method === 'turn/steer').map(one => promptParts(one.params.input[0].text))
  }
  return { ...binding, close: stop }
}

const isAlive = pid => {
  try { process.kill(pid, 0); return true } catch { return false }
}

export const NATIVE_RECEIVERS = {
  codex: { label: 'a Codex', attach: ownedCodex, proxy: proxyCodex },
  antigravity: { label: 'an Antigravity', attach: ownedAntigravity },
}
export const SENDERS = ['page', 'codex', 'antigravity']
export const RECEIVERS = ['claude', 'codex', 'antigravity', 'hermes', 'grok', 'opencode', 'openclaw', 'gemini', 'cursor', 'muse', 'deepseek']
export const GAPS = {
  claude: 58,
  hermes: 233,
  grok: 'hold:grok-receiver',
  opencode: 'hold:opencode-receiver',
  openclaw: 'hold:openclaw-receiver',
  gemini: 'hold:gemini-receiver',
  cursor: 'hold:cursor-receiver',
  muse: 'hold:muse-receiver',
  deepseek: 'hold:deepseek-receiver',
}
// A receiver either has a native row or names the gap its fallback stands for, never both or neither.
for (const name of RECEIVERS) assert.ok((name in NATIVE_RECEIVERS) !== (name in GAPS), `${name} must be in exactly one of NATIVE_RECEIVERS and GAPS`)
for (const name of [...Object.keys(NATIVE_RECEIVERS), ...Object.keys(GAPS)]) assert.ok(RECEIVERS.includes(name), `${name} is missing from RECEIVERS`)

const connectorSource = readFileSync(new URL('../../../scripts/message-client.mjs', import.meta.url), 'utf8')
const connectorPoll = connectorSource.match(/setInterval\(\(\) => \{ void poll\(\) \}, (\d+)\)/)
assert.ok(connectorPoll, 'Read the connector poll interval from its shipped source')
export const CONNECTOR_POLL_MS = Number(connectorPoll[1])

export const receiptBudget = async hub => {
  const pagePollMs = (await hub.page()).pollMs
  assert.ok(Number.isFinite(pagePollMs) && pagePollMs > 0, 'Read the page poll interval from its shipped setTimeout')
  const combined = CONNECTOR_POLL_MS + pagePollMs
  await knownFailure('hold:page-poll-budget', () => assert.ok(combined <= PAGE_MS, `Connector poll ${CONNECTOR_POLL_MS} + page poll ${pagePollMs} exceeds PAGE_MS ${PAGE_MS}`))
  return { pagePollMs, measuredMs: combined + RECEIPT_SLACK_MS }
}

export const withHub = async (specs, fn) => {
  const world = makeWorld()
  // Messaging leases and latency use real clocks in both parent and server; with no jump,
  // world.now is the real time too.
  world.env.NODE_OPTIONS = world.env.NODE_OPTIONS.split(' ').filter(one => !one.includes('clock-preload')).join(' ')
  let server
  try {
    const actors = specs.map((spec, index) => ({ ...spec, session: `${String(index + 1).padStart(8, '0')}-2222-4333-8444-555555555555`, block: (0xa1000001 + index).toString(16), title: spec.title ?? `Prepare ${spec.agent} ${index + 1}`, received: [], errors: [] }))
    for (const actor of actors) block(world, { agent: actor.agent, session: actor.block, resume: actor.session, dir: world.root, title: actor.title, updated: new Date().toISOString(), steps: ['- [~] Review synthetic message'] })
    server = await serve.start(world, ['--messages-dir', dirname(world.write('messages/.keep', ''))])
    let dom
    const hub = {
      world, server, actors,
      snapshot: async () => (await server.get('/api/board')).json(),
      page: async () => {
        const model = (await hub.snapshot()).model
        if (!dom) dom = await pageDom((await server.get(new URL(server.url).pathname + new URL(server.url).search)).body, model, async request => {
          const response = await server.post(request.path, request.body)
          return { ok: response.status < 400, json: async () => response.json() }
        })
        else await dom.redraw(model)
        return dom
      },
      card: async actor => {
        const page = await hub.page()
        const card = page.cards().find(one => one.textContent.includes(actor.title))
        assert.ok(card, 'Missing card: ' + actor.title + '\n' + page.text())
        return card
      },
      draft: async (actor, text) => {
        const card = await hub.card(actor)
        const input = dom.inputs(card)[0]
        assert.ok(input, 'No message box on ' + card.textContent)
        input.value = text
        const button = dom.buttons(card).find(one => /^(?:Send|Copy$)/.test(one.textContent))
        assert.ok(button, card.textContent)
        return { card, button, before: card.textContent }
      },
      click: async draft => {
        draft.button.click()
        await dom.flush()
        return { before: draft.before, after: dom.text(), surface: 'serve', card: draft.card.textContent, button: draft.button.textContent }
      },
      send: async (source, target, text, id = 'AB-synthetic-message') => {
        const started = performance.now()
        if (source === 'page') {
          const draft = await hub.draft(target, text)
          const press = await hub.click(draft)
          await hub.page()
          const after = (await hub.card(target)).textContent
          noSilentPress({ ...press, after })
          const request = dom.requests.at(-1)
          assert.equal(request?.body.type, 'message')
          return { id: request.body.id, text, started, from: 'board' }
        }
        assert.ok(source.connector, 'Sender has no native connection')
        assert.ok(target.connector, 'Target has no native connection')
        await source.connector.send({ id, target: target.connector.id, turn: target.connector.turn, text })
        return { id, text, started, from: source.agent + ':' + source.session }
      },
      receipt: async (actor, sent) => {
        let receipt, card
        const budget = await receiptBudget(hub)
        await seenWithin(async () => {
          const snapshot = await hub.snapshot()
          receipt = snapshot.messaging.messages.find(one => one.id === sent.id)
          card = (await hub.card(actor)).textContent
          return card
        }, text => receipt?.status === 'acknowledged' && receipt.reply.startsWith('ACK ' + sent.id) && text.includes('Replied'), Math.max(1, budget.measuredMs - budget.pagePollMs - (performance.now() - sent.started)))
        const elapsed = performance.now() - sent.started + budget.pagePollMs
        assert.ok(elapsed <= budget.measuredMs, `${elapsed} ms including the page poll exceeds ${budget.measuredMs} ms`)
        actor.refresh?.()
        const received = actor.received.find(one => one.id === sent.id)
        assert.ok(received, 'Native transport did not receive this message')
        assert.equal(received.text, sent.text)
        assert.equal(received.prompt, deliveryPrompt({ ...sent, from: sent.from }))
        assert.equal(receipt.from, sent.from)
        assert.equal(receipt.to, actor.agent + ':' + actor.session)
        console.log(`receipt ${actor.agent}: ${Math.round(elapsed)} ms`)
        return { receipt, card, elapsed }
      },
      cleanPage: async (sent) => {
        const text = (await hub.page()).text()
        noMachineIds(text, world)
        if (sent) assert.ok(!text.includes(sent.id), 'The page shows the raw message id ' + sent.id)
      },
      fallback: async (actor, text) => {
        const draft = await hub.draft(actor, text)
        assert.equal(draft.button.textContent, 'Copy', draft.card.textContent)
        assert.match(draft.card.textContent, /Copy/)
        const before = dom.text()
        await hub.click(draft)
        assert.equal(dom.copied.at(-1), text)
        noSilentPress({ surface: 'serve', card: actor.title, button: 'Copy', before, after: dom.text() })
        noMachineIds((await hub.card(actor)).textContent, world)
      },
    }
    for (const actor of actors) {
      const native = NATIVE_RECEIVERS[actor.agent]
      if (native && actor.connect !== false) {
        actor.connector = await (actor.mode === 'proxy' ? native.proxy : native.attach)(hub, actor)
        world.cleanups.push(() => actor.connector.close())
      }
    }
    await fn(hub)
  } finally {
    await world.close()
  }
}

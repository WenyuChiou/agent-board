import { registerHooks } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(specifier + '.ts', context)
  }
} })

const { DELIVERY_EVENTS, DELIVERY_STATES, DELIVERY_TABLE, SAMPLE_NOW, SUSPECT_CELLS, applyEvent, observe, observeHolds, rowOf, sampleBinding, sampleOf, shapesOf, stateOf } = await import('../hooks/delivery-states.ts')
const { FINISHED_KEEP_MS, MAILBOX_LEASE_MS, MAILBOX_REDELIVERIES, MCP_SURFACE, OPEN_LIMIT_MS, claimMessages, disconnectMessages, dismissMessage, isMailboxSurfaceLost, isMailboxTarget, isOpen, messageReceipt, pruneMessages, queueMessage, rebindMessages, shownMessage } = await import('../hooks/messaging.ts')
const { releaseMailboxMessage } = await import('../hooks/hook-messages.ts')
const { restartMessages } = await import('../hooks/messaging.ts')
const { mailboxAction } = await import('../scripts/board-messaging.ts')
const { servePage } = await import('../hooks/serve.ts')
const { STRINGS } = await import('../hooks/strings.ts')
const { EN } = await import('../hooks/strings-en.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')
const { ZH_CN } = await import('../hooks/strings-zh-cn.ts')

// Every state with no shape, then in each of its shapes.
const shapeNames = name => [undefined, ...Object.keys(shapesOf(name))]
const label = (name, shape) => shape === undefined ? name : `${name}.${shape}`
const isBoardError = error => /^[A-Z_]+$/.test(error.message)

test('every cell of the delivery table matches what hooks/messaging.ts does today (#1543)', () => {
  assert.deepEqual(Object.keys(DELIVERY_TABLE), [...DELIVERY_STATES])
  const wrong = []
  for (const name of DELIVERY_STATES) {
    assert.deepEqual(Object.keys(DELIVERY_TABLE[name].on), [...DELIVERY_EVENTS], name)
    for (const shape of Object.keys(DELIVERY_TABLE[name].shapes ?? {})) assert.ok(shape in shapesOf(name), `${name}: the table names a shape ${shape} no sample makes`)
    for (const shape of shapeNames(name)) {
      const where = label(name, shape)
      const row = rowOf(name, shape)
      // Each sample reads as its state, so a cell's next state names what the code produced.
      const read = stateOf(sampleOf(name, shape).message)
      if (read !== name) wrong.push(`${where}: its sample reads as ${read}`)
      const holds = observeHolds(name, shape)
      for (const key of ['holdsSend', 'holdsStart']) if (holds[key] !== row[key]) wrong.push(`${where} ${key}: table ${row[key]}, code ${holds[key]}`)
      for (const event of DELIVERY_EVENTS) {
        const code = observe(name, event, shape)
        if (code !== row.on[event]) wrong.push(`${where} x ${event}: table ${row.on[event]}, code ${code}`)
      }
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n'))
  for (const [state, event] of SUSPECT_CELLS) assert.ok(DELIVERY_STATES.includes(state) && DELIVERY_EVENTS.includes(event), `${state} x ${event}`)
})

// The page's own card selector (receiptLine and claudeReceipt in hooks/serve.ts), run on the receipt the board sends.
const page = servePage(STRINGS.en, 'synthetic')
const pageFunction = name => {
  const start = page.indexOf(`\n  function ${name}(`)
  assert.ok(start >= 0, `the page has no function ${name}`)
  return page.slice(start, page.indexOf('\n  }\n', start) + 4)
}
const selector = page.match(/\n {2}var ENDED_UNCERTAIN_ERRORS = .*;\n/)[0]
  + ['isEndedUncertainReceipt', 'releaseFinishedAttempt', 'receiptFailed', 'claudeReceipt', 'receiptLine'].map(pageFunction).join('\n')
const node = (tag, cls, text) => ({ tag, cls, text, children: [], setAttribute() {} })
const pageScope = {
  el: node, add: (parent, ...kids) => { parent.children.push(...kids.filter(Boolean)); return parent }, w: key => key, button: () => node('button'),
  dismissButton: () => node('button'), copy() {}, clearEnqueueResult() {}, isClaudeAgent: agent => agent === 'claude', agentName: agent => agent, sentLast: {}, messageAttempts: {},
}
runInNewContext(selector, pageScope)
// The key of the card's line: the first part of the receipt element's text, which `w` leaves as the key.
const lineOf = one => one == null ? null : (one.cls ?? '').split(' ').includes('receipt') ? one.text.split(' · ')[0] : one.children.map(lineOf).find(Boolean) ?? null
// A message's receipt as rowReceipt in hooks/serve.ts sends it, on the default route.
const cardOf = (name, shape, agent) => {
  const { message, state } = sampleOf(name, shape)
  const receipt = {
    id: message.id, status: message.status, reply: shownMessage(message).reply, error: message.error, text: message.text,
    ...(message.hasAccepted === true ? { hasAccepted: true } : {}), ...(isMailboxSurfaceLost(message, state.mailboxes) ? { isSurfaceLost: true } : {}),
    isMailbox: isMailboxTarget(message.target), when: '',
  }
  return lineOf(pageScope.receiptLine(receipt, 'k', agent, true, undefined))
}

test('every card line in the delivery table is the one the page picks (#1543)', () => {
  const wrong = []
  for (const name of DELIVERY_STATES) {
    for (const shape of shapeNames(name)) {
      const row = rowOf(name, shape)
      for (const [key, agent] of [['card', 'codex'], ['claudeCard', 'claude']]) {
        const shown = cardOf(name, shape, agent)
        if (shown !== row[key]) wrong.push(`${label(name, shape)} ${key}: table ${row[key]}, page ${shown}`)
        if (row[key] === null) continue
        for (const [lang, table] of [['en', EN], ['zh-TW', ZH_TW], ['zh-CN', ZH_CN]]) if (table[row[key]] === undefined) wrong.push(`${label(name, shape)}: ${row[key]} is missing from ${lang}`)
      }
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n'))
})

test('no uncertain receipt sends again a message its host accepted before, in any state of the table (#1553, #1407)', () => {
  const wrong = []
  for (const name of DELIVERY_STATES) {
    for (const shape of shapeNames(name)) {
      const { message, binding, state } = sampleOf(name, shape)
      let after
      try {
        after = applyEvent(state, message, binding, 'unsure').state
      } catch (error) {
        assert.ok(isBoardError(error), `${label(name, shape)}: ${error.stack}`)
      }
      // Sent again: its own binding, on its surface, takes it at once, once its lease passed, or after its hook hands it back
      // (plainly, or as a wake never sent).
      let isSentAgain = false
      if (after !== undefined) {
        const one = after.messages.find(item => item.id === message.id)
        const own = { ...binding, surface: one.surface ?? binding.surface }
        const at = one.updated + 1000
        const back = isUnsent => releaseMailboxMessage(after, binding.agent, binding.session, one.ref ?? '', at, isUnsent)
        isSentAgain = [[after, at], [after, one.claimed + MAILBOX_LEASE_MS], [back(false), at + 1000], [back(true), at + 1000]]
          .some(([store, now]) => claimMessages(store, own, now, 'd4e5f6', binding.scope === 'mailbox' ? 'ba9876543210' : undefined).messages.some(item => item.id === message.id))
      }
      if ((message.status === 'accepted' || message.hasAccepted === true) && isSentAgain) wrong.push(`${label(name, shape)}: accepted before and sent again`)
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n'))
})

test('combined flag shapes predict both card and transitions when independent flags interact (#1560)', () => {
  assert.ok('acceptedBefore+onHook' in shapesOf('turnEnded'))
  const hookAfterAccept = rowOf('turnEnded', 'acceptedBefore+onHook')
  assert.equal(hookAfterAccept.card, 'messagesAcceptedUnconfirmed')
  assert.equal(hookAfterAccept.on.accept, 'handed')
  assert.equal(hookAfterAccept.on.unsure, 'leased')
  assert.equal(observe('turnEnded', 'accept', 'acceptedBefore+onHook'), 'handed')

  assert.equal(rowOf('leased', 'otherSurface+lastRepeat').on.claimLate, 'leased')
  assert.equal(rowOf('inDoubt', 'acceptedBefore+otherError').card, 'messagesAcceptedUnconfirmed')
  assert.equal(rowOf('acceptedLost', 'awaitsAck+otherError').card, 'messagesHandedNow')
  assert.equal(rowOf('turnEnded', 'acceptedBefore+onWake').on.openLimit, 'wakeExpired')
  assert.equal('acceptedBefore+onWake' in shapesOf('expired'), false)
})

test('the delivery table held shape for the Codex desktop app keeps claim queued and rejects at the limits (#1775)', () => {
  assert.ok('appHeld' in shapesOf('queued'), 'queued defines the appHeld shape')
  assert.ok(DELIVERY_TABLE.queued.shapes && 'appHeld' in DELIVERY_TABLE.queued.shapes, 'DELIVERY_TABLE.queued.shapes defines appHeld')
  const row = rowOf('queued', 'appHeld')
  assert.equal(row.on.claim, 'queued')
  assert.equal(row.on.openLimit, 'rejected')
  assert.equal(row.on.dayLimit, 'rejected')
  assert.equal(observe('queued', 'claim', 'appHeld'), 'queued')
  assert.equal(observe('queued', 'openLimit', 'appHeld'), 'rejected')
  assert.equal(observe('queued', 'dayLimit', 'appHeld'), 'rejected')
})

// A small seeded generator, so every run plays the same orders.
const generator = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const EVERY_KIND = ['send', 'send', 'claim', 'claim', 'claim', 'pull', 'wake', 'receipt', 'receipt', 'hook', 'hook', 'dismiss', 'disconnect', 'leave', 'endMailbox', 'restart', 'tick', 'tick', 'tick']

test('short random event orders never lose a message, never send one twice, never start one in a running turn, and never open a finished one (#1543)', () => {
  const reached = new Set()
  let handOuts = 0
  for (let run = 0; run < 300; run++) {
    const random = generator(run + 1)
    const pick = list => list[Math.floor(random() * list.length)]
    // ACK codes and claim names as the board makes and takes them: 6 and 12 hex characters.
    const hex = size => Array.from({ length: size }, () => Math.floor(random() * 16).toString(16)).join('')
    const codexBox = sampleBinding('codex', 'mailbox')
    const opencodeBox = sampleBinding('opencode', 'mailbox')
    let live = sampleBinding('codex', 'live')
    let state = { messages: [], mailboxes: [codexBox, opencodeBox] }
    let now = SAMPLE_NOW
    // Each order sends and takes through some of the receivers: all three, or one alone, so a hook's claim can lapse to its last repeat.
    const using = pick([['live', 'codexBox', 'opencodeBox'], ['live', 'codexBox'], ['codexBox'], ['opencodeBox']])
    const receiver = () => ({ live, codexBox, opencodeBox })[pick(using)]
    // Some orders only send, claim and wait, so a hook's claim can lapse to its last repeat.
    const kinds = pick([EVERY_KIND, EVERY_KIND, EVERY_KIND, ['send', 'claim', 'claim', 'tick']])
    const seen = new Map()
    for (let step = 0; step < 40; step++) {
      const before = state
      const kind = pick(kinds)
      let where = `run ${run}, step ${step}, ${kind}`
      let sent = []
      let body
      try {
        if (kind === 'send') {
          const binding = receiver()
          const id = `m${run}x${step}`
          state = queueMessage(state, { id, target: binding.id, turn: binding.turn, text: `words ${step}` }, 'board', binding, now).state
          seen.set(id, { handed: 0, nonce: '', isAccepted: false, redelivered: 0 })
        } else if (kind === 'claim' || kind === 'pull') {
          // A claim by a receiver, named as a hook names it; or the agent's own MCP pull, an unnamed claim on its mailbox.
          const binding = kind === 'pull' ? { ...pick([codexBox, opencodeBox]), surface: MCP_SURFACE } : receiver()
          const result = claimMessages(state, binding, now, hex(6), kind === 'claim' && binding.scope === 'mailbox' ? hex(12) : undefined)
          state = result.state
          sent = result.messages
        } else if (kind === 'wake') {
          // OpenCode's plugin takes a message under a name and marks the wake it starts, as it does before it calls the host.
          const ref = hex(12)
          const result = claimMessages(state, opencodeBox, now, hex(6), ref)
          sent = result.messages
          state = sent.length === 0 ? result.state : mailboxAction(result.state, 'mailbox-attempt', { agent: 'opencode', session: 's1', ref }, now).state
        } else if (kind === 'receipt' || kind === 'dismiss') {
          const one = pick(state.messages.filter(message => kind === 'dismiss' || message.nonce !== ''))
          if (one !== undefined) {
            const event = kind === 'dismiss' ? 'dismiss' : pick(['accept', 'ack', 'reject', 'fail', 'timeout', 'unsure'])
            where += ` ${event} ${one.id}`
            const status = { accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'uncertain', timeout: 'uncertain', unsure: 'uncertain' }[event]
            const error = { fail: 'TURN_ABORTED', timeout: 'TIMEOUT' }[event]
            const binding = one.to.startsWith('opencode:') ? opencodeBox : live
            state = event === 'dismiss' ? dismissMessage(state, one.id, now) : messageReceipt(state, binding, {
              id: one.id, nonce: one.nonce, status, ...(event === 'ack' ? { reply: `ACK ${one.nonce}` } : {}), ...(error === undefined ? {} : { error }),
            }, now)
          }
        } else if (kind === 'hook') {
          // A hook's own call on a mailbox message, through the board's handler: OpenCode's plugin marks the wake it starts, a
          // hook hands its claim back (OpenCode's plugin says when it never sent it), or a caller that can ACK takes it.
          const one = pick(state.messages.filter(message => isMailboxTarget(message.target) && message.nonce !== ''))
          if (one !== undefined) {
            const agent = one.to.startsWith('opencode:') ? 'opencode' : 'codex'
            const action = pick(agent === 'opencode' ? ['mailbox-attempt', 'mailbox-release', 'mailbox-accept'] : ['mailbox-release', 'mailbox-accept'])
            body = action === 'mailbox-accept' ? { agent, session: 's1', id: one.id, nonce: one.nonce, awaitsAck: true }
              : { agent, session: 's1', ref: one.ref ?? hex(12), ...(action === 'mailbox-release' && agent === 'opencode' && random() < 0.5 ? { unsent: true } : {}) }
            where += ` ${action}${body.unsent ? ' unsent' : ''} ${one.id}`
            state = mailboxAction(state, action, body, now).state
          }
        } else if (kind === 'disconnect' || kind === 'leave') {
          // The live receiver goes and a new one of the same session connects; one that only left keeps its queue for the next.
          state = disconnectMessages(state, live.id, now, kind === 'leave')
          live = { ...live, id: `c${run}x${step}`, turn: `t${run}x${step}` }
          if (kind === 'leave') state = rebindMessages(state, live, id => id === live.id)
        } else if (kind === 'endMailbox') {
          state = disconnectMessages(state, pick([codexBox, opencodeBox]).id, now)
        } else if (kind === 'restart') {
          // The board starts again and loads the store (#1407).
          state = restartMessages(state, now)
        } else {
          // Mostly short steps and lease ends, so a hook's claim can lapse up to its last repeat.
          now += pick([1000, MAILBOX_LEASE_MS, MAILBOX_LEASE_MS, MAILBOX_LEASE_MS, OPEN_LIMIT_MS + 1000, FINISHED_KEEP_MS + 1000])
          state = pruneMessages(state, now)
        }
      } catch (error) {
        // The board refused the event and kept the store as it was.
        assert.ok(isBoardError(error), `${where}: ${error.stack}`)
        assert.equal(state, before, `${where}: ${error.message}`)
      }
      for (const one of before.messages) {
        const after = state.messages.find(message => message.id === one.id)
        if (isOpen(one)) {
          // Never lost: an open message stays in the store with its words.
          assert.ok(after !== undefined, `${where}: open message ${one.id} (${stateOf(one)}) left the store`)
          if (isOpen(after)) assert.notEqual(after.text, '', `${where}: open message ${one.id} lost its words`)
        } else {
          // Never opened again: a finished message stays finished until it leaves the store.
          assert.ok(after === undefined || !isOpen(after), `${where}: finished message ${one.id} (${stateOf(one)}) opened again as ${after && stateOf(after)}`)
        }
        // A started wake goes back to the queue only when its plugin says the host was never called (#724).
        if (one.attempted !== undefined && after?.status === 'queued') assert.ok(body?.unsent === true, `${where}: started wake ${one.id} went back to the queue`)
      }
      for (const one of sent) {
        handOuts++
        const earlier = before.messages.find(message => message.id === one.id)
        const record = seen.get(one.id)
        assert.ok(earlier !== undefined && isOpen(earlier), `${where}: ${one.id} was handed out from ${earlier && stateOf(earlier)}`)
        // Never sent twice: a message goes out again only while nobody took it, with its first ACK code. Taken again after its
        // lease passed, a started wake never goes, and a hook's claim says it is a repeat, up to the last; handed back by its
        // hook, it goes as it was.
        if (record.handed > 0) {
          assert.ok(!record.isAccepted, `${where}: ${one.id} was handed out again after it was accepted`)
          assert.equal(one.nonce, record.nonce, `${where}: ${one.id} went out again under a new ACK code`)
          if (earlier.status === 'queued') assert.equal(one.redelivered ?? 0, record.redelivered, `${where}: ${one.id} came back with ${one.redelivered} repeats`)
          else {
            assert.equal(earlier.attempted, undefined, `${where}: ${one.id}, a started wake, went out again`)
            if (!one.to.startsWith('opencode:')) assert.ok(one.redelivered === record.redelivered + 1 && one.redelivered <= MAILBOX_REDELIVERIES, `${where}: ${one.id} went out again ${one.redelivered} times`)
          }
        }
        // Never started in a running turn: no other message of the session is in a state the table says may still run.
        for (const other of before.messages.filter(message => message.to === one.to && message.id !== one.id)) {
          assert.ok(!DELIVERY_TABLE[stateOf(other)].holdsStart, `${where}: ${one.id} went out while ${other.id} was ${stateOf(other)}`)
        }
        record.handed++
        record.nonce = one.nonce
        record.redelivered = one.redelivered ?? 0
      }
      for (const one of state.messages) {
        reached.add(stateOf(one))
        const record = seen.get(one.id)
        if (one.status === 'accepted' || one.status === 'acknowledged' || one.hasAccepted === true) record.isAccepted = true
      }
    }
  }
  // The orders reach every state of the table.
  assert.deepEqual(DELIVERY_STATES.filter(name => !reached.has(name)), [])
  assert.ok(handOuts > 300, `only ${handOuts} hand-outs`)
})

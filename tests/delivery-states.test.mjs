import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DELIVERY_EVENTS, DELIVERY_STATES, DELIVERY_TABLE, SAMPLE_NOW, SUSPECT_CELLS, isSuspect, observe, observeHolds, sampleBinding, sampleOf, stateOf } from '../hooks/delivery-states.ts'
import { FINISHED_KEEP_MS, MAILBOX_LEASE_MS, MAILBOX_REDELIVERIES, OPEN_LIMIT_MS, claimMessages, disconnectMessages, dismissMessage, isOpen, messageReceipt, pruneMessages, queueMessage, rebindMessages } from '../hooks/messaging.ts'
import { EN } from '../hooks/strings-en.ts'
import { ZH_TW } from '../hooks/i18n.ts'
import { ZH_CN } from '../hooks/strings-zh-cn.ts'

test('every cell of the delivery table matches what hooks/messaging.ts does today (#1543)', () => {
  assert.deepEqual(Object.keys(DELIVERY_TABLE), [...DELIVERY_STATES])
  const wrong = []
  for (const name of DELIVERY_STATES) {
    const row = DELIVERY_TABLE[name]
    assert.deepEqual(Object.keys(row.on), [...DELIVERY_EVENTS], name)
    // Each state's sample reads as that state, so a cell's next state names what the code produced.
    if (stateOf(sampleOf(name).message) !== name) wrong.push(`${name}: its sample reads as ${stateOf(sampleOf(name).message)}`)
    const holds = observeHolds(name)
    for (const key of ['holdsSend', 'holdsStart']) if (holds[key] !== row[key]) wrong.push(`${name} ${key}: table ${row[key]}, code ${holds[key]}`)
    for (const event of DELIVERY_EVENTS) {
      const code = observe(name, event)
      if (code !== row.on[event]) wrong.push(`${name} x ${event}: table ${row.on[event]}, code ${code}`)
    }
    for (const key of [row.card, row.claudeCard].filter(one => one !== null)) {
      for (const [lang, table] of [['en', EN], ['zh-TW', ZH_TW], ['zh-CN', ZH_CN]]) if (table[key] === undefined) wrong.push(`${name}: card line ${key} is missing from ${lang}`)
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n'))
  for (const [state, event] of SUSPECT_CELLS) assert.ok(DELIVERY_STATES.includes(state) && DELIVERY_EVENTS.includes(event), `${state} x ${event}`)
})

// A small seeded generator, so every run plays the same orders.
const generator = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

test('short random event orders never lose a message, never send one twice, and never start one in a running turn (#1543)', () => {
  const reached = new Set()
  let handOuts = 0
  for (let run = 0; run < 300; run++) {
    const random = generator(run + 1)
    const pick = list => list[Math.floor(random() * list.length)]
    const codexBox = sampleBinding('codex', 'mailbox')
    const opencodeBox = sampleBinding('opencode', 'mailbox')
    let live = sampleBinding('codex', 'live')
    let state = { messages: [], mailboxes: [codexBox, opencodeBox] }
    let now = SAMPLE_NOW
    // Each order sends and takes through some of the receivers: all three, or one alone, so a hook's claim can lapse to its last repeat.
    const using = pick([['live', 'codexBox', 'opencodeBox'], ['live', 'codexBox'], ['codexBox'], ['opencodeBox']])
    const receiver = () => ({ live, codexBox, opencodeBox })[pick(using)]
    const seen = new Map()
    for (let step = 0; step < 40; step++) {
      const before = state
      const kind = pick(['send', 'send', 'claim', 'claim', 'claim', 'receipt', 'receipt', 'dismiss', 'disconnect', 'leave', 'endMailbox', 'tick', 'tick', 'tick'])
      const where = `run ${run}, step ${step}, ${kind}`
      let sent = []
      try {
        if (kind === 'send') {
          const binding = receiver()
          const id = `m${run}x${step}`
          state = queueMessage(state, { id, target: binding.id, turn: binding.turn, text: `words ${step}` }, 'board', binding, now).state
          seen.set(id, { handed: 0, nonce: '', isAccepted: false, redelivered: 0 })
        } else if (kind === 'claim') {
          const binding = receiver()
          const result = claimMessages(state, binding, now, `n${run}x${step}`, binding.scope === 'mailbox' ? `r${run}x${step}` : undefined)
          state = result.state
          sent = result.messages
        } else if (kind === 'receipt' || kind === 'dismiss') {
          const one = pick(state.messages.filter(message => kind === 'dismiss' || message.nonce !== ''))
          if (one !== undefined) {
            const event = kind === 'dismiss' ? 'dismiss' : pick(['accept', 'ack', 'reject', 'fail', 'timeout', 'unsure'])
            const status = { accept: 'accepted', ack: 'acknowledged', reject: 'rejected', fail: 'uncertain', timeout: 'uncertain', unsure: 'uncertain' }[event]
            const error = { fail: 'TURN_ABORTED', timeout: 'TIMEOUT' }[event]
            const binding = one.to.startsWith('opencode:') ? opencodeBox : live
            if (!isSuspect(one, event)) {
              state = event === 'dismiss' ? dismissMessage(state, one.id, now) : messageReceipt(state, binding, {
                id: one.id, nonce: one.nonce, status, ...(event === 'ack' ? { reply: `ACK ${one.nonce}` } : {}), ...(error === undefined ? {} : { error }),
              }, now)
            }
          }
        } else if (kind === 'disconnect' || kind === 'leave') {
          // The live receiver goes and a new one of the same session connects; one that only left keeps its queue for the next.
          state = disconnectMessages(state, live.id, now, kind === 'leave')
          live = { ...live, id: `c${run}x${step}`, turn: `t${run}x${step}` }
          if (kind === 'leave') state = rebindMessages(state, live, id => id === live.id)
        } else if (kind === 'endMailbox') {
          state = disconnectMessages(state, pick([codexBox, opencodeBox]).id, now)
        } else {
          // Mostly short steps and lease ends, so a hook's claim can lapse up to its last repeat.
          now += pick([1000, MAILBOX_LEASE_MS, MAILBOX_LEASE_MS, MAILBOX_LEASE_MS, OPEN_LIMIT_MS + 1000, FINISHED_KEEP_MS + 1000])
          state = pruneMessages(state, now)
        }
      } catch (error) {
        // The board refused the event and kept the store as it was.
        assert.equal(state, before, `${where}: ${error.message}`)
      }
      // Never lost: an open message stays in the store with its words.
      for (const one of before.messages.filter(isOpen)) {
        const after = state.messages.find(message => message.id === one.id)
        assert.ok(after !== undefined, `${where}: open message ${one.id} (${stateOf(one)}) left the store`)
        if (isOpen(after)) assert.notEqual(after.text, '', `${where}: open message ${one.id} lost its words`)
      }
      for (const one of sent) {
        handOuts++
        const earlier = before.messages.find(message => message.id === one.id)
        const record = seen.get(one.id)
        assert.ok(earlier !== undefined && isOpen(earlier), `${where}: ${one.id} was handed out from ${earlier && stateOf(earlier)}`)
        // Never sent twice: a message goes out again only while nobody took it, with its first ACK code, and a repeat says it is one.
        if (record.handed > 0) {
          assert.ok(!record.isAccepted, `${where}: ${one.id} was handed out again after it was accepted`)
          assert.equal(one.nonce, record.nonce, `${where}: ${one.id} went out again under a new ACK code`)
          if (!one.to.startsWith('opencode:')) assert.ok(one.redelivered === record.redelivered + 1 && one.redelivered <= MAILBOX_REDELIVERIES, `${where}: ${one.id} went out again ${one.redelivered} times`)
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
  // The orders reach every state that messaging.ts events alone can lead to; the OpenCode wake states need the plugin's mark.
  const unreached = DELIVERY_STATES.filter(name => !reached.has(name))
  assert.deepEqual(unreached, ['wakeStarted', 'acceptedAwaitsAck', 'wakeAccepted', 'unconfirmed'])
  assert.ok(handOuts > 300, `only ${handOuts} hand-outs`)
})

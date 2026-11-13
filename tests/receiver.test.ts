import { expect, test } from './kit'

import type { ReceiverState } from '../types'
import { ackLine, addressFileName, addressFolder, addressKey, createReceiver, emptyReceiver, parseAddress } from '../hooks/receiver'
import type { HubAnswer } from '../hooks/receiver'
import { sha256 } from '../hooks/sha256'

const SESSION = '11111111-2222-3333-4444-555555555555'
const NONCE = 'a1b2c3'
const MESSAGE = { id: 'AB-1', nonce: NONCE, prompt: `Agent Board message\n<<<AB-${NONCE}\nhello\nAB-${NONCE}>>>` }

type Sent = { action: string; body: Record<string, unknown> }

// A stand-in for the hub and the engine: the calls it saw, and what the engine answers a submit.
const world = () => {
  const sent: Sent[] = []
  const submitted: unknown[][] = []
  const box = {
    sent, submitted,
    busy: false,
    at: 1000,
    session: SESSION,
    queue: [] as unknown[],
    hasAddress: true,
    answers: new Map<string, HubAnswer | null>(),
    kept: undefined as ReceiverState | undefined,
    engine: (): Promise<{ drop?: string }> => Promise.resolve({}),
    onReceipt: null as null | (() => Promise<void>),
  }
  const receiver = () => createReceiver({
    session: async () => box.session,
    address: async () => (box.hasAddress ? { origin: 'http://127.0.0.1:1', token: 't' } : null),
    call: async (_, action, body) => {
      sent.push({ action, body })
      if (action === 'receipt' && box.onReceipt !== null) { const run = box.onReceipt; box.onReceipt = null; await run() }
      const answer = box.answers.get(action)
      if (answer === null) throw new Error('unreachable')
      if (answer !== undefined) return answer
      if (action === 'register') return { status: 200, json: { id: `c${sent.length}`, secret: 's', leaseMs: 15000 } }
      if (action === 'poll') return { status: 200, json: { messages: body.receive === true ? box.queue.splice(0, 1) : [], leaseMs: 15000 } }
      return { status: 200, json: { ok: true } }
    },
    isBusy: () => box.busy,
    now: async () => box.at,
    submit: (...args: unknown[]) => { submitted.push(args); return box.engine() },
    load: async () => box.kept,
    save: async state => { box.kept = state },
  })
  return { sent, submitted, get: () => box, receiver }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const of = (sent: Sent[], action: string): Sent[] => sent.filter(one => one.action === action)
const receipts = (sent: Sent[]): Array<Record<string, unknown>> => of(sent, 'receipt').map(one => one.body)

test('an idle Claude session claims a board message and starts one turn with it', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  const r = w.receiver()
  await r.tick()
  const registered = of(w.sent, 'register')[0]?.body
  expect(registered?.agent).toBe('claude')
  expect(registered?.session).toBe(SESSION)
  expect(registered?.scope).toBe('session')
  expect(registered?.turn).toBe('session')
  expect(of(w.sent, 'poll')[0]?.body.receive).toBe(true)
  expect(receipts(w.sent).map(one => one.status)).toEqual(['accepted'])
  expect(w.submitted.length).toBe(1)
  await settle()
  expect(await r.turnStarted(MESSAGE.prompt, 't1')).toBe(true)
  expect(await r.turnEnded('t1', `ACK ${NONCE}\nDone.`, false)).toBe(true)
  expect(receipts(w.sent).at(-1)?.status).toBe('acknowledged')
  await r.tick()
  expect(w.submitted.length).toBe(1)
})

test('a busy session keeps its lease with receive=false and takes the message after its turn', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  w.get().busy = true
  const r = w.receiver()
  await r.tick()
  await r.tick()
  expect(of(w.sent, 'poll').map(one => one.body.receive)).toEqual([false, false])
  expect(w.submitted.length).toBe(0)
  w.get().busy = false
  await r.tick()
  expect(w.submitted.length).toBe(1)
})

test('an interrupted Claude delivery is rejected as stopped and not resubmitted', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  w.get().engine = async () => ({ drop: 'the session was stopped and nobody has sent input since' })
  const r = w.receiver()
  await r.tick()
  await settle()
  expect(receipts(w.sent).at(-1)).toMatchObject({ id: 'AB-1', status: 'rejected', error: 'STOPPED' })
  await r.tick()
  expect(of(w.sent, 'poll').at(-1)?.body.receive).toBe(false)
  expect(w.submitted.length).toBe(1)
  // The person's own turn lifts the stop.
  expect(await r.turnStarted('carry on', 't2')).toBe(false)
  await r.tick()
  expect(of(w.sent, 'poll').at(-1)?.body.receive).toBe(true)
  expect(w.submitted.length).toBe(1)
})

test('a delivered message is submitted without asUser, inside a claim-time boundary', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  await w.receiver().tick()
  // The hub's framed text, as it came, and nothing else: register.tsx passes it as { text } alone.
  expect(w.submitted[0]).toEqual([MESSAGE.prompt])
  expect(String(w.submitted[0]?.[0])).toContain(`<<<AB-${NONCE}`)
  // The boundary comes first: the receipt was on its way before the engine saw the prompt.
  expect(receipts(w.sent)[0]?.status).toBe('accepted')
  const refused = world()
  refused.get().queue.push(MESSAGE)
  refused.get().answers.set('receipt', { status: 400, json: { error: 'MESSAGE_DISMISSED' } })
  await refused.receiver().tick()
  expect(refused.submitted.length).toBe(0)
})

test('an ACK on any reply line acknowledges and nothing else from the reply is kept', async () => {
  expect(ackLine(`ACK ${NONCE}\nsecret answer`, NONCE)).toBe(`ACK ${NONCE}`)
  expect(ackLine(`ACK ${NONCE} on it`, NONCE)).toBe(`ACK ${NONCE} on it`)
  expect(ackLine(`ACK ${NONCE} ${'x'.repeat(300)}`, NONCE)).toBe(`ACK ${NONCE}`)
  expect(ackLine(`Sure.\nACK ${NONCE}`, NONCE)).toBe(`ACK ${NONCE}`)
  expect(ackLine(`ACK ${NONCE}x`, NONCE)).toBe(null)
  expect(ackLine('ACK ffffff', NONCE)).toBe(null)
  expect(ackLine(`ACK ${NONCE}\rmore`, NONCE)).toBe(null)
  const w = world()
  w.get().queue.push(MESSAGE)
  const r = w.receiver()
  await r.tick()
  await settle()
  await r.turnStarted(MESSAGE.prompt, 't1')
  await r.turnEnded('t1', `Done.\nACK ${NONCE}\nThe whole answer, which stays in Claude.`, false)
  expect(receipts(w.sent).at(-1)).toMatchObject({ status: 'acknowledged', reply: `ACK ${NONCE}` })
  expect(JSON.stringify(w.sent)).not.toContain('The whole answer')
  const none = world()
  none.get().queue.push(MESSAGE)
  const silent = none.receiver()
  await silent.tick()
  await settle()
  await silent.turnStarted(MESSAGE.prompt, 't1')
  await silent.turnEnded('t1', 'No ack here.', false)
  expect(receipts(none.sent).at(-1)).toMatchObject({ status: 'uncertain', error: 'ACK_MISSING' })
  expect(JSON.stringify(none.sent)).not.toContain('No ack here')
})

test('the person typing first is not taken for the delivery, and only its own turn acknowledges', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  const r = w.receiver()
  await r.tick()
  await settle()
  expect(await r.turnStarted('something the person typed', 't1')).toBe(false)
  expect(await r.turnEnded('t1', `ACK ${NONCE}`, false)).toBe(false)
  expect(receipts(w.sent).map(one => one.status)).toEqual(['accepted'])
  expect(await r.turnStarted(MESSAGE.prompt, 't2')).toBe(true)
  expect(await r.turnEnded('t2', `ACK ${NONCE}`, false)).toBe(true)
  expect(receipts(w.sent).at(-1)?.status).toBe('acknowledged')
})

test('a delivery turn the person stops is uncertain, and a submit that throws is too', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  const r = w.receiver()
  await r.tick()
  await settle()
  await r.turnStarted(MESSAGE.prompt, 't1')
  await r.turnEnded('t1', `ACK ${NONCE}`, true)
  expect(receipts(w.sent).at(-1)).toMatchObject({ status: 'uncertain', error: 'TURN_ABORTED' })
  const thrown = world()
  thrown.get().queue.push(MESSAGE)
  thrown.get().engine = async () => { throw new Error('no') }
  await thrown.receiver().tick()
  await settle()
  expect(receipts(thrown.sent).at(-1)).toMatchObject({ status: 'uncertain', error: 'DELIVERY_UNCERTAIN' })
})

test('a prompt handed over with no turn to show for it is uncertain, once, and never sent again', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  const r = w.receiver()
  await r.tick()
  await settle()
  w.get().at += 29_000
  await r.tick()
  expect(receipts(w.sent).length).toBe(1)
  w.get().at += 1_000
  await r.tick()
  expect(receipts(w.sent).at(-1)).toMatchObject({ status: 'uncertain', error: 'DELIVERY_UNCERTAIN' })
  await r.tick()
  expect(receipts(w.sent).length).toBe(2)
  expect(w.submitted.length).toBe(1)
})

test('an accepted receipt the hub did not answer is asked again and nothing reaches Claude first', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  w.get().answers.set('receipt', { status: 503, json: { error: 'MESSAGE_STORE_BUSY' } })
  const r = w.receiver()
  await r.tick()
  expect(w.submitted.length).toBe(0)
  w.get().answers.set('receipt', null)
  await r.tick()
  expect(w.submitted.length).toBe(0)
  w.get().answers.delete('receipt')
  await r.tick()
  expect(w.submitted.length).toBe(1)
  expect(receipts(w.sent).map(one => one.status)).toEqual(['accepted', 'accepted', 'accepted'])
})

test('a contested receiver registers again with its own credentials, at most every 16 s', async () => {
  const w = world()
  const r = w.receiver()
  await r.tick()
  const first = w.get().kept
  w.get().answers.set('poll', { status: 200, json: { messages: [], leaseMs: 15000, contested: true } })
  await r.tick()
  expect(of(w.sent, 'register').length).toBe(2)
  expect(of(w.sent, 'register').at(-1)?.body.connection).toBe(first?.connection)
  w.get().at += 10_000
  await r.tick()
  expect(of(w.sent, 'register').length).toBe(2)
  w.get().at += 6_000
  await r.tick()
  expect(of(w.sent, 'register').length).toBe(3)
})

test('an ACK in the first step counts when the turn ends on another step', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  const r = w.receiver()
  await r.tick()
  await settle()
  await r.turnStarted(MESSAGE.prompt, 't1')
  await r.stepAnswered('someone else', `ACK ${NONCE}`)
  await r.stepAnswered('t1', `ACK ${NONCE}`)
  await r.stepAnswered('t1', `ACK ${NONCE} a later one does not replace it`)
  expect(await r.turnEnded('t1', 'All the tests pass.', false)).toBe(true)
  expect(receipts(w.sent).at(-1)).toMatchObject({ status: 'acknowledged', reply: `ACK ${NONCE}` })
})

test('an ACK in a step does not outweigh an interrupted turn', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  const r = w.receiver()
  await r.tick()
  await settle()
  await r.turnStarted(MESSAGE.prompt, 't1')
  await r.stepAnswered('t1', `ACK ${NONCE}`)
  await r.turnEnded('t1', '', true)
  expect(receipts(w.sent).at(-1)).toMatchObject({ status: 'uncertain', error: 'TURN_ABORTED' })
})

test('a session ended during the accepted receipt keeps the message out of the next one', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  const r = w.receiver()
  w.get().onReceipt = () => r.end()
  await r.tick()
  await settle()
  expect(w.submitted.length).toBe(0)
})

test('a turn that starts after its delivery was called uncertain still stays out of the board, and its ACK counts', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  const r = w.receiver()
  await r.tick()
  await settle()
  w.get().at += 30_000
  await r.tick()
  expect(receipts(w.sent).at(-1)?.error).toBe('DELIVERY_UNCERTAIN')
  expect(await r.turnStarted(MESSAGE.prompt, 't9')).toBe(true)
  expect(await r.turnEnded('t9', `ACK ${NONCE}`, false)).toBe(true)
  expect(receipts(w.sent).at(-1)?.status).toBe('acknowledged')
  expect(await r.turnStarted(MESSAGE.prompt, 't10')).toBe(false)
})

test('a reload presents its own connection, so it does not contest itself', async () => {
  const w = world()
  await w.receiver().tick()
  const first = w.get().kept
  expect(first?.connection).not.toBe('')
  // The module's own variables start over; what it kept does not.
  await w.receiver().tick()
  expect(of(w.sent, 'register').length).toBe(2)
  expect(of(w.sent, 'register').at(-1)?.body.connection).toBe(first?.connection)
  expect(of(w.sent, 'register').at(-1)?.body.secret).toBe(first?.secret)
})

test('a page that went away is registered with again, with nothing resent', async () => {
  const w = world()
  w.get().queue.push(MESSAGE)
  const r = w.receiver()
  await r.tick()
  await settle()
  await r.turnStarted(MESSAGE.prompt, 't1')
  await r.turnEnded('t1', `ACK ${NONCE}`, false)
  w.get().answers.set('poll', { status: 400, json: { error: 'CONNECTOR_NOT_CONNECTED' } })
  await r.tick()
  w.get().answers.delete('poll')
  w.get().at += 11_000
  const before = of(w.sent, 'register').length
  await r.tick()
  expect(of(w.sent, 'register').length).toBe(before + 1)
  expect(w.submitted.length).toBe(1)
})

test('no page, no connection: nothing is registered and a page that appears is found', async () => {
  const w = world()
  w.get().hasAddress = false
  const r = w.receiver()
  await r.tick()
  expect(w.sent.length).toBe(0)
  w.get().hasAddress = true
  w.get().at += 11_000
  await r.tick()
  expect(of(w.sent, 'register').length).toBe(1)
})

test('a new session id ends the old address and registers the new one', async () => {
  const w = world()
  const r = w.receiver()
  await r.tick()
  w.get().session = '99999999-2222-3333-4444-555555555555'
  await r.tick()
  expect(of(w.sent, 'disconnect').length).toBe(1)
  w.get().at += 11_000
  await r.tick()
  expect(of(w.sent, 'register').at(-1)?.body.session).toBe('99999999-2222-3333-4444-555555555555')
  expect(of(w.sent, 'register').at(-1)?.body.connection).toBeUndefined()
})

test('the session ending disconnects', async () => {
  const w = world()
  const r = w.receiver()
  await r.tick()
  await r.end()
  expect(of(w.sent, 'disconnect').length).toBe(1)
  expect(w.get().kept?.connection).toBe('')
  // After a /clear the same receiver goes on under the new id, at once.
  w.get().session = '99999999-2222-3333-4444-555555555555'
  await r.tick()
  expect(of(w.sent, 'register').at(-1)?.body.session).toBe('99999999-2222-3333-4444-555555555555')
  expect(of(w.sent, 'register').at(-1)?.body.connection).toBeUndefined()
})

test('the address file is named as the page names it, and read only for its own board', () => {
  expect(addressKey('C:/Users/me/.claude/./progress.md')).toBe('C:\\Users\\me\\.claude\\progress.md')
  expect(addressKey('C:\\Users\\me\\x\\..\\.claude\\progress.md')).toBe('C:\\Users\\me\\.claude\\progress.md')
  expect(addressKey('/home/me//.claude/progress.md')).toBe('/home/me/.claude/progress.md')
  expect(addressKey('relative/progress.md')).toBe(null)
  expect(addressFileName('/home/me/.claude/progress.md')).toBe(`agent-board-${sha256('/home/me/.claude/progress.md').slice(0, 16)}.json`)
  const key = '/home/me/.claude/progress.md'
  const url = 'http://127.0.0.1:4100/?t=abc-1'
  expect(parseAddress(JSON.stringify({ url, path: key }), key)).toEqual({ origin: 'http://127.0.0.1:4100', token: 'abc-1' })
  expect(parseAddress(JSON.stringify({ url, path: '/other/progress.md' }), key)).toBe(null)
  expect(parseAddress(JSON.stringify({ url: 'http://evil.example:4100/?t=abc', path: key }), key)).toBe(null)
  expect(parseAddress('not json', key)).toBe(null)
})

test('the address folder is one this account can show is its own, or none', () => {
  expect(addressFolder(true, 'C:\\Users\\me', undefined, false)).toBe('C:\\Users\\me\\.cache\\agent-board')
  expect(addressFolder(true, 'C:\\Users\\me', 'D:\\run', true)).toBe(null)
  expect(addressFolder(false, '/home/me', '/run/user/1000', true)).toBe('/run/user/1000')
  expect(addressFolder(false, '/home/me', '/tmp/shared', false)).toBe('/home/me/.cache/agent-board')
  expect(addressFolder(false, '', undefined, false)).toBe(null)
  expect(emptyReceiver().connection).toBe('')
})

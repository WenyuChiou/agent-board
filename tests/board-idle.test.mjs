// The page server's idle exit (#1958): a board whose event loop was held a moment does not stop as idle while it
// is polled. The server's own stall tests (a preload that blocks the board while a test polls it) are in
// messaging.test.mjs, beside the start helper they use; these are the decision's case table, with synthetic clocks.
// A re-check is a chain of hops, one per loop turn (scripts/board-idle.ts); `chain` runs one hop after another.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { IDLE_HOPS, IDLE_HOP_STALL_MS, idleStep } = await import('../scripts/board-idle.ts')

const idleMs = 1_800
// The interval's reading at `now`, with the last request seen at `seen`.
const reading = (now, seen, isBusy = false) => idleStep(null, now, seen, isBusy, idleMs)
// Runs the hops after `step`, each `gaps[i]` ms after the one before, while it hops; `seenAt(i)` is the last-seen
// time hop i finds and `busyAt(i)` whether a delivery is under way then. Returns every step, the first included.
const chain = (step, start, gaps, seenAt, busyAt = () => false) => {
  const steps = [step]
  let now = start
  for (let i = 0; i < gaps.length && steps.at(-1).kind === 'hop'; i++) {
    now += gaps[i]
    steps.push(idleStep(steps.at(-1).watch, now, seenAt(i), busyAt(i), idleMs))
  }
  return steps
}
const kinds = steps => steps.map(one => one.kind)

test('idle case: a board polled within its limit stays, and no limit never stops (#1958)', () => {
  assert.deepEqual(reading(10_000, 9_000), { kind: 'stay' })
  assert.deepEqual(idleStep(null, 10_000, 0, false, 0), { kind: 'stay' })
  assert.deepEqual(idleStep({ seen: 0, at: 9_999, hops: IDLE_HOPS - 1 }, 10_000, 0, false, 0), { kind: 'stay' })
})

test('idle case: a stale reading never stops at once, it sets up a re-check (#1958)', () => {
  // The reading that ran in the timers phase right after a 2 s stall: the polls the stall held are not served yet.
  assert.deepEqual(reading(3_500, 1_500), { kind: 'hop', watch: { seen: 1_500, at: 3_500, hops: 0 } })
})

test('idle case: polls queued behind a stall are served before the re-check, and the board stays (#1958)', () => {
  // A poll on its own connection: accepted in the poll phase before the first hop, read in the one before the second.
  const steps = chain(reading(3_500, 1_500), 3_500, [1, 1, 1], i => (i === 0 ? 1_500 : 3_502))
  assert.deepEqual(kinds(steps), ['hop', 'hop', 'stay'])
})

test('idle case: a second stall after the re-check is set up starts the re-check again, and the board stays (#1958)', () => {
  // A check-phase callback after the first hop held the loop 80 ms, under any timer's lateness margin: requests that
  // came in it may wait unread, so the chain stops there and nothing is stopped.
  const short = chain(reading(3_500, 1_500), 3_500, [1, 80, 1], () => 1_500)
  assert.deepEqual(kinds(short), ['hop', 'hop', 'retry'])
  // Just over the margin is a stall too; just under it is not.
  assert.equal(chain(reading(3_500, 1_500), 3_500, [IDLE_HOP_STALL_MS + 1], () => 1_500).at(-1).kind, 'retry')
  assert.equal(chain(reading(3_500, 1_500), 3_500, [IDLE_HOP_STALL_MS], () => 1_500).at(-1).kind, 'hop')
  // A 1 s stall, the last hop included.
  assert.deepEqual(kinds(chain(reading(3_500, 1_500), 3_500, [1, 1, 1_000], () => 1_500)), ['hop', 'hop', 'hop', 'retry'])
  // The retry's new reading, after the stall's requests were served, finds the board in use.
  assert.deepEqual(reading(3_640, 3_600), { kind: 'stay' })
})

test('idle case: a board that is really idle stops once a re-check on time still finds nothing (#1958)', () => {
  const steps = chain(reading(3_500, 1_500), 3_500, Array(IDLE_HOPS).fill(1), () => 1_500)
  assert.deepEqual(kinds(steps), [...Array(IDLE_HOPS).fill('hop'), 'stop'])
  // After a stall broke a chain, the next unbroken one stops a board nobody asks.
  const again = chain(reading(4_600, 1_500), 4_600, Array(IDLE_HOPS).fill(IDLE_HOP_STALL_MS), () => 1_500)
  assert.equal(again.at(-1).kind, 'stop')
})

test('idle case: a delivery under way during the re-check keeps the board, and the re-check ends (#1958)', () => {
  // A send queued in the stall started a delivery: /api/messages/ calls do not count as activity, but the delivery does.
  const steps = chain(reading(3_500, 1_500), 3_500, [1, 1, 1], () => 1_500, i => i === 1)
  assert.deepEqual(kinds(steps), ['hop', 'hop', 'stay'])
  // A delivery under way at the reading itself starts no chain.
  assert.deepEqual(reading(3_500, 1_500, true), { kind: 'stay' })
})

test('idle case: a request between the reading and the re-check, even one still stale, starts the judgement again (#1958)', () => {
  // touchWaiting moved the last request forward, but not past the limit: a new chain starts from this reading.
  const first = reading(3_500, 1_500)
  const hop = idleStep({ ...first.watch, hops: IDLE_HOPS - 1 }, 3_501, 1_600, false, idleMs)
  assert.deepEqual(hop, { kind: 'hop', watch: { seen: 1_600, at: 3_501, hops: 0 } })
})

// The page server's idle exit (#1958): a board whose event loop was held a moment does not stop as idle while it
// is polled. The server's own stall tests (a preload that blocks the board while a test polls it) are in
// messaging.test.mjs, beside the start helper they use; these are the decision's case table, with synthetic clocks.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { IDLE_RECHECK_MS, IDLE_STALL_MS, idleStep } = await import('../scripts/board-idle.ts')

const idleMs = 1_800
// The interval's reading at `now`, with the last request seen at `seen`.
const reading = (now, seen, isBusy = false) => idleStep(null, now, seen, isBusy, idleMs)

test('idle case: a board polled within its limit stays, and no limit never stops (#1958)', () => {
  assert.deepEqual(reading(10_000, 9_000), { kind: 'stay' })
  assert.deepEqual(idleStep(null, 10_000, 0, false, 0), { kind: 'stay' })
  assert.deepEqual(idleStep({ at: 9_950, seen: 0 }, 10_000, 0, false, 0), { kind: 'stay' })
})

test('idle case: a stale reading never stops at once, it sets up a re-check (#1958)', () => {
  // The reading that ran in the timers phase right after a 2 s stall: the polls the stall held are not served yet.
  const step = reading(3_500, 1_500)
  assert.deepEqual(step, { kind: 'recheck', watch: { at: 3_500, seen: 1_500 } })
})

test('idle case: polls queued behind a stall are served before the re-check, and the board stays (#1958)', () => {
  const step = reading(3_500, 1_500)
  assert.equal(step.kind, 'recheck')
  // The poll phase after the reading served the queued /api/ping calls: the last request is now.
  assert.deepEqual(idleStep(step.watch, 3_500 + IDLE_RECHECK_MS, 3_510, false, idleMs), { kind: 'stay' })
})

test('idle case: a second stall after the re-check is set up starts the re-check again, and the board stays (#1958)', () => {
  const first = reading(3_500, 1_500)
  assert.equal(first.kind, 'recheck')
  // A timer after the reading in the same timers phase, or a setImmediate callback after the poll phase, held the
  // loop 1 s: the re-check fires late, and requests that arrived in that stall may still wait unread.
  const late = 3_500 + IDLE_RECHECK_MS + 1_000
  const second = idleStep(first.watch, late, 1_500, false, idleMs)
  assert.deepEqual(second, { kind: 'recheck', watch: { at: late, seen: 1_500 } })
  // A re-check late by just over the stall margin is a stall too.
  const edge = 3_500 + IDLE_RECHECK_MS + IDLE_STALL_MS + 1
  assert.equal(idleStep(first.watch, edge, 1_500, false, idleMs).kind, 'recheck')
  // The next re-check, on time, finds the requests served after that stall.
  assert.deepEqual(idleStep(second.watch, late + IDLE_RECHECK_MS, late + 5, false, idleMs), { kind: 'stay' })
})

test('idle case: a board that is really idle stops once a re-check on time still finds nothing (#1958)', () => {
  const first = reading(3_500, 1_500)
  assert.equal(first.kind, 'recheck')
  assert.deepEqual(idleStep(first.watch, 3_500 + IDLE_RECHECK_MS, 1_500, false, idleMs), { kind: 'stop' })
  assert.deepEqual(idleStep(first.watch, 3_500 + IDLE_RECHECK_MS + IDLE_STALL_MS, 1_500, false, idleMs), { kind: 'stop' })
  // After a late re-check, the one after it on time stops a board nobody asks.
  const late = 3_500 + IDLE_RECHECK_MS + 1_000
  const second = idleStep(first.watch, late, 1_500, false, idleMs)
  assert.equal(second.kind, 'recheck')
  assert.deepEqual(idleStep(second.watch, late + IDLE_RECHECK_MS, 1_500, false, idleMs), { kind: 'stop' })
})

test('idle case: a delivery under way during the re-check keeps the board, and the re-check ends (#1958)', () => {
  const first = reading(3_500, 1_500)
  assert.equal(first.kind, 'recheck')
  // A send queued in the stall started a delivery: /api/messages/ calls do not count as activity, but the delivery does.
  assert.deepEqual(idleStep(first.watch, 3_500 + IDLE_RECHECK_MS, 1_500, true, idleMs), { kind: 'stay' })
  // A delivery under way at the reading itself sets up no re-check.
  assert.deepEqual(reading(3_500, 1_500, true), { kind: 'stay' })
})

test('idle case: a request between the reading and the re-check, even one still stale, starts the judgement again (#1958)', () => {
  const first = reading(3_500, 1_500)
  // touchWaiting moved the last request forward, but not past the limit: the judgement starts from this reading.
  assert.deepEqual(idleStep(first.watch, 3_500 + IDLE_RECHECK_MS, 1_600, false, idleMs), { kind: 'recheck', watch: { at: 3_500 + IDLE_RECHECK_MS, seen: 1_600 } })
})

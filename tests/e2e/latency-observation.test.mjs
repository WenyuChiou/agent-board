import assert from 'node:assert/strict'
import { test } from 'node:test'
import { performance } from 'node:perf_hooks'
import { makeWorld } from './lib/world.mjs'
import { terminal } from './lib/surfaces.mjs'
import { PANE_MS } from './lib/budget.mjs'

const observedFrame = async (t, { frameAt, observedAt, text = 'Synthetic ask', previous = false }) => {
  const world = makeWorld()
  let restoreClock, restoreTimer
  try {
    const trigger = world.write('frame-trigger', '')
    world.write('agent-board.mjs', `import { readFileSync, watchFile } from 'node:fs'
process.stdout.write('\\x1b[HProgress Synthetic ready\\n')
watchFile(${JSON.stringify(trigger)}, { interval: 5 }, () => {
  process.stdout.write('\\x1b[HProgress ' + readFileSync(${JSON.stringify(trigger)}, 'utf8') + '\\n')
})
process.stdin.resume()
`)
    let frameSeen
    const watch = terminal.watch(world, { onFrame: frame => frameSeen?.(frame) })
    await watch.next(value => value.includes('Synthetic ready'), 10000)
    let clock = 0
    const realTimer = globalThis.setTimeout
    const pending = []
    restoreClock = t.mock.method(performance, 'now', () => clock)
    restoreTimer = t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
      if (ms === 40) { pending.push(callback); return 1 }
      return realTimer(callback, ms, ...args)
    })
    const result = watch.next(value => value.includes(previous ? 'Synthetic ready' : text), PANE_MS)
    // Attach rejection handling before the deliberately held observation resumes.
    const settled = result.then(value => ({ value }), error => ({ error }))
    await new Promise(done => setImmediate(done))
    assert.equal(pending.length, 1, 'The normal observation poll is waiting, not a test-only retry')
    if (frameAt !== undefined) {
      const recorded = new Promise(done => { frameSeen = done })
      clock = frameAt
      world.write('frame-trigger', text)
      const frame = await recorded
      assert.equal(frame.at, frameAt, 'The real stdout listener recorded the frame before observation resumes')
    }
    clock = observedAt
    pending.shift()()
    return await settled
  } finally {
    restoreTimer?.mock.restore()
    restoreClock?.mock.restore()
    await world.close()
  }
}

test('terminal latency uses a frame recorded before the unchanged deadline even when its observation poll resumes late', async t => {
  const result = await observedFrame(t, { frameAt: PANE_MS - 10, observedAt: PANE_MS + 1 })
  assert.ifError(result.error)
  assert.equal(result.value.elapsed, PANE_MS - 10)
  assert.match(result.value.text, /Synthetic ask/)
})

test('terminal latency rejects a matching frame first recorded after the unchanged deadline', async t => {
  const result = await observedFrame(t, { frameAt: PANE_MS + 1, observedAt: PANE_MS + 1 })
  assert.match(result.error?.message ?? '', /Not seen within 3000 ms/)
})

test('terminal latency rejects a missing frame when its observation poll resumes late', async t => {
  const result = await observedFrame(t, { observedAt: PANE_MS + 1 })
  assert.match(result.error?.message ?? '', /Not seen within 3000 ms/)
})

test('terminal latency never counts a frame from before this wait as the new update', async t => {
  const result = await observedFrame(t, { observedAt: PANE_MS + 1, previous: true })
  assert.match(result.error?.message ?? '', /Not seen within 3000 ms/)
})

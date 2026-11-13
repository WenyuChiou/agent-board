import assert from 'node:assert/strict'
import { test } from 'node:test'
import { performance } from 'node:perf_hooks'
import { makeWorld } from './lib/world.mjs'
import { terminal } from './lib/surfaces.mjs'
import { PANE_MS } from './lib/budget.mjs'

const observedFrame = async (t, { frameAt, observedAt, text = 'Synthetic ask', previous = false, frameTimeoutMs = 5000, suppressTriggerFrame = false }) => {
  const world = makeWorld()
  let restoreClock, restoreTimer
  try {
    const trigger = world.write('frame-trigger', '')
    world.write('agent-board.mjs', `import { readFileSync } from 'node:fs'
const path = ${JSON.stringify(trigger)}
// Check trigger readiness and start polling before advertising Synthetic ready so a write never lands ahead of the watcher.
const initial = readFileSync(path, 'utf8')
const timer = setInterval(() => {
  const next = readFileSync(path, 'utf8')
  if (next.length > 0) {
    clearInterval(timer)
    process.stdout.write('\\x1b[HProgress ' + next + '\\n')
  }
}, 5)
process.stdout.write('\\x1b[HProgress Synthetic ready' + (initial ? ' ' + initial : '') + '\\n')
process.stdin.resume()
`)
    let frameSeen
    let onWatchClose
    const watch = terminal.watch(world, {
      onFrame: frame => frameSeen?.(frame),
      onClose: info => onWatchClose?.(info),
    })
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
      const recorded = new Promise((resolve, reject) => {
        const bound = realTimer(() => reject(new Error(`Timed out waiting for triggered stdout frame after ${frameTimeoutMs} ms`)), frameTimeoutMs)
        const finish = fn => value => {
          clearTimeout(bound)
          frameSeen = undefined
          onWatchClose = undefined
          fn(value)
        }
        frameSeen = finish(resolve)
        onWatchClose = finish(info => reject(new Error(`Watch closed before triggered stdout frame: exit=${info?.exitCode ?? 'null'} signal=${info?.signalCode ?? 'null'} ${info?.errors ?? ''}`)))
      })
      clock = frameAt
      if (!suppressTriggerFrame) world.write('frame-trigger', text)
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

test('terminal latency fails within its bound instead of draining the event loop when a triggered frame never arrives', async t => {
  await assert.rejects(
    () => observedFrame(t, { frameAt: 50, observedAt: 60, frameTimeoutMs: 120, suppressTriggerFrame: true }),
    /Timed out waiting for triggered stdout frame/,
  )
})

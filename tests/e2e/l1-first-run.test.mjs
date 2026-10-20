import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { makeWorld } from './lib/world.mjs'
import { block } from './lib/writers.mjs'
import { inspectSurfaces, terminal, seenPageWithin, serve } from './lib/surfaces.mjs'
import { seenWithin } from './lib/expect.mjs'
import { PANE_MS, PAGE_MS } from './lib/budget.mjs'

describe('L1 first run', () => {
  test('first run: with no progress file every surface says in words that nothing is here yet', async () => {
    const world = makeWorld()
    try {
      assert.equal(world.exists('progress.md'), false)
      const screens = await inspectSurfaces(world)
      for (const [name, text] of Object.entries(screens)) assert.match(text, /Nothing needs you|No work in progress/, name)
    } finally { await world.close() }
  })

  test('first run: no surface shows a stack trace, a file path or a session id on an empty board', async () => {
    const world = makeWorld()
    try {
      // inspectSurfaces enforces the id/path assertion separately on all four
      // default surfaces, keeping the known HTML footer failure visible.
      for (const [name, text] of Object.entries(await inspectSurfaces(world))) assert.doesNotMatch(text, /Error:|at .*\.m?js:\d|session=[a-f0-9]{8}/, name)
    } finally { await world.close() }
  })

  test('first run: the first block from each host appears on the terminal board within budget', async () => {
    const world = makeWorld()
    const watch = terminal.watch(world)
    try {
      await watch.next(text => text.includes('No work in progress'), 10000)
      for (const [index, host] of ['codex', 'antigravity', 'hermes', 'grok'].entries()) {
        const title = `First ${host} task`
        const start = performance.now()
        block(world, { agent: host, session: `a100000${index}`, title })
        const frame = await watch.next(text => text.includes(title), PANE_MS)
        assert.ok(performance.now() - start <= PANE_MS, `${host}: ${frame.elapsed} ms`)
        assert.match(frame.text, new RegExp(host))
      }
      const screens = await inspectSurfaces(world)
      for (const host of ['codex', 'antigravity', 'hermes', 'grok']) assert.match(screens.terminal, new RegExp(`First ${host} task`))
    } finally {
      await world.close()
    }
  })

  test('first run: the first block appears on the serve page within budget', async () => {
    const world = makeWorld()
    let server
    try {
      server = await serve.start(world)
      assert.match(await server.page(), /No work in progress/)
      block(world, { title: 'First gateway route' })
      const elapsed = await seenPageWithin(server, text => text.includes('First gateway route'), PAGE_MS)
      assert.ok(elapsed <= PAGE_MS)
      await inspectSurfaces(world, server)
    } finally {
      await world.close()
    }
  })
})

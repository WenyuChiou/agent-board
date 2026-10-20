import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld } from './lib/world.mjs'
import { block } from './lib/writers.mjs'
import { inspectSurfaces, terminal, seenPageWithin, serve } from './lib/surfaces.mjs'
import { seenWithin, noSilentPress } from './lib/expect.mjs'
import { PANE_MS, PAGE_MS } from './lib/budget.mjs'

const seedAsk = (world, agent, extra = {}) => block(world, { agent, state: 'waiting', title: `Publish ${agent} report`, steps: ['- [?] Publish the synthetic report, OK?'], ...extra })

describe('L3 across agents and sessions', () => {
  test('across agents: an Antigravity ask answered from the terminal board leaves the page and --chat', async () => {
    const world = makeWorld()
    let server
    try {
      seedAsk(world, 'antigravity')
      server = await serve.start(world)
      assert.match(await server.page(), /Publish the synthetic report/)
      const before = (await terminal.keys(world, ''))
      const after = (await terminal.keys(world, 'h'))
      noSilentPress({ surface: 'terminal', card: 'Publish antigravity report', button: 'h', before, after })
      await seenPageWithin(server, text => text.includes('Nothing needs you'), PAGE_MS)
      const screens = await inspectSurfaces(world, server)
      assert.match(screens.chat, /\b0 waiting\b/)
      assert.match(screens.terminal, /\b0 waiting\b/)
      assert.match(screens.page, /Nothing needs you/)
    } finally {
      await world.close()
    }
  })

  test('across agents: a Hermes ask answered from the serve page leaves the terminal board', async () => {
    const world = makeWorld()
    let server, watch
    try {
      seedAsk(world, 'hermes')
      server = await serve.start(world)
      watch = terminal.watch(world)
      await watch.next(text => text.includes('Publish the synthetic report'), 10000)
      noSilentPress(await server.press('Publish the synthetic report', 'Already answered, hide'))
      const frame = await watch.next(text => text.match(/\b0 waiting\b/), PANE_MS)
      assert.ok(frame.elapsed <= PANE_MS)
      const screens = await inspectSurfaces(world, server)
      assert.match(screens.terminal, /\b0 waiting\b/)
    } finally {
      await world.close()
    }
  })

  for (const state of ['stopped', 'ended']) test(`across sessions: an ask of ${state === 'ended' ? 'an' : 'a'} ${state} session leaves the waiting count and stays with its task on the stopped shelf`, async () => {
    const world = makeWorld()
    let server
    try {
      seedAsk(world, 'grok', { state: state === 'stopped' ? 'waiting' : 'ended', updated: new Date(world.now - (state === 'stopped' ? 13 : 1) * 3600000).toISOString() })
      server = await serve.start(world)
      const screens = await inspectSurfaces(world, server)
      const model = (await server.get('/api/board')).json().model
      assert.equal(model.counts.waiting, 0, `${state}: Waiting on you still has ${model.counts.waiting}; terminal says:\n${screens.terminal}`)
      const row = model.stopped.find(one => one.title === 'Publish grok report')
      assert.ok(row, 'The task must be on Stopped')
      assert.match(JSON.stringify(row), /Publish the synthetic report/)
      assert.match(world.read('progress.md'), /Publish the synthetic report/)
    } finally {
      await world.close()
    }
  })

  test("across sessions: an archived session's questions are resolved or carried, never lost", async () => {
    const world = makeWorld()
    try {
      seedAsk(world, 'codex', { state: 'ended', updated: new Date(world.now - 4 * 86400000).toISOString() })
      const before = await terminal.keys(world, 'i down')
      const after = (await terminal.keys(world, 'i down a'))
      const files = world.files().filter(name => /progress-(archive-.*\.md|questions.*\.json)$/.test(name))
      const retained = [world.read('progress.md'), ...files.map(name => world.read(name))].join('\n')
      assert.match(retained, /Publish the synthetic report, OK\?/)
      // A refused archive is safe, but does not satisfy this journey's explicit
      // archive action. Keep that target in addition to the no-loss check.
      noSilentPress({ surface: 'terminal', card: 'Publish codex report', button: 'a', before, after })
      assert.ok(!world.read('progress.md').includes('Publish codex report'), `The source was retained instead of archived.\n${after}`)
      await inspectSurfaces(world)
    } finally { await world.close() }
  })

  test('across sessions: a resumed session takes its row back without a second row', async () => {
    const world = makeWorld()
    let server
    try {
      block(world, { agent: 'codex', state: 'ended', title: 'Resume gateway publishing', steps: ['- [ ] Publish routes'] })
      block(world, { agent: 'hermes', session: 'b2000002', project: 'research-hub', title: 'Summarize citations' })
      server = await serve.start(world)
      const before = (await server.get('/api/board')).json().model
      assert.equal(before.stopped.filter(one => one.title === 'Resume gateway publishing').length, 1)
      block(world, { agent: 'codex', state: 'working', title: 'Resume gateway publishing', steps: ['- [~] Publish routes'] })
      await seenPageWithin(server, text => text.includes('codex is working'), PAGE_MS)
      const after = (await server.get('/api/board')).json().model
      const rows = [...after.groups.flatMap(group => group.rows), ...after.stopped]
      assert.equal(rows.filter(one => one.title === 'Resume gateway publishing').length, 1)
      assert.equal(after.stopped.filter(one => one.title === 'Resume gateway publishing').length, 0)
      assert.equal((world.read('progress.md').match(/session=a1000001 agent=/g) ?? []).length, 1)
      await inspectSurfaces(world, server)
    } finally {
      await world.close()
    }
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld } from './lib/world.mjs'
import { block, hook } from './lib/writers.mjs'
import { inspectSurfaces, terminal, seenPageWithin, serve, run } from './lib/surfaces.mjs'
import { seenWithin, noSilentPress, noMachineIds } from './lib/expect.mjs'
import { knownFailure } from './lib/known.mjs'
import { PANE_MS, PAGE_MS } from './lib/budget.mjs'

const seedAsk = (world, agent, extra = {}) => block(world, { agent, state: 'waiting', title: `Publish ${agent} report`, steps: ['- [?] Publish the synthetic report, OK?'], ...extra })

describe('L3 across agents and sessions', () => {
  test('L3 Codex: a new prompt leaves the open ask as [?] until it is answered', async () => {
    const world = makeWorld()
    try {
      const session = 'synthetic-open-ask-owner'
      assert.equal((await hook(world, 'codex', 'UserPromptSubmit', { session_id: session, prompt: 'Review routes' })).status, 0)
      const report = await run(world, ['--codex-report'], { input: JSON.stringify({ project: 'api-gateway', title: 'Review routes', state: 'waiting', steps: ['- [?] Publish the gateway, OK?', '- [ ] Check monitoring'] }) })
      assert.equal(report.status, 0, report.stderr)
      assert.match(world.read('progress.md'), /\[\?\] Publish the gateway, OK\?/)
      const result = await hook(world, 'codex', 'UserPromptSubmit', { session_id: session, turn_id: 'unrelated-turn', prompt: 'Also review the route metrics' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal((world.read('progress.md').match(/<!-- auto /g) ?? []).length, 1)
      assert.match(world.read('progress.md'), /Check monitoring/)
      assert.match(world.read('progress.md'), /- \[\?\] Publish the gateway, OK\?/)
      const server = await serve.start(world)
      for (const text of [await terminal.screen(world), await server.page()]) {
        noMachineIds(text, world)
        assert.match(text, /1\s+waiting/i)
      }
    } finally { await world.close() }
  })

  test('L3 archive then resume returns the task under its own project', async () => {
    const world = makeWorld()
    try {
      const session = 'synthetic-archive-owner'
      world.env.CODEX_THREAD_ID = session
      const payload = { project: 'api-gateway', title: 'Resume archived routes', state: 'ended', steps: ['- [ ] Check routes'] }
      assert.equal((await run(world, ['--codex-report'], { input: JSON.stringify(payload) })).status, 0)
      const before = await terminal.keys(world, 'i')
      const after = await terminal.keys(world, 'i a')
      noSilentPress({ surface: 'terminal', card: payload.title, button: 'a', before, after })
      assert.ok(!world.read('progress.md').includes(payload.title))
      const archives = world.files().filter(name => /progress-archive-.*\.md$/.test(name))
      assert.equal(archives.length, 1)
      assert.ok(world.read(archives[0]).includes(payload.title))
      assert.equal((await hook(world, 'codex', 'UserPromptSubmit', { session_id: session, cwd: world.root, prompt: 'Continue reviewing the archived routes' })).status, 0)
      const server = await serve.start(world)
      const rows = (await server.get('/api/board')).json().model.groups.flatMap(group => group.rows)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].project, 'api-gateway')
      noMachineIds(await terminal.screen(world), world)
      noMachineIds(await server.page(), world)
    } finally { await world.close() }
  })

  test('L3 serve: starting --serve twice reuses the open tab', async () => {
    const world = makeWorld()
    try {
      block(world)
      // Observe both browser requests at the world's existing launch seam; never open a real tab.
      const before = world.read('agent-board.mjs')
      const seam = '((target, done) => done(false))('
      assert.equal(before.split(seam).length - 1, 2)
      world.write('agent-board.mjs', before.split(seam).join('((target, done) => { process.stdout.write("E2E_BROWSER_REQUEST\\n"); done(true) })('))
      const server = await serve.start(world)
      const outputs = []
      for (let index = 0; index < 2; index++) outputs.push(await terminal.screen(world, ['--serve', '--idle-minutes', '1']))
      for (const output of outputs) assert.ok(output.includes(server.url), 'The same isolated server address must be reused')
      assert.equal((await server.get('/api/board')).status, 200)
      assert.equal((outputs[0].match(/E2E_BROWSER_REQUEST/g) ?? []).length, 1)
      await knownFailure('hold:serve-tab-reuse', () => assert.equal((outputs[1].match(/E2E_BROWSER_REQUEST/g) ?? []).length, 0, outputs[1]))
      noMachineIds(await server.page(), world)
    } finally { await world.close() }
  })

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
      await seenPageWithin(server, text => text.includes('Codex is working'), PAGE_MS)
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

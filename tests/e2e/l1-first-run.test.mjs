import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { makeWorld } from './lib/world.mjs'
import { block, hook } from './lib/writers.mjs'
import { inspectSurfaces, terminal, seenPageWithin, serve, run } from './lib/surfaces.mjs'
import { noMachineIds } from './lib/expect.mjs'
import { knownFailure } from './lib/known.mjs'
import { PANE_MS, PAGE_MS } from './lib/budget.mjs'

describe('L1 first run', () => {
  test('L1 first run: an empty board says how to connect the first agent', async () => {
    const world = makeWorld()
    try {
      assert.equal(world.exists('progress.md'), false)
      const screens = await inspectSurfaces(world)
      for (const surface of ['terminal', 'chat', 'page', 'html']) {
        assert.match(screens[surface], /Nothing needs you|No work in progress/, surface)
        await knownFailure('hold:empty-board-connect', () => assert.match(screens[surface], /\b(?:connect|set up|install)\b.*(?:agent|setup-agent)|setup-agent.*--apply/i, surface))
      }
    } finally { await world.close() }
  })

  test('L1 first Codex session: the row title comes from the first prompt, not "Local codex task"', async () => {
    const world = makeWorld()
    try {
      const prompt = 'Prepare the synthetic gateway release'
      const result = await hook(world, 'codex', 'UserPromptSubmit', { prompt, cwd: world.root })
      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.match(world.read('progress.md'), /agent=codex .*state=working/)
      const server = await serve.start(world)
      const rows = (await server.get('/api/board')).json().model.groups.flatMap(group => group.rows)
      assert.equal(rows.length, 1)
      await knownFailure('hold:codex-first-prompt-title', () => assert.equal(rows[0].title, prompt))
      for (const [surface, text] of Object.entries({ terminal: await terminal.screen(world), page: await server.page() })) {
        noMachineIds(text, world)
        await knownFailure('hold:codex-first-prompt-title', () => {
          assert.ok(text.includes(prompt), `${surface}: ${text}`)
          assert.ok(!text.includes('Local codex task'), surface)
        })
      }
    } finally { await world.close() }
  })

  test("L1 Codex report: a later report's project moves the block to that project", async () => {
    const world = makeWorld()
    try {
      world.env.CODEX_THREAD_ID = 'synthetic-moving-project'
      for (const project of ['alpha-web', 'beta-web']) {
        const result = await run(world, ['--codex-report'], { input: JSON.stringify({ project, title: 'Move the gateway report', state: 'working', steps: ['- [~] Check routes'] }) })
        assert.equal(result.status, 0, result.stderr || result.stdout)
      }
      assert.equal((world.read('progress.md').match(/<!-- auto /g) ?? []).length, 1)
      const server = await serve.start(world)
      const model = (await server.get('/api/board')).json().model
      const rows = model.groups.flatMap(group => group.rows).filter(row => row.title === 'Move the gateway report')
      assert.equal(rows.length, 1)
      await knownFailure('hold:codex-project-move', () => assert.equal(rows[0].project, 'beta-web'))
      noMachineIds(await terminal.screen(world), world)
      noMachineIds(await server.page(), world)
    } finally { await world.close() }
  })

  test('L1 Codex sessions: three sessions in one project share one ## heading', async () => {
    const world = makeWorld()
    try {
      for (let index = 0; index < 3; index++) {
        world.env.CODEX_THREAD_ID = `synthetic-shared-project-${index}`
        const result = await run(world, ['--codex-report'], { input: JSON.stringify({ project: 'alpha-web', title: `Gateway report ${index + 1}`, state: 'working', steps: ['- [~] Check routes'] }) })
        assert.equal(result.status, 0, result.stderr || result.stdout)
      }
      const source = world.read('progress.md')
      assert.equal((source.match(/<!-- auto /g) ?? []).length, 3)
      await knownFailure('hold:codex-project-headings', () => {
        assert.equal((source.match(/^## alpha-web$/gm) ?? []).length, 1, source)
        assert.equal((source.match(/^## /gm) ?? []).length, 1, source)
      })
      const text = await terminal.screen(world)
      for (let index = 0; index < 3; index++) assert.ok(text.includes(`Gateway report ${index + 1}`))
      noMachineIds(text, world)
    } finally { await world.close() }
  })

  test('L1 latency: a new ask is visible within 3 s on the page and the terminal', async () => {
    const world = makeWorld()
    try {
      block(world)
      const server = await serve.start(world)
      const watch = terminal.watch(world)
      await watch.next(text => text.includes('Prepare the gateway'), 10000)
      await server.page()
      // Measure an update after a steady-state poll, excluding startup and first ledger writes.
      await watch.next(text => text.includes('Prepare the gateway'), 10000)
      block(world, { state: 'waiting', steps: ['- [?] Publish the gateway, OK?'] })
      const [frame, elapsed] = await Promise.all([
        watch.next(text => text.includes('Publish the gateway, OK?'), PANE_MS),
        seenPageWithin(server, text => text.includes('Publish the gateway, OK?'), PAGE_MS),
      ])
      assert.ok(frame.elapsed <= PANE_MS)
      assert.ok(elapsed <= PAGE_MS)
      await knownFailure('hold:page-ask-three-seconds', () => seenPageWithin(server, text => text.includes('Publish the gateway, OK?'), PANE_MS))
      noMachineIds(frame.text, world)
      noMachineIds(await server.page(), world)
    } finally { await world.close() }
  })

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

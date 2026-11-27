import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { makeWorld } from './lib/world.mjs'
import { block, hook, hookHosts } from './lib/writers.mjs'
import { inspectSurfaces, terminal, seenPageWithin, serve, run } from './lib/surfaces.mjs'
import { noMachineIds } from './lib/expect.mjs'
import { PANE_MS, PAGE_EVENT_MS, PAGE_EVENT_SAMPLES, PAGE_MS } from './lib/budget.mjs'

// The page's empty board: the agents that report here and what to do next, in place of the sections.
const EMPTY_PAGE = /Your board is ready[\s\S]*Start a new session in an agent you set up; its work shows here/

describe('L1 first run', () => {
  test('L1 first run: an empty board says how to connect the first agent', async () => {
    const world = makeWorld()
    try {
      assert.equal(world.exists('progress.md'), false)
      const screens = await inspectSurfaces(world)
      for (const surface of ['terminal', 'watch', 'chat', 'page', 'print']) {
        // The page has no Needs you section yet: its empty board is the "Your board is ready" card.
        assert.match(screens[surface], surface === 'page' ? EMPTY_PAGE : /Nothing needs you|No work in progress/, surface)
        // The watch frame wraps the command onto the next row: match the words, not the rows.
        assert.match(screens[surface].replace(/\s+/g, ' '), /\b(?:connect|set up|install)\b.*(?:agent|setup-agent)|setup-agent.*--apply/i, surface)
      }
    } finally { await world.close() }
  })

  test('L1 first Codex session: the hook reports its project without reading the prompt', async () => {
    const world = makeWorld()
    try {
      const prompt = 'Prepare the synthetic gateway release'
      const expectedTitle = basename(world.root)
      const result = await hook(world, 'codex', 'UserPromptSubmit', { prompt, cwd: world.root })
      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.match(world.read('progress.md'), /agent=codex .*state=working/)
      const server = await serve.start(world)
      const rows = (await server.get('/api/board')).json().model.groups.flatMap(group => group.rows)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].title, expectedTitle)
      for (const [surface, text] of Object.entries({ terminal: await terminal.screen(world), page: await server.page() })) {
        noMachineIds(text, world)
        assert.ok(text.includes(expectedTitle), `${surface}: ${text}`)
        assert.ok(!text.includes('Local codex task'), surface)
        assert.ok(!text.includes(prompt), surface)
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
      assert.equal(rows[0].project, 'beta-web')
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
      // #922: a report for a project already headed joins that section.
      assert.equal((source.match(/^## alpha-web$/gm) ?? []).length, 1, source)
      assert.equal((source.match(/^## /gm) ?? []).length, 1, source)
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
      // The board writes nothing while its screen is unchanged (#545), so this waits one poll
      // rather than for another frame.
      await new Promise(done => setTimeout(done, 2500))
      block(world, { state: 'waiting', steps: ['- [?] Publish the gateway, OK?'] })
      const [frame, elapsed] = await Promise.all([
        watch.next(text => text.includes('Publish the gateway, OK?'), PANE_MS),
        seenPageWithin(server, text => text.includes('Publish the gateway, OK?'), PANE_MS),
      ])
      assert.ok(frame.elapsed <= PANE_MS)
      assert.ok(elapsed <= PANE_MS)
      noMachineIds(frame.text, world)
      noMachineIds(await server.page(), world)
    } finally { await world.close() }
  })

  test('first run: with no progress file every surface says in words that nothing is here yet', async () => {
    const world = makeWorld()
    try {
      assert.equal(world.exists('progress.md'), false)
      const screens = await inspectSurfaces(world)
      for (const [name, text] of Object.entries(screens)) assert.match(text, name === 'page' ? EMPTY_PAGE : /Nothing needs you|No work in progress/, name)
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
        block(world, { agent: host, session: `a100000${index}`, title })
        // Timed from the finished write. On main b31fa26 the board drew this block 0.1 ms after the write
        // returned, but the test's own synchronous write had taken nearly the whole budget (#910).
        const frame = await watch.next(text => text.includes(title), PANE_MS)
        assert.ok(frame.elapsed <= PANE_MS, `${host}: ${Math.round(frame.elapsed)} ms`)
        assert.match(frame.text, new RegExp(host))
      }
      const screens = await inspectSurfaces(world)
      for (const host of ['codex', 'antigravity', 'hermes', 'grok']) assert.match(screens.terminal, new RegExp(`First ${host} task`))
    } finally {
      await world.close()
    }
  })

  // #359: the page keeps one board request open and the server answers it from its file watch. Each event is a
  // real generated hook of a host, run as that host runs it; the clock starts when the hook has exited (its event
  // is written by then) and stops when the page's open request brings the changed light. An answer that came
  // before the hook process finished exiting counts as 0 ms.
  test(`L1 latency: a hook event from each host is on the page within 2 s (95th percentile over ${PAGE_EVENT_SAMPLES} events)`, async t => {
    const world = makeWorld()
    // The page stand-in below stops on every way out, a failed assertion included, so a failure cannot leave it asking.
    let isObserving = true
    const observerEnd = new AbortController()
    try {
      const server = await serve.start(world)
      const address = new URL(server.url)
      const token = address.searchParams.get('t')
      const START = { codex: 'UserPromptSubmit', grok: 'UserPromptSubmit', antigravity: 'PreInvocation' }
      const payloadOf = (id, n) => ({ session_id: id, conversationId: id, sessionId: id, cwd: world.root, turn_id: `turn-${n}`, prompt: `Check the synthetic routes ${n}`, last_assistant_message: `Checked the synthetic routes ${n}.`, lastAssistantMessage: `Checked the synthetic routes ${n}.` })
      // A host's first hook installs its hooks: each runs a turn untimed first.
      for (const host of hookHosts) {
        for (const event of [START[host], 'Stop']) {
          const result = await hook(world, host, event, payloadOf(`latency-${host}`, 0))
          assert.equal(result.status, 0, `the ${host} ${event} warm-up hook exited ${result.status}: ${result.stderr || result.stdout}`)
        }
      }
      // The board's short id for a session, from its block marker (resume= is the session's own id).
      const shortIdOf = id => readFileSync(world.path, 'utf8').match(new RegExp(`^<!-- auto session=([a-f0-9]{8}) [^\n]*? resume=${id}(?= |-->)`, 'm'))?.[1]
      const isShown = (model, id, isWorking) => {
        const shortId = shortIdOf(id)
        const row = [...model.groups.flatMap(group => group.rows), ...model.stopped, ...model.idle].find(item => item.session === id || (shortId !== undefined && item.session === shortId))
        return row !== undefined && / is working$/.test(row.status) === isWorking
      }
      // The page: one open board request at a time, asked again as soon as it is answered.
      let etag
      let answers = 0
      const expected = new Set()
      const observing = (async () => {
        while (isObserving) {
          try {
            const response = await fetch(new URL('/api/board', address), { headers: { 'x-board-token': token, 'x-board-page': 'p-l1-latency', 'x-board-visible': '1', ...(etag === undefined ? {} : { 'if-none-match': etag, 'x-board-wait': '1' }) }, signal: AbortSignal.any([AbortSignal.timeout(30_000), observerEnd.signal]) })
            answers += 1
            if (response.status !== 200) { await response.arrayBuffer(); continue }
            etag = response.headers.get('etag') ?? undefined
            const { model } = await response.json()
            const at = performance.now()
            for (const one of [...expected]) if (isShown(model, one.id, one.isWorking)) one.done(at)
          } catch { if (isObserving) await new Promise(done => setTimeout(done, 100)) }
        }
      })()
      const shown = (id, isWorking) => new Promise(resolve => {
        const one = { id, isWorking, done: at => { clearTimeout(timer); expected.delete(one); resolve(at) } }
        const timer = setTimeout(() => one.done(Infinity), 10_000)
        expected.add(one)
      })
      const results = []
      const working = Object.fromEntries(hookHosts.map(host => [host, false]))
      // A turn's Stop carries its prompt's turn id; Codex refuses a Stop for another turn.
      const turnOf = {}
      for (let n = 1; n <= PAGE_EVENT_SAMPLES; n += 1) {
        const host = hookHosts[n % hookHosts.length]
        const id = `latency-${host}`
        const isWorking = !working[host]
        working[host] = isWorking
        if (isWorking) turnOf[host] = n
        const seen = shown(id, isWorking)
        const startedAt = performance.now()
        const result = await hook(world, host, isWorking ? START[host] : 'Stop', payloadOf(id, turnOf[host]))
        const exitedAt = performance.now()
        assert.equal(result.status, 0, `the ${host} hook exited ${result.status}: ${result.stderr || result.stdout}`)
        const seenAt = await seen
        // fromStart includes the host shell and Node starting the hook: an upper bound, reported, not budgeted.
        results.push({ host, isWorking, ms: Math.max(0, seenAt - exitedAt), fromStart: seenAt - startedAt })
      }
      isObserving = false
      const sorted = results.map(one => one.ms).sort((a, b) => a - b)
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]
      const fromStart = results.map(one => one.fromStart).sort((a, b) => a - b)
      t.diagnostic(`${results.length} hook events over ${hookHosts.join(', ')}: from hook exit p50 ${Math.round(sorted[Math.floor(sorted.length / 2)])} ms, p95 ${Math.round(p95)} ms, max ${Math.round(sorted.at(-1))} ms; from hook start p50 ${Math.round(fromStart[Math.floor(fromStart.length / 2)])} ms, p95 ${Math.round(fromStart[Math.ceil(0.95 * fromStart.length) - 1])} ms; ${answers} board answers`)
      assert.ok(results.every(one => Number.isFinite(one.ms)), `an event never reached the page: ${JSON.stringify(results.filter(one => !Number.isFinite(one.ms)))}`)
      assert.ok(p95 <= PAGE_EVENT_MS, `p95 ${Math.round(p95)} ms from a hook event to the page, the budget is ${PAGE_EVENT_MS} ms: ${JSON.stringify(results)}`)
      // The request is held, not answered at once and asked again: about one answer per change, plus one per
      // quiet hold that ran out. A server that answers at once is asked thousands of times here.
      assert.ok(answers <= PAGE_EVENT_SAMPLES * 2 + 10, `${answers} board answers for ${PAGE_EVENT_SAMPLES} events: the request was not held`)
      await server.stop()
      await observing
    } finally {
      isObserving = false
      observerEnd.abort()
      await world.close()
    }
  })

  test('first run: the first block appears on the serve page within budget', async () => {
    const world = makeWorld()
    let server
    try {
      server = await serve.start(world)
      assert.match(await server.page(), EMPTY_PAGE)
      block(world, { title: 'First gateway route' })
      const elapsed = await seenPageWithin(server, text => text.includes('First gateway route'), PAGE_MS)
      assert.ok(elapsed <= PAGE_MS)
      await inspectSurfaces(world, server)
    } finally {
      await world.close()
    }
  })
})

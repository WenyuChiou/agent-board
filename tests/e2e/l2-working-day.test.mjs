import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld } from './lib/world.mjs'
import { block } from './lib/writers.mjs'
import { inspectSurfaces, terminal, seenPageWithin, chat, serve, html } from './lib/surfaces.mjs'
import { seenWithin, noSilentPress, noMachineIds } from './lib/expect.mjs'
import { knownFailure } from './lib/known.mjs'
import { PANE_MS, PAGE_MS } from './lib/budget.mjs'

const ask = (world, agent = 'codex') => block(world, { agent, state: 'waiting', title: 'Release the gateway', steps: ['- [x] Check routes', '- [?] Ship the gateway, OK?'] })
const seed = world => {
  const sessions = []
  for (const [index, agent] of ['codex', 'antigravity', 'hermes', 'grok'].entries()) {
    for (let n = 0; n < 2; n++) {
      const one = { agent, project: ['api-gateway', 'docs-site', 'research-hub'][index % 3], session: `a${index}00000${n}`, title: `${agent} task ${n + 1}`, state: n ? 'waiting' : 'working', steps: n ? ['- [?] Publish the synthetic report, OK?'] : ['- [~] Validate the synthetic report'] }
      block(world, one)
      sessions.push(one)
    }
  }
  return sessions
}

describe('L2 a working day', { concurrency: 2 }, () => {
  test('a working day: each session shows one row with agent, project, task and state', async () => {
    const world = makeWorld()
    let server
    try {
      const sessions = seed(world)
      server = await serve.start(world)
      const model = (await server.get('/api/board')).json().model
      const rows = [...model.asks.map(one => ({ ...one, title: one.task })), ...model.groups.flatMap(group => group.rows)]
      for (const one of sessions) {
        const found = rows.filter(row => row.title === one.title)
        assert.equal(found.length, 1, one.title)
        assert.equal(found[0].project, one.project)
        assert.equal(found[0].agent, one.agent)
      }
      const screens = await inspectSurfaces(world, server)
      for (const [surface, text] of Object.entries(screens)) for (const one of sessions) {
        assert.match(text, new RegExp(one.title), surface)
        assert.match(text, new RegExp(one.agent), surface)
        assert.match(text, new RegExp(one.project), surface)
      }
      assert.equal(model.counts.waiting, 4)
      assert.equal(model.counts.active, 4)
    } finally {
      await world.close()
    }
  })

  test('a working day: steps ticked by an agent show on every surface within budget', async () => {
    const world = makeWorld()
    let server, watch
    try {
      const original = { title: 'Validate gateway routes', steps: ['- [~] Measure routes', '- [ ] Publish gateway'] }
      block(world, original)
      server = await serve.start(world)
      watch = terminal.watch(world)
      await watch.next(text => text.includes(original.title), 10000)
      // Opening the row is a real TTY key; collapsed rows show only counts.
      assert.match(await watch.press('\r'), /Measure routes/)
      // Finish startup and the first idle poll before measuring a producer's
      // steady-state update. Opening a card is a separate user interaction.
      await watch.next(text => text.includes('0/2') && text.includes('Measure routes'), 10000)
      block(world, { ...original, steps: ['- [x] Measure routes', '- [~] Publish gateway'] })
      assert.match(world.read('progress.md'), /\[x\] Measure routes/)
      const [observed] = await Promise.all([
        watch.next(text => text.includes('1/2') && text.includes('Publish gateway'), PANE_MS),
        seenPageWithin(server, text => text.includes('1/2') && text.includes('Publish gateway'), PAGE_MS),
      ])
      assert.ok(observed.elapsed <= PANE_MS)
      const screens = await inspectSurfaces(world, server)
      for (const [surface, text] of Object.entries(screens)) {
        // Chat's compact row reports the new next step rather than a fraction.
        if (surface !== 'chat') assert.match(text, /1\/2/, surface)
        if (surface !== 'watch') assert.match(text, /Publish gateway/, surface)
      }
    } finally {
      await world.close()
    }
  })

  test('a working day: an ask answered from the terminal board leaves the waiting count with a visible result', async () => {
    const world = makeWorld()
    try {
      ask(world)
      const before = (await terminal.keys(world, ''))
      const after = (await terminal.keys(world, 'h'))
      noSilentPress({ surface: 'terminal', card: 'Release the gateway', button: 'h', before, after })
      assert.match(after, /\b0 waiting\b/)
      assert.match(after, /Hidden:|answered, hidden/)
      assert.match(world.read('progress.md'), /\[\?\] Ship the gateway/)
      const screens = await inspectSurfaces(world)
      assert.match(screens.terminal, /\b0 waiting\b/)
      assert.match(screens.chat, /\b0 waiting\b/)
      assert.match(screens.page, /Nothing needs you/)
    } finally { await world.close() }
  })

  test('a working day: --chat shows the ask and says where to answer it', async () => {
    const world = makeWorld()
    try {
      ask(world)
      const result = await chat(world)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Ship the gateway, OK\?/)
      // The read-only chat names the owning agent and session beside its ask.
      assert.match(result.stdout, /api-gateway · codex › Release the gateway/)
      await inspectSurfaces(world)
    } finally { await world.close() }
  })

  test('a working day: an ask answered from the serve page leaves the waiting count with a visible result', async () => {
    const world = makeWorld()
    let server
    try {
      ask(world)
      server = await serve.start(world)
      const press = await server.press('Ship the gateway', 'Already answered, hide')
      noSilentPress(press)
      await seenPageWithin(server, text => text.includes('Nothing needs you'), PAGE_MS)
      assert.equal((await server.get('/api/board')).json().model.counts.waiting, 0)
      assert.match((await terminal.screen(world)), /\b0 waiting\b/)
      await inspectSurfaces(world, server)
    } finally {
      await world.close()
    }
  })

  test('a working day: finished work appears on page and HTML, chat reads today’s journal, and hidden rows stay hidden', async () => {
    const world = makeWorld()
    try {
      ask(world)
      const before = (await terminal.keys(world, ''))
      const after = (await terminal.keys(world, 'h'))
      noSilentPress({ surface: 'terminal', card: 'Release the gateway', button: 'h', before, after })
      block(world, { session: 'b2000002', agent: 'hermes', project: 'research-hub', title: 'Prepare research summary', steps: ['- [~] Summarize findings'] })
      await terminal.screen(world)
      block(world, { session: 'b2000002', agent: 'hermes', project: 'research-hub', state: 'done', title: 'Prepare research summary', steps: ['- [x] Summarize findings'] })
      // Match hooks/journal.ts journalLine's local-calendar stamp and field separators.
      const date = new Date(world.now)
      const pad = value => String(value).padStart(2, '0')
      const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      world.write(`progress-journal-${day.slice(0, 7)}.md`, `- ${day} ${pad(date.getHours())}:${pad(date.getMinutes())} · research-hub · Prepare research summary · Summarize findings\n`)
      const screens = await inspectSurfaces(world)
      for (const surface of ['page', 'html']) {
        assert.match(screens[surface], /Prepare research summary/, surface)
        assert.match(screens[surface], /Done recently/, surface)
      }
      assert.match(screens.chat, /\b1 done today\b/)
      assert.match(screens.chat, /Prepare research summary/)
      for (const [surface, text] of Object.entries(screens)) assert.match(text, /Nothing needs you|\b0 waiting\b/, surface)
      assert.match(world.read('progress.md'), /\[\?\] Ship the gateway/)
    } finally { await world.close() }
  })

  test('a working day: archiving removes finished work from the live file and keeps its questions', async () => {
    const world = makeWorld()
    try {
      block(world, { state: 'done', title: 'Publish the gateway', steps: ['- [x] Publish routes', '- [?] Notify the team, OK?'] })
      const before = await terminal.keys(world, 'i down')
      const after = await terminal.keys(world, 'i down a')
      noSilentPress({ surface: 'terminal', card: 'Publish the gateway', button: 'a', before, after })
      // The question is never lost, archived or not; only the archive itself is the known gap.
      const kept = [world.read('progress.md'), ...world.files().filter(name => /progress-(archive-.*\.md|questions.*\.json)$/.test(name)).map(name => world.read(name))].join('\n')
      assert.match(kept, /Notify the team, OK\?/)
      await knownFailure('hold:terminal-archive-ask', () => {
        assert.ok(!world.read('progress.md').includes('Publish the gateway'), `The live file still holds Publish the gateway.\n${after}`)
      })
      await inspectSurfaces(world)
    } finally { await world.close() }
  })

  test("a working day: the copy-resume action gives each host's native resume command", async () => {
    const world = makeWorld()
    try {
      for (const [index, agent] of ['codex', 'hermes', 'grok'].entries()) {
        const session = `b200000${index}`
        const resume = `${agent}-native-journey-session`
        world.write('progress.md', '')
        block(world, { session, agent, state: 'ended', resume, dir: world.root, title: `Resume ${agent} work`, steps: ['- [ ] Finish publishing'] })
        const before = (await terminal.keys(world, 'i'))
        const after = (await terminal.keys(world, 'i c'))
        noSilentPress({ surface: 'terminal', card: `Resume ${agent} work`, button: 'c', before, after })
        const command = { codex: 'codex resume', hermes: 'hermes --resume', grok: 'grok -r' }[agent]
        const clipboard = (await import('node:fs')).readFileSync(world.env.E2E_CLIPBOARD, 'utf8')
        assert.ok(clipboard.includes(`${command} ${resume}`), clipboard)
        // Identifiers belong behind Copy. All default surfaces still get the
        // strict assertion, independently of the allowed copied command.
        noMachineIds((await terminal.screen(world, ['--all'])), world)
        const visible = (await html(world)).visible
        noMachineIds(visible, world, { allow: [world.path] })
        await knownFailure(250, () => assert.ok(!visible.includes(world.path), 'HTML footer exposes the full progress file path'))
      }
      await inspectSurfaces(world)
    } finally { await world.close() }
  })

  test('a working day: every press along the day shows a result or a reason next to its card', async () => {
    const world = makeWorld()
    let server
    try {
      world.write('progress.md', '## docs-site\n### Publish docs\n- [ ] Check the links\n- [ ] Upload docs\n')
      server = await serve.start(world)
      for (const button of ['Check the links', 'Upload docs']) noSilentPress(await server.press('Publish docs', button))
      ask(world)
      noSilentPress(await server.press('Ship the gateway', 'Already answered, hide'))
      const before = (await terminal.keys(world, ''))
      const after = (await terminal.keys(world, 'u'))
      noSilentPress({ surface: 'terminal', card: 'Release the gateway', button: 'u', before, after })
      await inspectSurfaces(world, server)
    } finally {
      await world.close()
    }
  })
})

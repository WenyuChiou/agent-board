import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EN } from '../../hooks/strings-en.ts'
import { makeWorld } from './lib/world.mjs'
import { block, hook } from './lib/writers.mjs'
import { inspectSurfaces, terminal, seenPageWithin, serve, run, command } from './lib/surfaces.mjs'
import { seenWithin, noSilentPress, noMachineIds } from './lib/expect.mjs'
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
      for (const [surface, text] of Object.entries({ terminal: await terminal.screen(world), page: await server.page() })) {
        noMachineIds(text, world)
        // The page counts what waits on the flag of its Needs you section.
        assert.match(text, surface === 'page' ? /Needs you\s*1\b/ : /1\s+waiting/i, surface)
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

  test('L3 serve: opening the page twice reuses the open tab', async () => {
    const world = makeWorld()
    try {
      block(world)
      // Observe browser requests at the world's existing launch seam; never open a real tab.
      const before = world.read('agent-board.mjs')
      const seam = '((target, done) => done(false))('
      // Desktop opens now share the live-page launcher, so the static HTML seam is gone.
      assert.equal(before.split(seam).length - 1, 2)
      world.write('agent-board.mjs', before.split(seam).join('((target, done) => { process.stdout.write("E2E_BROWSER_REQUEST\\n"); done(true) })('))
      const server = await serve.start(world)
      const outputs = []
      outputs.push(await command(world, ['--serve', '--idle-minutes', '1']))
      // The terminal board reads the board from the running page too; that is not a window.
      assert.equal((await server.get('/api/board')).status, 200)
      outputs.push(await command(world, ['--serve', '--idle-minutes', '1']))
      assert.equal((outputs[1].match(/E2E_BROWSER_REQUEST/g) ?? []).length, 1, 'a script reading the board is not an open window')
      // The opened window loads the page, as a real one does.
      await server.page()
      outputs.push(await command(world, ['--serve', '--idle-minutes', '1']))
      for (const output of outputs) assert.ok(output.includes(server.url), 'The same isolated server address must be reused')
      assert.equal((outputs[0].match(/E2E_BROWSER_REQUEST/g) ?? []).length, 1)
      assert.equal((outputs[2].match(/E2E_BROWSER_REQUEST/g) ?? []).length, 0, outputs[2])
      // The agent's own way to open the page (--html, the same code /agent-board uses) points at the open window too.
      const html = await command(world, ['--html'])
      assert.equal((html.match(/E2E_BROWSER_REQUEST/g) ?? []).length, 0, html)
      assert.ok(html.includes(server.url), html)
      // A page that says it is leaving is no longer an open window: the next open starts one.
      assert.equal((await server.post('/api/page-gone', {})).status, 200)
      const third = await command(world, ['--serve', '--idle-minutes', '1'])
      assert.equal((third.match(/E2E_BROWSER_REQUEST/g) ?? []).length, 1, third)
      // The test machine can be slow to start a command, so a visible page counts for a minute here; the expiry itself is tested last with a short one.
      world.env.AGENT_BOARD_PAGE_OPEN_MS = '60000'
      // A page counts only while it reports itself visible: each poll names its page in x-board-page and its visibility in x-board-visible.
      const page = new URL(server.url)
      const poll = (id, visible = '1') => fetch(new URL('/api/board', page), { headers: { 'x-board-token': page.searchParams.get('t'), 'x-board-page': id, 'x-board-visible': visible } })
      const leave = id => fetch(new URL('/api/page-gone', page), { method: 'POST', headers: { 'x-board-token': page.searchParams.get('t'), 'x-board-page': id, 'content-type': 'application/json' }, body: '{}' })
      const windows = output => (output.match(/E2E_BROWSER_REQUEST/g) ?? []).length
      // A page in a hidden or minimized window does not stand for a window the person can see.
      assert.equal((await poll('page-one', '0')).status, 200)
      assert.equal(windows(await command(world, ['--html'])), 1, 'a hidden page must not stop a window')
      // A visible page does.
      assert.equal((await poll('page-one')).status, 200)
      assert.equal(windows(await command(world, ['--html'])), 0)
      // A newer page takes over: the older one is told once and stops, the newer one keeps its board.
      assert.equal((await poll('page-two')).status, 200)
      const replaced = await poll('page-one')
      assert.equal((await replaced.json()).moved, true, 'the older page is told the board moved')
      const kept = await (await poll('page-two')).json()
      assert.equal(kept.moved, undefined)
      assert.ok(kept.model, 'the newer page still gets the board')
      // The replaced page leaving changes nothing; the newer page is still open.
      assert.equal((await leave('page-one')).status, 200)
      assert.equal(windows(await command(world, ['--serve', '--idle-minutes', '1'])), 0)
      // The last page leaving: the next open starts a window.
      assert.equal((await leave('page-two')).status, 200)
      assert.equal(windows(await command(world, ['--html'])), 1)
      // A page that stopped asking without leaving (a crash) stops counting once its last visible poll is old enough.
      assert.equal((await poll('page-three')).status, 200)
      assert.equal(windows(await command(world, ['--html'])), 0)
      world.env.AGENT_BOARD_PAGE_OPEN_MS = '1500'
      await new Promise(done => setTimeout(done, 1800))
      assert.equal(windows(await command(world, ['--html'])), 1, 'a page that stopped asking must not stop a window')
      noMachineIds(await server.page(), world)
    } finally { await world.close() }
  })

  test('across agents: an Antigravity ask answered from the terminal board leaves the page and --print', async () => {
    const world = makeWorld()
    let server
    try {
      seedAsk(world, 'antigravity')
      server = await serve.start(world)
      assert.match(await server.page(), /Publish the synthetic report/)
      const before = (await terminal.keys(world, ''))
      const after = (await terminal.keys(world, 'h'))
      noSilentPress({ surface: 'terminal', card: 'Publish antigravity report', button: 'h', before, after })
      await seenPageWithin(server, text => text.includes(EN.pgNothing), PAGE_MS)
      const screens = await inspectSurfaces(world, server)
      assert.match(screens.print, /\b0 waiting\b/)
      assert.match(screens.terminal, /\b0 waiting\b/)
      assert.ok(screens.page.includes(EN.pgNothing), screens.page)
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
      // The resumed task is a row under Working now, in place of its line on the shelf of stopped work.
      await seenPageWithin(server, text => text.includes('Resume gateway publishing'), PAGE_MS, { read: async () => { await server.page(); return server.dom.section('working') } })
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

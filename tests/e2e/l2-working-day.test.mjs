import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EN } from '../../hooks/strings-en.ts'
import { makeWorld } from './lib/world.mjs'
import { block } from './lib/writers.mjs'
import { inspectSurfaces, terminal, seenPageWithin, chat, serve, html, pageDom } from './lib/surfaces.mjs'
import { seenWithin, noSilentPress, noMachineIds } from './lib/expect.mjs'
import { knownFailure } from './lib/known.mjs'
import { PANE_MS, PAGE_MS } from './lib/budget.mjs'

// The page's words with their line breaks and runs of spaces folded to one space.
const squash = text => text.replace(/\s+/g, ' ')
const ask = (world, agent = 'codex') => block(world, { agent, state: 'waiting', title: 'Release the gateway', steps: ['- [x] Check routes', '- [?] Ship the gateway, OK?'] })
const seed = world => {
  const sessions = []
  const startedAt = world.now - 8
  for (const [index, agent] of ['codex', 'antigravity', 'hermes', 'grok'].entries()) {
    for (let n = 0; n < 2; n++) {
      const one = { agent, project: ['api-gateway', 'docs-site', 'research-hub'][index % 3], session: `a${index}00000${n}`, title: `${agent} task ${n + 1}`, updated: new Date(startedAt + sessions.length).toISOString(), state: n ? 'waiting' : 'working', steps: n ? ['- [?] Publish the synthetic report, OK?'] : ['- [~] Validate the synthetic report'] }
      block(world, one)
      sessions.push(one)
    }
  }
  return sessions
}

describe('L2 a working day', { concurrency: 2 }, () => {
  test('L2 day: an A-or-B question is offered as Choose with both options, not Yes/No', async () => {
    const world = makeWorld()
    try {
      const question = 'Merge FAQ into Troubleshooting or keep separate?'
      ask(world)
      block(world, { state: 'waiting', title: 'Organize the FAQ', steps: [`- [?] ${question}`] })
      const server = await serve.start(world)
      for (const [surface, text] of Object.entries({ terminal: await terminal.screen(world), page: await server.page() })) {
        assert.ok(text.includes(question), surface)
        noMachineIds(text, world)
        await knownFailure('hold:question-choice-options', () => {
          assert.match(text, /Choose/, surface)
          assert.match(text, /Merge FAQ into Troubleshooting/, surface)
          assert.match(text, /keep separate/, surface)
          assert.doesNotMatch(text, /Yes\s+No|\[Confirm\]/, surface)
        })
      }
      const model = (await server.get('/api/board')).json().model
      assert.equal(model.asks.length, 1)
      await knownFailure('hold:question-choice-options', () => {
        assert.equal(model.asks[0].kind, 'choose')
        assert.deepEqual(model.asks[0].options, ['Merge FAQ into Troubleshooting', 'keep separate'])
      })
    } finally { await world.close() }
  })

  test('L2 day: work finished by Codex, Antigravity and Hermes counts in done today on every surface', async () => {
    const world = makeWorld()
    try {
      const agents = ['codex', 'antigravity', 'hermes']
      const startedAt = world.now - agents.length
      for (const [index, agent] of agents.entries()) block(world, { agent, session: `b100000${index}`, title: `Finish ${agent} report`, updated: new Date(startedAt + index).toISOString() })
      const server = await serve.start(world)
      await server.page()
      const finishedAt = world.now - agents.length
      for (const [index, agent] of agents.entries()) block(world, { agent, session: `b100000${index}`, title: `Finish ${agent} report`, updated: new Date(finishedAt + index).toISOString(), state: 'done', steps: ['- [x] Check routes'] })
      const screens = await inspectSurfaces(world, server)
      for (const [surface, text] of Object.entries(screens)) {
        await knownFailure('hold:all-agent-done-today', () => assert.match(text, /(?:3\s+done today|done today\s*3)/i, surface))
        if (surface === 'page' || surface === 'html') for (const agent of agents) assert.ok(text.includes(`Finish ${agent} report`), surface)
      }
    } finally { await world.close() }
  })

  test('L2 day: a block reaching done writes one journal line for any agent', async () => {
    const world = makeWorld()
    try {
      const agents = ['claude', 'codex', 'antigravity', 'hermes', 'grok', 'gemini', 'cursor', 'openclaw', 'opencode', 'muse', 'deepseek']
      const startedAt = world.now - agents.length
      for (const [index, agent] of agents.entries()) block(world, { agent, session: (0xb2000000 + index).toString(16), title: `Journal ${agent} report`, updated: new Date(startedAt + index).toISOString() })
      const server = await serve.start(world)
      await server.page()
      // Recent rows are ordered by timestamp, so a batch must not depend on millisecond ties.
      const finishedAt = world.now - agents.length
      for (const [index, agent] of agents.entries()) block(world, { agent, session: (0xb2000000 + index).toString(16), title: `Journal ${agent} report`, updated: new Date(finishedAt + index).toISOString(), state: 'done', steps: ['- [x] Check routes'] })
      const first = await inspectSurfaces(world, server)
      // The Done shelf replaced the Done recently heading; its count is the week's finished work.
      assert.ok(squash(first.page).includes(`${EN.pgDone} ${EN.pgDoneWeek(agents.length)}`), first.page)
      assert.match(first.page, /Journal deepseek report/)
      assert.equal((world.read('progress.md').match(/state=done /g) ?? []).length, agents.length)
      const lines = () => world.files().filter(name => /progress-journal-.*\.md$/.test(name)).flatMap(name => world.read(name).split('\n').filter(Boolean))
      for (const agent of agents) await knownFailure('hold:all-agent-done-journal', () => assert.equal(lines().filter(line => line.includes(`Journal ${agent} report`)).length, 1, `${agent}: ${lines().join('\n')}`))
      await server.page()
      await terminal.screen(world)
      for (const agent of agents) await knownFailure('hold:all-agent-done-journal', () => assert.equal(lines().filter(line => line.includes(`Journal ${agent} report`)).length, 1, `${agent}: completion must be journaled exactly once after repeated reads`))
    } finally { await world.close() }
  })

  test('L2 terminal: every key on every row kind changes the screen or prints a reason', async () => {
    const world = makeWorld()
    try {
      const failures = []
      const rows = [
        { kind: 'working', state: 'working', steps: ['- [~] Check routes'] },
        { kind: 'waiting', state: 'waiting', steps: ['- [?] Publish routes, OK?'] },
        { kind: 'stopped', state: 'ended', steps: ['- [ ] Check routes'] },
        { kind: 'idle', state: 'waiting', steps: ['- [ ] Check routes'] },
        { kind: 'blocked', state: 'working', steps: ['- [!] Check routes'] },
        { kind: 'choice', state: 'waiting', steps: ['- [?] Rollout — Canary or Everyone?'] },
        { kind: 'manual', steps: ['- [ ] Check routes'] },
        { kind: 'stopped-ask', state: 'ended', steps: ['- [?] Publish routes, OK?'] },
      ]
      // Number keys past the last row take one path; 3 and 9 stand for 3 to 9 and keep the matrix short.
      const keys = ['enter', 'x', 'a', 'd', 'c', 'h', 'y', 'n', '1', '2', '3', '9']
      for (const [index, row] of rows.entries()) for (const [keyIndex, key] of keys.entries()) {
        // Old unanswered questions become reminders; each pair needs its own ledger as well as its row.
        for (const name of world.files().filter(name => name.startsWith('progress-') && statSync(join(world.claudeDir, name)).isFile())) {
          renameSync(join(world.claudeDir, name), world.write(`matrix-aside/${index}-${keyIndex}/${name}`, ''))
        }
        world.write('progress.md', '')
        if (row.kind === 'manual') world.write('progress.md', `## api-gateway\n### manual gateway\n${row.steps.join('\n')}\n`)
        else block(world, { session: (0xc0000000 + index * 32 + keyIndex).toString(16), title: `${row.kind} gateway`, state: row.state, steps: row.steps, resume: `synthetic-${row.kind}-owner`, dir: world.root })
        const prefix = row.state === 'ended' || row.kind === 'idle' ? 'i' : ''
        const before = await terminal.keys(world, prefix)
        assert.ok(before.includes(`${row.kind} gateway`), `${row.kind} must be selectable`)
        const after = await terminal.keys(world, `${prefix} ${key}`.trim())
        const check = () => noSilentPress({ surface: 'terminal', card: row.kind, button: key, before, after })
        try {
          check()
          noMachineIds(after, world)
        } catch (error) { failures.push(new Error(`${row.kind}/${key}: ${error.message}`)) }
      }
      if (failures.length) throw new AggregateError(failures, 'Unexpected terminal key results')
    } finally { await world.close() }
  })

  test('L2 page: every button changes the page or writes a reason, including Copy with an empty box', async () => {
    const world = makeWorld()
    try {
      block(world, { state: 'waiting', resume: 'synthetic-page-owner', dir: world.root, title: 'Publish page report', steps: ['- [?] Publish routes, OK?'] })
      world.write('progress.md', world.read('progress.md') + '\n## docs-site\n### Publish docs\n- [ ] Check links\n')
      const server = await serve.start(world)
      const source = (await server.get(new URL(server.url).pathname + new URL(server.url).search)).body
      const model = (await server.get('/api/board')).json().model
      const createPage = () => pageDom(source, model, async request => {
        const result = await server.post(request.path, request.body)
        return { ok: result.status < 400, json: async () => result.json() }
      })
      const initial = await createPage()
      // The question is a card under Needs you and the docs task is a row; each is found by its own words.
      const ownerOf = card => card.textContent.includes('Publish routes, OK?') ? 'Publish routes, OK?' : 'Publish docs'
      // A button that only opens or reveals something (a row, More, Write your own) is no action; the rest are pressed.
      const isNav = button => button.getAttribute('data-nav') !== null
      const labels = []
      for (const card of initial.cards()) for (const button of initial.buttons(card)) {
        if (!isNav(button) && initial.reveal(button)) labels.push({ card: ownerOf(card), label: button.textContent })
      }
      assert.ok(labels.length > 0)
      // Each button is pressed on a fresh page, after the shelf, row or More panel around it is open.
      for (const { card: title, label } of labels) {
        const page = await createPage()
        const card = page.cards().find(one => one.textContent.includes(title) && page.buttons(one).some(button => button.textContent === label && button.getAttribute('data-nav') === null))
        assert.ok(card, `${title}: ${label}`)
        const button = page.buttons(card).find(one => one.textContent === label && one.getAttribute('data-nav') === null)
        assert.ok(page.reveal(button), `${title}: ${label} is not on screen`)
        const before = page.visible()
        button.click()
        await page.flush()
        const after = page.visible()
        const check = () => noSilentPress({ surface: 'page', card: title, button: label, before, after })
        check()
        noMachineIds(page.text(), world)
      }
      // Write your own opens a box with Copy answer: empty, it says so; with text, it copies it.
      const writing = await createPage()
      const asked = writing.cards().find(one => one.textContent.includes('Publish routes, OK?'))
      assert.ok(asked, 'The question must be a card')
      writing.buttons(asked).find(button => button.textContent === EN.pgWriteOwn).click()
      const copy = writing.buttons(asked).find(button => button.textContent === EN.pgCopyAnswer)
      assert.ok(copy && writing.reveal(copy), 'Write your own must expose a Copy answer action')
      const beforeEmpty = writing.visible()
      copy.click()
      await writing.flush()
      noSilentPress({ surface: 'page', card: 'empty reply', button: EN.pgCopyAnswer, before: beforeEmpty, after: writing.visible() })
      assert.equal(writing.copied.length, 0, 'An empty box copies nothing')
      writing.inputs(asked)[0].value = 'Publish the synthetic routes'
      const before = writing.visible()
      copy.click()
      await writing.flush()
      assert.equal(writing.copied.at(-1), 'Publish the synthetic routes')
      noSilentPress({ surface: 'page', card: 'nonempty reply', button: EN.pgCopyAnswer, before, after: writing.visible() })
      // The paste box and its relay button left the page with the redesign; Close board is the control that remains.
      const closing = await createPage()
      const beforeClose = closing.visible()
      closing.node('close').click()
      await closing.flush()
      noSilentPress({ surface: 'page', card: 'board controls', button: 'close', before: beforeClose, after: closing.visible() })
      assert.match(closing.text(), /closed/i)
    } finally { await world.close() }
  })

  test('L2 page: a stopped task without a question shows no answer box', async () => {
    const world = makeWorld()
    try {
      block(world, { state: 'ended', title: 'Stopped route review', steps: ['- [ ] Check routes'] })
      const server = await serve.start(world)
      const model = (await server.get('/api/board')).json().model
      assert.equal(model.asks.length, 0)
      assert.equal(model.stopped.length, 1)
      const page = await pageDom((await server.get(new URL(server.url).pathname + new URL(server.url).search)).body, model, async () => { assert.fail('Rendering must not post an action') })
      const card = page.cards().find(one => one.textContent.includes('Stopped route review'))
      assert.ok(card)
      noMachineIds(page.text(), world)
      await knownFailure('hold:stopped-answer-box', () => assert.equal(page.inputs(card).length, 0, card.textContent))
    } finally { await world.close() }
  })

  test('L2 page: the status line never shows a session id or a file path', async () => {
    const world = makeWorld()
    try {
      block(world, { state: 'ended', title: 'Resume route review', resume: 'synthetic-status-owner', dir: world.root, steps: ['- [ ] Check routes'] })
      const server = await serve.start(world)
      const page = await pageDom((await server.get(new URL(server.url).pathname + new URL(server.url).search)).body, (await server.get('/api/board')).json().model, async request => {
        const result = await server.post(request.path, request.body)
        return { ok: result.status < 400, json: async () => result.json() }
      })
      noMachineIds(page.text(), world)
      const card = page.cards().find(one => one.className?.split(' ').includes('row') && one.textContent.includes('Resume route review'))
      const button = page.buttons(card).find(one => /Copy resume/.test(one.textContent))
      assert.ok(button)
      // The stopped task sits on the closed Other work shelf; a person opens it and the row first.
      assert.ok(page.reveal(button), 'Copy resume must be reachable')
      const before = page.visible()
      button.click()
      await page.flush()
      noMachineIds(page.text(), world)
      assert.ok(page.copied.at(-1).includes('codex resume synthetic-status-owner'))
      noSilentPress({ surface: 'page', card: 'Resume route review', button: button.textContent, before, after: page.visible() })
      const result = page.slot(card)
      assert.ok(result)
      const status = result.textContent
      assert.ok(status.length > 0)
      noMachineIds(status, world)
    } finally { await world.close() }
  })

  test('L2 chat: --chat shows stuck steps and done recently like the terminal board', async () => {
    const world = makeWorld()
    try {
      block(world, { title: 'Review stuck route', steps: ['- [!] Waiting for synthetic credentials'] })
      block(world, { session: 'd1000001', title: 'Finished route review', state: 'done', steps: ['- [x] Check routes'] })
      const terminalText = await terminal.screen(world, ['--all'])
      const result = await chat(world)
      assert.equal(result.status, 0, result.stderr)
      noMachineIds(terminalText, world)
      noMachineIds(result.stdout, world)
      assert.match(terminalText, /Waiting for synthetic credentials/)
      assert.match(result.stdout, /Waiting for synthetic credentials/)
      for (const [surface, text] of Object.entries({ terminal: terminalText, chat: result.stdout })) await knownFailure('hold:done-recently-summary', () => {
        assert.match(text, /Done recently/, surface)
        assert.match(text, /Finished route review/, surface)
      })
    } finally { await world.close() }
  })

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
        // The page draws a waiting session as a card of its own question, naming the agent and the
        // project but not the task; those are checked below, card by card.
        if (surface === 'page' && one.state === 'waiting') continue
        assert.match(text, new RegExp(one.title), surface)
        assert.match(text, new RegExp(one.agent, surface === 'page' ? 'i' : ''), surface)
        assert.match(text, new RegExp(one.project), surface)
      }
      const cards = server.dom.cards().filter(card => card.tag === 'article')
      for (const one of sessions.filter(session => session.state === 'waiting')) {
        const found = cards.filter(card => new RegExp(one.agent, 'i').test(card.textContent) && card.textContent.includes(one.project) && card.textContent.includes('Publish the synthetic report, OK?'))
        assert.equal(found.length, 1, one.title)
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
      // The board writes nothing while its screen is unchanged (#545), so this waits one poll
      // rather than for another frame.
      await new Promise(done => setTimeout(done, 2500))
      block(world, { ...original, steps: ['- [x] Measure routes', '- [~] Publish gateway'] })
      assert.match(world.read('progress.md'), /\[x\] Measure routes/)
      const [observed] = await Promise.all([
        watch.next(text => text.includes('1/2') && text.includes('Publish gateway'), PANE_MS),
        // The page counts finished steps in words on the row ("1 step done"), not as a fraction.
        seenPageWithin(server, text => text.includes(EN.pgDoneStepsOne(1)) && text.includes('Publish gateway'), PAGE_MS),
      ])
      assert.ok(observed.elapsed <= PANE_MS)
      const screens = await inspectSurfaces(world, server)
      for (const [surface, text] of Object.entries(screens)) {
        // Chat's compact row reports the new next step rather than a fraction.
        if (surface !== 'chat') assert.match(text, surface === 'page' ? new RegExp(EN.pgDoneStepsOne(1)) : /1\/2/, surface)
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
        // The Done section replaced Done recently: the page counts the week's finished work, progress.html counts the shelf.
        assert.ok(squash(screens[surface]).includes(surface === 'page' ? `${EN.pgDone} ${EN.pgDoneWeek(1)}` : `${EN.pgDone} 1`), screens[surface])
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
        noMachineIds(visible, world)
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

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EN } from '../../hooks/strings-en.ts'
import { hookTimeout } from '../../hooks/hook-safety.ts'
import { makeWorld } from './lib/world.mjs'
import { block, hook } from './lib/writers.mjs'
import { chat, html, run, serve, terminal } from './lib/surfaces.mjs'
import { keptHookEvents } from './lib/faults.mjs'
import { knownFailure } from './lib/known.mjs'
import { fileOpsPerPoll } from './lib/soak-report.mjs'
import { BIG_FILE_HOOK_MS, BLOCKS, HOOK_TIMEOUT_MS, IDLE_POLL_FILE_OPS, LIVE_SESSIONS } from './lib/budget.mjs'

const HOUR = 3600000
const DAY = 24 * HOUR
// The most asks the terminal should print under "Waiting on you" before it says how to see the
// rest. #269 found 66 asks filling 134 lines of an 805-line print. Ten is a list the eye takes in
// at once, and the line that follows says how many more there are.
const ASK_LIST_CAP = 10
const FIVE_MB = 5 * 1024 * 1024

// The age words the board uses (hooks/view.ts relativeTime), as one pattern and as minutes. The
// pattern is built from the string table, so a reworded age changes this check with it and a
// known failure here can only keep failing for hold:ask-list-at-scale (#347).
const countOf = (say, sample) => say(sample).replace(String(sample), '\\d+')
const AGE = new RegExp(`\\b(?:${[EN.justNow, EN.yesterday, countOf(EN.minutesAgo, 0), countOf(EN.hoursAgo, 0), countOf(EN.daysAgo, 1), countOf(EN.daysAgo, 2)].join('|')})(?![\\w-])`, 'g')
const minutesOf = phrase => {
  if (phrase === EN.justNow) return 0
  if (phrase === EN.yesterday) return 24 * 60
  const count = Number(/\d+/.exec(phrase)?.[0])
  const unit = [[EN.minutesAgo, 1], [EN.hoursAgo, 60], [EN.daysAgo, 24 * 60]].find(([say]) => say(count) === phrase)
  assert.ok(unit, `Not an age the board uses: ${phrase}`)
  return count * unit[1]
}

// A session block written as text, so a file of hundreds of blocks is built and saved once
// (the block() writer reads and rewrites the whole file for every block).
const blockText = ({ session, agent = 'codex', state, updated, title, steps }) => [
  `<!-- auto session=${session} agent=${agent} state=${state} updated=${new Date(updated).toISOString()} -->`,
  `### ${title}`,
  '> Context: Synthetic scale scenario',
  ...steps,
  `<!-- /auto session=${session} -->`,
].join('\n')
const projectNames = count => Array.from({ length: count }, (_, index) => `project-${String(index).padStart(2, '0')}`)
const fileOf = (projects, blocks) => projects.flatMap(project => {
  const own = blocks.filter(one => one.project === project)
  return own.length === 0 ? [] : [`## ${project}`, ...own.map(one => one.text)]
}).join('\n') + '\n'
const agents = ['codex', 'antigravity', 'hermes', 'grok']

describe('L4 time and scale', () => {
  test('L4 a 30-day-old ask shows its age from updated=, not "just now"', async () => {
    const world = makeWorld()
    try {
      const task = 'Old gateway'
      const ask = 'Ship the gateway, OK?'
      // The board sees this block for the first time today. Only its own updated= says how old it is.
      block(world, { session: 'a4000001', state: 'waiting', updated: new Date(world.now - 30 * DAY).toISOString(), title: task, steps: ['- [x] Check routes', `- [?] ${ask}`] })
      const server = await serve.start(world)
      const screens = {
        // The stopped list is closed on the plain terminal print and opens with --all.
        terminal: await terminal.screen(world, ['--all']),
        chat: (await chat(world)).stdout,
        page: await server.page(),
        html: (await html(world)).visible,
      }
      const model = (await server.get('/api/board')).json().model
      assert.equal(model.stopped.length, 1, JSON.stringify(model.stopped))
      for (const [surface, text] of Object.entries(screens)) {
        const start = text.indexOf(task)
        const end = text.indexOf(ask, start)
        assert.ok(start >= 0 && end > start, `${surface} must show the task and its ask:\n${text}`)
        // Everything the surface says about this task, from its title down to the ask itself.
        const entry = text.slice(start, end + ask.length)
        assert.ok(entry.includes(EN.daysAgo(30)), `${surface}: ${entry}`)
        assert.ok(!text.includes(EN.justNow), `${surface} calls something "just now" on a board that holds only a 30-day-old block:\n${text}`)
      }
      assert.equal(model.stopped[0].when, EN.daysAgo(30))
      assert.ok(!JSON.stringify(model.stopped).includes(EN.justNow), JSON.stringify(model.stopped))
    } finally { await world.close() }
  })

  test('L4 +7 d: the idle shelf and the reminder list a task untouched for 7 days and an ask waiting 5 days, with their ages', async () => {
    const world = makeWorld()
    try {
      const quiet = 'Overnight job'
      const task = 'Release gateway'
      const ask = 'Ship the gateway, OK?'
      // A session that is still connected and waiting keeps its block fresh. A stopped session's
      // questions go to the older shelf at once, so only a live one can show as a reminder.
      const asking = () => block(world, { session: 'a4000702', project: 'docs-site', title: task, state: 'waiting', steps: ['- [x] Check routes', `- [?] ${ask}`] })
      // The first task is never touched again.
      block(world, { session: 'a4000701', title: quiet, state: 'working', steps: ['- [x] Check routes', '- [~] Publish the report'] })
      world.jump('2d')
      asking()
      // The board dates an ask from its first look, once the file has stood unchanged for a second
      // (isSettled in board-cli.ts), so it looks twice.
      await terminal.keys(world, 'down')
      await new Promise(done => setTimeout(done, 1300))
      await terminal.keys(world, 'down')

      // +4 d: the ask is 2 days old, so it still waits on the person, and nothing is idle yet.
      world.jump('2d')
      asking()
      const early = { terminal: await terminal.screen(world, ['--all']), chat: (await chat(world)).stdout }
      for (const [surface, text] of Object.entries(early)) {
        assert.ok(text.includes(ask) && text.includes(EN.sectionWaiting), `${surface} at +4 d must list the ask as waiting:\n${text}`)
        assert.ok(!text.includes(EN.sectionQuestionReminders), `${surface} at +4 d has a reminder too soon:\n${text}`)
        assert.ok(!text.includes(EN.idleCount(1)), `${surface} at +4 d has an idle task too soon:\n${text}`)
      }

      // +6 d: the first task has been quiet for 6 days, so it is not idle yet. An idle limit set
      // anywhere under 7 days would already list it.
      world.jump('2d')
      asking()
      const nearly = { terminal: await terminal.screen(world, ['--all']), chat: (await chat(world)).stdout }
      for (const [surface, text] of Object.entries(nearly)) {
        assert.ok(!text.includes(EN.idleCount(1)), `${surface} at +6 d has an idle task too soon:\n${text}`)
      }

      // +7 d: the first task has been quiet for 7 days and the ask is 5 days old.
      world.jump('1d')
      asking()
      const server = await serve.start(world)
      const screens = {
        terminal: await terminal.screen(world),
        'terminal --all': await terminal.screen(world, ['--all']),
        chat: (await chat(world)).stdout,
        page: await server.page(),
        html: (await html(world)).visible,
      }
      const model = (await server.get('/api/board')).json().model
      // An age phrase that does not start inside a longer number, so "5 days ago" does not pass for "15 days ago".
      const escaped = phrase => phrase.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&')
      const ageOf = phrase => new RegExp(`(^|[^0-9])${escaped(phrase)}`)
      // What a surface says about a task: the 250 characters after its title.
      const around = (surface, text, title) => {
        const at = text.indexOf(title)
        assert.ok(at >= 0, `${surface} must show "${title}":\n${text}`)
        return text.slice(at, at + 250)
      }
      for (const [surface, text] of Object.entries(screens)) {
        // Both shelves are named on every surface. The plain terminal print only names them, and
        // --all opens them.
        assert.ok(text.includes(EN.idleCount(1)), `${surface} must count the idle task:\n${text}`)
        assert.ok(text.includes(EN.sectionQuestionReminders), `${surface} must show the reminders:\n${text}`)
        assert.ok(!text.includes(EN.sectionOlderQuestions), `${surface} puts a 5-day-old ask on the older shelf:\n${text}`)
        if (surface === 'terminal') continue
        const waiting = around(surface, text, task)
        assert.match(waiting, ageOf(EN.daysAgo(5)), `${surface}: the ask must say it is 5 days old`)
        assert.ok(text.includes(ask), `${surface} must show the ask:\n${text}`)
        // Chat keeps the idle shelf to its count.
        if (surface === 'chat') continue
        const idle = around(surface, text, quiet)
        assert.ok(idle.includes(EN.sessionStopped(EN.daysAgo(7))), `${surface}: the idle task must say when it was last active: ${idle}`)
        assert.ok(!idle.includes(EN.justNow), `${surface} calls the idle task "just now": ${idle}`)
      }
      assert.deepEqual(model.idle.map(row => [row.title, row.status, row.when]), [[quiet, EN.sessionStopped(EN.daysAgo(7)), EN.daysAgo(7)]])
      assert.deepEqual((model.reminder ?? []).map(item => [item.task, item.text, item.when]), [[task, ask, EN.daysAgo(5)]])
      assert.deepEqual(model.older ?? [], [])
      assert.deepEqual(model.asks, [], 'a reminder is not also in the waiting list')
    } finally { await world.close() }
  })

  test('L4 D24 scale: the page server does at most 6 file operations per idle poll', async () => {
    const world = makeWorld()
    try {
      // A small board, so the count is the cost of one poll itself and not of a large ledger:
      // four working tasks and one open ask.
      for (let n = 0; n < 4; n++) block(world, { session: `a400090${n}`, title: `Idle poll task ${n}`, steps: ['- [x] Check routes', '- [~] Publish the report'] })
      block(world, { session: 'a4000999', state: 'waiting', title: 'Idle poll ask', steps: ['- [?] Ship the gateway, OK?'] })
      // The probe counts the page server's file operations and requests. It leaves out the clock
      // preload's own reads of the clock file.
      const probeDir = join(world.root, 'probe')
      mkdirSync(probeDir)
      world.env.E2E_SOAK_PROBE_DIR = probeDir
      world.env.NODE_OPTIONS += ` --import=${pathToFileURL(fileURLToPath(new URL('./lib/soak-probe.mjs', import.meta.url))).href}`
      const server = await serve.start(world)
      const lines = () => readdirSync(probeDir).filter(name => name.startsWith(`serve-${server.pid}.`)).flatMap(name => {
        const rows = []
        // A line the probe is still writing does not parse, and the next look reads it whole.
        for (const line of readFileSync(join(probeDir, name), 'utf8').split('\n')) {
          try { if (line !== '') rows.push(JSON.parse(line)) } catch {}
        }
        return rows
      }).map(row => ({ t: row.at, ops: Object.values(row.ops).reduce((sum, count) => sum + count, 0), requests: row.requests })).sort((a, b) => a.t - b.t)
      const pause = ms => new Promise(done => setTimeout(done, ms))
      const poll = async () => {
        const response = await server.get('/api/board')
        assert.equal(response.status, 200)
      }
      // The probe writes a line at the start and then every 10 s. The first polls record the ask,
      // which is not what an idle page costs, so they run until the second line is written. That
      // line is where the idle stretch starts.
      const began = Date.now()
      while (lines().length < 2) {
        assert.ok(Date.now() - began < 60000, `The probe wrote no second line in 60 s: ${JSON.stringify(lines())}`)
        await poll()
        await pause(250)
      }
      for (let n = 0; n < 20; n++) {
        await poll()
        await pause(200)
      }
      // The server writes its last line when it exits, and the close request is one more request.
      await server.stop()
      const samples = lines()
      assert.ok(samples.length >= 3, `The probe wrote no line when the server exited: ${JSON.stringify(samples)}`)
      const idle = fileOpsPerPoll(samples, samples[1].t, samples.at(-1).t)
      assert.ok(idle !== undefined, JSON.stringify(samples))
      assert.ok(samples.at(-1).requests - samples[1].requests >= 20, `Too few polls reached the idle stretch: ${JSON.stringify(samples)}`)
      // The ceiling is outside the marker, so the cost cannot rise further while the budget is
      // known to fail. It was 29.7 here, and a figure above 35 is a regression.
      assert.ok(idle.perPoll <= 35, `idle poll cost rose past today's 29.7: ${idle.perPoll}`)
      // The count does not depend on how busy the machine is, so a pass is a fix and the marker has
      // no mayPass. Every poll reads the board's files again even when nothing changed, and each
      // question adds to that. The budget of 6 is #254's, which was closed and folded into the
      // open umbrella #346. It was 29.7 here against that budget.
      await knownFailure(346, () => assert.ok(idle.perPoll <= IDLE_POLL_FILE_OPS, `${idle.perPoll} file operations per idle poll on a board of 5 tasks and 1 ask, the budget is ${IDLE_POLL_FILE_OPS}`))
    } finally { await world.close() }
  })

  // "L4 D24 scale: the pane does at most 6 file operations per idle poll" is in
  // tests/ledger-reads.test.tsx (#156). The pane is hooks/register.tsx running inside Claude Code:
  // plain Node cannot load it (it refuses the .tsx extension, and the 'claude-code' module the
  // file imports exists only inside Claude Code), and it reads every file through the engine's
  // $.fs, so it is counted against the mock engine under `claude plugin test`.

  test('L4 D24 scale: the terminal lists waiting asks newest first with ages, capped with "show all"', async () => {
    const world = makeWorld()
    try {
      const projects = projectNames(20)
      const live = []
      const stopped = []
      let number = 0
      const waitingAsks = Math.floor(LIVE_SESSIONS * 2 / 3)
      // The board remembers when it first saw each ask, and the terminal print only reads that
      // record. So the asks arrive in two batches, two simulated hours apart, with the page
      // server watching: at the end they are 2 hours and a moment old. Every live block stays
      // under the 12 hours after which a session counts as stopped. Two batches, not more: the
      // server's poll slows faster than the number of records (hold:serve-poll-file-ops), and a
      // third batch took this journey past 30 s.
      const batches = [33, 33]
      const asks = []
      const addBlock = (list, state, steps, title) => {
        const index = number++
        list.push({ project: projects[index % projects.length], text: blockText({ session: (0xe4000000 + index).toString(16), agent: agents[index % agents.length], state, updated: world.now, title: `${title} ${index}`, steps }) })
      }
      const server = await serve.start(world)
      // The poll reports the server's own clock, so a batch is never observed before the server
      // has caught up with a jump. The limit is long, since a poll at this size is slow on a busy
      // machine, but it stays under the lifetime serve.start gives its server (lib/surfaces.mjs),
      // so a longer wait could end in a connection error instead of the slow-poll message.
      const poll = async () => {
        const response = await fetch(new URL('/api/board', server.url), { headers: { 'x-board-token': new URL(server.url).searchParams.get('t') }, signal: AbortSignal.timeout(15000) })
        assert.equal(response.status, 200)
        return response.json()
      }
      for (const [round, size] of batches.entries()) {
        if (round > 0) {
          world.jump('2h')
          // The server child re-reads the clock file every 100 ms. Observing before it has would
          // date this batch two hours early. Polling the unchanged file is harmless.
          for (let attempt = 0; Math.abs((await poll()).now - world.now) > 2000; attempt++) {
            assert.ok(attempt < 50, 'The page server never took the clock jump')
            await new Promise(done => setTimeout(done, 100))
          }
        }
        for (let n = 0; n < size; n++) {
          const text = `Approve release ${String(asks.length).padStart(3, '0')}, OK?`
          asks.push({ text, round })
          addBlock(live, 'waiting', [`- [?] ${text}`], 'Waiting task')
        }
        // The rest of the 100 live sessions.
        if (round === 0) for (let n = 0; n < LIVE_SESSIONS - waitingAsks; n++) addBlock(live, 'working', ['- [~] Check routes'], 'Working task')
        world.write('progress.md', fileOf(projects, live))
        await poll()
        // The board writes a question's record only after the file has stood unchanged for a
        // second (isSettled in board-cli.ts), so the batch needs a second look.
        await new Promise(done => setTimeout(done, 1200))
        assert.equal((await poll()).model.asks.length, asks.length, `batch ${round}`)
      }
      const ledger = JSON.parse(world.read('progress-questions.json'))
      assert.equal(ledger.records.length, waitingAsks)
      // D24 asks for 1,000 question records. This board holds 66, the asks of its 100 live
      // sessions. The order, the ages and the cap below are checked in full, but the record count
      // is only about a fifteenth of the budget: every poll reads each record's capture file
      // (hold:serve-poll-file-ops), so each record added slows every later poll, and this journey
      // is already near the 30 s it gets at 66. Neither journey reaches the 1,000-record cap.
      assert.equal(new Set(ledger.records.map(record => record.firstObserved)).size, batches.length, 'each batch must have its own first-seen time')

      // The page server has done its part. Stopping it now, while its board is small and idle,
      // keeps the teardown quick: with 300 blocks on a busy machine its reply to the close
      // request can pass the helper's 1.5 s limit and leave the server running.
      await server.stop()

      // The other 200 of the 300 blocks: finished and stopped sessions with no open question, added
      // after the last look. Stopped sessions' questions would be recorded in the same poll, about
      // 950 capture files and 5 to 13 s per poll here: the cost of hold:serve-poll-file-ops, and not
      // what this journey looks at.
      for (let n = 0; n < BLOCKS - LIVE_SESSIONS; n++) addBlock(stopped, n % 2 ? 'ended' : 'done', n % 2 ? ['- [x] Check routes', '- [ ] Publish the report'] : ['- [x] Check routes', '- [x] Publish the report'], 'Stopped task')
      world.write('progress.md', fileOf(projects, [...live, ...stopped]))

      const shown = await terminal.screen(world)
      const everything = await terminal.screen(world, ['--all'])
      for (const text of [shown, everything]) assert.match(text, new RegExp(`${waitingAsks} ${EN.countWaiting}`))
      // Every ask is on the board. The cap may hide some of them from the plain print.
      for (const ask of asks) assert.ok(everything.includes(ask.text), `${ask.text} is missing from the --all print`)

      // The "Waiting on you" section: its heading down to the first blank line.
      const section = text => {
        const lines = text.split('\n')
        const start = lines.findIndex(line => line.includes(EN.sectionWaiting))
        assert.ok(start >= 0, text)
        const end = lines.findIndex((line, at) => at > start && line.trim() === '')
        return lines.slice(start, end < 0 ? lines.length : end)
      }
      const asksIn = lines => lines.flatMap((line, at) => asks.filter(ask => line.includes(ask.text)).map(ask => ({ ...ask, at })))
      // Without the cap the --all print is the whole list, one entry per ask.
      const everyone = section(everything)
      const listed = asksIn(everyone)
      assert.equal(listed.length, waitingAsks)
      // The plain print, read before the holds: a missing "Waiting on you" fails plainly.
      const capped = section(shown)
      // #269 (closed, folded into #347) expected all of these. They share one hold until it is built.
      await knownFailure('hold:ask-list-at-scale', () => {
        const ages = everyone.join('\n').match(AGE) ?? []
        assert.ok(ages.length >= waitingAsks, `the waiting list shows ${ages.length} ages for ${waitingAsks} asks`)
      })
      await knownFailure('hold:ask-list-at-scale', () => {
        // Newest batch first: the batch number never goes up from one ask to the next.
        const rounds = listed.map(ask => ask.round)
        assert.ok(rounds.every((round, at) => at === 0 || rounds[at - 1] >= round), `asks are not newest first (batch numbers in print order: ${rounds.slice(0, 12).join(' ')} ...)`)
        // The ages it prints read in the same order, shortest first.
        const minutes = (everyone.join('\n').match(AGE) ?? []).map(minutesOf)
        assert.ok(minutes.every((one, at) => at === 0 || minutes[at - 1] <= one), `ages do not run from newest to oldest: ${minutes.join(' ')}`)
      })
      // The plain print stops at the cap, and says how to see the rest.
      await knownFailure('hold:ask-list-at-scale', () => assert.ok(asksIn(capped).length <= ASK_LIST_CAP, `${asksIn(capped).length} asks printed under "${EN.sectionWaiting}", the cap is ${ASK_LIST_CAP}`))
      await knownFailure('hold:ask-list-at-scale', () => assert.match(capped.join('\n'), /--all|show all/i, 'no "show all" in the waiting list'))
    } finally { await world.close() }
  })

  test('L4 cleanup without Claude: stopped tasks older than the limit are archived by --tidy', async () => {
    const world = makeWorld()
    try {
      // FORMAT.md, Archive: a block that is not done goes more than 3 days after updated=.
      block(world, { session: 'a4000501', title: 'Ended long ago', state: 'ended', steps: ['- [x] Check routes', '- [ ] Publish the report'] })
      block(world, { session: 'a4000502', project: 'docs-site', agent: 'antigravity', title: 'Crashed long ago', state: 'working', steps: ['- [~] Check links'] })
      world.jump('2d')
      block(world, { session: 'a4000503', title: 'Ended two days ago', state: 'ended', steps: ['- [x] Check routes', '- [ ] Publish the report'] })
      world.jump('2d')
      block(world, { session: 'a4000504', title: 'Still working', state: 'working', steps: ['- [~] Check routes'] })
      // A finished hand-kept task nobody has watched is not archived by a scheduled sweep (FORMAT.md, Archive).
      world.write('progress.md', world.read('progress.md') + '\n## notes\n### Hand-kept errand\n- [x] Water the plants\n')

      const first = await run(world, ['--tidy'])
      assert.equal(first.status, 0, first.stderr || first.stdout)
      assert.equal(first.stdout.trim(), EN.tidyMoved(2))
      const left = world.read('progress.md')
      for (const kept of ['Ended two days ago', 'Still working', 'Hand-kept errand']) assert.ok(left.includes(kept), kept)
      for (const gone of ['Ended long ago', 'Crashed long ago']) assert.ok(!left.includes(gone), gone)
      const archives = world.files().filter(name => /^progress-archive-\d{4}-\d{2}\.md$/.test(name))
      assert.equal(archives.length, 1, world.files().join(', '))
      const archived = world.read(archives[0])
      assert.ok(archived.startsWith(EN.archiveTitle), archived)
      for (const moved of ['Ended long ago', 'Check routes', 'Crashed long ago', 'Check links']) assert.ok(archived.includes(moved), moved)
      for (const stayed of ['Ended two days ago', 'Still working', 'Hand-kept errand']) assert.ok(!archived.includes(stayed), stayed)

      // A second sweep finds nothing more and changes nothing.
      const before = world.read('progress.md')
      const second = await run(world, ['--tidy'])
      assert.equal(second.status, 0, second.stderr || second.stdout)
      assert.equal(second.stdout.trim(), EN.tidyScheduledNothing)
      assert.equal(world.read('progress.md'), before)
      assert.equal(world.read(archives[0]), archived)
    } finally { await world.close() }
  })

  test('L4 5 MB file: the Codex hook takes under 1 s longer than on a small file, within the 3 s budget', async t => {
    // Two worlds, one with a small progress.md and one with a 5 MB one, and every hook call is
    // made on each of them in turn (small, big, small, big ...). Whatever else the machine is
    // doing then slows both alike, so the small file's times say how slow the machine is and the
    // difference says how slow the file is.
    // Both are made inside the try, so a failure making the second still closes the first.
    let small, big
    try {
      small = makeWorld()
      big = makeWorld()
      // The budget is the host's own limit (HOOK_TIMEOUTS in hooks/hook-safety.ts), so a change
      // there fails here instead of leaving this check pointing at an old figure.
      assert.equal(HOOK_TIMEOUT_MS, hookTimeout('antigravity'))
      assert.equal(HOOK_TIMEOUT_MS, hookTimeout('codex', 'UserPromptSubmit'))
      const call = (world, event, payload) => hook(world, 'codex', event, { session_id: 'l4-big-file-session', cwd: world.root, ...payload })
      // The first call installs the hooks into the isolated home. It is not what is timed.
      for (const world of [small, big]) {
        const warm = await call(world, 'UserPromptSubmit', { prompt: 'Warm up the hook', turn_id: 'warm-up' })
        assert.equal(warm.status, 0, warm.stderr || warm.stdout)
        const warmStop = await call(world, 'Stop', { turn_id: 'warm-up', last_assistant_message: 'Warmed up.' })
        assert.equal(warmStop.status, 0, warmStop.stderr || warmStop.stdout)
      }

      // 300 blocks (the D24 count), long enough to pass 5 MB: 100 working, 100 ended, 100 done.
      const projects = projectNames(20)
      const blocks = Array.from({ length: BLOCKS }, (_, index) => {
        const state = ['working', 'ended', 'done'][index % 3]
        const steps = Array.from({ length: 220 }, (_, step) => `- [x] Synthetic finished step ${step} with enough words to read like a real report line`)
        if (state === 'working') steps[0] = '- [~] Check the synthetic routes'
        return { project: projects[index % projects.length], text: blockText({ session: (0xe4100000 + index).toString(16), state, updated: big.now - HOUR, title: `Big task ${index}`, steps }) }
      })
      const own = big.read('progress.md')
      big.write('progress.md', fileOf(projects, blocks) + own)
      const size = Buffer.byteLength(big.read('progress.md'))
      assert.ok(size >= FIVE_MB, `${size} bytes`)
      // The marker line of the Codex session's own block (not one of the 300 synthetic blocks, which
      // also say agent=codex). A hook that runs past the host's limit queues its event and exits 0,
      // so a clean exit alone does not show that the event reached this file: each event has to
      // move the marker (its state and updated=), or else wait in the pending folder for the next run.
      const markerOf = text => text.split('\n').find(line => line.startsWith('<!-- auto ') && line.includes('resume=l4-big-file-session '))
      const marker = markerOf(big.read('progress.md'))
      assert.ok(marker, 'the warm-up wrote no block for the Codex session')

      // The wall time of several turns, each a prompt and its end. A loaded machine only ever adds
      // time, so the fastest run is the hook's own cost plus the least delay. A hook slow on this
      // file is slow in all of them.
      const spans = { small: { prompt: [], stop: [] }, big: { prompt: [], stop: [] } }
      const outcomes = []
      let lastMarker = marker, lastQueued = keptHookEvents(big).length
      for (let attempt = 0; attempt < 4; attempt++) {
        for (const [kind, event, payload] of [['prompt', 'UserPromptSubmit', { prompt: 'Review the synthetic routes' }], ['stop', 'Stop', { last_assistant_message: 'Checked the synthetic routes.' }]]) {
          for (const [label, world] of [['small', small], ['big', big]]) {
            const start = performance.now()
            const result = await call(world, event, { turn_id: `${label}-${attempt}`, ...payload })
            spans[label][kind].push(Math.round(performance.now() - start))
            assert.equal(result.status, 0, result.stderr || result.stdout)
            if (label === 'big') {
              // Applied (the block moved) or queued (one more event waits in the pending folder).
              // An event that did neither is lost. The whole marker line is compared, since a
              // prompt and an end can land in one second and leave updated= alone as it was.
              const current = markerOf(big.read('progress.md')), queued = keptHookEvents(big).length
              outcomes.push(current !== lastMarker ? 'applied' : queued > lastQueued ? 'queued' : 'lost')
              lastMarker = current
              lastQueued = queued
            }
          }
        }
      }
      // The hook worked in the big file: it lost none of its blocks, and none of the timed events.
      // On a loaded machine an event may wait in the pending folder for the next run, which is not a loss.
      const after = big.read('progress.md')
      assert.equal((after.match(/<!-- auto session=/g) ?? []).length, BLOCKS + 1)
      assert.notEqual(markerOf(after), marker, 'the timed events never reached the big file')
      // Every run prints what became of the timed events and how long they took, so a CI run records both.
      t.diagnostic(`5 MB file: timed events ${outcomes.join(', ')}; prompt ms big ${spans.big.prompt.join(' ')} small ${spans.small.prompt.join(' ')}; stop ms big ${spans.big.stop.join(' ')} small ${spans.small.stop.join(' ')}`)
      assert.ok(!outcomes.includes('lost'), `a timed event was neither applied nor queued (in order: ${outcomes.join(', ')})`)

      // The file's own cost is the big file's fastest run minus the small file's fastest run of the
      // same hook, taken in turn. An absolute 1 s cannot be the limit: on a loaded 4-vCPU runner
      // the small file alone took 1150 to 2095 ms (measured), and CI runs 3 test files at once on
      // 4 vCPUs. The 3 s budget stays absolute, because a hook past the host's limit loses its event.
      // #241 measured 0.8 to 1.8 s on a small file and 1.5 to 2.4 s on 5 MB, so the file added
      // about 0.7 s there, which this check allows: a pass does not show that slowdown is gone.
      const fastest = list => Math.min(...list)
      const note = `on ${size} bytes`
      for (const [kind, event] of [['prompt', 'UserPromptSubmit'], ['stop', 'Stop']]) {
        const bigRun = fastest(spans.big[kind]), smallRun = fastest(spans.small[kind])
        // The 5 MB file may add less than BIG_FILE_HOOK_MS to the same hook on a small file, run in turn.
        assert.ok(bigRun - smallRun < BIG_FILE_HOOK_MS, `${event}: big ${spans.big[kind].join(', ')} ms vs small ${spans.small[kind].join(', ')} ms ${note}`)
        assert.ok(bigRun < HOOK_TIMEOUT_MS, `${event} took ${bigRun} ms ${note}; the budget is ${HOOK_TIMEOUT_MS} ms (the host gives up after ${hookTimeout('codex', event)} ms)`)
      }
    } finally {
      // Both closes finish before either failure is reported.
      const closed = await Promise.allSettled([small?.close(), big?.close()])
      const failed = closed.filter(one => one.status === 'rejected').map(one => one.reason)
      if (failed.length) throw new AggregateError(failed, 'World cleanup failed')
    }
  })
})

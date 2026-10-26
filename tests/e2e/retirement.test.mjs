import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
// hook-reporters.ts and what it imports use `.ts` suffixes, so plain Node loads it without a resolve hook.
import { reporterPs1, reporterSh } from '../../hooks/hook-reporters.ts'
import { EN } from '../../hooks/strings-en.ts'
import { makeWorld } from './lib/world.mjs'
import { block, turn } from './lib/writers.mjs'
import { run, runProcess, terminal } from './lib/surfaces.mjs'
import {
  RETIREMENT_DAYS, RETIREMENT_QUESTIONS_PER_DAY, RETIREMENT_LIVE_BLOCKS, RETIREMENT_PROGRESS_BYTES, RETIREMENT_INBOX_FILES,
} from './lib/budget.mjs'

// Session ids are 8 hex characters. A day and a slot give each of a day's six sessions its own.
const sessionOf = (day, slot) => (0xd0000000 + day * 16 + slot).toString(16)
const two = day => String(day).padStart(2, '0')
const titlesIn = text => [...text.matchAll(/^### (.+?)\r?$/gm)].map(match => match[1])
const archiveText = world => world.files().filter(name => /^progress-archive-.*\.md$/.test(name)).map(name => world.read(name)).join('\n')

// dropped.log is the reporters' count of the turns they removed (docs/FORMAT.md), not a turn.
const inboxOf = world => {
  const names = readdirSync(world.inbox)
  return {
    turns: names.filter(name => name.endsWith('.json')).length,
    others: names.filter(name => !name.endsWith('.json')).sort(),
  }
}

// What the live file and the inbox hold, as docs/FORMAT.md names them.
const measure = world => {
  const live = world.read('progress.md')
  const { turns, others } = inboxOf(world)
  return {
    progress: Buffer.byteLength(live),
    blocks: (live.match(/^<!-- auto /gm) ?? []).length,
    inbox: turns,
    others,
  }
}

// The next turn end of an agent that reports through the inbox, run through the reporter script
// the installer writes (PowerShell on Windows, sh elsewhere). Each run deletes the inbox files
// that are past its age limit, which is the only thing that trims the inbox without a Claude session.
// On a busy machine a reporter can give up at its own time limit before it writes its file, and
// exits 0 without having cleaned up (the host-timeout problem #241 describes). The next turn of
// the agent would run it again, so this does too, up to three times.
const reportTurn = async (world, session) => {
  const payload = JSON.stringify({ session_id: session, cwd: world.root, last_assistant_message: 'Synced the list.' })
  const before = new Set(readdirSync(world.inbox))
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = process.platform === 'win32'
      ? await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', world.write('progress-report.ps1', reporterPs1()), 'hermes', 'turn'], { env: world.env, cwd: world.root, input: payload })
      : await runProcess('/bin/sh', [world.write('progress-report.sh', reporterSh(join(world.claudeDir, 'progress-inbox'))), 'hermes', 'turn'], { env: world.env, cwd: world.root, input: payload })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    if (readdirSync(world.inbox).some(name => !before.has(name) && name.endsWith('.json'))) return
  }
  assert.fail('The reporter wrote no turn file in three tries')
}

// Alone on Windows this takes 7 to 8 s warm and 15 s on a cold first run while other tests ran
// (15 board sweeps, 5 board looks and 3 PowerShell reporter runs, each a process start). On a
// machine other sessions held at 99% CPU it took 32 s, so the limit is 60 s: a hang still shows in
// a minute, not 2.5 minutes.
test('Retirement: after 30 simulated days of daily churn, progress.md and the inbox stay bounded and the question ledger still holds the first day', { timeout: 60000 }, async () => {
  const world = makeWorld()
  try {
    const titles = []
    const samples = []
    // The questions that were open while the person looked, by day: the board records those.
    const looked = []
    for (let day = 0; day < RETIREMENT_DAYS; day++) {
      const label = two(day)
      // Four sessions ask a question and finish. Two start work that stays stopped.
      const asking = [
        { agent: 'codex', project: 'api-gateway', title: `Build ${label} release`, ask: `Ship build ${label}, OK?` },
        { agent: 'antigravity', project: 'docs-site', title: `Notes ${label} review`, ask: `Publish notes ${label}, OK?` },
        { agent: 'cursor', project: 'api-gateway', title: `Lint ${label} pass`, ask: `Apply the lint fixes ${label}, OK?` },
        { agent: 'gemini', project: 'docs-site', title: `Links ${label} check`, ask: `Remove the dead links ${label}, OK?` },
      ].map((one, slot) => ({ ...one, session: sessionOf(day, slot) }))
      assert.equal(asking.length, RETIREMENT_QUESTIONS_PER_DAY)
      const papers = { agent: 'hermes', session: sessionOf(day, 4), project: 'research-hub', title: `Papers ${label} sync` }
      const cleanup = { agent: 'grok', session: sessionOf(day, 5), project: 'api-gateway', title: `Cleanup ${label} job` }
      titles.push(...asking.map(one => one.title), papers.title, cleanup.title)

      // Morning: four sessions ask, and a fifth starts work it never finishes (its terminal closes).
      for (const one of asking) block(world, { ...one, state: 'waiting', steps: ['- [x] Check the routes', `- [?] ${one.ask}`] })
      block(world, { ...papers, state: 'working', steps: ['- [~] Fetch the paper list'] })
      // The person opens the board once a week, while the day's four questions are open. A board
      // run reads every question file there is, so five looks are enough to record questions
      // across the month without making the late runs slow.
      if (day % 7 === 0) {
        await terminal.keys(world, '')
        looked.push(...asking.map(one => ({ day, ask: one.ask })))
      }
      // Afternoon: the person answers each agent in its own chat, and each agent ticks its step and
      // finishes. The sixth session ends with a step left.
      for (const one of asking) block(world, { ...one, state: 'done', steps: ['- [x] Check the routes', `- [x] ${one.ask.replace(/, OK\?$/, '')}`] })
      block(world, { ...cleanup, state: 'ended', steps: ['- [x] Draft the cleanup', '- [ ] Publish the cleanup'] })
      // Evening: two agents that report through the inbox leave a turn each. A file carries the
      // real time, which the clock jumps then age, the way the reporter script reads it.
      turn(world, 'hermes', { session: `hermes-${label}`, project: 'research-hub', text: `Synced papers ${label}.` }, { at: Date.now() })
      turn(world, 'gemini', { session: `gemini-${label}`, project: 'docs-site', text: `Reviewed notes ${label}.` }, { at: Date.now() })
      // The reporter runs at the end of every tenth day, as the next turn of any agent would.
      if (day % 10 === 9) {
        await reportTurn(world, `hermes-${label}`)
        const { turns, others } = inboxOf(world)
        assert.ok(turns <= RETIREMENT_INBOX_FILES, `day ${day}: ${turns} inbox files after a reporter run, cap ${RETIREMENT_INBOX_FILES}`)
        assert.deepEqual(others, ['dropped.log'], `day ${day}: non-turn inbox files after a reporter run: ${others.join(', ')}`)
      }
      world.jump('1d')
      // The scheduled sweep every second night: no Claude session, the standalone board's own command.
      if (day % 2 === 1) {
        const swept = await run(world, ['--tidy'])
        assert.equal(swept.status, 0, swept.stderr || swept.stdout)
      }
      samples.push({ day, ...measure(world) })
    }

    // Nothing is lost: every title is on the board or in the archive.
    const everything = titlesIn(world.read('progress.md')).concat(titlesIn(archiveText(world)))
    for (const title of titles) assert.ok(everything.includes(title), `${title} is neither on the board nor in the archive`)
    // The archive limits apply from the fifth day on. From then on the live file stays under its caps.
    for (const sample of samples.filter(one => one.day >= 5)) {
      assert.ok(sample.blocks <= RETIREMENT_LIVE_BLOCKS, `day ${sample.day}: ${sample.blocks} blocks on the board, cap ${RETIREMENT_LIVE_BLOCKS}`)
      assert.ok(sample.progress <= RETIREMENT_PROGRESS_BYTES, `day ${sample.day}: progress.md is ${sample.progress} bytes, cap ${RETIREMENT_PROGRESS_BYTES}`)
    }
    const last = samples.at(-1)
    assert.ok(last.inbox <= RETIREMENT_INBOX_FILES, `${last.inbox} inbox files after ${RETIREMENT_DAYS} days, cap ${RETIREMENT_INBOX_FILES}`)
    assert.deepEqual(last.others, ['dropped.log'], `non-turn inbox files after ${RETIREMENT_DAYS} days: ${last.others.join(', ')}`)
    // FORMAT.md (Versioning, full-source evidence) says never to age-prune the question evidence:
    // the ledger and its capture files. So after 30 days the ledger holds exactly the questions
    // asked while someone looked, the first day's included, with at least as many capture files. How
    // fast they grow is the storage work (#373).
    const records = JSON.parse(world.read('progress-questions.json')).records
    for (const one of looked) assert.ok(records.some(record => record.words === one.ask), `the question of day ${one.day} is missing from the ledger: ${one.ask}`)
    assert.equal(records.length, looked.length, `${records.length} question records for the ${looked.length} questions asked while someone looked`)
    const captures = readdirSync(world.claudeDir).filter(name => /^progress-questions-source-[a-f0-9]{64}\.json$/.test(name))
    assert.ok(captures.length >= looked.length, `${captures.length} capture files for ${looked.length} recorded questions`)
  } finally { await world.close() }
})

test('Retirement: old sessions leave the live file the way FORMAT.md says (done after 12 hours, working, waiting or ended after 3 days)', async () => {
  const world = makeWorld()
  try {
    const sessions = [
      { agent: 'codex', session: 'e1000001', title: 'Finished report', state: 'done', steps: ['- [x] Check the routes'] },
      { agent: 'codex', session: 'e1000002', title: 'Finished with a question', state: 'done', steps: ['- [x] Check the routes', '- [?] Ship the gateway, OK?'] },
      { agent: 'antigravity', session: 'e1000003', title: 'Working session', state: 'working', steps: ['- [~] Check the routes'] },
      { agent: 'hermes', session: 'e1000004', title: 'Waiting session', state: 'waiting', steps: ['- [ ] Check the routes'] },
      { agent: 'grok', session: 'e1000005', title: 'Ended session', state: 'ended', steps: ['- [ ] Check the routes'] },
    ]
    for (const one of sessions) block(world, one)
    const live = () => titlesIn(world.read('progress.md'))
    const archived = () => titlesIn(archiveText(world))
    const sweep = async () => {
      const result = await run(world, ['--tidy'])
      assert.equal(result.status, 0, result.stderr || result.stdout)
      return result.stdout.trim()
    }
    const titles = sessions.map(one => one.title)

    // 11 hours: a finished block is still in its first half day.
    world.jump('11h')
    assert.equal(await sweep(), EN.tidyScheduledNothing)
    assert.deepEqual(live(), titles)
    // 13 hours: only the finished block with no open question has gone.
    world.jump('2h')
    assert.equal(await sweep(), EN.tidyMoved(1))
    assert.deepEqual(live(), titles.filter(title => title !== 'Finished report'))
    assert.deepEqual(archived(), ['Finished report'])
    // 71 hours: sessions that look stopped since 12 hours still have their three days.
    world.jump('58h')
    assert.equal(await sweep(), EN.tidyScheduledNothing)
    assert.deepEqual(live(), titles.filter(title => title !== 'Finished report'))
    // 73 hours: working, waiting and ended sessions go together. A block that still asks a
    // question stays whatever its state says.
    world.jump('2h')
    assert.equal(await sweep(), EN.tidyMoved(3))
    assert.deepEqual(live(), ['Finished with a question'])
    assert.deepEqual(archived().sort(), ['Ended session', 'Finished report', 'Waiting session', 'Working session'])
    // The stopped shelf is closed on the plain screen, and --all opens it.
    const screen = await terminal.screen(world, ['--all'])
    assert.ok(screen.includes('Finished with a question'), screen)
    for (const title of ['Finished report', 'Working session', 'Waiting session', 'Ended session']) assert.ok(!screen.includes(title), `${title} is still on the board:\n${screen}`)
  } finally { await world.close() }
})

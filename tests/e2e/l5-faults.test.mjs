import { test } from 'node:test'
import assert from 'node:assert/strict'
import { availableParallelism } from 'node:os'
import { performance } from 'node:perf_hooks'
import { EN } from '../../hooks/strings-en.ts'
import { STALE_MS } from '../../hooks/parse.ts'
import { hookTimeout } from '../../hooks/hook-safety.ts'
import { HOOK_TIMEOUT_MS } from './lib/budget.mjs'
import { makeWorld } from './lib/world.mjs'
import { block, hook } from './lib/writers.mjs'
import { busyProcesses, formatWriters, keptHookEvents, lockFile, skew, storageFault, tear } from './lib/faults.mjs'
import { knownFailure } from './lib/known.mjs'
import { chat, html, pageDom, run, serve } from './lib/surfaces.mjs'

const journalText = world => world.files().filter(name => /^progress-journal-.*\.md$/.test(name)).map(name => world.read(name)).join('\n')
const journalName = world => {
  const day = new Date(world.now)
  return `progress-journal-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}.md`
}
const stamp = at => {
  const day = new Date(at)
  const two = value => String(value).padStart(2, '0')
  return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())} ${two(day.getHours())}:${two(day.getMinutes())}`
}
const descendants = node => [node, ...node.childNodes.flatMap(descendants)]
// The whole reason, wrapped under the pressed card and never cut.
const resultUnderCard = (frame, note) => {
  const lines = frame.split('\n')
  const card = lines.findIndex(line => line.includes('First card'))
  assert.ok(card >= 0, frame)
  const under = []
  for (const line of lines.slice(card + 1)) {
    if (!line.startsWith('    ') || under.join(' ') === note) break
    under.push(line.trim())
  }
  assert.equal(under.join(' '), note, frame)
  assert.ok(!under.some(line => line.includes('…')), frame)
}
const unsaved = EN.boardSaveFailed(EN.fileProgress, EN.storageReadOnly)
// progress.md cannot be replaced, the way a read-only file refuses it on Windows; the journal
// beside it can still be written.
const readOnlyProgress = world => storageFault(world, { code: 'EPERM' }).enable('write')

test('L5 read-only file: a failed tick writes no journal line and shows a one-line reason', async () => {
  const world = makeWorld()
  try {
    const step = 'Review every route in the synthetic deployment report'
    const source = `## Demo\n### First card\n- [ ] ${step}\n`
    world.write('progress.md', source)
    readOnlyProgress(world)
    const terminal = await run(world, ['--keys', 'x'])
    assert.notEqual(terminal.status, 0, terminal.stderr)
    assert.equal(terminal.signal, null)
    assert.equal(terminal.stderr.trim(), unsaved)
    resultUnderCard(terminal.stdout, unsaved)
    assert.equal(world.read('progress.md'), source)
    assert.ok(!journalText(world).includes(step))

    const server = await serve.start(world)
    const model = (await server.get('/api/board')).json().model
    let response
    const page = await pageDom((await server.get(new URL(server.url).pathname + new URL(server.url).search)).body, model, async request => {
      response = await server.post(request.path, request.body)
      return { ok: response.status < 400, json: async () => response.json() }
    })
    const card = page.cards().find(one => one.textContent.includes('First card'))
    assert.ok(card, page.text())
    const button = page.buttons(card).find(one => one.textContent === `Done: ${step}`)
    assert.ok(button, card.textContent)
    button.click()
    await page.flush()
    assert.equal(response.status, 409)
    const result = descendants(card).find(one => one.className?.split(' ').includes('press-result'))
    assert.equal(result?.textContent, unsaved)
    assert.equal(world.read('progress.md'), source)
    assert.ok(!journalText(world).includes(step))
  } finally { await world.close() }
})

test('L5 read-only file: a failed confirm-done writes no journal line', async () => {
  const world = makeWorld()
  try {
    // The same step twice gives the same journal line twice: both are taken back.
    const steps = ['Review the synthetic route report', 'Review the synthetic route report', 'Check the synthetic deployment plan']
    const source = `## Demo\n### First card\n${steps.map(step => `- [ ] ${step}`).join('\n')}\n`
    world.write('progress.md', source)
    readOnlyProgress(world)
    const terminal = await run(world, ['--keys', 'd'])
    assert.notEqual(terminal.status, 0, terminal.stderr)
    assert.equal(terminal.signal, null)
    assert.equal(terminal.stderr.trim(), unsaved)
    resultUnderCard(terminal.stdout, unsaved)
    assert.equal(world.read('progress.md'), source)
    for (const step of steps) assert.ok(!journalText(world).includes(step))
  } finally { await world.close() }
})

test('L5 read-only file: a failed tick keeps the journal lines that were there before or written meanwhile', async () => {
  const world = makeWorld()
  try {
    const step = 'Review the synthetic gateway routes'
    const source = `## Demo\n### First card\n- [ ] ${step}\n`
    world.write('progress.md', source)
    // A CRLF line inside, so a rewrite that normalised the lines it keeps would show.
    const before = '# Work log\r\n- 2026-10-01 09:00 · Demo · Earlier card · Earlier synthetic work\n'
    const meanwhile = '- 2026-10-01 09:05 · Docs · Other card · Another writer finished a synthetic report\r\n'
    const journal = world.write(journalName(world), before)
    // Another writer adds a line between this tick's journal write and its refused board write.
    const preload = world.write('meanwhile-fault.cjs', `const fs = require('node:fs')
const { resolve } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const target = ${JSON.stringify(world.path)}
const rename = fs.renameSync
let isFirst = true
fs.renameSync = (from, to, ...args) => {
  if (resolve(String(to)) !== resolve(target)) return rename(from, to, ...args)
  if (isFirst) { isFirst = false; fs.appendFileSync(${JSON.stringify(journal)}, ${JSON.stringify(meanwhile)}) }
  throw Object.assign(new Error('synthetic read-only progress file'), { code: 'EPERM' })
}
syncBuiltinESMExports()
`)
    world.env.NODE_OPTIONS += ` --require=${JSON.stringify(preload)}`
    const terminal = await run(world, ['--keys', 'x'])
    assert.notEqual(terminal.status, 0, terminal.stderr)
    assert.equal(terminal.stderr.trim(), unsaved)
    assert.equal(world.read('progress.md'), source)
    assert.equal(world.read(journalName(world)), before + meanwhile)
  } finally { await world.close() }
})

test('L5 read-only file: a failed tick whose line was already in the journal leaves the journal as it was', async () => {
  const world = makeWorld()
  try {
    const step = 'Review the synthetic gateway routes'
    const source = `## Demo\n### First card\n- [ ] ${step}\n`
    world.write('progress.md', source)
    // The line this tick would write, for this minute and the next, so a minute that turns
    // during the run still finds it there.
    // CRLF endings: an append would turn the last one into LF, so this passes only when the
    // tick found its line there and wrote nothing.
    const lines = [world.now, world.now + 60000].map(at => `- ${stamp(at)} · Demo · First card · ${step}`)
    const before = `# Work log\r\n${lines.join('\r\n')}\r\n`
    world.write(journalName(world), before)
    readOnlyProgress(world)
    const terminal = await run(world, ['--keys', 'x'])
    assert.notEqual(terminal.status, 0, terminal.stderr)
    assert.equal(terminal.stderr.trim(), unsaved)
    assert.equal(world.read('progress.md'), source)
    assert.equal(world.read(journalName(world)), before)
  } finally { await world.close() }
})

test('L5 locked file: a tick whose board write landed before the file was locked keeps its journal line', async () => {
  const world = makeWorld()
  try {
    const step = 'Review the synthetic gateway routes'
    world.write('progress.md', `## Demo\n### First card\n- [ ] ${step}\n`)
    // The board is replaced, then another program holds progress.md, so reading it back fails.
    const preload = world.write('landed-fault.cjs', `const fs = require('node:fs')
const { resolve } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const target = ${JSON.stringify(world.path)}
const rename = fs.renameSync
const read = fs.readFileSync
let isHeld = false
fs.renameSync = (from, to, ...args) => {
  const result = rename(from, to, ...args)
  if (resolve(String(to)) === resolve(target)) isHeld = true
  return result
}
fs.readFileSync = (file, ...args) => {
  if (isHeld && resolve(String(file)) === resolve(target)) throw Object.assign(new Error('synthetic busy file'), { code: 'EBUSY' })
  return read(file, ...args)
}
syncBuiltinESMExports()
`)
    world.env.NODE_OPTIONS += ` --require=${JSON.stringify(preload)}`
    const terminal = await run(world, ['--keys', 'x'])
    assert.notEqual(terminal.status, 0, terminal.stderr)
    assert.ok(terminal.stderr.includes(EN.boardStorageFailed(EN.fileProgress, EN.storageBusy)), terminal.stderr)
    assert.ok(world.read('progress.md').includes(`- [x] ${step}`))
    assert.ok(journalText(world).includes(`First card · ${step}`))
  } finally { await world.close() }
})

// Step 3 of #222: more failures a person meets, each checked on what they would see or what stays on disk.
const occurrences = (text, part) => text.split(part).length - 1
const pause = ms => new Promise(done => setTimeout(done, ms))

test('L5 torn tail: the board warns in one line and still shows every complete block', async () => {
  // Two ways a write is cut off: in the middle of a new block's start marker, and in the middle of
  // the end marker of the last block. The blocks before the cut are complete in both.
  const cutOff = EN.progressIncomplete(1)
  const shapes = [
    { name: 'cut start marker', complete: ['First complete card', 'Second complete card', 'Third complete card'], cut: world => world.write('progress.md', world.read('progress.md') + '<!-- auto session=b200') },
    { name: 'cut end marker', complete: ['First complete card', 'Second complete card'], cut: world => tear(world, 'progress.md', world.read('progress.md').lastIndexOf('<!-- /auto session=a1000003 -->') + '<!-- /auto sess'.length) },
  ]
  for (const shape of shapes) {
    const world = makeWorld()
    try {
      block(world, { session: 'a1000001', title: 'First complete card', steps: ['- [~] Check the synthetic routes'] })
      block(world, { session: 'a1000002', agent: 'antigravity', project: 'docs-site', state: 'waiting', title: 'Second complete card', steps: ['- [?] Publish the synthetic docs, OK?'] })
      block(world, { session: 'a1000003', agent: 'hermes', project: 'research-hub', title: 'Third complete card', steps: ['- [~] Summarise the synthetic notes'] })
      shape.cut(world)
      const server = await serve.start(world)
      const terminal = await run(world, [])
      assert.equal(terminal.status, 0, terminal.stderr)
      const screens = { terminal: terminal.stdout, chat: (await chat(world)).stdout, html: (await html(world)).visible, page: await server.page() }
      for (const [surface, text] of Object.entries(screens)) {
        const label = `${shape.name} on ${surface}`
        // Once, and whole: a warning cut over two lines or shown twice does not count.
        assert.equal(occurrences(text, cutOff), 1, `${label}:\n${text}`)
        for (const title of shape.complete) assert.ok(text.includes(title), `${label} lost ${title}:\n${text}`)
      }
      for (const surface of ['terminal', 'chat']) assert.equal(screens[surface].split('\n').filter(line => line.trim() === cutOff).length, 1, surface)
      assert.equal((await server.get('/api/board')).json().model.warning, cutOff)
    } finally { await world.close() }
  }
})

test('L5 torn tail: a reporter append repairs the tail or reports why, never fails silently', async () => {
  const world = makeWorld()
  try {
    const fragments = () => world.files().filter(name => name.startsWith('progress.md.torn-'))
    const fragmentTexts = () => fragments().map(name => world.read(name).trim()).sort()
    const report = session => hook(world, 'codex', 'UserPromptSubmit', { session_id: session, prompt: 'Review the synthetic routes', cwd: world.root })
    // One complete block, as the file stood before the cut.
    const start = () => {
      world.write('progress.md', '')
      block(world, { session: 'a1000001', title: 'Complete card', steps: ['- [~] Check the synthetic routes'] })
      return world.read('progress.md')
    }
    const cutStart = '<!-- auto session=b200'
    const cutEnd = '<!-- /auto sess'

    // The cut is a start marker with nothing after it: the reporter sets it aside and writes on.
    let whole = start()
    world.write('progress.md', whole + cutStart)
    let result = await report('codex-torn-session-1')
    assert.equal(result.status, 0, result.stderr)
    let after = world.read('progress.md')
    assert.ok(after.startsWith(whole), 'the complete block keeps its bytes')
    assert.ok(!after.includes(cutStart), 'the cut marker is gone from the board')
    assert.equal(occurrences(after, 'resume=codex-torn-session-1 '), 1, 'the new report is written')
    assert.deepEqual(fragmentTexts(), [cutStart])
    assert.doesNotMatch((await run(world, [])).stdout, /cut-off marker/)

    // The cut is inside the end marker of an open block: the reporter writes the marker out in full.
    whole = start()
    tear(world, 'progress.md', whole.indexOf('<!-- /auto session=a1000001 -->') + cutEnd.length)
    result = await report('codex-torn-session-2')
    assert.equal(result.status, 0, result.stderr)
    after = world.read('progress.md')
    assert.ok(after.startsWith(whole), 'the end marker is whole again')
    assert.equal(occurrences(after, 'resume=codex-torn-session-2 '), 1, 'the new report is written')
    assert.deepEqual(fragmentTexts(), [cutEnd, cutStart].sort())
    assert.doesNotMatch((await run(world, [])).stdout, /cut-off marker/)

    // Text follows the cut: the reporter does not guess. It keeps every byte, adds its report
    // and the board goes on warning, so the damage stays in view.
    whole = start()
    const torn = whole + `${cutStart}\n### Keep\n- [ ] later synthetic task\n`
    world.write('progress.md', torn)
    const saved = fragments().length
    result = await report('codex-torn-session-3')
    assert.equal(result.status, 0, result.stderr)
    after = world.read('progress.md')
    assert.ok(after.startsWith(torn), 'every byte after the cut is kept')
    assert.equal(occurrences(after, 'resume=codex-torn-session-3 '), 1, 'the new report is written')
    assert.equal(fragments().length, saved, 'nothing is set aside when nothing is repaired')
    assert.match((await run(world, [])).stdout, /cut-off marker line/)

    // The repair cannot be written: a one-line error, a failing exit, the board as it was and no
    // fragment left behind.
    whole = start()
    world.write('progress.md', whole + cutStart)
    const unrepaired = world.read('progress.md')
    const kept = fragments()
    world.env.CODEX_THREAD_ID = 'codex-torn-session-4'
    storageFault(world, { code: 'EACCES' }).enable('write')
    result = await run(world, ['--codex-report'], { input: JSON.stringify({ project: 'api-gateway', title: 'Report onto a torn file', state: 'working', steps: ['- [~] Write the report'] }) })
    assert.notEqual(result.status, 0, 'a refused write must not look like success')
    assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr)
    assert.match(result.stderr, /EACCES/)
    assert.equal(world.read('progress.md'), unrepaired)
    assert.deepEqual(fragments(), kept)
  } finally { await world.close() }
})

test('L5 locked file: the hook retries, exits 0, and the Stop event lands on the next run', async t => {
  const world = makeWorld()
  try {
    const session = 'codex-locked-session'
    assert.equal((await hook(world, 'codex', 'UserPromptSubmit', { session_id: session, prompt: 'Review the synthetic routes', cwd: world.root })).status, 0)
    const before = world.read('progress.md')
    const lock = await lockFile(world, 'progress.md')
    if (lock.skip) {
      t.skip(lock.skip)
      return
    }
    // The hook may not wait long: the budget is 3 s (Codex gives up on a Stop hook after 10 s). It returns quietly and keeps
    // the event for later instead of failing or writing half a file.
    const stopped = await hook(world, 'codex', 'Stop', { session_id: session, cwd: world.root })
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.equal(stopped.stderr.trim(), '')
    // The locked run itself queued the event; the later run below only replays it.
    assert.ok(keptHookEvents(world).includes(session), 'the locked Stop event is kept for the next run')
    await lock.release()
    assert.equal(world.read('progress.md'), before, 'a locked run changes nothing')
    assert.deepEqual(world.files().filter(name => name.endsWith('.tmp')), [], 'no half-written temp file is left')
    assert.match(before, new RegExp(`state=working [^>]*resume=${session} `))
    // Any later run replays what was kept, oldest first, before its own event.
    const next = await hook(world, 'codex', 'UserPromptSubmit', { session_id: 'codex-locked-next-session', prompt: 'Review the synthetic metrics', cwd: world.root })
    assert.equal(next.status, 0, next.stderr)
    const after = world.read('progress.md')
    assert.match(after, new RegExp(`state=waiting [^>]*resume=${session} `), 'the Stop event landed')
    assert.equal(occurrences(after, 'resume=codex-locked-next-session '), 1, 'the next run wrote its own event too')
  } finally { await world.close() }
})

test('L5 busy machine: Antigravity and Codex hooks finish under 3 s with 4 CPU-busy processes', async t => {
  const world = makeWorld()
  try {
    // A host's first event installs its hook, which takes seconds by itself, so install both before the load starts.
    assert.equal((await hook(world, 'antigravity', 'PreInvocation', { conversationId: 'agy-warmup-session' })).status, 0)
    assert.equal((await hook(world, 'codex', 'UserPromptSubmit', { session_id: 'codex-warmup-session', prompt: 'Warm up', cwd: world.root })).status, 0)
    const timings = []
    // The start and the end of a turn, for each host.
    const events = [
      ['antigravity', 'PreInvocation', { conversationId: 'agy-busy-session' }],
      ['codex', 'UserPromptSubmit', { session_id: 'codex-busy-session', prompt: 'Review the synthetic routes', cwd: world.root }],
      ['antigravity', 'Stop', { conversationId: 'agy-busy-session' }],
      ['codex', 'Stop', { session_id: 'codex-busy-session', cwd: world.root }],
    ]
    const isSaturated = availableParallelism() <= 4
    // Whether #241 shows depends on the load, so on a saturated Windows machine one lucky fast run
    // must not decide: each event is timed up to 3 times, and the first run at or over the limit
    // settles the verdict. Every timed run is checked against the same limit, so the title stays true.
    const tries = process.platform === 'win32' && isSaturated ? 3 : 1
    let isLate = false
    for (const [host, event, payload] of events) {
      for (let attempt = 1; attempt <= tries && !isLate; attempt++) {
        // The title names 4 busy processes, so load the machine with exactly 4, and only while one hook
        // is timed: this suite runs beside other test files, whose own timing checks must not
        // compete with a load that lasts the whole test. Each process has printed its start line
        // before the clock starts, so the whole hook runs under the load.
        const load = await busyProcesses(world, 4)
        let result, ms
        try {
          const started = performance.now()
          result = await hook(world, host, event, payload)
          ms = performance.now() - started
        } finally { await load.stop() }
        // A hook that crashes or that the driver gave up on (20 s) is a broken hook, not #241:
        // the exit status is checked here, outside the known failure.
        assert.equal(result.status, 0, `${host} ${event}: ${result.stderr}`)
        timings.push({ host, event, ms })
        isLate = ms >= HOOK_TIMEOUT_MS
      }
      // One late event settles the verdict; on a loaded machine each further one costs many seconds.
      if (isLate) break
    }
    const measured = timings.map(each => `${each.host} ${each.event} ${Math.round(each.ms)} ms`).join(', ')
    // Every run prints its timings, so a CI run records them for each system.
    t.diagnostic(`busy-machine hook timings: ${measured}`)
    const check = () => {
      for (const one of timings) {
        assert.ok(one.ms < HOOK_TIMEOUT_MS, `${one.host} ${one.event} hook took ${Math.round(one.ms)} ms; the budget is ${HOOK_TIMEOUT_MS} ms (the host gives up after ${hookTimeout(one.host, one.event)} ms) (${measured})`)
      }
    }
    // #241 was measured on a busy Windows laptop, where the Antigravity hook starts PowerShell. It
    // shows only when the 4 busy processes leave no core free, as on the 4-vCPU runners. Measured
    // with the process held to 4 cores (cmd /c start /b /wait /affinity F): the first Antigravity
    // hook took 2798 to 4550 ms; 7 of 10 runs were at or over 3 s on the first try, and the other 3
    // went over on the second (3088 to 4599 ms), so all 10 ended over the limit. A single try
    // would have been under 3 s in 3 of the 10, which is why a saturated Windows machine times
    // each event up to 3 times. A machine with more cores is not saturated, so it runs the same check without
    // the marker and must pass it, and so must every other system. On 16 cores the hooks stay under
    // 3 s when the machine is quiet, but other test lanes' load made 2 of 6 full-file runs take
    // 4330 and 4572 ms. This test fails on a loaded machine, so run it alone.
    if (process.platform === 'win32' && isSaturated) await knownFailure(241, check)
    else check()
  } finally { await world.close() }
})

// Eight hooks and four writers that follow docs/FORMAT.md ("Concurrent writers"), together.
// Windows refuses a rename onto a file another process has open, so on Windows the writers repeat
// the procedure for a few seconds while the hooks run, which is how the loss was seen (#249).
// The procedure has no lock, so overlapping writers can overwrite each other on any system. The
// other systems therefore run no writer while a hook runs: the hooks go first, then the writers
// one after another, each once, so nothing competes for the file and a lost block there is a bug.
const RACE_WRITERS = ['f0000001', 'f0000002', 'f0000003', 'f0000004']
const RACE_HOOKS = Array.from({ length: 8 }, (_, index) => `codex-race-session-${index + 1}`)
// Returns what was lost or broken, and lets a setup failure (a broken install, a writer that never
// got ready, a driver timeout) throw, so that it can never pass for the known failure.
const raceOnce = async isWindows => {
  const world = makeWorld()
  const problems = []
  try {
    const warmup = 'codex-race-warmup'
    assert.equal((await hook(world, 'codex', 'UserPromptSubmit', { session_id: warmup, prompt: 'Warm up', cwd: world.root })).status, 0)
    const writers = await formatWriters(world, RACE_WRITERS, isWindows ? { rounds: 40, spacingMs: 75 } : { isSequential: true })
    const start = () => RACE_HOOKS.map(session => hook(world, 'codex', 'UserPromptSubmit', { session_id: session, prompt: 'Review the synthetic routes', cwd: world.root }))
    let written, ran
    if (isWindows) {
      writers.go()
      const hooks = start()
      written = await writers.finished()
      ran = await Promise.all(hooks)
    } else {
      ran = await Promise.all(start())
      writers.go()
      written = await writers.finished()
    }
    // A hook that finds the board busy keeps its event and exits 0; the next hook run applies it.
    // Settling runs replay what was kept (a second one only when the first left something), and
    // an event still kept after them was never applied, which is a lost block.
    const sessions = [warmup, ...RACE_HOOKS]
    for (const number of [1, 2]) {
      const settle = `codex-race-settle-${number}`
      sessions.push(settle)
      const settled = await hook(world, 'codex', 'UserPromptSubmit', { session_id: settle, prompt: 'Settle', cwd: world.root })
      if (settled.status !== 0) problems.push(`settling hook exited ${settled.status}: ${settled.stderr.trim()}`)
      if (keptHookEvents(world).length === 0) break
    }
    written.forEach((result, index) => {
      // The writer prints WRITER_READY first; what it says it could not do is the WRITE_FAILED line.
      const failure = result.stdout.split('\n').find(line => line.startsWith('WRITE_FAILED'))
      if (result.status !== 0 || !result.stdout.includes('WRITER_OK')) problems.push(`writer ${RACE_WRITERS[index]} failed: ${failure?.trim() || result.stderr.trim() || result.stdout.trim()}`)
    })
    ran.forEach((result, index) => {
      if (result.status !== 0) problems.push(`hook ${RACE_HOOKS[index]} exited ${result.status}: ${result.stderr.trim()}`)
    })
    const source = world.read('progress.md')
    const kept = keptHookEvents(world)
    for (const session of sessions) {
      const count = occurrences(source, `resume=${session} `)
      if (count === 0 && !kept.includes(session)) problems.push(`hook block lost: ${session}`)
      if (count > 1) problems.push(`hook block doubled: ${session}`)
    }
    for (const session of kept) problems.push(`hook event never applied: ${session} still waits in the pending folder after the settling runs`)
    for (const session of RACE_WRITERS) {
      const count = occurrences(source, `<!-- auto session=${session} `)
      if (count === 0) problems.push(`writer block lost: ${session}`)
      if (count > 1) problems.push(`writer block doubled: ${session}`)
    }
    return problems
  } finally { await world.close() }
}

// What #249 reports: a writer that follows FORMAT.md is refused the rename (EPERM) and gives up
// after three tries, or a block is lost under the concurrent writes. Anything else (a hook that
// exits non-zero, a doubled block) is another failure and must not pass as #249.
const SYMPTOM_249 = /^writer f\d+ failed: WRITE_FAILED .*EPERM|^(?:hook|writer) block lost/

test('L5 concurrent writers: 8 hooks and 4 FORMAT.md writers lose no block on Windows', async () => {
  const isWindows = process.platform === 'win32'
  // The loss on Windows depends on which process holds the file at which moment, so a clean run
  // does not prove it fixed: after a clean first run, two more must be clean before the marker
  // is lifted. A run that loses something ends the loop at once.
  let problems = []
  for (let attempt = 1; attempt <= (isWindows ? 3 : 1) && problems.length === 0; attempt++) problems = await raceOnce(isWindows)
  if (isWindows) {
    for (const problem of problems) assert.match(problem, SYMPTOM_249, `not the #249 failure: ${problem}`)
    await knownFailure(249, () => assert.deepEqual(problems, []))
  } else assert.deepEqual(problems, [])
})

test('L5 future clock: a block dated days ahead is shown as clock-skewed, not working just now', async () => {
  const world = makeWorld()
  try {
    block(world, { session: 'a1000001', title: 'Future dated card', steps: ['- [~] Check the synthetic routes'] })
    skew(world, 'a1000001', 3 * 86400000)
    const server = await serve.start(world)
    const screens = { terminal: (await run(world, [])).stdout, page: await server.page() }
    for (const text of Object.values(screens)) assert.ok(text.includes('Future dated card'))
    // The board has no word for a clock that is off yet: it reads the future time as the newest event.
    await knownFailure('hold:future-clock-skew', () => {
      for (const [surface, text] of Object.entries(screens)) {
        assert.doesNotMatch(text, /working[^\n]*just now/i, `${surface} says a block dated 3 days ahead is working just now`)
        assert.match(text, /clock/i, `${surface} never says the clock is off`)
      }
    })
  } finally { await world.close() }
})

// pageDom (lib/surfaces.mjs) answers /api/board itself and has no document.querySelectorAll, so it
// cannot show a tab whose server has gone. This gives the shipped page script both, inside the
// script only and after its 'use strict': polls go to the real server as a POST the test
// forwards, and the missing selector is answered from the buttons the page drew.
const reachableTab = source => source.replace("'use strict';", () => `'use strict';
  document.querySelectorAll = function (selector) {
    var found = []
    function walk(node) { if (node.tag === 'button') found.push(node); node.childNodes.forEach(walk) }
    ['summary', 'counts', 'status', 'board', 'note', 'main'].forEach(function (id) { walk(document.getElementById(id)) })
    return found.filter(function (node) {
      if (selector.indexOf('data-local') >= 0) return node.getAttribute('data-local') === null
      if (selector.indexOf('data-static') >= 0) return node.getAttribute('data-static') !== null
      return true
    })
  }
  var send = fetch
  fetch = function (target, options) { return target === '/api/board' ? send('/api/poll', { method: 'POST', body: '{}' }) : send(target, options) }`)

test('L5 restarted server: an old page tab disables its buttons and says how to reconnect', async () => {
  const world = makeWorld()
  try {
    block(world, { state: 'waiting', title: 'Publish the gateway', steps: ['- [?] Ship the gateway, OK?'] })
    const first = await serve.start(world)
    const old = new URL(first.url)
    const model = (await first.get('/api/board')).json().model
    const source = (await first.get(old.pathname + old.search)).body
    // The tab talks to the address it was opened from, as a browser does, and fails as a browser does.
    const tab = await pageDom(reachableTab(source), model, async request => {
      const isPoll = request.path === '/api/poll'
      const response = await fetch(new URL(isPoll ? '/api/board' : request.path, old), {
        method: isPoll ? 'GET' : 'POST',
        headers: { 'x-board-token': old.searchParams.get('t'), ...(isPoll ? {} : { 'content-type': 'application/json' }) },
        body: isPoll ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(5000),
      })
      const data = await response.text()
      return { ok: response.status < 400, json: async () => JSON.parse(data) }
    })
    // pageDom waits on every request it saw, so a refused one rejects its flush after the page has handled it.
    const settle = async work => {
      try { await work() } catch {}
      for (let n = 0; n < 3; n++) await new Promise(done => setImmediate(done))
    }
    const wired = () => tab.cards().flatMap(card => tab.buttons(card)).filter(one => one.getAttribute('data-local') === null)
    assert.equal(tab.node('offline').textContent, '')
    assert.ok(wired().length > 0 && wired().every(one => !one.disabled), 'a tab with its server works')

    // The board is restarted: the old server stops and a new one starts on another address and token.
    process.kill(first.pid)
    for (let n = 0; n < 60; n++) {
      try { process.kill(first.pid, 0) } catch { break }
      await pause(50)
    }
    const second = await serve.start(world)
    assert.notEqual(second.url, first.url)

    await settle(() => tab.redraw(model))
    assert.equal(tab.node('offline').textContent, EN.serveOffline)
    assert.deepEqual(wired().filter(one => !one.disabled).map(one => one.textContent), [], 'every button that needs the server is disabled')
    // A press on a disabled button does nothing: no request, and the advice stays.
    const seen = tab.requests.length
    wired()[0].click()
    await settle(() => tab.flush())
    assert.equal(tab.requests.length, seen)
    assert.equal(tab.node('offline').textContent, EN.serveOffline)
  } finally { await world.close() }
})

test('L5 crashed agent: a working row with no event for the host\'s stale time says why it looks stale', async () => {
  const world = makeWorld()
  try {
    block(world, { session: 'a1000001', title: 'Crashed agent card', steps: ['- [~] Check the synthetic routes'] })
    // The agent dies mid-turn and sends no end event; the board waits out the host's stale time, then a little more.
    world.jump(`${STALE_MS / 60000 + 1}m`)
    const server = await serve.start(world)
    const rows = {}
    for (const [surface, text] of Object.entries({ terminal: (await run(world, ['--all'])).stdout, page: await server.page() })) {
      const at = text.indexOf('Crashed agent card')
      assert.ok(at >= 0, `${surface} lost the row:\n${text}`)
      rows[surface] = text.slice(at, at + 300)
      assert.doesNotMatch(rows[surface], /is working/, `${surface} still calls a silent agent working`)
    }
    // The row says what the board knows, that nothing has been heard for this long, not only that it stopped.
    const saysWhy = /\bno (?:event|report|update|word|turn)s?\b|\bsilen|went quiet|quiet for|not heard|without (?:an? )?(?:event|report|update|word)/i
    await knownFailure('hold:crashed-agent-stale-reason', () => {
      for (const [surface, row] of Object.entries(rows)) assert.match(row, saysWhy, `${surface} gives no reason, only: ${row}`)
    })
  } finally { await world.close() }
})

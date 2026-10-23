import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EN } from '../../hooks/strings-en.ts'
import { STALE_MS } from '../../hooks/parse.ts'
import { makeWorld } from './lib/world.mjs'
import { block, hook } from './lib/writers.mjs'
import { formatWriters, keptHookEvents, lockFile, storageFault, tear } from './lib/faults.mjs'
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
// Why a hook run failed: stderr, else stdout. "The command line is too long" means a long %TEMP%:
// the generated hook command (the Antigravity cmd /c one is about 7.8 KB) then passes the 8191
// characters cmd.exe takes, so TEMP must stay under about 84 characters.
const whyFailed = result => {
  const said = result.stderr || result.stdout
  return /too long/i.test(said) ? `${said} (a long TEMP; keep it under about 84 characters)` : said
}

test('L5 torn tail: the terminal, --chat, html view and page each warn once and still show every complete block', async () => {
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

test('L5 torn tail: an append by the Codex hook repairs the tail or reports why, never fails silently', async () => {
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

test('L5 locked file: the Codex hook keeps a locked Stop event, exits 0, and the next run applies it', async t => {
  const world = makeWorld()
  try {
    const session = 'codex-locked-session'
    const first = await hook(world, 'codex', 'UserPromptSubmit', { session_id: session, prompt: 'Review the synthetic routes', cwd: world.root })
    assert.equal(first.status, 0, whyFailed(first))
    const before = world.read('progress.md')
    const lock = await lockFile(world, 'progress.md')
    if (lock.skip) {
      t.skip(lock.skip)
      return
    }
    // The hook may not wait long: the budget is 3 s (Codex gives up on a Stop hook after 10 s). It returns quietly and keeps
    // the event for later instead of failing or writing half a file.
    const stopped = await hook(world, 'codex', 'Stop', { session_id: session, cwd: world.root })
    assert.equal(stopped.status, 0, whyFailed(stopped))
    assert.equal(stopped.stderr.trim(), '')
    // The locked run itself queued the event. The later run below only replays it.
    assert.ok(keptHookEvents(world).includes(session), 'the locked Stop event is kept for the next run')
    await lock.release()
    assert.equal(world.read('progress.md'), before, 'a locked run changes nothing')
    assert.deepEqual(world.files().filter(name => name.endsWith('.tmp')), [], 'no half-written temp file is left')
    // Any later run replays what was kept, oldest first, before its own event.
    const next = await hook(world, 'codex', 'UserPromptSubmit', { session_id: 'codex-locked-next-session', prompt: 'Review the synthetic metrics', cwd: world.root })
    assert.equal(next.status, 0, whyFailed(next))
    const after = world.read('progress.md')
    assert.match(after, new RegExp(`state=waiting [^>]*resume=${session} `), 'the Stop event landed')
    assert.equal(occurrences(after, 'resume=codex-locked-next-session '), 1, 'the next run wrote its own event too')
  } finally { await world.close() }
})

// Eight hooks and four writers that follow docs/FORMAT.md ("Concurrent writers"), together.
// Windows refuses a rename onto a file another process has open, so on Windows the writers repeat
// the procedure for a few seconds while the hooks run, which is how the loss was seen (#249).
// The writers take the native lock the hooks take, so no two of them write at once. The other
// systems never refuse that rename: there the hooks go first, then the writers one after another,
// each once, and a lost block is a bug.
const RACE_WRITERS = ['f0000001', 'f0000002', 'f0000003', 'f0000004']
const RACE_HOOKS = Array.from({ length: 8 }, (_, index) => `codex-race-session-${index + 1}`)
// Returns what was lost or broken, and lets a setup failure (a broken install, a writer that never
// got ready, a driver timeout) throw.
const raceOnce = async isWindows => {
  const world = makeWorld()
  const problems = []
  try {
    const warmup = 'codex-race-warmup'
    const warmed = await hook(world, 'codex', 'UserPromptSubmit', { session_id: warmup, prompt: 'Warm up', cwd: world.root })
    assert.equal(warmed.status, 0, whyFailed(warmed))
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
    // A hook that finds the board busy keeps its event and exits 0. The next hook run applies it.
    // Settling runs replay what was kept (a second one only when the first left something), and
    // an event still kept after them was never applied, which is a lost block.
    const sessions = [warmup, ...RACE_HOOKS]
    for (const number of [1, 2]) {
      const settle = `codex-race-settle-${number}`
      sessions.push(settle)
      const settled = await hook(world, 'codex', 'UserPromptSubmit', { session_id: settle, prompt: 'Settle', cwd: world.root })
      if (settled.status !== 0) problems.push(`settling hook exited ${settled.status}: ${whyFailed(settled).trim()}`)
      if (keptHookEvents(world).length === 0) break
    }
    written.forEach((result, index) => {
      // The writer prints WRITER_READY first. What it says it could not do is the WRITE_FAILED line.
      const failure = result.stdout.split('\n').find(line => line.startsWith('WRITE_FAILED'))
      if (result.status !== 0 || !result.stdout.includes('WRITER_OK')) problems.push(`writer ${RACE_WRITERS[index]} failed: ${failure?.trim() || result.stderr.trim() || result.stdout.trim()}`)
    })
    ran.forEach((result, index) => {
      if (result.status !== 0) problems.push(`hook ${RACE_HOOKS[index]} exited ${result.status}: ${whyFailed(result).trim()}`)
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

// #249: a writer that followed FORMAT.md was refused the rename (EPERM) and gave up after three
// tries, or its block was lost under the concurrent writes, and a hook could lose its block the
// other way round, to a writer that had read the file before the hook wrote and renamed its copy
// over the hook's block. Writers that take the native lock and try a refused rename again (#381)
// lose neither, so any problem fails the journey. While a writer holds the lock no other writer has
// the file open, so the journey does not reach the refused-rename retry; a program outside the board
// holding the file open would.
test('L5 concurrent writers: 8 hooks and 4 FORMAT.md writers lose no block on Windows', async () => {
  const isWindows = process.platform === 'win32'
  // The loss on Windows depended on which process held the file at which moment, so one clean run
  // does not show it gone: up to three runs try to catch it, and a run that loses something ends
  // the loop at once.
  let problems = []
  for (let attempt = 1; attempt <= (isWindows ? 3 : 1) && problems.length === 0; attempt++) problems = await raceOnce(isWindows)
  assert.deepEqual(problems, [])
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

test('L5 restarted server: after a real restart an old page tab disables every button that needs the server and says how to reconnect', async () => {
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
    // stop() closes the server through its own endpoint and waits for the process to go. Only if
    // it stays up does it kill the pid it recorded, after checking the record (a raw kill could hit a reused pid).
    await first.stop()
    const second = await serve.start(world)
    assert.notEqual(second.url, first.url)

    await settle(() => tab.redraw(model))
    assert.equal(tab.node('offline').textContent, EN.serveOffline)
    // The buttons are still drawn (the list is not empty), and not one of them can be pressed.
    assert.ok(wired().length > 0, 'the tab still shows its buttons')
    assert.deepEqual(wired().filter(one => !one.disabled).map(one => one.textContent), [], 'every button that needs the server is disabled')
  } finally { await world.close() }
})

test('L5 OpenCode exit: a row whose end report missed the hook limit reads as stopped after the stale time', async () => {
  const world = makeWorld()
  try {
    const title = 'Synthetic OpenCode exit card'
    block(world, { project: 'synthetic-project', agent: 'opencode', session: 'a1000002', resume: 'synthetic-opencode-exit', state: 'waiting', title, steps: ['- [ ] Synthetic next step'] })
    const server = await serve.start(world)
    const rows = async () => ({ terminal: (await run(world, ['--all'])).stdout, page: await server.page() })
    for (const [surface, text] of Object.entries(await rows())) {
      const at = text.indexOf(title)
      assert.ok(at >= 0, `${surface} lost the row:\n${text}`)
      assert.doesNotMatch(text.slice(at, at + 300), /is working/, `${surface} calls an idle agent working`)
    }
    world.jump(`${STALE_MS / 60000 + 1}m`)
    const saysWhy = EN.sessionStopped(EN.hoursAgo(STALE_MS / 3600000))
    // The server child re-reads the clock file every 100 ms: read the page only once the server's
    // own clock has taken the jump (as l4-time.test.mjs does).
    const poll = async () => {
      const response = await fetch(new URL('/api/board', server.url), { headers: { 'x-board-token': new URL(server.url).searchParams.get('t') }, signal: AbortSignal.timeout(15000) })
      assert.equal(response.status, 200)
      return response.json()
    }
    for (let attempt = 0; Math.abs((await poll()).now - world.now) > 2000; attempt++) {
      assert.ok(attempt < 50, 'The page server never took the clock jump')
      await new Promise(done => setTimeout(done, 100))
    }
    for (const [surface, text] of Object.entries(await rows())) {
      const at = text.indexOf(title)
      assert.ok(at >= 0, `${surface} lost the row:\n${text}`)
      const row = text.slice(at, at + 300)
      assert.doesNotMatch(row, /is working/, `${surface} still calls a silent agent working`)
      assert.ok(row.includes(saysWhy), `${surface} never says "${saysWhy}": ${row}`)
    }
  } finally { await world.close() }
})

test('L5 crashed agent: a working row with no event for the stale time of its host says why it looks stale', async () => {
  const world = makeWorld()
  try {
    block(world, { session: 'a1000001', title: 'Crashed agent card', steps: ['- [~] Check the synthetic routes'] })
    // The agent dies mid-turn and sends no end event. The board waits out the host's stale time, then a little more.
    world.jump(`${STALE_MS / 60000 + 1}m`)
    const server = await serve.start(world)
    const rows = {}
    for (const [surface, text] of Object.entries({ terminal: (await run(world, ['--all'])).stdout, page: await server.page() })) {
      const at = text.indexOf('Crashed agent card')
      assert.ok(at >= 0, `${surface} lost the row:\n${text}`)
      rows[surface] = text.slice(at, at + 300)
      assert.doesNotMatch(rows[surface], /is working/, `${surface} still calls a silent agent working`)
    }
    // The row says what the board knows: the session stopped and when it was last active, with the age.
    // The age is whole hours rounded down, so the extra minute past the stale time still reads as
    // the stale time itself (12 h).
    const saysWhy = EN.sessionStopped(EN.hoursAgo(STALE_MS / 3600000))
    for (const [surface, row] of Object.entries(rows)) assert.ok(row.includes(saysWhy), `${surface} never says "${saysWhy}": ${row}`)
  } finally { await world.close() }
})

// Performance budgets for building the board view and draining the inbox (#192).
// Synthetic fixtures only: the 300-block board comes from tests/fixtures/big-board.mjs
// and the 1,000-record ledger and 50 inbox files are built here from made-up ids, words
// and paths. No network, no clock or platform input, no model call anywhere in this file.
//
// Scope boundary, from the maintainer's Answer on #192 (2026-10-28): this file covers
// the pure paths only — buildView over parsed projects plus a ledger, and the pure
// peekInbox/turnsFor drain. The engine's per-poll inbox cap (pendingTurns reads at most
// 30 files) and the model call that precedes question detection in hooks/register.tsx
// are engine behavior changes reserved to a plugin-capable lane; nothing here changes
// them or claims the engine acceptance. The budgets themselves live in one constants
// file, tests/e2e/lib/budget.ts, so raising a number is a reviewed change, not drift.
//
// Counting note: the view test checks the saving by count, not by time — how many
// ledger records the per-view indexes visit while building, how many lookups they
// answer, and how many per-task answers the memos reuse. A wall-clock median is
// flaky on any loaded runner, CI included, so the millisecond measurement lives
// behind AGENT_BOARD_HEAVY_TESTS=1, printed and never asserted; anywhere else the
// suite reports it as not run here. The budget is the issue's 50 ms; it is not
// loosened here.

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BLOCKS, BUILD_VIEW_MS, INBOX_DRAIN_TURNS, LEDGER_RECORDS, LIVE_SESSIONS } from './e2e/lib/budget.mjs'

// The board modules use extensionless imports; resolve only those local paths, as
// tests/messaging.test.mjs does.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })

const { bigBoard, bigBoardNow } = await import('./fixtures/big-board.mjs')
const { parseProgress } = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { emptyQuestions, questionScope, questionWords } = await import('../hooks/questions.ts')
const { peekInbox, turnsFor } = await import('../hooks/board.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// The scale board: 50 projects, 300 blocks, 100 of them live, plus a 1,000-record
// ledger whose records match the board's real scopes and question words, so observe
// does the matching work a real board does instead of skipping it. Returns the parsed
// projects (the parse itself is timed separately, below) and the ledger.
const scaleBoard = () => {
  const parseStart = performance.now()
  const projects = parseProgress(bigBoard())
  const parseMs = performance.now() - parseStart
  const tasks = projects.flatMap(project => project.tasks.map(task => ({ project: project.name, task })))
  const live = tasks.filter(({ task }) => task.auto?.state === 'working')
  const waiting = tasks.flatMap(({ task }) => task.steps.filter(step => step.status === 'waiting'))
  assert.equal(tasks.length, BLOCKS, `the fixture must hold ${BLOCKS} blocks`)
  assert.equal(live.length, LIVE_SESSIONS, `the fixture must hold ${LIVE_SESSIONS} live blocks`)
  const ledger = emptyQuestions()
  for (let index = 0; index < LEDGER_RECORDS; index++) {
    const pick = tasks[index % tasks.length]
    const auto = pick.task.auto
    ledger.records.push({
      id: `q${index}`,
      scope: questionScope(pick.project, auto?.agent ?? 'claude', auto?.session ?? `session-${index}`),
      words: questionWords(waiting[index % waiting.length]?.text ?? `Synthetic question ${index}?`),
      occurrence: 1,
      copies: 1,
      isWaiting: true,
      isPresent: true,
      firstObserved: bigBoardNow - 1000,
      incarnation: 'performance-budgets',
      isUnresolved: true,
    })
  }
  ledger.next = LEDGER_RECORDS + 1
  assert.equal(ledger.records.length, LEDGER_RECORDS, `the ledger must hold ${LEDGER_RECORDS} records`)
  return { projects, ledger, parseMs }
}

// Fifty queued turns: alternating questions and plain statements, each its own
// session, in the file names the inbox reader accepts.
const drainFiles = () => Array.from({ length: INBOX_DRAIN_TURNS }, (_, index) => {
  const isQuestion = index % 2 === 0
  return {
    name: `claude-turn-${1700000000 + index}-1.json`,
    body: JSON.stringify({
      session_id: `sess-${index}`,
      cwd: '/home/synthetic/app',
      last_assistant_message: isQuestion
        ? `Done step ${index}. Should we keep plan ${index}?`
        : `Finished step ${index}, nothing to ask.`,
    }),
    at: 1700000000000 + index * 1000,
  }
})

// The millisecond measurement lives behind AGENT_BOARD_HEAVY_TESTS=1: a wall-clock
// median is flaky on any loaded runner, CI included, so it is printed and never
// asserted.
const isHeavyRun = process.env.AGENT_BOARD_HEAVY_TESTS === '1'

test('building the view answers its ledger lookups from the indexes instead of rescanning the ledger', () => {
  const { projects, ledger } = scaleBoard()
  const counts = { indexRecords: 0, indexLookups: 0, memoReused: 0 }
  // Trailing positions: frozen, observe, staleMs, then the counts object the build
  // fills in; undefined keeps the observe and staleness defaults.
  const args = [projects, [], null, bigBoardNow, 0, {}, ZH_TW, [], {}, ledger, { retired: [], consumed: [] }, [], new Set(), undefined, undefined, counts]
  const view = buildView(...args)
  assert.ok(view.waiting.length > 0, 'the counted view must carry waiting questions')
  // The indexes are load-bearing: at least one answered lookup per block.
  assert.ok(counts.indexLookups >= BLOCKS, `the indexes must answer at least one lookup per block, got ${counts.indexLookups} for ${BLOCKS} blocks`)
  // Building them is a constant number of linear passes: the observed ledger holds
  // the input records plus the ones observe adds for uncovered steps, so one pass
  // can visit more than LEDGER_RECORDS records, but never many.
  assert.ok(counts.indexRecords <= 3 * LEDGER_RECORDS, `building the indexes must stay a few linear passes, visited ${counts.indexRecords} records for a ${LEDGER_RECORDS}-record ledger`)
  // The per-task memos reuse answers instead of recomputing them per scan.
  assert.ok(counts.memoReused >= BLOCKS, `the memos must reuse at least one answer per block, reused ${counts.memoReused} for ${BLOCKS} blocks`)
  // The saving, in counts: without the indexes each answered lookup rescans up to
  // LEDGER_RECORDS records, so even one scan per block would already cost more
  // record visits than the whole indexed build.
  assert.ok(counts.indexRecords + counts.indexLookups < BLOCKS * LEDGER_RECORDS, `the indexed build must examine fewer records than one scan per block: ${counts.indexRecords} indexed + ${counts.indexLookups} probes, against ${BLOCKS * LEDGER_RECORDS}`)
  console.log(`view counts: ${counts.indexRecords} records indexed, ${counts.indexLookups} indexed lookups, ${counts.memoReused} memo reuses; without the indexes those lookups could rescan up to ${counts.indexLookups * LEDGER_RECORDS} records`)
})

test('building the view of a 300-block file prints its milliseconds without asserting them', { skip: isHeavyRun ? false : 'the millisecond measurement is printed, not asserted; run with AGENT_BOARD_HEAVY_TESTS=1' }, () => {
  const { projects, ledger, parseMs } = scaleBoard()
  const args = [projects, [], null, bigBoardNow, 0, {}, ZH_TW, [], {}, ledger, { retired: [], consumed: [] }, [], new Set()]
  // Warmup first: the first calls compile the view/question modules, which is not
  // the cost the budget guards.
  buildView(...args)
  buildView(...args)
  const runs = []
  for (let run = 0; run < 5; run++) {
    const start = performance.now()
    const view = buildView(...args)
    runs.push(performance.now() - start)
    assert.ok(view.waiting.length > 0, 'the timed view must carry waiting questions')
  }
  const measured = median(runs)
  console.log(`buildView (heavy only, not asserted): parse ${parseMs.toFixed(1)} ms; timed runs ${runs.map(ms => ms.toFixed(1)).join(', ')} ms; median ${measured.toFixed(1)} ms; budget ${BUILD_VIEW_MS} ms`)
})

test('draining 50 queued turns takes one tick and no model call', async () => {
  const files = drainFiles()
  assert.equal(files.length, INBOX_DRAIN_TURNS, `the drain must queue ${INBOX_DRAIN_TURNS} turns`)
  const start = performance.now()
  // One synchronous call: peekInbox takes no model or engine argument, so there is
  // no model call to make — a result that is not a promise proves the pass did not
  // wait on one. The question/non-question split is the detection the drain exists for.
  const turns = peekInbox(files, undefined, undefined, ZH_TW)
  const drainMs = performance.now() - start
  assert.ok(!(turns instanceof Promise), 'the drain must finish in one synchronous pass')
  assert.equal(turns.length, INBOX_DRAIN_TURNS, 'the drain must return every queued turn')
  assert.equal(turns.filter(turn => turn.isQuestion).length, INBOX_DRAIN_TURNS / 2, 'every other queued turn must read as a question')
  assert.equal(turns.filter(turn => !turn.isQuestion).length, INBOX_DRAIN_TURNS / 2, 'the other half must read as plain statements')
  assert.ok(turns.every(turn => turn.text !== ''), 'every drained turn must carry text')
  assert.ok(turns.filter(turn => turn.isQuestion).every(turn => turn.session !== undefined && turn.session !== ''), 'every drained question must carry its session')
  assert.ok(turns.every(turn => turn.agent !== '' && turn.project !== ''), 'every drained turn must carry its agent and project')

  // The cached wrapper must likewise read the queue in one pass: fresh() runs once.
  let freshCalls = 0
  const { turns: cached, cache } = await turnsFor(null, ['performance-budgets', ZH_TW.lang], ZH_TW, async () => {
    freshCalls += 1
    return { files, scrub: text => text, isComplete: true }
  })
  assert.equal(freshCalls, 1, 'turnsFor must read the queue exactly once')
  assert.equal(cached.length, INBOX_DRAIN_TURNS, 'the cached drain must return every queued turn')
  assert.ok(cache !== null, 'a complete drain must fill the cache')
  console.log(`drain: peekInbox ${drainMs.toFixed(1)} ms for ${INBOX_DRAIN_TURNS} turns in one call (no time budget is stated for the drain)`)
})

const { serveModel, servePage } = await import('../hooks/serve.ts')
const { STRINGS } = await import('../hooks/strings.ts')
const { pageDom } = await import('./e2e/lib/surfaces.mjs')
const pressWalk = node => [node, ...node.childNodes.flatMap(pressWalk)]

test('the page shows Needs you within 5 s on a 600 KB board (#862)', async () => {
  const now = Date.parse('2026-11-05T12:00:00Z')
  let content = `## Project\n<!-- auto session=urgent1 agent=codex state=waiting updated=${new Date(now).toISOString()} -->\n### Urgent question needing you\n- [?] Which database should we use?\n<!-- /auto session=urgent1 -->\n\n`
  let n = 0
  while (Buffer.byteLength(content, 'utf8') < 600 * 1024) {
    n++
    const time = new Date(now - n * 3600000).toISOString()
    content += `<!-- auto session=done${n} agent=claude state=done updated=${time} -->\n### Historical Task ${n} with a fairly typical description\n- [x] Initial research for feature ${n}\n- [x] Implementation phase for feature ${n}\n- [x] Test coverage verification for feature ${n}\n- [x] Code review and merge\n<!-- /auto session=done${n} -->\n\n`
  }
  const started = performance.now()
  const view = buildView(parseProgress(content), [], null, now, 0, {}, STRINGS.en)
  const group = { now, repoOf: () => null, versions: { board: '1.0.0', package: null }, unreadable: [] }
  const model = JSON.parse(JSON.stringify(serveModel(view, [], STRINGS.en, new Set(), false, undefined, false, group)))
  const html = servePage(STRINGS.en, 'synthetic')
  const dom = await pageDom(html, model)
  const elapsed = performance.now() - started
  assert.ok(elapsed < 5000, `the page must show Needs you within 5 s on a 600 KB board (took ${elapsed.toFixed(1)} ms)`)
  const cards = pressWalk(dom.node('board')).filter(node => node.tag === 'article' && String(node.className).split(' ').includes('card'))
  assert.ok(cards.some(card => card.textContent.includes('Which database should we use?')), 'Needs you must show the waiting question')
})


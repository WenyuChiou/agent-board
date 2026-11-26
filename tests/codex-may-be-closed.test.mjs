import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(specifier + '.ts', context)
  }
} })

// A Codex card with no process record (#1092, M7): Windows and the shared server
// give the board no process to check, and SessionEnd came 61 s after a close in
// the C1 check. Past two quiet minutes the card says the window may be closed and
// offers Archive; it stays in Needs you and the count, and never says closed.
const parse = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { takeTask } = await import('../hooks/blocks.ts')
const { STRINGS } = await import('../hooks/strings.ts')
const { boardDocument } = await import('../hooks/board-json.ts')
const { boardItems, boardKey, boardScreen, emptyBoardState, pinned } = await import('../hooks/board.ts')

const NOW = Date.parse('2026-11-19T12:00:00Z')
const SECOND = 1000
const ASK = 'Deploy the synthetic build, OK?'
const block = ({ id = 'c0d1e2f3', agent = 'codex', state = 'waiting', ago, steps = `- [x] Build\n- [?] ${ASK}`, claim = '' }) =>
  `## demo\n<!-- auto session=${id} agent=${agent} state=${state} updated=${new Date(NOW - ago).toISOString()}${claim} -->\n### Ship it\n${steps}\n<!-- /auto session=${id} -->\n`
const viewOf = text => buildView(parse.parseProgress(text), [], null, NOW, 0, {}, STRINGS.en)
const cardOf = view => view.waiting.find(one => one.text.includes('Deploy the synthetic build'))

const MAY_BE_CLOSED_MS = 30 * 60 * SECOND

test('the may-be-closed threshold waits 30 minutes so open idle Codex windows do not warn at 2 minutes', () => {
  assert.equal(parse.CODEX_MAY_BE_CLOSED_MS, MAY_BE_CLOSED_MS)
})

test('a Codex card with no process record says the window may be closed only past 30 quiet minutes', () => {
  for (const ago of [119 * SECOND, 120 * SECOND, 3 * 60 * SECOND, 29 * 60 * SECOND, MAY_BE_CLOSED_MS]) {
    const view = viewOf(block({ ago }))
    const card = cardOf(view)
    assert.ok(card, `card at ${ago} ms`)
    assert.equal(card.mayBeClosed, undefined, `no line at ${ago} ms`)
    assert.equal(card.archive, undefined, `no archive at ${ago} ms`)
  }
  const view = viewOf(block({ ago: MAY_BE_CLOSED_MS + SECOND }))
  const card = cardOf(view)
  assert.ok(card, 'the card stays in Needs you')
  assert.equal(card.mayBeClosed, true)
  assert.equal(view.overview.waiting, 1, 'the card still counts')
  // The task is drawn as this card alone (a waiting task with a question has no row), so the card carries Archive.
  assert.deepEqual(card.archive, { project: 'demo', title: 'Ship it', line: 2, session: 'c0d1e2f3' }, 'Archive is offered')
  assert.equal(card.target?.isClosed, false, 'the card does not read as closed')
})

test('no line for a working Codex block, a waiting one with no question, a future time, another agent, or a block with a process record', () => {
  const ago = 31 * 60 * SECOND
  const host = 'd'.repeat(64)
  // The same quiet waiting Codex block with nothing taken away does say it: each case below differs in one thing.
  assert.equal(cardOf(viewOf(block({ ago })))?.mayBeClosed, true, 'control')
  const cases = {
    working: block({ ago, state: 'working', steps: '- [~] Build' }),
    noQuestion: block({ ago, steps: '- [x] Build\n- [ ] Wait for the next instruction' }),
    future: block({ ago: -10 * 60 * SECOND }),
    grok: block({ ago, agent: 'grok' }),
    claude: block({ ago, agent: 'claude' }),
    // A live record (or one from another machine) is a signal: the process check decides, not the clock.
    claimed: block({ ago, claim: ` agentpid=${process.pid} agentstarted=${Math.round(performance.timeOrigin)} host=${host}` }),
  }
  for (const [name, text] of Object.entries(cases)) {
    const view = viewOf(text)
    assert.equal(cardOf(view)?.mayBeClosed, undefined, name)
    assert.equal(cardOf(view)?.archive, undefined, name)
  }
})

test('Archive on a may-be-closed card goes through, keeps nothing sent, and is refused before 30 minutes', () => {
  const ref = { project: 'demo', title: 'Ship it', line: 2, session: 'c0d1e2f3' }
  assert.equal(takeTask(block({ ago: MAY_BE_CLOSED_MS - SECOND }), ref, NOW, STRINGS.en), null)
  const archived = takeTask(block({ ago: MAY_BE_CLOSED_MS + SECOND }), ref, NOW, STRINGS.en)
  assert.ok(archived, 'archive goes through past 30 minutes')
  assert.ok(!archived.text.includes('c0d1e2f3'), 'the block left progress.md')
  assert.ok(archived.entries.join('\n').includes(ASK), 'the question goes to the archive with its block')
  // A working Codex block quiet for 30+ minutes is not offered this way.
  assert.equal(takeTask(block({ ago: MAY_BE_CLOSED_MS + SECOND, state: 'working', steps: `- [~] ${ASK}` }), ref, NOW, STRINGS.en), null)
})

test('--json says may be closed as a flag only, with no process identity', () => {
  const view = viewOf(block({ ago: MAY_BE_CLOSED_MS + SECOND }))
  const document = boardDocument(view, [], [], STRINGS.en, '/synthetic-home', false, NOW, { now: NOW, repoOf: () => null, versions: { board: '0.0.0', package: null }, unreadable: [] })
  const need = document.needs.find(one => one.kind === 'question')
  assert.ok(need)
  assert.equal(need.mayBeClosed, true)
  const quiet = viewOf(block({ ago: 3 * 60 * SECOND }))
  assert.equal(boardDocument(quiet, [], [], STRINGS.en, '/synthetic-home', false, NOW, { now: NOW, repoOf: () => null, versions: { board: '0.0.0', package: null }, unreadable: [] }).needs.find(one => one.kind === 'question').mayBeClosed, false)
})

test('every string table says the window may be closed, and none says it closed', () => {
  for (const [lang, table] of Object.entries(STRINGS)) {
    assert.equal(typeof table.windowMayBeClosed, 'string', lang)
    assert.ok(table.windowMayBeClosed.length > 0, lang)
  }
  assert.equal(STRINGS.en.windowMayBeClosed, 'The window may be closed.')
  assert.match(STRINGS['zh-CN'].windowMayBeClosed, /可能/)
  assert.match(STRINGS['zh-TW'].windowMayBeClosed, /可能/)
})

test('on the terminal board, a archives a may-be-closed card and says the live answer otherwise', () => {
  const ref = { project: 'demo', title: 'Ship it', line: 2, session: 'c0d1e2f3' }
  const pressA = ago => {
    const view = viewOf(block({ ago }))
    const items = boardItems(view, [])
    const at = items.findIndex(item => item.type === 'ask')
    return boardKey(pinned({ ...emptyBoardState, selected: at }, items), 'a', items, STRINGS.en)
  }
  assert.deepEqual(pressA(MAY_BE_CLOSED_MS + SECOND).action, { type: 'archive', ref, title: 'Ship it' })
  const early = pressA(3 * 60 * SECOND)
  assert.equal(early.action, null)
  assert.equal(early.state.note, STRINGS.en.archiveLive)
})

test('on the terminal board, a may-be-closed card\'s footer lists the archive key, and a younger card\'s does not (review of #1731)', () => {
  const footer = ago => {
    const view = viewOf(block({ ago }))
    const items = boardItems(view, [])
    const at = items.findIndex(item => item.type === 'ask')
    return boardScreen(view, [], pinned({ ...emptyBoardState, selected: at }, items), STRINGS.en, { width: 120, isColor: false })
  }
  assert.ok(footer(MAY_BE_CLOSED_MS + SECOND).includes(STRINGS.en.boardKeyArchive), footer(MAY_BE_CLOSED_MS + SECOND))
  assert.ok(!footer(3 * 60 * SECOND).includes(STRINGS.en.boardKeyArchive), footer(3 * 60 * SECOND))
})

test('a resume SessionStart that waited in the pending queue keeps the new window\'s process when a later hook applies it (review of #1731)', async () => {
  const { codexClaimOf, seenClaimOf } = await import('../hooks/codex.ts')
  const host = 'e'.repeat(64)
  const old = { pid: 11, started: 1000, host }
  const fresh = { pid: 22, started: 2000, host }
  // The queue writes the event as JSON and a later hook reads it back.
  const stored = JSON.parse(JSON.stringify({ version: 1, payload: { hook_event_name: 'SessionStart' }, seenClaim: fresh }))
  assert.deepEqual(codexClaimOf({ event: stored.payload.hook_event_name, seen: seenClaimOf(stored.seenClaim), named: old }), fresh)
  // The same event whose walk found nothing clears the old window's process; a raw event the board script never ran for too.
  assert.equal(codexClaimOf({ event: 'SessionStart', seen: seenClaimOf(JSON.parse(JSON.stringify({ seenClaim: null })).seenClaim), named: old }), null)
  assert.equal(codexClaimOf({ event: 'UserPromptSubmit', seen: seenClaimOf(undefined), named: old }), null)
  // A tampered record is none.
  assert.equal(seenClaimOf({ pid: -1, host }), null)
  assert.equal(seenClaimOf('22'), null)
  // A Stop after the resume keeps the record the resume wrote.
  assert.deepEqual(codexClaimOf({ event: 'Stop', seen: undefined, named: fresh }), fresh)
})

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

const NOW = Date.parse('2026-11-19T12:00:00Z')
const SECOND = 1000
const ASK = 'Deploy the synthetic build, OK?'
const block = ({ id = 'c0d1e2f3', agent = 'codex', state = 'waiting', ago, steps = `- [x] Build\n- [?] ${ASK}`, claim = '' }) =>
  `## demo\n<!-- auto session=${id} agent=${agent} state=${state} updated=${new Date(NOW - ago).toISOString()}${claim} -->\n### Ship it\n${steps}\n<!-- /auto session=${id} -->\n`
const viewOf = text => buildView(parse.parseProgress(text), [], null, NOW, 0, {}, STRINGS.en)
const cardOf = view => view.waiting.find(one => one.text.includes('Deploy the synthetic build'))

test('the two-minute line is a named constant above the 61 s SessionEnd lag', () => {
  assert.equal(parse.CODEX_MAY_BE_CLOSED_MS, 120 * SECOND)
})

test('a Codex card with no process record says the window may be closed only past two quiet minutes', () => {
  for (const ago of [119 * SECOND, 120 * SECOND]) {
    const view = viewOf(block({ ago }))
    const card = cardOf(view)
    assert.ok(card, `card at ${ago} ms`)
    assert.equal(card.mayBeClosed, undefined, `no line at ${ago} ms`)
    assert.equal(card.archive, undefined, `no archive at ${ago} ms`)
  }
  const view = viewOf(block({ ago: 121 * SECOND }))
  const card = cardOf(view)
  assert.ok(card, 'the card stays in Needs you')
  assert.equal(card.mayBeClosed, true)
  assert.equal(view.overview.waiting, 1, 'the card still counts')
  // The task is drawn as this card alone (a waiting task with a question has no row), so the card carries Archive.
  assert.deepEqual(card.archive, { project: 'demo', title: 'Ship it', line: 2, session: 'c0d1e2f3' }, 'Archive is offered')
  assert.equal(card.target?.isClosed, false, 'the card does not read as closed')
})

test('no line for a working Codex block, a waiting one with no question, a future time, another agent, or a block with a process record', () => {
  const ago = 30 * 60 * SECOND
  const host = 'd'.repeat(64)
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

test('Archive on a may-be-closed card goes through, keeps nothing sent, and is refused before the two minutes', () => {
  const ref = { project: 'demo', title: 'Ship it', line: 2, session: 'c0d1e2f3' }
  assert.equal(takeTask(block({ ago: 119 * SECOND }), ref, NOW, STRINGS.en), null)
  const archived = takeTask(block({ ago: 121 * SECOND }), ref, NOW, STRINGS.en)
  assert.ok(archived, 'archive goes through past two minutes')
  assert.ok(!archived.text.includes('c0d1e2f3'), 'the block left progress.md')
  assert.ok(archived.entries.join('\n').includes(ASK), 'the question goes to the archive with its block')
  // A working Codex block quiet for two minutes is not offered this way.
  assert.equal(takeTask(block({ ago: 121 * SECOND, state: 'working', steps: `- [~] ${ASK}` }), ref, NOW, STRINGS.en), null)
})

test('--json says may be closed as a flag only, with no process identity', () => {
  const view = viewOf(block({ ago: 121 * SECOND }))
  const document = boardDocument(view, [], [], STRINGS.en, '/synthetic-home', false, NOW, { now: NOW, repoOf: () => null, versions: { board: '0.0.0', package: null }, unreadable: [] })
  const need = document.needs.find(one => one.kind === 'question')
  assert.ok(need)
  assert.equal(need.mayBeClosed, true)
  const quiet = viewOf(block({ ago: 60 * SECOND }))
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

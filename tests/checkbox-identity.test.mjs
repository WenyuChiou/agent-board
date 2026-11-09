import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
let boardItems, boardKey, emptyBoardState, pinned, buildView, parseProgress, serveAction, serveModel, setManualStep, EN, ZH_TW, ZH_CN
try {
  ;({ boardItems, boardKey, emptyBoardState, pinned } = await import('../hooks/board.ts'))
  ;({ buildView } = await import('../hooks/view.ts'))
  ;({ parseProgress } = await import('../hooks/parse.ts'))
  ;({ serveAction, serveModel } = await import('../hooks/serve.ts'))
  ;({ setManualStep } = await import('../hooks/blocks.ts'))
  ;({ EN } = await import('../hooks/strings-en.ts'))
  ;({ ZH_TW } = await import('../hooks/i18n.ts'))
  ;({ ZH_CN } = await import('../hooks/strings-zh-cn.ts'))
} finally { loader.deregister() }

const now = Date.parse('2026-11-09T06:00:00Z')
const source = `## Synthetic project
### Earlier card
- [ ] Check the sample
### Twin steps
- [ ] Inspect the map
- [ ] Inspect the map
`
const draw = text => {
  const view = buildView(parseProgress(text), [], null, now, 0, {}, EN)
  const items = boardItems(view, [], true)
  const row = serveModel(view, [], EN).groups.flatMap(group => group.rows).find(row => row.title === 'Twin steps')
  assert.ok(row)
  return { items, row }
}
const request = (row, step = 1) => ({ key: row.key, type: 'tick', text: row.steps[step].text, session: '', line: row.steps[step].fileLine, fp: row.tickFp ?? row.fp })

test('a checkbox press cannot tick its identical sibling after another card shifts its file lines', () => {
  const before = draw(source)
  const shifted = source.replace('### Twin steps', '> Synthetic extra context\n### Twin steps')
  const action = serveAction(draw(shifted).items, request(before.row), EN)
  const result = action.type === 'tick' ? setManualStep(shifted, action.ref, 'x', now) : shifted
  assert.equal(result.split('\n').filter(line => line.startsWith('- [x]')).length, 0, 'a stale twin press must refuse rather than write the sibling')
  assert.equal(action.type, 'refuse')
  assert.equal(result, shifted)
})

test('fresh checkbox presses still tick the second twin and then the first', () => {
  let text = source
  const first = draw(text)
  const secondAction = serveAction(first.items, request(first.row), EN)
  assert.equal(secondAction.type, 'tick')
  text = setManualStep(text, secondAction.ref, 'x', now)
  const second = draw(text)
  const firstStep = second.row.steps.findIndex(step => step.status !== 'done')
  const firstAction = serveAction(second.items, request(second.row, firstStep), EN)
  assert.equal(firstAction.type, 'tick')
  text = setManualStep(text, firstAction.ref, 'x', now)
  assert.equal(text.split('\n').filter(line => line.startsWith('- [x] Inspect the map')).length, 2)
})

test('a card action still works when only another card moves its lines', () => {
  const before = draw(source)
  const shifted = draw(source.replace('### Twin steps', '> Synthetic extra context\n### Twin steps'))
  assert.equal(before.row.fp, shifted.row.fp)
  const action = serveAction(shifted.items, { key: before.row.key, type: 'archive', text: '', session: '', fp: before.row.fp }, EN)
  assert.equal(action.type, 'archive')
})

test('a line-specific checkbox press without its drawn line fingerprint asks for a refresh', () => {
  const before = draw(source)
  const action = serveAction(before.items, { ...request(before.row), fp: before.row.fp }, EN)
  assert.equal(action.type, 'refuse')
  assert.equal(action.note, EN.boardLineChanged)
})

test('a validated checkbox follows its original twin when the file moves before writing', () => {
  const before = draw(source)
  const action = serveAction(before.items, request(before.row), EN)
  assert.equal(action.type, 'tick')
  const shifted = source.replace('### Twin steps', '> Synthetic extra context\n### Twin steps')
  const result = setManualStep(shifted, action.ref, 'x', now, EN)
  const row = draw(shifted).row
  const lines = result.split('\n')
  assert.equal(lines[row.steps[0].fileLine], '- [ ] Inspect the map')
  assert.match(lines[row.steps[1].fileLine], /^- \[x\] Inspect the map/)
})

test('a validated checkbox refuses a replaced task even when its steps keep the same words', () => {
  const before = draw(source)
  const action = serveAction(before.items, request(before.row), EN)
  assert.equal(action.type, 'tick')
  const replaced = source.replace('### Twin steps', '### Replacement task')
  assert.equal(setManualStep(replaced, action.ref, 'x', now, EN), replaced)
})

test('the terminal tick follows its original first twin after an earlier line is removed', () => {
  const before = draw(source)
  const state = pinned({ ...emptyBoardState, key: before.row.key }, before.items)
  const action = boardKey(state, 'x', before.items, EN).action
  assert.equal(action.type, 'tick')
  const shifted = source.replace('- [ ] Check the sample\n', '')
  const result = setManualStep(shifted, action.ref, 'x', now, EN)
  const row = draw(shifted).row
  const lines = result.split('\n')
  assert.match(lines[row.steps[0].fileLine], /^- \[x\] Inspect the map/)
  assert.equal(lines[row.steps[1].fileLine], '- [ ] Inspect the map')
})

test('guarded checkboxes keep unnamed projects addressable in all three languages', () => {
  const text = '### Twin steps\n- [ ] Inspect the map\n- [ ] Inspect the map\n'
  for (const words of [EN, ZH_TW, ZH_CN]) {
    const view = buildView(parseProgress(text), [], null, now, 0, {}, words)
    const items = boardItems(view, [], true)
    const row = serveModel(view, [], words).groups.flatMap(group => group.rows).find(row => row.title === 'Twin steps')
    assert.ok(row)
    const action = serveAction(items, request(row), words)
    assert.equal(action.type, 'tick')
    const result = setManualStep(text, action.ref, 'x', now, words)
    assert.equal(result.split('\n')[row.steps[0].fileLine], '- [ ] Inspect the map')
    assert.match(result.split('\n')[row.steps[1].fileLine], /^- \[x\] Inspect the map/)
  }
})

const identicalCards = '## Synthetic project\n' + '### Twin steps\n- [ ] Inspect the map\n- [ ] Inspect the map\n'.repeat(2)
const drawIdenticalCards = () => {
  const view = buildView(parseProgress(identicalCards), [], null, now, 0, {}, EN)
  return { items: boardItems(view, [], true), rows: serveModel(view, [], EN).groups.flatMap(group => group.rows) }
}

test('a fresh guarded checkbox still selects the second of two identical task cards', () => {
  const { items, rows } = drawIdenticalCards()
  const action = serveAction(items, request(rows[1]), EN)
  assert.equal(action.type, 'tick')
  const result = setManualStep(identicalCards, action.ref, 'x', now, EN).split('\n')
  for (const step of rows[0].steps) assert.equal(result[step.fileLine], '- [ ] Inspect the map')
  assert.equal(result[rows[1].steps[0].fileLine], '- [ ] Inspect the map')
  assert.match(result[rows[1].steps[1].fileLine], /^- \[x\] Inspect the map/)
})

test('a guarded checkbox refuses when an identical task card moves into its old position', () => {
  const { items, rows } = drawIdenticalCards()
  const action = serveAction(items, request(rows[1]), EN)
  assert.equal(action.type, 'tick')
  const shifted = identicalCards.replace('### Twin steps', '\n\n\n### Twin steps')
  assert.equal(shifted.split('\n')[action.ref.guard.task.line], '### Twin steps', 'the other identical card now occupies the old task line')
  assert.equal(setManualStep(shifted, action.ref, 'x', now, EN), shifted, 'ambiguous task movement must not tick the other card')
})

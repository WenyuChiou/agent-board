import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
let boardItems, buildView, parseProgress, serveAction, serveModel, setManualStep, EN
try {
  ;({ boardItems } = await import('../hooks/board.ts'))
  ;({ buildView } = await import('../hooks/view.ts'))
  ;({ parseProgress } = await import('../hooks/parse.ts'))
  ;({ serveAction, serveModel } = await import('../hooks/serve.ts'))
  ;({ setManualStep } = await import('../hooks/blocks.ts'))
  ;({ EN } = await import('../hooks/strings-en.ts'))
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

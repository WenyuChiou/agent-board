// Row key disambiguation (#940).
//
// A row's key is `project::title`, with `#2`, `#3`, … disambiguation added for repeated titles.
// When a task title literally contains `#2` (or any suffix that collides with an assigned repeated key),
// each task must receive a globally unique row key so that:
// 1. All rows appear on both the terminal board and the web page.
// 2. No row is hidden or dropped by group deduplication or finished-asking filters (#883).
// 3. Each button or key press acts strictly on its own task.
// Synthetic data only: no network, no clock or platform input.

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(new URL(`${specifier}.ts`, context.parentURL).href, context)
  }
} })

const { parseProgress } = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { boardItems, boardKey, emptyBoardState, pinned } = await import('../hooks/board.ts')
const { serveModel, serveAction } = await import('../hooks/serve.ts')
const { EN } = await import('../hooks/strings-en.ts')

const NOW = Date.parse('2026-11-05T12:00:00Z')

test('a task titled Release#2 next to two tasks titled Release gives three rows on the terminal board and the page, and each press acts on its own task (#940)', () => {
  const file = `## Demo
### Release
- [ ] Step 1A

### Release
- [ ] Step 1B

### Release#2
- [ ] Step 2
`
  const view = buildView(parseProgress(file), [], null, NOW, 0, {}, EN)

  // 1. Build view must assign unique keys to all rows
  const groupRows = view.groups.flatMap(g => g.rows)
  assert.equal(groupRows.length, 3)
  const keys = new Set(groupRows.map(r => r.key))
  assert.equal(keys.size, 3, 'all row keys in view must be distinct')

  // 2. Terminal board items gives 3 rows
  const items = boardItems(view, [])
  const itemRows = items.filter(item => item.type === 'row')
  assert.equal(itemRows.length, 3, 'terminal board must show all 3 rows')
  const itemKeys = new Set(itemRows.map(item => item.key))
  assert.equal(itemKeys.size, 3, 'all item row keys must be distinct')

  // Terminal board press 'x' (tick) on each row acts on its own task
  for (let i = 0; i < itemRows.length; i++) {
    const item = itemRows[i]
    const state = pinned({ ...emptyBoardState, selected: items.indexOf(item) }, items)
    const pressed = boardKey(state, 'x', items, EN)
    assert.equal(pressed.action?.type, 'tick')
    assert.equal(pressed.action?.ref?.title, item.row.title)
    assert.equal(pressed.action?.ref?.step, item.row.next?.step)
  }

  // 3. Page model gives 3 rows
  const model = serveModel(view, [], EN)
  const pageRows = model.groups.flatMap(g => g.rows)
  assert.equal(pageRows.length, 3, 'page must show all 3 rows')
  const pageKeys = new Set(pageRows.map(r => r.key))
  assert.equal(pageKeys.size, 3, 'all page row keys must be distinct')

  // Page press on each row acts on its own task
  for (const row of pageRows) {
    const acted = serveAction(items, { key: row.key, type: 'tick', text: row.next ?? '', fp: row.fp }, EN)
    assert.equal(acted.type, 'tick')
    assert.equal(acted.ref?.title, row.title)
    assert.equal(acted.ref?.step, row.next)
  }
})

test('tasks with literal disambiguation suffixes in any order keep distinct keys and do not hide each other (#940)', () => {
  // When Release#2 appears first before Release tasks
  const file = `## Demo
### Release#2
- [ ] Step 2

### Release
- [ ] Step 1A

### Release
- [ ] Step 1B
`
  const view = buildView(parseProgress(file), [], null, NOW, 0, {}, EN)
  const groupRows = view.groups.flatMap(g => g.rows)
  assert.equal(groupRows.length, 3)
  const keys = new Set(groupRows.map(r => r.key))
  assert.equal(keys.size, 3)

  const items = boardItems(view, [])
  const itemRows = items.filter(item => item.type === 'row')
  assert.equal(itemRows.length, 3)

  const model = serveModel(view, [], EN)
  const pageRows = model.groups.flatMap(g => g.rows)
  assert.equal(pageRows.length, 3)

  for (const row of pageRows) {
    const acted = serveAction(items, { key: row.key, type: 'tick', text: row.next ?? '', fp: row.fp }, EN)
    assert.equal(acted.type, 'tick')
    assert.equal(acted.ref?.title, row.title)
    assert.equal(acted.ref?.step, row.next)
  }
})

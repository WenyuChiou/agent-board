import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
let boardItems, boardKey, emptyBoardState, pinned, buildView, taskFingerprint, parseProgress, serveAction, serveModel, setManualStep, EN, ZH_TW, ZH_CN
try {
  ;({ boardItems, boardKey, emptyBoardState, pinned } = await import('../hooks/board.ts'))
  ;({ buildView, taskFingerprint } = await import('../hooks/view.ts'))
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

test('a validated checkbox refuses without writing when its source positions move before writing', () => {
  const before = draw(source)
  const action = serveAction(before.items, request(before.row), EN)
  assert.equal(action.type, 'tick')
  const shifted = source.replace('### Twin steps', '> Synthetic extra context\n### Twin steps')
  assert.equal(setManualStep(shifted, action.ref, 'x', now, EN), shifted)
})

test('a validated checkbox refuses a replaced task even when its steps keep the same words', () => {
  const before = draw(source)
  const action = serveAction(before.items, request(before.row), EN)
  assert.equal(action.type, 'tick')
  const replaced = source.replace('### Twin steps', '### Replacement task')
  assert.equal(setManualStep(replaced, action.ref, 'x', now, EN), replaced)
})

test('the terminal tick refuses without writing after an earlier line is removed', () => {
  const before = draw(source)
  const state = pinned({ ...emptyBoardState, key: before.row.key }, before.items)
  const action = boardKey(state, 'x', before.items, EN).action
  assert.equal(action.type, 'tick')
  const shifted = source.replace('- [ ] Check the sample\n', '')
  assert.equal(setManualStep(shifted, action.ref, 'x', now, EN), shifted)
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

const viewFor = text => {
  const view = buildView(parseProgress(text), [], null, now, 0, {}, EN)
  return { items: boardItems(view, [], true), row: serveModel(view, [], EN).groups.flatMap(group => group.rows).find(row => row.title === 'Twin steps') }
}

test('folding completed steps does not change which visible open twin is ticked', () => {
  const text = '## Synthetic project\n### Twin steps\n- [x] Completed one\n- [x] Completed two\n' + '- [ ] Inspect the map\n'.repeat(6)
  const { items, row } = viewFor(text)
  const open = row.steps.filter(step => step.text === 'Inspect the map' && typeof step.fileLine === 'number')
  const action = serveAction(items, { key: row.key, type: 'tick', text: open[1].text, line: open[1].fileLine, fp: row.tickFp, session: '' }, EN)
  assert.equal(action.type, 'tick')
  const result = setManualStep(text, action.ref, 'x', now, EN).split('\n')
  assert.equal(result[open[0].fileLine], '- [ ] Inspect the map')
  assert.match(result[open[1].fileLine], /^- \[x\] Inspect the map/)
})

test('a folded-out next tick cannot select its doing twin after an earlier line disappears', () => {
  const text = '## Synthetic project\n### Earlier card\n- [ ] Check the sample\n### Twin steps\n' + Array.from({ length: 5 }, (_, i) => '- [ ] Ordinary step ' + i + '\n').join('') + '- [~] Inspect the map\n- [~] Inspect the map\n'
  const { items, row } = viewFor(text)
  assert.ok(row.steps.every(step => step.fileLine !== row.nextFileLine))
  const action = serveAction(items, { key: row.key, type: 'tick', text: row.next, line: row.nextFileLine, fp: row.tickFp, session: '' }, EN)
  assert.equal(action.type, 'tick')
  const shifted = text.replace('- [ ] Check the sample\n', '')
  const result = setManualStep(shifted, action.ref, 'x', now, EN)
  const first = shifted.split('\n').indexOf('- [~] Inspect the map')
  assert.equal(result.split('\n')[first + 1], '- [~] Inspect the map', 'the other doing twin must remain open')
  if (result !== shifted) assert.match(result.split('\n')[first], /^- \[x\] Inspect the map/)
})

test('a guarded checkbox cannot fall back to a sibling when its selected identical card changes', () => {
  const { items, rows } = drawIdenticalCards()
  const action = serveAction(items, request(rows[1]), EN)
  assert.equal(action.type, 'tick')
  const at = identicalCards.lastIndexOf('### Twin steps')
  const changed = identicalCards.slice(0, at) + identicalCards.slice(at).replace('### Twin steps\n', '### Twin steps\n> Changed selected card\n')
  assert.equal(setManualStep(changed, action.ref, 'x', now, EN), changed, 'losing the selected candidate must not select the unchanged sibling')
})

test('a manual question keeps its write guard when its task row is in the collapsed idle section', () => {
  const text = source.replaceAll('- [ ] Inspect the map', '- [?] Inspect the map')
  const projects = parseProgress(text)
  const seen = Object.fromEntries(projects.flatMap(project => project.tasks.map(task => [taskFingerprint(project.name, task), now - 8 * 86400000])))
  const view = buildView(projects, [], null, now, 0, {}, EN, [], seen)
  assert.ok(view.idle.some(row => row.title === 'Twin steps'))
  const items = boardItems(view, [], false)
  assert.ok(!items.some(item => item.type === 'row' && item.row.title === 'Twin steps'))
  const ask = items.find(item => item.type === 'ask' && item.ask.task === 'Twin steps')
  assert.ok(ask)
  const action = boardKey(pinned({ ...emptyBoardState, key: ask.key }, items), 'x', items, EN).action
  assert.equal(action.type, 'tick')
  const shifted = text.replace('- [ ] Check the sample\n', '')
  assert.equal(setManualStep(shifted, action.ref, 'x', now, EN), shifted)
})

const questionSource = '## Synthetic project\n### Twin steps\n- [ ] Earlier step\n- [?] Inspect the map\n- [?] Inspect the map\n'
const drawQuestions = (text, isIdleOpen = true) => {
  const projects = parseProgress(text)
  const seen = isIdleOpen ? {} : Object.fromEntries(projects.flatMap(project => project.tasks.map(task => [taskFingerprint(project.name, task), now - 8 * 86400000])))
  const view = buildView(projects, [], null, now, 0, {}, EN, [], seen)
  const items = boardItems(view, [], isIdleOpen)
  const asks = serveModel(view, [], EN).asks.filter(ask => ask.task === 'Twin steps')
  for (const item of items.filter(item => item.type === 'ask' && item.ask.step !== null)) {
    assert.ok(item.ask.step.guard, 'drawn questions must carry their task source guard')
    assert.deepEqual(item.ask.step.guard.steps, projects[0].tasks[0].steps.map(step => step.line))
  }
  if (!isIdleOpen) assert.ok(!items.some(item => item.type === 'row' && item.row.title === 'Twin steps'))
  return { items, asks }
}
const questionRequest = ask => ({ key: ask.key, type: 'tick', text: '', session: '', fp: ask.tickFp ?? ask.fp, line: ask.fileLine })

for (const isIdleOpen of [true, false]) {
  const shelf = isIdleOpen ? 'visible' : 'collapsed'
  test('a saved question Done press refuses an identical sibling after an earlier step disappears with its task ' + shelf, () => {
    const before = drawQuestions(questionSource, isIdleOpen)
    const saved = questionRequest(before.asks[0])
    const shifted = questionSource.replace('- [ ] Earlier step\n', '')
    const after = drawQuestions(shifted, isIdleOpen)
    const previous = before.items.find(item => item.key === saved.key)
    const current = after.items.find(item => item.key === saved.key)
    assert.equal(previous.ask.step.line, current.ask.step.line, 'the second question now occupies the first question\'s source line')
    assert.notDeepEqual(previous.ask.step.guard.steps, current.ask.step.guard.steps, 'the task\'s full step-line vector must tell the questions apart')
    assert.equal(before.asks[0].fp, after.asks.find(ask => ask.key === saved.key).fp, 'card actions keep their identity through unrelated line moves')
    const action = serveAction(after.items, saved, EN)
    const result = action.type === 'tick' ? setManualStep(shifted, action.ref, 'x', now, EN) : shifted
    assert.deepEqual(action, { type: 'refuse', note: EN.boardLineChanged })
    assert.equal(result, shifted, 'a refused question must not write either sibling')
  })

  test('a pinned terminal question refuses an identical sibling after an earlier step disappears with its task ' + shelf, () => {
    const before = drawQuestions(questionSource, isIdleOpen)
    const state = pinned({ ...emptyBoardState, key: before.asks[0].key }, before.items)
    const shifted = questionSource.replace('- [ ] Earlier step\n', '')
    const after = drawQuestions(shifted, isIdleOpen)
    const pressed = boardKey(state, 'x', after.items, EN)
    const result = pressed.action?.type === 'tick' ? setManualStep(shifted, pressed.action.ref, 'x', now, EN) : shifted
    assert.equal(pressed.action, null)
    assert.equal(pressed.state.note, EN.boardLineChanged)
    assert.equal(result, shifted, 'a refused terminal question must not write either sibling')
  })
}

for (const surface of ['page', 'terminal']) {
  test('fresh ' + surface + ' question presses tick the second identical question and then the first', () => {
    let text = questionSource
    for (const index of [1, 0]) {
      const { items, asks } = drawQuestions(text)
      const ask = asks[index]
      assert.equal(typeof ask.tickFp, 'string')
      assert.equal(typeof ask.fileLine, 'number')
      const action = surface === 'page'
        ? serveAction(items, questionRequest(ask), EN)
        : boardKey(pinned({ ...emptyBoardState, key: ask.key }, items), 'x', items, EN).action
      assert.equal(action.type, 'tick')
      assert.equal(action.ref.line, ask.fileLine)
      text = setManualStep(text, action.ref, 'x', now, EN)
      assert.match(text.split('\n')[ask.fileLine], /^- \[x\] Inspect the map/)
      if (index === 1) assert.equal(text.split('\n')[asks[0].fileLine], '- [?] Inspect the map')
    }
    assert.equal(text.split('\n').filter(line => line.startsWith('- [x] Inspect the map')).length, 2)
    assert.ok(text.includes('- [ ] Earlier step'))
  })
}

test('an old question Done press without a tick fingerprint or source line asks for a refresh', () => {
  const { items, asks } = drawQuestions(questionSource)
  const action = serveAction(items, { key: asks[0].key, type: 'tick', text: '', session: '', fp: asks[0].fp }, EN)
  const result = action.type === 'tick' ? setManualStep(questionSource, action.ref, 'x', now, EN) : questionSource
  assert.deepEqual(action, { type: 'refuse', note: EN.boardLineChanged })
  assert.equal(result, questionSource)
})

test('a question Done press needs both its tick fingerprint and its source line', () => {
  const { items, asks } = drawQuestions(questionSource)
  const ask = asks[0]
  const fresh = questionRequest(ask)
  for (const invalid of [{ ...fresh, fp: ask.fp }, { ...fresh, line: undefined }, { ...fresh, line: ask.fileLine + 1 }]) {
    const action = serveAction(items, invalid, EN)
    const result = action.type === 'tick' ? setManualStep(questionSource, action.ref, 'x', now, EN) : questionSource
    assert.deepEqual(action, { type: 'refuse', note: EN.boardLineChanged })
    assert.equal(result, questionSource)
  }
})

test('a terminal question without its pinned tick fingerprint asks for a refresh', () => {
  const { items, asks } = drawQuestions(questionSource)
  const { seenTicks, ...state } = pinned({ ...emptyBoardState, key: asks[0].key }, items)
  assert.ok(seenTicks)
  const pressed = boardKey(state, 'x', items, EN)
  assert.equal(pressed.action, null)
  assert.equal(pressed.state.note, EN.boardLineChanged)
})

const untitledSource = '## Earlier project\n### Earlier card\n- [ ] Check the sample\n## Untitled project\n- [ ] Inspect the map\n- [ ] Inspect the map\n'
const drawUntitled = (text, words) => {
  const view = buildView(parseProgress(text), [], null, now, 0, {}, words)
  const items = boardItems(view, [], true)
  const row = serveModel(view, [], words).groups.flatMap(group => group.rows).find(row => row.project === 'Untitled project' && row.title === words.unnamed)
  assert.ok(row)
  return { items, row }
}

for (const [language, words] of [['en', EN], ['zh-TW', ZH_TW], ['zh-CN', ZH_CN]]) {
  test('an untitled checkbox refuses a moved source without ticking its twin in ' + language, () => {
    const { items, row } = drawUntitled(untitledSource, words)
    const action = serveAction(items, request(row), words)
    assert.equal(action.type, 'tick')
    const shifted = untitledSource.replace('## Untitled project', '> Synthetic extra context\n## Untitled project')
    assert.equal(setManualStep(shifted, action.ref, 'x', now, words), shifted)
  })

  test('fresh untitled checkbox presses tick the second twin and then the first in ' + language, () => {
    let text = untitledSource
    for (const index of [1, 0]) {
      const { items, row } = drawUntitled(text, words)
      const action = serveAction(items, request(row, index), words)
      assert.equal(action.type, 'tick')
      text = setManualStep(text, action.ref, 'x', now, words)
      const lines = text.split('\n')
      assert.match(lines[row.steps[index].fileLine], /^- \[x\] Inspect the map/)
      if (index === 1) assert.equal(lines[row.steps[0].fileLine], '- [ ] Inspect the map')
    }
    assert.equal(text.split('\n').filter(line => line.startsWith('- [x] Inspect the map')).length, 2)
  })
}

test('fresh identical untitled task cards keep their own checkbox in repeated project sections', () => {
  const text = '## Untitled project\n- [ ] Inspect the map\n- [ ] Inspect the map\n'.repeat(2)
  const view = buildView(parseProgress(text), [], null, now, 0, {}, EN)
  const items = boardItems(view, [], true)
  const rows = serveModel(view, [], EN).groups.flatMap(group => group.rows)
  const action = serveAction(items, request(rows[1]), EN)
  assert.equal(action.type, 'tick')
  const result = setManualStep(text, action.ref, 'x', now, EN).split('\n')
  for (const step of rows[0].steps) assert.equal(result[step.fileLine], '- [ ] Inspect the map')
  assert.equal(result[rows[1].steps[0].fileLine], '- [ ] Inspect the map')
  assert.match(result[rows[1].steps[1].fileLine], /^- \[x\] Inspect the map/)
})

test('the terminal refuses an untitled checkbox after an earlier source line disappears', () => {
  const { items, row } = drawUntitled(untitledSource, EN)
  const action = boardKey(pinned({ ...emptyBoardState, key: row.key }, items), 'x', items, EN).action
  assert.equal(action.type, 'tick')
  const shifted = untitledSource.replace('- [ ] Check the sample\n', '')
  assert.equal(setManualStep(shifted, action.ref, 'x', now, EN), shifted)
})

// Codex Sol R2 on #1212: an identical card reworded and moved above its twin hands the twin the
// drawn key, step line and task line; only the matching-task positions tell the two draws apart.
const twinTasks = mark => '## Synthetic project\n' + `### Twin tasks\n- [${mark}] Inspect the map\n`.repeat(2)
const reworkedAndMoved = mark => `## Synthetic project\n### Twin tasks\n- [${mark}] Replacement step\n### Twin tasks\n- [${mark}] Inspect the map\n`
const drawTwinTasks = text => {
  const view = buildView(parseProgress(text), [], null, now, 0, {}, EN)
  const model = serveModel(view, [], EN)
  return { items: boardItems(view, [], true), asks: model.asks.filter(ask => ask.task === 'Twin tasks'), rows: model.groups.flatMap(group => group.rows).filter(row => row.title === 'Twin tasks') }
}

for (const surface of ['page', 'terminal']) {
  test('a ' + surface + ' question press refuses after its card is reworded and moved above an identical twin', () => {
    const before = drawTwinTasks(twinTasks('?'))
    const drawn = before.asks[1]
    const state = pinned({ ...emptyBoardState, key: drawn.key }, before.items)
    const moved = reworkedAndMoved('?')
    const after = drawTwinTasks(moved)
    const current = after.items.find(item => item.key === drawn.key)
    assert.equal(current?.ask.step.line, drawn.fileLine, 'the untouched twin now holds the drawn key and source line')
    const action = surface === 'page' ? serveAction(after.items, questionRequest(drawn), EN) : boardKey(state, 'x', after.items, EN).action
    const result = action?.type === 'tick' ? setManualStep(moved, action.ref, 'x', now, EN) : moved
    if (surface === 'page') assert.deepEqual(action, { type: 'refuse', note: EN.boardLineChanged })
    else assert.equal(action, null)
    assert.equal(result, moved, 'a refused question must not write the untouched twin')
  })

  test('a ' + surface + ' checkbox press refuses after its card is reworded and moved above an identical twin', () => {
    const before = drawTwinTasks(twinTasks(' '))
    const drawn = before.rows[1]
    const state = pinned({ ...emptyBoardState, key: drawn.key }, before.items)
    const moved = reworkedAndMoved(' ')
    const after = drawTwinTasks(moved)
    const current = after.items.find(item => item.key === drawn.key)
    assert.equal(current?.row.next?.line, drawn.steps[0].fileLine, 'the untouched twin now holds the drawn key and source line')
    const action = surface === 'page' ? serveAction(after.items, request(drawn, 0), EN) : boardKey(state, 'x', after.items, EN).action
    const result = action?.type === 'tick' ? setManualStep(moved, action.ref, 'x', now, EN) : moved
    if (surface === 'page') assert.deepEqual(action, { type: 'refuse', note: EN.boardLineChanged })
    else assert.equal(action, null)
    assert.equal(result, moved, 'a refused checkbox must not write the untouched twin')
  })
}

// #1228: the board writes a hidden done date onto a finished step after the draw (done-stamp.ts).
// That date is not part of the task's identity, so a guarded step drawn before it still ticks at
// write time (the native pane's queued write checks only this).
test('a guarded step drawn before the board dated an earlier done step still ticks its own twin at write time (#1228)', () => {
  const text = '## Synthetic project\n### Twin steps\n- [x] Earlier step\n- [ ] Inspect the map\n- [ ] Inspect the map\n'
  const dated = text.replace('- [x] Earlier step', '- [x] Earlier step <!-- done 2026-11-08 -->')
  const drawn = viewFor(text).items.find(item => item.type === 'row' && item.row.title === 'Twin steps').row.next
  assert.ok(drawn.guard, 'the drawn step carries its source guard')
  const lines = setManualStep(dated, drawn, 'x', now, EN).split('\n')
  assert.match(lines[3], /^- \[x\] Inspect the map/)
  assert.equal(lines[4], '- [ ] Inspect the map')
})

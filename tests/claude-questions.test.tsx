import { EN, FILE, SESSION, buildView, engineBeneath, expect, parseProgress, serveModel, start, test, type World } from './pane-helpers'
import { boardText } from '../hooks/board'
import { emptyQuestions, parseQuestions } from '../hooks/questions'

const worldOf = (): World => ({ files: new Map(), mtime: 1, hasTasks: false, store: { lang: 'en', autoConnectOff: true }, reply: () => 'TITLE: Update colors\nCONTEXT: -\nDONE: Checked the palette and updated colors\nNEXT: -\nASK: -' })

const visibleQuestion = (world: World, question: string): void => {
  const projects = parseProgress(world.files.get(FILE) ?? '')
  const ledger = parseQuestions(world.files.get(FILE.replace('.md', '-questions.json')) ?? '') ?? emptyQuestions()
  const view = buildView(projects, [], null, Date.parse('2026-10-16T12:00:00Z'), 0, {}, EN, [], {}, ledger)
  expect(view.waiting.some(one => one.text.includes(question) || one.note.includes(question))).toBe(true)
  expect(boardText(view, [], EN)).toContain(question)
  expect(JSON.stringify(serveModel(view, [], EN))).toContain(question)
}

test('a Claude Code turn that ends on a question shows it in Needs you without Task tools', async ($, on) => {
  const world = worldOf()
  const clock = engineBeneath(on, world)
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'updated' }))
  await start($, 'Check the palette and update colors')
  await $.tool.call({ tool: 'Edit', file_path: '/synthetic/colors', old_string: 'red', new_string: 'blue' })
  await $.turn.complete({ answer: 'Checked the palette and updated colors. Blue or green?', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  visibleQuestion(world, 'Blue or green?')
  expect(world.files.get(FILE) ?? '').toContain('- [x] Checked the palette and updated colors')
  expect(world.messageReads ?? 0).toBe(0)
})

test('a default Claude Code turn reports steps before returning without Task tools or history', async ($, on) => {
  const world = worldOf()
  const clock = engineBeneath(on, world)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'synthetic palette' }))
  await start($, 'Check both palettes')
  await $.tool.call({ tool: 'Read', file_path: '/synthetic/light' })
  await $.tool.call({ tool: 'Read', file_path: '/synthetic/dark' })
  await $.turn.complete({ answer: 'Checked the palette and updated colors.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').toContain('- [x] Checked the palette and updated colors')
  expect(world.files.get(FILE) ?? '').toContain('state=done')
  expect(world.messageReads ?? 0).toBe(0)
})

test('AskUserQuestion is in Needs you while Claude waits and leaves when the native tool returns', async ($, on) => {
  const world = worldOf()
  const clock = engineBeneath(on, world)
  let release!: () => void
  const answered = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    entered()
    await answered
    return { result: { answers: { 'Blue or green?': 'Blue' } } }
  })
  await start($, 'Choose the colors')
  const call = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'synthetic-choice', questions: [{ question: 'Blue or green?', header: 'Color', options: [{ label: 'Blue', description: 'Blue palette' }, { label: 'Green', description: 'Green palette' }], multiSelect: false }] })
  await waiting
  try {
    visibleQuestion(world, 'Blue or green?')
    expect(world.files.get(FILE) ?? '').toContain('Blue')
  } finally {
    release()
    await call
  }
  expect(world.files.get(FILE) ?? '').not.toContain('- [?]')
  const ledger = parseQuestions(world.files.get(FILE.replace('.md', '-questions.json')) ?? '')
  expect(ledger?.records.some(record => record.isUnresolved)).toBe(false)
  await $.turn.complete({ answer: 'Checked the palette and updated colors.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').toContain('- [x] Checked the palette and updated colors')
})

test('a Claude Code closing question preserves completed Task steps', async ($, on) => {
  const world = { ...worldOf(), hasTasks: true }
  const clock = engineBeneath(on, world)
  await start($, 'Update colors')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Check palette', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.turn.complete({ answer: 'Blue or green?', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').toContain('- [x] Check palette')
  visibleQuestion(world, 'Blue or green?')
  expect(world.store?.[`mirror:${SESSION}`]).toBeDefined()
  await $.turn.start({ text: 'Blue', turnId: 't2' })
  await clock.advance(10)
  const ledger = parseQuestions(world.files.get(FILE.replace('.md', '-questions.json')) ?? '')
  expect(ledger?.records.some(record => record.isUnresolved)).toBe(false)
})

test('a Claude Code closing question survives an empty summary without Task tools', async ($, on) => {
  const world = { ...worldOf(), reply: () => '' }
  const clock = engineBeneath(on, world)
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'updated' }))
  await start($, 'Update colors')
  await $.tool.call({ tool: 'Edit', file_path: '/synthetic/colors', old_string: 'red', new_string: 'blue' })
  await $.turn.complete({ answer: 'Blue or green?', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  visibleQuestion(world, 'Blue or green?')
  expect(world.messageReads ?? 0).toBe(0)
})

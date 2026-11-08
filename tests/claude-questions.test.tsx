import { EN, FILE, SESSION, buildView, engineBeneath, expect, parseProgress, serveModel, start, test, type World } from './pane-helpers'
import { boardText } from '../hooks/board'
import { emptyQuestions, observeQuestions, parseQuestions, questionsJson } from '../hooks/questions'
import { closeApproval, markApproval } from '../hooks/digest'
import { applyTaskCreate, emptyMirror } from '../hooks/mirror'
import { renderAutoBlock } from '../hooks/blocks'

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

test('AskUserQuestion leaves a Task list session when the native tool returns, and its step finishes', async ($, on) => {
  const world = { ...worldOf(), hasTasks: true }
  const clock = engineBeneath(on, world)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { answers: { 'Blue or green?': 'Blue' } } }))
  await start($, 'Update colors')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Check palette', description: '' })
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'synthetic-list', questions: [{ question: 'Blue or green?', header: 'Color', options: [{ label: 'Blue', description: 'Blue palette' }, { label: 'Green', description: 'Green palette' }] }] })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.turn.complete({ answer: 'Updated colors.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  const written = world.files.get(FILE) ?? ''
  expect(written).not.toContain('- [?]')
  expect(written).not.toContain('- [ ]')
  expect(written).toContain('state=done')
})

test('AskUserQuestion that fails does not leave its question waiting in Needs you', async ($, on) => {
  const world = worldOf()
  const clock = engineBeneath(on, world)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ isError: true, result: 'declined' }))
  await start($, 'Choose the colors')
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'synthetic-fail', questions: [{ question: 'Blue or green?', header: 'Color', options: [{ label: 'Blue', description: 'Blue palette' }] }] })
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').not.toContain('- [?]')
  const ledger = parseQuestions(world.files.get(FILE.replace('.md', '-questions.json')) ?? '')
  expect(ledger?.records.some(record => record.isUnresolved) ?? false).toBe(false)
})

test('AskUserQuestion writes its question once with the options on a native line, and no repeated note', async ($, on) => {
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
  const call = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'synthetic-native', questions: [{ question: 'Blue or green?', header: 'Color', options: [{ label: 'Blue', description: 'Blue palette' }, { label: 'Green', description: 'Green palette' }], multiSelect: false }] })
  await waiting
  try {
    const written = world.files.get(FILE) ?? ''
    expect(written.split('- [?] Blue or green?\n').length).toBe(2)
    expect(written).not.toContain('Blue or green? —')
    expect(written).toContain('<!-- native=claude options=["Blue","Green"] -->')
    const projects = parseProgress(written)
    const ledger = parseQuestions(world.files.get(FILE.replace('.md', '-questions.json')) ?? '') ?? emptyQuestions()
    const view = buildView(projects, [], null, Date.parse('2026-10-16T12:00:00Z'), 0, {}, EN, [], {}, ledger)
    const ask = serveModel(view, [], EN).asks.find(one => one.text.includes('Blue or green?'))
    expect(ask?.native?.options).toEqual(['Blue', 'Green'])
    expect(ask?.native?.line).toBe("Answer in Claude Code's window.")
    expect(ask?.answers).toEqual([])
  } finally {
    release()
    await call
  }
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').not.toContain('native=')
})

const approval = { tool: 'Bash', input: { command: 'synthetic' }, approver: 'person' } as never

test('a tool approval the person has waited on for 3 seconds shows a waiting step with a native line, and the tool finishing takes it back', async ($, on) => {
  const world: World = { ...worldOf(), hasTasks: true }
  const clock = engineBeneath(on, world)
  on('tool.check', () => ({ decision: 'ask' as const }))
  let release!: () => void
  const answered = new Promise<void>(resolve => { release = resolve })
  on('tool.call', { tool: 'Bash' }, async () => {
    await answered
    return { result: 'done' }
  })
  await start($, 'Update colors')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Check palette', description: '' })
  await $.tool.check({ ...(approval as object), tool_use_id: 'synthetic-approval' } as never)
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'synthetic-approval', command: 'synthetic' })
  await clock.advance(2000)
  expect(world.files.get(FILE) ?? '').not.toContain('- [?]')
  await clock.advance(1500)
  const written = world.files.get(FILE) ?? ''
  expect(written).toContain('- [?] Claude asks to run Bash\n<!-- question=')
  expect(written).toContain('<!-- native=claude -->')
  release()
  await call
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').not.toContain('- [?]')
  expect(world.files.get(FILE) ?? '').not.toContain('native=')
})

test('a tool approval that waits behind an open question goes up once that question is answered (#1106)', async ($, on) => {
  const world: World = { ...worldOf(), hasTasks: true }
  const clock = engineBeneath(on, world)
  on('tool.check', () => ({ decision: 'ask' as const }))
  let answer!: () => void
  const answered = new Promise<void>(resolve => { answer = resolve })
  let entered!: () => void
  const asking = new Promise<void>(resolve => { entered = resolve })
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    entered()
    await answered
    return { result: { answers: { 'Blue or green?': 'Blue' } } }
  })
  let approve!: () => void
  const approved = new Promise<void>(resolve => { approve = resolve })
  on('tool.call', { tool: 'Bash' }, async () => {
    await approved
    return { result: 'done' }
  })
  await start($, 'Update colors')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Check palette', description: '' })
  const ask = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'synthetic-held', questions: [{ question: 'Blue or green?', header: 'Color', options: [{ label: 'Blue', description: 'Blue palette' }, { label: 'Green', description: 'Green palette' }], multiSelect: false }] })
  await asking
  await $.tool.check({ ...(approval as object), tool_use_id: 'synthetic-behind' } as never)
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'synthetic-behind', command: 'synthetic' })
  try {
    await clock.advance(3500)
    // The open question keeps the board; the approval waits behind it.
    expect(world.files.get(FILE) ?? '').toContain('- [?] Blue or green?')
    expect(world.files.get(FILE) ?? '').not.toContain('Claude asks to run Bash')
    answer()
    await ask
    await clock.advance(10)
    const written = world.files.get(FILE) ?? ''
    expect(written).not.toContain('- [?] Blue or green?')
    expect(written).toContain('- [?] Claude asks to run Bash\n<!-- question=')
    expect(written).toContain('<!-- native=claude -->')
    // Later saves leave the raised step and its question token as they are.
    const token = /<!-- question=([^ ]+) -->/.exec(written)?.[1]
    await $.tool.call({ tool: 'TaskCreate', subject: 'Check contrast', description: '' })
    await clock.advance(10)
    const later = world.files.get(FILE) ?? ''
    expect(later.split('Claude asks to run Bash').length).toBe(2)
    expect(/<!-- question=([^ ]+) -->/.exec(later)?.[1]).toBe(token)
  } finally {
    answer()
    approve()
    await ask
    await call
  }
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').not.toContain('- [?]')
})

test('a tool approval answered within 3 seconds never reaches the board', async ($, on) => {
  const world: World = { ...worldOf(), hasTasks: true }
  const clock = engineBeneath(on, world)
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'done' }))
  await start($, 'Update colors')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Check palette', description: '' })
  await $.tool.check({ ...(approval as object), tool_use_id: 'synthetic-quick' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'synthetic-quick', command: 'synthetic' })
  await clock.advance(5000)
  expect(world.files.get(FILE) ?? '').not.toContain('- [?]')
})

test('a tool approval in a subagent or for AskUserQuestion shows no approval step', async ($, on) => {
  const world: World = { ...worldOf(), hasTasks: true }
  const clock = engineBeneath(on, world)
  on('tool.check', () => ({ decision: 'ask' as const }))
  await start($, 'Update colors')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Check palette', description: '' })
  await $.tool.check({ ...(approval as object), tool_use_id: 'synthetic-sub', agentId: 'synthetic-agent' } as never)
  await $.tool.check({ tool: 'AskUserQuestion', input: {}, approver: 'person', tool_use_id: 'synthetic-ask' } as never)
  await clock.advance(5000)
  expect(world.files.get(FILE) ?? '').not.toContain('- [?]')
})

for (const fault of ['capture', 'mirror'] as const) test(`a failed approval ${fault} write preserves its evidence until a later successful pass`, async ($, on) => {
  const world: World = { ...worldOf(), hasTasks: true }
  const clock = engineBeneath(on, world)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {} }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  let release!: () => void
  const answered = new Promise<void>(resolve => { release = resolve })
  on('tool.call', { tool: 'Bash' }, async () => { await answered; return { result: 'done' } })
  await start($, 'Update synthetic colors')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Check synthetic palette', description: '' })
  await $.tool.check({ ...(approval as object), tool_use_id: 'synthetic-approval-fault' } as never)
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'synthetic-approval-fault', command: 'synthetic' })
  await clock.advance(3500)
  const ledgerPath = FILE.replace('.md', '-questions.json')
  const open = parseQuestions(world.files.get(ledgerPath) ?? '')!
  expect(open.records.some(record => record.isUnresolved)).toBe(true)
  if (fault === 'capture') world.failQuestionCapture = 'write'
  else world.failStore = (operation, key) => operation === 'set' && key === `mirror:${SESSION}`
  release()
  await call
  await clock.advance(10)
  expect(world.files.get(FILE) ?? '').toContain('Claude asks to run Bash')
  expect(parseQuestions(world.files.get(ledgerPath) ?? '')?.records.some(record => record.isUnresolved)).toBe(true)
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Continue synthetic work', status: 'in_progress', activeForm: 'Continuing synthetic work' }] })
  // A task-list refresh must not drop the pending closure either.
  expect(world.files.get(FILE) ?? '').toContain('Claude asks to run Bash')
  // A missing mutable index must still recover the unanswered capture while writes fail.
  world.files.delete(ledgerPath)
  await clock.advance(2100)
  expect(world.files.get(FILE) ?? '').toContain('Claude asks to run Bash')
  world.failQuestionCapture = undefined
  world.failStore = undefined
  await clock.advance(4100)
  const recovered = parseQuestions(world.files.get(ledgerPath) ?? '') ?? emptyQuestions()
  expect(recovered.records.some(record => record.isUnresolved)).toBe(false)
  expect(world.files.get(FILE) ?? '').not.toContain('Claude asks to run Bash')
  const view = buildView(parseProgress(world.files.get(FILE) ?? ''), [], null, Date.parse('2026-10-16T12:00:10Z'), 0, {}, EN, [], {}, recovered)
  expect(view.waiting).toEqual([])
  // The durable terminal capture also prevents resurrection if the index is lost again.
  world.files.delete(ledgerPath)
  await clock.advance(4100)
  expect(parseQuestions(world.files.get(ledgerPath) ?? '')?.records.some(record => record.isUnresolved)).toBe(false)
})

test('a delayed completion does not clear an approval opened during closure persistence', async ($, on) => {
  const world: World = { ...worldOf(), hasTasks: true }
  const clock = engineBeneath(on, world)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {} }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  let releaseFirst!: () => void
  let releaseSecond!: () => void
  const firstAnswer = new Promise<void>(resolve => { releaseFirst = resolve })
  const secondAnswer = new Promise<void>(resolve => { releaseSecond = resolve })
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    await (e.tool_use_id === 'synthetic-first' ? firstAnswer : secondAnswer)
    return { result: 'done' }
  })
  await start($, 'Update synthetic colors')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Check synthetic palette', description: '' })
  await $.tool.check({ ...(approval as object), tool_use_id: 'synthetic-first' } as never)
  const firstCall = $.tool.call({ tool: 'Bash', tool_use_id: 'synthetic-first', command: 'synthetic' })
  await clock.advance(3500)
  const ledgerPath = FILE.replace('.md', '-questions.json')
  const firstId = parseQuestions(world.files.get(ledgerPath) ?? '')!.records.find(record => record.isUnresolved)!.id
  let reached!: () => void
  let releaseStore!: () => void
  const held = new Promise<void>(resolve => { reached = resolve })
  world.holdStore = { key: `mirror:${SESSION}`, reached, release: new Promise<void>(resolve => { releaseStore = resolve }) }
  releaseFirst()
  await held
  await $.tool.check({ ...(approval as object), tool_use_id: 'synthetic-second' } as never)
  const secondCall = $.tool.call({ tool: 'Bash', tool_use_id: 'synthetic-second', command: 'synthetic' })
  await clock.advance(3500)
  try {
    releaseStore()
    await firstCall
    await clock.advance(2100)
    expect(world.files.get(FILE) ?? '').toContain('- [?] Claude asks to run Bash')
    const ledger = parseQuestions(world.files.get(ledgerPath) ?? '')!
    const current = ledger.records.filter(record => record.isUnresolved)
    expect(current).toHaveLength(1)
    expect(current[0]!.id === firstId).toBe(false)
  } finally {
    releaseStore()
    releaseSecond()
    await secondCall
  }
  await clock.advance(2100)
  expect(parseQuestions(world.files.get(ledgerPath) ?? '')?.records.some(record => record.isUnresolved)).toBe(false)
})

test('a restarted session retries a stored approval closure before a task refresh can drop it', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00Z')
  const task = applyTaskCreate(emptyMirror(SESSION, 'demo', at), { subject: 'Check synthetic palette' }, '1', at)
  const waiting = markApproval(task, EN.claudeApprovalStep('Bash'))
  const source = `## demo\n${renderAutoBlock(waiting, EN).join('\n')}\n`
  const open = observeQuestions(emptyQuestions(), parseProgress(source), waiting, [], at, true).ledger
  const ledgerPath = FILE.replace('.md', '-questions.json')
  const world: World = {
    ...worldOf(), hasTasks: true, failQuestionCapture: 'write',
    files: new Map([[FILE, source], [ledgerPath, questionsJson(open)]]),
    store: { lang: 'en', autoConnectOff: true, [`mirror:${SESSION}`]: closeApproval(waiting) },
  }
  const clock = engineBeneath(on, world)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {} }))
  await start($, 'Continue synthetic colors')
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Continue synthetic work', status: 'in_progress', activeForm: 'Continuing synthetic work' }] })
  expect(world.files.get(FILE) ?? '').toContain('Claude asks to run Bash')
  world.failQuestionCapture = undefined
  await clock.advance(4100)
  const closed = parseQuestions(world.files.get(ledgerPath) ?? '')!
  expect(closed.records.some(record => record.isUnresolved)).toBe(false)
  expect(world.files.get(FILE) ?? '').not.toContain('Claude asks to run Bash')
})

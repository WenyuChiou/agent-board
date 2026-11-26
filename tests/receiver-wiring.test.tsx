import { parseQuestions, questionsPath } from '../hooks/questions'
import { addressFileName, addressKey } from '../hooks/receiver'
import { engineBeneath, expect, FILE, outside, SESSION, start, test } from './pane-helpers'
import type { World } from './pane-helpers'
import type { ProgressMirror } from '../types'

const NONCE = 'a1b2c3'
const WORDS = 'the message text from the board'
const PROMPT = `Agent Board message\nReply first with this line alone: ACK ${NONCE}\n<<<AB-${NONCE}\n${WORDS}\nAB-${NONCE}>>>`
const ADDRESS = `/home/me/.cache/agent-board/${addressFileName(addressKey(FILE) ?? '')}`

const hub = (on: Parameters<Parameters<typeof test>[1]>[1], world: World) => {
  world.files.set(ADDRESS, JSON.stringify({ pid: 1, port: 4100, url: 'http://127.0.0.1:4100/?t=token1', path: FILE, built: '' }))
  const sent: Array<{ action: string; body: Record<string, unknown>; token: unknown }> = []
  const queue: unknown[] = [{ id: 'AB-1', nonce: NONCE, prompt: PROMPT }]
  const submitted: Array<Record<string, unknown>> = []
  world.isAddressOwn ??= true
  on('http.fetch', ($, e) => {
    const action = e.url.split('/').at(-1) ?? ''
    const body = JSON.parse(String(e.init?.body)) as Record<string, unknown>
    sent.push({ action, body, token: (e.init?.headers as Record<string, string> | undefined)?.['x-board-token'] })
    const json = action === 'register' ? { id: 'c1', secret: 's1', leaseMs: 15000 }
      : action === 'poll' ? { messages: body.receive === true ? queue.splice(0, 1) : [], leaseMs: 15000 }
      : { ok: true }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(json) } }
  })
  on('prompt.submit', ($, e) => {
    submitted.push({ ...e })
    return { text: e.text }
  })
  return { sent, submitted }
}

test('a board message runs as one turn whose words and reply stay out of the board', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, reply: () => 'TITLE: x\nCONTEXT: -\nDONE: leaked\nNEXT: -\nASK: -' }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { sent, submitted } = hub(on, world)
  await start($, 'first task')
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2100)
  expect(sent[0]?.action).toBe('register')
  expect(sent[0]?.token).toBe('token1')
  expect(sent[0]?.body).toMatchObject({ agent: 'claude', session: SESSION, scope: 'session', turn: 'session' })
  expect(submitted.length).toBe(1)
  expect(submitted[0]?.text).toBe(PROMPT)
  expect(submitted[0]?.asUser).toBeUndefined()
  await $.turn.start({ text: PROMPT, turnId: 'd1' })
  await $.turn.complete({ answer: `ACK ${NONCE}\nThe reply body. Which one do you want?`, durationMs: 1, isAborted: false, turnId: 'd1', reason: 'answer' })
  await clock.advance(10)
  expect(sent.filter(one => one.action === 'receipt').map(one => one.body.status)).toEqual(['accepted', 'acknowledged'])
  expect(sent.find(one => one.body.status === 'acknowledged')?.body.reply).toBe(`ACK ${NONCE}`)
  const board = [...world.files.entries()].filter(([path]) => path !== ADDRESS).map(([, text]) => text).join('\n')
  for (const leak of [WORDS, 'The reply body', 'Which one do you want', NONCE]) expect(board).not.toContain(leak)
  expect(JSON.stringify(sent)).not.toContain('The reply body')
})

test('a board message whose reply ends on a question waits on you in a session with a Task list, without the ACK or the message words', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { submitted } = hub(on, world)
  await start($, 'name the pets')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Pick a fish name', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2100)
  expect(submitted.length).toBe(1)
  await $.turn.start({ text: PROMPT, turnId: 'd1' })
  await $.turn.complete({ answer: `ACK ${NONCE}\nShould I pick a third name?`, durationMs: 1, isAborted: false, turnId: 'd1', reason: 'answer' })
  await clock.advance(2100)
  const board = world.files.get(FILE) ?? ''
  expect(board).toContain('- [?] Should I pick a third name?')
  for (const leak of [WORDS, NONCE, 'ACK']) expect(board).not.toContain(leak)
})

test('a board message whose reply ends on a question waits on you in a session without a Task list, on an existing summary row', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, reply: () => 'TITLE: Pick the pets\nCONTEXT: -\nDONE: Picked a fish name\nNEXT: -\nASK: -' }
  const clock = engineBeneath(on, world)
  outside(on, world)
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'updated' }))
  const { sent, submitted } = hub(on, world)
  await start($, 'name the pets')
  await $.tool.call({ tool: 'Edit', file_path: '/synthetic/pets', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2100)
  expect(submitted.length).toBe(1)
  expect(world.files.get(FILE) ?? '').toContain('Picked a fish name')
  await $.turn.start({ text: PROMPT, turnId: 'd1' })
  await $.turn.complete({ answer: `ACK ${NONCE}\nShould I pick a third name?`, durationMs: 1, isAborted: false, turnId: 'd1', reason: 'answer' })
  await clock.advance(2100)
  expect(sent.filter(one => one.action === 'receipt').map(one => one.body.status)).toEqual(['accepted', 'acknowledged'])
  expect(sent.find(one => one.body.status === 'acknowledged')?.body.reply).toBe(`ACK ${NONCE}`)
  const board = world.files.get(FILE) ?? ''
  expect(board).toContain('Picked a fish name')
  expect(board).toContain('- [?] Should I pick a third name?')
  for (const leak of [WORDS, NONCE, 'ACK']) expect(board).not.toContain(leak)
  const ledger = parseQuestions(world.files.get(questionsPath(FILE)) ?? '')
  const unresolved = ledger?.records.filter(one => one.isUnresolved) ?? []
  expect(unresolved).toHaveLength(1)
  expect(unresolved[0]?.words).toBe('Should I pick a third name?')
})

test('a busy session keeps its address and does not take a message until its turn ends', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { sent, submitted } = hub(on, world)
  await start($, 'long task')
  await clock.advance(2100)
  expect(sent.filter(one => one.action === 'poll').at(-1)?.body.receive).toBe(false)
  expect(submitted.length).toBe(0)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2100)
  expect(submitted.length).toBe(1)
})

test('an address folder this account cannot show is its own gives no connection', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, isAddressOwn: false }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { sent } = hub(on, world)
  await start($, 'task')
  await clock.advance(2100)
  expect(sent.length).toBe(0)
})

test('the ACK of a main step counts when the turn ends on other words, and a subagent step does not', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { sent } = hub(on, world)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: `ACK ${NONCE}`, toolUses: [], stopReason: 'tool_use', usage: null } as never
  })
  const step = async (agentId?: string): Promise<void> => {
    const stream = $.turn.step({ turnId: 'd1', index: 0, model: 'm', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
    while (!(await stream.next()).done);
  }
  await start($, 'first task')
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2100)
  await $.turn.start({ text: PROMPT, turnId: 'd1' })
  await step('a subagent')
  await step()
  await $.turn.complete({ answer: 'All the tests pass.', durationMs: 1, isAborted: false, turnId: 'd1', reason: 'answer' })
  await clock.advance(10)
  expect(sent.find(one => one.body.status === 'acknowledged')?.body.reply).toBe(`ACK ${NONCE}`)
})

test('a subagent step alone does not acknowledge a delivery', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { sent } = hub(on, world)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: `ACK ${NONCE}`, toolUses: [], stopReason: 'tool_use', usage: null } as never
  })
  await start($, 'first task')
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2100)
  await $.turn.start({ text: PROMPT, turnId: 'd1' })
  const stream = $.turn.step({ turnId: 'd1', index: 0, model: 'm', messageCount: 1, agentId: 'a subagent' })
  while (!(await stream.next()).done);
  await $.turn.complete({ answer: 'All the tests pass.', durationMs: 1, isAborted: false, turnId: 'd1', reason: 'answer' })
  await clock.advance(10)
  expect(sent.find(one => one.body.status === 'uncertain')?.body.error).toBe('ACK_MISSING')
})

test('after a /clear the session goes on receiving, and after an exit it does not', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { sent } = hub(on, world)
  await start($, 'task')
  await clock.advance(2100)
  expect(sent.filter(one => one.action === 'register').length).toBe(1)
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { sessionId: SESSION } as never })
  await clock.advance(2100)
  expect(sent.filter(one => one.action === 'disconnect').length).toBe(1)
  expect(sent.filter(one => one.action === 'register').length).toBe(2)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION, resume: { sessionId: SESSION } as never })
  const count = sent.length
  await clock.advance(6100)
  expect(sent.filter(one => one.action === 'disconnect').length).toBe(2)
  expect(sent.length - count).toBe(0)
})

test('a plain -p session without desktop surface keeps isRun true, writes no block, and never registers', async ($, on) => {
  const shared: Record<string, unknown> = { autoConnectOff: true }
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, surfaces: ['terminal'], shared }
  const clock = engineBeneath(on, world)
  outside(on, world)
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'updated' }))
  const { sent } = hub(on, world)
  await $.session.start({ cwd: '/w/api-gateway', surface: null, isInteractive: false })
  await $.turn.start({ text: 'Run check', turnId: 'p1' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/api-gateway/a', old_string: '1', new_string: '2' })
  await clock.advance(5000)
  await $.turn.complete({ answer: 'Checked. Ship now?', durationMs: 1, isAborted: false, turnId: 'p1', reason: 'answer' })
  await clock.advance(6100)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION, resume: { sessionId: SESSION } as never })
  expect((shared[`mirror:${SESSION}`] as ProgressMirror).isRun).toBe(true)
  expect(world.files.get(FILE) ?? '').toBe('')
  expect(sent.length).toBe(0)
})

test('an interactive terminal session still registers as Claude Code', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, surfaces: ['terminal'] }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { sent } = hub(on, world)
  await $.session.start({ cwd: '/w/api-gateway', surface: 'terminal', isInteractive: true })
  await clock.advance(2100)
  expect(sent.find(one => one.action === 'register')?.body.surface).toBe('Claude Code')
})

test('a Code tab desktop session starts the receiver as Claude Desktop Code and writes no-Task-list questions to the board', async ($, on) => {
  const shared: Record<string, unknown> = { autoConnectOff: true }
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, surfaces: ['desktop'], shared, reply: () => 'TITLE: Code tab task\nCONTEXT: -\nDONE: Checked code\nNEXT: -\nASK: Ship now?' }
  const clock = engineBeneath(on, world)
  outside(on, world)
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'updated' }))
  const { sent } = hub(on, world)
  await $.session.start({ cwd: '/w/api-gateway', surface: 'desktop', isInteractive: false })
  await clock.advance(2100)
  expect(sent.find(one => one.action === 'register')?.body.surface).toBe('Claude Desktop Code')
  expect((shared[`mirror:${SESSION}`] as ProgressMirror).isRun).toBeUndefined()
  await $.turn.start({ text: 'Check the code', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/api-gateway/a', old_string: '1', new_string: '2' })
  await $.turn.complete({ answer: 'Done editing. Ship now?', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2100)
  const board = world.files.get(FILE) ?? ''
  expect(board).toContain('Checked code')
  expect(board).toContain('- [?] Ship now?')
})

test('a Code tab desktop session delivers a board message and keeps only its trailing question on a no-Task-list board', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, surfaces: ['desktop'], reply: () => 'TITLE: Code tab delivery\nCONTEXT: -\nDONE: Built module\nNEXT: -\nASK: -' }
  const clock = engineBeneath(on, world)
  outside(on, world)
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'updated' }))
  const { sent, submitted } = hub(on, world)
  await $.session.start({ cwd: '/w/api-gateway', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'Start module', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/api-gateway/a', old_string: '1', new_string: '2' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2100)
  expect(submitted.length).toBe(1)
  expect(sent.find(one => one.action === 'register')?.body.surface).toBe('Claude Desktop Code')
  expect(sent.find(one => one.action === 'receipt')?.body.status).toBe('accepted')
  await $.turn.start({ text: PROMPT, turnId: 'd1' })
  await $.turn.complete({ answer: `ACK ${NONCE}\nFinished. Blue or green?`, durationMs: 1, isAborted: false, turnId: 'd1', reason: 'answer' })
  await clock.advance(2100)
  expect(sent.filter(one => one.action === 'receipt').map(one => one.body.status)).toEqual(['accepted', 'acknowledged'])
  expect(sent.find(one => one.body.status === 'acknowledged')?.body.reply).toBe(`ACK ${NONCE}`)
  const board = world.files.get(FILE) ?? ''
  expect(board).toContain('- [?] Blue or green?')
  for (const leak of [WORDS, NONCE, 'ACK']) expect(board).not.toContain(leak)
})

test('late desktop surface attachment before a turn promotes the session, clears isRun, and registers as Claude Desktop Code', async ($, on) => {
  const shared: Record<string, unknown> = { autoConnectOff: true }
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, surfaces: [], shared }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { sent } = hub(on, world)
  await $.session.start({ cwd: '/w/api-gateway', surface: null, isInteractive: false })
  await clock.advance(2100)
  expect((shared[`mirror:${SESSION}`] as ProgressMirror).isRun).toBe(true)
  expect(sent.length).toBe(0)
  world.surfaces = ['desktop']
  await clock.advance(5100)
  expect((shared[`mirror:${SESSION}`] as ProgressMirror).isRun).toBeUndefined()
  expect(sent.find(one => one.action === 'register')?.body.surface).toBe('Claude Desktop Code')
})

test('late desktop surface attachment during a turn clears isRun without delivering mid-turn and delivers after turn.complete', async ($, on) => {
  const shared: Record<string, unknown> = { autoConnectOff: true }
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, surfaces: [], shared }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { sent, submitted } = hub(on, world)
  await $.session.start({ cwd: '/w/api-gateway', surface: null, isInteractive: false })
  await $.turn.start({ text: 'Work in progress', turnId: 't1' })
  world.surfaces = ['desktop']
  await clock.advance(5100)
  expect((shared[`mirror:${SESSION}`] as ProgressMirror).isRun).toBeUndefined()
  expect(sent.find(one => one.action === 'register')?.body.surface).toBe('Claude Desktop Code')
  expect(sent.filter(one => one.action === 'poll').at(-1)?.body.receive).toBe(false)
  expect(submitted.length).toBe(0)
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2100)
  expect(submitted.length).toBe(1)
})

test('late desktop surface attachment at turn.complete clears isRun so the completed no-Task-list turn writes to the board', async ($, on) => {
  const shared: Record<string, unknown> = { autoConnectOff: true }
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, surfaces: [], shared, reply: () => 'TITLE: Late desktop task\nCONTEXT: -\nDONE: Applied change\nNEXT: -\nASK: Continue?' }
  const clock = engineBeneath(on, world)
  outside(on, world)
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'updated' }))
  const { sent } = hub(on, world)
  await $.session.start({ cwd: '/w/api-gateway', surface: null, isInteractive: false })
  await $.turn.start({ text: 'Edit file', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/api-gateway/a', old_string: '1', new_string: '2' })
  world.surfaces = ['desktop']
  await $.turn.complete({ answer: 'Updated. Continue?', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2100)
  expect((shared[`mirror:${SESSION}`] as ProgressMirror).isRun).toBeUndefined()
  expect(sent.find(one => one.action === 'register')?.body.surface).toBe('Claude Desktop Code')
  const board = world.files.get(FILE) ?? ''
  expect(board).toContain('Applied change')
  expect(board).toContain('- [?] Continue?')
})

test('repeated desktop surface checks never start a second receiver or double-register', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, surfaces: ['desktop'] }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { sent } = hub(on, world)
  await $.session.start({ cwd: '/w/api-gateway', surface: 'desktop', isInteractive: false })
  await clock.advance(2100)
  expect(sent.filter(one => one.action === 'register').length).toBe(1)
  await $.turn.start({ text: 'Turn 1', turnId: 't1' })
  await $.turn.complete({ answer: 'Ok.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(6100)
  expect(sent.filter(one => one.action === 'register').length).toBe(1)
  expect(sent.filter(one => one.action === 'poll').length).toBeGreaterThan(1)
})

test('after a /clear a Code tab desktop session re-registers as Claude Desktop Code, and stops after exit', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: false, surfaces: ['desktop'] }
  const clock = engineBeneath(on, world)
  outside(on, world)
  const { sent } = hub(on, world)
  await $.session.start({ cwd: '/w/api-gateway', surface: 'desktop', isInteractive: false })
  await clock.advance(2100)
  expect(sent.filter(one => one.action === 'register').map(one => one.body.surface)).toEqual(['Claude Desktop Code'])
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { sessionId: SESSION } as never })
  await clock.advance(2100)
  expect(sent.filter(one => one.action === 'disconnect').length).toBe(1)
  expect(sent.filter(one => one.action === 'register').map(one => one.body.surface)).toEqual(['Claude Desktop Code', 'Claude Desktop Code'])
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION, resume: { sessionId: SESSION } as never })
  const count = sent.length
  await clock.advance(6100)
  expect(sent.filter(one => one.action === 'disconnect').length).toBe(2)
  expect(sent.length - count).toBe(0)
})

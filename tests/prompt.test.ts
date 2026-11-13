import { expect, test } from './kit'
import { agentHooks, COLLISION, DELETE, openclawPlugin, opencodePlugin } from '../hooks/connect'
import { hookTimeout, hostHookTimeout } from '../hooks/hook-safety'
import { answerAgentPrompt, blockId, inboxOrder, normalizeTurnOrder, readTurn, restoreAgentBoardQuestion, turnOrder, turnsToDigest, withAgentPrompts } from '../hooks/inbox'
import { emptyMirror, isStaleStoreKey } from '../hooks/mirror'
import { answerTurns, applyDigest, markAsked, settleChatReply } from '../hooks/digest'
import { peekInbox } from '../hooks/board'
import { stepWords, upsertAutoBlock } from '../hooks/blocks'
import { parseProgress } from '../hooks/parse'
import { emptyQuestions, observeQuestions, resolveQuestion } from '../hooks/questions'
import { EN } from '../hooks/strings-en'

const CTX = { home: '/h', sep: '/', isWindows: false, script: '/h/progress-report.sh', inbox: '/h/progress-inbox', codexHome: '/h/.codex', grokHome: '/h/.grok', hermesHome: '/h/.hermes', openclawHome: '/h/.openclaw' }
const AT = Date.parse('2026-10-16T12:00:00Z')
const SESSION = 'prompt-owner'
const ID = blockId('codex', SESSION)
const mirror = () => ({ ...applyDigest(emptyMirror(ID, 'demo', AT, '/demo', 'codex'), { title: 'Migration', context: '', done: '', next: 'Continue migration', ask: 'Database', why: 'Use staging?' }, AT), resume: SESSION, turnOrder: AT * 2, firstPrompt: 'Original request' })
const prompt = (at = AT + 1000) => readTurn(`codex-prompt-${at}-1.json`, JSON.stringify({ session_id: SESSION, prompt: 'PRIVATE_NEW_INPUT', last_assistant_message: 'SHOULD_NOT_SUMMARIZE', transcript_path: '/not/read.jsonl' }))!

test('a prompt receipt contains only binding metadata and never enters the digest selection', () => {
  const receipt = prompt()
  expect(receipt).toMatchObject({ event: 'prompt', prompt: '', answer: '', transcript: '' })
  expect([...turnsToDigest([receipt])]).toEqual([])
  expect(peekInbox([{ name: `codex-prompt-${AT + 1000}-1.json`, body: JSON.stringify({ session_id: SESSION, prompt: 'PRIVATE_NEW_INPUT', transcript_path: '/not/read.jsonl' }), at: AT + 1000 }], () => { throw new Error('prompt read a transcript') })).toEqual([])
})

for (const kind of ['future', 'unsafe-order', 'unknown-source', 'unbound-session'] as const) test(`pending previews keep reports and questions after ${kind} prompts`, () => {
  const now = AT + 2000
  const source = kind === 'future' ? now + 86400000 : kind === 'unsafe-order' ? Number.MAX_SAFE_INTEGER : now
  const submitted = { name: `codex-prompt-${source}-2.json`, body: JSON.stringify({ session_id: SESSION, prompt: 'PRIVATE_NEW_INPUT', last_assistant_message: 'PRIVATE_FAKE_REPLY?', transcript_path: '/not/read.jsonl' }), at: now }
  const current = kind === 'unbound-session' ? undefined : kind === 'unknown-source' ? { ...mirror(), turnOrder: undefined, updated: now - 1 } : mirror()
  expect(answerAgentPrompt(current, readTurn(submitted.name, submitted.body)!, now)).toBeNull()
  let transcriptReads = 0
  const readLog = (): never => { transcriptReads += 1; throw new Error('prompt preview read a transcript') }
  for (const answer of ['Validation finished; packaging next.', 'Ship it to staging now?']) {
    const report = { name: kind === 'unknown-source' ? 'codex-turn-no-clock-1.json' : `codex-turn-${AT}-1.json`, body: JSON.stringify({ session_id: SESSION, cwd: '/demo', last_assistant_message: answer }), at: now - 100 }
    const expected = peekInbox([report], readLog)
    expect(expected).toHaveLength(1)
    expect(peekInbox([report, submitted], readLog)).toEqual(expected)
    expect(JSON.stringify(peekInbox([report, submitted], readLog))).not.toContain('PRIVATE_')
  }
  expect(transcriptReads).toBe(0)
})

test('prompt ordering preserves saved binary turn and end numbers and answers only strictly newer receipts', () => {
  const current = mirror()
  const next = answerAgentPrompt(current, prompt(), AT + 2000)!
  expect(next.state).toBe('working')
  expect(next.tasks).toEqual(current.tasks)
  expect(next.replied).toBe(AT + 1000)
  expect(next.firstPrompt).toBe('Original request')
  expect(next.turnOrder).toBe(AT * 2)
  expect(next.promptOrder).toBe((AT + 1000) * 2)
  expect(answerAgentPrompt(current, prompt(AT), AT + 2000)).toBeNull()
  expect(answerAgentPrompt(next, prompt(), AT + 3000)).toBeNull()
  expect(answerAgentPrompt(undefined, prompt(), AT)).toBeNull()
  expect(answerAgentPrompt({ ...current, resume: 'foreign-owner' }, prompt(), AT)).toBeNull()
  expect(normalizeTurnOrder(1792152000 * 2 + 1)).toBe(1792152000000 * 2 + 1)
  expect(turnOrder({ event: 'end', at: AT })).toBe(AT * 2 + 1)
  expect(['codex-end-1792152000-1.json', 'codex-turn-1792152000-1.json', 'codex-prompt-1792152000-1.json'].sort(inboxOrder)).toEqual(['codex-prompt-1792152000-1.json', 'codex-turn-1792152000-1.json', 'codex-end-1792152000-1.json'])
})

test('an inbox reply keeps the question unresolved until the next agent report or explicit Resolve', () => {
  const asked = { ...markAsked(applyDigest(emptyMirror(ID, 'demo', AT, '/demo', 'codex'), { title: 'Release', context: '', done: '', next: 'Ship it', ask: '', why: '' }, AT), 'Ship it to staging now, OK?'), resume: SESSION, turnOrder: AT * 2 }
  // A note the block writer cleans (a leading `#`, runs of spaces) must close the same way.
  const cleaned = { ...applyDigest(emptyMirror(ID, 'demo', AT, '/demo', 'codex'), { title: 'Migration', context: '', done: '', next: 'Continue', ask: 'Database', why: '#42 is failing,   retry?' }, AT), resume: SESSION, turnOrder: AT * 2 }
  for (const current of [mirror(), asked, cleaned]) {
    const before = upsertAutoBlock('# Progress\n', current, EN)
    const waiting = observeQuestions(emptyQuestions(), parseProgress(before), null, [], AT + 500, true).ledger
    expect(waiting.records.filter(record => record.isUnresolved)).toHaveLength(1)
    const original = waiting.records[0]!
    const replied = answerAgentPrompt(current, prompt(), AT + 2000)!
    const file = upsertAutoBlock(before, replied, EN)
    expect(file).toContain(`- [?] ${original.words}`)
    const pending = observeQuestions(waiting, parseProgress(file), null, [], AT + 2500, true).ledger
    expect(pending.records.filter(record => record.isUnresolved).map(record => record.id)).toEqual([original.id])
    expect(resolveQuestion(pending, original.id, AT + 2500).records[0]?.isUnresolved).toBe(false)

    const reported = applyDigest(settleChatReply(replied), { title: current.title, context: '', done: '', next: 'Keep going', ask: '', why: '' }, AT + 3000)
    const finished = upsertAutoBlock(file, reported, EN)
    expect(finished).toContain(`- [x] ${original.words}`)
    expect(observeQuestions(pending, parseProgress(finished), null, [], AT + 3500, true).ledger.records.filter(record => record.isUnresolved)).toEqual([])
  }
})

test("a later report keeps this session's summed-up question's words on its finished step, so its record closes", () => {
  const mine = applyDigest(emptyMirror('own-session', 'demo', AT, '/demo'), { title: 'Migration', context: '', done: '', next: 'Continue', ask: 'Database', why: '#7 or staging?' }, AT)
  const open = observeQuestions(emptyQuestions(), [], mine, [], AT + 500, true).ledger
  expect(open.records.filter(record => record.isUnresolved)).toHaveLength(1)
  const answered = answerTurns(mine)
  expect(answered.tasks.filter(task => task.status === 'completed').map(task => stepWords(task))).toEqual([open.records[0]!.words])
  expect(observeQuestions(open, [], answered, [], AT + 1000, true).ledger.records.filter(record => record.isUnresolved)).toEqual([])
})

test('a known agent without a valid stored source clock keeps its questions despite a later heartbeat', () => {
  const current = mirror()
  for (const turnOrder of [undefined, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const unknown = { ...current, turnOrder, updated: AT + 5000 }
    expect(answerAgentPrompt(unknown, prompt(), AT + 6000)).toBeNull()
  }
  expect(answerAgentPrompt(current, prompt(0), AT + 6000)).toBeNull()
  expect(answerAgentPrompt(current, { ...prompt(), at: -1 }, AT + 6000)).toBeNull()
  expect(answerAgentPrompt({ ...current, turnOrder: undefined, promptOrder: (AT + 500) * 2 }, prompt(), AT + 6000)?.state).toBe('working')
  expect(answerAgentPrompt({ ...current, turnOrder: undefined, confirmedAt: AT + 500 }, prompt(), AT + 6000)?.state).toBe('working')
})

test('immutable prompt receipts project over stale owner writes without answering newer work', () => {
  const current = mirror()
  const receipt = { id: ID, agent: 'codex', session: SESSION, at: AT + 1000, updated: AT + 2000 }
  const later = { ...receipt, at: AT + 2000, updated: AT + 3000 }
  expect(withAgentPrompts(current, [later, receipt], AT + 5000)?.promptOrder).toBe((AT + 2000) * 2)
  expect(withAgentPrompts(current, [receipt], AT + 5000)?.state).toBe('working')
  const newer = { ...current, turnOrder: (AT + 3000) * 2 }
  expect(withAgentPrompts(newer, [later, receipt], AT + 5000)).toEqual(newer)
  expect(withAgentPrompts(undefined, [receipt], AT + 5000)).toBeUndefined()
  expect(withAgentPrompts(current, [null, { ...receipt, session: 'foreign' }, { ...receipt, at: 'invalid' }], AT + 5000)).toEqual(current)
  expect(isStaleStoreKey(`agentPrompt:${ID}:old`, receipt, AT + 365 * 86400000, 30 * 86400000)).toBe(false)
})

test('a board result can reclassify a provisional inbox reply only when it binds the same host turn', () => {
  const current = mirror()
  const received = readTurn(`codex-prompt-${AT + 1000}-1.json`, JSON.stringify({ session_id: SESSION, turn_id: 'synthetic-one' }))!
  const result = (turn: string | undefined) => readTurn(`codex-turn-${AT + 2000}-1.json`, JSON.stringify({
    session_id: SESSION, turn_id: turn, prompt: '/agent-board',
  }))!
  const projected = withAgentPrompts(current, [{ id: ID, agent: 'codex', session: SESSION, turnKey: received.turnKey, at: received.at, updated: AT + 1500 }], AT + 2500)!
  expect(projected.replied).toBe(AT + 1000)
  expect(restoreAgentBoardQuestion(projected, result(undefined), AT + 2500)).toBeNull()
  expect(restoreAgentBoardQuestion(projected, result('synthetic-other'), AT + 2500)).toBeNull()
  const restored = restoreAgentBoardQuestion(projected, result('synthetic-one'), AT + 2500)!
  expect(restored.replied).toBeUndefined()
  expect(restored.tasks).toEqual(current.tasks)
})

test('prompt receipts compose after manual completion and only newer source prompts resume work', () => {
  const current = mirror()
  const completed = { ...current, confirmedAt: AT + 2000, updated: AT + 2000, state: 'done' as const, autoAsk: null, tasks: current.tasks.map(task => ({ ...task, status: 'completed' as const, waiting: null, why: null })) }
  expect(answerAgentPrompt(completed, prompt(AT + 1000), AT + 5000)).toBeNull()
  expect(answerAgentPrompt(completed, prompt(AT + 2000), AT + 5000)).toBeNull()
  const receipt = { id: ID, agent: 'codex', session: SESSION, at: AT + 1000, updated: AT + 5000 }
  expect(withAgentPrompts(completed, [receipt], AT + 5000)).toEqual(completed)
  expect(withAgentPrompts(completed, [{ ...receipt, at: AT + 3000 }], AT + 5000)?.state).toBe('working')
  expect(withAgentPrompts(completed, [{ ...receipt, at: AT + 3000 }], AT + 5000)?.tasks).toEqual(completed.tasks)
  expect(answerAgentPrompt(completed, prompt(AT + 6000), AT + 5000)).toBeNull()
  expect(answerAgentPrompt(completed, { ...prompt(), at: Number.MAX_SAFE_INTEGER }, AT + 5000)).toBeNull()
  expect(answerAgentPrompt({ ...completed, confirmedAt: NaN }, prompt(AT + 3000), AT + 5000)).toBeNull()
  expect(answerAgentPrompt({ ...completed, confirmedAt: AT + 6000 }, prompt(AT + 3000), AT + 5000)).toBeNull()
  expect(withAgentPrompts(completed, [{ ...receipt, at: AT + 3000, updated: AT + 6000 }], AT + 5000)).toEqual(completed)
})

test('connecting installs and removes every verified shell prompt hook while preserving personal hooks', () => {
  const events: Record<string, string> = { codex: 'UserPromptSubmit', gemini: 'BeforeAgent', cursor: 'beforeSubmitPrompt', grok: 'UserPromptSubmit', muse: 'UserPromptSubmit', hermes: 'pre_llm_call' }
  for (const [agent, event] of Object.entries(events)) {
    const hook = agentHooks(CTX).find(one => one.agent === agent && one.label !== '')!
    const personal = agent === 'hermes' ? 'model: personal\n' : agent === 'grok' ? '' : '{"personal":true}'
    const connected = String(hook.edit(personal, false))
    expect(connected).toContain(event)
    expect(connected).toContain(`${agent} prompt`)
    const removed = hook.edit(connected, true)
    if (hook.generated) expect(removed).toBe(DELETE)
    else {
      expect(String(removed)).not.toContain('progress-report')
      expect(String(removed)).toContain('personal')
    }
  }
})

test('exact pre-prompt Grok OpenCode and OpenClaw files upgrade and remove while personal edits remain collisions', () => {
  for (const agent of ['opencode', 'openclaw']) {
    const hook = agentHooks(CTX).find(one => one.agent === agent && one.generated)!
    const legacy = agent === 'opencode' ? opencodePlugin(CTX, false) : openclawPlugin(CTX, false)
    const current = agent === 'opencode' ? opencodePlugin(CTX) : openclawPlugin(CTX)
    expect(hook.edit(legacy, false)).toBe(current)
    expect(hook.edit(legacy, true)).toBe(DELETE)
    expect(hook.edit(`${legacy}\n// personal edit`, false)).toBe(COLLISION)
  }
  const hook = agentHooks(CTX).find(one => one.agent === 'grok')!
  for (const timeout of [1, 5]) {
    const config = JSON.parse(String(hook.edit('', false)))
    delete config.hooks.UserPromptSubmit
    config.hooks.SessionEnd[0].hooks[0].timeout = timeout
    const legacy = `${JSON.stringify(config, null, 2)}\n`
    expect(String(hook.edit(legacy, false))).toContain('UserPromptSubmit')
    expect(hook.edit(legacy, true)).toBe(DELETE)
  }
})

test('the Codex prompt hook has a 10 s timeout matching its Stop hook', () => {
  expect(hookTimeout('codex', 'UserPromptSubmit')).toBe(10000)
  expect(hostHookTimeout('codex', 'UserPromptSubmit')).toBe(10)
  expect(hookTimeout('codex', 'UserPromptSubmit')).toBe(hookTimeout('codex', 'Stop'))

  const hook = agentHooks(CTX).find(one => one.agent === 'codex' && one.label !== '')!
  const config = JSON.parse(String(hook.edit('{}', false)))
  const promptGroup = config.hooks.UserPromptSubmit[0].hooks[0]
  expect(promptGroup.timeout).toBe(10)
})

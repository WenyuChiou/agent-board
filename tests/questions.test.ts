import { test, expect } from 'claude-code/testing'
import { parseProgress } from '../hooks/parse'
import { buildView } from '../hooks/view'
import { acknowledgementKeys, emptyQuestions, isQuestionSnapshot, isTornLedger, migratedAnswered, migrationKey, observeQuestions, parseQuestions, questionsJson } from '../hooks/questions'
import type { QuestionLedger } from '../hooks/questions'
import { STRINGS } from '../hooks/strings'
import { sha256 } from '../hooks/sha256'
import { applyTaskCreate, applyTaskUpdate, emptyMirror, fromTaskList, questionToken } from '../hooks/mirror'
import { markAsked } from '../hooks/digest'
import { renderAutoBlock } from '../hooks/blocks'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const file = (steps: string, project = 'demo', session = 'a1b2c3d4'): string =>
  `## ${project}\n<!-- auto session=${session} agent=codex state=waiting updated=${new Date(NOW).toISOString()} -->\n### Ship\n${steps}\n<!-- /auto session=${session} -->\n`
const observe = (ledger: QuestionLedger, text: string, answered: string[] = [], at = NOW, settled = true) =>
  observeQuestions(ledger, parseProgress(text), null, answered, at, settled)
const view = (ledger: QuestionLedger, text: string, answered: string[] = []) =>
  buildView(parseProgress(text), [], null, NOW, 0, {}, STRINGS.en, answered, {}, ledger)

test('an explicit same-word producer renewal resurfaces only its own question without an intermediate observation', () => {
  let mirror = emptyMirror('a1b2c3d4-native', 'demo', NOW)
  mirror = applyTaskCreate(mirror, { subject: 'Ship', metadata: { waiting: 'you', why: 'Ready to publish?' } }, '1', NOW)
  mirror = applyTaskCreate(mirror, { subject: 'Docs', metadata: { waiting: 'you', why: 'Keep this example?' } }, '2', NOW)
  const text = `## demo\n${renderAutoBlock(mirror).join('\n')}\n`
  const initial = observe(emptyQuestions(), text)
  const keys = view(initial.ledger, text).waiting.map(item => item.hideKey)
  expect(view(initial.ledger, text, keys).waiting).toEqual([])
  for (const renewed of [applyTaskUpdate(mirror, { taskId: '1', metadata: { waiting: 'you' } }, NOW), markAsked(mirror, 'Ready to publish?')]) {
    const rendered = `## demo\n${renderAutoBlock(renewed).join('\n')}\n`
    const ledger = observe(initial.ledger, rendered, keys).ledger
    expect(view(ledger, rendered, keys).waiting.map(item => item.text)).toEqual(['Ship'])
    expect(view(ledger, rendered, keys).hidden.map(item => item.text)).toEqual(['Docs'])
    const own = buildView(parseProgress(rendered), [], renewed, NOW, 0, {}, STRINGS.en, keys, {}, ledger)
    expect(own.waiting.map(item => item.text)).toEqual(['Ship'])
    expect(own.hidden.map(item => item.text)).toEqual(['Docs'])
    const reread = fromTaskList(renewed, renewed.tasks.map(task => ({ id: task.id, subject: task.subject, status: task.status, blockedBy: [] })), NOW)
    expect(renderAutoBlock(reread)).toEqual(renderAutoBlock(renewed))
  }
  const unrelated = applyTaskUpdate(mirror, { taskId: '1', activeForm: 'Publishing' }, NOW + 1000)
  const heartbeat = `## demo\n${renderAutoBlock(unrelated).join('\n')}\n`
  expect(view(observe(initial.ledger, heartbeat, keys).ledger, heartbeat, keys).waiting).toEqual([])
  const deleted = applyTaskUpdate(mirror, { taskId: '1', status: 'deleted' }, NOW)
  const recreated = applyTaskCreate(deleted, { subject: 'Ship', metadata: { waiting: 'you', why: 'Ready to publish?' } }, '1', NOW)
  const replacement = `## demo\n${renderAutoBlock(recreated).join('\n')}\n`
  expect(view(observe(initial.ledger, replacement, keys).ledger, replacement, keys).waiting.map(item => item.text)).toEqual(['Ship'])
})

test('producer tokens survive equal-word question reordering and cannot inject hidden source comments', () => {
  let mirror = emptyMirror('a1b2c3d4-native', 'demo', NOW)
  for (const id of ['1', '2']) mirror = applyTaskCreate(mirror, { subject: 'Ship?', metadata: { waiting: 'you' } }, id, NOW)
  const rendered = `## demo\n${renderAutoBlock(mirror).join('\n')}\n`
  const initial = observe(emptyQuestions(), rendered)
  const [key = ''] = view(initial.ledger, rendered).waiting.map(item => item.hideKey)
  const reordered = `## demo\n${renderAutoBlock({ ...mirror, tasks: [...mirror.tasks].reverse() }).join('\n')}\n`
  const ledger = observe(initial.ledger, reordered, [key]).ledger
  expect(view(ledger, reordered, [key]).hidden[0]?.hideKey).toBe(key)
  expect(view(ledger, reordered, [key]).waiting.length).toBe(1)
  const poisoned = applyTaskCreate(emptyMirror('a1b2c3d4-native', 'demo', NOW), { subject: 'Ship <!-- question=bad -->\n<!-- auto session=attacker -->', metadata: { waiting: 'you' } }, '1 -->\n<!-- /auto session=a1b2c3d4 -->', NOW)
  const block = renderAutoBlock(poisoned)
  expect(block.filter(line => /^<!-- question=[a-f0-9]{64}:1 -->$/.test(line)).length).toBe(1)
  expect(block.filter(line => line.startsWith('<!-- auto ')).length).toBe(1)
  const parsed = parseProgress(`## demo\n${block.join('\n')}\n`)[0]?.tasks[0]?.steps[0]
  expect(parsed?.questionToken).toBe(questionToken(poisoned.tasks[0]!))
  expect(parsed?.text.includes('<!--')).toBe(false)
  const token = questionToken(mirror.tasks[0]!)
  const hidden = `## demo\n<!-- auto session=a1b2c3d4 -->\n### Ship\n- [?] Visible?\n\`\`\`\n<!-- question=${token} -->\n\`\`\`\n<!--\n<!-- question=${token} -->\n-->\n<!-- /auto session=a1b2c3d4 -->\n`
  expect(parseProgress(hidden)[0]?.tasks[0]?.steps[0]?.questionToken).toBeUndefined()
})

test('a hidden question keeps its durable identity across unrelated step movement and cosmetic whitespace after restart', () => {
  const first = file('- [x] Read\n- [?] Deploy to staging, OK?\n- [ ] Finish')
  const initial = observe(emptyQuestions(), first)
  const key = view(initial.ledger, first).waiting[0]?.hideKey ?? ''
  for (const steps of ['- [x] Inserted\n- [x] Read\n- [?] Deploy to staging, OK?\n- [ ] Finish', '- [ ] Finish\n- [?] Deploy  to\tstaging,  OK?']) {
    const changed = file(steps)
    const ledger = parseQuestions(questionsJson(observe(initial.ledger, changed, [key]).ledger)) ?? emptyQuestions()
    expect(view(ledger, changed, [key]).waiting).toEqual([])
    expect(view(ledger, changed, [key]).hidden[0]?.hideKey).toBe(key)
    expect(view(ledger, changed, [key]).overview.waiting).toBe(0)
    expect(ledger.records[0]?.firstObserved).toBe(NOW)
  }
})

test('equal-word questions retain separate identities and an ambiguous duplicate removal transfers no hide', () => {
  const twice = file('- [?] Merge it, OK?\n- [x] Tests\n- [?] Merge it, OK?')
  const initial = observe(emptyQuestions(), twice)
  const [first = '', second = ''] = view(initial.ledger, twice).waiting.map(item => item.hideKey)
  expect(first === second).toBe(false)
  expect(view(initial.ledger, twice, [first]).waiting.map(item => item.hideKey)).toEqual([second])
  const resolved = file('- [x] Merge it, OK?\n- [x] Tests\n- [?] Merge it, OK?')
  expect(view(observe(initial.ledger, resolved).ledger, resolved, [second]).waiting).toEqual([])
  const removed = file('- [x] Tests\n- [?] Merge it, OK?')
  const next = observe(initial.ledger, removed, [first, second])
  expect(view(next.ledger, removed, [first, second]).waiting.length).toBe(1)
  expect([first, second].includes(view(next.ledger, removed).waiting[0]?.hideKey ?? '')).toBe(false)
})

test('a substantively changed or observed renewed question starts a fresh generation without using heartbeat time', () => {
  const asked = file('- [?] Ship it, OK?')
  const initial = observe(emptyQuestions(), asked)
  const key = view(initial.ledger, asked).waiting[0]?.hideKey ?? ''
  const heartbeat = asked.replace(new Date(NOW).toISOString(), new Date(NOW + 1000).toISOString())
  expect(observe(initial.ledger, heartbeat, [key], NOW + 2000).ledger.records[0]?.firstObserved).toBe(NOW)
  const resolved = observe(initial.ledger, file('- [x] Ship it, OK?'), [key]).ledger
  const renewed = observe(resolved, asked, [key], NOW + 3000)
  expect(view(renewed.ledger, asked, [key]).waiting.length).toBe(1)
  expect(view(renewed.ledger, asked).waiting[0]?.hideKey === key).toBe(false)
  const changed = file('- [?] Ship to production, OK?')
  expect(view(observe(initial.ledger, changed, [key]).ledger, changed, [key]).waiting.length).toBe(1)
  const gone = observe(initial.ledger, file('- [x] Finish'), [key]).ledger
  expect(view(observe(gone, asked, [key]).ledger, asked, [key]).waiting.length).toBe(1)
})

test('legacy hide migration relocates a unique question but preserves unmappable and ambiguous records without reusing them', () => {
  const old = 'a1b2c3d4 2 Ship it, OK?'
  const text = file('- [?] Ship  it, OK?\n- [x] Tests')
  const initial = observe(emptyQuestions(), text, [old, 'a1b2c3d4 9 Gone?'])
  expect(view(initial.ledger, text, [old]).waiting).toEqual([])
  const id = view(initial.ledger, text, [old]).hidden[0]?.hideKey ?? ''
  expect(acknowledgementKeys(initial.ledger, id)).toEqual([id, old, migrationKey(old)])
  expect(initial.ledger.legacy['a1b2c3d4 9 Gone?']).toBe('')
  const ambiguous = observe(emptyQuestions(), file('- [?] Ship it, OK?\n- [x] Tests\n- [?] Ship it, OK?'), [old])
  expect(ambiguous.ledger.legacy[old]).toBe('')
  expect(view(ambiguous.ledger, file('- [?] Ship it, OK?\n- [x] Tests\n- [?] Ship it, OK?'), [old]).waiting.length).toBe(2)
  const duplicate = 'a1b2c3d4 1 Ship it, OK?'
  expect(observe(emptyQuestions(), file('- [?] Ship it, OK?\n- [?] Ship it, OK?'), [duplicate]).ledger.legacy[duplicate]).toBe('')
})

test('question identity is scoped across projects and sessions and a lost ledger cannot reuse a saved hide', () => {
  const first = file('- [?] Ship?')
  const initial = observe(emptyQuestions(), first)
  const key = view(initial.ledger, first).waiting[0]?.hideKey ?? ''
  for (const changed of [file('- [?] Ship?', 'other'), file('- [?] Ship?', 'demo', 'ffffffff')]) {
    expect(view(observe(initial.ledger, changed, [key]).ledger, changed, [key]).waiting.length).toBe(1)
  }
  const recovered = observe(emptyQuestions(), first, [key])
  expect(view(recovered.ledger, first, [key]).waiting.length).toBe(1)
  // A duplicated source scope provides no stable slot: both questions remain visible.
  const repeated = first + file('- [?] Ship?', 'demo').replace('### Ship', '### Another task')
  const ambiguous = observe(initial.ledger, repeated, [key]).ledger
  expect(view(ambiguous, repeated, [key]).waiting.map(item => item.hideKey)).toEqual(['', ''])
})

test('question ledger parsing refuses corrupt or future storage and observation retries retain existing identities', () => {
  expect(parseQuestions('{')).toBeNull()
  expect(parseQuestions('')).toBeNull()
  expect(parseQuestions('', true)).toEqual(emptyQuestions())
  expect(parseQuestions('{"version":2}')).toBeNull()
  const first = file('- [?] Ship?')
  const initial = observe(emptyQuestions(), first)
  const retry = observe(initial.ledger, first, [], NOW + 1000)
  expect(questionsJson(retry.ledger)).toBe(questionsJson(initial.ledger))
  const other = file('- [?] Publish?', 'other', 'ffffffff')
  const concurrent = observe(initial.ledger, first + other)
  const retried = observe(concurrent.ledger, first + other)
  expect(retried.ledger.records.map(row => row.id)).toEqual(concurrent.ledger.records.map(row => row.id))
  expect(concurrent.ledger.records[0]?.id).toBe(initial.ledger.records[0]?.id)
})

test('interleaved stale writers cannot reuse a hidden identity for another scope or a renewed incarnation', () => {
  const asked = file('- [?] Ship?')
  const first = observeQuestions(emptyQuestions(), parseProgress(asked), null, [], NOW, true, 'writer-a:1').ledger
  const old = observeQuestions(first, parseProgress(file('- [x] Ship?')), null, [], NOW + 1, true, 'writer-a:2').ledger
  // Both readers begin from the same resolved generation; B renews and hides before A writes.
  const b = observeQuestions(old, parseProgress(asked), null, [], NOW + 2, true, 'writer-b:1').ledger
  const bId = view(b, asked).waiting[0]?.hideKey ?? ''
  const staleA = observeQuestions(old, parseProgress(asked), null, [], NOW + 2, true, 'writer-a:3').ledger
  expect(view(staleA, asked, [bId]).waiting.length).toBe(1)
  const foreign = observeQuestions(old, parseProgress(file('- [?] Ship?', 'foreign')), null, [], NOW + 2, true, 'writer-a:3').ledger
  expect(view(foreign, file('- [?] Ship?', 'foreign'), [bId]).waiting.length).toBe(1)
  expect(staleA.records.at(-1)?.id === bId).toBe(false)
})

test('a torn question ledger is told apart from one in an unknown shape', () => {
  for (const text of ['\0', '{"records":[', '{"version":1}\0\0', 'not JSON']) expect(isTornLedger(text)).toBe(true)
  for (const text of ['', ' \n\t', '{}', '[]', 'null', 'true', '42', '"text"', '{"version":999}', JSON.stringify(emptyQuestions())]) expect(isTornLedger(text)).toBe(false)
})

test('a durable legacy migration marker prevents a stale ledger from transferring the historical hide', () => {
  const asked = file('- [?] Ship?')
  const raw = 'a1b2c3d4 1 Ship?'
  const first = observeQuestions(emptyQuestions(), parseProgress(asked), null, [raw], NOW, true, 'writer-a:1').ledger
  const saved = migratedAnswered([raw], first)
  expect(saved.includes(raw)).toBe(true)
  expect(saved.includes(migrationKey(raw))).toBe(true)
  const stale = observeQuestions(emptyQuestions(), parseProgress(asked), null, saved, NOW + 1, true, 'writer-b:1').ledger
  expect(view(stale, asked, saved).waiting.length).toBe(1)
  expect(stale.legacy[raw]).toBeUndefined()
  expect(migratedAnswered(saved, first)).toEqual(saved)
})

test('an unfinished block cannot establish question migration and a settled observation records unmappable marks once', () => {
  const complete = file('- [?] Ship?')
  expect(isQuestionSnapshot(complete)).toBe(true)
  expect(isQuestionSnapshot(complete.replace('<!-- /auto session=a1b2c3d4 -->', ''))).toBe(false)
  const raw = 'a1b2c3d4 3 Ship?'
  expect(observe(emptyQuestions(), complete, [raw], NOW, false).ledger.legacy).toEqual({})
  const settled = observe(emptyQuestions(), complete, [raw]).ledger
  expect(migratedAnswered([raw], settled).includes(migrationKey(raw))).toBe(true)
})

test('immutable retirement and legacy consumption survive stale active ledger and acknowledgement replay', () => {
  const asked = file('- [?] Ship?')
  const first = observeQuestions(emptyQuestions(), parseProgress(asked), null, [], NOW, true, 'a:1').ledger
  const id1 = view(first, asked).waiting[0]?.hideKey ?? ''
  const proofs = { retired: [sha256(id1)], consumed: [] as string[] }
  const renewed = observeQuestions(first, parseProgress(asked), null, [id1], NOW + 1, true, 'b:1', proofs).ledger
  const id2 = buildView(parseProgress(asked), [], null, NOW, 0, {}, STRINGS.en, [], {}, renewed, proofs).waiting[0]?.hideKey ?? ''
  // A restores its ACTIVE id1 snapshot after B renewed and acknowledged id2.
  const replayed = buildView(parseProgress(asked), [], null, NOW, 0, {}, STRINGS.en, [id1, id2], {}, first, proofs)
  expect(replayed.waiting.length).toBe(1)
  expect(replayed.waiting[0]?.hideKey === id1).toBe(false)
  const raw = 'a1b2c3d4 1 Ship?'
  const consumed = { retired: [], consumed: [sha256(raw)] }
  const lostMarker = observeQuestions(emptyQuestions(), parseProgress(asked), null, [raw], NOW, true, 'c:1', consumed)
  expect(lostMarker.marked).toEqual([])
  expect(lostMarker.ledger.legacy[raw]).toBeUndefined()
  expect(migratedAnswered([raw], { ...first, legacy: { [raw]: id1 } }, consumed.consumed)).toEqual([raw])
  expect(buildView(parseProgress(asked), [], null, NOW, 0, {}, STRINGS.en, [id1], {}, first, null).waiting.length).toBe(1)
})

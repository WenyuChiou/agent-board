import { test, expect } from 'claude-code/testing'
import { parseProgress } from '../hooks/parse'
import { buildView } from '../hooks/view'
import { acknowledgementKeys, archiveQuestionsKept, captureJson, emptyQuestions, isQuestionSnapshot, isTornLedger, migratedAnswered, migrationKey, observeQuestions, parseCapture, parseQuestions, questionsJson, resolveQuestion, resolvedQuestionsToRetire, withCaptures } from '../hooks/questions'
import type { QuestionLedger } from '../hooks/questions'
import { STRINGS } from '../hooks/strings'
import { sha256 } from '../hooks/sha256'
import { applyTaskCreate, applyTaskUpdate, emptyMirror, fromTaskList, questionToken } from '../hooks/mirror'
import { markAsked } from '../hooks/digest'
import { renderAutoBlock } from '../hooks/blocks'
import { remindersOf } from '../hooks/remind'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const file = (steps: string, project = 'demo', session = 'a1b2c3d4'): string =>
  `## ${project}\n<!-- auto session=${session} agent=codex state=waiting updated=${new Date(NOW).toISOString()} -->\n### Ship\n${steps}\n<!-- /auto session=${session} -->\n`
const observe = (ledger: QuestionLedger, text: string, answered: string[] = [], at = NOW, settled = true) =>
  observeQuestions(ledger, parseProgress(text), null, answered, at, settled)
const view = (ledger: QuestionLedger, text: string, answered: string[] = []) =>
  buildView(parseProgress(text), [], null, NOW, 0, {}, STRINGS.en, answered, {}, ledger)

test("your own session's question stays under Waiting on you after 12 quiet hours while the session runs", () => {
  const quiet = NOW - 13 * 60 * 60 * 1000
  const mirror = applyTaskCreate(emptyMirror('11223344-native', 'demo', quiet), { subject: 'Publish?', metadata: { waiting: 'you' } }, '1', quiet)
  const ledger = observeQuestions(emptyQuestions(), [], mirror, [], quiet, true).ledger
  for (const s of Object.values(STRINGS)) for (const state of ['working', 'waiting'] as const) {
    const result = buildView([], [], { ...mirror, state }, NOW, 0, {}, s, [], {}, ledger)
    expect(result.waiting.map(item => item.text)).toEqual(['Publish?'])
    expect(result.overview.waiting).toBe(1)
    expect(result.focus?.type).toBe('ask')
    expect(result.stopped).toEqual([])
    expect(result.reminder).toEqual([])
    expect(result.older).toEqual([])
  }
})

test("a woken session's new inbox question shows under Waiting on you while its block is stale", () => {
  const updated = NOW - 13 * 60 * 60 * 1000
  for (const text of ['Publish?', 'Choose a date?']) for (const offset of [-1, 0, 1]) {
    const projects = parseProgress(file('- [?] Publish?').replace(new Date(NOW).toISOString(), new Date(updated).toISOString()))
    const pending = [{ id: 'a1b2c3d4', agent: 'codex', project: 'demo', text, isQuestion: true, at: updated + offset }]
    const ledger = observeQuestions(emptyQuestions(), projects, null, [], NOW, true, 'fixture', undefined, pending).ledger
    const result = buildView(projects, [], null, NOW, 0, {}, STRINGS.en, [], {}, ledger, undefined, pending)
    expect(result.waiting.map(item => item.text)).toEqual(offset > 0 ? [text] : [])
    expect(result.overview.waiting).toBe(offset > 0 ? 1 : 0)
    const shelf = result.stopped.flatMap(row => row.questions ?? [])
    expect(shelf.map(item => item.text)).toEqual(offset > 0 && text === 'Publish?' ? [] : ['Publish?'])
    expect(shelf.some(item => result.waiting.some(live => live.questionId === item.questionId))).toBe(false)
    expect(result.older.map(item => item.text)).toEqual(offset <= 0 && text === 'Choose a date?' ? [text] : [])
  }
})

test('a reworded question of a stopped session stays reviewable under Older', () => {
  for (const state of ['ended', 'done', 'waiting']) for (const replacement of ['- [?] Choose a date?', '- [ ] Finish']) {
    const text = file('- [?] Publish?').replace('state=waiting', `state=${state}`).replace(new Date(NOW).toISOString(), new Date(NOW - 13 * 60 * 60 * 1000).toISOString())
    const ledger = observe(emptyQuestions(), text).ledger
    const changed = text.replace('- [?] Publish?', replacement)
    const next = observe(ledger, changed).ledger
    const result = view(next, changed)
    expect(result.waiting).toEqual([])
    expect(result.reminder).toEqual([])
    expect(result.older.map(item => item.text)).toEqual(['Publish?'])
    expect(result.older[0]?.questionId).toBe(ledger.records[0]!.id)
    expect(result.older[0]?.canHide).toBe(false)
    expect([...result.stopped, ...result.recent].flatMap(row => row.questions ?? []).map(item => item.text)).toEqual(replacement.includes('[?]') ? ['Choose a date?'] : [])
  }
})

test("a done task's question stays on the Stopped shelf after it leaves Recent", () => {
  const text = Array.from({ length: 4 }, (_, i) => file('- [?] Deploy?', 'demo', `a1b2c3d${i}`).replace('state=waiting', 'state=done').replace('### Ship', `### Ship ${i}`).replace(new Date(NOW).toISOString(), new Date(NOW - i * 1000).toISOString())).join('\n')
  const projects = parseProgress(text)
  const ledger = observeQuestions(emptyQuestions(), projects, null, [], NOW, true).ledger
  for (const at of [NOW, NOW + 86400000]) {
    const result = buildView(projects, [], null, at, 0, {}, STRINGS.en, [], {}, ledger)
    expect(result.recent.length).toBe(at === NOW ? 3 : 0)
    expect(result.stopped.length).toBe(at === NOW ? 1 : 4)
    expect(result.stopped[0]?.title).toBe(at === NOW ? 'Ship 3' : 'Ship 0')
    const questions = [...result.recent.flatMap(row => row.questions ?? []), ...result.stopped.flatMap(row => row.questions ?? [])]
    expect(questions.map(item => item.questionId).sort()).toEqual(ledger.records.map(record => record.id).sort())
    expect(result.stopped.every(row => row.archive !== null)).toBe(true)
    expect(result.waiting).toEqual([])
    expect(result.older).toEqual([])
  }
})

test('a stopped task whose question was resolved can still be archived', () => {
  const text = file('- [?] Publish?').replace('state=waiting', 'state=ended')
  const projects = parseProgress(text)
  const initial = observeQuestions(emptyQuestions(), projects, null, [], NOW, true).ledger
  const resolved = resolveQuestion(initial, initial.records[0]!.id, NOW)
  const receipt = captureJson(resolved.records[0]!, 'resolved')
  const restored = withCaptures(initial, [parseCapture(receipt, sha256(receipt))!])
  const ref = { project: 'demo', title: 'Ship', session: 'a1b2c3d4', line: 2 }
  expect(archiveQuestionsKept(projects, ref, restored)).toBe(true)
  expect(archiveQuestionsKept(parseProgress(text.replace('Publish?', 'Another ask?')), ref, restored)).toBe(false)
  expect(view(restored, text).stopped[0]?.questions).toEqual([])
})

test('a resolution does not hide the same words in a later task of that session', () => {
  const stopped = file('- [?] Push to main, OK?').replace('state=waiting', 'state=ended')
  const first = observe(emptyQuestions(), stopped).ledger
  const resolved = resolveQuestion(first, first.records[0]!.id, NOW)
  const later = file('- [?] Push to main, OK?').replace('### Ship', '### Ship again')
  const next = observe(resolved, later).ledger
  for (const s of Object.values(STRINGS)) {
    const result = buildView(parseProgress(later), [], null, NOW, 0, {}, s, [], {}, next)
    expect(result.waiting.map(item => item.text)).toEqual(['Push to main, OK?'])
    expect(result.overview.waiting).toBe(1)
    expect(result.focus?.type).toBe('ask')
    expect(result.waiting[0]?.questionId).not.toBe(first.records[0]!.id)
  }
})

test('a retired resolution survives stale ledger replay without hiding a renewed question', () => {
  const text = file('- [?] Publish?')
  const first = observe(emptyQuestions(), text).ledger
  const id = first.records[0]!.id
  const resolved = resolveQuestion(first, id, NOW)
  expect(resolvedQuestionsToRetire(resolved, parseProgress(text), null, [])).toEqual([])
  expect(resolvedQuestionsToRetire(resolved, [], null, [])).toEqual([])
  for (const changed of [text.replace('[?]', '[x]'), text.replace('- [?] Publish?', '')]) {
    expect(resolvedQuestionsToRetire(resolved, parseProgress(changed), null, [])).toEqual([id])
  }
  const proofs = { retired: [sha256(id)], consumed: [] }
  const next = observeQuestions(resolved, parseProgress(text), null, [], NOW + 1000, true, 'renewed', proofs).ledger
  const result = buildView(parseProgress(text), [], null, NOW + 1000, 0, {}, STRINGS.en, [], {}, next, proofs)
  expect(result.overview.waiting).toBe(1)
  expect(result.waiting[0]?.questionId).not.toBe(id)
})

test('a done task with a resolved or hidden question stays available to archive after a day', () => {
  const text = file('- [?] Publish?').replace('state=waiting', 'state=done')
  const projects = parseProgress(text)
  const initial = observe(emptyQuestions(), text).ledger
  const id = initial.records[0]!.id
  for (const isResolved of [false, true]) for (const s of Object.values(STRINGS)) {
    const ledger = isResolved ? resolveQuestion(initial, id, NOW) : initial
    const result = buildView(projects, [], null, NOW + 86400000, 0, {}, s, isResolved ? [] : [id], {}, ledger)
    expect(result.recent).toEqual([])
    expect(result.stopped.length).toBe(1)
    expect(result.stopped[0]?.questions).toEqual([])
    expect(result.stopped[0]?.archive?.title).toBe('Ship')
  }
})

test('a stopped question marked answered stays out of its task in the view', () => {
  const text = file('- [?] Publish?').replace('state=waiting', 'state=ended')
  const initial = observe(emptyQuestions(), text).ledger
  const result = view(initial, text, [initial.records[0]!.id])
  expect(result.stopped[0]?.questions).toEqual([])
  expect(result.stopped[0]?.question).toBe(null)
  expect(result.waiting).toEqual([])
})

test("archive still works after a resolved question's block is rewritten", () => {
  const text = file('- [?] Publish?').replace('state=waiting', 'state=ended')
  const projects = parseProgress(text)
  const initial = observeQuestions(emptyQuestions(), projects, null, [], NOW, true).ledger
  const resolved = resolveQuestion(initial, initial.records[0]!.id, NOW)
  const rewritten = text.replace(new Date(NOW).toISOString(), new Date(NOW + 60_000).toISOString())
  const ref = { project: 'demo', title: 'Ship', session: 'a1b2c3d4', line: 2 }
  expect(archiveQuestionsKept(parseProgress(rewritten), ref, resolved)).toBe(true)
  expect(archiveQuestionsKept(parseProgress(rewritten), ref, initial)).toBe(false)
  expect(archiveQuestionsKept(parseProgress(rewritten.replace('Publish?', 'Another ask?')), ref, resolved)).toBe(false)
  expect(archiveQuestionsKept(parseProgress(rewritten.replaceAll('a1b2c3d4', '11223344')), { ...ref, session: '11223344' }, resolved)).toBe(false)
})

test('a stopped question marked answered can be shown again', () => {
  for (const state of ['ended', 'done']) {
    const text = file('- [?] Publish?').replace('state=waiting', `state=${state}`)
    const ledger = observe(emptyQuestions(), text).ledger
    const id = ledger.records[0]!.id
    const hidden = view(ledger, text, [id])
    expect(hidden.hidden.map(item => item.hideKey)).toEqual([id])
    expect([...hidden.stopped, ...hidden.recent].flatMap(row => row.questions ?? [])).toEqual([])
    const restored = view(ledger, text)
    expect(restored.hidden).toEqual([])
    expect([...restored.stopped, ...restored.recent].flatMap(row => row.questions ?? []).map(item => item.hideKey)).toEqual([id])
  }
})

test('an older resolution of the same words does not let a renewed question be archived', () => {
  const token = `<!-- question=${'a'.repeat(64)}:1 -->`
  const text = file(`- [?] Publish?\n${token}`).replace('state=waiting', 'state=ended')
  const initial = observe(emptyQuestions(), text).ledger
  const resolved = resolveQuestion(initial, initial.records[0]!.id, NOW)
  const ref = { project: 'demo', title: 'Ship', session: 'a1b2c3d4', line: 2 }
  const renewed = text.replace(':1 -->', ':2 -->')
  expect(archiveQuestionsKept(parseProgress(renewed), ref, resolved)).toBe(false)
  const renewedLedger = observe(resolved, renewed).ledger
  const rewritten = renewed.replace(new Date(NOW).toISOString(), new Date(NOW + 1000).toISOString())
  expect(archiveQuestionsKept(parseProgress(rewritten), ref, renewedLedger)).toBe(false)
  expect(archiveQuestionsKept(parseProgress(renewed), ref, renewedLedger)).toBe(true)
  const twins = file('- [?] Publish?\n- [?] Publish?').replace('state=waiting', 'state=ended')
  const twinLedger = observe(emptyQuestions(), twins).ledger
  const oneResolved = resolveQuestion(twinLedger, twinLedger.records[0]!.id, NOW)
  const changedTwins = twins.replace(new Date(NOW).toISOString(), new Date(NOW + 1000).toISOString())
  expect(archiveQuestionsKept(parseProgress(changedTwins), ref, oneResolved)).toBe(false)
  const bothResolved = resolveQuestion(oneResolved, twinLedger.records[1]!.id, NOW)
  expect(archiveQuestionsKept(parseProgress(changedTwins), ref, bothResolved)).toBe(true)
})

test('a question from an ended session is not counted in Waiting on you', () => {
  const text = file('- [?] Publish?').replace('state=waiting', 'state=ended')
  const result = view(observe(emptyQuestions(), text).ledger, text)
  expect(result.waiting).toEqual([])
  expect(result.overview.waiting).toBe(0)
  expect(result.focus).toBe(null)
  expect(result.stopped[0]?.question).toBe('Publish?')
})

test('a question of a working session still counts', () => {
  for (const state of ['working', 'waiting']) {
    const text = file('- [?] Publish?').replace('state=waiting', `state=${state}`)
    const result = view(observe(emptyQuestions(), text).ledger, text)
    expect(result.overview.waiting).toBe(1)
    expect(result.waiting[0]?.text).toBe('Publish?')
    expect(result.focus?.type).toBe('ask')
  }
})

test("a resolved question does not come back when its session wakes up, and a new question still counts", () => {
  for (const producer of ['', `<!-- question=${'a'.repeat(64)}:1 -->\n`]) {
    const stopped = file(`- [?] Publish?\n${producer}`).replace('state=waiting', 'state=ended')
    const first = observe(emptyQuestions(), stopped).ledger
    const id = first.records[0]!.id
    const resolved = resolveQuestion(first, id, NOW)
    const capture = captureJson(resolved.records[0]!, 'resolved')
    const restored = withCaptures(first, [parseCapture(capture, sha256(capture))!])
    const awake = stopped.replace('state=ended', 'state=working')
    expect(view(observe(restored, awake).ledger, awake).waiting).toEqual([])
    const changed = awake.replace('Publish?', 'Choose a date?')
    expect(view(observe(restored, changed).ledger, changed).overview.waiting).toBe(1)
    if (producer !== '') {
      const renewed = awake.replace(':1 -->', ':2 -->')
      expect(view(observe(restored, renewed).ledger, renewed).overview.waiting).toBe(1)
    }
    expect(restored.records.find(record => record.id === id)?.source).toEqual(first.records[0]?.source)
    expect(first.records[0]?.isUnresolved).toBe(true)
  }
})

test('resolving one of two identical stopped questions leaves the other identity open', () => {
  const text = file('- [?] Publish?\n- [?] Publish?').replace('state=waiting', 'state=ended')
  const initial = observe(emptyQuestions(), text).ledger
  const resolved = resolveQuestion(initial, initial.records[0]!.id, NOW)
  const next = observe(resolved, text).ledger
  expect(view(next, text).waiting).toEqual([])
  expect(view(next, text).stopped[0]?.questions?.map(item => item.hideKey)).toEqual([initial.records[1]!.id])
})

test('a retained question from a replaced stopped session stays out of Waiting on you', () => {
  const stopped = file('- [?] Publish?').replace('state=waiting', 'state=ended')
  const ledger = observe(emptyQuestions(), stopped).ledger
  const replacement = stopped.replaceAll('a1b2c3d4', '11223344').replace('- [?] Publish?', '- [ ] Finish')
  const result = view(observe(ledger, replacement).ledger, replacement)
  expect(result.waiting).toEqual([])
  expect(result.overview.waiting).toBe(0)
  expect(result.older?.map(item => item.text)).toEqual(['Publish?'])
})

test('stopped and done questions bypass aging, due dates, focus and notifications in every language', () => {
  for (const s of Object.values(STRINGS)) for (const state of ['working', 'waiting', 'ended', 'done']) for (const gap of [13 * 60 * 60 * 1000, 8 * 86400000]) for (const isDue of [true, false]) {
    const text = file('- [?] Publish?\n- [ ] Finish').replace('state=waiting', `state=${state}`).replace(new Date(NOW).toISOString(), new Date(NOW - gap).toISOString()).replace('### Ship', isDue ? '### Ship\n> due 2026-10-17' : '### Ship')
    const projects = parseProgress(text)
    const ledger = observeQuestions(emptyQuestions(), projects, null, [], NOW - 8 * 86400000, true).ledger
    const result = buildView(projects, [], null, NOW, 0, {}, s, [], {}, ledger)
    expect(result.waiting).toEqual([])
    expect(result.reminder).toEqual([])
    expect(result.older).toEqual([])
    expect(result.overview.waiting).toBe(0)
    expect(result.focus).toBe(null)
    expect(remindersOf(result, {}, NOW, '2026-10-16', s)).toEqual([])
    if (state === 'done' && gap < 86400000) expect(result.recent[0]?.questions?.[0]?.text).toBe('Publish?')
    else expect(result.stopped[0]?.questions?.[0]?.text).toBe('Publish?')
  }
})

test('a new raw producer revision renews a resolved stopped question and survives inbox consumption', () => {
  const text = file('- [?] Publish?').replace('state=waiting', 'state=ended')
  const pending = (revision: string) => [{ id: 'a1b2c3d4', agent: 'codex', project: 'demo', text: 'Publish?', isQuestion: true, at: NOW, sourceRevisions: [revision.repeat(64)] }]
  const first = observeQuestions(emptyQuestions(), parseProgress(text), null, [], NOW, true, 'first', undefined, pending('a')).ledger
  const resolved = resolveQuestion(first, first.records[0]!.id, NOW)
  const projects = parseProgress(text.replace('state=ended', 'state=working'))
  const next = observeQuestions(resolved, projects, null, [], NOW, true, 'second', undefined, pending('b')).ledger
  const renewed = buildView(projects, [], null, NOW, 0, {}, STRINGS.en, [], {}, next, undefined, pending('b'))
  expect(renewed.overview.waiting).toBe(1)
  expect(renewed.waiting[0]?.questionId === first.records[0]?.id).toBe(false)
  const consumed = observeQuestions(next, projects, null, [], NOW, true, 'third').ledger
  expect(buildView(projects, [], null, NOW, 0, {}, STRINGS.en, [], {}, consumed).overview.waiting).toBe(1)
})

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

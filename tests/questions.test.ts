import { test, expect } from 'claude-code/testing'
import { parseProgress } from '../hooks/parse'
import { buildView } from '../hooks/view'
import { acknowledgementKeys, archiveQuestionsKept, captureCovers, captureJson, emptyQuestions, isAskedBy, isQuestionSnapshot, isTornLedger, ledgerLeftovers, LEDGER_TEMP_MS, migratedAnswered, migrationKey, observeQuestions, ownQuestionsKey, parseCapture, parseQuestions, prunableCaptures, prunableProofs, questionFilesKey, questionsJson, resolveQuestion, resolvedQuestionsToRetire, withCaptures } from '../hooks/questions'
import type { QuestionLedger } from '../hooks/questions'
import { edited, finished, held, ledgerOf, named, proof, question, reopened } from './fixtures/question-files'
import { STRINGS } from '../hooks/strings'
import { sha256 } from '../hooks/sha256'
import { applyTaskCreate, applyTaskUpdate, emptyMirror, fromTaskList, markAnswered, questionToken } from '../hooks/mirror'
import { markAsked } from '../hooks/digest'
import { renderAutoBlock } from '../hooks/blocks'
import { remindersOf } from '../hooks/remind'
import { peekInbox } from '../hooks/board'
import { answerAgentPrompt, blockId } from '../hooks/inbox'
import type { AgentTurn } from '../hooks/inbox'

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

const inboxSession = 'inbox-question-session'
const inboxTurn = (at = NOW, event: AgentTurn['event'] = 'turn'): AgentTurn => ({
  id: blockId('codex', inboxSession), session: inboxSession, agent: 'codex', project: 'demo',
  cwd: '/demo', event, at, prompt: '', answer: 'Use staging?', transcript: '',
})
const inboxQuestion = () => peekInbox([{
  name: `codex-turn-${NOW}-1.json`,
  body: JSON.stringify({ session_id: inboxSession, cwd: '/demo', last_assistant_message: 'Use staging?' }),
  at: NOW,
}])

test('an inbox question is resolved by the next turn of the same session', () => {
  const pending = inboxQuestion()
  const initial = observeQuestions(emptyQuestions(), [], null, [], NOW, true, 'first', undefined, pending).ledger
  expect(initial.records.map(row => row.source?.kind)).toEqual(['inbox'])
  const next = { ...inboxTurn(NOW + 1000), answer: 'Using staging.' }
  const resolved = observeQuestions(initial, [], null, [], NOW + 2000, true, 'second', undefined, pending, [next]).ledger
  expect(resolved.records.map(row => [row.isUnresolved, row.isWaiting, row.isPresent])).toEqual([[false, false, false]])
  expect(initial.records[0]?.isUnresolved).toBe(true)
  const replay = observeQuestions(resolved, [], null, [], NOW + 3000, true, 'replay', undefined, pending).ledger
  expect(replay.records).toEqual(resolved.records)
})

test("an inbox question is resolved by the person's prompt to that session", () => {
  const pending = inboxQuestion()
  const initial = observeQuestions(emptyQuestions(), [], null, [], NOW, true, 'first', undefined, pending).ledger
  const prompt = inboxTurn(NOW + 1000, 'prompt')
  const mirror = { ...emptyMirror(prompt.id, 'demo', NOW, '/demo', 'codex'), resume: inboxSession, turnOrder: NOW * 2 }
  const asked = markAsked(applyTaskCreate(mirror, { subject: 'Deploy' }, '1', NOW), 'Use staging?')
  expect(answerAgentPrompt(asked, prompt, NOW + 2000)?.tasks.some(task => task.waiting === 'you')).toBe(false)
  const resolved = observeQuestions(initial, [], null, [], NOW + 2000, true, 'prompt', undefined, [], [prompt]).ledger
  expect(resolved.records.map(row => [row.isUnresolved, row.isWaiting, row.isPresent])).toEqual([[false, false, false]])
})

test("an end, a cleanup or another session's turn does not resolve an inbox question", () => {
  const pending = inboxQuestion()
  const initial = observeQuestions(emptyQuestions(), [], null, [], NOW, true, 'first', undefined, pending).ledger
  for (const turns of [[], [inboxTurn(NOW + 1000, 'end')], [inboxTurn()], [{ ...inboxTurn(NOW + 1000), id: 'ffffffff', session: 'other' }], [{ ...inboxTurn(NOW + 1000), agent: 'cursor' }], [{ ...inboxTurn(NOW + 1000), answer: '' }]]) {
    const next = observeQuestions(initial, [], null, [], NOW + 2000, true, 'unchanged', undefined, [], turns).ledger
    expect(next.records).toEqual(initial.records)
  }
})

test('a duplicate delivery of the asking turn leaves the question open', () => {
  for (const agent of ['grok', 'opencode']) {
    const body = JSON.stringify({ session_id: inboxSession, cwd: '/demo', last_assistant_message: 'Use staging?' })
    const first = { name: `${agent}-turn-${NOW}-1.json`, body, at: NOW }
    const duplicate = { name: `${agent}-turn-${NOW + 1000}-2.json`, body: agent === 'grok' ? JSON.stringify({ session_id: inboxSession, cwd: '/demo', lastAssistantMessage: 'Use staging?' }) : body, at: NOW + 1000 }
    const initial = observeQuestions(emptyQuestions(), [], null, [], NOW, false, 'first', undefined, peekInbox([first])).ledger
    const captured = observeQuestions(initial, [], null, [], NOW + 1000, false, 'duplicate', undefined, peekInbox([first, duplicate])).ledger
    const delivery = { ...inboxTurn(NOW + 1000), agent, id: blockId(agent, inboxSession) }
    const next = observeQuestions(captured, [], null, [], NOW + 2000, true, 'settle', undefined, [], [delivery]).ledger
    expect(next.records.map(row => [row.id, row.isUnresolved])).toEqual(initial.records.map(row => [row.id, true]))
    expect(JSON.parse(next.records[0]!.source!.data).sourceAt).toBe(NOW + 1000)
    const answered = observeQuestions(next, [], null, [], NOW + 3000, true, 'answer', undefined, [], [{ ...delivery, at: NOW + 2000, answer: 'Using staging.' }]).ledger
    expect(answered.records.map(row => row.isUnresolved)).toEqual([false])
  }
})

test("a question asked without a working folder is settled by the same session's next turn", () => {
  const pending = peekInbox([{
    name: `codex-turn-${NOW}-1.json`,
    body: JSON.stringify({ session_id: inboxSession, last_assistant_message: 'Use staging?' }),
    at: NOW,
  }])
  const initial = observeQuestions(emptyQuestions(), [], null, [], NOW, true, 'first', undefined, pending).ledger
  expect(initial.records[0]?.source?.project).toBe('')
  for (const project of [STRINGS.en.uncategorized, 'other']) {
    const next = { ...inboxTurn(NOW + 1000), project, answer: 'Using staging.' }
    const resolved = observeQuestions(initial, [], null, [], NOW, true, 'answer', undefined, pending, [next]).ledger
    expect(resolved.records.map(row => row.isUnresolved)).toEqual([false])
  }
  const moved = observeQuestions(emptyQuestions(), [], null, [], NOW, true, 'first', undefined, inboxQuestion()).ledger
  const resolved = observeQuestions(moved, [], null, [], NOW, true, 'answer', undefined, [], [{ ...inboxTurn(NOW + 1000), project: 'other' }]).ledger
  expect(resolved.records.map(row => row.isUnresolved)).toEqual([false])
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

test('question captures beyond the newest 16 are pruned once the ledger and a newer copy hold what they hold', () => {
  // Three answered and retired questions with a copy from when each was open and one from when
  // it was answered, and one open question whose block changed 20 times.
  const answered = [1, 2, 3].map(finished)
  const old = answered.flatMap((record, index) => [
    held(reopened(record), 'unresolved', 1 + index * 2),
    held(record, 'resolved', 2 + index * 2),
  ])
  const snapshots = Array.from({ length: 20 }, (_, version) => held(edited(9, version), 'unresolved', 100 + version))
  const ledger = ledgerOf(...answered, edited(9, 19))
  const retired = answered.map(record => sha256(record.id))
  // The ten oldest files go: the six of the answered questions and the four oldest snapshots.
  expect(new Set(prunableCaptures(ledger, [...old, ...snapshots], retired))).toEqual(named([...old, ...snapshots.slice(0, 4)]))
  // Without the retirement proofs the answered questions' copies stay, since nothing newer holds them.
  expect(new Set(prunableCaptures(ledger, [...old, ...snapshots], []))).toEqual(named(snapshots.slice(0, 4)))
})

test('the newest copy of an open question and the copy the ledger matches exactly are never pruned', () => {
  const snapshots = Array.from({ length: 20 }, (_, version) => held(edited(9, version), 'unresolved', 100 + version))
  // Keeping one file leaves the newest copy alone, and the 19 older ones are covered by it.
  expect(new Set(prunableCaptures(ledgerOf(edited(9, 19)), snapshots, [], 1))).toEqual(named(snapshots.slice(0, 19)))
  // A ledger that still holds the oldest version keeps that one copy, since the next poll would write it again.
  expect(new Set(prunableCaptures(ledgerOf(edited(9, 0)), snapshots, []))).toEqual(named(snapshots.slice(1, 4)))
})

test('a capture stays when it may be the only copy of an unresolved question or holds what the ledger lacks', () => {
  const open = Array.from({ length: 20 }, (_, n) => question(n + 1))
  const copies = open.map((record, index) => held(record, 'unresolved', 10 + index))
  // No ledger record: the files are the only copy, so none goes, however many there are.
  expect(prunableCaptures(ledgerOf(), copies, [])).toEqual([])
  // The ledger has them all, but each is the only copy of its question in the open state.
  expect(prunableCaptures(ledgerOf(...open), copies, [])).toEqual([])
  // An older copy that names a producer revision the ledger has not seen is not covered.
  const revised = held({ ...open[0]!, producerRevisions: ['a'.repeat(64)] }, 'unresolved', 1)
  expect(prunableCaptures(ledgerOf(...open), [revised, ...copies], [])).toEqual([])
  // A resolved receipt the ledger has not applied yet is kept as well.
  const receipt = held(finished(1), 'resolved', 2)
  expect(prunableCaptures(ledgerOf(...open), [receipt, ...copies], [])).toEqual([])
})

test('an answered question keeps its copies until its retirement proof exists', () => {
  const answered = finished(1)
  const fillers = Array.from({ length: 16 }, (_, n) => held(question(n + 10), 'unresolved', 100 + n))
  const copies = [held(reopened(answered), 'unresolved', 1), held(answered, 'resolved', 2)]
  const ledger = ledgerOf(answered, ...fillers.map(one => one.capture.record))
  expect(prunableCaptures(ledger, [...copies, ...fillers], [])).toEqual([])
  expect(new Set(prunableCaptures(ledger, [...copies, ...fillers], [sha256(answered.id)]))).toEqual(named(copies))
})

test('each capture that can go is named with the file that lets it go: its retirement proof, or the newest newer copy that holds what it holds', () => {
  const answered = finished(1)
  const old = [held(reopened(answered), 'unresolved', 1), held(answered, 'resolved', 2)]
  const snapshots = Array.from({ length: 20 }, (_, version) => held(edited(9, version), 'unresolved', 100 + version))
  // The newest file is a resolved copy of the open question, so it covers none of its open copies.
  const resolved = held(finished(9), 'resolved', 200)
  const covers = captureCovers(ledgerOf(answered, edited(9, 19)), [...old, ...snapshots, resolved], [sha256(answered.id)])
  const byHash = (one: { hash: string }, other: { hash: string }): number => one.hash.localeCompare(other.hash)
  expect([...covers].sort(byHash)).toEqual([
    ...old.map(one => ({ hash: one.hash, cover: null, retired: sha256(answered.id) })),
    ...snapshots.slice(0, 5).map(one => ({ hash: one.hash, cover: snapshots[19]!.hash, retired: null })),
  ].sort(byHash))
})

test('question proofs beyond the newest 16 go only when no ledger record, capture or acknowledgement refers to them', () => {
  const records = [finished(1), finished(2), question(3)]
  const ledger: QuestionLedger = { ...ledgerOf(...records), legacy: { 'a1b2c3d4 1 Old ask?': records[0]!.id } }
  // Twenty retirement proofs of questions no file holds any more, three of questions still in the ledger.
  const orphans = Array.from({ length: 20 }, (_, n) => proof('retired', `question:${'0'.repeat(63)}${n % 10}:${n + 50}`, 10 + n))
  const retained = records.map((record, index) => proof('retired', record.id, 1 + index))
  const stale = Array.from({ length: 20 }, (_, n) => proof('consumed', `gone ${n} Ask?`, 10 + n))
  const referred = [proof('consumed', 'a1b2c3d4 1 Old ask?', 1), proof('consumed', 'a1b2c3d4 2 Marked ask?', 2)]
  const doomed = prunableProofs(ledger, [], ['a1b2c3d4 2 Marked ask?'], [...orphans, ...retained, ...stale, ...referred])
  expect(new Set(doomed.map(one => `${one.kind}:${one.hash}`))).toEqual(new Set([...orphans.slice(0, 4), ...stale.slice(0, 4)].map(one => `${one.kind}:${one.hash}`)))
  // A capture of a question the ledger lost still refers to its retirement proof.
  const lost = held(question(77), 'unresolved', 5)
  const newest = Array.from({ length: 16 }, (_, n) => proof('retired', `question:${'1'.repeat(64)}:${n + 200}`, 10 + n))
  expect(prunableProofs(ledgerOf(), [lost.capture], [], [proof('retired', question(77).id, 1), ...newest])).toEqual([])
  // Sixteen or fewer of a kind always stay.
  expect(prunableProofs(ledger, [], [], orphans.slice(0, 16))).toEqual([])
})

test('the questions of a block are told from those of another session with the same title', () => {
  const record = question(1)
  const ref = { project: 'demo', title: 'Plan 1', line: 0, session: 'syn1' }
  expect(isAskedBy(record, ref)).toBe(true)
  expect(isAskedBy(record, { ...ref, session: 'syn2' })).toBe(false)
  expect(isAskedBy(record, { ...ref, title: 'Plan 2' })).toBe(false)
  expect(isAskedBy(record, { ...ref, project: 'other' })).toBe(false)
  // A hand-kept task has no session to tell apart, so only a hand-kept task's questions match it:
  // an agent block with the same project and title is not taken for it.
  const manual = { ...record, source: { ...record.source!, kind: 'manual' as const, session: '' } }
  expect(isAskedBy(manual, { ...ref, session: null })).toBe(true)
  expect(isAskedBy(record, { ...ref, session: null })).toBe(false)
  expect(isAskedBy(manual, ref)).toBe(false)
})

test('a copy that holds more than the ledger stays even when its question is answered and retired, and a plain copy goes', () => {
  const answered = finished(30)
  const fillers = Array.from({ length: 16 }, (_, n) => held(question(n + 40), 'unresolved', 100 + n))
  const ledger = ledgerOf(answered, ...fillers.map(one => one.capture.record))
  const retired = [sha256(answered.id)]
  // A producer revision the ledger has not seen: reading this copy back would add something, so it is the only record of it.
  const richer = held({ ...reopened(answered), producerRevisions: ['a'.repeat(64)] }, 'unresolved', 1)
  expect(prunableCaptures(ledger, [richer, ...fillers], retired)).toEqual([])
  // The same copy without the extra goes: the ledger holds all of it and the question is retired.
  const plain = held(reopened(answered), 'unresolved', 1)
  expect(prunableCaptures(ledger, [plain, ...fillers], retired)).toEqual([plain.hash])
})

test("an archived mark counts only while the question's block is gone", () => {
  const asking = file('- [?] Publish the plan, OK?')
  const record = observe(emptyQuestions(), asking).ledger.records[0]!
  const marked: QuestionLedger = { ...ledgerOf(), next: 2, records: [{ ...record, isArchived: true }] }
  // The block is still there, as when the archive stopped half way: the question is live.
  expect(observe(marked, asking).ledger.records[0]?.isArchived).toBeUndefined()
  expect(observe(marked, asking, [], NOW, false).ledger.records[0]?.isArchived).toBeUndefined()
  // The block is gone: the mark stays, and the question is kept as an older one.
  const gone = observe(marked, '## demo\n').ledger.records[0]
  expect(gone?.isArchived).toBe(true)
  expect(gone?.isUnresolved).toBe(true)
})

test('torn ledgers past the newest three go by the time in their names, and temporary copies of the ledger once a day old', () => {
  const path = '/home/me/.claude/progress.md'
  const ledger = 'progress-questions.json'
  const now = Date.parse('2026-10-16T12:00:00Z')
  const entries = [
    // Moved aside by the pane (session) and by the board script (process id); the names, not
    // the files' own times, say which is newest.
    { name: `${ledger}.torn-${now - 5_000}-synthetic-session`, mtimeMs: 1 },
    { name: `${ledger}.torn-${now - 1_000}-4242`, mtimeMs: 1 },
    { name: `${ledger}.torn-${now - 4_000}-4243`, mtimeMs: 9 },
    { name: `${ledger}.torn-${now - 2_000}-synthetic-session`, mtimeMs: 1 },
    { name: `${ledger}.torn-${now - 3_000}-synthetic-session`, mtimeMs: 1 },
    { name: `${ledger}.tmp-synthetic-session-1`, mtimeMs: now - LEDGER_TEMP_MS - 1 },
    { name: `${ledger}.tmp-synthetic-session-2`, mtimeMs: now - LEDGER_TEMP_MS + 1 },
    { name: `${ledger}.4242.mf3x9k.board-tmp`, mtimeMs: now - LEDGER_TEMP_MS - 1 },
    // Not the ledger's: another file's temporary copy and the ledger itself stay.
    { name: 'progress-answered.json.tmp-synthetic-session-3', mtimeMs: 1 },
    { name: 'progress.md.4242.mf3x9k.board-tmp', mtimeMs: 1 },
    { name: ledger, mtimeMs: 1 },
  ]
  const { torn, temps } = ledgerLeftovers(path, entries, now)
  expect(torn.sort()).toEqual([
    `${ledger}.torn-${now - 5_000}-synthetic-session`,
    `${ledger}.torn-${now - 4_000}-4243`,
  ])
  expect(temps.sort()).toEqual([
    `${ledger}.4242.mf3x9k.board-tmp`,
    `${ledger}.tmp-synthetic-session-1`,
  ])
})

test('the question files key lists the question files in name order, and is null while one was just written', () => {
  const path = '/home/me/.claude/progress.md'
  const now = Date.parse('2026-10-16T12:00:00Z')
  const hash = 'a'.repeat(64)
  const entries = [
    { name: 'progress-questions.json', size: 30, mtimeMs: 5 },
    { name: 'progress.md', size: 20, mtimeMs: 4 },
    { name: 'progress-answered.json', size: 10, mtimeMs: 3 },
    { name: `progress-questions-source-${hash}.json`, size: 40, mtimeMs: 2 },
    { name: `progress-questions-retired-${hash}.json`, size: 50, mtimeMs: 1 },
    // Not read by a question pass: another file family and leftovers of a ledger write.
    { name: 'progress-seen.json', size: 60, mtimeMs: now },
    { name: 'progress-questions.json.tmp-synthetic-session-1', size: 30, mtimeMs: now },
    { name: 'progress-archive-2026-10.md', size: 70, mtimeMs: now },
  ]
  expect(questionFilesKey(path, '/home/me/.claude/progress-answered.json', entries, now, 2_000)).toEqual([
    ['progress-answered.json', 10, 3],
    [`progress-questions-retired-${hash}.json`, 50, 1],
    [`progress-questions-source-${hash}.json`, 40, 2],
    ['progress-questions.json', 30, 5],
    ['progress.md', 20, 4],
  ])
  const fresh = entries.map(entry => (entry.name === 'progress-questions.json' ? { ...entry, mtimeMs: now - 1_999 } : entry))
  expect(questionFilesKey(path, '/home/me/.claude/progress-answered.json', fresh, now, 2_000)).toBeNull()
})

test('the own list\'s part of the idle question key moves with its questions, not with its times, turn state or background jobs', () => {
  let mirror = emptyMirror('a1b2c3d4-native', 'demo', NOW)
  mirror = applyTaskCreate(mirror, { subject: 'Ship', metadata: { waiting: 'you', why: 'Ready to publish?' } }, '1', NOW)
  mirror = applyTaskCreate(mirror, { subject: 'Docs' }, '2', NOW)
  const key = ownQuestionsKey(mirror)
  // What every hook of a running session changes, one at a time so a failure names the field.
  const churn: Array<Partial<typeof mirror>> = [{ updated: NOW + 60_000 }, { isTurnRunning: true }, { state: 'working' }, { backgroundJobs: 2 }, { backgroundJobIds: ['job-1', 'job-2'] }, { backgroundReleases: ['job-0'] }, { backgroundReleaseCount: 1 }]
  for (const change of churn) expect([change, ownQuestionsKey({ ...mirror, ...change })]).toEqual([change, key])
  // What a question pass reads: the steps' words and tasks, whether a step still waits, the
  // list's title and context, and whose list it is.
  const moved = [
    applyTaskUpdate(mirror, { taskId: '1', metadata: { why: 'Ready to publish today?' } }, NOW),
    markAnswered(mirror),
    applyTaskUpdate(mirror, { taskId: '2', subject: 'Docs again' }, NOW),
    applyTaskUpdate(mirror, { taskId: '2', status: 'completed' }, NOW),
    applyTaskUpdate(mirror, { taskId: '2', status: 'deleted' }, NOW),
    { ...mirror, title: 'Another title' },
    { ...mirror, context: 'Another context' },
    { ...mirror, project: 'other' },
    { ...mirror, sessionId: 'b1b2c3d4-native' },
    null,
  ]
  for (const [index, one] of moved.entries()) expect([index, ownQuestionsKey(one) === key]).toEqual([index, false])
})

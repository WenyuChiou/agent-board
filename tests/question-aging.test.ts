import { test, expect } from 'claude-code/testing'
import { ageQuestions, questionAge, QUESTION_DAY } from '../hooks/question-aging'
import { archiveQuestionsKept, captureCovers, captureJson, emptyQuestions, observeQuestions, parseCapture, parseQuestions, questionsJson, withCaptures } from '../hooks/questions'
import { parseProgress } from '../hooks/parse'
import { applyTaskCreate, applyTaskUpdate, emptyMirror } from '../hooks/mirror'
import { archivableAsking, renderAutoBlock, takeArchivable } from '../hooks/blocks'
import { buildView } from '../hooks/view'
import { boardItems, boardKey, boardScreen, boardText, chatText, emptyBoardState, peekInbox, pinned } from '../hooks/board'
import { sha256 } from '../hooks/sha256'
import { serveAction, serveModel, servePage } from '../hooks/serve'
import { dashboardHtml } from '../hooks/dashboard'
import { STRINGS } from '../hooks/strings'
import { remindersOf } from '../hooks/remind'

const START = Date.parse('2026-10-01T00:00:00Z')
const board = (steps: string, updated = START): string => `## demo\n<!-- auto session=a1b2c3d4 agent=codex state=waiting updated=${new Date(updated).toISOString()} -->\n### Release\n${steps}\n<!-- /auto session=a1b2c3d4 -->\n`

test('a question\'s copy of its block holds the block\'s state and step marks, not its lines, so an edit above the block changes nothing in it', () => {
  const original = board('- [x] Synthetic preparation\n- [?] Publish the synthetic plan, OK?')
  const projects = parseProgress(original)
  const task = projects[0]!.tasks[0]!
  const shifted = parseProgress(original.replace('## demo\n', '## demo\n> Synthetic note above the block\n\n'))
  expect(shifted[0]!.tasks[0]!.line).toBeGreaterThan(task.line)
  const first = observeQuestions(emptyQuestions(), projects, null, [], START, true, 'writer:1').ledger
  const next = observeQuestions(first, shifted, null, [], START, true, 'writer:2').ledger
  const expected = JSON.stringify({ auto: task.auto, steps: task.steps.map(step => step.status) })
  expect(first.records[0]?.source?.data).toBe(expected)
  expect(next.records[0]?.source).toEqual(first.records[0]?.source)
  const data = first.records[0]?.source?.data ?? ''
  expect(data.includes(task.steps[1]!.text)).toBe(false)
  expect(data.includes('"line"')).toBe(false)
})

test('a hand-kept task\'s question copy keeps it apart from another hand-kept task that asks the same, so archiving one waits for its own copy', () => {
  const text = '## Home\n### Pay rent\n- [?] Send the synthetic receipt, OK?\n\n### Pay water\n- [?] Send the synthetic receipt, OK?\n'
  const projects = parseProgress(text)
  const rent = projects[0]!.tasks[0]!
  const water = projects[0]!.tasks[1]!
  // Both tasks have the same marks, so the same copy data: only the title tells them apart.
  expect(JSON.stringify({ auto: rent.auto, steps: rent.steps.map(step => step.status) })).toBe(JSON.stringify({ auto: water.auto, steps: water.steps.map(step => step.status) }))
  const ledger = observeQuestions(emptyQuestions(), projects, null, [], START, true, 'writer:1').ledger
  const onlyRent = { ...ledger, records: ledger.records.filter(record => record.source?.task === 'Pay rent') }
  expect(onlyRent.records).toHaveLength(1)
  expect(archiveQuestionsKept(projects, { project: 'Home', title: 'Pay rent', line: rent.line, session: null }, onlyRent)).toBe(true)
  expect(archiveQuestionsKept(projects, { project: 'Home', title: 'Pay water', line: water.line, session: null }, onlyRent)).toBe(false)
  expect(archiveQuestionsKept(projects, { project: 'Home', title: 'Pay water', line: water.line, session: null }, ledger)).toBe(true)
})

test('a ledger and a question copy written before 0.24.0 hold the whole task, and read as the same copy of the block\'s state and marks', () => {
  const projects = parseProgress(board('- [?] Publish the synthetic plan, OK?') + '\n## Personal\n### Letter\n- [?] Send the synthetic letter, OK?\n')
  const first = observeQuestions(emptyQuestions(), projects, null, [], START, true, 'writer:1').ledger
  for (const record of first.records) {
    const task = projects.find(project => project.name === record.source!.project)!.tasks[0]!
    const old = { ...record, source: { ...record.source!, data: JSON.stringify(task) } }
    const expected = JSON.stringify({ auto: task.auto, steps: task.steps.map(step => step.status) })
    const ledger = { ...first, records: [old] }
    const parsed = parseQuestions(questionsJson(ledger))!
    expect(parsed.records[0]?.source?.data).toBe(expected)
    expect(questionsJson(parseQuestions(questionsJson(parsed))!)).toBe(questionsJson(parsed))
    const text = captureJson(old, 'unresolved')
    const capture = parseCapture(text, sha256(text))!
    expect(capture.record.source?.data).toBe(expected)
    expect(parseCapture(captureJson(capture.record, 'unresolved'), sha256(captureJson(capture.record, 'unresolved')))).toEqual(capture)
    for (const data of [JSON.stringify({ n: 3 }), 'not JSON', '[]', JSON.stringify({ title: 'Broken', auto: null, steps: [null] })]) {
      const unchanged = { ...ledger, records: [{ ...old, source: { ...old.source, data } }] }
      expect(parseQuestions(questionsJson(unchanged))?.records[0]?.source?.data).toBe(data)
    }
    for (const kind of ['own', 'inbox'] as const) {
      const unchanged = { ...ledger, records: [{ ...old, source: { ...old.source, kind } }] }
      expect(parseQuestions(questionsJson(unchanged))?.records[0]?.source?.data).toBe(old.source.data)
      const ownText = captureJson(unchanged.records[0]!, 'unresolved')
      expect(parseCapture(ownText, sha256(ownText))?.record.source?.data).toBe(old.source.data)
    }
  }
  // The raw files differ, but equal normalized copies use the same deterministic name tie-break.
  const record = first.records[0]!
  const task = projects[0]!.tasks[0]!
  const held = [0, 10].map(offset => {
    const old = { ...record, source: { ...record.source!, data: JSON.stringify({ ...task, line: task.line + offset }) } }
    const text = captureJson(old, 'unresolved')
    return { hash: sha256(text), mtimeMs: START, capture: parseCapture(text, sha256(text))! }
  })
  const ordered = [...held].sort((a, b) => a.hash < b.hash ? 1 : a.hash > b.hash ? -1 : 0)
  expect(captureCovers(first, held, [], 0)).toEqual([{ hash: ordered[1]!.hash, cover: ordered[0]!.hash, retired: null }])
  expect(captureCovers(first, [...held].reverse(), [], 0)).toEqual([{ hash: ordered[1]!.hash, cover: ordered[0]!.hash, retired: null }])
})

test('a retained question of a finished block whose copy was written by 0.24.0 or before stays under Older', () => {
  const first = observeQuestions(emptyQuestions(), parseProgress(board('- [?] Publish the synthetic plan, OK?')), null, [], START, true, 'writer:1').ledger
  const task = parseProgress(board('- [x] Publish the synthetic plan, OK?'))[0]!.tasks[0]!
  expect(task.auto?.state).toBe('waiting')
  for (const data of [JSON.stringify({ auto: task.auto, steps: task.steps.map(step => step.status) }), JSON.stringify(task)]) {
    const ledger = { ...first, records: first.records.map(record => ({ ...record, source: { ...record.source!, data } })) }
    const view = buildView([], [], null, START, 0, {}, STRINGS.en, [], {}, ledger)
    expect(view.waiting).toEqual([])
    expect(view.older?.map(item => item.questionId)).toEqual([first.records[0]!.id])
  }
  for (const data of ['not JSON', JSON.stringify({ n: 3 }), JSON.stringify({ auto: [], steps: ['done'] }), JSON.stringify({ auto: task.auto, steps: [null] })]) {
    const ledger = { ...first, records: first.records.map(record => ({ ...record, source: { ...record.source!, data } })) }
    expect(buildView([], [], null, START, 0, {}, STRINGS.en, [], {}, ledger).waiting).toHaveLength(1)
  }
})

test('question age is pending at three days, a reminder through seven days, and older only after seven days', () => {
  for (const [age, stage] of [[3 * QUESTION_DAY, 'pending'], [3 * QUESTION_DAY + 1, 'reminder'], [7 * QUESTION_DAY, 'reminder'], [7 * QUESTION_DAY + 1, 'older']] as const) {
    expect(questionAge(START, START + age)).toEqual({ stage, age })
  }
})

test('unknown or future question observation clocks remain visible without inventing ask time', () => {
  for (const first of [0, -1, NaN, Infinity, START + 1]) expect(questionAge(first, START)).toEqual({ stage: 'pending', age: null })
  expect(questionAge(START, NaN)).toEqual({ stage: 'pending', age: null })
  expect(questionAge(START, START - 1000)).toEqual({ stage: 'pending', age: null })
  expect(questionAge(START, START + 8 * QUESTION_DAY).stage).toBe('older')
})

test('aging keeps full records, manual hide state and source completion unchanged when older questions are opened repeatedly', () => {
  const text = 'Need the complete answer? '.repeat(1000)
  const source = { project: 'demo', task: 'Release', text, status: 'waiting', options: ['Keep', 'Change'], context: 'Original context' }
  const old = { id: 'old', firstObserved: START, source }
  const recent = { id: 'recent', firstObserved: START + 6 * QUESTION_DAY, source: { ...source, text: 'Another ask?' } }
  const hidden = { id: 'hidden', firstObserved: START, source }
  const records = [old, recent, hidden]
  const before = JSON.stringify(records)
  for (let i = 0; i < 3; i += 1) {
    const shelves = ageQuestions(records, START + 8 * QUESTION_DAY, ['hidden'])
    expect(shelves.older).toEqual([old])
    expect(shelves.pending).toEqual([recent])
    expect(shelves.hidden).toEqual([hidden])
    expect(shelves.older[0]?.source.text).toBe(text)
    expect(JSON.stringify(records)).toBe(before)
  }
})

test('restart, whitespace, a newer report timestamp and unrelated progress preserve independent question ages', () => {
  const original = board('- [?] Publish?\n- [?] Keep docs?\n- [ ] Verify')
  const first = observeQuestions(emptyQuestions(), parseProgress(original), null, [], START, true, 'writer:1').ledger
  const restarted = parseQuestions(questionsJson(first))!
  const next = board('- [x] Verify\n- [?] Publish?\n- [?] Keep   docs?', START + 6 * QUESTION_DAY)
  const observed = observeQuestions(restarted, parseProgress(next), null, [], START + 6 * QUESTION_DAY, true, 'writer:2').ledger
  expect(observed.records.map(row => row.firstObserved)).toEqual([START, START])
  expect(ageQuestions(observed.records, START + 6 * QUESTION_DAY).reminder.length).toBe(2)
  const newAsk = board('- [x] Verify\n- [?] Publish to production?\n- [?] Keep docs?', START + 6 * QUESTION_DAY)
  const changed = observeQuestions(observed, parseProgress(newAsk), null, [], START + 6 * QUESTION_DAY, true, 'writer:3').ledger
  const open = changed.records.filter(row => row.isWaiting && row.isPresent)
  expect(ageQuestions(open, START + 6 * QUESTION_DAY).pending.map(row => row.words)).toEqual(['Publish to production?'])
  expect(ageQuestions(open, START + 6 * QUESTION_DAY).reminder.map(row => row.words)).toEqual(['Keep docs?'])
})

test('explicit producer renewal refreshes only that question age while another unresolved ask keeps its baseline', () => {
  let mirror = emptyMirror('a1b2c3d4-native', 'demo', START)
  mirror = applyTaskCreate(mirror, { subject: 'Publish?', metadata: { waiting: 'you' } }, '1', START)
  mirror = applyTaskCreate(mirror, { subject: 'Keep docs?', metadata: { waiting: 'you' } }, '2', START)
  const first = observeQuestions(emptyQuestions(), parseProgress(`## demo\n${renderAutoBlock(mirror).join('\n')}`), null, [], START, true, 'writer:1').ledger
  const now = START + 8 * QUESTION_DAY
  const renewed = applyTaskUpdate(mirror, { taskId: '1', metadata: { waiting: 'you' } }, now)
  const next = observeQuestions(first, parseProgress(`## demo\n${renderAutoBlock(renewed).join('\n')}`), null, [], now, true, 'writer:2').ledger
  const shelves = ageQuestions(next.records.filter(row => row.isWaiting && row.isPresent), now)
  expect(shelves.pending.map(row => row.words)).toEqual(['Publish?'])
  expect(shelves.older.map(row => row.words)).toEqual(['Keep docs?'])
})

test('own, live external, manual and inbox questions share exact age shelves and actionable counts on every reader', () => {
  const manual = '\n## Personal\n### Letter\n> Full context\n- [?] Ask Prof Lee?\n'
  const projects = parseProgress(board('- [?] Publish?') + manual)
  const mine = applyTaskCreate(emptyMirror('11223344-native', 'mine', START), { subject: 'Keep docs?', metadata: { waiting: 'you' } }, '1', START)
  const pending = [{ id: '99aabbcc', agent: 'cursor', project: 'inbox', text: 'Use the full option '.repeat(100) + '?', fullText: 'Complete original source', isQuestion: true, at: START + 100 * QUESTION_DAY }]
  const first = observeQuestions(emptyQuestions(), projects, mine, [], START, true, 'writer:1', undefined, pending).ledger
  const saved = parseQuestions(questionsJson(first))!
  expect(saved.records.length).toBe(4)
  expect(saved.records.find(row => row.source?.kind === 'inbox')?.source?.data.includes('Complete original source')).toBe(true)
  for (const s of Object.values(STRINGS)) {
    for (const [gap, shelf] of [[3 * QUESTION_DAY, 'waiting'], [3 * QUESTION_DAY + 1, 'reminder'], [7 * QUESTION_DAY, 'reminder'], [7 * QUESTION_DAY + 1, 'older']] as const) {
      const now = START + gap
      const live = parseProgress(board('- [?] Publish?', now) + manual)
      const view = buildView(live, [], mine, now, 0, {}, s, [], {}, saved, undefined, pending)
      expect(view[shelf]?.length).toBe(4)
      expect(view.overview.waiting).toBe(shelf === 'waiting' ? 4 : 0)
      expect(view.focus?.type === 'ask').toBe(shelf === 'waiting')
      if (shelf !== 'waiting') {
        expect(view.current?.status).toBe(shelf === 'reminder' ? s.sectionQuestionReminders : s.sectionOlderQuestions)
        expect([...view.active, ...view.idle].every(row => row.question === null)).toBe(true)
      }
      const model = serveModel(view, pending, s)
      expect(model.counts.waiting).toBe(view.overview.waiting)
      expect(model[shelf === 'waiting' ? 'asks' : shelf].length).toBe(4)
      if (shelf === 'older') {
        expect(boardItems(view, pending).filter(item => item.type === 'ask').length).toBe(0)
        expect(boardItems(view, pending, false, true).filter(item => item.type === 'ask').length).toBe(4)
        expect(boardText(view, pending, s, { width: 3000, isColor: false, isIdleOpen: true }).includes(pending[0]!.text)).toBe(true)
        expect(chatText(view, pending, [], s, '/home/me', false).includes(s.sectionOlderQuestions)).toBe(true)
        expect(dashboardHtml(view, s, '/tmp/progress.md', '', pending).includes(pending[0]!.text)).toBe(true)
      }
    }
  }
})

test('complete retained source questions remain recoverable after explicit archival and storage checks refuse an uncopied replacement', () => {
  const text = board('- [?] Full question with exact  whitespace?')
  const projects = parseProgress(text)
  const ref = { project: 'demo', title: 'Release', line: 2, session: 'a1b2c3d4' }
  const first = observeQuestions(emptyQuestions(), projects, null, [], START, true, 'writer:1').ledger
  expect(archiveQuestionsKept(projects, ref, first)).toBe(true)
  expect(archiveQuestionsKept(parseProgress(text.replace('exact  whitespace', 'another request')), ref, first)).toBe(false)
  const reloaded = withCaptures(parseQuestions(questionsJson(first))!, [{ version: 1, disposition: 'archived', record: first.records[0]! }])
  const view = buildView([], [], null, START + QUESTION_DAY, 0, {}, STRINGS.en, [], {}, reloaded)
  expect(view.waiting.length).toBe(0)
  expect(view.older?.[0]?.text).toBe('Full question with exact  whitespace?')
  const task = projects[0]!.tasks[0]!
  expect(reloaded.records[0]?.source?.data).toBe(JSON.stringify({ auto: task.auto, steps: task.steps.map(step => step.status) }))
  expect(reloaded.records[0]?.firstObserved).toBe(START)
})

test('a waiting block archived after seven days of silence keeps its question under Older unanswered, and a ledger lost afterwards gets it back from the saved copy', () => {
  const text = board('- [?] Publish the synthetic plan, OK?')
  const projects = parseProgress(text)
  const ledger = observeQuestions(emptyQuestions(), projects, null, [], START, true, 'writer:1').ledger
  const inside = START + 6 * QUESTION_DAY
  expect(archivableAsking(text, inside)).toEqual([])
  expect(takeArchivable(text, inside, undefined, STRINGS.en, false, () => true)).toEqual({ text, entries: [] })
  const now = START + 7 * QUESTION_DAY + 60 * 60 * 1000
  const asking = archivableAsking(text, now)
  expect(asking).toHaveLength(1)
  expect(archiveQuestionsKept(projects, asking[0]!.ref, ledger)).toBe(true)
  const taken = takeArchivable(text, now, undefined, STRINGS.en, false, () => true)
  expect(taken.entries).toHaveLength(1)
  expect(taken.text).not.toContain('session=a1b2c3d4')
  const record = ledger.records[0]!
  const capture = { version: 1 as const, disposition: 'archived' as const, record }
  for (const kept of [withCaptures(ledger, [capture]), withCaptures(emptyQuestions(), [capture])]) {
    const view = buildView([], [], null, now, 0, {}, STRINGS.en, [], {}, kept)
    expect(view.waiting).toEqual([])
    expect(view.older?.map(question => question.text)).toEqual(['Publish the synthetic plan, OK?'])
    expect(kept.records[0]?.firstObserved).toBe(START)
  }
})

test('automatic archive never removes an unresolved question even in an ended or done block beyond seven days', () => {
  const now = START + 10 * QUESTION_DAY
  for (const state of ['ended', 'done', 'waiting']) {
    const text = board('- [?] Still unresolved?').replace('state=waiting', `state=${state}`)
    expect(takeArchivable(text, now, undefined, STRINGS.en, true)).toEqual({ text, entries: [] })
  }
  const done = board('- [x] Complete\n```\n- [?] Example only\n```').replace('state=waiting', 'state=done')
  expect(takeArchivable(done, now, undefined, STRINGS.en, true).entries.length).toBe(1)
})

test('unexpected source loss keeps unknown clocks prominent while explicit archive remains recoverable in every language', () => {
  const projects = parseProgress(board('- [?] Keep the complete original?') + '\n## Personal\n### Letter\n- [?] Ask Prof Lee?\n')
  for (const observedAt of [0, START + QUESTION_DAY]) {
    const first = observeQuestions(emptyQuestions(), projects, null, [], observedAt, true, 'writer:1').ledger
    const captured = withCaptures(emptyQuestions(), first.records.map(record => ({ version: 1, disposition: 'unresolved', record })))
    for (const s of Object.values(STRINGS)) {
      const lost = buildView([], [], null, START, 0, {}, s, [], {}, captured)
      expect(lost.waiting.length).toBe(2)
      expect(lost.waiting.every(item => item.when === s.questionAgeUnknown)).toBe(true)
      expect(serveModel(lost, [], s).counts.waiting).toBe(2)
      const archived = withCaptures(captured, captured.records.map(record => ({ version: 1, disposition: 'archived', record })))
      const recovered = buildView([], [], null, START, 0, {}, s, [], {}, archived)
      expect(recovered.waiting.length).toBe(0)
      expect(recovered.older?.length).toBe(2)
      expect(recovered.older?.every(item => item.when === s.questionAgeUnknown)).toBe(true)
      expect(recovered.older?.map(item => item.text)).toEqual(['Keep the complete original?', 'Ask Prof Lee?'])
    }
  }
})

test('equal-title manual tasks remain visibly ambiguous and no timestamp or viewing operation invents a hide', () => {
  const projects = parseProgress('## Personal\n### Letter\n- [?] Ask?\n### Letter\n- [?] Ask?\n')
  const first = observeQuestions(emptyQuestions(), projects, null, [], START, true, 'writer:1').ledger
  expect(first.records.length).toBe(0)
  const view = buildView(projects, [], null, START + 10 * QUESTION_DAY, 0, {}, STRINGS.en, [], {}, first)
  expect(view.waiting.length).toBe(2)
  expect(view.waiting.every(item => item.when === STRINGS.en.questionAgeUnknown)).toBe(true)
})

test('unseen distinct inbox questions survive same-batch end, end-only payloads and later statements without sharing identities', () => {
  const body = (answer: string) => JSON.stringify({ session_id: 'same-owner', cwd: '/work/demo', last_assistant_message: answer })
  const files = [
    { name: 'codex-turn-1-1.json', body: body('Use option A?'), at: START },
    { name: 'codex-turn-2-1.json', body: body('Use option B?'), at: START + 1 },
    { name: 'codex-turn-3-1.json', body: body('Use  option A?'), at: START + 2 },
    { name: 'codex-turn-4-1.json', body: body('More work is running.'), at: START + 3 },
    { name: 'codex-end-5-1.json', body: body('Keep the full end-only question?'), at: START + 4 },
  ]
  const pending = peekInbox(files)
  expect(pending.length).toBe(3)
  expect(pending.every(turn => turn.isQuestion && turn.isClosed)).toBe(true)
  const initial = observeQuestions(emptyQuestions(), [], null, [], START, true, 'writer:1', undefined, pending).ledger
  expect(new Set(initial.records.map(record => record.id)).size).toBe(3)
  expect(initial.records.every(record => record.firstObserved === START)).toBe(true)
  const restarted = parseQuestions(questionsJson(initial))!
  const repeated = observeQuestions(restarted, [], null, [], START + 4 * QUESTION_DAY, true, 'writer:2', undefined, peekInbox([...files].reverse())).ledger
  expect(repeated.records.map(record => record.id)).toEqual(initial.records.map(record => record.id))
  expect(buildView([], [], null, START + 4 * QUESTION_DAY, 0, {}, STRINGS.en, [], {}, repeated, undefined, pending).reminder?.length).toBe(3)
  // Losing the physical files without a processing/answer receipt cannot make them vanish.
  expect(buildView([], [], null, START + QUESTION_DAY, 0, {}, STRINGS.en, [], {}, restarted).waiting.length).toBe(3)
  const absent = observeQuestions(restarted, [], null, [], START + QUESTION_DAY, true, 'writer:3').ledger
  const reconnected = observeQuestions(absent, [], null, [], START + 2 * QUESTION_DAY, true, 'writer:4', undefined, pending).ledger
  expect(reconnected.records.map(record => [record.id, record.firstObserved])).toEqual(initial.records.map(record => [record.id, record.firstObserved]))
})

test('immutable full captures recover after stale ledger overwrite and exact resolution receipts cannot retire a newer ask', () => {
  const pending = [{ id: 'aabbccdd', agent: 'codex', project: 'demo', text: 'Full original question? '.repeat(100), isQuestion: true, at: START }]
  const initial = observeQuestions(emptyQuestions(), [], null, [], START, true, 'writer:1', undefined, pending).ledger
  const record = initial.records[0]!
  const text = captureJson(record, 'unresolved')
  const captured = parseCapture(text, sha256(text))!
  expect(captured.record.source?.text).toBe(pending[0]!.text)
  expect(parseCapture(text + ' ', sha256(text))).toBe(null)
  const recovered = withCaptures(emptyQuestions(), [captured])
  expect(buildView([], [], null, START + QUESTION_DAY, 0, {}, STRINGS.en, [], {}, recovered).waiting[0]?.text).toBe(pending[0]!.text)
  const resolvedText = captureJson({ ...record, isUnresolved: false, isPresent: false, isWaiting: false }, 'resolved')
  const resolved = parseCapture(resolvedText, sha256(resolvedText))!
  const newer = observeQuestions(emptyQuestions(), [], null, [], START + QUESTION_DAY, true, 'writer:2', undefined, [{ ...pending[0]!, text: 'New ask?' }]).ledger
  const replayed = withCaptures({ ...newer, records: [...newer.records, record] }, [resolved, captured])
  const view = buildView([], [], null, START + QUESTION_DAY, 0, {}, STRINGS.en, [], {}, replayed)
  expect(view.waiting.map(item => item.text)).toEqual(['New ask?'])
  expect(replayed.records.find(item => item.id === record.id)?.isUnresolved).toBe(false)
})

test('an inbox question transferred to an exact block preserves its original observation baseline', () => {
  const pending = [{ id: 'aabbccdd', agent: 'codex', project: 'demo', text: 'Keep the original ask?', isQuestion: true, at: START }]
  const initial = observeQuestions(emptyQuestions(), [], null, [], START, true, 'writer:1', undefined, pending).ledger
  const record = initial.records[0]!
  const capture = parseCapture(captureJson(record, 'unresolved'), sha256(captureJson(record, 'unresolved')))!
  const projects = parseProgress(board('- [?] Keep the original ask?', START + 6 * QUESTION_DAY).replace('a1b2c3d4', 'aabbccdd'))
  const next = observeQuestions(withCaptures(emptyQuestions(), [capture]), projects, null, [], START + 6 * QUESTION_DAY, true, 'writer:2').ledger
  expect(next.records[0]?.id).toBe(record.id)
  expect(next.records[0]?.firstObserved).toBe(START)
  expect(next.records[0]?.source?.kind).toBe('block')
  expect(buildView(projects, [], null, START + 6 * QUESTION_DAY, 0, {}, STRINGS.en, [], {}, next).reminder?.length).toBe(1)
})

test('exact resolved producer revisions reject stale raw replay while new file or changed content remains a fresh ask', () => {
  const file = { name: 'codex-turn-1792152000-1.json', body: JSON.stringify({ session_id: 'owner', cwd: '/work/demo', last_assistant_message: 'Keep this exact ask?' }), at: START }
  const pending = peekInbox([file])
  const initial = observeQuestions(emptyQuestions(), [], null, [], START, true, 'writer:1', undefined, pending).ledger
  const record = initial.records[0]!
  const receipt = { version: 1 as const, disposition: 'resolved' as const, record: { ...record, isUnresolved: false, isWaiting: false, isPresent: false } }
  const recovered = withCaptures(emptyQuestions(), [{ version: 1, disposition: 'unresolved', record }, receipt])
  const replay = observeQuestions(recovered, [], null, [], START + QUESTION_DAY, true, 'writer:2', undefined, pending).ledger
  expect(replay.records.filter(row => row.isUnresolved).length).toBe(0)
  expect(buildView([], [], null, START + QUESTION_DAY, 0, {}, STRINGS.en, [], {}, replay, undefined, pending).waiting.length).toBe(0)
  const lostProvenance = { ...initial, records: [{ ...record, producerRevisions: undefined, producerSources: undefined }] }
  const recoveredReceipt = withCaptures(lostProvenance, [receipt])
  expect(observeQuestions(recoveredReceipt, [], null, [], START + QUESTION_DAY, true, 'writer:2', undefined, pending).ledger.records.filter(row => row.isUnresolved).length).toBe(0)
  for (const fresh of [{ ...file, name: 'codex-turn-1792152000-2.json' }, { ...file, body: file.body.replace('exact ask', 'different ask') }]) {
    const renewed = observeQuestions(recovered, [], null, [], START + QUESTION_DAY, true, 'writer:3', undefined, peekInbox([fresh])).ledger
    const active = renewed.records.filter(row => row.isUnresolved)
    expect(active.length).toBe(1)
    expect(active[0]?.firstObserved).toBe(START + QUESTION_DAY)
    expect(active[0]?.id === record.id).toBe(false)
  }
})

test('an overlapping projection keeps complete producer payload and exact revision through resolution', () => {
  const file = { name: 'codex-turn-1792152000-1.json', body: JSON.stringify({ session_id: 'owner', cwd: '/work/demo', last_assistant_message: 'Full original background. Keep this exact ask?' }), at: START }
  const pending = peekInbox([file])
  const projects = parseProgress(board(`- [?] ${pending[0]!.text}`).replace('a1b2c3d4', pending[0]!.id!))
  const first = observeQuestions(emptyQuestions(), projects, null, [], START, true, 'writer:1', undefined, pending).ledger
  expect(first.records.length).toBe(1)
  const original = first.records[0]!
  expect(original.producerSources?.[0]).toBe(JSON.stringify(pending[0]))
  expect(original.producerRevisions).toEqual(pending[0]?.sourceRevisions)
  const settled = observeQuestions(first, parseProgress(board(`- [x] ${pending[0]!.text}`).replace('a1b2c3d4', pending[0]!.id!)), null, [], START + 1, true, 'writer:2').ledger
  const record = settled.records.find(one => one.id === original.id)!
  const restored = withCaptures(emptyQuestions(), [{ version: 1, disposition: 'resolved', record }])
  const replayed = observeQuestions(restored, [], null, [], START + 2, true, 'writer:3', undefined, pending).ledger
  expect(replayed.records.filter(one => one.isUnresolved).length).toBe(0)
})

test('a resolved producer token rejects stale block and own-mirror replay while a fresh revision or changed question resurfaces', () => {
  const mirror = applyTaskCreate(emptyMirror('11223344-native', 'demo', START), { subject: 'Keep the exact producer ask?', metadata: { waiting: 'you' } }, '1', START)
  const raw = `## demo\n${renderAutoBlock(mirror).join('\n')}`
  const projects = parseProgress(raw)
  const initial = observeQuestions(emptyQuestions(), projects, null, [], START, true, 'writer:1').ledger
  const completed = observeQuestions(initial, parseProgress(raw.replace('- [?]', '- [x]')), null, [], START + 1, true, 'writer:2').ledger
  const record = completed.records[0]!
  const restored = withCaptures(initial, [{ version: 1, disposition: 'resolved', record }])
  const replayed = observeQuestions(restored, projects, null, [], START + QUESTION_DAY, true, 'writer:3').ledger
  expect(replayed.records.filter(row => row.isUnresolved).length).toBe(0)
  expect(replayed.records.length).toBe(1)
  for (const s of Object.values(STRINGS)) {
    const external = buildView(projects, [], null, START + QUESTION_DAY, 0, {}, s, [], {}, restored)
    const own = buildView(projects, [], mirror, START + QUESTION_DAY, 0, {}, s, [], {}, restored)
    expect(external.waiting.length).toBe(0)
    expect(external.overview.waiting).toBe(0)
    expect(external.focus?.type === 'ask').toBe(false)
    expect(own.waiting.length).toBe(0)
    expect(own.current?.status).toBe(s.answeredNote)
    expect(serveModel(external, [], s).counts.waiting).toBe(0)
  }
  const renewed = applyTaskUpdate(mirror, { taskId: '1', metadata: { waiting: 'you' } }, START + QUESTION_DAY)
  const fresh = observeQuestions(restored, parseProgress(`## demo\n${renderAutoBlock(renewed).join('\n')}`), null, [], START + QUESTION_DAY, true, 'writer:4').ledger
  expect(fresh.records.filter(row => row.isUnresolved).length).toBe(1)
  expect(fresh.records.find(row => row.isUnresolved)?.producer === record.producer).toBe(false)
  const changed = observeQuestions(restored, parseProgress(raw.replaceAll('Keep the exact producer ask?', 'Choose the new substantive question?')), null, [], START + QUESTION_DAY, true, 'writer:5').ledger
  expect(changed.records.filter(row => row.isUnresolved).length).toBe(1)
})

test('aged shelf hide actions keep identity and stale fingerprints while retained sources are explicitly review only', () => {
  const projects = parseProgress(board('- [?] Publish?'))
  const first = observeQuestions(emptyQuestions(), projects, null, [], START, true, 'writer:1').ledger
  for (const s of Object.values(STRINGS)) for (const days of [4, 8]) {
    const now = START + days * QUESTION_DAY
    const live = parseProgress(board('- [?] Publish?', now))
    const view = buildView(live, [], null, now, 0, {}, s, [], {}, first)
    const items = boardItems(view, [], false, true)
    const state = pinned({ ...emptyBoardState, isOlderOpen: true }, items)
    expect(boardKey(state, 'h', items, s).action).toEqual({ type: 'hide', key: first.records[0]!.id, text: 'Publish?' })
    const changed = items.map(item => item.type === 'ask' ? { ...item, ask: { ...item.ask, note: 'Changed context' } } : item)
    expect(boardKey(state, 'h', changed, s).state.note).toBe(s.boardLineChanged)
    expect(boardKey(state, 'h', changed, s).action).toBe(null)
    const renewedProjects = parseProgress(board('- [?] Publish to production?', now))
    const renewed = observeQuestions(first, renewedProjects, null, [], now, true, 'writer:2').ledger
    const newItems = boardItems(buildView(renewedProjects, [], null, now, 0, {}, s, [], {}, renewed), [], false, true)
    expect(boardKey(state, 'h', newItems, s).action).toBe(null)
    const retired = observeQuestions(first, parseProgress(board('- [x] Publish?')), null, [], now, true, 'writer:3').ledger
    const repeated = observeQuestions(retired, projects, null, [], now + 1, true, 'writer:4').ledger
    const repeatedItems = boardItems(buildView(live, [], null, now + 1, 0, {}, s, [], {}, repeated), [], false, true)
    expect(boardKey(state, 'h', repeatedItems, s).action).toBe(null)
    expect(repeated.records.find(row => row.isWaiting && row.isPresent)?.id === first.records[0]!.id).toBe(false)
    // A retained source without a current producer stays review only.
    const captured = withCaptures(emptyQuestions(), [{ version: 1, disposition: 'unresolved', record: first.records[0]! }])
    const retained = buildView([], [], null, now, 0, {}, s, [], {}, captured)
    const retainedItems = boardItems(retained, [], false, true)
    const selected = pinned({ ...emptyBoardState, isOlderOpen: true }, retainedItems)
    expect(boardKey(selected, 'h', retainedItems, s).action).toBe(null)
    expect(boardScreen(retained, [], selected, s, { width: 500, isColor: false }).includes(s.questionReviewOnly)).toBe(true)
    expect(serveAction(retainedItems, { key: retainedItems[0]!.key, type: 'hide' }, s).type).toBe('refuse')
    const shelf = (model: ReturnType<typeof serveModel>) => [...model.reminder, ...model.older]
    expect(shelf(serveModel(retained, [], s)).map(one => one.canHide)).toEqual([false])
    expect(servePage(s, 'synthetic-nonce').includes(s.questionReviewOnly)).toBe(true)
    // One kept from an archived block can be hidden, from the terminal board and the page alike (#400).
    const archived = withCaptures(emptyQuestions(), [{ version: 1, disposition: 'archived', record: first.records[0]! }])
    const kept = buildView([], [], null, now, 0, {}, s, [], {}, archived)
    const keptItems = boardItems(kept, [], false, true)
    const keptState = pinned({ ...emptyBoardState, isOlderOpen: true }, keptItems)
    expect(boardKey(keptState, 'h', keptItems, s).action).toEqual({ type: 'hide', key: first.records[0]!.id, text: 'Publish?' })
    expect(boardScreen(kept, [], keptState, s, { width: 500, isColor: false }).includes(s.questionReviewOnly)).toBe(false)
    // Nothing is running, so the note about archiving a live session does not belong on it.
    expect(boardScreen(kept, [], keptState, s, { width: 500, isColor: false }).includes(s.archiveLive)).toBe(false)
    expect(serveAction(keptItems, { key: keptItems[0]!.key, type: 'hide' }, s)).toEqual({ type: 'hide', key: first.records[0]!.id, text: 'Publish?' })
    const keptModel = serveModel(kept, [], s).older
    expect(keptModel.map(one => [one.canHide, one.key])).toEqual([[true, keptItems[0]!.key]])
  }
})

test('retaining a question changes no reminder identity while a new producer incarnation can notify', () => {
  const projects = parseProgress(board('- [?] Publish?'))
  const first = observeQuestions(emptyQuestions(), projects, null, [], START, true, 'remind:1').ledger
  const active = buildView(projects, [], null, START, 0, {}, STRINGS.en, [], {}, first)
  const notices = remindersOf(active, {}, START, '2026-10-01', STRINGS.en)
  const told = Object.fromEntries(notices.map(one => [one.key, START]))
  const retained = buildView([], [], null, START + 1, 0, {}, STRINGS.en, [], {}, withCaptures(emptyQuestions(), [{ version: 1, disposition: 'unresolved', record: first.records[0]! }]))
  expect(remindersOf(retained, told, START + 1, '2026-10-01', STRINGS.en)).toEqual([])
  const completed = observeQuestions(first, parseProgress(board('- [x] Publish?')), null, [], START + 1, true, 'remind:2').ledger
  const renewed = observeQuestions(completed, projects, null, [], START + 2, true, 'remind:3').ledger
  expect(remindersOf(buildView(projects, [], null, START + 2, 0, {}, STRINGS.en, [], {}, renewed), told, START + 2, '2026-10-01', STRINGS.en).length).toBe(1)
})

test('archiving a block refuses when a step\'s question annotation changed or now repeats another step\'s, so a kept question keeps its own identity', () => {
  const first = `${'a'.repeat(64)}:1`
  const second = `${'b'.repeat(64)}:1`
  const done = `${'d'.repeat(64)}:1`
  const text = board(`- [x] Synthetic preparation\n<!-- question=${done} -->\n- [?] Publish the first synthetic plan, OK?\n<!-- question=${first} -->\n- [?] Publish the second synthetic plan, OK?\n<!-- question=${second} -->`).replace('state=waiting', 'state=ended')
  const projects = parseProgress(text)
  expect(projects[0]!.tasks[0]!.steps.map(step => step.questionToken)).toEqual([done, first, second])
  const ledger = observeQuestions(emptyQuestions(), projects, null, [], START, true, 'seed').ledger
  const ref = { project: 'demo', title: 'Release', line: 2, session: 'a1b2c3d4' }
  expect(archiveQuestionsKept(projects, ref, ledger)).toBe(true)
  expect(archiveQuestionsKept(parseProgress(text.replace(second, `${'c'.repeat(64)}:1`)), ref, ledger)).toBe(false)
  expect(archiveQuestionsKept(parseProgress(text.replace(second, first)), ref, ledger)).toBe(false)
  // A finished step that now repeats a waiting step's token leaves every mark and waiting token
  // as it was, but the polls no longer see the waiting step's identity.
  expect(archiveQuestionsKept(parseProgress(text.replace(done, first)), ref, ledger)).toBe(false)
  // Two finished steps that share a token leave the waiting steps' identities as they were.
  const twice = board(`- [x] Synthetic preparation\n<!-- question=${done} -->\n- [x] Synthetic review\n<!-- question=${'e'.repeat(64)}:1 -->\n- [?] Publish the first synthetic plan, OK?\n<!-- question=${first} -->`).replace('state=waiting', 'state=ended')
  const kept = observeQuestions(emptyQuestions(), parseProgress(twice), null, [], START, true, 'seed').ledger
  expect(archiveQuestionsKept(parseProgress(twice.replace(`${'e'.repeat(64)}:1`, done)), ref, kept)).toBe(true)
})

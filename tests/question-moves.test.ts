import { test, expect } from 'claude-code/testing'
import { parseProgress } from '../hooks/parse'
import { emptyQuestions, observeQuestions, questionScope } from '../hooks/questions'
import type { QuestionLedger } from '../hooks/questions'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const A = 'deadbeef-0000-4000-8000-000000000001'
const B = 'deadbeef-0000-4000-8000-000000000002'
type Spec = { project: string; agent?: string; session?: string; resume?: string; steps?: string }
const block = ({ project, agent = 'codex', session = 'deadbeef', resume, steps = '- [?] Confirm the synthetic plan, OK?' }: Spec): string =>
  '## ' + project + '\n<!-- auto session=' + session + ' agent=' + agent + ' state=waiting updated=2026-10-16T12:00:00Z' + (resume === undefined ? '' : ' resume=' + resume) + ' -->\n### Synthetic task\n' + steps + '\n<!-- /auto session=' + session + ' -->\n'
const initial = (resume?: string): QuestionLedger =>
  observeQuestions(emptyQuestions(), parseProgress(block({ project: 'OldProject', resume })), null, [], NOW - 5000, true, 'before').ledger
const observe = (ledger: QuestionLedger, text: string, isSettled = true, frozen: ReadonlySet<string> = new Set()) =>
  observeQuestions(ledger, parseProgress(text), null, [], NOW, isSettled, 'after', { retired: [], consumed: [] }, [], [], frozen).ledger

test('moving a live block to another project supersedes the old question without changing its evidence', () => {
  for (const resume of [undefined, A]) {
    const before = initial(resume)
    const original = { ...before.records[0]!, producerSources: ['synthetic receipt'], isArchived: true }
    const ledger = { ...before, records: [original] }
    const snapshot = JSON.stringify(ledger)
    const after = observe(ledger, block({ project: 'NewProject', resume, steps: '- [?] Review the new synthetic plan?' }))
    const retained = after.records.find(record => record.id === original.id)
    expect(retained).toEqual({ ...original, isUnresolved: false, isPresent: false, isWaiting: false })
    expect(after.records.filter(record => record.isUnresolved)).toHaveLength(1)
    expect(after.records.find(record => record.isUnresolved)?.source?.project).toBe('NewProject')
    expect(JSON.stringify(ledger)).toBe(snapshot)
  }
})

test('a different full session sharing a short id never supersedes a missing project question', () => {
  for (const isSettled of [false, true]) {
    const before = initial(A)
    const original = { ...before.records[0]!, isArchived: true }
    const after = observe({ ...before, records: [original] }, block({ project: 'NewProject', resume: B }), isSettled)
    const retained = after.records.find(record => record.id === original.id)!
    expect(retained.isUnresolved).toBe(true)
    expect(retained.firstObserved).toBe(original.firstObserved)
    expect(retained.source).toEqual(original.source)
    expect(retained.isArchived).toBe(true)
  }
})

test('an unreadable saved block snapshot cannot prove a project move', () => {
  const before = initial(A)
  const original = before.records[0]!
  const ledger = { ...before, records: [{ ...original, source: { ...original.source!, data: '{not-json' } }] }
  const after = observe(ledger, block({ project: 'NewProject', resume: A }))
  const retained = after.records.find(record => record.id === original.id)!
  expect(retained.isUnresolved).toBe(true)
  expect(retained.firstObserved).toBe(original.firstObserved)
  expect(retained.source?.data).toBe('{not-json')
})

test('ambiguous live block destinations do not supersede a prior project question', () => {
  const before = initial(A)
  const original = before.records[0]!
  const after = observe(before, block({ project: 'NewProject', resume: A }) + block({ project: 'AnotherProject', resume: A }))
  expect(after.records.find(record => record.id === original.id)?.isUnresolved).toBe(true)
  expect(after.records.find(record => record.id === original.id)?.source).toEqual(original.source)
})

test('a colliding destination question scope keeps the former project question unresolved', () => {
  const before = initial(A)
  const original = before.records[0]!
  const after = observe(before, block({ project: 'NewProject', resume: A }) + block({ project: 'NewProject' }))
  const retained = after.records.find(record => record.id === original.id)!
  expect(retained.isUnresolved).toBe(true)
  expect(retained.firstObserved).toBe(original.firstObserved)
  expect(retained.source).toEqual(original.source)
  expect(after.records.filter(record => record.isUnresolved)).toHaveLength(1)
})

test('a move beside a same-prefix peer supersedes the mover alone', () => {
  const before = initial(A)
  const original = before.records[0]!
  const text = block({ project: 'NewProject', resume: A, steps: '- [?] Mover question?' }) + block({ project: 'NewProject', resume: B, steps: '- [?] Peer question?' })
  const after = observe(before, text)
  const retained = after.records.find(record => record.id === original.id)!
  expect(retained.isUnresolved).toBe(false)
  expect(retained.firstObserved).toBe(original.firstObserved)
  expect(retained.source).toEqual(original.source)
  expect(after.records.filter(record => record.isUnresolved).map(record => record.words).sort()).toEqual(['Mover question?', 'Peer question?'])
  const frozen = new Set([questionScope('NewProject', 'codex', 'deadbeef')])
  expect(observe(before, text, true, frozen).records.find(record => record.id === original.id)?.isUnresolved).toBe(true)
})

test('a moved block without question steps still supersedes its previous project question', () => {
  const before = initial(A)
  const original = before.records[0]!
  const after = observe(before, block({ project: 'NewProject', resume: A, steps: '- [x] Synthetic plan reviewed' }))
  expect(after.records.find(record => record.id === original.id)?.isUnresolved).toBe(false)
  expect(after.records.filter(record => record.isUnresolved)).toHaveLength(0)
  expect(after.records.find(record => record.id === original.id)?.source).toEqual(original.source)
})

test('a frozen destination or a different agent cannot prove a project move', () => {
  const before = initial(A)
  const original = before.records[0]!
  const frozen = new Set([questionScope('NewProject', 'codex', 'deadbeef')])
  const held = observe(before, block({ project: 'NewProject', resume: A }), true, frozen)
  const otherAgent = observe(before, block({ project: 'NewProject', resume: A, agent: 'antigravity' }))
  for (const after of [held, otherAgent]) {
    const retained = after.records.find(record => record.id === original.id)!
    expect(retained.isUnresolved).toBe(true)
    expect(retained.firstObserved).toBe(original.firstObserved)
    expect(retained.source).toEqual(original.source)
  }
})

test('project moves do not supersede own or inbox question sources', () => {
  const before = initial(A)
  const original = before.records[0]!
  for (const kind of ['own', 'inbox'] as const) {
    const source = { ...original.source!, kind }
    const ledger = { ...before, records: [{ ...original, source }] }
    const after = observe(ledger, block({ project: 'NewProject', resume: A }))
    const retained = after.records.find(record => record.id === original.id)!
    expect(retained.isUnresolved).toBe(true)
    expect(retained.source).toEqual(source)
    expect(retained.firstObserved).toBe(original.firstObserved)
  }
})

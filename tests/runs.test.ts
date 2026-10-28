import { expect, test } from 'claude-code/testing'

import { boardItems, boardScreen, boardText, chatText, emptyBoardState } from '../hooks/board'
import { renderAutoBlock, takeTask, upsertAutoBlock } from '../hooks/blocks'
import { dashboardHtml } from '../hooks/dashboard'
import { applyTaskCreate, emptyMirror } from '../hooks/mirror'
import { autoOf, parseProgress } from '../hooks/parse'
import { emptyQuestions, observeQuestions } from '../hooks/questions'
import { cleanSignal, codexSignal, foldRuns, pickParent, withRunMark, withSignal } from '../hooks/runs'
import { serveModel } from '../hooks/serve'
import { STRINGS } from '../hooks/strings'
import { buildView } from '../hooks/view'
import type { View } from '../hooks/view'

// Synthetic ids only: nothing here belongs to a real session.
const NOW = Date.parse('2026-10-27T12:00:00Z')
const PERSON = 'aaaa1111-0000-4000-8000-000000000001'
const OTHER = 'cccc3333-0000-4000-8000-000000000003'
const en = STRINGS.en

type Spec = { session: string; agent?: string; state?: string; ageMinutes?: number; resume?: string; run?: boolean; parent?: string; title?: string }

const block = (spec: Spec): string => {
  const attrs = [
    `session=${spec.session}`,
    `agent=${spec.agent ?? 'claude'}`,
    `state=${spec.state ?? 'working'}`,
    `updated=${new Date(NOW - (spec.ageMinutes ?? 1) * 60000).toISOString()}`,
    spec.resume === undefined ? '' : `resume=${spec.resume}`,
    spec.run === true ? 'origin=run' : '',
    spec.parent === undefined ? '' : `parent=${spec.parent}`,
  ].filter(part => part !== '')

  return [`<!-- auto ${attrs.join(' ')} -->`, `### ${spec.title ?? 'Synthetic task'}`, '- [~] A step', `<!-- /auto session=${spec.session} -->`, ''].join('\n')
}

const file = (...specs: Spec[]): string => `## Demo\n${specs.map(block).join('\n')}`
const viewOf = (text: string): View => buildView(parseProgress(text), [], null, NOW, 0, {}, en)
const rowsOf = (view: View) => boardItems(view, [], true).flatMap(item => (item.type === 'row' ? [item.row] : []))

const person: Spec = { session: 'aaaa1111', resume: PERSON, title: 'Ship the export feature' }
const delegate = (index: number, extra: Partial<Spec> = {}): Spec => ({
  session: `bbbb000${index}`, agent: 'codex', resume: `bbbb000${index}-0000-4000-8000-00000000000${index}`, run: true, parent: PERSON, ageMinutes: 20 + index, title: 'demo', ...extra,
})

test('a conversation a person started with three delegate runs is one row that says "+3 runs by Codex"', () => {
  const view = viewOf(file(person, delegate(1), delegate(2), delegate(3)))
  const rows = rowsOf(view)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.title).toBe('Ship the export feature')
  expect(rows[0]?.runs).toBe('+3 runs by Codex, last 21 min ago')
  expect(view.background).toBe(undefined)
  expect(view.overview.active).toBe(1)
})

test('runs by two agents are named together and the one that ran most comes first', () => {
  const view = viewOf(file(person, delegate(1), delegate(2), delegate(3, { agent: 'claude', resume: 'dddd4444-0000-4000-8000-000000000004' })))
  expect(rowsOf(view)[0]?.runs).toBe('+3 runs by Codex / Claude Code, last 21 min ago')
})

test('a run with no known parent is counted only on the Background runs line, never as a row or in the header', () => {
  const orphan = (index: number): Spec => delegate(index, { parent: undefined })
  const view = viewOf(file(person, orphan(1), orphan(2)))
  expect(rowsOf(view)).toHaveLength(1)
  expect(rowsOf(view)[0]?.runs).toBe(undefined)
  expect(view.background).toBe('Background runs: 2, last 21 min ago')
  expect(view.overview.active).toBe(1)
  expect(view.overview.waiting).toBe(0)
})

test('a run whose parent session is not in the file is counted on the Background runs line', () => {
  const view = viewOf(file(person, delegate(1, { parent: OTHER })))
  expect(rowsOf(view)).toHaveLength(1)
  expect(rowsOf(view)[0]?.runs).toBe(undefined)
  expect(view.background).toBe('Background runs: 1, last 21 min ago')
})

test('a run started by another run joins the row of the person who started the first one', () => {
  const inner = delegate(2, { parent: 'bbbb0001-0000-4000-8000-000000000001' })
  const view = viewOf(file(person, delegate(1), inner))
  expect(rowsOf(view)).toHaveLength(1)
  expect(rowsOf(view)[0]?.runs).toBe('+2 runs by Codex, last 21 min ago')
})

test('a parent can be named by the block id as well as by the full session id', () => {
  const view = viewOf(file(person, delegate(1, { parent: 'aaaa1111' })))
  expect(rowsOf(view)[0]?.runs).toBe('+1 run by Codex, last 21 min ago')
})

test('runs that start each other in a circle are counted as background runs and do not hang', () => {
  const one = delegate(1, { parent: 'bbbb0002-0000-4000-8000-000000000002' })
  const two = delegate(2, { parent: 'bbbb0001-0000-4000-8000-000000000001' })
  const view = viewOf(file(person, one, two))
  expect(rowsOf(view)).toHaveLength(1)
  expect(view.background).toBe('Background runs: 2, last 21 min ago')
})

test('the runs of a finished session are counted as background runs, since a finished session draws no row', () => {
  const text = file({ ...person, state: 'done' }, delegate(1), delegate(2)).replace('- [~] A step', '- [x] A step')
  const view = viewOf(text)
  expect(rowsOf(view)).toHaveLength(0)
  expect(view.background).toBe('Background runs: 2, last 21 min ago')
})

test('a run asks the person nothing, even when its own step is a question', () => {
  const text = file(person, delegate(1)).replace(/(session=bbbb0001[^\n]*\n### demo\n)- \[~\] A step/, '$1- [?] Which database should I use?')
  const view = viewOf(text)
  expect(view.overview.waiting).toBe(0)
  expect(view.waiting).toHaveLength(0)
})

test('a question a run saved in the ledger is not asked again and is not counted in the header', () => {
  const text = file(person, delegate(1)).replace(/(session=bbbb0001[^\n]*\n### demo\n)- \[~\] A step/, '$1- [?] Which database should I use?')
  const projects = parseProgress(text)
  // The writers save the ledger from every block of the file, a run's included.
  const ledger = observeQuestions(emptyQuestions(), projects, null, [], NOW - 60000, true, 'fixture:1').ledger
  expect(ledger.records.some(record => record.isUnresolved)).toBe(true)
  const view = buildView(projects, [], null, NOW, 0, {}, en, [], {}, ledger)
  expect(view.waiting).toHaveLength(0)
  expect(view.overview.waiting).toBe(0)
  expect(serveModel(view, [], en).asks).toEqual([])
  expect(rowsOf(view)).toHaveLength(1)
})

test('the runs of the session whose pane this is show on its current card, not on the Background runs line', () => {
  const mine = applyTaskCreate(emptyMirror(PERSON, 'Demo', NOW - 60000, ''), { subject: 'Write the exporter' }, '1', NOW - 60000)
  const view = buildView(parseProgress(file(person, delegate(1), delegate(2))), [], mine, NOW, 0, {}, en)
  expect(view.current?.runs).toBe('+2 runs by Codex, last 21 min ago')
  expect(view.background).toBe(undefined)
  expect(rowsOf(view)).toHaveLength(0)
})

test('the runs of the pane session with no current card are counted on the Background runs line', () => {
  const mine = emptyMirror(PERSON, 'Demo', NOW - 60000, '')
  const view = buildView(parseProgress(file(person, delegate(1))), [], mine, NOW, 0, {}, en)
  expect(view.current).toBe(null)
  expect(view.background).toBe('Background runs: 1, last 21 min ago')
})

test('the runs line says "just now" and "yesterday" the way a person would', () => {
  expect(en.runsLine(2, 'Codex', en.justNow)).toBe('+2 runs by Codex, just now')
  expect(en.runsLine(2, 'Codex', en.yesterday)).toBe('+2 runs by Codex, yesterday')
  expect(en.backgroundRuns(2, en.yesterday)).toBe('Background runs: 2, yesterday')
  for (const s of Object.values(STRINGS)) {
    expect(s.runsLine(2, 'Codex', s.justNow)).not.toContain('最近')
    expect(s.backgroundRuns(2, s.justNow)).not.toContain('最近')
  }
})

test('two blocks for one agent and one session id show as one row and the older is offered for archive', () => {
  const older: Spec = { session: 'eeee0001', agent: 'codex', resume: 'eeee0001-0000-4000-8000-000000000005', title: 'Old copy', ageMinutes: 30 }
  const newer: Spec = { session: 'eeee0002', agent: 'codex', resume: 'eeee0001-0000-4000-8000-000000000005', title: 'New copy', ageMinutes: 2 }
  const text = file(older, newer)
  const view = viewOf(text)
  const titles = rowsOf(view).map(row => row.title)
  expect(titles).toEqual(['New copy', 'Old copy'])
  expect(view.groups.flatMap(group => group.rows).map(row => row.title)).toEqual(['New copy'])
  expect(view.stopped.map(row => row.title)).toEqual(['Old copy'])
  const copy = view.stopped[0]
  expect(copy?.archive?.isDuplicate).toBe(true)
  expect(copy?.status).toBe(en.duplicateSession)
  const taken = copy?.archive == null ? null : takeTask(text, copy.archive, NOW, en)
  expect(taken?.text).not.toContain('Old copy')
  expect(taken?.text).toContain('New copy')
})

test('the archive of a live-looking block is refused unless a newer block carries the same agent and session id', () => {
  const lone: Spec = { session: 'ffff0001', agent: 'codex', resume: 'ffff0001-0000-4000-8000-000000000006', title: 'Only copy', ageMinutes: 2 }
  const text = file(lone)
  const view = viewOf(text)
  const row = rowsOf(view)[0]
  expect(row?.archive).toBe(null)
  const forged = { project: 'Demo', title: 'Only copy', line: parseProgress(text)[0]?.tasks[0]?.line ?? 0, session: 'ffff0001', isDuplicate: true as const }
  expect(takeTask(text, forged, NOW, en)).toBe(null)
})

test('a run mark on either block of a twin pair makes the session a run', () => {
  const marked: Spec = { session: 'eeee0001', agent: 'codex', resume: 'eeee0001-0000-4000-8000-000000000005', run: true, parent: PERSON, ageMinutes: 30, title: 'older' }
  const plain: Spec = { session: 'eeee0002', agent: 'codex', resume: 'eeee0001-0000-4000-8000-000000000005', ageMinutes: 2, title: 'newer' }
  const view = viewOf(file(person, marked, plain))
  expect(rowsOf(view).map(row => row.title)).toEqual(['Ship the export feature'])
  expect(rowsOf(view)[0]?.runs).toBe('+1 run by Codex, last 2 min ago')
})

test('blocks of different agents with one session id stay two rows', () => {
  const view = viewOf(file({ ...person, session: 'aaaa1111', resume: PERSON, title: 'Claude side' }, { session: 'aaaa2222', agent: 'codex', resume: PERSON, title: 'Codex side' }))
  expect(rowsOf(view)).toHaveLength(2)
  expect(view.stopped).toHaveLength(0)
})

test('a file with no origin or parent reads and folds exactly as before', () => {
  const text = file(person, { session: 'gggg0001', agent: 'codex', resume: 'gggg0001-0000-4000-8000-000000000007', title: 'Plain codex' })
  const folded = foldRuns(parseProgress(text))
  expect(folded.runs.size).toBe(0)
  expect(folded.background).toBe(null)
  expect(folded.duplicates).toHaveLength(0)
  expect(rowsOf(viewOf(text))).toHaveLength(2)
})

test('the marker is read as origin=run and a parent that is an id, and a parent without origin=run is ignored', () => {
  const [project] = parseProgress(file(delegate(1), delegate(2, { run: false }), delegate(3, { parent: '--oops' })))
  const [one, two, three] = (project?.tasks ?? []).map(task => task.auto)
  expect(one?.isRun).toBe(true)
  expect(one?.parent).toBe(PERSON)
  expect(two?.isRun).toBe(undefined)
  expect(two?.parent).toBe(undefined)
  expect(three?.isRun).toBe(true)
  expect(three?.parent).toBe(undefined)
  expect(autoOf('session=abcdef12 agent=claude state=working updated=2026-10-27T12:00:00Z origin=person')?.isRun).toBe(undefined)
  expect(autoOf('session=abcdef12 agent=claude state=working updated=2026-10-27T12:00:00Z origin=run')?.isRun).toBe(true)
})

test('a writer marks a print-mode session with origin=run and names the person working in the same project as its parent', () => {
  const mine = { ...emptyMirror('11111111-0000-4000-8000-0000000000aa', 'Demo', NOW, ''), isRun: true as const }
  const written = upsertAutoBlock(file(person), mine, en)
  expect(written).toContain(`origin=run parent=${PERSON}`)
  const [project] = parseProgress(written)
  const mirrored = project?.tasks.map(task => task.auto).find(auto => auto?.isRun === true)
  expect(mirrored?.parent).toBe(PERSON)
  const stays = upsertAutoBlock(written.replace('state=working', 'state=done'), { ...mine, updated: NOW + 1000 }, en)
  expect(stays).toContain(`origin=run parent=${PERSON}`)
})

test('a person\'s session is written with no origin and no parent', () => {
  const mine = emptyMirror('22222222-0000-4000-8000-0000000000bb', 'Demo', NOW, '')
  expect(renderAutoBlock(mine, en)[0]).not.toContain('origin=')
  expect(renderAutoBlock(mine, en)[0]).not.toContain('parent=')
  expect(upsertAutoBlock(file(person), mine, en)).not.toContain('origin=')
})

test('a print-mode session with no person working in its project is written with origin=run and no parent', () => {
  const mine = { ...emptyMirror('33333333-0000-4000-8000-0000000000cc', 'Elsewhere', NOW, ''), isRun: true as const }
  const written = upsertAutoBlock(file(person), mine, en)
  expect(written).toContain('origin=run')
  expect(written).not.toContain('parent=')
})

test('the mark on Claude\'s own mirror follows the mode: print mode is a run, interactive is a person', () => {
  const mirror = emptyMirror('44444444-0000-4000-8000-0000000000dd', 'Demo', NOW, '')
  expect(withRunMark(mirror, true).isRun).toBe(true)
  expect(withRunMark({ ...mirror, isRun: true }, false).isRun).toBe(undefined)
  expect('isRun' in withRunMark({ ...mirror, isRun: true }, false)).toBe(false)
})

test('the parent a writer picks is the one person session working in the same project, never the run itself or a stale one', () => {
  const stale: Spec = { session: 'hhhh0001', resume: 'hhhh0001-0000-4000-8000-000000000008', ageMinutes: 13 * 60 }
  const projects = parseProgress(file(person, stale, delegate(1, { ageMinutes: 0.1 })))
  expect(pickParent(projects, 'Demo', NOW)).toBe(PERSON)
  expect(pickParent(projects, ' demo ', NOW)).toBe(PERSON)
  expect(pickParent(projects, 'Demo', NOW, ['aaaa1111'])).toBe(null)
  expect(pickParent(projects, 'Elsewhere', NOW)).toBe(null)
  expect(pickParent(projects, '', NOW)).toBe(null)
  expect(pickParent(parseProgress(file({ ...person, state: 'done' })), 'Demo', NOW)).toBe(null)
  // Two blocks of one session (same agent and full id) are one session, so still one candidate.
  expect(pickParent(parseProgress(file(person, { ...person, session: 'aaaa1112', ageMinutes: 2 })), 'Demo', NOW)).toBe(PERSON)
  // A session whose twin is marked a run is a run, so it is not a candidate.
  expect(pickParent(parseProgress(file(person, { ...person, session: 'aaaa1112', ageMinutes: 2, run: true })), 'Demo', NOW)).toBe(null)
})

test('a run is given no parent when two person sessions are working in its project, and is counted only as a background run', () => {
  const newest: Spec = { session: 'hhhh0002', resume: 'hhhh0002-0000-4000-8000-000000000009', ageMinutes: 0.5, title: 'Fix the importer' }
  const projects = parseProgress(file(person, newest))
  expect(pickParent(projects, 'Demo', NOW)).toBe(null)
  // The run's own earlier block is not a candidate, but the two person sessions still are.
  expect(pickParent(projects, 'Demo', NOW, ['cccc0003'])).toBe(null)
  // With one of the two left out there is exactly one, and it is named.
  expect(pickParent(projects, 'Demo', NOW, ['hhhh0002'])).toBe(PERSON)
  const mine = { ...emptyMirror('11111111-0000-4000-8000-0000000000aa', 'Demo', NOW, ''), isRun: true as const }
  const written = upsertAutoBlock(file(person, newest), mine, en)
  expect(written).toContain('origin=run')
  expect(written).not.toContain('parent=')
  const view = viewOf(written)
  expect(rowsOf(view)).toHaveLength(2)
  expect(rowsOf(view).every(row => row.runs === undefined)).toBe(true)
  expect(view.background).toContain('Background runs: 1')
})

test('Codex marks a session a run from its first record: exec, a helper thread, a subagent or a program originator', () => {
  const run = { origin: 'run' }
  expect(codexSignal(true, 'x', { originator: 'codex_exec', source: 'exec', thread_source: 'user' })).toEqual(run)
  expect(codexSignal(true, 'x', { originator: 'Codex Desktop', source: 'exec', thread_source: 'user' })).toEqual(run)
  expect(codexSignal(true, 'x', { originator: 'Codex Desktop', source: 'vscode', thread_source: 'agent_created_thread' })).toEqual(run)
  expect(codexSignal(true, 'x', { originator: 'codex_exec', source: { subagent: true }, thread_source: 'subagent', parent_thread_id: PERSON })).toEqual({ origin: 'run', parent: PERSON })
  expect(codexSignal(true, 'x', { originator: 'Codex Desktop', source: { subagent: true }, thread_source: 'guardian_review' })).toEqual(run)
  expect(codexSignal(true, 'x', { originator: 'codex-sdk' })).toEqual(run)
})

test('Codex marks a session a person\'s when its first record says a person started it', () => {
  const stated = { origin: 'person' }
  expect(codexSignal(true, 'x', { originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' })).toEqual(stated)
  expect(codexSignal(true, 'x', { originator: 'codex-tui', source: 'vscode', thread_source: 'user' })).toEqual(stated)
  expect(codexSignal(true, 'x', { originator: 'An unknown program', source: 'vscode' })).toEqual(stated)
  expect(codexSignal(true, 'x', {})).toBe(undefined)
})

test('Codex without a history file is only a hint, and a host that sends no path gives no signal at all', () => {
  expect(codexSignal(true, null, null)).toEqual({ origin: 'run', isWeak: true })
  expect(codexSignal(true, '', null)).toEqual({ origin: 'run', isWeak: true })
  expect(codexSignal(true, '/some/rollout.jsonl', null)).toEqual({ origin: 'person', isWeak: true })
  expect(codexSignal(false, undefined, null)).toBe(undefined)
})

test('a Codex parent that is not an id is dropped from the signal', () => {
  expect(codexSignal(true, 'x', { source: 'exec', parent_thread_id: '--oops' })).toEqual({ origin: 'run' })
  expect(cleanSignal({ origin: 'run', parent: '--oops' })).toEqual({ origin: 'run' })
  expect(cleanSignal({ origin: 'person', parent: PERSON })).toEqual({ origin: 'person' })
  expect(cleanSignal({ origin: 'robot' })).toBe(undefined)
  expect(cleanSignal('run')).toBe(undefined)
  expect(cleanSignal(null)).toBe(undefined)
})

test('what a session record keeps: a statement replaces it, a hint never undoes a statement, and a run keeps its parent', () => {
  const statedRun = withSignal(null, { origin: 'run', parent: PERSON })
  expect(statedRun).toEqual({ origin: 'run', parent: PERSON })
  expect(withSignal(statedRun, { origin: 'run' })).toEqual({ origin: 'run', parent: PERSON })
  expect(withSignal(statedRun, { origin: 'person', isWeak: true })).toEqual(statedRun)
  expect(withSignal(statedRun, undefined)).toEqual(statedRun)
  expect(withSignal(statedRun, { origin: 'person' })).toEqual({ origin: 'person' })
  const hintRun = withSignal(null, { origin: 'run', isWeak: true })
  expect(hintRun).toEqual({ origin: 'run', isWeak: true })
  expect(withSignal(hintRun, { origin: 'person', isWeak: true })).toEqual({ origin: 'person', isWeak: true })
  expect(withSignal(hintRun, { origin: 'person' })).toEqual({ origin: 'person' })
  expect(withSignal({ origin: 'person' }, { origin: 'run', isWeak: true })).toEqual({ origin: 'person' })
  expect(withSignal(undefined, undefined)).toEqual({})
})

test('every board surface shows the runs line and the Background runs line and none shows a session id', () => {
  const orphan = delegate(4, { parent: undefined, resume: 'iiii9999-0000-4000-8000-000000000009', session: 'iiii9999' })
  const text = file(person, delegate(1), delegate(2), delegate(3), orphan)
  const view = viewOf(text)
  const surfaces = [
    boardText(view, [], en, { width: 100, isColor: false }),
    boardScreen(view, [], emptyBoardState, en, { width: 100, isColor: false }),
    chatText(view, [], [], en, '/home/synthetic'),
    dashboardHtml(view, en, 'progress.md', 'now'),
    JSON.stringify(serveModel(view, [], en)),
  ]
  for (const surface of surfaces) {
    expect(surface).toContain('+3 runs by Codex')
    expect(surface).toContain('Background runs: 1')
    for (const id of ['aaaa1111', 'bbbb0001', 'bbbb0002', 'bbbb0003', 'iiii9999', 'cccc3333']) expect(surface).not.toContain(id)
  }
  expect(boardText(view, [], en, { width: 100, isColor: false }).match(/Background runs/g)).toHaveLength(1)
})

test('the runs and background words exist in every language and carry the count', () => {
  for (const s of Object.values(STRINGS)) {
    expect(s.runsLine(3, 'Codex', '5')).toContain('3')
    expect(s.runsLine(3, 'Codex', '5')).toContain('Codex')
    expect(s.runsLine(1, 'Codex', '')).toContain('1')
    expect(s.backgroundRuns(4, '5')).toContain('4')
    expect(s.backgroundRuns(4, '')).toContain('4')
    expect(s.duplicateSession.length).toBeGreaterThan(0)
  }
})

import { expect, test } from 'claude-code/testing'
import type { ProgressMirror } from '../types'
import { emptyMirror } from '../hooks/mirror'
import { keepRecent, liveToldKeys, remindersOf, toldKey, TOLD_MAX } from '../hooks/remind'
import { boardRecords, currentPart, isExpiredRecord, monthPart, monthParts, pruneBatch, RETENTION, sizeWarnings, staleFailedInbox, staleStoreTemps, storeBytes } from '../hooks/retention'
import { STRINGS } from '../hooks/strings'
import { buildView, viewCache } from '../hooks/view'
import { parseProgress } from '../hooks/parse'

// Synthetic records only: made-up sessions, projects and file names (#373).
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const record = (state: ProgressMirror['state'], updated: number, open: boolean): ProgressMirror => ({
  ...emptyMirror('synthetic-session', 'synthetic-project', updated, '/work/synthetic', 'codex'),
  state,
  updated,
  tasks: [
    { id: '1', subject: 'Synthetic done step', status: 'completed', activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] },
    ...(open ? [{ id: '2', subject: 'Synthetic open step', status: 'pending' as const, activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] }] : []),
  ],
})

test('an ended agent record goes just over 3 days after its last write, and one still at work is kept for 30 days', () => {
  expect(isExpiredRecord('agent:0a1b2c3d', record('ended', NOW - 3 * DAY + HOUR, true), NOW)).toBe(false)
  expect(isExpiredRecord('agent:0a1b2c3d', record('ended', NOW - 3 * DAY - 1, true), NOW)).toBe(true)
  expect(isExpiredRecord('agent:0a1b2c3d', record('done', NOW - 3 * DAY - 1, false), NOW)).toBe(true)
  expect(isExpiredRecord('agent:0a1b2c3d', record('waiting', NOW - 29 * DAY, true), NOW)).toBe(false)
  expect(isExpiredRecord('agent:0a1b2c3d', record('working', NOW - 30 * DAY - 1, true), NOW)).toBe(true)
})

test('a mirror with open steps is kept at 29 days, and one with none goes just over 7 days', () => {
  expect(isExpiredRecord('mirror:synthetic-1', record('ended', NOW - 29 * DAY, true), NOW)).toBe(false)
  expect(isExpiredRecord('mirror:synthetic-1', record('working', NOW - 30 * DAY - 1, true), NOW)).toBe(true)
  expect(isExpiredRecord('mirror:synthetic-2', record('ended', NOW - 7 * DAY + HOUR, false), NOW)).toBe(false)
  expect(isExpiredRecord('mirror:synthetic-2', record('ended', NOW - 7 * DAY - 1, false), NOW)).toBe(true)
  // A session that never made a list has no open step either.
  expect(isExpiredRecord('mirror:synthetic-3', { ...record('working', NOW - 8 * DAY, false), tasks: [] }, NOW)).toBe(true)
})

test('hint and done marks keep their 30 days, a broken record counts as old, and settings never age', () => {
  expect(isExpiredRecord('hinted:synthetic', NOW - 29 * DAY, NOW)).toBe(false)
  expect(isExpiredRecord('done:synthetic::Synthetic task', NOW - 31 * DAY, NOW)).toBe(true)
  expect(isExpiredRecord('pendingInboxQuestion:synthetic', { at: NOW - 2 * DAY }, NOW)).toBe(false)
  expect(isExpiredRecord('pendingInboxQuestion:synthetic', { at: NOW - 3 * DAY - 1 }, NOW)).toBe(true)
  expect(isExpiredRecord('mirror:synthetic-4', 'not a mirror', NOW)).toBe(true)
  for (const key of ['closedByPerson', 'lang', 'told', 'inboxDone', 'completion:synthetic', 'agentPrompt:synthetic:1:2', 'pendingJournal:synthetic', 'generated:/synthetic/file']) {
    expect(isExpiredRecord(key, { updated: 0, at: 0 }, NOW)).toBe(false)
  }
})

test('a record whose block is still on the board is kept whatever its age, and one whose block is gone is not', () => {
  const text = [
    '## synthetic-project',
    '<!-- auto session=0a1b2c3d agent=codex state=ended updated=2026-10-10T12:00:00.000Z -->',
    '### Synthetic codex task',
    '- [x] Synthetic step',
    '<!-- /auto session=0a1b2c3d -->',
    '<!-- auto session=9f8e7d6c agent=claude state=ended updated=2026-10-10T12:00:00.000Z resume=9f8e7d6c-0000-4000-8000-000000000001 -->',
    '### Synthetic claude task',
    '- [x] Synthetic step',
    '<!-- /auto session=9f8e7d6c -->',
    '### Synthetic hand-kept task',
    '- [ ] Synthetic step',
    '',
  ].join('\n')
  const isOnBoard = boardRecords(parseProgress(text))
  expect(isOnBoard('agent:0a1b2c3d')).toBe(true)
  expect(isOnBoard('mirror:9f8e7d6c-0000-4000-8000-000000000001')).toBe(true)
  // A Claude session's block is named by the start of its id, with or without resume=.
  expect(isOnBoard('mirror:0a1b2c3d-1111-4000-8000-000000000002')).toBe(true)
  expect(isOnBoard('agent:5e5e5e5e')).toBe(false)
  expect(isOnBoard('mirror:5e5e5e5e-0000-4000-8000-000000000003')).toBe(false)
  expect(isOnBoard('hinted:0a1b2c3d')).toBe(false)
})

test('a pass over the store reads at most 20 values, and the next pass starts where the last one stopped', () => {
  const keys = ['lang', 'told', ...Array.from({ length: 45 }, (_, n) => `agent:${String(n).padStart(4, '0')}`), 'generated:/synthetic/board.mjs']
  const first = pruneBatch(keys, '')
  expect(first.batch).toHaveLength(RETENTION.pruneReads)
  expect(first.batch[0]).toBe('agent:0000')
  const second = pruneBatch(keys, first.next)
  expect(second.batch[0]).toBe('agent:0020')
  const third = pruneBatch(keys, second.next)
  expect(third.batch).toEqual(['agent:0040', 'agent:0041', 'agent:0042', 'agent:0043', 'agent:0044'])
  // The walk reached the end: the next pass starts over.
  expect(third.next).toBe('')
  // A key the last pass stopped at may be gone by now; the walk goes on after it.
  expect(pruneBatch(keys.filter(key => key !== first.next), first.next).batch[0]).toBe('agent:0020')
  expect(pruneBatch(['lang', 'told'], '')).toEqual({ batch: [], next: '' })
})

test('reminders told are keyed by where and what was asked, kept 3 days and at most 500', () => {
  const key = toldKey('synthetic-project', 'codex', 'Synthetic task', 'Publish the synthetic page, OK?')
  expect(key).toMatch(/^ask:[0-9a-f]{16}$/)
  expect(toldKey('synthetic-project', 'codex', 'Synthetic task', 'Publish the synthetic page, OK?')).toBe(key)
  expect(toldKey('other-project', 'codex', 'Synthetic task', 'Publish the synthetic page, OK?')).not.toBe(key)
  const told: Record<string, number> = {}
  for (let n = 0; n < 900; n++) told[`ask:${String(n).padStart(16, '0')}`] = NOW - n * 60 * 1000
  told['ask:old'] = NOW - 3 * DAY - 1
  const kept = keepRecent(told, NOW)
  expect(Object.keys(kept)).toHaveLength(TOLD_MAX)
  // The newest stay.
  expect(kept['ask:0000000000000000']).toBe(NOW)
  expect(kept['ask:old']).toBeUndefined()
  // A question still waiting keeps its key past the cap, however many were told since.
  expect(keepRecent(told, NOW, new Set(['ask:0000000000000899']))['ask:0000000000000899']).toBe(NOW - 899 * 60 * 1000)
  expect(Object.keys(keepRecent(told, NOW, new Set(['ask:0000000000000899'])))).toHaveLength(TOLD_MAX)
})

test('a question keeps one reminder key when the ledger is rebuilt, and an old key still counts as told', () => {
  const text = [
    '## synthetic-project',
    '<!-- auto session=0a1b2c3d agent=codex state=waiting updated=2026-10-16T11:30:00.000Z -->',
    '### Synthetic task',
    '- [?] Synthetic step — Publish the synthetic page, OK?',
    '<!-- /auto session=0a1b2c3d -->',
    '',
  ].join('\n')
  const view = buildView(parseProgress(text), [], null, NOW)
  const first = remindersOf(view, {}, NOW, '2026-10-16')
  expect(first).toHaveLength(1)
  const item = view.waiting[0]
  expect(item).toBeDefined()
  // The same words asked again after a rebuild (a new question id) are not said again.
  const rebuilt = { ...view, waiting: view.waiting.map(one => ({ ...one, questionId: 'synthetic-rebuilt-id' })) }
  expect(remindersOf(rebuilt, { [first[0]?.key ?? '']: NOW }, NOW, '2026-10-16')).toEqual([])
  // What an earlier release kept still counts, so an update does not say every question again.
  const legacy = `ask:${item?.questionId ?? item?.key}:${item?.text}`
  expect(remindersOf(view, { [legacy]: NOW }, NOW, '2026-10-16')).toEqual([])
  expect([...liveToldKeys(view)].sort()).toEqual([first[0]?.key ?? '', legacy].sort())
})

test("only this plugin's store copies older than a day and inbox files given up on a week ago are swept", () => {
  const file = (name: string, age: number, size = 10) => ({ name, kind: 'file', size, mtimeMs: NOW - age })
  const store = [
    file('agent-board_agent-board-0a1b2c3d4e5f.json', 0, 900_000),
    file('agent-board_agent-board-0a1b2c3d4e5f.json.tmp.20fb583a', DAY + 1),
    file('agent-board_agent-board-0a1b2c3d4e5f.json.tmp.3b28eca4', DAY - HOUR),
    file('agent-board_inline-9f8e7d6c5b4a.json', 0, 1_300_000),
    file('another-plugin_x-0a1b2c3d4e5f.json.tmp.20fb583a', 9 * DAY),
    { name: 'agent-board_agent-board-0a1b2c3d4e5f.json.tmp.dir', kind: 'dir', size: 0, mtimeMs: NOW - 9 * DAY },
  ]
  expect(staleStoreTemps(store, NOW)).toEqual(['agent-board_agent-board-0a1b2c3d4e5f.json.tmp.20fb583a'])
  expect(storeBytes(store)).toBe(1_300_000)
  const inbox = [file('codex-turn-1-1.json.failed', 7 * DAY + 1), file('codex-turn-1-2.json.failed.1', 8 * DAY), file('codex-turn-1-3.json.failed', 6 * DAY), file('codex-turn-1-4.json', 9 * DAY), file('codex-turn-1-5.json.tmp', 9 * DAY)]
  expect(staleFailedInbox(inbox, NOW)).toEqual(['codex-turn-1-1.json.failed', 'codex-turn-1-2.json.failed.1'])
  // A rename keeps the file's own time: one set aside a day ago is kept a week from then.
  expect(staleFailedInbox(inbox, NOW, { 'codex-turn-1-1.json.failed': NOW - DAY })).toEqual(['codex-turn-1-2.json.failed.1'])
})

test("a month's journal goes on in a second part once the first reaches 1 MB, and readers find every part", () => {
  const base = '/home/synthetic/.claude/progress-journal-2026-10.md'
  expect(monthPart(base, 1)).toBe(base)
  expect(monthPart(base, 2)).toBe('/home/synthetic/.claude/progress-journal-2026-10-2.md')
  const sizes = new Map<string, number>([[base, RETENTION.monthPartBytes - 1]])
  expect(currentPart(base, path => sizes.get(path) ?? null)).toBe(base)
  sizes.set(base, RETENTION.monthPartBytes)
  expect(currentPart(base, path => sizes.get(path) ?? null)).toBe(monthPart(base, 2))
  sizes.set(monthPart(base, 2), 10)
  expect(monthParts(base, path => sizes.has(path))).toEqual([base, monthPart(base, 2)])
  expect(monthParts('/home/synthetic/.claude/progress-archive-2026-09.md', () => false)).toEqual([])
})

test('a size warning shows only past its limit and says what is kept', () => {
  const s = STRINGS.en
  expect(sizeWarnings({ progress: RETENTION.progressSoftBytes, store: RETENTION.storeWarnBytes }, s)).toEqual([])
  const [progress, store] = sizeWarnings({ progress: 600 * 1024, store: 1.3 * 1024 * 1024 }, s)
  expect(progress).toBe(s.progressLarge(600, 512))
  expect(progress).toContain('hand-kept tasks and steps waiting on you are never removed')
  expect(store).toBe(s.storeLarge('1.3', '1.5'))
})

test("the board's view is built once for the same inputs and again when one changes", () => {
  const text = '## synthetic-project\n### Synthetic task\n- [ ] Synthetic step\n'
  const views = viewCache()
  const projects = parseProgress(text)
  const first = views.view(projects, [], null, NOW, 0, {}, STRINGS.en)
  // A copy read again is the same input.
  expect(views.view(parseProgress(text), [], null, NOW, 0, {}, STRINGS.en)).toBe(first)
  expect(views.built()).toBe(1)
  // The dashboard's view (no session) does not push the session's out.
  views.view(projects, ['synthetic-project'], null, NOW, 0, {}, STRINGS.en)
  expect(views.view(projects, [], null, NOW, 0, {}, STRINGS.en)).toBe(first)
  expect(views.built()).toBe(2)
  expect(views.view(projects, [], null, NOW + 1, 0, {}, STRINGS.en)).not.toBe(first)
  expect(views.view(projects, [], null, NOW, 0, {}, STRINGS['zh-TW'])).not.toBe(first)
  expect(views.built()).toBe(4)
})

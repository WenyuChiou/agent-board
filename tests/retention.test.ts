import { expect, test } from 'claude-code/testing'
import type { ProgressMirror } from '../types'
import { emptyMirror } from '../hooks/mirror'
import { keepRecent, liveToldKeys, remindersOf, toldKey } from '../hooks/remind'
import { addPruned, boardRecords, boardTag, companionKeys, countPruned, currentPart, isExpiredRecord, isSameWrite, monthPart, monthParts, overCapKeys, pruneBatch, prunedNote, prunedSince, prunedTotal, recordBytes, sizeWarnings, staleFailedInbox, staleInboxTemps, staleStoreTemps, storeBytes, unseenFailedInbox } from '../hooks/retention'
import { completionPrefix } from '../hooks/mirror'
import { STRINGS } from '../hooks/strings'
import { buildView, viewCache } from '../hooks/view'
import { parseProgress } from '../hooks/parse'

// Synthetic records only: made-up sessions, projects and file names (#373).
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// The tag of the board every record below is saved for, and of a second board on the same machine.
const BOARD = boardTag('/synthetic/home/.claude/progress.md')
const OTHER = boardTag('/synthetic/other/progress.md')

const record = (state: ProgressMirror['state'], updated: number, open: boolean): ProgressMirror => ({
  ...emptyMirror('synthetic-session', 'synthetic-project', updated, '/work/synthetic', 'codex'),
  state,
  updated,
  board: BOARD,
  tasks: [
    { id: '1', subject: 'Synthetic done step', status: 'completed', activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] },
    ...(open ? [{ id: '2', subject: 'Synthetic open step', status: 'pending' as const, activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] }] : []),
  ],
})

test('records expire only once past their 3, 7 and 30 days, to the millisecond', () => {
  const cases = [
    ['agent:synthetic', 'ended', true, 259200000],
    ['agent:synthetic', 'done', false, 259200000],
    ['agent:synthetic', 'working', true, 2592000000],
    ['mirror:synthetic', 'ended', false, 604800000],
    ['mirror:synthetic', 'ended', true, 2592000000],
    ['hinted:synthetic', 'ended', false, 2592000000],
    ['done:synthetic', 'ended', false, 2592000000],
    ['pendingInboxQuestion:synthetic', 'ended', false, 259200000],
  ] as const
  for (const [key, state, isOpen, age] of cases) {
    for (const offset of [-1, 0, 1]) {
      const updated = NOW - age - offset
      const value = key.startsWith('pendingInboxQuestion:') ? { at: updated } : key.startsWith('hinted:') || key.startsWith('done:') ? updated : record(state, updated, isOpen)
      expect(isExpiredRecord(key, value, NOW, BOARD)).toBe(offset > 0)
    }
  }
  const entries = [-1, 0, 1].map(offset => ({ name: `synthetic-${offset}.json.failed`, kind: 'file', size: 1, mtimeMs: 0 }))
  const setAside = Object.fromEntries([-1, 0, 1].map(offset => [`synthetic-${offset}.json.failed`, NOW - 604800000 - offset]))
  expect(staleFailedInbox(entries, NOW, setAside)).toEqual(['synthetic-1.json.failed'])
})

test('a told reminder is dropped once it is exactly 3 days old', () => {
  const told = { before: NOW - 259199999, at: NOW - 259200000, after: NOW - 259200001 }
  expect(keepRecent(told, NOW)).toEqual({ before: told.before })
})

test('warnings start above 524288 and 1258291.2 bytes', () => {
  for (const [progress, store] of [[524287, 1258290.2], [524288, 1258291.2], [524288, 1258291]]) {
    expect(sizeWarnings({ progress: progress ?? 0, store: store ?? 0 }, STRINGS.en)).toEqual([])
  }
  expect(sizeWarnings({ progress: 524289, store: 1258292 }, STRINGS.en)).toEqual([
    STRINGS.en.progressLarge(512, 512),
    STRINGS.en.storeLarge('1.2', '1.5'),
  ])
})

test('an ended agent record goes just over 3 days after its last write, and one still at work is kept for 30 days', () => {
  expect(isExpiredRecord('agent:0a1b2c3d', record('ended', NOW - 259200000 + HOUR, true), NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('agent:0a1b2c3d', record('ended', NOW - 259200000 - 1, true), NOW, BOARD)).toBe(true)
  expect(isExpiredRecord('agent:0a1b2c3d', record('done', NOW - 259200000 - 1, false), NOW, BOARD)).toBe(true)
  expect(isExpiredRecord('agent:0a1b2c3d', record('waiting', NOW - 29 * DAY, true), NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('agent:0a1b2c3d', record('working', NOW - 2592000000 - 1, true), NOW, BOARD)).toBe(true)
})

test('a mirror with open steps is kept at 29 days, and one with none goes just over 7 days', () => {
  expect(isExpiredRecord('mirror:synthetic-1', record('ended', NOW - 29 * DAY, true), NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('mirror:synthetic-1', record('working', NOW - 2592000000 - 1, true), NOW, BOARD)).toBe(true)
  expect(isExpiredRecord('mirror:synthetic-2', record('ended', NOW - 604800000 + HOUR, false), NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('mirror:synthetic-2', record('ended', NOW - 604800000 - 1, false), NOW, BOARD)).toBe(true)
  // A session that never made a list has no open step either.
  expect(isExpiredRecord('mirror:synthetic-3', { ...record('working', NOW - 8 * DAY, false), tasks: [] }, NOW, BOARD)).toBe(true)
})

test('hint and done marks keep their 30 days, a broken record counts as old, and settings never age', () => {
  expect(isExpiredRecord('hinted:synthetic', NOW - 29 * DAY, NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('done:synthetic::Synthetic task', NOW - 31 * DAY, NOW, BOARD)).toBe(true)
  expect(isExpiredRecord('pendingInboxQuestion:synthetic', { at: NOW - 2 * DAY }, NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('pendingInboxQuestion:synthetic', { at: NOW - 259200000 - 1 }, NOW, BOARD)).toBe(true)
  expect(isExpiredRecord('mirror:synthetic-4', 'not a mirror', NOW, BOARD)).toBe(true)
  for (const key of ['closedByPerson', 'lang', 'told', 'inboxDone', 'completion:synthetic', 'agentPrompt:synthetic:1:2', 'pendingJournal:synthetic', 'generated:/synthetic/file']) {
    expect(isExpiredRecord(key, { updated: 0, at: 0 }, NOW, BOARD)).toBe(false)
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
  expect(first.batch).toHaveLength(20)
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

test('reminders told are keyed by a short hash of the question and its words, kept 3 days and at most 500', () => {
  const key = toldKey('synthetic-question-1', 'Publish the synthetic page, OK?')
  expect(key).toMatch(/^ask:[0-9a-f]{16}$/)
  expect(toldKey('synthetic-question-1', 'Publish the synthetic page, OK?')).toBe(key)
  expect(toldKey('synthetic-question-2', 'Publish the synthetic page, OK?')).not.toBe(key)
  expect(toldKey('synthetic-question-1', 'Publish the other synthetic page, OK?')).not.toBe(key)
  const told: Record<string, number> = {}
  for (let n = 0; n < 900; n++) told[`ask:${String(n).padStart(16, '0')}`] = NOW - n * 60 * 1000
  told['ask:old'] = NOW - 259200000 - 1
  const kept = keepRecent(told, NOW)
  expect(Object.keys(kept)).toHaveLength(500)
  // The newest stay.
  expect(kept['ask:0000000000000000']).toBe(NOW)
  expect(kept['ask:old']).toBeUndefined()
  // A question still waiting keeps its key past the cap, however many were told since.
  expect(keepRecent(told, NOW, new Set(['ask:0000000000000899']))['ask:0000000000000899']).toBe(NOW - 899 * 60 * 1000)
  expect(Object.keys(keepRecent(told, NOW, new Set(['ask:0000000000000899'])))).toHaveLength(500)
})

test('a waiting question is told once under its short key, and the key an earlier release kept still counts as told', () => {
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
  expect(first[0]?.key).toMatch(/^ask:[0-9a-f]{16}$/)
  expect(remindersOf(view, { [first[0]?.key ?? '']: NOW }, NOW, '2026-10-16')).toEqual([])
  // What an earlier release kept still counts, so an update does not say every question again.
  const legacy = `ask:${item?.questionId ?? item?.key}:${item?.text}`
  expect(remindersOf(view, { [legacy]: NOW }, NOW, '2026-10-16')).toEqual([])
  expect([...liveToldKeys(view)].sort()).toEqual([first[0]?.key ?? '', legacy].sort())
  // The reminder carries that key too, for the store to write beside the short one until 0.25.
  expect(first[0]?.oldKey).toBe(legacy)
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
  const inbox = [file('codex-turn-1-1.json.failed', 604800000 + 1), file('codex-turn-1-2.json.failed.1', 8 * DAY), file('codex-turn-1-3.json.failed', 6 * DAY), file('codex-turn-1-4.json', 9 * DAY), file('codex-turn-1-5.json.tmp', 9 * DAY)]
  // A file set aside is kept a week from when that was done, whatever its own date.
  const setAside = { 'codex-turn-1-1.json.failed': NOW - 604800000 - 1, 'codex-turn-1-2.json.failed.1': NOW - 604800000 - HOUR, 'codex-turn-1-3.json.failed': NOW - 6 * DAY }
  expect(staleFailedInbox(inbox, NOW, setAside)).toEqual(['codex-turn-1-1.json.failed', 'codex-turn-1-2.json.failed.1'])
  expect(staleFailedInbox(inbox, NOW, { ...setAside, 'codex-turn-1-1.json.failed': NOW - DAY })).toEqual(['codex-turn-1-2.json.failed.1'])
})

test("a month's journal goes on in a second part once the first reaches 1 MB, and readers find every part", () => {
  const base = '/home/synthetic/.claude/progress-journal-2026-10.md'
  expect(monthPart(base, 1)).toBe(base)
  expect(monthPart(base, 2)).toBe('/home/synthetic/.claude/progress-journal-2026-10-2.md')
  // Rotation starts at the limit, so one byte under still uses the first part.
  const sizes = new Map<string, number>([[base, 1048575]])
  expect(currentPart(base, path => sizes.get(path) ?? null)).toBe(base)
  sizes.set(base, 1048576)
  expect(currentPart(base, path => sizes.get(path) ?? null)).toBe(monthPart(base, 2))
  sizes.set(monthPart(base, 2), 10)
  expect(monthParts(base, path => sizes.has(path))).toEqual([base, monthPart(base, 2)])
  expect(monthParts('/home/synthetic/.claude/progress-archive-2026-09.md', () => false)).toEqual([])
})

test('a size warning shows only past its limit and says what is kept', () => {
  const s = STRINGS.en
  expect(sizeWarnings({ progress: 524288, store: 1258291.2 }, s)).toEqual([])
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

// A record padded to a size that matters to the cap, with the state and write time it is judged by.
const padded = (state: ProgressMirror['state'], updated: number, open: boolean) => ({ ...record(state, updated, open), pad: 'x'.repeat(1000) })

test('a store at or over 1572864 bytes loses its oldest ended agent and mirror records off the board first, until it is under the cap', () => {
  const records = [
    { key: 'agent:0a0a0a05', value: padded('ended', NOW - 1 * DAY, false) },
    { key: 'mirror:0a0a0a04', value: padded('done', NOW - 5 * DAY, true) },
    { key: 'agent:0a0a0a01', value: padded('ended', NOW - 259200000, false) },
    // Still at work: not ended, so the cap leaves it though it is the oldest.
    { key: 'agent:0a0a0a03', value: padded('working', NOW - 9 * DAY, true) },
    { key: 'agent:0a0a0a02', value: padded('ended', NOW - 2 * DAY, false) },
  ]
  const each = recordBytes('agent:0a0a0a01', records[2]?.value)
  const never = (): boolean => false
  // Two and a half records over the cap: two records leave it still over, so three go.
  const over = 1572864 + Math.round(2.5 * each)
  expect(overCapKeys(records, never, over, BOARD)).toEqual(['mirror:0a0a0a04', 'agent:0a0a0a01', 'agent:0a0a0a02'])
  // Exactly at the cap counts as over; one byte under it loses nothing.
  expect(overCapKeys(records, never, 1572864, BOARD)).toEqual(['mirror:0a0a0a04'])
  expect(overCapKeys(records, never, 1572863, BOARD)).toEqual([])
  // Records that are not the cap's to take are never named.
  expect(overCapKeys([{ key: 'told', value: padded('ended', NOW - 9 * DAY, false) }, { key: 'hinted:0a0a0a01', value: padded('ended', NOW - 9 * DAY, false) }], never, 4000000, BOARD)).toEqual([])
})

test('a record on the board and a mirror with open steps of a session on the board stay when the store stays over the cap', () => {
  const board = [
    '## synthetic-project',
    '<!-- auto session=0a1b2c3d agent=codex state=ended updated=2026-10-10T12:00:00.000Z -->',
    '### Synthetic codex task',
    '- [x] Synthetic step',
    '<!-- /auto session=0a1b2c3d -->',
    '<!-- auto session=9f8e7d6c agent=claude state=working updated=2026-10-16T11:00:00.000Z -->',
    '### Synthetic claude task',
    '- [ ] Synthetic open step',
    '<!-- /auto session=9f8e7d6c -->',
    '',
  ].join('\n')
  const records = [
    { key: 'agent:0a1b2c3d', value: padded('ended', NOW - 9 * DAY, false) },
    { key: 'mirror:9f8e7d6c-0000-4000-8000-000000000001', value: padded('ended', NOW - 8 * DAY, true) },
    { key: 'mirror:5e5e5e5e-0000-4000-8000-000000000003', value: padded('ended', NOW - 2 * DAY, true) },
  ]
  // The store is far over the cap: the one record off the board goes and the others stay.
  expect(overCapKeys(records, boardRecords(parseProgress(board)), 5000000, BOARD)).toEqual(['mirror:5e5e5e5e-0000-4000-8000-000000000003'])
})

test('the counts of what was cleared are kept by UTC day for 7 days, add up, and skip entries that do not read', () => {
  const removed = countPruned(['agent:0a0a0a01', 'agent:0a0a0a02', 'mirror:synthetic-m1', 'hinted:synthetic-old'])
  expect(removed).toEqual({ agent: 2, mirror: 1 })
  const first = addPruned(undefined, removed, NOW)
  expect(first).toEqual({ '2026-10-16': { agent: 2, mirror: 1 } })
  // A second removal the same day adds to it; one a day later is its own day.
  const second = addPruned(first, { agent: 1, mirror: 0 }, NOW + 2 * HOUR)
  expect(second).toEqual({ '2026-10-16': { agent: 3, mirror: 1 } })
  const third = addPruned(second, { agent: 4, mirror: 2 }, NOW + DAY)
  expect(prunedTotal(third, NOW + DAY)).toEqual({ agent: 7, mirror: 3 })
  // The window is today and the six days before it: day 7 back is out, day 6 back is in.
  expect(prunedSince(NOW)).toBe(Date.parse('2026-10-10T00:00:00Z'))
  expect(prunedTotal(third, NOW + 6 * DAY)).toEqual({ agent: 7, mirror: 3 })
  expect(prunedTotal(third, NOW + 604800000)).toEqual({ agent: 4, mirror: 2 })
  expect(addPruned(third, { agent: 1, mirror: 0 }, NOW + 604800000)).toEqual({ '2026-10-17': { agent: 4, mirror: 2 }, '2026-10-23': { agent: 1, mirror: 0 } })
  expect(addPruned(third, { agent: 1, mirror: 0 }, NOW + 8 * DAY)).toEqual({ '2026-10-24': { agent: 1, mirror: 0 } })
  // Whatever else is in the value is let go.
  const broken = { '2026-10-16': { agent: 2, mirror: 1 }, soon: { agent: 1, mirror: 1 }, '2026-10-15': { agent: -1, mirror: 0 }, '2026-10-14': { agent: 1.5, mirror: 0 }, '2026-10-13': { agent: 1 }, '2026-10-12': 'x' }
  expect(prunedTotal(broken, NOW)).toEqual({ agent: 2, mirror: 1 })
  for (const junk of [null, 'x', 4, [], undefined]) expect(prunedTotal(junk, NOW)).toEqual({ agent: 0, mirror: 0 })
})

test('the line saying what was cleared names each kind in all three languages, and is absent when nothing was', () => {
  const some = { agent: 12, mirror: 1, turns: 340 }
  expect(prunedNote(some, STRINGS.en)).toBe('Cleared 12 old agent records, 1 old session task list and 340 unread inbox turns in the last 7 days')
  expect(prunedNote({ agent: 12, mirror: 0, turns: 340 }, STRINGS.en)).toBe('Cleared 12 old agent records and 340 unread inbox turns in the last 7 days')
  expect(prunedNote({ agent: 0, mirror: 0, turns: 1 }, STRINGS.en)).toBe('Cleared 1 unread inbox turn in the last 7 days')
  expect(prunedNote(some, STRINGS['zh-TW'])).toBe('最近 7 天清掉了 12 筆舊的 agent 紀錄、1 份舊的 session 工作清單和 340 則還沒讀的收件匣回合')
  expect(prunedNote(some, STRINGS['zh-CN'])).toBe('最近 7 天清掉了 12 条旧的 agent 记录、1 份旧的 session 工作清单和 340 条还没读的收件箱回合')
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) expect(prunedNote({ agent: 0, mirror: 0, turns: 0 }, STRINGS[lang])).toBeNull()
})

// A record saved by a release before 0.24, which wrote no board tag.
const untagged = (state: ProgressMirror['state'], updated: number, open: boolean): ProgressMirror => {
  const { board: _board, ...rest } = record(state, updated, open)
  return rest
}

test('a board tags its records with a short hash of its path, and other boards use the 30-day rule', () => {
  expect(boardTag('/synthetic/home/.claude/progress.md')).toMatch(/^[0-9a-f]{8}$/)
  expect(boardTag('/synthetic/home/.claude/progress.md')).toBe(BOARD)
  expect(OTHER).not.toBe(BOARD)
  // Another board's record uses the long life, even if it ended.
  expect(isExpiredRecord('agent:0a1b2c3d', { ...record('ended', NOW - 9 * DAY, false), board: OTHER }, NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('mirror:synthetic-5', { ...record('ended', NOW - 40 * DAY, false), board: OTHER }, NOW, BOARD)).toBe(true)
  expect(isExpiredRecord('agent:0a1b2c3d', record('ended', NOW - 9 * DAY, false), NOW, BOARD)).toBe(true)
  expect(isExpiredRecord('agent:0a1b2c3d', { ...record('ended', NOW - 9 * DAY, false), board: OTHER }, NOW, OTHER)).toBe(true)
})

test('a record with no board tag stays on the 30-day rule, however it ended', () => {
  expect(isExpiredRecord('agent:0a1b2c3d', untagged('ended', NOW - 4 * DAY, false), NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('agent:0a1b2c3d', untagged('ended', NOW - 29 * DAY, false), NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('agent:0a1b2c3d', untagged('ended', NOW - 2592000000 - 1, false), NOW, BOARD)).toBe(true)
  expect(isExpiredRecord('mirror:synthetic-6', untagged('ended', NOW - 8 * DAY, false), NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('mirror:synthetic-6', untagged('ended', NOW - 2592000000 - 1, false), NOW, BOARD)).toBe(true)
})

test('untagged agent and mirror records skip the future-clock check while this board\'s tagged records expire', () => {
  for (const key of ['agent:synthetic-future', 'mirror:synthetic-future']) {
    expect(isExpiredRecord(key, untagged('ended', NOW + DAY + 1, false), NOW, BOARD)).toBe(false)
    expect(isExpiredRecord(key, record('ended', NOW + DAY + 1, false), NOW, BOARD)).toBe(true)
    for (const age of [30 * DAY, 30 * DAY + 1]) {
      expect(isExpiredRecord(key, untagged('ended', NOW - age, false), NOW, BOARD)).toBe(age > 30 * DAY)
    }
  }
})

test("the store's cap takes only ended records that carry this board's tag", () => {
  const records = [
    { key: 'agent:0a0a0a01', value: padded('ended', NOW - 9 * DAY, false) },
    { key: 'agent:0a0a0a02', value: { ...padded('ended', NOW - 9 * DAY, false), board: OTHER } },
    { key: 'agent:0a0a0a03', value: { ...padded('ended', NOW - 9 * DAY, false), board: undefined } },
  ]
  expect(overCapKeys(records, () => false, 5000000, BOARD)).toEqual(['agent:0a0a0a01'])
})

test('a record dated more than a day ahead counts as expired, and one exactly a day ahead is kept', () => {
  expect(isExpiredRecord('agent:0a1b2c3d', record('working', NOW + DAY, true), NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('agent:0a1b2c3d', record('working', NOW + DAY + 1, true), NOW, BOARD)).toBe(true)
  expect(isExpiredRecord('mirror:synthetic-7', record('working', NOW + DAY + 1, true), NOW, BOARD)).toBe(true)
  expect(isExpiredRecord('hinted:synthetic', NOW + DAY, NOW, BOARD)).toBe(false)
  expect(isExpiredRecord('hinted:synthetic', NOW + DAY + 1, NOW, BOARD)).toBe(true)
  expect(isExpiredRecord('pendingInboxQuestion:synthetic', { at: NOW + DAY + 1 }, NOW, BOARD)).toBe(true)
})

test('a record read again is the same write only while its time is the one the prune chose it by', () => {
  const chosen = record('ended', NOW - 4 * DAY, false)
  expect(isSameWrite('agent:0a1b2c3d', chosen, { ...chosen })).toBe(true)
  expect(isSameWrite('agent:0a1b2c3d', chosen, { ...chosen, updated: NOW })).toBe(false)
  expect(isSameWrite('agent:0a1b2c3d', chosen, undefined)).toBe(false)
  expect(isSameWrite('hinted:synthetic', NOW - 31 * DAY, NOW - 31 * DAY)).toBe(true)
  expect(isSameWrite('hinted:synthetic', NOW - 31 * DAY, NOW)).toBe(false)
  // A record with no time of its own is compared whole.
  expect(isSameWrite('mirror:synthetic-8', 'not a mirror', 'not a mirror')).toBe(true)
  expect(isSameWrite('mirror:synthetic-8', 'not a mirror', 'another value')).toBe(false)
})

test("an agent record's prompt receipts and confirmed completions, and a mirror's confirmed completions and unwritable journal lines, go with it", () => {
  const keys = [
    'agent:0a1b2c3d',
    'agent:0a1b2c3d9',
    'agentPrompt:0a1b2c3d:12:1792216380000',
    'agentPrompt:0a1b2c3d9:12:1792216380000',
    `${completionPrefix('agent:0a1b2c3d')}${'a'.repeat(64)}:1792216380000`,
    `${completionPrefix('mirror:0a1b2c3d')}${'b'.repeat(64)}:1792216380000`,
    'mirror:9f8e7d6c-0000-4000-8000-000000000001',
    `${completionPrefix('mirror:9f8e7d6c-0000-4000-8000-000000000001')}${'c'.repeat(64)}:1792216380000`,
    'pendingJournalBad:9f8e7d6c-0000-4000-8000-000000000001',
    'pendingJournalBad:9f8e7d6c-0000-4000-8000-0000000000019',
    'pendingJournal:9f8e7d6c-0000-4000-8000-000000000001',
    'told',
  ]
  expect(companionKeys('agent:0a1b2c3d', keys)).toEqual([keys[2], keys[4]])
  expect(companionKeys('mirror:9f8e7d6c-0000-4000-8000-000000000001', keys)).toEqual([keys[7], keys[8]])
  expect(companionKeys('hinted:0a1b2c3d', keys)).toEqual([])
})

test('an inbox file set aside is kept a week from when that was recorded, never from its own date, and a name with no time recorded is named for the sweep to record', () => {
  const file = (name: string, age: number) => ({ name, kind: 'file', size: 10, mtimeMs: NOW - age })
  const inbox = [file('codex-turn-1-1.json.failed', 2592000000), file('codex-turn-1-2.json.failed.1', 2592000000), file('codex-turn-1-3.json', 2592000000)]
  // Older than a week by its own date, first seen now: not swept, and named.
  expect(staleFailedInbox(inbox, NOW, {})).toEqual([])
  expect(unseenFailedInbox(inbox, {})).toEqual(['codex-turn-1-1.json.failed', 'codex-turn-1-2.json.failed.1'])
  const recorded = { 'codex-turn-1-1.json.failed': NOW - 604800000, 'codex-turn-1-2.json.failed.1': NOW - 604800000 - 1 }
  expect(staleFailedInbox(inbox, NOW, recorded)).toEqual(['codex-turn-1-2.json.failed.1'])
  expect(unseenFailedInbox(inbox, recorded)).toEqual([])
})

test('a reporter temporary copy in the inbox goes once it is over a day old, and no turn, receipt, taken or set-aside file ever does', () => {
  const file = (name: string, age: number) => ({ name, kind: 'file', size: 10, mtimeMs: NOW - age })
  const inbox = [
    // The names the reporters give a copy they are still writing: `<turn name>.tmp`, and the
    // same with `.json` before it.
    file('codex-turn-1-1.tmp', DAY + 1),
    file('codex-turn-1-2.json.tmp', 259200000),
    file('codex-turn-1-3.tmp', DAY),
    file('codex-turn-1-4.json.tmp', DAY - 1),
    file('codex-turn-1-5.tmp', 0),
    // Never these, however old.
    file('codex-turn-1-6.json', 2592000000),
    file('codex-prompt-1-7.receipt', 2592000000),
    file('codex-turn-1-8.json.taking', 2592000000),
    file('codex-turn-1-9.json.failed', 2592000000),
    file('codex-turn-1-10.json.failed.1', 2592000000),
    file('dropped.log', 2592000000),
    { name: 'codex-turn-1-11.tmp', kind: 'dir', size: 0, mtimeMs: NOW - 2592000000 },
  ]
  expect(staleInboxTemps(inbox, NOW)).toEqual(['codex-turn-1-1.tmp', 'codex-turn-1-2.json.tmp'])
})

test('the saved-records warning says that only records of sessions whose block has left the board are cleared, in every language', () => {
  const warn = (lang: 'en' | 'zh-TW' | 'zh-CN'): string => sizeWarnings({ progress: 0, store: 1.3 * 1024 * 1024 }, STRINGS[lang])[0] ?? ''
  expect(warn('en')).toContain('only records of sessions whose block has left the board are cleared')
  expect(warn('en')).not.toContain('old records are being cleared')
  expect(warn('zh-TW')).toContain('只有區塊已離開看板的 session 紀錄會被清掉')
  expect(warn('zh-CN')).toContain('只有区块已离开看板的 session 记录会被清掉')
})


test('an ended agent record of another board is kept at 29 days and expires only past 30 days', () => {
  for (const age of [29 * DAY, 30 * DAY, 30 * DAY + 1]) {
    expect(isExpiredRecord('agent:synthetic-other', { ...record('ended', NOW - age, false), board: OTHER }, NOW, BOARD)).toBe(age > 30 * DAY)
  }
  expect(isExpiredRecord('agent:synthetic-own', record('ended', NOW - 3 * DAY - 1, false), NOW, BOARD)).toBe(true)
})

test('a mirror of another board with no open steps is kept at 29 days and expires only past 30 days', () => {
  for (const age of [29 * DAY, 30 * DAY, 30 * DAY + 1]) {
    expect(isExpiredRecord('mirror:synthetic-other', { ...record('ended', NOW - age, false), board: OTHER }, NOW, BOARD)).toBe(age > 30 * DAY)
  }
})

test('a record of another board more than a day ahead is kept for that board to age', () => {
  for (const key of ['agent:synthetic-other', 'mirror:synthetic-other']) {
    expect(isExpiredRecord(key, { ...record('ended', NOW + DAY + 1, false), board: OTHER }, NOW, BOARD)).toBe(false)
  }
})

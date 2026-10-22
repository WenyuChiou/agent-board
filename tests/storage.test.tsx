import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ProgressMirror } from '../types'
import { emptyMirror } from '../hooks/mirror'
import { TOLD_MAX } from '../hooks/remind'
import { isPrunableKey, RETENTION } from '../hooks/retention'
import { EN } from '../hooks/strings-en'
import { engineBeneath, FILE, INBOX, PANE, PROPS } from './fixtures/pane-world'
import type { World } from './fixtures/pane-world'
import { bigWorld, BIG_AT } from './fixtures/big-board'

// The store and files a session start leaves, on today's synthetic board and on one four times its
// size (#373). Every record, file and name here is made up.
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const STORE_DIR = '/home/me/.claude/plugins/store'
const CONNECT_RECORD = '/home/me/.agent-board/legacy-connect.json'
const JOURNAL = '/home/me/.claude/progress-journal-2026-10.md'

const record = (id: string, state: ProgressMirror['state'], updated: number, isOpen: boolean): ProgressMirror => ({
  ...emptyMirror(id, 'synthetic-project', updated, '/work/synthetic', 'codex'),
  state,
  updated,
  tasks: [
    { id: '1', subject: 'Synthetic done step', status: 'completed', activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] },
    ...(isOpen ? [{ id: '2', subject: 'Synthetic open step', status: 'pending' as const, activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] }] : []),
  ],
})

// Today's board with every record that grows with use copied `k` times, its done marks in the one
// value this release keeps them in, and no step left to start or stop.
const scaled = (k: number): World => {
  const world = { ...bigWorld(), isArchiveClockOnly: true }
  const store = world.store as Record<string, unknown>
  const seen: Record<string, number> = {}
  for (const [key, value] of Object.entries({ ...store })) {
    if (key.startsWith('done:') && typeof value === 'number') {
      for (let copy = 0; copy < k; copy++) seen[copy === 0 ? key : `${key} ${copy}`] = value
      delete store[key]
      continue
    }
    if (!/^(agent|mirror|hinted|agentPrompt):/.test(key)) continue
    for (let copy = 1; copy < k; copy++) store[`${key}-c${copy}`] = value
  }
  store.doneSeen = seen
  return world
}

const startReads = async ($: Engine, on: On, k: number): Promise<{ total: number; pruned: number; keys: number }> => {
  const world = scaled(k)
  const reads: string[] = []
  world.storeReads = reads
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project-3', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  return {
    total: reads.length,
    pruned: reads.filter(key => isPrunableKey(key) || key === 'pruneAfter').length,
    keys: Object.keys(world.store ?? {}).length,
  }
}

const counts = new Map<number, { total: number; pruned: number; keys: number }>()

for (const k of [1, 4]) {
  test(`a session start on ${k}x today's synthetic store reads at most 25 values to prune it`, { timeoutMs: 300000 }, async ($, on) => {
    const seen = await startReads($, on, k)
    counts.set(k, seen)
    expect(seen.pruned).toBeLessThanOrEqual(25)
    expect(seen.pruned).toBeGreaterThanOrEqual(RETENTION.pruneReads)
  })
}

test("a session start reads as many store values at 4x today's synthetic store as at 1x", () => {
  const one = counts.get(1)
  const four = counts.get(4)
  expect(one).toBeDefined()
  expect(four).toBeDefined()
  // The bigger store really is bigger, and the start does not read more of it.
  expect(four?.keys ?? 0).toBeGreaterThan(3 * (one?.keys ?? 0))
  expect(four?.total).toBe(one?.total)
})

test('after a walk over the store, ended and stale records are gone and every open record and question stays', { timeoutMs: 300000 }, async ($, on) => {
  const world = { ...bigWorld(), isArchiveClockOnly: true }
  const store = world.store as Record<string, unknown>
  const at = BIG_AT
  store['agent:0e0e0e01'] = record('0e0e0e01', 'ended', at - 3 * DAY - HOUR, true)
  store['agent:0e0e0e02'] = record('0e0e0e02', 'ended', at - 3 * DAY + HOUR, true)
  store['agent:0e0e0e03'] = record('0e0e0e03', 'waiting', at - 29 * DAY, true)
  store['mirror:synthetic-open-29d'] = record('synthetic-open-29d', 'ended', at - 29 * DAY, true)
  store['mirror:synthetic-ended-8d'] = record('synthetic-ended-8d', 'ended', at - 8 * DAY, false)
  store['hinted:synthetic-old'] = at - 31 * DAY
  store['pendingInboxQuestion:synthetic-old'] = { at: at - 4 * DAY }
  world.files.set(CONNECT_RECORD, JSON.stringify({ version: 1 }))
  // Records of blocks still on the board, past their age: kept while the block is there.
  const source = world.files.get(FILE) ?? ''
  const codex = /<!-- auto session=([0-9a-f]{8}) agent=codex state=waiting /.exec(source)?.[1] ?? ''
  const claude = /<!-- auto session=[0-9a-f]{8} agent=claude state=waiting updated=\S+ resume=(\S+) /.exec(source)?.[1] ?? ''
  expect([codex, claude].every(one => one !== '')).toBe(true)
  store[`agent:${codex}`] = record(codex, 'ended', at - 4 * DAY, true)
  store[`mirror:${claude}`] = record(claude, 'ended', at - 8 * DAY, false)
  const asked = (world.files.get(FILE) ?? '').split('\n').filter(line => line.startsWith('- [?] '))
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project-3', surface: 'desktop', isInteractive: true })
  // A start walks one stretch of the store; each hourly sweep walks ten more, so two hours cover it.
  await clock.advance(2 * HOUR)

  expect(store['agent:0e0e0e01']).toBeUndefined()
  expect(store['agent:0e0e0e02']).toBeDefined()
  expect(store['agent:0e0e0e03']).toBeDefined()
  expect(store['mirror:synthetic-open-29d']).toBeDefined()
  expect(store['mirror:synthetic-ended-8d']).toBeUndefined()
  expect(store['hinted:synthetic-old']).toBeUndefined()
  expect(store['pendingInboxQuestion:synthetic-old']).toBeUndefined()
  expect(store[`agent:${codex}`]).toBeDefined()
  expect(store[`mirror:${claude}`]).toBeDefined()
  // The board's own records of today are all kept.
  expect(Object.keys(store).filter(key => key.startsWith('agent:')).length).toBe(194 + 3)
  expect(Object.keys(store).filter(key => key.startsWith('mirror:')).length).toBeGreaterThanOrEqual(69 + 2)
  // The 3,400 reminders told come down to the newest 500 at the first new reminder.
  expect(Object.keys(store.told as Record<string, number>).length).toBeLessThanOrEqual(TOLD_MAX)
  // The copies of other agents' files go once the connect worker keeps its own record.
  expect(Object.keys(store).filter(key => key.startsWith('generated:'))).toEqual([])
  // Every step that waits on the person is still in progress.md, word for word.
  const now = (world.files.get(FILE) ?? '').split('\n').filter(line => line.startsWith('- [?] '))
  expect(asked.length).toBeGreaterThan(0)
  for (const line of asked) expect(now).toContain(line)
})

test("copies of other agents' files stay in the store until the connect worker keeps its own record", async ($, on) => {
  const world: World = { files: new Map([[FILE, '## synthetic-project\n### Synthetic task\n- [ ] Synthetic step\n']]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true, 'generated:/home/me/.synthetic-agent/board.md': 'synthetic copy' } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(world.store?.['generated:/home/me/.synthetic-agent/board.md']).toBe('synthetic copy')
})

test("a session start sweeps this plugin's store copies cut off over a day ago and inbox files given up on over a week ago, in one removal", async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00.000Z')
  const store = `${STORE_DIR}/agent-board_agent-board-0a1b2c3d4e5f.json`
  const files: Array<[string, string, number]> = [
    [store, '{}', at],
    [`${store}.tmp.20fb583a`, '{}', at - DAY - HOUR],
    [`${store}.tmp.3b28eca4`, '{}', at - HOUR],
    [`${STORE_DIR}/another-plugin_x-0a1b2c3d4e5f.json.tmp.20fb583a`, '{}', at - 9 * DAY],
    [`${INBOX}/codex-turn-1-1.json.failed`, '{}', at - 8 * DAY],
    [`${INBOX}/codex-turn-1-2.json.failed.1`, '{}', at - 7 * DAY - HOUR],
    [`${INBOX}/codex-turn-1-3.json.failed`, '{}', at - 6 * DAY],
  ]
  const world: World = {
    files: new Map([[FILE, '## synthetic-project\n### Synthetic task\n- [ ] Synthetic step\n'], ...files.map(([path, text]): [string, string] => [path, text])]),
    mtimes: Object.fromEntries(files.map(([path, , mtime]) => [path, mtime])),
    mtime: 1,
    hasTasks: true,
    store: { inboxDone: {}, autoConnectOff: true },
    ran: [],
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  const swept = [`${store}.tmp.20fb583a`, `${INBOX}/codex-turn-1-1.json.failed`, `${INBOX}/codex-turn-1-2.json.failed.1`]
  for (const path of swept) expect(world.files.has(path)).toBe(false)
  for (const path of [store, `${store}.tmp.3b28eca4`, `${STORE_DIR}/another-plugin_x-0a1b2c3d4e5f.json.tmp.20fb583a`, `${INBOX}/codex-turn-1-3.json.failed`]) expect(world.files.has(path)).toBe(true)
  const removals = (world.ran ?? []).filter(argv => argv[0] === 'rm')
  expect(removals).toHaveLength(1)
  expect(removals[0]?.slice(2).sort()).toEqual([...swept].sort())
})

test('done marks an earlier release kept one key each are moved into one value, and their keys removed', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00.000Z')
  const world: World = {
    files: new Map([[FILE, '## synthetic-project\n### Synthetic finished\n- [x] Synthetic step\n\n### Synthetic long ago\n- [x] Synthetic step\n']]),
    mtime: 1,
    hasTasks: true,
    store: { inboxDone: {}, autoConnectOff: true, 'done:synthetic-project::Synthetic finished': at - HOUR, 'done:synthetic-project::Synthetic long ago': at - 31 * DAY },
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(Object.keys(world.store ?? {}).filter(key => key.startsWith('done:'))).toEqual([])
  // Past 30 days a mark goes, as the keys did; that task is then seen done afresh.
  expect(world.store?.doneSeen).toEqual({ 'done:synthetic-project::Synthetic finished': at - HOUR, 'done:synthetic-project::Synthetic long ago': at })
})

test('a time kept for a hand-kept task no longer done is let go, so a later task of that name waits its own day', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00.000Z')
  // A time from a task archived two days ago, come back from another session's save.
  const world: World = {
    files: new Map([[FILE, '## synthetic-project\n### Synthetic weekly review\n- [ ] Synthetic step\n']]),
    mtime: 1,
    hasTasks: true,
    store: { inboxDone: {}, autoConnectOff: true, doneSeen: { 'done:synthetic-project::Synthetic weekly review': at - 2 * DAY } },
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(world.store?.doneSeen).toEqual({})
  // Ticked now, it is seen done now, and stays on the board for its day.
  world.files.set(FILE, '## synthetic-project\n### Synthetic weekly review\n- [x] Synthetic step\n')
  world.mtime += 1
  await clock.advance(3000)
  expect((world.store?.doneSeen as Record<string, number>)['done:synthetic-project::Synthetic weekly review']).toBeGreaterThanOrEqual(at)
  expect(world.files.get(FILE)).toContain('### Synthetic weekly review')
})

test('an inbox file set aside today is kept a week, even when the file itself is older', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00.000Z')
  const name = 'codex-turn-1792216380-10.json'
  const world: World = {
    files: new Map([[FILE, '# Progress\n'], [`${INBOX}/${name}`, '{synthetic broken input']]),
    mtimes: { [`${INBOX}/${name}`]: at - 8 * DAY },
    mtime: 1,
    hasTasks: true,
    // Every timer but the hourly one fires every two hours, so hours go by quickly.
    isArchiveClockOnly: true,
    store: { inboxDone: {}, autoConnectOff: true },
    ran: [],
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(2 * HOUR)
  expect(world.files.get(`${INBOX}/${name}.failed`)).toBe('{synthetic broken input')
  expect((world.store?.inboxSetAside as Record<string, number>)[`${name}.failed`]).toBeGreaterThanOrEqual(at)
  // The hourly sweep finds it eight days old by its own time, and keeps it.
  await clock.advance(HOUR)
  expect(world.files.get(`${INBOX}/${name}.failed`)).toBe('{synthetic broken input')
})

test("a month's journal goes on in a second part once the first holds 1 MB, and the first is left as it was", async ($, on) => {
  const full = `# synthetic journal\n${'x'.repeat(RETENTION.monthPartBytes)}\n`
  const world: World = { files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n'], [JOURNAL, full]]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  await ui.press({ key: 'demo-1::Demo task::0::done' })
  expect(world.files.get(JOURNAL)).toBe(full)
  expect(world.files.get(JOURNAL.replace('.md', '-2.md'))).toContain(' · Demo step\n')
  await ui.unmount()
})

test('the board says when progress.md and the saved records pass their size limits, and keeps every task', async ($, on) => {
  const source = `## synthetic-project\n### Synthetic task\n> Context: ${'synthetic '.repeat(60_000)}\n- [?] Synthetic step — Publish the synthetic page, OK?\n`
  const store = `${STORE_DIR}/agent-board_agent-board-0a1b2c3d4e5f.json`
  const world: World = { files: new Map([[FILE, source], [store, 'x'.repeat(1_300_000)]]), mtime: 1, hasTasks: true, store: { lang: 'en', inboxDone: {}, autoConnectOff: true, opened: ['others'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/other-project', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const warning = [EN.progressLarge(Math.round(source.length / 1024), 512), EN.storeLarge('1.2', '1.5')].join(' · ')
  expect(await ui.find({ type: 'Text', text: warning })).toBeDefined()
  // Over the limit, nothing is removed: the question and its task are still there, word for word.
  expect(world.files.get(FILE)).toBe(source)
  await ui.unmount()
})

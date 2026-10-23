import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ProgressMirror } from '../types'
import { completionPrefix, emptyMirror } from '../hooks/mirror'
import { boardTag, inboxDropped, isPrunableKey } from '../hooks/retention'
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
  // The tag of the board these tests run on, as the pane writes it into every record it saves.
  board: boardTag(FILE),
  tasks: [
    { id: '1', subject: 'Synthetic done step', status: 'completed', activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] },
    ...(isOpen ? [{ id: '2', subject: 'Synthetic open step', status: 'pending' as const, activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] }] : []),
  ],
})

// Grow the board, inbox and records together, with done marks in the one value this release keeps.
const scaled = (k: number): World => {
  const world = { ...bigWorld(), isArchiveClockOnly: true }
  world.files.set(FILE, (world.files.get(FILE) ?? '').repeat(k))
  for (const [path, text] of [...world.files]) {
    if (!path.startsWith(`${INBOX}/`)) continue
    for (let copy = 1; copy < k; copy++) world.files.set(path.replace('.json', `-c${copy}.json`), text)
  }
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

type StartReads = { total: number; pruned: number; keys: number; boardBytes: number; inboxFiles: number; inboxBytes: number; fileReads: number; boardReads: number; inboxReads: number }

const startReads = async ($: Engine, on: On, k: number): Promise<StartReads> => {
  const world = scaled(k)
  const reads: string[] = []
  world.storeReads = reads
  world.reads = []
  const boardBytes = (world.files.get(FILE) ?? '').length
  const inbox = [...world.files].filter(([path]) => path.startsWith(`${INBOX}/`))
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/project-3', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  return {
    total: reads.length,
    pruned: reads.filter(key => isPrunableKey(key) || key === 'pruneAfter').length,
    keys: Object.keys(world.store ?? {}).length,
    boardBytes,
    inboxFiles: inbox.length,
    inboxBytes: inbox.reduce((sum, [, text]) => sum + text.length, 0),
    fileReads: world.reads.length,
    boardReads: world.reads.filter(path => path === FILE).length,
    inboxReads: world.reads.filter(path => path.startsWith(`${INBOX}/`)).length,
  }
}

const counts = new Map<number, StartReads>()

for (const k of [1, 4]) {
  test(`a session start on ${k}x the board, inbox and store bounds its reads`, { timeoutMs: 300000 }, async ($, on) => {
    const seen = await startReads($, on, k)
    counts.set(k, seen)
    expect(seen.pruned).toBeLessThanOrEqual(25)
    expect(seen.pruned).toBeGreaterThanOrEqual(20)
    // 736 is the 1x inbox; 10 bounds the start's board polls, and 800 leaves 64 reads for the board and other files.
    expect(seen.fileReads).toBeLessThanOrEqual(800)
    expect(seen.boardReads).toBeLessThanOrEqual(10)
    expect(seen.inboxReads).toBeLessThanOrEqual(736)
  })
}

test('four times the board, inbox and store keeps session start store reads fixed', () => {
  const one = counts.get(1)
  const four = counts.get(4)
  expect(one).toBeDefined()
  expect(four).toBeDefined()
  // The bigger store really is bigger, and the start does not read more of it.
  expect(four?.keys ?? 0).toBeGreaterThan(3 * (one?.keys ?? 0))
  expect(four?.boardBytes).toBe(4 * (one?.boardBytes ?? 0))
  expect(four?.inboxFiles).toBe(4 * (one?.inboxFiles ?? 0))
  expect(four?.inboxBytes).toBe(4 * (one?.inboxBytes ?? 0))
  expect(four?.total).toBe(one?.total)
  expect(four?.boardReads ?? Infinity).toBeLessThanOrEqual(one?.boardReads ?? 0)
  expect(four?.inboxReads ?? Infinity).toBeLessThanOrEqual(one?.inboxReads ?? 0)
})

test('after a walk over the store, ended and stale records are gone and every open record and question stays', { timeoutMs: 300000 }, async ($, on) => {
  const world = { ...bigWorld(), isArchiveClockOnly: true }
  const store = world.store as Record<string, unknown>
  const at = BIG_AT
  store['agent:0e0e0e01'] = record('0e0e0e01', 'ended', at - 259200000 - HOUR, true)
  store['agent:ffffffff'] = record('ffffffff', 'ended', at - 259200000 + HOUR, true)
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
  expect(store['agent:ffffffff']).toBeDefined()
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
  expect(Object.keys(store.told as Record<string, number>).length).toBeLessThanOrEqual(500)
  // The copies of other agents' files go once the connect worker keeps its own record.
  expect(Object.keys(store).filter(key => key.startsWith('generated:'))).toEqual([])
  // Every step that waits on the person is still in progress.md, word for word.
  const now = (world.files.get(FILE) ?? '').split('\n').filter(line => line.startsWith('- [?] '))
  expect(asked.length).toBeGreaterThan(0)
  for (const line of asked) expect(now).toContain(line)
})

// An agent that ended 4 days ago, a day past the 3 an ended agent's record is kept. No block on any
// board below is its own, so only the state of the board decides whether the record goes.
const OLD_AGENT = 'agent:0e0e0e01'
const BOARD = '## synthetic-project\n### Synthetic task\n- [ ] Synthetic step\n'
const FULL_BOARD = `${BOARD}## synthetic-agents\n<!-- auto session=0e0e0e01 agent=codex state=ended updated=2026-10-12T11:00:00Z -->\n### Synthetic agent work\n- [?] Synthetic question — Publish the synthetic page, OK?\n<!-- /auto session=0e0e0e01 -->\n`

const oldAgentWorld = (board: string | undefined): World => ({
  files: new Map(board === undefined ? [] : [[FILE, board]]),
  mtime: 1,
  hasTasks: true,
  store: { inboxDone: {}, autoConnectOff: true, [OLD_AGENT]: record('0e0e0e01', 'ended', Date.parse('2026-10-16T12:00:00.000Z') - 4 * DAY, true) },
})

const startOn = async ($: Engine, on: On, world: World): Promise<void> => {
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
}

test('an ended agent record whose block is not on a whole, settled board is pruned at a session start', async ($, on) => {
  const world = oldAgentWorld(BOARD)
  await startOn($, on, world)
  expect(world.store?.[OLD_AGENT]).toBeUndefined()
})

test('an ended agent record is kept while progress.md is missing', async ($, on) => {
  const world = oldAgentWorld(undefined)
  await startOn($, on, world)
  expect(world.store?.[OLD_AGENT]).toBeDefined()
})

test('an ended agent record is kept while progress.md is empty', async ($, on) => {
  const world = oldAgentWorld('')
  await startOn($, on, world)
  expect(world.store?.[OLD_AGENT]).toBeDefined()
})

test('an ended agent record is kept while progress.md is cut off inside a marker', async ($, on) => {
  const world = oldAgentWorld(`${BOARD}<!-- auto session=0e0e0e01 agent=codex state=wor`)
  await startOn($, on, world)
  expect(world.store?.[OLD_AGENT]).toBeDefined()
})

// A writer that has not finished looks like a whole board with fewer blocks. Its block lies past the
// cut, which is not inside a marker, and the file is whole again before the prune deletes.
test('an ended agent record is kept when progress.md was read half written and the write finished before the delete', async ($, on) => {
  const world = oldAgentWorld(BOARD)
  world.beforeStoreGet = key => {
    if (key !== OLD_AGENT) return
    world.beforeStoreGet = undefined
    world.files.set(FILE, FULL_BOARD)
    world.mtime += 1
  }
  await startOn($, on, world)
  expect(world.store?.[OLD_AGENT]).toBeDefined()
})

for (const [change, write] of [
  ['time', (world: World) => { world.mtime += 1 }],
  ['size', (world: World) => { world.files.set(FILE, `${BOARD}- [ ] Synthetic added step\n`) }],
] as const) {
  test(`an ended agent record is kept when progress.md changes its ${change} between the read and the delete`, async ($, on) => {
    const world = oldAgentWorld(BOARD)
    world.beforeStoreGet = key => {
      if (key !== OLD_AGENT) return
      world.beforeStoreGet = undefined
      write(world)
    }
    await startOn($, on, world)
    expect(world.store?.[OLD_AGENT]).toBeDefined()
  })
}

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
    [`${INBOX}/codex-turn-1-2.json.failed.1`, '{}', at - 604800000 - HOUR],
    [`${INBOX}/codex-turn-1-3.json.failed`, '{}', at - 6 * DAY],
  ]
  const world: World = {
    files: new Map([[FILE, '## synthetic-project\n### Synthetic task\n- [ ] Synthetic step\n'], ...files.map(([path, text]): [string, string] => [path, text])]),
    mtimes: Object.fromEntries(files.map(([path, , mtime]) => [path, mtime])),
    mtime: 1,
    hasTasks: true,
    // The time each was set aside, which a file's own date does not stand in for.
    store: { inboxDone: {}, autoConnectOff: true, inboxSetAside: { 'codex-turn-1-1.json.failed': at - 8 * DAY, 'codex-turn-1-2.json.failed.1': at - 604800000 - HOUR, 'codex-turn-1-3.json.failed': at - 6 * DAY } },
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

test('a session start removes the temporary copies reporters left in the inbox over a day ago, keeps a fresh one, and counts none as a lost turn', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00.000Z')
  const files: Array<[string, string, number]> = [
    [`${INBOX}/codex-turn-1-1.tmp`, '{', at - 259200000],
    [`${INBOX}/codex-turn-1-2.json.tmp`, '{', at - DAY - HOUR],
    [`${INBOX}/codex-turn-1-3.tmp`, '{', at - HOUR],
    [`${INBOX}/codex-turn-1-4.json.tmp`, '{', at - DAY + HOUR],
    // Whatever their age, these are not a reporter's temporary copy.
    [`${INBOX}/codex-turn-1-5.json`, '{}', at - 9 * DAY],
    [`${INBOX}/codex-prompt-1-6.receipt`, '{}', at - 9 * DAY],
    [`${INBOX}/codex-turn-1-7.json.taking`, '{}', at - 9 * DAY],
    [`${INBOX}/codex-turn-1-8.json.failed`, '{}', at - 9 * DAY],
  ]
  const world: World = {
    files: new Map([[FILE, '## synthetic-project\n### Synthetic task\n- [ ] Synthetic step\n'], ...files.map(([path, text]): [string, string] => [path, text])]),
    mtimes: Object.fromEntries(files.map(([path, , mtime]) => [path, mtime])),
    mtime: 1,
    hasTasks: true,
    store: { inboxDone: {}, autoConnectOff: true, inboxSetAside: { 'codex-turn-1-8.json.failed': at - HOUR } },
    ran: [],
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  const swept = [`${INBOX}/codex-turn-1-1.tmp`, `${INBOX}/codex-turn-1-2.json.tmp`]
  for (const path of swept) expect(world.files.has(path)).toBe(false)
  for (const [path] of files.filter(([path]) => !swept.includes(path))) expect(world.files.has(path)).toBe(true)
  // Both go in the one removal the sweep makes, with no turn counted as cleared: a partial write is not a turn the person lost.
  const removals = (world.ran ?? []).filter(argv => argv[0] === 'rm')
  expect(removals).toHaveLength(1)
  expect(removals[0]?.slice(2).sort()).toEqual([...swept].sort())
  expect(world.store?.prunedCounts).toBeUndefined()
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

test('a time kept for a hand-kept task past a cut-off marker is kept, since a board read cut short says nothing about it', async ($, on) => {
  const at = Date.parse('2026-10-16T12:00:00.000Z')
  const early = 'done:synthetic-project::Synthetic finished early'
  const past = 'done:synthetic-project::Synthetic finished past the cut'
  const world: World = {
    files: new Map([[FILE, '## synthetic-project\n### Synthetic finished early\n- [x] Synthetic step\n<!-- auto session=0e0e0e01 agent=codex state=wor']]),
    mtime: 1,
    hasTasks: true,
    store: { inboxDone: {}, autoConnectOff: true, doneSeen: { [early]: at - HOUR, [past]: at - HOUR } },
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(world.store?.doneSeen).toEqual({ [early]: at - HOUR, [past]: at - HOUR })
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

for (const bytes of [1048575, 1048576]) {
  test(`a journal of ${bytes} bytes ${bytes === 1048575 ? 'stays in part 1' : 'rotates to part 2'}`, async ($, on) => {
    // Rotation starts at the limit, before the new journal line is appended.
    const full = 'x'.repeat(bytes)
    const world: World = { files: new Map([[FILE, '## demo-1\n### Demo task\n- [?] Demo step\n'], [JOURNAL, full]]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true } }
    engineBeneath(on, world)
    await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    await ui.press({ key: 'demo-1::Demo task::0::done' })
    if (bytes === 1048576) {
      expect(world.files.get(JOURNAL)).toBe(full)
      expect(world.files.get(JOURNAL.replace('.md', '-2.md'))).toContain(' · Demo step\n')
    } else {
      expect(world.files.get(JOURNAL)).toContain(full)
      expect(world.files.get(JOURNAL)).toContain(' · Demo step\n')
      expect(world.files.has(JOURNAL.replace('.md', '-2.md'))).toBe(false)
    }
    await ui.unmount()
  })
}

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

// What the inbox writers add to dropped.log when they remove a turn file unread (#373).
test('the count of turns the inbox writers dropped sums the lines from a time on and skips lines that do not read', () => {
  const log = [
    '2026-10-20T10:00:00Z 4 age',
    '2026-10-21T10:00:00Z 3 cap',
    '2026-10-22T04:15:00Z 1 cap',
    'a line nobody wrote',
    '2026-10-22T05:00:00Z -2 cap',
    '2026-10-22T05:00:00Z 5 unknown',
    '2026-10-22T05:00:00 6 cap',
    '2026-13-40T10:00:00Z 9 cap',
    '2026-10-22T06:00:00Z 2 age\r',
    '',
  ].join('\n')
  expect(inboxDropped(log, Date.parse('2026-10-21T00:00:00Z'))).toEqual({ age: 2, cap: 4 })
  expect(inboxDropped(log, 0)).toEqual({ age: 6, cap: 4 })
  // A line stamped at the asked time counts; the one before it does not.
  expect(inboxDropped(log, Date.parse('2026-10-22T04:15:00Z'))).toEqual({ age: 2, cap: 1 })
  expect(inboxDropped(log, Date.parse('2026-10-22T04:15:01Z'))).toEqual({ age: 2, cap: 0 })
  expect(inboxDropped('', 0)).toEqual({ age: 0, cap: 0 })
})

// The hard cap on the store and the line saying what was cleared (#373). The store file here is a
// made-up one of the size a test asks for; each record carries 10,000 bytes of padding, which makes
// it about 10.5 KB in the store, so the cap has to take a known number of them.
const STORE_FILE = `${STORE_DIR}/agent-board_agent-board-0a1b2c3d4e5f.json`
const CAP_BOARD = [
  '## synthetic-project',
  '### Synthetic task',
  '- [ ] Synthetic step',
  '## synthetic-agents',
  '<!-- auto session=0b0b0b01 agent=codex state=ended updated=2026-10-16T09:00:00.000Z -->',
  '### Synthetic codex work',
  '- [x] Synthetic step',
  '<!-- /auto session=0b0b0b01 -->',
  '<!-- auto session=0c0c0c01 agent=claude state=working updated=2026-10-16T11:00:00.000Z -->',
  '### Synthetic claude work',
  '- [ ] Synthetic open step',
  '<!-- /auto session=0c0c0c01 -->',
  '',
].join('\n')
const AT = Date.parse('2026-10-16T12:00:00.000Z')
const padded = (id: string, state: ProgressMirror['state'], updated: number, isOpen: boolean): ProgressMirror & { pad: string } => ({ ...record(id, state, updated, isOpen), pad: 'x'.repeat(10_000) })
const PRUNED_LINE = 'Cleared 2 old agent records and 1 old session task list in the last 7 days'
const OPEN_MIRROR = 'mirror:0c0c0c01-0000-4000-8000-000000000001'
const OLD_MIRROR = 'mirror:0d0d0d01-0000-4000-8000-000000000001'

// Records of blocks on the board, far past their age; and four ended records off the board and one
// still at work, all inside the age rules, so only the cap can take them.
const capWorld = (storeBytes: number): World => ({
  files: new Map([[FILE, CAP_BOARD], [STORE_FILE, 'x'.repeat(storeBytes)]]),
  mtime: 1,
  hasTasks: true,
  ran: [],
  store: {
    lang: 'en',
    inboxDone: {},
    autoConnectOff: true,
    opened: ['others'],
    'agent:0b0b0b01': padded('0b0b0b01', 'ended', AT - 9 * DAY, false),
    [OPEN_MIRROR]: padded('0c0c0c01', 'ended', AT - 8 * DAY, true),
    [OLD_MIRROR]: padded('0d0d0d01', 'ended', AT - 6.5 * DAY, false),
    'agent:0d0d0d02': padded('0d0d0d02', 'ended', AT - 2.8 * DAY, false),
    'agent:0d0d0d03': padded('0d0d0d03', 'ended', AT - 2.5 * DAY, false),
    'agent:0d0d0d04': padded('0d0d0d04', 'ended', AT - 1 * DAY, false),
    'agent:0d0d0d05': padded('0d0d0d05', 'working', AT - 1 * DAY, true),
  },
})

const capStart = async ($: Engine, on: On, world: World): Promise<void> => {
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/other-project', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
}

test('a store over 1572864 bytes loses its oldest ended records off the board until it is under the cap, and the pane says how many', async ($, on) => {
  const world = capWorld(1_572_864 + 26_000)
  await capStart($, on, world)
  const store = world.store ?? {}
  // Oldest first: the mirror and the two oldest agent records go, which frees more than the 26,000
  // bytes over (two of them would not); the newer ones stay.
  expect(store[OLD_MIRROR]).toBeUndefined()
  expect(store['agent:0d0d0d02']).toBeUndefined()
  expect(store['agent:0d0d0d03']).toBeUndefined()
  expect(store['agent:0d0d0d04']).toBeDefined()
  expect(store['agent:0d0d0d05']).toBeDefined()
  expect(store['agent:0b0b0b01']).toBeDefined()
  expect(store[OPEN_MIRROR]).toBeDefined()
  // The count is one small value, by kind and UTC day.
  expect(store.prunedCounts).toEqual({ '2026-10-16': { agent: 2, mirror: 1 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: PRUNED_LINE })).toBeDefined()
  await ui.unmount()
})

test('a store that stays over 1572864 bytes keeps the records of blocks on the board and the mirror with open steps of a session on the board', async ($, on) => {
  const world = capWorld(5_000_000)
  await capStart($, on, world)
  const store = world.store ?? {}
  // Everything the cap may take is gone and the store is still over, so it keeps warning.
  for (const key of [OLD_MIRROR, 'agent:0d0d0d02', 'agent:0d0d0d03', 'agent:0d0d0d04']) expect(store[key]).toBeUndefined()
  for (const key of ['agent:0b0b0b01', OPEN_MIRROR, 'agent:0d0d0d05']) expect(store[key]).toBeDefined()
  expect(store.prunedCounts).toEqual({ '2026-10-16': { agent: 3, mirror: 1 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: EN.storeLarge('4.8', '1.5') })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Cleared 3 old agent records and 1 old session task list in the last 7 days' })).toBeDefined()
  await ui.unmount()
})

test('a store under the cap loses no record to it, and the pane and progress.html say nothing about clearing', async ($, on) => {
  const world = capWorld(1_572_864 - 1)
  await capStart($, on, world)
  const store = world.store ?? {}
  for (const key of ['agent:0b0b0b01', OPEN_MIRROR, OLD_MIRROR, 'agent:0d0d0d02', 'agent:0d0d0d03', 'agent:0d0d0d04', 'agent:0d0d0d05']) expect(store[key]).toBeDefined()
  expect(store.prunedCounts).toBeUndefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /Cleared/ })).toBeUndefined()
  await ui.unmount()
  await $.command.run({ command: 'progress', args: 'open', origin: { kind: 'composer' } })
  const page = world.files.get('/home/me/.claude/progress.html') ?? ''
  expect(page).toContain('<!doctype html>')
  expect(page).not.toContain('Cleared')
})

// The cap deletes only under the guard the age rules have: progress.md must still have the time and
// size it had when the board was read, since a file half written looks like a board with fewer blocks.
test('a store over 1572864 bytes keeps every record when progress.md changes its time before the cap deletes', async ($, on) => {
  const world = capWorld(5_000_000)
  world.beforeStoreGet = key => {
    if (key !== OLD_MIRROR) return
    world.beforeStoreGet = undefined
    world.mtime += 1
  }
  await capStart($, on, world)
  const store = world.store ?? {}
  for (const key of [OLD_MIRROR, 'agent:0d0d0d02', 'agent:0d0d0d03', 'agent:0d0d0d04']) expect(store[key]).toBeDefined()
  expect(store.prunedCounts).toBeUndefined()
})

// Records the age rules remove count as well, not only the ones the cap takes.
test('a store record the age rules remove is counted too, and the pane says so', async ($, on) => {
  const world = oldAgentWorld(BOARD)
  world.store = { ...world.store, lang: 'en', opened: ['others'] }
  await startOn($, on, world)
  expect(world.store?.[OLD_AGENT]).toBeUndefined()
  expect(world.store?.prunedCounts).toEqual({ '2026-10-16': { agent: 1, mirror: 0 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: 'Cleared 1 old agent record in the last 7 days' })).toBeDefined()
  await ui.unmount()
})

// What the board cleared in the last 7 days: the store's counts for the days inside the window, and
// the turns the inbox writers dropped (their dropped.log) from the same days.
const countedWorld = (): World => {
  const world = capWorld(100_000)
  world.store = {
    ...world.store,
    prunedCounts: { '2026-10-16': { agent: 12, mirror: 0 }, '2026-10-05': { agent: 99, mirror: 99 } },
  }
  world.files.set(`${INBOX}/dropped.log`, '2026-10-15T08:00:00Z 40 age\n2026-10-16T08:00:00Z 300 cap\n2026-10-02T08:00:00Z 999 cap\n')
  return world
}
const COUNTED_LINE = 'Cleared 12 old agent records and 340 unread inbox turns in the last 7 days'

test('the pane says what was cleared in the last 7 days, with the inbox turns from the count file and without older ones', async ($, on) => {
  await capStart($, on, countedWorld())
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Text', text: COUNTED_LINE })).toBeDefined()
  await ui.unmount()
})

test('progress.html says what was cleared in the last 7 days, with the inbox turns from the count file and without older ones', async ($, on) => {
  const world = countedWorld()
  await capStart($, on, world)
  await $.command.run({ command: 'progress', args: 'open', origin: { kind: 'composer' } })
  const page = world.files.get('/home/me/.claude/progress.html') ?? ''
  expect(page).toContain(`<p role="status" class="quiet">${COUNTED_LINE}</p>`)
})

for (const [lang, line] of [
  ['zh-TW', '最近 7 天清掉了 12 筆舊的 agent 紀錄和 340 則還沒讀的收件匣回合'],
  ['zh-CN', '最近 7 天清掉了 12 条旧的 agent 记录和 340 条还没读的收件箱回合'],
] as const) {
  test(`the line saying what was cleared reads the same numbers in ${lang} as in English`, async ($, on) => {
    const world = countedWorld()
    world.store = { ...world.store, lang }
    await capStart($, on, world)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    expect(await ui.find({ type: 'Text', text: line })).toBeDefined()
    await ui.unmount()
  })
}

// A second board and releases before 0.24 share the store with this board (#373). A record carries
// the tag of the board path it was saved for; a board removes only its own, and those with no tag
// on the 30-day rule.
const OTHER_BOARD = boardTag('/home/me/other-board/progress.md')
const SECOND_MIRROR = 'mirror:0e0e0e03-0000-4000-8000-000000000001'

test('a record the board saves for another agent carries the tag of its board path', async ($, on) => {
  const world: World = {
    files: new Map([[FILE, '# Progress\n'], [`${INBOX}/codex-turn-1792216380-1.json`, JSON.stringify({ session_id: 'synthetic-tag-source', cwd: '/work/demo', prompt: 'Fix export', last_assistant_message: 'Export fixed.' })]]),
    mtime: 1,
    hasTasks: true,
    asked: [],
    store: { autoConnectOff: true, inboxDone: {} },
    reply: prompt => prompt.includes('TITLE:') ? 'TITLE: Source work\nCONTEXT: Export fixes\nDONE: Fixed issue 10\nNEXT: Finish issue 11\nASK: -' : undefined,
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/source', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  const saved = Object.entries(world.store ?? {}).filter(([key]) => key.startsWith('agent:'))
  expect(saved).toHaveLength(1)
  expect((saved[0]?.[1] as ProgressMirror).board).toBe(boardTag(FILE))
})

test('the record the board saves for a Claude session carries the tag of its board path', async ($, on) => {
  const world: World = { files: new Map(), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Finish export', description: '' })
  await clock.advance(10)
  const saved = Object.entries(world.store ?? {}).filter(([key]) => key.startsWith('mirror:'))
  expect(saved).toHaveLength(1)
  expect((saved[0]?.[1] as ProgressMirror).board).toBe(boardTag(FILE))
})

test('a board removes the ended records it saved, and leaves those another board sharing the store saved, and those with no tag until 30 days', async ($, on) => {
  const world = oldAgentWorld(BOARD)
  const store = world.store as Record<string, unknown>
  // The other board still shows these blocks; this board never did.
  store['agent:0e0e0e02'] = { ...record('0e0e0e02', 'ended', AT - 4 * DAY, true), board: OTHER_BOARD }
  store[SECOND_MIRROR] = { ...record('0e0e0e03', 'ended', AT - 9 * DAY, false), board: OTHER_BOARD }
  const { board: _board, ...older } = record('0e0e0e04', 'ended', AT - 4 * DAY, true)
  store['agent:0e0e0e04'] = older
  store['agent:0e0e0e05'] = { ...older, updated: AT - 31 * DAY }
  await startOn($, on, world)
  expect(store[OLD_AGENT]).toBeUndefined()
  expect(store['agent:0e0e0e02']).toBeDefined()
  expect(store[SECOND_MIRROR]).toBeDefined()
  expect(store['agent:0e0e0e04']).toBeDefined()
  expect(store['agent:0e0e0e05']).toBeUndefined()
})

test('a store over 1572864 bytes takes only the ended records of its own board', async ($, on) => {
  const world = capWorld(5_000_000)
  const store = world.store as Record<string, unknown>
  store['agent:0d0d0d02'] = { ...padded('0d0d0d02', 'ended', AT - 2.8 * DAY, false), board: OTHER_BOARD }
  const { board: _board, ...older } = padded('0d0d0d03', 'ended', AT - 2.5 * DAY, false)
  store['agent:0d0d0d03'] = older
  await capStart($, on, world)
  expect(store[OLD_MIRROR]).toBeUndefined()
  expect(store['agent:0d0d0d04']).toBeUndefined()
  expect(store['agent:0d0d0d02']).toBeDefined()
  expect(store['agent:0d0d0d03']).toBeDefined()
})

// A prune reads a record, and deletes it a moment later. An agent that comes back in between has
// written a newer one, which must not go with the old.
test('an ended agent record its agent writes again between the prune reading it and deleting it is kept', async ($, on) => {
  const world = oldAgentWorld(BOARD)
  let reads = 0
  world.beforeStoreGet = key => {
    if (key !== OLD_AGENT) return
    reads += 1
    // The first read chose the record; the second is the look right before the delete.
    if (reads === 2) (world.store as Record<string, unknown>)[OLD_AGENT] = record('0e0e0e01', 'working', AT, true)
  }
  await startOn($, on, world)
  expect(reads).toBe(2)
  expect((world.store?.[OLD_AGENT] as ProgressMirror).state).toBe('working')
})

test('a record the store cap chose is kept when its agent writes it again before the cap deletes it', async ($, on) => {
  const world = capWorld(5_000_000)
  let reads = 0
  world.beforeStoreGet = key => {
    if (key !== 'agent:0d0d0d02') return
    reads += 1
    // The walk of the age rules read it first, the cap second; the third read is right before the delete.
    if (reads === 3) (world.store as Record<string, unknown>)['agent:0d0d0d02'] = padded('0d0d0d02', 'working', AT, true)
  }
  await capStart($, on, world)
  expect(reads).toBe(3)
  expect((world.store?.['agent:0d0d0d02'] as ProgressMirror).state).toBe('working')
  expect(world.store?.['agent:0d0d0d03']).toBeUndefined()
})

// A date a clock that ran ahead wrote never ages by itself. Off the board it counts as old once it
// is more than a day ahead; on the board the block is what keeps it.
const AHEAD_BOARD = `${BOARD}## synthetic-agents\n<!-- auto session=0e0e0e01 agent=codex state=waiting updated=2026-10-16T11:30:00Z -->\n### Synthetic agent work\n- [ ] Synthetic step\n<!-- /auto session=0e0e0e01 -->\n`

test('a record dated more than a day ahead is removed when its block is not on the board, and kept when it is', async ($, on) => {
  const world = oldAgentWorld(AHEAD_BOARD)
  const store = world.store as Record<string, unknown>
  store[OLD_AGENT] = record('0e0e0e01', 'working', AT + 2 * DAY, true)
  store['agent:0e0e0e09'] = record('0e0e0e09', 'working', AT + 2 * DAY, true)
  store['agent:0e0e0e08'] = record('0e0e0e08', 'working', AT + DAY, true)
  await startOn($, on, world)
  expect(store[OLD_AGENT]).toBeDefined()
  expect(store['agent:0e0e0e09']).toBeUndefined()
  // Exactly a day ahead is still within a clock's usual error.
  expect(store['agent:0e0e0e08']).toBeDefined()
})

// The keys that only belong to a record (#373): the receipts of the prompts an agent took, the
// completions the person confirmed, and the journal lines a session could not write.
const receipt = (id: string): Record<string, unknown> => ({ id, agent: 'codex', session: 'synthetic-session', at: AT - 5 * DAY, updated: AT - 5 * DAY })
const completionKeyOf = (owner: string): string => `${completionPrefix(owner)}${'a'.repeat(64)}:${AT - 5 * DAY}`

test('the prompt receipts, confirmed completions and journal lines of a record the age rules remove go with it, and those of a record that stays stay', async ($, on) => {
  const world = oldAgentWorld(AHEAD_BOARD)
  const store = world.store as Record<string, unknown>
  store['agentPrompt:0e0e0e01:1:2'] = receipt('0e0e0e01')
  store[completionKeyOf('agent:0e0e0e01')] = { owner: 'agent:0e0e0e01' }
  store[OLD_AGENT] = record('0e0e0e01', 'ended', AT - 5 * DAY, true)
  // Another record on this board, ended and old, whose block is gone.
  store['agent:0e0e0e02'] = record('0e0e0e02', 'ended', AT - 5 * DAY, true)
  store['agentPrompt:0e0e0e02:1:2'] = receipt('0e0e0e02')
  store[completionKeyOf('agent:0e0e0e02')] = { owner: 'agent:0e0e0e02' }
  store[SECOND_MIRROR] = record('0e0e0e03', 'ended', AT - 8 * DAY, false)
  store[completionKeyOf(SECOND_MIRROR)] = { owner: SECOND_MIRROR }
  store['pendingJournalBad:0e0e0e03-0000-4000-8000-000000000001'] = { '/home/me/.claude/progress-journal-2026-10.md': ['synthetic line'] }
  // A session with this id prefix whose record is not the mirror's.
  store['pendingJournalBad:0e0e0e03-0000-4000-8000-0000000000019'] = { '/home/me/.claude/progress-journal-2026-10.md': ['synthetic line'] }
  await startOn($, on, world)
  // 0e0e0e01 is on the board (AHEAD_BOARD), so its record and keys stay; 0e0e0e02 and the mirror go.
  expect(store[OLD_AGENT]).toBeDefined()
  expect(store['agentPrompt:0e0e0e01:1:2']).toBeDefined()
  expect(store[completionKeyOf('agent:0e0e0e01')]).toBeDefined()
  expect(store['agent:0e0e0e02']).toBeUndefined()
  expect(store['agentPrompt:0e0e0e02:1:2']).toBeUndefined()
  expect(store[completionKeyOf('agent:0e0e0e02')]).toBeUndefined()
  expect(store[SECOND_MIRROR]).toBeUndefined()
  expect(store[completionKeyOf(SECOND_MIRROR)]).toBeUndefined()
  expect(store['pendingJournalBad:0e0e0e03-0000-4000-8000-000000000001']).toBeUndefined()
  expect(store['pendingJournalBad:0e0e0e03-0000-4000-8000-0000000000019']).toBeDefined()
  // The count is of records, one each; the keys that went with them are not counted again.
  expect(store.prunedCounts).toEqual({ '2026-10-16': { agent: 1, mirror: 1 } })
})

test('a record the store cap removes takes its prompt receipts and confirmed completions with it', async ($, on) => {
  const world = capWorld(5_000_000)
  const store = world.store as Record<string, unknown>
  store['agentPrompt:0d0d0d02:1:2'] = receipt('0d0d0d02')
  store[completionKeyOf('agent:0d0d0d02')] = { owner: 'agent:0d0d0d02' }
  store['agentPrompt:0b0b0b01:1:2'] = receipt('0b0b0b01')
  store[completionKeyOf('agent:0b0b0b01')] = { owner: 'agent:0b0b0b01' }
  await capStart($, on, world)
  expect(store['agent:0d0d0d02']).toBeUndefined()
  expect(store['agentPrompt:0d0d0d02:1:2']).toBeUndefined()
  expect(store[completionKeyOf('agent:0d0d0d02')]).toBeUndefined()
  // The record of a block on the board stays with its keys.
  expect(store['agent:0b0b0b01']).toBeDefined()
  expect(store['agentPrompt:0b0b0b01:1:2']).toBeDefined()
  expect(store[completionKeyOf('agent:0b0b0b01')]).toBeDefined()
})

// A time kept for a task that left the board comes back from another session's older save. The
// later task of that name, ticked now, must be seen done now, not at the time that came back.
test('a time that comes back for an archived task does not win over the new time of a later task with that name', async ($, on) => {
  const key = 'done:synthetic-project::Synthetic weekly review'
  const world: World = {
    files: new Map([[FILE, '## synthetic-project\n### Synthetic weekly review\n- [x] Synthetic step\n']]),
    mtime: 1,
    hasTasks: true,
    store: { inboxDone: {}, autoConnectOff: true },
  }
  const store = world.store as Record<string, unknown>
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const first = (store.doneSeen as Record<string, number>)[key]
  expect(first).toBeDefined()
  // Archived: the task is gone from the file, and its time with it.
  world.files.set(FILE, '## synthetic-project\n### Another task\n- [ ] Synthetic step\n')
  world.mtime += 1
  await clock.advance(3000)
  expect(store.doneSeen).toEqual({})
  // Another session's older save puts the old time back.
  store.doneSeen = { [key]: first }
  world.files.set(FILE, '## synthetic-project\n### Synthetic weekly review\n- [x] Synthetic step\n')
  world.mtime += 1
  await clock.advance(3000)
  expect((store.doneSeen as Record<string, number>)[key]).toBeGreaterThan(first ?? Infinity)
  expect(world.files.get(FILE)).toContain('### Synthetic weekly review')
})

// An inbox file the drain gave up on (#373): kept a week from when it was set aside.
const BROKEN = 'codex-turn-1792216380-10.json'
const brokenWorld = (): World => ({
  files: new Map([[FILE, '# Progress\n'], [`${INBOX}/${BROKEN}`, '{synthetic broken input']]),
  mtime: 1,
  hasTasks: true,
  isArchiveClockOnly: true,
  store: { inboxDone: {}, autoConnectOff: true },
  ran: [],
})

test('an inbox file set aside by an earlier release, over a week old by its own date, is kept a week from the first sweep that sees it', { timeoutMs: 300000 }, async ($, on) => {
  const name = 'codex-turn-1-1.json.failed'
  const world: World = {
    files: new Map([[FILE, '# Progress\n'], [`${INBOX}/${name}`, '{synthetic broken input']]),
    mtimes: { [`${INBOX}/${name}`]: AT - 2592000000 },
    mtime: 1,
    hasTasks: true,
    isArchiveClockOnly: true,
    store: { inboxDone: {}, autoConnectOff: true },
    ran: [],
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(world.files.has(`${INBOX}/${name}`)).toBe(true)
  expect((world.store?.inboxSetAside as Record<string, number>)[name]).toBeGreaterThanOrEqual(AT)
  await clock.advance(6 * DAY)
  expect(world.files.has(`${INBOX}/${name}`)).toBe(true)
  await clock.advance(2 * DAY)
  expect(world.files.has(`${INBOX}/${name}`)).toBe(false)
  expect((world.store?.inboxSetAside as Record<string, number>)[name]).toBeUndefined()
})

test('the time an inbox file is set aside is recorded before the move, so a move that goes through finds it', async ($, on) => {
  const world = brokenWorld()
  let atMove: Record<string, number> | undefined
  world.isMoveRefused = from => {
    if (from.endsWith('.taking')) atMove = structuredClone(world.store?.inboxSetAside) as Record<string, number> | undefined
    return false
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(2 * HOUR)
  expect(world.files.has(`${INBOX}/${BROKEN}.failed`)).toBe(true)
  expect(Object.keys(atMove ?? {})).toEqual([`${BROKEN}.failed`])
})

test('a move to .failed that fails has already recorded the time, which the next sweep lets go as it finds no such file', async ($, on) => {
  const world = brokenWorld()
  let atRefusal: Record<string, number> | undefined
  world.isMoveRefused = from => {
    if (!from.endsWith('.taking')) return false
    atRefusal = structuredClone(world.store?.inboxSetAside) as Record<string, number> | undefined
    return true
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(2 * HOUR)
  expect(world.files.has(`${INBOX}/${BROKEN}.failed`)).toBe(false)
  expect(Object.keys(atRefusal ?? {})).toEqual([`${BROKEN}.failed`])
  // The sweep after it finds no such file, and the name needs no time.
  expect(world.store?.inboxSetAside).toEqual({})
})

// PowerShell's Remove-Item stops at the first file that is not there when it is told to stop on
// errors, so a file another session removed first held the rest of the batch back for an hour.
test('on Windows a batch of removals goes on past a file another session already removed', async ($, on) => {
  const store = `${STORE_DIR}/agent-board_agent-board-0a1b2c3d4e5f.json`
  const gone = `${store}.tmp.1a1a1a1a`
  const later = `${store}.tmp.2b2b2b2b`
  const world: World = {
    files: new Map([[FILE, BOARD], [store, '{}'], [gone, '{}'], [later, '{}']]),
    mtimes: { [store]: AT, [gone]: AT - DAY - HOUR, [later]: AT - DAY - HOUR },
    mtime: 1,
    hasTasks: true,
    env: { OS: 'Windows_NT', HOME: '/home/me', LANG: 'en_US.UTF-8' },
    store: { inboxDone: {}, autoConnectOff: true },
    ran: [],
  }
  // The sweep has listed both copies when it reads its record; another session removes the first then.
  world.beforeStoreGet = key => {
    if (key !== 'inboxSetAside') return
    world.beforeStoreGet = undefined
    world.files.delete(gone)
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const removals = (world.ran ?? []).filter(argv => argv[0] === 'powershell' && (argv[3] ?? '').startsWith('Remove-Item'))
  expect(removals).toHaveLength(1)
  expect(removals[0]?.[3]).toContain('-ErrorAction SilentlyContinue')
  expect(world.files.has(later)).toBe(false)
  expect(world.files.has(store)).toBe(true)
})

// The sweep reads the record of set-aside times first and writes it last, with removals between.
// A time another part of the pane adds in between is a newer entry, not something to write over.
test('a time recorded for a file set aside while the sweep removes other files is still there after it', async ($, on) => {
  const old = 'codex-turn-1-1.json.failed'
  const world: World = {
    files: new Map([[FILE, BOARD], [`${INBOX}/${old}`, '{}']]),
    mtime: 1,
    hasTasks: true,
    store: { inboxDone: {}, autoConnectOff: true, inboxSetAside: { [old]: AT - 8 * DAY } },
    ran: [],
  }
  world.isRemoveRefused = () => {
    ;(world.store as Record<string, unknown>).inboxSetAside = { ...(world.store?.inboxSetAside as object), 'codex-turn-1-2.json.failed': AT }
    return false
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(world.files.has(`${INBOX}/${old}`)).toBe(false)
  expect(world.store?.inboxSetAside).toEqual({ 'codex-turn-1-2.json.failed': AT })
})


test('a store held over the cap skips full record reads for six hours, then retries a newly ended record', async ($, on) => {
  const world = capWorld(1_572_865)
  world.isArchiveClockOnly = true
  world.storeReads = []
  const store = world.store as Record<string, unknown>
  for (const key of [OLD_MIRROR, 'agent:0d0d0d02', 'agent:0d0d0d03', 'agent:0d0d0d04']) delete store[key]
  const agent = 'agent:0d0d0d05'
  const mirror = 'mirror:0e0e0e01-0000-4000-8000-000000000001'
  store[mirror] = padded('0e0e0e01', 'working', AT, true)
  // Keep the separate bounded age walk in its hint segment, so these reads measure the cap pass.
  store.pruneAfter = 'agent:zzzzzzzz'
  for (let i = 0; i < 5000; i += 1) store[`hinted:synthetic-${String(i).padStart(4, '0')}`] = AT
  const reads = () => (world.storeReads ?? []).filter(key => key === agent || key === mirror)
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(reads()).toEqual([agent, mirror])
  expect(store.storeCapHeld).toEqual({ at: AT })
  world.storeReads.length = 0
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(HOUR)
  expect(reads()).toEqual([])
  store[agent] = padded('0d0d0d05', 'ended', AT, false)
  await clock.advance(4 * HOUR)
  expect(reads()).toEqual([])
  expect(store[agent]).toBeDefined()
  await clock.advance(HOUR)
  expect(reads()).toContain(agent)
  expect(reads()).toContain(mirror)
  expect(store[agent]).toBeUndefined()
  expect(store[mirror]).toBeDefined()
})

test('a store under the cap lets a previous six-hour hold go', async ($, on) => {
  const world = capWorld(1_572_863)
  ;(world.store as Record<string, unknown>).storeCapHeld = { at: AT }
  await capStart($, on, world)
  expect(world.store?.storeCapHeld).toBeUndefined()
})

test('a store-cap pass skipped while the board is busy sets no six-hour hold', async ($, on) => {
  const world = capWorld(5_000_000)
  world.isArchiveClockOnly = true
  world.storeReads = []
  world.beforeStoreGet = key => {
    if (key !== OLD_MIRROR) return
    world.beforeStoreGet = undefined
    world.mtime += 1
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const store = world.store ?? {}
  for (const key of [OLD_MIRROR, 'agent:0d0d0d02', 'agent:0d0d0d03', 'agent:0d0d0d04']) expect(store[key]).toBeDefined()
  expect(store.prunedCounts).toBeUndefined()
  expect(store.storeCapHeld).toBeUndefined()
  world.storeReads.length = 0
  await clock.advance(HOUR)
  expect(world.storeReads).toContain(OLD_MIRROR)
  expect(store[OLD_MIRROR]).toBeUndefined()
  expect(store.prunedCounts).toEqual({ '2026-10-16': { agent: 3, mirror: 1 } })
})

test('a store under the cap with no hold writes no storeCapHeld delete', async ($, on) => {
  const world = capWorld(1_572_863)
  const deleted: string[] = []
  world.store = new Proxy(world.store ?? {}, {
    deleteProperty: (store, key) => {
      deleted.push(String(key))
      return Reflect.deleteProperty(store, key)
    },
  })
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(deleted).not.toContain('storeCapHeld')
  expect(world.store?.storeCapHeld).toBeUndefined()
})

test('a failing storeCapHeld save still counts the records the cap removed', async ($, on) => {
  const world = capWorld(5_000_000)
  let saves = 0
  world.failStore = (operation, key) => {
    if (operation !== 'set' || key !== 'storeCapHeld') return false
    saves += 1
    return true
  }
  await capStart($, on, world)
  expect(saves).toBe(1)
  expect(world.store?.storeCapHeld).toBeUndefined()
  for (const key of [OLD_MIRROR, 'agent:0d0d0d02', 'agent:0d0d0d03', 'agent:0d0d0d04']) expect(world.store?.[key]).toBeUndefined()
  expect(world.store?.prunedCounts).toEqual({ '2026-10-16': { agent: 3, mirror: 1 } })
})

test('overlapping sweep and drain saves keep both set-aside changes through the save queue', async ($, on) => {
  const old = 'codex-turn-1-1.json.failed'
  const name = 'codex-turn-1-2.json'
  const taken = `${name}.synthetic-${(AT - HOUR).toString(36)}-8.taking`
  const world: World = {
    files: new Map([[FILE, BOARD], [`${INBOX}/${old}`, '{}']]),
    mtime: 1,
    hasTasks: true,
    store: { inboxDone: {}, autoConnectOff: true, inboxSetAside: { [old]: AT - 8 * DAY } },
    ran: [],
  }
  let release = () => {}
  const held = new Promise<void>(done => { release = done })
  let reached = () => {}
  const holding = new Promise<void>(done => { reached = done })
  let reads = 0
  world.beforeStoreGet = key => {
    if (key !== 'inboxSetAside' || ++reads !== 2) return
    reached()
    return held
  }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/synthetic', surface: 'desktop', isInteractive: true })
  await holding
  // The sweep's queued save has captured its old value. The drain now asks the same queue to save.
  world.files.set(`${INBOX}/${taken}`, '{synthetic broken input')
  let draining = () => {}
  const drainRead = new Promise<void>(done => { draining = done })
  world.beforeRead = path => { if (path === `${INBOX}/${taken}`) draining() }
  let moved = () => {}
  const drainDone = new Promise<void>(done => { moved = done })
  world.afterMove = (_from, to) => { if (to === `${INBOX}/${name}.failed`) moved(); return false }
  try {
    await clock.advance(5000)
    await drainRead
    // Flush work after the payload read, through clock.now and into saveSetAside, before release.
    await clock.advance(1)
  } finally {
    release()
  }
  await drainDone
  await clock.advance(1)
  expect(world.files.has(`${INBOX}/${old}`)).toBe(false)
  expect(world.files.has(`${INBOX}/${name}.failed`)).toBe(true)
  expect(world.store?.inboxSetAside).toEqual({ [`${name}.failed`]: AT + 5000 })
})

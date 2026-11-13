import type { On } from 'claude-code'
import { expect, test } from './kit'
import type { Engine } from 'claude-code/testing'
import { oldMonthFiles } from '../hooks/old-months'
import { engineBeneath, FILE, makeWorld } from './fixtures/pane-world'
import type { World } from './fixtures/pane-world'

// Old archive and journal months move to an archives folder (#922), against the mock engine.
// All data is made up.
const english = { HOME: '/home/me', LANG: 'en_US.UTF-8' }
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const HOUR = 3_600_000
const DIR = '/home/me/.claude'
const START = { cwd: '/work/persona_framework', surface: 'terminal' as const, isInteractive: true }
const OLD = ['progress-archive-2026-05.md', 'progress-journal-2026-06.md', 'progress-archive-2026-07-2.md']
const KEPT = ['progress-archive-2026-08.md', 'progress-journal-2026-09.md', 'progress-archive-2026-10.md', 'progress-journal-2026-10.md']

const seed = (world: World): void => {
  for (const name of [...OLD, ...KEPT]) world.files.set(`${DIR}/${name}`, `## synthetic ${name}\n- [x] Made up\n`)
}
const removals = (world: World): number => (world.ran ?? []).filter(argv => argv[0] === 'rm').length

test('archive and journal months older than 3 months move to the archives folder and are never deleted', async ($, on) => {
  const world = makeWorld([[FILE, '## demo\n']])
  world.env = english
  world.isArchiveClockOnly = true
  world.ran = []
  seed(world)
  const before = new Map(world.files)
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(HOUR)
  for (const name of OLD) {
    expect(world.files.has(`${DIR}/${name}`)).toBe(false)
    expect(world.files.get(`${DIR}/archives/${name}`)).toBe(before.get(`${DIR}/${name}`))
  }
  for (const name of KEPT) {
    expect(world.files.get(`${DIR}/${name}`)).toBe(before.get(`${DIR}/${name}`))
    expect(world.files.has(`${DIR}/archives/${name}`)).toBe(false)
  }
  expect(removals(world)).toBe(0)
})

test('an old month whose name is taken in the archives folder stays where it is and the other moves', async ($, on) => {
  const world = makeWorld([[FILE, '## demo\n']])
  world.env = english
  world.isArchiveClockOnly = true
  world.ran = []
  seed(world)
  world.files.set(`${DIR}/archives/${OLD[0]}`, 'older words that must survive\n')
  const mine = world.files.get(`${DIR}/${OLD[0]}`)
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(HOUR)
  expect(world.files.get(`${DIR}/${OLD[0]}`)).toBe(mine)
  expect(world.files.get(`${DIR}/archives/${OLD[0]}`)).toBe('older words that must survive\n')
  expect(world.files.has(`${DIR}/archives/${OLD[1]}`)).toBe(true)
  expect(removals(world)).toBe(0)
})

test('an old month whose move fails stays in place and does not stop the others', async ($, on) => {
  const world = makeWorld([[FILE, '## demo\n']])
  world.env = english
  world.isArchiveClockOnly = true
  seed(world)
  world.isMoveRefused = path => path.endsWith(OLD[0]!)
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(HOUR)
  expect(world.files.has(`${DIR}/${OLD[0]}`)).toBe(true)
  expect(world.files.has(`${DIR}/archives/${OLD[1]}`)).toBe(true)
  expect(world.files.has(`${DIR}/archives/${OLD[2]}`)).toBe(true)
})

test('which month files move depends on the day, the last three months stay, and a taken name is skipped', () => {
  const names = ['progress.md', 'progress-archive-2026-07.md', 'progress-archive-2026-08.md', 'progress-journal-2026-07-3.md', 'other-archive-2026-01.md', 'progress-archive.pending']
  expect(oldMonthFiles('progress', names, [], NOW)).toEqual(['progress-archive-2026-07.md', 'progress-journal-2026-07-3.md'])
  expect(oldMonthFiles('progress', names, ['progress-archive-2026-07.md'], NOW)).toEqual(['progress-journal-2026-07-3.md'])
  expect(oldMonthFiles('progress', names, [], Date.parse('2026-12-02T12:00:00.000Z'))).toEqual(['progress-archive-2026-07.md', 'progress-archive-2026-08.md', 'progress-journal-2026-07-3.md'])
})

// A board of session blocks and hand-kept tasks, made up: session n sits in project n % projects.
const boardOf = (sessions: number, projects: number, taskBytes: number): string => {
  const stamp = new Date(NOW - HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const step = '- [x] Synthetic finished step of some length to fill the line\n'
  return Array.from({ length: projects }, (_, p) => {
    const blocks = Array.from({ length: sessions }, (__, n) => n).filter(n => n % projects === p).map(n => {
      const id = `s${String(n).padStart(7, '0')}`

      return `<!-- auto session=${id} agent=codex state=working updated=${stamp} -->\n### Synthetic plan ${n}\n- [~] Work\n<!-- /auto session=${id} -->\n`
    }).join('')

    return `## project-${p}\n${blocks}### Hand-kept ${p}\n${step.repeat(Math.ceil(taskBytes / projects / step.length))}`
  }).join('\n')
}

type Reads = { start: number; poll: number; ops: number }
const seen = new Map<string, Reads>()

for (const [name, sessions, projects, taskBytes] of [['normal', 10, 7, 60_000], ['scale', 100, 70, 600_000]] as const) {
  test(`the ${name} board's session start and idle poll reads are counted`, { timeoutMs: 120_000 }, async ($, on) => {
    const world = makeWorld([[FILE, boardOf(sessions, projects, taskBytes)]])
    world.env = english
    const clock = engineBeneath(on, world)
    world.reads = []
    await $.session.start(START)
    for (let n = 0; n < 6; n++) await clock.advance(2000)
    const start = world.reads.length
    world.reads = []
    world.fileOps = []
    await clock.advance(2000)
    seen.set(name, { start, poll: world.reads.length, ops: world.fileOps.length })
    // The fixture really is that big.
    expect((world.files.get(FILE) ?? '').length).toBeGreaterThan(taskBytes)
  })
}

test('a board with 100 sessions in 70 projects keeps the pane and page read counts of the normal board', () => {
  const normal = seen.get('normal')
  const scale = seen.get('scale')
  expect(normal).toBeDefined()
  expect(scale).toEqual(normal)
})

import { expect, test } from 'claude-code/testing'
import { parseProgress } from '../hooks/parse'
import { parseQuestions, questionsPath } from '../hooks/questions'
import { EN } from '../hooks/strings-en'
import { engineBeneath, FILE, makeWorld, PANE, PROPS, visiblePaneText } from './fixtures/pane-world'

// The question ledger against the host's cap on one write (#419). All data is made up.
const english = { HOME: '/home/me', LANG: 'en_US.UTF-8' }
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const HOUR = 3_600_000
const LEDGER = questionsPath(FILE)
const START = { cwd: '/work/persona_framework', surface: 'terminal' as const, isInteractive: true }

const block = (session: string, state: string, hours: number, steps: string, title = `Synthetic plan ${session}`): string =>
  `<!-- auto session=${session} agent=codex state=${state} updated=${new Date(NOW - hours * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z')} -->\n### ${title}\n> Context: Synthetic data.\n${steps}\n<!-- /auto session=${session} -->\n`

// Waiting blocks that each ask one question, with a few finished steps before it.
const askingBoard = (count: number): string => `## demo\n${Array.from({ length: count }, (_, n) => {
  const session = `b${String(n).padStart(7, '0')}`
  const done = Array.from({ length: 4 }, (_, step) => `- [x] Synthetic step ${step} of plan ${n}, written out at some length`).join('\n')
  return block(session, 'waiting', 1, `${done}\n- [?] Publish synthetic plan ${n} to the shared folder, OK?`)
}).join('\n')}`

test('a board whose whole-block copies would make a question ledger over the host\'s 4 MiB write limit has its questions saved in one pass, in a ledger under a megabyte', { timeoutMs: 60_000 }, async ($, on) => {
  // 150 blocks of 12 steps: eight long finished steps and four short questions each. The board
  // stays under a megabyte, as a real one does, while a copy of the whole task per question
  // would come to more than the limit.
  const board = `## demo\n${Array.from({ length: 150 }, (_, n) => {
    const steps = Array.from({ length: 12 }, (_, step) => step < 8
      ? `- [x] Synthetic plan ${n} step ${step}: ${'Synthetic words for a finished step. '.repeat(15)}`
      : `- [?] Publish synthetic part ${step} of plan ${n}, OK?`).join('\n')
    return block(`b${n.toString(16).padStart(7, '0')}`, 'waiting', 0, steps)
  }).join('\n')}`
  expect(board.length).toBeLessThan(1_000_000)
  const tasks = parseProgress(board).flatMap(project => project.tasks)
  expect(tasks).toHaveLength(150)
  expect(tasks.reduce((size, task) => size + task.steps.filter(step => step.status === 'waiting').length * JSON.stringify(task).length, 0)).toBeGreaterThan(4_194_304)
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.writeLimit = 4_194_304
  world.written = []
  world.refused = []
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  expect(world.files.has(LEDGER)).toBe(true)
  const text = world.files.get(LEDGER)!
  expect(parseQuestions(text)?.records.filter(record => record.isUnresolved)).toHaveLength(600)
  expect(new TextEncoder().encode(text).length).toBeLessThan(1_000_000)
  const writes = world.written.filter(path => path.startsWith(`${LEDGER}.tmp-`))
  expect(writes).toHaveLength(1)
  expect(world.refused.filter(path => path.includes('-questions'))).toEqual([])
})

test('an edit above a block that asks writes no new copy of its question over ten polls', async ($, on) => {
  const asked = block('a1b2c301', 'waiting', 0, '- [x] Synthetic preparation\n- [?] Publish the synthetic plan, OK?')
  // A hand-kept task above the block that grows a step at each poll, so every line of the block moves.
  const boardWith = (lines: number): string => `## demo\n### Synthetic notes\n${Array.from({ length: lines + 1 }, (_, n) => `- [ ] Synthetic note ${n}`).join('\n')}\n\n${asked}`
  const world = makeWorld([[FILE, boardWith(0)]])
  world.env = english
  world.written = []
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  await clock.advance(2000)
  const id = parseQuestions(world.files.get(LEDGER) ?? '')?.records.find(record => record.isUnresolved)?.id
  expect(id).toBeDefined()
  world.written = []
  for (let lines = 1; lines <= 10; lines += 1) {
    world.files.set(FILE, boardWith(lines))
    world.mtime += 1
    await clock.advance(2000)
  }
  expect(world.written.filter(path => path.includes('-questions-source-'))).toEqual([])
  expect(parseQuestions(world.files.get(LEDGER) ?? '')?.records.filter(record => record.isUnresolved).map(record => record.id)).toEqual([id])
  // The polls did read each edit: a change to one of the block's marks is a new copy at once.
  world.files.set(FILE, boardWith(10).replace('- [x] Synthetic preparation', '- [~] Synthetic preparation'))
  world.mtime += 1
  await clock.advance(2000)
  expect(world.written.filter(path => path.includes('-questions-source-')).length).toBeGreaterThan(0)
})

test('a question ledger the host refuses to write shows the question-list line after three passes, and each pass sends it once', async ($, on) => {
  const world = makeWorld([[FILE, askingBoard(12)]])
  world.env = english
  world.written = []
  world.refused = []
  // Enough for a capture or a short file, not for the ledger of twelve questions.
  world.writeLimit = 4096
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const sent = (): number => (world.refused ?? []).filter(path => path.startsWith(`${LEDGER}.tmp-`)).length
    const trace: Array<{ sent: number; isShown: boolean }> = []
    let before = sent()
    for (let poll = 0; poll < 8; poll += 1) {
      await clock.advance(2000)
      const now = sent()
      // One pass to a poll, and a refused write is not tried again inside it.
      expect(now - before).toBeLessThanOrEqual(1)
      before = now
      trace.push({ sent: now, isShown: visiblePaneText(await ui.drawn()).includes(EN.questionsUnreadable()) })
    }
    expect(world.files.has(LEDGER)).toBe(false)
    expect(sent()).toBeGreaterThanOrEqual(3)
    // Every ledger write the pane sent was the refused one.
    expect((world.written ?? []).filter(path => path.startsWith(`${LEDGER}.tmp-`))).toHaveLength(sent())
    // The line shows once three passes have failed in a row, and stays.
    expect(trace).toEqual(trace.map(one => ({ sent: one.sent, isShown: one.sent >= 3 })))
  } finally { await ui.unmount() }
})

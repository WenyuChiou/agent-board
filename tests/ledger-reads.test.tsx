import { expect, test } from 'claude-code/testing'
import { parseProgress } from '../hooks/parse'
import { captureJson, capturePath, emptyQuestions, observeQuestions, parseCapture, parseQuestions, questionProofJson, questionProofPath, questionsJson, questionsPath } from '../hooks/questions'
import type { QuestionCapture } from '../hooks/questions'
import { sha256 } from '../hooks/sha256'
import { answeredPath } from '../hooks/view'
import { finished, ledgerOf, reopened } from './fixtures/question-files'
import { engineBeneath, FILE, INBOX, makeWorld, PANE, PROPS, visiblePaneText } from './fixtures/pane-world'
import type { World } from './fixtures/pane-world'

// The files the pane keeps beside progress.md for its questions (#156), and the automatic archive
// of a block that still asks (#174), against the mock engine. All data is made up.
const english = { HOME: '/home/me', LANG: 'en_US.UTF-8' }
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const HOUR = 3_600_000
const LEDGER = questionsPath(FILE)
const ANSWERED = answeredPath(FILE)
const ARCHIVE = '/home/me/.claude/progress-archive-2026-10.md'
const CAPTURES = '-questions-source-'
const RETIRED = '-questions-retired-'
const CONSUMED = '-questions-consumed-'
const TIDY = { command: 'progress', args: 'tidy', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
const START = { cwd: '/work/persona_framework', surface: 'terminal' as const, isInteractive: true }

const block = (session: string, state: string, hours: number, steps: string, title = `Synthetic plan ${session}`): string =>
  `<!-- auto session=${session} agent=codex state=${state} updated=${new Date(NOW - hours * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z')} -->\n### ${title}\n> Context: Synthetic data.\n${steps}\n<!-- /auto session=${session} -->\n`

// A file with a modified time of its own, so the order of the files does not drift with the clock.
const put = (world: World, path: string, text: string, mtime: number): void => {
  world.files.set(path, text)
  world.mtimes = { ...world.mtimes, [path]: mtime }
}
const captureFile = (record: Parameters<typeof captureJson>[0], disposition: QuestionCapture['disposition']): string => capturePath(FILE, sha256(captureJson(record, disposition)))
const proofFile = (kind: 'retired' | 'consumed', key: string): string => questionProofPath(FILE, kind, sha256(key))
const putCapture = (world: World, record: Parameters<typeof captureJson>[0], disposition: QuestionCapture['disposition'], mtime: number): void => put(world, captureFile(record, disposition), captureJson(record, disposition), mtime)
const putProof = (world: World, kind: 'retired' | 'consumed', key: string, mtime: number): void => put(world, proofFile(kind, key), questionProofJson(kind, sha256(key)), mtime)
const filesOf = (world: World, marker: string): string[] => [...world.files.keys()].filter(path => path.includes(marker)).sort()
const capturesOf = (world: World): QuestionCapture[] => filesOf(world, CAPTURES).map(path => parseCapture(world.files.get(path) ?? '', path.slice(path.lastIndexOf('-') + 1, -5))!)
const ledgerRecords = (world: World) => parseQuestions(world.files.get(LEDGER) ?? '')?.records ?? []
const removals = (world: World): number => (world.ran ?? []).filter(argv => argv[0] === 'rm').length
// How many paths each removal process was given.
const removedPerProcess = (world: World): number[] => (world.ran ?? []).filter(argv => argv[0] === 'rm').map(argv => argv.length - 2)
// The key of a retirement proof that no ledger record, capture or acknowledgement refers to.
const orphan = (n: number): string => `question:${'0'.repeat(60)}${String(n).padStart(4, '0')}:${n + 50}`
const putOrphans = (world: World, count: number): string[] => {
  const keys = Array.from({ length: count }, (_, n) => orphan(n))
  keys.forEach((key, n) => putProof(world, 'retired', key, 1_000 + n))

  return keys
}
// A board whose question puts the ledger there for the polls to write. The clean-up stops at a
// missing ledger, so these tests need one beside the proofs they pile up.
const pruningBoard = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`

// What the pane would have written for a board it had watched for a while: the ledger and the copy of each question.
const seedAsked = (world: World, board: string): void => {
  const ledger = observeQuestions(emptyQuestions(), parseProgress(board), null, [], NOW, true, 'seed').ledger
  put(world, LEDGER, questionsJson(ledger), 1)
  for (const record of ledger.records) putCapture(world, record, 'unresolved', 2)
}

test('an idle poll reads the same few files with piles of captures, proofs and inbox turns waiting', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}${block('a1b2c302', 'working', 1, '- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  // Forty answered questions, each with two copies and a retirement proof, twenty acknowledgement
  // proofs and thirty turns that other agents left in the inbox.
  const answered = Array.from({ length: 40 }, (_, n) => finished(n + 1))
  put(world, LEDGER, questionsJson(ledgerOf(...answered)), 1)
  answered.forEach((record, n) => {
    putCapture(world, reopened(record), 'unresolved', 10 + n)
    putCapture(world, record, 'resolved', 100 + n)
    putProof(world, 'retired', record.id, 10 + n)
    putProof(world, 'consumed', `old acknowledgement ${n}`, 10 + n)
    put(world, `${INBOX}/codex-turn-${1_760_000_000 + n}-1.json`, JSON.stringify({ session_id: `synthetic-session-${n}`, cwd: '/work/demo', prompt: 'Synthetic request', last_assistant_message: 'Synthetic work is done.' }), 1_000 + n)
  })
  world.reads = []
  await $.session.start(START)
  // The first looks read everything once; the poll after that finds nothing changed.
  await clock.advance(2000)
  expect(world.reads.some(path => path.includes(CAPTURES))).toBe(true)
  expect(world.reads.some(path => path.includes(RETIRED) || path.includes(CONSUMED))).toBe(true)
  expect(world.reads.some(path => path.startsWith(INBOX))).toBe(true)
  world.reads = []
  await clock.advance(2000)
  // The ledger three times and progress.md twice, whatever the piles beside them.
  expect([...world.reads].sort()).toEqual([FILE, FILE, LEDGER, LEDGER, LEDGER].sort())
})

test('an inbox turn that arrives between two polls is read at the next poll', async ($, on) => {
  const world = makeWorld([[FILE, `## demo\n${block('a1b2c302', 'working', 1, '- [~] Work')}`]])
  world.env = english
  world.reads = []
  const clock = engineBeneath(on, world)
  const turn = (session: string): string => JSON.stringify({ session_id: session, cwd: '/work/demo', prompt: 'Synthetic request', last_assistant_message: 'Synthetic work is done.' })
  const first = `${INBOX}/codex-turn-1760000000-1.json`
  const second = `${INBOX}/codex-turn-1760000001-1.json`
  put(world, first, turn('synthetic-session-1'), 1_000)
  await $.session.start(START)
  await clock.advance(2000)
  expect(world.reads).toContain(first)
  // The listing differs now, so the cached turns are not reused.
  world.reads = []
  put(world, second, turn('synthetic-session-2'), 1_001)
  await clock.advance(2000)
  expect(world.reads).toContain(second)
})

test('a capture is read once, a damaged one is read at every look, and a repaired one is read once more', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`
  const record = finished(1)
  const good = captureJson(record, 'resolved')
  const path = captureFile(record, 'resolved')
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.reads = []
  const clock = engineBeneath(on, world)
  put(world, LEDGER, questionsJson(ledgerOf(record)), 1)
  putProof(world, 'retired', record.id, 2)
  // Cut short, so what it holds no longer matches its name.
  put(world, path, good.slice(0, 40), 3)
  const timesRead = (): number => (world.reads ?? []).filter(one => one === path).length
  await $.session.start(START)
  await clock.advance(2000)
  const first = timesRead()
  expect(first).toBeGreaterThan(0)
  await clock.advance(2000)
  expect(timesRead()).toBeGreaterThan(first)
  // Written whole under the same name: one more read, and then it is remembered.
  put(world, path, good, 4)
  const damaged = timesRead()
  await clock.advance(2000)
  expect(timesRead()).toBe(damaged + 1)
  await clock.advance(2000)
  await clock.advance(2000)
  expect(timesRead()).toBe(damaged + 1)
})

test('captures and proofs beyond the newest 16 are pruned at tidy, and the ledger still holds every unresolved question', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}${block('a1b2c302', 'working', 1, '- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.ran = []
  const clock = engineBeneath(on, world)
  // Three answered questions with the copy from when each was open and from when it was answered,
  // all retired; and twenty old proofs of each kind that nothing refers to any more.
  const answered = [1, 2, 3].map(finished)
  put(world, LEDGER, questionsJson(ledgerOf(...answered)), 1)
  answered.forEach((record, n) => {
    putCapture(world, reopened(record), 'unresolved', 10 + n * 2)
    putCapture(world, record, 'resolved', 11 + n * 2)
    putProof(world, 'retired', record.id, 10 + n)
  })
  for (let n = 0; n < 20; n++) {
    putProof(world, 'retired', `question:${'0'.repeat(63)}${n % 10}:${n + 50}`, 100 + n)
    putProof(world, 'consumed', `old acknowledgement ${n}`, 100 + n)
  }
  await $.session.start(START)
  await clock.advance(2000)
  // The open question is in the ledger by now, with its copy. Twenty older states of its block pile up beside it.
  const open = ledgerRecords(world).find(record => record.isUnresolved)!
  const current = captureFile(open, 'unresolved')
  expect(world.files.has(current)).toBe(true)
  put(world, current, world.files.get(current)!, 5_000)
  const versions = Array.from({ length: 20 }, (_, version) => ({ ...open, source: { ...open.source!, data: JSON.stringify({ version }) } }))
  versions.forEach((record, version) => putCapture(world, record, 'unresolved', 1_000 + version))
  expect(filesOf(world, CAPTURES)).toHaveLength(27)
  const ledgerBefore = world.files.get(LEDGER)

  // The old proofs went when the session started; this sweep takes the copies, in one process.
  world.ran = []
  await $.command.run(TIDY)
  // The newest 16 stay: the open question's own copy and its 15 newest versions. The five oldest
  // versions and the six copies of the answered questions are gone.
  expect(filesOf(world, CAPTURES)).toHaveLength(16)
  expect(world.files.has(current)).toBe(true)
  for (const record of versions.slice(5)) expect(world.files.has(captureFile(record, 'unresolved'))).toBe(true)
  for (const record of versions.slice(0, 5)) expect(world.files.has(captureFile(record, 'unresolved'))).toBe(false)
  for (const record of answered) {
    expect(world.files.has(captureFile(reopened(record), 'unresolved'))).toBe(false)
    expect(world.files.has(captureFile(record, 'resolved'))).toBe(false)
  }
  // The proofs of the answered questions stay (their questions are in the ledger); of the others, the newest 16 of each kind.
  for (const record of answered) expect(world.files.has(proofFile('retired', record.id))).toBe(true)
  expect(filesOf(world, RETIRED)).toHaveLength(19)
  expect(filesOf(world, CONSUMED)).toHaveLength(16)
  expect(removals(world)).toBe(1)
  // The ledger is untouched, and the open question is still there.
  expect(world.files.get(LEDGER)).toBe(ledgerBefore)
  expect(ledgerRecords(world).filter(record => record.isUnresolved).map(record => record.words)).toEqual(['Publish the first plan, OK?'])
  expect(ledgerRecords(world)).toHaveLength(4)
  // A second tidy finds nothing more to remove.
  await $.command.run(TIDY)
  expect(removals(world)).toBe(1)
  expect(filesOf(world, CAPTURES)).toHaveLength(16)
})

test('twenty unresolved questions with no other copy keep all twenty captures at tidy', async ($, on) => {
  const board = `## demo\n${Array.from({ length: 20 }, (_, n) => block(`a1b2c3${n.toString(16).padStart(2, '0')}`, 'waiting', 1, `- [?] Question number ${n}, OK?`)).join('')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.ran = []
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  await clock.advance(2000)
  await clock.advance(2000)
  const kept = filesOf(world, CAPTURES)
  expect(ledgerRecords(world).filter(record => record.isUnresolved)).toHaveLength(20)
  expect(kept.length).toBeGreaterThanOrEqual(20)

  await $.command.run(TIDY)
  expect(filesOf(world, CAPTURES)).toEqual(kept)
  expect(ledgerRecords(world).filter(record => record.isUnresolved)).toHaveLength(20)
  expect(removals(world)).toBe(0)
})

test('an ended block that still asks is archived after its three days, and its question stays unanswered in the ledger and on the pane', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'ended', 96, '- [x] Draft the plan\n- [?] Publish the plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  expect(world.files.get(FILE)).not.toContain('session=a1b2c301')
  expect(world.files.get(ARCHIVE)).toContain('Publish the plan, OK?')
  expect(ledgerRecords(world).filter(record => record.isUnresolved).map(record => record.words)).toEqual(['Publish the plan, OK?'])
  expect(capturesOf(world).some(copy => copy.disposition === 'archived' && copy.record.words === 'Publish the plan, OK?')).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    // The block is gone from the file, so the question sits with the older unanswered ones.
    expect(visiblePaneText(await ui.drawn())).toContain('Older unanswered questions')
    await ui.press({ key: 'section::older' })
    expect(visiblePaneText(await ui.drawn())).toContain('Publish the plan, OK?')
  } finally { await ui.unmount() }
})

test('a block that asks and has not yet been stopped for three days stays, and no archived copy is made', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'ended', 48, '- [x] Draft the plan\n- [?] Publish the plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  await $.command.run(TIDY)
  expect(world.files.get(FILE)).toBe(board)
  expect(world.files.has(ARCHIVE)).toBe(false)
  expect(capturesOf(world).filter(copy => copy.disposition === 'archived')).toEqual([])
})

test('a block whose question copy cannot be written stays in the file until it can', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'ended', 96, '- [x] Draft the plan\n- [?] Publish the plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  // The ledger and the copy of the open question are already kept; only the copy made for the archive fails.
  seedAsked(world, board)
  world.failQuestionCapture = 'write'
  await $.session.start(START)
  await clock.advance(2000)
  await $.command.run(TIDY)
  expect(world.files.get(FILE)).toBe(board)
  expect(world.files.has(ARCHIVE)).toBe(false)
  expect(capturesOf(world).filter(copy => copy.disposition === 'archived')).toEqual([])
  // With the copy writable again, the next sweep takes the block and the question stays.
  world.failQuestionCapture = undefined
  await $.command.run(TIDY)
  expect(world.files.get(FILE)).not.toContain('session=a1b2c301')
  expect(world.files.get(ARCHIVE)).toContain('Publish the plan, OK?')
  expect(capturesOf(world).some(copy => copy.disposition === 'archived')).toBe(true)
  expect(ledgerRecords(world).filter(record => record.isUnresolved)).toHaveLength(1)
})

test('a block that asks is not archived when no copy of its question could be written at all', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'ended', 96, '- [x] Draft the plan\n- [?] Publish the plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.failQuestionCapture = 'write'
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  await $.command.run(TIDY)
  expect(world.files.get(FILE)).toBe(board)
  expect(world.files.has(ARCHIVE)).toBe(false)
})

test('a write another agent makes while the archive checks a question is not written over', async ($, on) => {
  const stale = block('a1b2c301', 'ended', 96, '- [x] Draft the plan\n- [?] Publish the plan, OK?')
  const other = (steps: string): string => block('a1b2c302', 'working', 1, steps)
  const world = makeWorld([[FILE, `## demo\n${stale}${other('- [~] Work')}`]])
  world.env = english
  seedAsked(world, `## demo\n${stale}${other('- [~] Work')}`)
  // Another agent adds a question to its own block just as the archive reads back its copy of the old one.
  const added = `## demo\n${stale}${other('- [~] Work\n- [?] Added while the archive ran, OK?')}`
  let isChanged = false
  world.beforeRead = path => {
    if (isChanged || !(world.files.get(path) ?? '').includes('"disposition":"archived"')) return
    isChanged = true
    world.files.set(FILE, added)
    world.mtime += 1
  }
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  expect(isChanged).toBe(true)
  // The archive started over from the new text: the old block went and the new question is still there.
  expect(world.files.get(FILE)).toContain('Added while the archive ran, OK?')
  expect(world.files.get(FILE)).not.toContain('session=a1b2c301')
  expect(world.files.get(ARCHIVE)).toContain('Publish the plan, OK?')
  expect(ledgerRecords(world).filter(record => record.isUnresolved).map(record => record.words).sort()).toEqual(['Added while the archive ran, OK?', 'Publish the plan, OK?'])
})

test('a block that comes back to work while the archive checks it stays, and its question is not marked archived', async ($, on) => {
  const asking = (state: string, hours: number): string => `## demo\n${block('a1b2c301', state, hours, '- [x] Draft the plan\n- [?] Publish the plan, OK?')}`
  const world = makeWorld([[FILE, asking('ended', 96)]])
  world.env = english
  seedAsked(world, asking('ended', 96))
  // The agent takes up its session again just as the archive reads back the copy it made for it.
  let isChanged = false
  world.beforeRead = path => {
    if (isChanged || !(world.files.get(path) ?? '').includes('"disposition":"archived"')) return
    isChanged = true
    world.files.set(FILE, asking('working', 0))
    world.mtime += 1
  }
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  await clock.advance(2000)
  expect(isChanged).toBe(true)
  // The copy is on disk, but the block is still where it was, so the question is a live one.
  expect(world.files.get(FILE)).toBe(asking('working', 0))
  expect(world.files.has(ARCHIVE)).toBe(false)
  expect(capturesOf(world).some(copy => copy.disposition === 'archived')).toBe(true)
  expect(ledgerRecords(world).filter(record => record.isArchived)).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const text = visiblePaneText(await ui.drawn())
    expect(text).toContain('Publish the plan, OK?')
    expect(text).not.toContain('Older unanswered questions')
  } finally { await ui.unmount() }
})

test('archiving a block marks only its own questions, not those of another session with the same title', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'ended', 96, '- [x] Draft\n- [?] First session question, OK?', 'Shared plan')}${block('a1b2c302', 'working', 1, '- [~] Work\n- [?] Second session question, OK?', 'Shared plan')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  seedAsked(world, board)
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  await clock.advance(2000)
  expect(world.files.get(FILE)).not.toContain('session=a1b2c301')
  expect(world.files.get(FILE)).toContain('session=a1b2c302')
  expect(capturesOf(world).filter(copy => copy.disposition === 'archived').map(copy => copy.record.words)).toEqual(['First session question, OK?'])
  expect(ledgerRecords(world).filter(record => record.isArchived).map(record => record.words)).toEqual(['First session question, OK?'])
})

test('pruning reads the files afresh, so a copy damaged on disk since the polls looked is not the newer copy', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.ran = []
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  const open = ledgerRecords(world).find(record => record.isUnresolved)!
  const current = captureFile(open, 'unresolved')
  put(world, current, world.files.get(current)!, 5_000)
  // Twenty older states of the open question's block, the newest of them (and so the one that lets the others go) read and remembered by the polls.
  const versions = Array.from({ length: 20 }, (_, version) => ({ ...open, source: { ...open.source!, data: JSON.stringify({ version }) } }))
  versions.forEach((record, version) => putCapture(world, record, 'unresolved', 1_000 + version))
  await clock.advance(2000)
  await clock.advance(2000)
  // Damaged without moving its size or time: the same number of characters, no longer what its name says.
  const newest = captureFile(versions[19]!, 'unresolved')
  const good = world.files.get(newest)!
  put(world, newest, `${good.slice(0, -2)}x\n`, 1_019)
  expect(world.files.get(newest)).toHaveLength(good.length)
  world.ran = []
  await $.command.run(TIDY)
  expect(removals(world)).toBe(0)
  expect(filesOf(world, CAPTURES)).toHaveLength(21)
  // Written whole again, it is read afresh and the five oldest go.
  put(world, newest, good, 1_019)
  await $.command.run(TIDY)
  expect(removals(world)).toBe(1)
  expect(filesOf(world, CAPTURES)).toHaveLength(16)
})

test('pruning reads the proofs afresh, so a proof damaged on disk since the polls looked stops the clean-up', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  // Twenty retirement proofs that nothing refers to, put there after the session start's sweep and read by two polls.
  const keys = putOrphans(world, 20)
  await clock.advance(2000)
  await clock.advance(2000)
  // The newest of them, damaged without moving its size or time: the same number of characters, no longer what its name says.
  const newest = proofFile('retired', keys[19]!)
  const good = world.files.get(newest)!
  put(world, newest, `${good.slice(0, -2)}x\n`, 1_019)
  expect(world.files.get(newest)).toHaveLength(good.length)
  world.ran = []
  await $.command.run(TIDY)
  expect(removals(world)).toBe(0)
  expect(filesOf(world, RETIRED)).toHaveLength(20)
  // Written whole again, it is read afresh and the four oldest go.
  put(world, newest, good, 1_019)
  await $.command.run(TIDY)
  expect(removals(world)).toBe(1)
  expect(filesOf(world, RETIRED)).toHaveLength(16)
})

test('a remembered question copy or proof is read again when its time moves or its size changes, and not otherwise', async ($, on) => {
  const record = finished(1)
  const world = makeWorld([[FILE, `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`]])
  world.env = english
  world.reads = []
  const clock = engineBeneath(on, world)
  put(world, LEDGER, questionsJson(ledgerOf(record)), 1)
  const copy = captureFile(record, 'resolved')
  const retired = proofFile('retired', record.id)
  const whole = new Map([[copy, captureJson(record, 'resolved')], [retired, questionProofJson('retired', sha256(record.id))]])
  for (const [path, text] of whole) put(world, path, text, 3)
  const timesRead = (path: string): number => (world.reads ?? []).filter(one => one === path).length
  await $.session.start(START)
  await clock.advance(2000)
  for (const [path, text] of whole) {
    const first = timesRead(path)
    expect(first).toBeGreaterThan(0)
    // Nothing moved: not read again.
    await clock.advance(2000)
    expect(timesRead(path)).toBe(first)
    // The same bytes under a new time: read once more, and then remembered.
    put(world, path, text, 50)
    await clock.advance(2000)
    expect(timesRead(path)).toBe(first + 1)
    await clock.advance(2000)
    expect(timesRead(path)).toBe(first + 1)
    // Another size under the same time: read again, and a damaged one at every look after.
    put(world, path, text.slice(0, 40), 50)
    await clock.advance(2000)
    const damaged = timesRead(path)
    expect(damaged).toBeGreaterThan(first + 1)
    await clock.advance(2000)
    expect(timesRead(path)).toBeGreaterThan(damaged)
    // Whole again for the next file.
    put(world, path, text, 60)
    await clock.advance(2000)
  }
})

test('a question copy or proof that leaves the folder is forgotten, so one that comes back with the same size and time is read again', async ($, on) => {
  const record = finished(1)
  const world = makeWorld([[FILE, `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`]])
  world.env = english
  world.reads = []
  const clock = engineBeneath(on, world)
  put(world, LEDGER, questionsJson(ledgerOf(record)), 1)
  const whole = new Map([[captureFile(record, 'resolved'), captureJson(record, 'resolved')], [proofFile('retired', record.id), questionProofJson('retired', sha256(record.id))]])
  for (const [path, text] of whole) put(world, path, text, 3)
  const timesRead = (path: string): number => (world.reads ?? []).filter(one => one === path).length
  await $.session.start(START)
  await clock.advance(2000)
  await clock.advance(2000)
  const first = new Map([...whole.keys()].map(path => [path, timesRead(path)]))
  for (const path of whole.keys()) expect(first.get(path)).toBeGreaterThan(0)
  // Gone from the folder for a poll, then back as it was.
  for (const path of whole.keys()) world.files.delete(path)
  await clock.advance(2000)
  for (const [path, text] of whole) put(world, path, text, 3)
  await clock.advance(2000)
  for (const path of whole.keys()) expect(timesRead(path)).toBe((first.get(path) ?? 0) + 1)
})

test('an inbox turn that could not be read is tried again at the next poll', async ($, on) => {
  const world = makeWorld([[FILE, `## demo\n${block('a1b2c302', 'working', 1, '- [~] Work')}`]])
  world.env = english
  const clock = engineBeneath(on, world)
  const turn = `${INBOX}/codex-turn-1760000000-1.json`
  put(world, turn, JSON.stringify({ session_id: 'synthetic-session-1', cwd: '/work/demo', prompt: 'Synthetic request', last_assistant_message: 'Synthetic work is done.' }), 1_000)
  world.unreadable = new Set([turn])
  world.reads = []
  await $.session.start(START)
  await clock.advance(2000)
  expect(world.reads).toContain(turn)
  // The listing and the taken turns are as they were; only a read that failed is not remembered.
  world.unreadable = undefined
  world.reads = []
  await clock.advance(2000)
  expect(world.reads).toContain(turn)
})

test('nothing is removed while the ledger cannot be read, and the files go once it can', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  putOrphans(world, 20)
  await clock.advance(2000)
  await clock.advance(2000)
  const ledger = world.files.get(LEDGER)!
  // The ledger is cut off just as the clean-up starts reading its files.
  let isArmed = true
  world.beforeRead = path => {
    if (!isArmed || !path.includes(RETIRED)) return
    isArmed = false
    world.files.set(LEDGER, '{"version":1,"records":[')
  }
  world.ran = []
  await $.command.run(TIDY)
  expect(isArmed).toBe(false)
  expect(removals(world)).toBe(0)
  expect(filesOf(world, RETIRED)).toHaveLength(20)
  world.beforeRead = undefined
  put(world, LEDGER, ledger, 5_000)
  await $.command.run(TIDY)
  expect(removals(world)).toBe(1)
  expect(filesOf(world, RETIRED)).toHaveLength(16)
})

test('nothing is removed while the acknowledgement list cannot be read, and the files go once it can', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  putOrphans(world, 20)
  await clock.advance(2000)
  await clock.advance(2000)
  // The list is cut off, as a write caught half-way, just as the clean-up starts reading its files.
  let isArmed = true
  world.beforeRead = path => {
    if (!isArmed || !path.includes(RETIRED)) return
    isArmed = false
    world.files.set(ANSWERED, '{')
  }
  world.ran = []
  await $.command.run(TIDY)
  expect(isArmed).toBe(false)
  expect(removals(world)).toBe(0)
  expect(filesOf(world, RETIRED)).toHaveLength(20)
  world.beforeRead = undefined
  world.files.delete(ANSWERED)
  await $.command.run(TIDY)
  expect(removals(world)).toBe(1)
  expect(filesOf(world, RETIRED)).toHaveLength(16)
})

test('nothing is removed while a retirement proof is still being written, and the files go once it is', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  putOrphans(world, 20)
  await clock.advance(2000)
  await clock.advance(2000)
  // The question is answered in the file, which retires it, but its proof cannot be written yet.
  const open = ledgerRecords(world).find(record => record.isUnresolved)!
  const proof = proofFile('retired', open.id)
  world.unwritable = new Set([proof])
  world.files.set(FILE, `## demo\n${block('a1b2c301', 'waiting', 1, '- [x] Publish the first plan, OK?')}`)
  world.mtime += 1
  await clock.advance(2000)
  expect(world.files.has(proof)).toBe(false)
  world.ran = []
  await $.command.run(TIDY)
  expect(removals(world)).toBe(0)
  expect(filesOf(world, RETIRED)).toHaveLength(20)
  // Writable again, the next poll keeps the proof and the clean-up goes ahead.
  world.unwritable = undefined
  await clock.advance(2000)
  expect(world.files.has(proof)).toBe(true)
  await $.command.run(TIDY)
  expect(removals(world)).toBe(1)
  // The new proof is older than the piled ones by its time but the ledger still holds its question, so it stays with them.
  expect(filesOf(world, RETIRED)).toHaveLength(17)
  expect(world.files.has(proof)).toBe(true)
})

test('nothing is removed when the ledger changes between the choice and the removal, and the files go at the next tidy', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  putOrphans(world, 20)
  await clock.advance(2000)
  await clock.advance(2000)
  // Another session writes the ledger after the clean-up read it (it reads the acknowledgement list next).
  let isArmed = false
  world.beforeRead = path => {
    if (path.includes(RETIRED)) isArmed = true
    if (!isArmed || path !== ANSWERED) return
    isArmed = false
    world.files.set(LEDGER, `${world.files.get(LEDGER)}\n`)
  }
  world.ran = []
  await $.command.run(TIDY)
  expect(removals(world)).toBe(0)
  expect(filesOf(world, RETIRED)).toHaveLength(20)
  world.beforeRead = undefined
  await $.command.run(TIDY)
  expect(removals(world)).toBe(1)
  expect(filesOf(world, RETIRED)).toHaveLength(16)
})

test('an hour with nothing over the floor of 16 reads no question copy or proof', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  // Exactly 16 proofs of each kind, and one copy of the open question.
  putOrphans(world, 16)
  for (let n = 0; n < 16; n++) putProof(world, 'consumed', `old acknowledgement ${n}`, 1_000 + n)
  await clock.advance(2000)
  await clock.advance(2000)
  world.reads = []
  world.ran = []
  await $.command.run(TIDY)
  expect(world.reads.filter(path => path.includes(CAPTURES) || path.includes(RETIRED) || path.includes(CONSUMED))).toEqual([])
  expect(removals(world)).toBe(0)
})

test('one sweep removes at most 200 files, fifty to a process, and the next sweep takes the rest', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  putOrphans(world, 260)
  await clock.advance(2000)
  await clock.advance(2000)
  world.ran = []
  await $.command.run(TIDY)
  // 244 are over the newest 16, and the sweep takes 200 of them.
  expect(removedPerProcess(world)).toEqual([50, 50, 50, 50])
  expect(filesOf(world, RETIRED)).toHaveLength(60)
  world.ran = []
  await $.command.run(TIDY)
  expect(removedPerProcess(world)).toEqual([44])
  expect(filesOf(world, RETIRED)).toHaveLength(16)
})

test('a working or waiting block that asks stays however old, while an ended one that asks is archived', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'ended', 96, '- [x] Draft\n- [?] Ended question, OK?')}${block('a1b2c302', 'waiting', 96, '- [?] Waiting question, OK?')}${block('a1b2c303', 'working', 24 * 40, '- [~] Work\n- [?] Working question, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  seedAsked(world, board)
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  await $.command.run(TIDY)
  const text = world.files.get(FILE) ?? ''
  expect(text).not.toContain('session=a1b2c301')
  expect(text).toContain('session=a1b2c302')
  expect(text).toContain('session=a1b2c303')
  const archive = world.files.get(ARCHIVE) ?? ''
  expect(archive).toContain('Ended question, OK?')
  expect(archive).not.toContain('Waiting question')
  expect(archive).not.toContain('Working question')
  // Only the ended block's question has a copy made for the archive; the others are live questions with their blocks on the board.
  expect(capturesOf(world).filter(copy => copy.disposition === 'archived').map(copy => copy.record.words)).toEqual(['Ended question, OK?'])
  expect(ledgerRecords(world).filter(record => record.isArchived).map(record => record.words)).toEqual(['Ended question, OK?'])
  expect(ledgerRecords(world).filter(record => record.isUnresolved)).toHaveLength(3)
})

test('a board that changes on every try still has its finished blocks archived, and the block that asks waits for the next sweep', async ($, on) => {
  const boardAt = (hours: number): string => `## demo\n${block('a1b2c301', 'ended', hours, '- [x] Draft\n- [?] Publish the plan, OK?')}${block('a1b2c302', 'done', 5, '- [x] Finished')}`
  const world = makeWorld([[FILE, boardAt(48)]])
  world.env = english
  seedAsked(world, boardAt(48))
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  await clock.advance(2000)
  // The block that asks has been quiet for 96 hours now, and another agent writes progress.md just as each try of
  // the sweep has settled the questions: every try that checks a block that asks finds the text changed.
  world.files.set(FILE, boardAt(96))
  world.mtime += 1
  let edits = 0
  let isReady = false
  world.beforeRead = path => {
    // Once for each try: the list of hidden questions is read twice in the same settling.
    if (path === FILE) isReady = true
    if (path !== ANSWERED || !isReady) return
    isReady = false
    edits += 1
    world.files.set(FILE, `${world.files.get(FILE)}\n`)
    world.mtime += 1
  }
  await $.command.run(TIDY)
  // The third try leaves the block that asks where it is and goes ahead with the rest.
  expect(world.files.get(ARCHIVE)).toContain('Finished')
  expect(world.files.get(FILE)).not.toContain('session=a1b2c302')
  expect(world.files.get(FILE)).toContain('session=a1b2c301')
  expect(world.files.get(ARCHIVE)).not.toContain('Publish the plan, OK?')
  // Only the first two tries checked the questions, so only they saw the board change.
  expect(edits).toBe(2)
  // A quiet sweep after that takes it, its question kept.
  world.beforeRead = undefined
  await $.command.run(TIDY)
  expect(world.files.get(FILE)).not.toContain('session=a1b2c301')
  expect(world.files.get(ARCHIVE)).toContain('Publish the plan, OK?')
  expect(ledgerRecords(world).filter(record => record.isUnresolved).map(record => record.words)).toEqual(['Publish the plan, OK?'])
})

test("the person's Archive of a block that asks starts again from the text when another agent writes while its question is kept", async ($, on) => {
  const stale = block('a1b2c301', 'ended', 10, '- [x] Draft the plan\n- [?] Publish the plan, OK?')
  const other = (steps: string): string => block('a1b2c302', 'working', 1, steps)
  const board = `## demo\n${stale}${other('- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.store = { ...world.store, opened: ['stopped'] }
  seedAsked(world, board)
  // Another agent adds a question to its own block just as the copy of the old one is read back.
  const added = `## demo\n${stale}${other('- [~] Work\n- [?] Added while the archive ran, OK?')}`
  let isChanged = false
  world.beforeRead = path => {
    if (isChanged || !(world.files.get(path) ?? '').includes('"disposition":"archived"')) return
    isChanged = true
    world.files.set(FILE, added)
    world.mtime += 1
  }
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    await ui.press({ key: 'demo::Synthetic plan a1b2c301' })
    await ui.press({ key: 'demo::Synthetic plan a1b2c301::archive' })
    await clock.advance(2000)
  } finally { await ui.unmount() }
  expect(isChanged).toBe(true)
  // Started over from the new text: the old block went and the new question is still there.
  expect(world.files.get(FILE)).toContain('Added while the archive ran, OK?')
  expect(world.files.get(FILE)).not.toContain('session=a1b2c301')
  expect(world.files.get(ARCHIVE)).toContain('Publish the plan, OK?')
})

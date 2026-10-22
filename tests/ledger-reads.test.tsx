import { expect, test } from 'claude-code/testing'
import { parseProgress } from '../hooks/parse'
import { captureJson, capturePath, emptyQuestions, observeQuestions, parseCapture, parseQuestions, questionProofJson, questionProofPath, questionsJson, questionsPath } from '../hooks/questions'
import type { QuestionCapture } from '../hooks/questions'
import { sha256 } from '../hooks/sha256'
import { finished, ledgerOf, reopened } from './fixtures/question-files'
import { engineBeneath, FILE, INBOX, makeWorld, PANE, PROPS, visiblePaneText } from './fixtures/pane-world'
import type { World } from './fixtures/pane-world'

// The files the pane keeps beside progress.md for its questions (#156), and the automatic archive
// of a block that still asks (#174), against the mock engine. All data is made up.
const english = { HOME: '/home/me', LANG: 'en_US.UTF-8' }
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const HOUR = 3_600_000
const LEDGER = questionsPath(FILE)
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
  await $.session.start(START)
  // The first looks read everything once; the poll after that finds nothing changed.
  await clock.advance(2000)
  world.reads = []
  await clock.advance(2000)
  expect(world.reads.length).toBeLessThanOrEqual(6)
  expect(world.reads.filter(path => path.includes(CAPTURES) || path.includes(RETIRED) || path.includes(CONSUMED) || path.startsWith(INBOX))).toEqual([])
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

import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { localDay } from '../hooks/journal'
import { paletteFor } from '../hooks/palette'
import { parseProgress } from '../hooks/parse'
import { captureJson, capturePath, emptyQuestions, observeQuestions, parseCapture, parseQuestions, questionProofJson, questionProofPath, questionsJson, questionsPath, resolveQuestion } from '../hooks/questions'
import type { QuestionCapture } from '../hooks/questions'
import { sha256 } from '../hooks/sha256'
import { STRINGS } from '../hooks/strings'
import { answeredPath } from '../hooks/view'
import { EN } from '../hooks/strings-en'
import { finished, ledgerOf, reopened } from './fixtures/question-files'
import { engineBeneath, FILE, INBOX, makeWorld, PANE, PROPS, visiblePaneText } from './fixtures/pane-world'
import type { World } from './fixtures/pane-world'
import { BLOCKS, IDLE_POLL_FILE_OPS, LEDGER_RECORDS, LIVE_SESSIONS } from './e2e/lib/budget'

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

test('an idle poll reads no file with piles of captures, proofs and inbox turns waiting', async ($, on) => {
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
  world.fileOps = []
  await clock.advance(2000)
  // The poll ran and looked at progress.md, but with nothing changed it read no file at all,
  // whatever the piles beside it: neither progress.md nor the ledger, captures, proofs or inbox.
  expect(world.fileOps).toContain(`stat ${FILE}`)
  expect(world.reads).toEqual([])
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

test('on Windows question-file pruning continues through later batches after an already removed file returns exit code 1', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = { ...english, OS: 'Windows_NT' }
  world.ran = []
  world.missingRemoveExitCode = 1
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  const keys = putOrphans(world, 136)
  const first = proofFile('retired', keys[0]!)
  const gone = proofFile('retired', keys[1]!)
  let isRaced = false
  world.isRemoveRefused = path => {
    if (path === first) {
      world.files.delete(gone)
      isRaced = true
    }
    return false
  }
  world.ran = []
  await $.command.run(TIDY)
  expect(isRaced).toBe(true)
  const removals = world.ran.filter(argv => argv[0] === 'powershell' && (argv[3] ?? '').startsWith('Remove-Item'))
  expect(removals).toHaveLength(3)
  for (const argv of removals) expect(argv[3]).toContain('; exit 0')
  for (const key of keys.slice(0, 120)) expect(world.files.has(proofFile('retired', key))).toBe(false)
  for (const key of keys.slice(120)) expect(world.files.has(proofFile('retired', key))).toBe(true)
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

// A session id for block `n`, eight hex characters.
const sessionOf = (n: number): string => (0xa0000000 + n).toString(16)

test('L4 D24 scale: the pane does at most 6 file operations per idle poll', { timeoutMs: 30_000 }, async ($, on) => {
  // D24's scale, all made up: 300 blocks in ten projects, 100 of them live sessions (two in three
  // asking the person), a ledger of 1,000 questions with their copies and proofs, and thirty
  // turns other agents left in the inbox.
  const blocks = Array.from({ length: BLOCKS }, (_, n) => n < LIVE_SESSIONS
    ? block(sessionOf(n), n % 3 === 2 ? 'working' : 'waiting', 1, n % 3 === 2 ? '- [~] Check routes' : `- [?] Publish report ${n}, OK?`)
    : block(sessionOf(n), n % 2 === 0 ? 'done' : 'ended', 1, n % 2 === 0 ? '- [x] Check routes\n- [x] Publish the report' : '- [x] Check routes\n- [ ] Publish the report'))
  const board = Array.from({ length: 10 }, (_, p) => `## project-${p}\n${blocks.slice(p * 30, p * 30 + 30).join('')}`).join('\n')
  const world = makeWorld([[FILE, board]])
  world.env = english
  seedAsked(world, board)
  const asked = ledgerRecords(world)
  const answered = Array.from({ length: LEDGER_RECORDS - asked.length }, (_, n) => finished(n + 1))
  put(world, LEDGER, questionsJson({ ...ledgerOf(...asked, ...answered), next: 2 * LEDGER_RECORDS }), 1)
  answered.forEach((record, n) => {
    putProof(world, 'retired', record.id, 10 + n)
    if (n < 100) putCapture(world, record, 'resolved', 10 + n)
  })
  for (let n = 0; n < 30; n++) put(world, `${INBOX}/codex-turn-${1_760_000_000 + n}-1.json`, JSON.stringify({ session_id: `synthetic-session-${n}`, cwd: '/work/demo', prompt: 'Synthetic request', last_assistant_message: 'Synthetic work is done.' }), 1_000 + n)
  expect(ledgerRecords(world)).toHaveLength(LEDGER_RECORDS)
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  // The first polls read everything once, the start's archive and sweeps run, and a pass after
  // the pane's own writes finds nothing more to do.
  for (let n = 0; n < 6; n++) await clock.advance(2000)
  world.fileOps = []
  world.ran = []
  // From the 12th second to the 14th only the 2 s poll runs: the inbox look comes every 5 s.
  await clock.advance(2000)
  // The poll ran: it looked at progress.md and listed the folder beside it.
  expect(world.fileOps).toContain(`stat ${FILE}`)
  expect(world.fileOps).toContain(`list ${FILE.replace(/\/[^/]*$/, '')}`)
  expect(world.fileOps.length).toBeLessThanOrEqual(IDLE_POLL_FILE_OPS)
  expect(world.fileOps.filter(op => op.startsWith('read ') || op.startsWith('write '))).toEqual([])
  expect(world.ran).toEqual([])
})

test('an idle poll reads the questions again once another session changes the ledger, and not before', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  world.reads = []
  await clock.advance(2000)
  await clock.advance(2000)
  expect(world.reads).not.toContain(LEDGER)
  // Another session writes the same ledger again: its time moves, so it is read.
  put(world, LEDGER, world.files.get(LEDGER)!, 5)
  await clock.advance(2000)
  expect(world.reads).toContain(LEDGER)
})

test('idle polls run no question pass while only this session\'s background jobs change its list', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  on('tool.call', { tool: 'SyntheticBackground' }, () => ({ result: 'Synthetic job started' }))
  await $.session.start(START)
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  const board0 = world.files.get(FILE)
  const jobs = (): unknown => Object.entries(world.store ?? {}).find(([key]) => key.startsWith('mirror:'))?.[1]
  // Before each poll a background job starts: this session's list changes (its job count and
  // ids) and no file does. None of that is a question, so no poll has anything to pass again.
  const passed: boolean[] = []
  for (let n = 0; n < 5; n++) {
    await $.tool.call({ tool: 'SyntheticBackground', tool_use_id: `synthetic-job-${n}`, run_in_background: true })
    world.reads = []
    await clock.advance(2000)
    passed.push(world.reads.includes(LEDGER))
  }
  expect(jobs()).toMatchObject({ backgroundJobs: 5 })
  expect(world.files.get(FILE)).toBe(board0)
  expect(passed).toEqual([false, false, false, false, false])
})

test('a question file written within the last poll is read again at the next poll, whatever its time and size say', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  // Written half a second before the poll at the 8th second.
  put(world, LEDGER, world.files.get(LEDGER)!, NOW + 7_500)
  const ledgerReads = (): number => (world.reads ?? []).filter(path => path === LEDGER).length
  world.reads = []
  await clock.advance(2000)
  expect(ledgerReads()).toBeGreaterThan(0)
  // Too fresh to be taken as unchanged at the 8th second, so the 10th reads it again; the 12th does not.
  world.reads = []
  await clock.advance(2000)
  expect(ledgerReads()).toBeGreaterThan(0)
  world.reads = []
  await clock.advance(2000)
  expect(ledgerReads()).toBe(0)
})

test('a question file whose read never answers does not keep the line under the prompt from being drawn', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  // With the pane closed, the line under the prompt holds the board's counts.
  world.store = { ...world.store, closedByPerson: true }
  const clock = engineBeneath(on, world)
  const status: Array<string | undefined> = []
  on('ui.status', ($, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  await $.session.start(START)
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  const before = status.at(-1)
  expect(before).toBeDefined()
  world.holdRead = path => (path === LEDGER ? new Promise(() => undefined) : undefined)
  world.files.set(FILE, `${board}${block('a1b2c302', 'waiting', 1, '- [?] Publish the second plan, OK?')}`)
  world.mtime += 1
  // The poll that sees the change waits one poll for the question pass, then draws without it.
  await clock.advance(2000)
  await clock.advance(2000)
  expect(status.at(-1)).not.toBe(before)
})

test('a poll held by a read of progress.md gives way to a new one after 15 seconds, and what the held read brings back late is dropped', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  let release = (): void => undefined
  const held = new Promise<void>(resolve => { release = resolve })
  world.holdRead = path => (path === FILE ? held : undefined)
  world.files.set(FILE, `${board}${block('a1b2c302', 'working', 1, '- [~] Held work')}`)
  world.mtime += 1
  await clock.advance(2000)
  // The drive answers again and the file changes once more, while the first read is still held.
  world.holdRead = undefined
  world.files.set(FILE, `${board}${block('a1b2c302', 'working', 1, '- [~] Held work')}${block('a1b2c303', 'working', 1, '- [~] Later work')}`)
  world.mtime += 1
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    // The pane counts the work in progress: one session before the later read, three after it.
    await clock.advance(10_000)
    expect(visiblePaneText(await ui.drawn())).toMatch(/▸\s+1\s+in progress/)
    await clock.advance(6_000)
    expect(visiblePaneText(await ui.drawn())).toMatch(/▸\s+3\s+in progress/)
    // The held read answers with the two sessions it was asked about; the pane keeps three.
    release()
    await clock.advance(1)
    expect(visiblePaneText(await ui.drawn())).toMatch(/▸\s+3\s+in progress/)
  } finally { await ui.unmount() }
})

for (const hasSavedQuestion of [false, true]) test(`a first read of progress.md that never answers at session start still lets the 2-second poll take over after 15 seconds ${hasSavedQuestion ? 'with a saved pending question too' : 'with an empty store'}`, { timeoutMs: 30_000 }, async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const pending = { id: 'a1b2c301', agent: 'codex', project: 'demo', text: 'Ship the shelf, OK?', isQuestion: true, at: NOW - 60_000, sourceRevisions: ['f'.repeat(64)] }
  const key = `pendingInboxQuestion:${sha256(FILE)}:${sha256(JSON.stringify([pending.id, pending.sourceRevisions]))}`
  if (hasSavedQuestion) world.store = { ...world.store, [key]: pending }
  const clock = engineBeneath(on, world)
  const reached: Array<() => void> = []
  const readings = Array.from({ length: hasSavedQuestion ? 2 : 1 }, () => new Promise<void>(resolve => { reached.push(resolve) }))
  const held: Array<() => void> = []
  world.holdRead = path => {
    if (path !== FILE) return undefined
    reached[held.length]?.()
    return new Promise<void>(resolve => { held.push(resolve) })
  }
  // The first poll reads progress.md and, with a saved pending question, so does its restore: both reads stay held.
  const started = $.session.start(START)
  for (const reading of readings) {
    await reading
    await clock.advance(15_001)
  }
  await started
  // The timers run while every read of progress.md is still held: a 2-second poll takes the held one's place.
  world.fileOps = []
  await clock.advance(2_000)
  expect(world.fileOps).toContain(`stat ${FILE}`)
  // Once the reads answer, the pane shows a change made since.
  world.holdRead = undefined
  for (const release of held) release()
  world.files.set(FILE, `${board}${block('a1b2c302', 'working', 1, '- [~] Later work')}`)
  world.mtime += 1
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    await clock.advance(2000)
    expect(visiblePaneText(await ui.drawn())).toMatch(/▸\s+2\s+in progress/)
  } finally { await ui.unmount() }
})

test('a write made while a poll is held still lands, without waiting on the held read', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  // The answered list changes and its read never answers, so each poll from now on is held.
  const answered = FILE.replace(/\.md$/, '-answered.json')
  put(world, answered, '{}\n', NOW + 6_000)
  world.holdRead = path => (path === answered ? new Promise(() => undefined) : undefined)
  const add = (title: string) => $.command.run({ ...TIDY, args: `add demo: ${title}` })
  // Each add comes when the held poll is past 15 seconds and before the 2 s timer looks again, so
  // only the add's own poll could take the held one's place.
  await clock.advance(2000)
  await clock.advance(14_000)
  await clock.advance(1_500)
  await add('Synthetic quick task')
  await clock.advance(500)
  await clock.advance(14_000)
  await clock.advance(1_500)
  await add('Synthetic second quick task')
  expect(world.files.get(FILE)).toContain('Synthetic quick task')
  expect(world.files.get(FILE)).toContain('Synthetic second quick task')
})

test('a poll held for a minute leaves at most two reads of the held file waiting', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  const answered = FILE.replace(/\.md$/, '-answered.json')
  put(world, answered, '{}\n', NOW + 6_000)
  world.holdRead = path => (path === answered ? new Promise(() => undefined) : undefined)
  world.reads = []
  for (let n = 0; n < 30; n++) await clock.advance(2000)
  // The held poll and the one that took its place; no third while both are held.
  expect(world.reads.filter(path => path === answered)).toHaveLength(2)
})

test('a poll whose reads of progress.md hang for a minute starts at most two polls while the 2-second timer ticks', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  const held: Array<() => void> = []
  world.holdRead = path => (path === FILE ? new Promise<void>(resolve => { held.push(resolve) }) : undefined)
  world.files.set(FILE, `${board}${block('a1b2c302', 'working', 1, '- [~] Later work')}`)
  world.mtime += 1
  world.reads = []
  for (let n = 0; n < 30; n++) await clock.advance(2000)
  // The held poll and the one that took its place: no third starts while the first is still held.
  expect(world.reads.filter(path => path === FILE)).toHaveLength(2)
  world.holdRead = undefined
  for (const release of held) release()
})

test('a question pass held for a minute leaves one read of the ledger waiting', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  // Another session writes the ledger again, so the next pass reads it, and that read is held.
  put(world, LEDGER, world.files.get(LEDGER)!, NOW)
  world.holdRead = path => (path === LEDGER ? new Promise(() => undefined) : undefined)
  world.reads = []
  for (let n = 0; n < 30; n++) await clock.advance(2000)
  expect(world.reads.filter(path => path === LEDGER)).toHaveLength(1)
})

test('an inbox drain held on the ledger for a minute releases the write queue within 16 seconds and records its saved question once', { timeoutMs: 30_000 }, async ($, on) => {
  const world = makeWorld([[FILE, `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`]])
  world.env = english
  world.hasTasks = true
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {} }
  world.reply = prompt => prompt.includes('TITLE:') ? 'TITLE: Add the limiter\nDONE: Added the middleware\nNEXT: Write the tests\nASK: Keep the limiter, OK?' : undefined
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  let isArmed = false
  let inFlight = 0
  let maxInFlight = 0
  let release = (): void => undefined
  world.beforeStoreSet = key => { if (key.startsWith('pendingInboxQuestion:')) isArmed = true }
  world.holdRead = path => {
    if (path !== LEDGER || !isArmed) return undefined
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    return new Promise<void>(resolve => {
      release = () => { isArmed = false; inFlight -= 1; resolve() }
    })
  }
  put(world, `${INBOX}/codex-turn-1760600000-1.json`, JSON.stringify({ session_id: 'synthetic-drain-question', cwd: '/work/api-gateway', last_assistant_message: 'Synthetic work is done. Keep the limiter, OK?' }), NOW)
  await clock.advance(4000)
  expect(inFlight).toBe(1)
  let hasWritten = false
  const writing = $.command.run({ ...TIDY, args: 'add demo: Synthetic write after the drain' }).then(() => { hasWritten = true })
  try {
    for (let n = 0; n < 8; n++) await clock.advance(2000)
    expect(world.files.get(FILE)).toContain('Synthetic write after the drain')
    expect(hasWritten).toBe(true)
    expect(Object.keys(world.store).some(key => key.startsWith('pendingInboxQuestion:'))).toBe(true)
    expect(inFlight).toBe(1)
    expect(maxInFlight).toBe(1)
    for (let n = 0; n < 22; n++) await clock.advance(2000)
    world.holdRead = undefined
    release()
  } finally {
    world.holdRead = undefined
    if (inFlight > 0) release()
    await clock.advance(2000)
    await writing
  }
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  expect(ledgerRecords(world).filter(record => record.words === 'Keep the limiter, OK?')).toHaveLength(1)
  expect(Object.keys(world.store).some(key => key.startsWith('pendingInboxQuestion:'))).toBe(false)
  expect(maxInFlight).toBe(1)
})

test('a ledger read held for a minute shows the question-list error after 15 seconds and a successful pass clears it', { timeoutMs: 30_000 }, async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {} }
  const clock = engineBeneath(on, world)
  await $.session.start({ ...START, surface: 'desktop' })
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  let release = (): void => undefined
  let reads = 0
  world.holdRead = path => {
    if (path !== LEDGER) return undefined
    reads += 1
    return new Promise<void>(resolve => {
      release = resolve
    })
  }
  put(world, LEDGER, world.files.get(LEDGER)!, NOW)
  try {
    await clock.advance(2000)
    expect(reads).toBe(1)
    await clock.advance(14_000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeUndefined()
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeDefined()
    for (let n = 0; n < 22; n++) await clock.advance(2000)
    expect(reads).toBe(1)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeDefined()
    await clock.advance(1000)
    world.holdRead = undefined
    release()
    await clock.advance(2000)
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeUndefined()
  } finally {
    world.holdRead = undefined
    release()
    await clock.advance(2000)
    await ui.unmount()
  }
})

test('a caller waiting behind two successive ten-second question passes gives up within 15 seconds in total', async ($, on) => {
  const world = makeWorld([[FILE, `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?', 'Add a shelf')}`]])
  world.env = english
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {}, opened: ['waiting'] }
  let isArmed = false
  let held = 0
  let reached!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  const releases: Array<() => void> = []
  // The cache is written at the end of each pass, so only the next pass's first read is held.
  on('state.set', { plugin: 'agent-board', key: 'questionLedger' }, ($, e, next) => {
    if (held === 1) isArmed = true
    return next(e)
  })
  const clock = engineBeneath(on, world)
  await $.session.start({ ...START, surface: 'desktop' })
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  isArmed = true
  world.holdRead = path => {
    if (path !== LEDGER || !isArmed || held >= 2) return undefined
    isArmed = false
    held += 1
    reached()
    return new Promise<void>(resolve => { releases.push(resolve) })
  }
  const key = 'demo::Add a shelf::0::hide'
  const first = ui.press({ key })
  await entered
  const second = ui.press({ key })
  await clock.advance(1)
  let hasFinished = false
  const waiting = ui.press({ key }).then(() => { hasFinished = true })
  try {
    await clock.advance(9999)
    releases[0]!()
    await clock.advance(1)
    expect(held).toBe(2)
    // A second past the third press's 15-second deadline; with a deadline per pass it waits to 25.
    await clock.advance(6000)
    expect(hasFinished).toBe(true)
    expect(await ui.find({ type: 'Text', text: EN.pressLedgerFailed })).toBeDefined()
  } finally {
    await clock.advance(5000)
    world.holdRead = undefined
    for (const release of releases) release()
    await clock.advance(2000)
    await Promise.all([first, second, waiting])
    await ui.unmount()
  }
})

test('board reads that hang for a minute leave one question pass at a time while the 2-second timer ticks, and an inbox question is recorded within seconds once they answer', { timeoutMs: 30_000 }, async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.hasTasks = true
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {} }
  world.reply = prompt => prompt.includes('TITLE:') ? 'TITLE: Add the limiter\nDONE: Added the middleware\nNEXT: Write the tests\nASK: Keep the limiter, OK?' : undefined
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  put(world, LEDGER, world.files.get(LEDGER)!, NOW)
  const held: Array<() => void> = []
  let inFlight = 0
  let maxInFlight = 0
  world.written = []
  world.holdRead = path => {
    if (path !== LEDGER) return undefined
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    return new Promise<void>(resolve => {
      held.push(() => {
        inFlight -= 1
        resolve()
      })
    })
  }
  const inbox = `${INBOX}/codex-turn-1760600000-1.json`
  put(world, inbox, JSON.stringify({ session_id: 'synthetic-question', cwd: '/work/api-gateway', last_assistant_message: 'Synthetic work is done. Keep the limiter, OK?' }), NOW)
  try {
    for (let n = 0; n < 30; n++) await clock.advance(2000)
    expect(maxInFlight).toBe(1)
    // The drain took the turn while the pass was held: its question waits saved, not recorded.
    expect(Object.keys(world.store).some(key => key.startsWith('pendingInboxQuestion:'))).toBe(true)
  } finally {
    world.holdRead = undefined
    for (const release of held) release()
  }
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  // If the drain has not taken the file yet, allow its next five-second inbox interval too.
  if (world.files.has(inbox)) await clock.advance(5000)
  expect(world.files.has(inbox)).toBe(false)
  expect(ledgerRecords(world).some(record => record.words.includes('Keep the limiter'))).toBe(true)
  expect(Object.keys(world.store).some(key => key.startsWith('pendingInboxQuestion:'))).toBe(false)
  expect(maxInFlight).toBe(1)
  const captureWrites = world.written.filter(path => path.includes(CAPTURES))
  expect(captureWrites.length).toBeGreaterThan(0)
  expect(new Set(captureWrites).size).toBe(captureWrites.length)
})

// The live board that showed the red line: no ledger yet, two torn ledgers from days ago, and a
// block cut off in the middle of the file (no end marker, more sections after it).
test('a board with no ledger, two torn ledgers days old and a block cut off in the middle folds the cut-off notice under Board health, with no error or retry', async ($, on) => {
  const cut = '<!-- auto session=55fb44cb agent=codex state=waiting updated=2026-10-15T01:17:08.128Z source=turns -->'
  const day = localDay(Date.parse('2026-10-15T01:17:08.128Z')).slice(5)
  const board = `# Progress\n\n## demo-152\n\n${cut}\n### Add a shelf\n> waiting on your repl\n\n## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.hasTasks = true
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {} }
  world.reply = prompt => prompt.includes('TITLE:') ? 'TITLE: Add the limiter\nDONE: Added the middleware\nNEXT: Write the tests\nASK: Keep the limiter, OK?' : undefined
  put(world, `${INBOX}/codex-turn-1760600000-1.json`, JSON.stringify({ session_id: 'synthetic-question', cwd: '/work/api-gateway', last_assistant_message: 'Synthetic work is done. Keep the limiter, OK?' }), 1_000)
  const torn = [3, 3.1].map(days => `${LEDGER}.torn-${NOW - days * 24 * HOUR}-synthetic-session`)
  torn.forEach(path => put(world, path, '{"version":1,"rec', NOW - 3 * 24 * HOUR))
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  const seen = new Set<string>()
  // More polls than the 15 races that would raise the question list's problem line.
  for (let n = 0; n < 20; n += 1) {
    await clock.advance(2000)
    if (await ui.find({ type: 'Text', text: EN.questionsUnreadable() }) !== undefined) seen.add('unreadable')
    if (await ui.find({ type: 'Text', text: EN.inboxQuestionNotKept }) !== undefined) seen.add('notKept')
  }
  expect([...seen]).toEqual([])
  const notice = EN.blockCutOff('Codex', day)
  expect(await ui.find({ type: 'Button', key: 'section::health' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: notice })).toBeUndefined()
  await ui.press({ key: 'section::health' })
  expect(await ui.find({ type: 'Text', text: notice })).toBeDefined()
  expect((world.files.get(FILE.replace('.md', '.html')) ?? '').split(notice).length - 1).toBe(1)
  // The ledger is written, with the board's question and the inbox turn's, and the torn ledgers,
  // three days old, stay for the sweep.
  const words = ledgerRecords(world).map(record => record.words)
  expect(words).toContain('Publish the first plan, OK?')
  expect(words).toContain('Keep the limiter, OK?')
  expect(torn.filter(path => world.files.has(path))).toEqual(torn)
  expect(world.files.get(FILE)?.startsWith(board.slice(0, board.indexOf('## demo\n')))).toBe(true)
  await ui.unmount()
})

test('a progress.md with a mid-file cut-off block writes the ledger and shows no error line', async ($, on) => {
  const cut = '<!-- auto session=55fb44cb agent=codex state=waiting updated=2026-10-15T01:17:08.128Z source=turns -->'
  const board = `# Progress\n\n## demo-152\n\n${cut}\n### Add a shelf\n> waiting on your repl\n\n## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}\n${block('9a9a9a9a', 'done', 2, '- [x] Finished step', 'A finished plan')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.hasTasks = true
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {} }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    expect(world.files.has(LEDGER)).toBe(true)
    expect(ledgerRecords(world).map(record => record.words)).toContain('Publish the first plan, OK?')
    const alertTexts = (await ui.findAll({ type: 'Text' })).filter(node => node.props.color === paletteFor('dark').alert)
    expect(alertTexts).toEqual([])
    const hideBtn = (await ui.findAll({ type: 'Button' })).find(node => node.key?.endsWith('::hide'))
    expect(hideBtn?.key).toBeDefined()
    await ui.press({ key: hideBtn!.key! })
    expect(ledgerRecords(world).find(record => record.words === 'Publish the first plan, OK?')?.resolvedAt).not.toBeNull()
    await ui.press({ key: 'section::recent' })
    await ui.press({ key: 'archive' })
    expect(world.files.get(ARCHIVE) ?? '').toContain('A finished plan')
    expect(world.files.get(FILE) ?? '').not.toContain('A finished plan')
    expect(world.files.get(FILE) ?? '').toContain('Add a shelf')
  } finally {
    await ui.unmount()
  }
})

test('a pending inbox question stays stored when its block is cut between the drain and the pass, and is recorded once when whole', async ($, on) => {
  const whole = `## demo\n${block('55fb44cb', 'working', 0, '- [~] Work', 'Add a shelf')}\n## later\n${block('a1b2c301', 'working', 0, '- [~] Work')}`
  const cut = whole.replace('<!-- /auto session=55fb44cb -->', '')
  const world = makeWorld([[FILE, whole]])
  world.env = english
  const pending = { id: '55fb44cb', agent: 'codex', project: 'demo', text: 'Ship the shelf, OK?', isQuestion: true, at: NOW - 60_000, sourceRevisions: ['f'.repeat(64)] }
  const key = `pendingInboxQuestion:${sha256(FILE)}:${sha256(JSON.stringify([pending.id, pending.sourceRevisions]))}`
  let isRestoring = false
  let reads = 0
  const discarded: string[] = []
  world.store = new Proxy({ lang: 'en', autoConnectOff: true, inboxDone: {}, [key]: pending }, {
    deleteProperty: (target, one) => {
      discarded.push(String(one))
      return Reflect.deleteProperty(target, one)
    },
  })
  world.beforeStoreGet = one => { if (one === key) isRestoring = true }
  world.beforeRead = path => {
    if (path !== FILE || !isRestoring) return
    reads += 1
    if (reads === 2) world.files.set(FILE, cut)
  }
  const clock = engineBeneath(on, world)
  let hasPassed = false
  on('state.set', { plugin: 'agent-board', key: 'questionLedger' }, ($, e, next) => {
    if (reads >= 2) hasPassed = true
    return next(e)
  })
  expect(parseProgress(cut)).toEqual(parseProgress(whole))
  await $.session.start({ ...START, surface: 'desktop' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(hasPassed).toBe(true)
    expect(world.store[key]).toEqual(pending)
    expect(discarded).not.toContain(key)
    expect(ledgerRecords(world).some(record => record.words === pending.text)).toBe(false)
    expect(await ui.find({ type: 'Text', text: EN.inboxQuestionNotKept })).toBeDefined()
    world.beforeRead = undefined
    world.files.set(FILE, whole)
    world.mtime += 1
    for (let n = 0; n < 3; n++) await clock.advance(2000)
    expect(ledgerRecords(world).filter(record => record.words === pending.text)).toHaveLength(1)
    expect(world.store[key]).toBeUndefined()
    expect(discarded.filter(one => one === key)).toHaveLength(1)
  } finally {
    await ui.unmount()
  }
})

test('a pending inbox question no pass can record stays stored, runs no question pass on idle polls, and is tried again once progress.md changes', async ($, on) => {
  // Two blocks with one session id under one heading: the pass records neither them nor the turn.
  const twice = `## demo\n${block('55fb44cb', 'working', 0, '- [~] Work', 'Add a shelf')}${block('55fb44cb', 'working', 0, '- [~] Work', 'Paint it')}`
  const once = `## demo\n${block('55fb44cb', 'working', 0, '- [~] Work', 'Add a shelf')}`
  const world = makeWorld([[FILE, twice]])
  world.env = english
  const pending = { id: '55fb44cb', agent: 'codex', project: 'demo', text: 'Ship the shelf, OK?', isQuestion: true, at: NOW - 60_000, sourceRevisions: ['f'.repeat(64)] }
  const key = `pendingInboxQuestion:${sha256(FILE)}:${sha256(JSON.stringify([pending.id, pending.sourceRevisions]))}`
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {}, [key]: pending }
  const clock = engineBeneath(on, world)
  let passes = 0
  on('state.set', { plugin: 'agent-board', key: 'questionLedger' }, ($, e, next) => {
    passes += 1
    return next(e)
  })
  await $.session.start({ ...START, surface: 'desktop' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    for (let n = 0; n < 4; n++) await clock.advance(2000)
    expect(passes).toBeGreaterThan(0)
    expect(world.store[key]).toEqual(pending)
    expect(ledgerRecords(world).some(record => record.words === pending.text)).toBe(false)
    const before = passes
    for (let n = 0; n < 5; n++) await clock.advance(2000)
    expect(passes).toBe(before)
    world.files.set(FILE, once)
    world.mtime += 1
    for (let n = 0; n < 3; n++) await clock.advance(2000)
    expect(ledgerRecords(world).filter(record => record.words === pending.text)).toHaveLength(1)
    expect(world.store[key]).toBeUndefined()
  } finally {
    await ui.unmount()
  }
})

test('a pending inbox question a session asked before in the same words, and the person answered, stays stored until the pass records this ask', async ($, on) => {
  // The answered record has the same scope and words, but another inbox file's revision.
  const twice = `## demo\n${block('55fb44cb', 'working', 0, '- [~] Work', 'Add a shelf')}${block('55fb44cb', 'working', 0, '- [~] Work', 'Paint it')}`
  const once = `## demo\n${block('55fb44cb', 'working', 0, '- [~] Work', 'Add a shelf')}`
  const earlier = { id: '55fb44cb', agent: 'codex', project: 'demo', text: 'Ship the shelf, OK?', isQuestion: true, at: NOW - 2 * HOUR, sourceRevisions: ['e'.repeat(64)] }
  const seeded = observeQuestions(emptyQuestions(), parseProgress(once), null, [], NOW - 2 * HOUR, true, 'seed', { retired: [], consumed: [] }, [earlier]).ledger
  const asked = seeded.records.find(record => record.words === earlier.text)!
  const answered = resolveQuestion(seeded, asked.id, NOW - HOUR)
  const world = makeWorld([[FILE, twice], [LEDGER, questionsJson(answered)]])
  world.env = english
  const pending = { ...earlier, at: NOW - 60_000, sourceRevisions: ['f'.repeat(64)] }
  const key = `pendingInboxQuestion:${sha256(FILE)}:${sha256(JSON.stringify([pending.id, pending.sourceRevisions]))}`
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {}, [key]: pending }
  const clock = engineBeneath(on, world)
  await $.session.start({ ...START, surface: 'desktop' })
  for (let n = 0; n < 4; n++) await clock.advance(2000)
  expect(world.store[key]).toEqual(pending)
  expect(ledgerRecords(world).filter(record => record.words === pending.text && record.isUnresolved)).toHaveLength(0)
  world.files.set(FILE, once)
  world.mtime += 1
  for (let n = 0; n < 3; n++) await clock.advance(2000)
  expect(ledgerRecords(world).filter(record => record.words === pending.text && record.isUnresolved)).toHaveLength(1)
  expect(world.store[key]).toBeUndefined()
})

test('a saved pending question of a block cut off before its question line stays stored, and is recorded once when the block is whole', async ($, on) => {
  const head = '# Progress\n\n## demo-152\n\n<!-- auto session=55fb44cb agent=codex state=waiting updated=2026-10-15T01:17:08.128Z source=turns -->\n### Add a shelf\n'
  const tail = `\n## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`
  const world = makeWorld([[FILE, `${head}${tail}`]])
  world.env = english
  const pending = { id: '55fb44cb', agent: 'codex', project: 'demo-152', text: 'Ship the shelf, OK?', isQuestion: true, at: NOW - 60_000, sourceRevisions: ['f'.repeat(64)] }
  const key = `pendingInboxQuestion:${sha256(FILE)}:${sha256(JSON.stringify([pending.id, pending.sourceRevisions]))}`
  world.store = { ...world.store, [key]: pending }
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  expect(world.store[key]).toEqual(pending)
  expect(ledgerRecords(world).some(record => record.words === pending.text)).toBe(false)
  world.reads = []
  await clock.advance(2000)
  expect(world.reads).not.toContain(FILE)
  world.files.set(FILE, `${head}- [?] Ship the shelf, OK?\n<!-- /auto session=55fb44cb -->\n${tail}`)
  world.mtime += 1
  await clock.advance(4000)
  expect(ledgerRecords(world).filter(record => record.words === pending.text)).toHaveLength(1)
  expect(world.store[key]).toBeUndefined()
})

test('a cut-off block is listed under Board health at the bottom, not in the warning', async ($, on) => {
  const cut = '<!-- auto session=55fb44cb agent=codex state=waiting updated=2026-10-15T01:17:08.128Z source=turns -->'
  const day = localDay(Date.parse('2026-10-15T01:17:08.128Z')).slice(5)
  const notice = EN.blockCutOff('Codex', day)
  const board = `# Progress\n\n## demo-152\n\n${cut}\n### Add a shelf\n> waiting on your repl\n\n## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.hasTasks = true
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {}, told: { seed: 1 } }
  const notified: string[] = []
  on('ui.notify', ($, e) => {
    notified.push(e.message)
    return {}
  })
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    expect(notified.some(text => text.includes('cut off') || text.includes('55fb44cb'))).toBe(false)
    const sections = (await ui.findAll({ type: 'Button' })).map(node => node.key).filter((key): key is string => key?.startsWith('section::') ?? false)
    expect(sections.at(-1)).toBe('section::health')
    expect(await ui.find({ type: 'Button', key: 'section::health', text: `▸ ${EN.sectionHealth}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: notice })).toBeUndefined()
    const beforeOpen = visiblePaneText(await ui.drawn())
    expect(beforeOpen.indexOf(EN.sectionHealth)).toBeGreaterThan(beforeOpen.indexOf(EN.progressFileShown))
    await ui.press({ key: 'section::health' })
    const line = await ui.find({ type: 'Text', text: notice })
    expect(line).toBeDefined()
    expect(line?.props).toMatchObject({ color: paletteFor('dark').muted })
    expect(line?.props.color).not.toBe(paletteFor('dark').alert)
    expect(notice).toContain('Codex')
    expect(notice).toContain(day)
    expect(notice).not.toContain('<!--')
    expect(notice).not.toContain('55fb44cb')
    expect(notice).not.toContain('line ')
    expect(notice).not.toContain('progress.md')
  } finally {
    await ui.unmount()
  }
})

test('the pane records no half-written question of a block cut off in the middle, and its tidy does not count the block\'s questions gone', async ($, on) => {
  const head = `# Progress\n\n## demo-152\n\n<!-- auto session=55fb44cb agent=codex state=waiting updated=2026-10-15T01:17:08Z -->\n### Add a shelf\n`
  const tail = `\n## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  // The pane watched the block whole; a write then cut it in the middle of its question.
  const whole = `${head}- [?] Paint it, OK?\n<!-- /auto session=55fb44cb -->\n${tail}`
  const world = makeWorld([[FILE, `${head}- [?] Paint it, O\n${tail}`]])
  world.env = english
  seedAsked(world, whole)
  const [paint] = ledgerRecords(world).filter(record => record.words === 'Paint it, OK?')
  expect(paint?.isWaiting).toBe(true)
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  for (let n = 0; n < 3; n += 1) await clock.advance(2000)
  await $.command.run(TIDY)
  await clock.advance(2000)
  const records = ledgerRecords(world)
  expect(records.map(record => record.words)).not.toContain('Paint it, O')
  expect(records.find(record => record.id === paint?.id)).toMatchObject({ isPresent: true, isWaiting: true })
  expect(world.files.has(proofFile('retired', paint!.id))).toBe(false)
})

test('the pane keeps the question and writes no retirement proof when its block is cut right after the marker', async ($, on) => {
  const head = `## demo\n<!-- auto session=55fb44cb agent=codex state=waiting updated=${new Date(NOW).toISOString()} -->\n`
  const tail = `\n## later\n${block('a1b2c301', 'working', 0, '- [~] Work')}`
  const whole = `${head}### Add a shelf\n- [?] Paint it, OK?\n<!-- /auto session=55fb44cb -->\n${tail}`
  const world = makeWorld([[FILE, whole]])
  world.env = english
  seedAsked(world, whole)
  const paint = ledgerRecords(world).find(record => record.words === 'Paint it, OK?')!
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  world.files.set(FILE, `${head}${tail}`)
  world.mtime += 1
  for (let pass = 0; pass < 3; pass += 1) await clock.advance(2000)
  await $.command.run(TIDY)
  expect(ledgerRecords(world).find(record => record.id === paint.id)).toMatchObject({ isUnresolved: true, isPresent: true, isWaiting: true })
  expect(world.files.has(proofFile('retired', paint.id))).toBe(false)
  world.files.set(FILE, whole)
  world.mtime += 1
  for (let pass = 0; pass < 3; pass += 1) await clock.advance(2000)
  expect(ledgerRecords(world).filter(record => record.words === paint.words).map(record => record.id)).toEqual([paint.id])
  expect(world.files.has(proofFile('retired', paint.id))).toBe(false)
})

test('the pane shows a frozen question once in full without its cut-off prefix', async ($, on) => {
  const head = `## demo\n<!-- auto session=55fb44cb agent=codex state=waiting updated=${new Date(NOW).toISOString()} -->\n### Add a shelf\n`
  const tail = `\n## later\n${block('a1b2c301', 'working', 0, '- [~] Work')}`
  const whole = `${head}- [?] Paint it, OK?\n<!-- /auto session=55fb44cb -->\n${tail}`
  const world = makeWorld([[FILE, `${head}- [?] Paint it, O\n${tail}`]])
  world.env = english
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {}, opened: ['waiting'] }
  seedAsked(world, whole)
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (let pass = 0; pass < 3; pass += 1) await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    expect(await ui.findAll({ type: 'Button', text: 'Paint it, OK?' })).toHaveLength(1)
    // The text match is a substring one, so the full question is the only button it may find.
    expect((await ui.findAll({ type: 'Button', text: 'Paint it, O' }) as Array<{ text?: string }>).map(node => node.text)).toEqual(['Paint it, OK?'])
    await $.command.run({ ...TIDY, args: 'open' })
    const html = world.files.get(FILE.replace(/\.md$/, '.html')) ?? ''
    expect(html).toContain('Paint it, OK?')
    expect(html).not.toContain('Paint it, O<')
  } finally {
    await ui.unmount()
  }
})

test('the pane refuses a hide when the question block loses its end marker before the press', async ($, on) => {
  const whole = `## demo\n${block('55fb44cb', 'waiting', 0, '- [?] Paint it, OK?', 'Add a shelf')}\n## later\n${block('a1b2c301', 'working', 0, '- [~] Work')}`
  const cut = whole.replace('<!-- /auto session=55fb44cb -->', '')
  const world = makeWorld([[FILE, whole]])
  world.env = english
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {}, opened: ['waiting'] }
  seedAsked(world, whole)
  const paint = ledgerRecords(world).find(record => record.words === 'Paint it, OK?')!
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const key = 'demo::Add a shelf::0::hide'
    expect(await ui.find({ type: 'Button', key })).toBeDefined()
    // Keeping the empty marker line leaves the parsed tasks equal to the pane's snapshot.
    world.files.set(FILE, cut)
    world.mtime += 1
    await ui.press({ key })
    expect(JSON.parse(world.files.get(ANSWERED) ?? '{"answered":[]}').answered).not.toContain(paint.id)
    expect(await ui.find({ type: 'Text', text: EN.boardLineChanged })).toBeDefined()
    expect(ledgerRecords(world).find(record => record.id === paint.id)?.isUnresolved).toBe(true)
    world.files.set(FILE, whole)
    world.mtime += 1
    await clock.advance(2000)
    expect(ledgerRecords(world).filter(record => record.words === paint.words).map(record => record.id)).toEqual([paint.id])
  } finally {
    await ui.unmount()
  }
})

test('the pane unhides a frozen question without consuming an unmapped legacy acknowledgement', async ($, on) => {
  const whole = `## demo\n${block('55fb44cb', 'waiting', 0, '- [?] Paint it, OK?', 'Add a shelf')}\n## later\n${block('a1b2c301', 'working', 0, '- [~] Work')}`
  const cut = whole.replace('<!-- /auto session=55fb44cb -->', '')
  const world = makeWorld([[FILE, cut]])
  world.env = english
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {}, opened: ['hidden'] }
  seedAsked(world, whole)
  const paint = ledgerRecords(world).find(record => record.words === 'Paint it, OK?')!
  const legacy = '55fb44cb 0 Paint it, OK?'
  put(world, ANSWERED, JSON.stringify({ answered: [paint.id, legacy] }), 3)
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const key = `retained::${paint.id}::unhide`
    expect(await ui.find({ type: 'Button', key })).toBeDefined()
    await ui.press({ key })
    expect(JSON.parse(world.files.get(ANSWERED)!).answered).toEqual([legacy])
    expect(ledgerRecords(world).filter(record => record.words === paint.words).map(record => record.id)).toEqual([paint.id])
    expect(ledgerRecords(world).find(record => record.id === paint.id)?.isUnresolved).toBe(true)
  } finally {
    await ui.unmount()
  }
})

test('the pane refuses a resolution when the stopped question block loses its end marker before the press', async ($, on) => {
  const whole = `## demo\n${block('55fb44cb', 'ended', 0, '- [?] Paint it, OK?', 'Add a shelf')}\n## later\n${block('a1b2c301', 'working', 0, '- [~] Work')}`
  const cut = whole.replace('<!-- /auto session=55fb44cb -->', '')
  const world = makeWorld([[FILE, whole]])
  world.env = english
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {}, opened: ['stopped'] }
  seedAsked(world, whole)
  const paint = ledgerRecords(world).find(record => record.words === 'Paint it, OK?')!
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const key = 'demo::Add a shelf::0::resolve'
    expect(await ui.find({ type: 'Button', key })).toBeDefined()
    world.files.set(FILE, cut)
    world.mtime += 1
    await ui.press({ key })
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.resolveChanged })).toBeDefined()
    expect(ledgerRecords(world).find(record => record.id === paint.id)?.isUnresolved).toBe(true)
    expect(capturesOf(world).some(capture => capture.record.id === paint.id && capture.disposition === 'resolved')).toBe(false)
    world.files.set(FILE, whole)
    world.mtime += 1
    await clock.advance(2000)
    expect(ledgerRecords(world).filter(record => record.words === paint.words).map(record => record.id)).toEqual([paint.id])
  } finally {
    await ui.unmount()
  }
})

test('a block cut off at the end of the file shows one line about the block and no retry once the file is still, and no line while it is still changing', async ($, on) => {
  const cut = '<!-- auto session=55fb44cb agent=codex state=waiting updated=2026-10-15T01:17:08.128Z source=turns -->'
  const day = localDay(Date.parse('2026-10-15T01:17:08.128Z')).slice(5)
  const board = `# Progress\n\n## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}\n## demo-152\n\n${cut}\n### Add a shelf\n> waiting on your repl\n`
  const notice = EN.blockCutOff('Codex', day)
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.hasTasks = true
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {}, opened: ['health'] }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    // While the file is still changing at every poll, even past 10 seconds, there is no line about the cut-off block.
    for (let n = 0; n < 6; n += 1) {
      world.files.set(FILE, `${board}${'\n'.repeat(n + 1)}`)
      world.mtime += 1
      await clock.advance(2000)
      expect(await ui.find({ type: 'Text', text: notice })).toBeUndefined()
    }
    for (let n = 0; n < 5; n += 1) await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: notice })).toBeDefined()
    // Once settled, no red question problem and no endless race.
    const seen = new Set<string>()
    for (let n = 0; n < 15; n += 1) {
      await clock.advance(2000)
      if (await ui.find({ type: 'Text', text: EN.questionsUnreadable() }) !== undefined) seen.add('unreadable')
      if (await ui.find({ type: 'Text', text: EN.inboxQuestionNotKept }) !== undefined) seen.add('notKept')
    }
    expect([...seen]).toEqual([])
    expect(await ui.find({ type: 'Text', text: notice })).toBeDefined()
    expect(visiblePaneText(await ui.drawn()).split(notice).length - 1).toBe(1)
    world.reads = []
    await clock.advance(2000)
    expect(world.reads).toEqual([])
  } finally {
    await ui.unmount()
  }
})

test('a block cut off at the end of the file is not named while the file has been still for 8 seconds, and is named at 10', async ($, on) => {
  const cut = '<!-- auto session=55fb44cb agent=codex state=waiting updated=2026-10-15T01:17:08.128Z source=turns -->'
  const day = localDay(Date.parse('2026-10-15T01:17:08.128Z')).slice(5)
  const board = `# Progress\n\n## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}\n## demo-152\n\n${cut}\n### Add a shelf\n> waiting on your repl\n`
  const notice = EN.blockCutOff('Codex', day)
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.hasTasks = true
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {}, opened: ['health'] }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    // 4 polls (8 seconds unchanged): no notice and no ledger write yet.
    for (let n = 0; n < 4; n += 1) {
      await clock.advance(2000)
      expect(await ui.find({ type: 'Button', key: 'section::health' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: notice })).toBeUndefined()
      expect(world.files.has(LEDGER)).toBe(false)
    }
    // 5th poll (10 seconds unchanged): the notice and the ledger write both appear.
    await clock.advance(2000)
    expect(await ui.find({ type: 'Button', key: 'section::health' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: notice })).toBeDefined()
    expect(world.files.has(LEDGER)).toBe(true)
    expect(ledgerRecords(world).map(record => record.words)).toContain('Publish the first plan, OK?')
  } finally {
    await ui.unmount()
  }
})

const engineWithOffset = (on: Parameters<typeof engineBeneath>[0], world: World, offsetOf: () => number) =>
  engineBeneath(((...args: Parameters<typeof on>) => {
    if (args[0] !== 'clock.now') return Reflect.apply(on, undefined, args)
    const callback = args.at(-1) as (...a: unknown[]) => Promise<{ value: number }>
    return on('clock.now', async ($, event, next) => {
      const result = await callback($, event, next)
      return { ...result, value: result.value + offsetOf() }
    })
  }) as typeof on, world)

test('moving a torn question list aside shows no question-list error', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {} }
  seedAsked(world, board)
  put(world, LEDGER, '{"version":1,"rec', 1)
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeUndefined()
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeUndefined()
    expect(ledgerRecords(world).map(record => record.words)).toContain('Publish the first plan, OK?')
    expect(filesOf(world, `${LEDGER}.torn-`)).toHaveLength(1)
  } finally {
    await ui.unmount()
  }
})

test('an unwritable question list shows no error before ten minutes of failed passes', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {} }
  let offset = 0
  const clock = engineWithOffset(on, world, () => offset)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    put(world, LEDGER, '{"version":999}', NOW + 10)
    // Fault 1 at t0 = NOW + 2000, followed by 3 more faults before 10 minutes (9m59.999s after t0).
    await clock.advance(2000)
    await clock.advance(2000)
    await clock.advance(2000)
    offset = 10 * 60_000 - 6000 - 1
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeUndefined()
  } finally {
    await ui.unmount()
  }
})

test('an unwritable question list shows the short error after ten minutes of failed passes, and a good pass clears it', async ($, on) => {
  expect(STRINGS.en.questionsUnreadable()).toBe("Questions can't be hidden or archived right now. If this lasts, check that the disk has free space.")
  expect(STRINGS['zh-TW'].questionsUnreadable()).toBe('目前無法隱藏或封存問題。如果持續發生，請檢查磁碟空間。')
  expect(STRINGS['zh-CN'].questionsUnreadable()).toBe('目前无法隐藏或归档问题。如果持续发生，请检查磁盘空间。')
  const board = `## demo\n${block('a1b2c301', 'waiting', 1, '- [?] Publish the first plan, OK?')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.store = { lang: 'en', autoConnectOff: true, inboxDone: {} }
  let offset = 0
  const clock = engineWithOffset(on, world, () => offset)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    put(world, LEDGER, '{"version":999}', NOW + 10)
    await clock.advance(2000)
    await clock.advance(2000)
    offset = 10 * 60_000
    await clock.advance(2000)
    const shown = await ui.find({ type: 'Text', text: "Questions can't be hidden or archived right now. If this lasts, check that the disk has free space." })
    expect(shown).toBeDefined()
    // A good pass clears the error and resets the 10-minute timer.
    world.files.delete(LEDGER)
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeUndefined()
    put(world, LEDGER, '{"version":999}', NOW + 20 * 60_000)
    await clock.advance(2000)
    await clock.advance(2000)
    offset += 5 * 60_000
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeUndefined()
  } finally {
    await ui.unmount()
  }
})

test('two failed question passes over ten minutes show no error and the third shows it', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  let offset = 0
  const clock = engineWithOffset(on, world, () => offset)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (let pass = 0; pass < 3; pass += 1) await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    put(world, LEDGER, '{"version":999}', NOW + 10)
    await clock.advance(2000)
    offset = 10 * 60_000 + 1
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeUndefined()
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeDefined()
  } finally {
    await ui.unmount()
  }
})

test('fourteen question races over ten minutes show no error and the fifteenth shows it', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  let offset = 0
  const clock = engineWithOffset(on, world, () => offset)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (let pass = 0; pass < 3; pass += 1) await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    // An unreadable proof listing takes the race path before any ledger write.
    world.unlistable = new Set([FILE.replace(/\/[^/]*$/, '')])
    await clock.advance(2000)
    offset = 10 * 60_000 + 1
    for (let race = 2; race <= 14; race += 1) {
      await clock.advance(2000)
      expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeUndefined()
    }
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeDefined()
  } finally {
    await ui.unmount()
  }
})

test('a clock moved back an hour restarts the ten-minute wait for the question-list error', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  let offset = 0
  const clock = engineWithOffset(on, world, () => offset)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (let pass = 0; pass < 3; pass += 1) await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    put(world, LEDGER, '{"version":999}', NOW + 10)
    for (let fault = 0; fault < 3; fault += 1) await clock.advance(2000)
    offset = -HOUR
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeUndefined()
    // The next pass is 9m59.999s after the jump, then the next is exactly ten minutes after it.
    offset = -HOUR + 10 * 60_000 - 2000 - 1
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeUndefined()
    offset = -HOUR + 10 * 60_000 - 4000
    await clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: EN.questionsUnreadable() })).toBeDefined()
  } finally {
    await ui.unmount()
  }
})

test('the archive sweep removes torn ledgers over a week old even among the newest three, and keeps younger ones', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  world.ran = []
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  put(world, LEDGER, questionsJson(emptyQuestions()), NOW - HOUR)
  // Three only, so none goes for being past the newest three.
  const young = [`${LEDGER}.torn-${NOW - 6 * 24 * HOUR}-synthetic-session`]
  // Over a week old by the time in its name, and one moved aside by hand, by its own time.
  const old = [`${LEDGER}.torn-${NOW - 8 * 24 * HOUR}-4243`, `${LEDGER}.torn-20261007`]
  for (const path of [...young, ...old]) put(world, path, '{"version":1,"rec', 1)
  world.mtimes = { ...world.mtimes, [old[1]!]: NOW - 9 * 24 * HOUR }
  await $.command.run(TIDY)
  expect(young.filter(path => world.files.has(path))).toEqual(young)
  expect(old.filter(path => world.files.has(path))).toEqual([])
})

test('one archive sweep removes at most 200 files across torn ledgers and old proofs, and the next sweep takes the rest', { timeoutMs: 60_000 }, async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  const torn = Array.from({ length: 150 }, (_, n) => `${LEDGER}.torn-${NOW - 8 * 24 * HOUR - n}-${4000 + n}`)
  torn.forEach(path => put(world, path, '{"version":1,"rec', 1))
  // The newest 16 proofs stay, leaving 150 to share the allowance with the torn ledgers.
  putOrphans(world, 166)
  world.ran = []
  await $.command.run(TIDY)
  expect(removedPerProcess(world).reduce((sum, count) => sum + count, 0)).toBe(200)
  expect(torn.filter(path => world.files.has(path))).toEqual([])
  expect(filesOf(world, RETIRED)).toHaveLength(116)
  world.ran = []
  await $.command.run(TIDY)
  expect(removedPerProcess(world).reduce((sum, count) => sum + count, 0)).toBe(100)
  expect(filesOf(world, RETIRED)).toHaveLength(16)
})

test('an archive sweep whose torn-ledger removal fails after removing files ends there, and the next sweep goes on', async ($, on) => {
  const world = makeWorld([[FILE, pruningBoard]])
  world.env = english
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  const torn = Array.from({ length: 150 }, (_, n) => `${LEDGER}.torn-${NOW - 8 * 24 * HOUR - n}-${4000 + n}`)
  torn.forEach(path => put(world, path, '{"version":1,"rec', 1))
  putOrphans(world, 166)
  const proofs = filesOf(world, RETIRED)
  world.beforeExists = path => { if (torn.includes(path)) throw new Error('EIO') }
  world.ran = []
  await $.command.run(TIDY)
  expect(removedPerProcess(world)).toEqual([50])
  expect(torn.filter(path => world.files.has(path))).toHaveLength(100)
  expect(filesOf(world, RETIRED)).toEqual(proofs)
  world.beforeExists = undefined
  world.ran = []
  await $.command.run(TIDY)
  expect(removedPerProcess(world).reduce((sum, count) => sum + count, 0)).toBe(200)
  expect(torn.filter(path => world.files.has(path))).toEqual([])
  expect(filesOf(world, RETIRED)).toHaveLength(66)
})

test('the archive sweep keeps the newest three torn ledgers and removes day-old temporary copies of the ledger', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.ran = []
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  // Five torn ledgers, from the pane and from the board script, and three temporary copies.
  const torn = [1, 2, 3, 4, 5].map(n => `${LEDGER}.torn-${NOW - n * HOUR}-${n % 2 === 0 ? 'synthetic-session' : String(4000 + n)}`)
  torn.forEach(path => put(world, path, '{"version":1,"rec', 1))
  const ledger = questionsJson(emptyQuestions())
  put(world, LEDGER, ledger, NOW - HOUR)
  const oldTemp = `${LEDGER}.tmp-synthetic-session-7`
  const freshTemp = `${LEDGER}.tmp-synthetic-session-8`
  const oldBoardTemp = `${LEDGER}.4242.mf3x9k.board-tmp`
  put(world, oldTemp, ledger, NOW - 2 * 24 * HOUR)
  put(world, freshTemp, ledger, NOW - HOUR)
  put(world, oldBoardTemp, ledger, NOW - 2 * 24 * HOUR)
  await $.command.run(TIDY)
  expect(torn.filter(path => world.files.has(path))).toEqual(torn.slice(0, 3))
  expect(world.files.has(oldTemp)).toBe(false)
  expect(world.files.has(oldBoardTemp)).toBe(false)
  expect(world.files.has(freshTemp)).toBe(true)
  expect(world.files.has(LEDGER)).toBe(true)
})

test('one archive sweep removes at most 200 torn ledgers and temporary copies, and the next sweep takes the rest', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.ran = []
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  // 253 torn ledgers, of which the newest three stay, and ten day-old temporary copies.
  const torn = Array.from({ length: 253 }, (_, n) => `${LEDGER}.torn-${NOW - (n + 1) * 60_000}-${4000 + n}`)
  torn.forEach(path => put(world, path, '{"version":1,"rec', 1))
  const ledger = questionsJson(emptyQuestions())
  put(world, LEDGER, ledger, NOW - HOUR)
  const temps = Array.from({ length: 10 }, (_, n) => `${LEDGER}.tmp-synthetic-session-${n}`)
  temps.forEach(path => put(world, path, ledger, NOW - 2 * 24 * HOUR))
  const left = (): number => [...torn, ...temps].filter(path => world.files.has(path)).length
  await $.command.run(TIDY)
  expect(left()).toBe(253 + 10 - 200)
  await $.command.run(TIDY)
  expect(torn.filter(path => world.files.has(path))).toEqual(torn.slice(0, 3))
  expect(temps.filter(path => world.files.has(path))).toEqual([])
})

test('the archive sweep keeps a day-old temporary copy while the ledger does not read, and a torn name that holds a whole ledger', async ($, on) => {
  const board = `## demo\n${block('a1b2c301', 'working', 1, '- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.ran = []
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  const ledger = questionsJson(emptyQuestions())
  // Five torn names: the fourth holds a whole ledger, left when putting one back failed.
  const torn = [1, 2, 3, 4, 5].map(n => `${LEDGER}.torn-${NOW - n * HOUR}-synthetic-session`)
  torn.forEach((path, n) => put(world, path, n === 3 ? ledger : '{"version":1,"rec', 1))
  const oldTemp = `${LEDGER}.tmp-synthetic-session-7`
  put(world, oldTemp, ledger, NOW - 2 * 24 * HOUR)
  world.unreadable = new Set([LEDGER])
  await $.command.run(TIDY)
  expect(torn.filter(path => world.files.has(path))).toEqual(torn.slice(0, 4))
  expect(world.files.has(oldTemp)).toBe(true)
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

// A sweep whose first try archives the block that asks and is then undone by another agent's write
// (with `isChanged`, one that also adds a step to that block), and whose second try finds the board
// changed while it checks the question, so the third try is the last.
const sweptTwice = async ($: Engine, on: On, isChanged: boolean): Promise<World> => {
  const asking = '- [x] Draft\n- [?] Publish the plan, OK?'
  const boardAt = (hours: number, steps = asking): string => `## demo\n${block('a1b2c301', 'ended', hours, steps)}${block('a1b2c302', 'done', 5, '- [x] Finished')}`
  const world = makeWorld([[FILE, boardAt(48)]])
  world.env = english
  seedAsked(world, boardAt(48))
  const clock = engineBeneath(on, world)
  await $.session.start(START)
  await clock.advance(2000)
  await clock.advance(2000)
  world.files.set(FILE, boardAt(96))
  world.mtime += 1
  let isUndone = false
  world.afterWrite = () => {
    isUndone = true
    return `${boardAt(96, isChanged ? `- [x] Draft\n- [x] Read it again\n- [?] Publish the plan, OK?` : asking)}### Added by another agent\n- [ ] Not seen by the sweep\n`
  }
  world.beforeRead = path => {
    if (path !== ANSWERED || !isUndone) return
    isUndone = false
    world.files.set(FILE, `${world.files.get(FILE)}\n`)
    world.mtime += 1
  }
  await $.command.run(TIDY)
  world.beforeRead = undefined

  return world
}

test('a block that asks which an earlier try archived leaves on the last try when it reads the same, so it is in one place', async ($, on) => {
  const world = await sweptTwice($, on, false)
  expect(world.files.get(FILE)).toContain('Added by another agent')
  expect(world.files.get(FILE)).not.toContain('session=a1b2c301')
  expect(world.files.get(FILE)).not.toContain('session=a1b2c302')
  expect(world.files.get(ARCHIVE)?.split('Publish the plan, OK?').length).toBe(2)
  expect(world.files.get(ARCHIVE)?.split('Finished').length).toBe(2)
  expect(ledgerRecords(world).filter(record => record.isUnresolved).map(record => record.words)).toEqual(['Publish the plan, OK?'])
})

test('a block that asks which changed after an earlier try archived it stays on the last try, and its newer text is not archived unchecked', async ($, on) => {
  const world = await sweptTwice($, on, true)
  expect(world.files.get(FILE)).toContain('- [x] Read it again\n- [?] Publish the plan, OK?')
  expect(world.files.get(FILE)).not.toContain('session=a1b2c302')
  expect(world.files.get(ARCHIVE)?.split('Publish the plan, OK?').length).toBe(2)
  expect(world.files.get(ARCHIVE)).not.toContain('Read it again')
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

import { expect, test } from 'claude-code/testing'
import { captureJson, capturePath, questionProofJson, questionProofPath, questionsJson, questionsPath } from '../hooks/questions'
import type { QuestionCapture } from '../hooks/questions'
import { sha256 } from '../hooks/sha256'
import { finished, ledgerOf, reopened } from './fixtures/question-files'
import { engineBeneath, FILE, INBOX, makeWorld } from './fixtures/pane-world'
import type { World } from './fixtures/pane-world'

// A session start on a board with thousands of question files beside it (#416), against the mock
// engine. All data is made up.
const english = { HOME: '/home/me', LANG: 'en_US.UTF-8' }
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const START = { cwd: '/work/persona_framework', surface: 'terminal' as const, isInteractive: true }
const QUESTION_FILE = /-questions-(?:source|retired|consumed)-[a-f0-9]{64}\.json$/

const block = (session: string, state: string, steps: string): string =>
  `<!-- auto session=${session} agent=codex state=${state} updated=${new Date(NOW - HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z')} -->\n### Synthetic plan ${session}\n> Context: Synthetic data.\n${steps}\n<!-- /auto session=${session} -->\n`

// Assigned in place: thousands of files spread into a new object each would cost seconds.
const put = (world: World, path: string, text: string, mtime: number): void => {
  world.files.set(path, text)
  world.mtimes ??= {}
  world.mtimes[path] = mtime
}
// How many paths each removal of question files was given (taken inbox turns are removed too).
const questionRemovals = (world: World): string[][] => (world.ran ?? []).filter(argv => argv[0] === 'rm' && argv.some(arg => QUESTION_FILE.test(arg)))
const removedPerProcess = (world: World): number[] => questionRemovals(world).map(argv => argv.length - 2)
const putCapture = (world: World, record: Parameters<typeof captureJson>[0], disposition: QuestionCapture['disposition'], mtime: number): string => {
  const path = capturePath(FILE, sha256(captureJson(record, disposition)))
  put(world, path, captureJson(record, disposition), mtime)

  return path
}

test('on a board with 5,500 question copies, 500 proofs and 400 inbox turns, the inbox drains from the first look while the question files are trimmed', { timeoutMs: 240_000 }, async ($, on) => {
  const world = makeWorld([[FILE, `## demo\n${block('a1b2c302', 'working', '- [~] Work')}`]])
  world.env = english
  world.ran = []
  world.reads = []
  world.reply = () => 'TITLE: Synthetic backlog\nCONTEXT: Inbox turns\nDONE: Saved the turn\nNEXT: Check the result\nASK: -'
  const clock = engineBeneath(on, world)
  // 2,750 answered questions with the copy from when each was open and from when it was answered:
  // 5,500 copies. The 500 oldest questions are retired, so their 1,000 copies are what the rules let go.
  const answered = Array.from({ length: 2750 }, (_, n) => finished(n + 1))
  put(world, questionsPath(FILE), questionsJson({ ...ledgerOf(...answered), next: 3000 }), 1)
  // Each copy of a retired question, with the retirement proof that lets it go.
  const retiredCopies = new Map<string, string>()
  answered.forEach((record, n) => {
    const open = putCapture(world, reopened(record), 'unresolved', 10 + n * 2)
    const closed = putCapture(world, record, 'resolved', 11 + n * 2)
    if (n < 500) {
      const proof = questionProofPath(FILE, 'retired', sha256(record.id))
      retiredCopies.set(open, proof)
      retiredCopies.set(closed, proof)
      put(world, proof, questionProofJson('retired', sha256(record.id)), 10 + n)
    }
  })
  const names = Array.from({ length: 400 }, (_, n) => `codex-turn-${1_760_000_000 + n}-1.json`)
  names.forEach((name, n) => put(world, `${INBOX}/${name}`, JSON.stringify({ session_id: `synthetic-session-${n}`, cwd: '/work/demo', prompt: 'Synthetic request', last_assistant_message: 'Synthetic work is done.' }), 1_000 + n))
  const questionFiles = new Set([...world.files.keys()].filter(path => QUESTION_FILE.test(path)))
  expect(questionFiles.size).toBe(6000)
  const taken = (): number => names.filter(name => !world.files.has(`${INBOX}/${name}`)).length
  const delivered = (): number => names.filter(name => (world.store?.inboxDone as Record<string, string>)[name] !== undefined).length
  // The polls read each question file once and remember it, so a second read of one is the trim
  // reading a file again from disk before it removes it (or the file that lets it go): that read
  // is held until released.
  const seen = new Set<string>()
  let isTrimReading = false
  let takenBeforeTrim = 0
  let trimFrom = 0
  let release = (): void => undefined
  let heldAt = 0
  world.pauseRead = {
    when: path => {
      if (!QUESTION_FILE.test(path)) return false
      if (seen.has(path)) return true
      seen.add(path)
      return false
    },
    reached: () => {
      heldAt = performance.now()
      isTrimReading = true
      takenBeforeTrim = taken()
      // The held read is the last one listed.
      trimFrom = world.reads!.length - 1
    },
    release: new Promise<void>(done => { release = done }),
  }
  const gone = (): string[] => [...questionFiles].filter(path => !world.files.has(path))
  // While the trim's read is held, a later look takes more turns. A look goes through the write
  // queue before it takes any, so the trim is not holding the queue. The read is let go at that
  // take, not after a wait: the test kit drops a test's hooks once one of them runs ten seconds.
  let takenWhileHeld = 0
  let goneWhileHeld: string[] = []
  world.afterMove = from => {
    if (isTrimReading && takenWhileHeld === 0 && from.startsWith(`${INBOX}/`)) {
      takenWhileHeld = taken()
      goneWhileHeld = gone()
      release()
    }
    return false
  }
  try {
    await $.session.start(START)
    // The first poll reads every question file, each once. What those reads cost in time on a
    // real disk is for the soak and the parity board to measure: the mock charges nothing for them.
    const counts = new Map<string, number>()
    for (const path of world.reads.filter(one => QUESTION_FILE.test(one))) counts.set(path, (counts.get(path) ?? 0) + 1)
    expect(counts.size).toBe(questionFiles.size)
    expect(Math.max(...counts.values())).toBe(1)
    // The first look at the inbox, five seconds in, takes turns: nothing in the write queue holds it.
    await clock.advance(5000)
    expect(taken()).toBeGreaterThan(0)
    // The trim starts only after that first look.
    for (let n = 0; n < 30 && !isTrimReading; n += 1) await clock.advance(2000)
    expect(isTrimReading).toBe(true)
    expect(takenBeforeTrim).toBeGreaterThan(0)
    for (let n = 0; n < 30 && takenWhileHeld === 0; n += 1) await clock.advance(1000)
    expect(takenWhileHeld).toBeGreaterThan(takenBeforeTrim)
    expect(goneWhileHeld).toEqual([])
  } finally {
    console.log(`the trim's read was held ${Math.round(performance.now() - heldAt)} ms`)
    release()
  }
  // The turns taken are recorded as done.
  for (let n = 0; n < 30 && delivered() === 0; n += 1) await clock.advance(2000)
  expect(delivered()).toBeGreaterThan(0)
  for (let n = 0; n < 30 && gone().length === 0; n += 1) await clock.advance(2000)
  // The sweep removed 200 files, fifty to a process, all copies of retired questions.
  expect(gone().length).toBe(200)
  expect(removedPerProcess(world)).toEqual([50, 50, 50, 50])
  expect(gone().filter(path => !retiredCopies.has(path))).toEqual([])
  // From disk it read again only what it removed and the proofs that let those go, not the pile.
  const removed = gone()
  const covering = new Set(removed.map(path => retiredCopies.get(path)))
  const trimReads = world.reads.slice(trimFrom).filter(path => QUESTION_FILE.test(path))
  expect(trimReads.filter(path => !removed.includes(path) && !covering.has(path))).toEqual([])
})


test('an hourly sweep reads again only the question files it removes and the proofs that let them go, and one with nothing to remove reads none', { timeoutMs: 240_000 }, async ($, on) => {
  const world = makeWorld([[FILE, `## demo\n${block('a1b2c302', 'working', '- [~] Work')}`]])
  world.env = english
  world.isArchiveClockOnly = true
  world.ran = []
  const clock = engineBeneath(on, world)
  // 600 answered questions with two copies each; the copies of the 100 oldest are retired.
  const answered = Array.from({ length: 600 }, (_, n) => finished(n + 1))
  put(world, questionsPath(FILE), questionsJson({ ...ledgerOf(...answered), next: 1000 }), 1)
  const retiredCopies = new Map<string, string>()
  answered.forEach((record, n) => {
    const open = putCapture(world, reopened(record), 'unresolved', 10 + n * 2)
    const closed = putCapture(world, record, 'resolved', 11 + n * 2)
    if (n < 100) {
      const proof = questionProofPath(FILE, 'retired', sha256(record.id))
      retiredCopies.set(open, proof)
      retiredCopies.set(closed, proof)
      put(world, proof, questionProofJson('retired', sha256(record.id)), 10 + n)
    }
  })
  const questionFiles = [...world.files.keys()].filter(path => QUESTION_FILE.test(path))
  await $.session.start(START)
  // The first hour's sweep: the 200 retired copies go.
  world.reads = []
  await clock.advance(HOUR)
  const gone = questionFiles.filter(path => !world.files.has(path))
  expect(gone.length).toBe(200)
  expect(gone.filter(path => !retiredCopies.has(path))).toEqual([])
  const covering = new Set(gone.map(path => retiredCopies.get(path)))
  expect(world.reads.filter(path => QUESTION_FILE.test(path) && !gone.includes(path) && !covering.has(path))).toEqual([])
  // The next hour finds 1,000 copies and 100 proofs, over the floor of 16 but kept by the rules:
  // none of them is read.
  world.reads = []
  world.ran = []
  await clock.advance(HOUR)
  expect(world.reads.filter(path => QUESTION_FILE.test(path))).toEqual([])
  expect(questionRemovals(world)).toEqual([])
})

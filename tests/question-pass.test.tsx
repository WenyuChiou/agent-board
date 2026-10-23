import { expect, test } from 'claude-code/testing'
import { parseProgress } from '../hooks/parse'
import { captureJson, capturePath, copiesToKeep, emptyQuestions, identitiesToRetire, observeQuestions, questionsJson, questionsPath, withCaptures } from '../hooks/questions'
import type { QuestionCapture } from '../hooks/questions'
import { sha256 } from '../hooks/sha256'
import { finished, held, ledgerOf, question, reopened } from './fixtures/question-files'
import { engineBeneath, FILE, makeWorld } from './fixtures/pane-world'
import type { World } from './fixtures/pane-world'

// A question pass on a board with thousands of questions and question copies beside it (#416).
// All data is made up.
const english = { HOME: '/home/me', LANG: 'en_US.UTF-8' }
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const START = { cwd: '/work/persona_framework', surface: 'terminal' as const, isInteractive: true }
const QUESTION_FILE = /-questions-(?:source|retired|consumed)-[a-f0-9]{64}\.json$/

test('a question pass over 1,000 open questions and 5,600 copies works out the copies to keep and the questions to retire well within a second', () => {
  const open = Array.from({ length: 1000 }, (_, n) => question(n + 1))
  const answered = Array.from({ length: 2700 }, (_, n) => finished(n + 1001))
  // A copy from when each answered question was open and from when it was answered, and the
  // copies the 200 oldest open questions already have.
  const captures = [
    ...answered.flatMap(record => [held(reopened(record), 'unresolved', 0).capture, held(record, 'resolved', 0).capture]),
    ...open.slice(0, 200).map(record => held(record, 'unresolved', 0).capture),
  ]
  expect(captures.length).toBe(5600)
  const started = Date.now()
  const current = withCaptures(ledgerOf(...open, ...answered), captures)
  // Since the ledger was read, every other open question was answered and every tenth left the board.
  const observed = { ...current, records: current.records.map((record, n) => {
    if (n >= 1000) return record
    if (n % 2 === 1) return { ...record, isUnresolved: false, isWaiting: false, isPresent: false, resolvedAt: NOW }
    return n % 10 === 0 ? { ...record, isWaiting: false, isPresent: false } : record
  }) }
  const copies = copiesToKeep(current, observed, captures)
  const retired = identitiesToRetire(current, observed, [])
  const took = Date.now() - started
  // Comparing every copy with every question took seconds here and kept the mod from the host.
  expect(took).toBeLessThan(1000)
  // Each still-open question gets a copy of what it holds now unless it has one (one that left
  // the board holds something new), and each one answered since gets its answered copy.
  const ids = (disposition: QuestionCapture['disposition']): string[] => copies.filter(copy => copy.disposition === disposition).map(copy => copy.record.id)
  expect(ids('unresolved')).toEqual(open.filter((_, n) => n % 2 === 0 && (n >= 200 || n % 10 === 0)).map(record => record.id))
  expect(ids('resolved')).toEqual(open.filter((_, n) => n % 2 === 1).map(record => record.id))
  expect(retired).toEqual(open.filter((_, n) => n % 10 === 0).map(record => record.id))
})

// Assigned in place: thousands of files spread into a new object each would cost seconds.
const put = (world: World, path: string, text: string, mtime: number): void => {
  world.files.set(path, text)
  world.mtimes ??= {}
  world.mtimes[path] = mtime
}
const putCapture = (world: World, record: Parameters<typeof captureJson>[0], disposition: QuestionCapture['disposition'], mtime: number): void => {
  put(world, capturePath(FILE, sha256(captureJson(record, disposition))), captureJson(record, disposition), mtime)
}
const block = (session: string, steps: string): string =>
  `<!-- auto session=${session} agent=codex state=waiting updated=${new Date(NOW - HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z')} -->\n### Synthetic plan ${session}\n> Context: Synthetic data.\n${steps}\n<!-- /auto session=${session} -->\n`

test('a session start on a board with 300 waiting questions and 5,500 old copies never goes a second without a trip to the host, and writes no copy it already has', { timeoutMs: 600_000 }, async ($, on) => {
  // Claude Code unloads a mod whose worker has not answered its heartbeat for 5 s (#371), and the
  // worker answers only while it waits on the host: the time between two host calls is that stretch.
  let last = Date.now()
  let lastCall = ''
  let longest = 0
  let between = ''
  const timed = ((...args: unknown[]) => {
    const callback = args.at(-1)
    if (typeof callback !== 'function') return Reflect.apply(on, undefined, args)
    return Reflect.apply(on, undefined, [...args.slice(0, -1), (...inner: unknown[]) => {
      const at = Date.now()
      // From the first call on: before it the mod has done nothing, and the time is the test's own.
      if (lastCall !== '' && at - last > longest) {
        longest = at - last
        between = `${lastCall} and ${String(args[0])}`
      }
      last = at
      lastCall = String(args[0])
      return Reflect.apply(callback, undefined, inner)
    }])
  }) as typeof on
  const board = `## demo\n${Array.from({ length: 300 }, (_, n) => block(`b0${n.toString(16).padStart(6, '0')}`, `- [?] Publish plan number ${n}, OK?`)).join('')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  const clock = engineBeneath(timed, world)
  // The ledger and a copy of each open question, as a pane that watched this board wrote them,
  // listed after 5,500 copies of 2,750 answered questions.
  const asked = observeQuestions(emptyQuestions(), parseProgress(board), null, [], NOW, true, 'seed').ledger
  const answered = Array.from({ length: 2750 }, (_, n) => finished(n + 1))
  put(world, questionsPath(FILE), questionsJson({ ...asked, next: 3100, records: [...asked.records, ...answered] }), 1)
  answered.forEach((record, n) => {
    putCapture(world, reopened(record), 'unresolved', 10 + n * 2)
    putCapture(world, record, 'resolved', 11 + n * 2)
  })
  asked.records.forEach((record, n) => putCapture(world, record, 'unresolved', 6_000 + n))
  const before = [...world.files.keys()].filter(path => QUESTION_FILE.test(path)).length
  expect(before).toBe(5800)
  world.written = []
  lastCall = ''
  longest = 0
  await $.session.start(START)
  await clock.advance(2000)
  console.log(`longest stretch without a host call: ${longest} ms, between ${between}`)
  expect(longest).toBeLessThan(1000)
  expect(world.written.filter(path => QUESTION_FILE.test(path))).toEqual([])
  expect([...world.files.keys()].filter(path => QUESTION_FILE.test(path)).length).toBe(before)
})

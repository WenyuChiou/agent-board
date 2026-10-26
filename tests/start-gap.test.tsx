import { expect, test } from 'claude-code/testing'
import { parseProgress } from '../hooks/parse'
import { captureJson, capturePath, emptyQuestions, observeQuestions, parseQuestions, questionsJson, questionsPath } from '../hooks/questions'
import type { QuestionCapture } from '../hooks/questions'
import { sha256 } from '../hooks/sha256'
import { timeStretches, untilQuiet } from './fixtures/big-board'
import { finished, reopened } from './fixtures/question-files'
import { engineBeneath, FILE, INBOX, makeWorld } from './fixtures/pane-world'
import type { World } from './fixtures/pane-world'

// A session start on a board with thousands of question files beside it, and the inbox looks
// after it (#416). Imports only what main already had, so the same file times main too. All data
// is made up.
const english = { HOME: '/home/me', LANG: 'en_US.UTF-8' }
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const START = { cwd: '/work/persona_framework', surface: 'terminal' as const, isInteractive: true }
const QUESTION_FILE = /-questions-(?:source|retired|consumed)-[a-f0-9]{64}\.json$/
// Claude Code unloads a mod whose worker has not answered its heartbeat for 5 s (#371). A wait
// for quiet this long sees any stretch up to it end, so none is cut off by the test's own wait.
const QUIET_MS = 5000

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

test('a session start on a board with 300 waiting questions and 5,500 old copies, and the inbox looks that keep 30 new questions, never go a second without a trip to the host', { timeoutMs: 600_000 }, async ($, on) => {
  const board = `## demo\n${Array.from({ length: 300 }, (_, n) => block(`b0${n.toString(16).padStart(6, '0')}`, `- [?] Publish plan number ${n}, OK?`)).join('')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  world.reply = () => 'TITLE: Synthetic release\nCONTEXT: Inbox turns\nDONE: Prepared the change\nNEXT: Publish it\nASK: -'
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
  // 30 turns from 30 sessions, each ending on a question: three looks at the inbox, ten turns each.
  for (let n = 0; n < 30; n++) {
    const body = JSON.stringify({ session_id: `synthetic-session-${n}`, cwd: '/work/demo', prompt: 'Synthetic request', last_assistant_message: `Synthetic change ${n} is ready. Publish it to the synthetic staging board, OK?` })
    put(world, `${INBOX}/codex-turn-${1_760_000_000 + n}-1.json`, body, 7_000 + n)
  }
  const before = new Set([...world.files.keys()].filter(path => QUESTION_FILE.test(path)))
  expect(before.size).toBe(5800)
  world.written = []
  const timing = timeStretches(on)
  const clock = engineBeneath(timing.on, world)
  timing.begin()
  await $.session.start(START)
  await untilQuiet(timing.stretches, QUIET_MS)
  timing.stop()
  // Each look, five seconds apart, and the work it leaves running. Timing stops while the test
  // waits, so the wait is not counted as the module's.
  const fromInbox = (): number => (parseQuestions(world.files.get(questionsPath(FILE)) ?? '')?.records ?? []).filter(record => record.source?.kind === 'inbox').length
  for (let look = 0; look < 6 && fromInbox() < 30; look++) {
    timing.begin()
    await clock.advance(5000)
    await untilQuiet(timing.stretches, QUIET_MS)
    timing.stop()
  }
  const { longest, at } = timing.stretches
  console.log(`longest stretch without a host call: ${Math.round(longest)} ms, ${at}`)
  // The questions of the inbox reached the ledger within the timed looks.
  expect(fromInbox()).toBe(30)
  expect(longest).toBeLessThan(1000)
  // No copy the board already had was written again.
  expect(world.written.filter(path => before.has(path))).toEqual([])
})

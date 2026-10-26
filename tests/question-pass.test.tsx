import { expect, test } from 'claude-code/testing'
import { copiesToKeep, identitiesToRetire, parseQuestions, questionProofJson, questionProofPath, questionScope, questionsJson, questionsPath, withCaptures } from '../hooks/questions'
import type { QuestionCapture, QuestionRecord } from '../hooks/questions'
import { sha256 } from '../hooks/sha256'
import { finished, held, ledgerOf, question, reopened } from './fixtures/question-files'
import { engineBeneath, FILE, INBOX, makeWorld } from './fixtures/pane-world'
import { timeStretches, untilQuiet } from './fixtures/big-board'
import type { World } from './fixtures/pane-world'

// A question pass on a board with thousands of questions and question copies beside it (#416).
// All data is made up.
const english = { HOME: '/home/me', LANG: 'en_US.UTF-8' }
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const START = { cwd: '/work/persona_framework', surface: 'terminal' as const, isInteractive: true }

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
  // An answered copy already among the files is not written again (#414).
  const onDisk = copies.filter(copy => copy.disposition === 'resolved').slice(0, 10).map(copy => ({ version: 1 as const, disposition: 'resolved' as const, record: copy.record }))
  expect(copiesToKeep(current, observed, [...captures, ...onDisk]).filter(copy => copy.disposition === 'resolved').map(copy => copy.record.id)).toEqual(ids('resolved').slice(10))
  expect(retired).toEqual(open.filter((_, n) => n % 10 === 0).map(record => record.id))
  // A question whose retirement proof is already kept is left out.
  const proven = retired.slice(0, 40).map(id => sha256(id))
  expect(identitiesToRetire(current, observed, [], proven)).toEqual(retired.slice(40))
})

// Assigned in place: thousands of files spread into a new object each would cost seconds.
const put = (world: World, path: string, text: string, mtime: number): void => {
  world.files.set(path, text)
  world.mtimes ??= {}
  world.mtimes[path] = mtime
}
const block = (session: string, steps: string): string =>
  `<!-- auto session=${session} agent=codex state=waiting updated=${new Date(NOW - HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z')} -->\n### Synthetic plan ${session}\n> Context: Synthetic data.\n${steps}\n<!-- /auto session=${session} -->\n`

test('question passes over a board whose retirement proofs all exist read each proof once, and neither write a proof nor ask whether one exists', { timeoutMs: 240_000 }, async ($, on) => {
  const board = `## demo\n${block('a1b2c302', '- [~] Work')}`
  const world = makeWorld([[FILE, board]])
  world.env = english
  // Every path the mod asks the host whether it exists.
  const asked: string[] = []
  const watched = ((...args: unknown[]) => {
    const handler = args.at(-1)
    if (args[0] !== 'fs.exists' || typeof handler !== 'function') return Reflect.apply(on, undefined, args)
    return Reflect.apply(on, undefined, [...args.slice(0, -1), (...inner: unknown[]) => {
      const event = inner[1] as { path?: unknown } | undefined
      if (typeof event?.path === 'string') asked.push(event.path)
      return Reflect.apply(handler, undefined, inner)
    }])
  }) as typeof on
  const clock = engineBeneath(watched, world)
  // 300 questions answered on this block and gone from it: every pass finds them again as ones
  // to retire, and each already has its retirement proof.
  const scope = questionScope('demo', 'codex', 'a1b2c302')
  const gone = Array.from({ length: 300 }, (_, n): QuestionRecord => {
    const words = `Synthetic old question ${n + 1}?`
    const record = finished(n + 1)
    return { ...record, id: `question:${sha256(JSON.stringify([scope, words, 1, 1, record.incarnation]))}:${n + 1}`, scope, words, source: { ...record.source!, session: 'a1b2c302', text: words } }
  })
  put(world, questionsPath(FILE), questionsJson(ledgerOf(...gone)), 1)
  const proofs = gone.map((record, n) => {
    const path = questionProofPath(FILE, 'retired', sha256(record.id))
    put(world, path, questionProofJson('retired', sha256(record.id)), 10 + n)
    return path
  })
  world.reads = []
  world.written = []
  await $.session.start(START)
  await clock.advance(10_000)
  // The first look reads each proof; the passes after it trust that look and never check again.
  // Keeping a proof again costs three trips to the host, the first asking whether it exists.
  const counts = new Map<string, number>()
  for (const path of world.reads.filter(one => proofs.includes(one))) counts.set(path, (counts.get(path) ?? 0) + 1)
  expect(counts.size).toBe(300)
  expect(Math.max(...counts.values())).toBe(1)
  expect(world.written.filter(path => proofs.includes(path))).toEqual([])
  expect(asked.filter(path => proofs.includes(path))).toEqual([])
})

test('a look at the inbox that takes questions from ten sessions keeps them all in one question pass', { timeoutMs: 240_000 }, async ($, on) => {
  const world = makeWorld([[FILE, `## demo\n${block('a1b2c302', '- [~] Work')}`]])
  world.env = english
  world.reply = () => 'TITLE: Synthetic release\nCONTEXT: Inbox turns\nDONE: Prepared the change\nNEXT: Publish it\nASK: -'
  const timing = timeStretches(on)
  const clock = engineBeneath(timing.on, world)
  for (let n = 0; n < 10; n++) {
    const body = JSON.stringify({ session_id: `synthetic-session-${n}`, cwd: '/work/demo', prompt: 'Synthetic request', last_assistant_message: `Synthetic change ${n} is ready. Publish it to the synthetic staging board, OK?` })
    put(world, `${INBOX}/codex-turn-${1_760_000_000 + n}-1.json`, body, 1_000 + n)
  }
  const fromInbox = (): number => (parseQuestions(world.files.get(questionsPath(FILE)) ?? '')?.records ?? []).filter(record => record.source?.kind === 'inbox').length
  await $.session.start(START)
  // The polls before the look, then the look itself, five seconds in.
  await clock.advance(4000)
  world.written = []
  // The look's work runs on after the clock call: the count waits until the module makes no
  // more calls beneath it.
  timing.begin()
  await clock.advance(1000)
  await untilQuiet(timing.stretches, 1000)
  timing.stop()
  expect(fromInbox()).toBe(10)
  expect(Object.keys(world.store?.inboxDone as Record<string, string>)).toHaveLength(10)
  // The ledger is written to a temporary file and moved into place: once when the look's blocks
  // are settled and polled, once when its questions are kept. Two passes for each session, each
  // seconds long on a big board, wrote it twenty times.
  expect(world.written.filter(path => path.startsWith(`${questionsPath(FILE)}.tmp-`))).toHaveLength(2)
})

test('a look whose one question the store will not keep sends back only the run that asked it, and the other run is done', { timeoutMs: 240_000 }, async ($, on) => {
  const world = makeWorld([[FILE, `## demo\n${block('a1b2c302', '- [~] Work')}`]])
  world.env = english
  world.reply = () => 'TITLE: Synthetic release\nCONTEXT: Inbox turns\nDONE: Prepared the change\nNEXT: Publish it\nASK: -'
  const timing = timeStretches(on)
  const clock = engineBeneath(timing.on, world)
  const names = [0, 1].map(n => `codex-turn-${1_760_000_000 + n}-1.json`)
  names.forEach((name, n) => put(world, `${INBOX}/${name}`, JSON.stringify({ session_id: `synthetic-session-${n}`, cwd: '/work/demo', prompt: 'Synthetic request', last_assistant_message: `Synthetic change ${n} is ready. Publish it to the synthetic staging board, OK?` }), 1_000 + n))
  // Every time, the store refuses the preview of the first question it is asked to keep.
  let refused: string | undefined
  world.failStore = (operation, key) => {
    if (operation !== 'set' || !key.startsWith('pendingInboxQuestion:')) return false
    refused ??= key
    return key === refused
  }
  await $.session.start(START)
  timing.begin()
  await clock.advance(5000)
  await untilQuiet(timing.stretches, 1000)
  timing.stop()
  expect(refused).toBeDefined()
  const done = names.filter(name => (world.store?.inboxDone as Record<string, string>)[name] !== undefined)
  const failed = (world.store?.inboxFailed ?? {}) as Record<string, string>
  const held = names.filter(name => failed[name] !== undefined)
  // One run is done: its file is gone, and its question went into the pass from the turn it took.
  // The other question is in the ledger only as it was seen in its inbox file, before any look.
  expect(done).toHaveLength(1)
  expect([...world.files.keys()].filter(path => path.includes(done[0]!.replace(/\.json$/, '')))).toEqual([])
  const taken = (parseQuestions(world.files.get(questionsPath(FILE)) ?? '')?.records ?? [])
    .flatMap(record => record.producerSources ?? [])
    .map(source => JSON.parse(source) as { sources?: string[]; at: number })
    .filter(turn => turn.at > 1_000_000)
    .flatMap(turn => turn.sources ?? [])
  expect(taken).toEqual([done[0]!])
  // Only the other is sent back, to be taken again once its claim runs out.
  expect(held).toHaveLength(1)
  expect(held[0]).not.toBe(done[0])
  expect(failed[held[0]!]).toMatch(/^1:\d+:PENDING_QUESTION_NOT_KEPT$/)
  expect([...world.files.keys()].filter(path => path.startsWith(`${INBOX}/`) && path.includes(held[0]!.replace(/\.json$/, '')))).toHaveLength(1)
})

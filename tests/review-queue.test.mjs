import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classify, fetchQueue, formatQueue, main, parseArgs } from '../scripts/review-queue.mjs'

const head = 'abcdef0123456789abcdef0123456789abcdef01'
const oldHead = '1234567890123456789012345678901234567890'
const now = '2026-10-20T12:00:00Z'
const pull = (number, fields = {}) => ({
  number, title: `Synthetic change ${number}`, author: { login: 'alice' }, body: '', isDraft: false,
  headRefOid: head, mergeStateStatus: 'CLEAN', additions: 10, deletions: 5, ...fields,
})
const comment = (body, created_at = '2026-10-20T09:00:00Z', id = 1) => ({ body, created_at, id })
const ready = (sha = head, at, id) => comment(`Ready for review ${sha}`, at, id)
const verdict = (kind, sha = head, at, id) => comment(`Review: ${kind} ${sha}`, at, id)

test('a pull request whose Ready comment is for its head and has no verdict after it waits on a reviewer', () => {
  const prs = [pull(1, { body: 'Author: `bot-one`, branch' })]
  const comments = { 1: [ready(head.slice(0, 7))] }
  const before = structuredClone({ prs, comments })
  const queue = classify(prs, comments, now)
  assert.equal(queue.needsReviewer.length, 1)
  assert.equal(queue.needsReviewer[0].author, 'bot-one')
  assert.equal(queue.needsReviewer[0].hours, 3)
  assert.deepEqual(queue.approved, [])
  assert.deepEqual({ prs, comments }, before)
})

test('a Ready comment for an older head does not put a pull request in the reviewer queue', () => {
  const queue = classify([pull(1)], { 1: [ready(oldHead)] }, now)
  assert.deepEqual(queue.needsReviewer, [])
  assert.equal(queue.waitingForAuthor[0].number, 1)
})

test('a verdict for an older head does not count against a Ready for the current head', () => {
  const queue = classify([pull(1)], { 1: [ready(head, '2026-10-20T08:00:00Z'), verdict('APPROVE', oldHead, '2026-10-20T10:00:00Z')] }, now)
  assert.deepEqual(queue.needsReviewer.map(item => item.number), [1])
  assert.deepEqual(queue.approved, [])
})

test('a conflicted or behind pull request is listed as needing main before anything else', () => {
  const prs = [pull(1, { mergeStateStatus: 'DIRTY' }), pull(2, { mergeStateStatus: 'BEHIND' })]
  const comments = { 1: [ready()], 2: [ready(), verdict('APPROVE', head, '2026-10-20T10:00:00Z')] }
  const queue = classify(prs, comments, now)
  assert.deepEqual(queue.needsMain.map(item => item.number), [1, 2])
  assert.equal(queue.needsMain[0].detail, 'no CI runs until main is merged')
  assert.deepEqual(queue.needsReviewer, [])
  assert.deepEqual(queue.approved, [])
  assert.match(formatQueue(queue), /^No pull requests need a reviewer\./)
})

test('the reviewer queue lists the smallest pull request first and marks one Ready for more than four hours', () => {
  const prs = [pull(1, { additions: 30 }), pull(2, { additions: 3 }), pull(3, { additions: 3 })]
  const comments = { 1: [ready(head, '2026-10-20T06:00:00Z')], 2: [ready(head, '2026-10-20T08:00:00Z')], 3: [ready(head, '2026-10-20T07:59:59Z')] }
  const queue = classify(prs, comments, now)
  assert.deepEqual(queue.needsReviewer.map(item => item.number), [3, 2, 1])
  assert.deepEqual(queue.needsReviewer.map(item => item.isOverFourHours), [true, false, true])
  assert.match(formatQueue(queue), /#3  8 lines  alice  Synthetic change 3  Ready 4\.0 h over 4 h/)
})

test('a Reviewing comment after the Ready names who took the review', () => {
  const comments = { 1: [comment('Reviewing: alice', '2026-10-20T07:00:00Z'), ready(head, '2026-10-20T08:00:00Z'), comment('Reviewing: bot-one', '2026-10-20T09:00:00Z')] }
  const queue = classify([pull(1)], comments, now)
  assert.equal(queue.needsReviewer[0].takenBy, 'bot-one')
  assert.match(formatQueue(queue), /taken by bot-one/)
})

test('drafts are counted, not listed', () => {
  const queue = classify([pull(1, { isDraft: true }), pull(2, { isDraft: true, mergeStateStatus: 'DIRTY' })], { 1: [ready()] }, now)
  assert.equal(queue.drafts, 2)
  assert.deepEqual(queue.needsReviewer, [])
  assert.deepEqual(queue.needsMain, [])
  assert.equal(formatQueue(queue), 'No pull requests need a reviewer.\nDrafts: 2')
})

test('current-head verdicts determine approval or author changes and a new Ready starts another review', () => {
  const prs = [pull(1), pull(2), pull(3), pull(4), pull(5)]
  const comments = {
    1: [ready(head, '2026-10-20T08:00:00Z'), verdict('APPROVE', head, '2026-10-20T09:00:00Z')],
    2: [ready(head, '2026-10-20T08:00:00Z'), verdict('REQUEST CHANGES', head, '2026-10-20T09:00:00Z')],
    3: [ready(head, '2026-10-20T10:00:00Z'), verdict('REQUEST CHANGES', head, '2026-10-20T09:00:00Z')],
    4: [verdict('REQUEST CHANGES', oldHead)],
    5: [verdict('APPROVE', head)],
  }
  const queue = classify(prs, comments, now)
  assert.deepEqual(queue.needsReviewer.map(item => item.number), [3])
  assert.deepEqual(queue.approved.map(item => item.number), [1, 5])
  assert.deepEqual(queue.waitingForAuthor.map(item => item.number), [2, 4])
  assert.ok(queue.waitingForAuthor.every(item => item.detail === 'changes requested'))
})

test('the latest Ready and later take are selected in comment time order', () => {
  const comments = { 1: [
    comment('Reviewing: bot-one', '2026-10-20T11:00:00Z', 4),
    ready(head, '2026-10-20T10:00:00Z', 3),
    verdict('APPROVE', head, '2026-10-20T09:00:00Z', 2),
    ready(head, '2026-10-20T08:00:00Z', 1),
  ] }
  const queue = classify([pull(1)], comments, now)
  assert.equal(queue.needsReviewer[0].hours, 2)
  assert.equal(queue.needsReviewer[0].takenBy, 'bot-one')
})

test('only a complete 7 to 40 character head prefix in a starting Ready comment counts', () => {
  const prs = [pull(1), pull(2), pull(3), pull(4), pull(5), pull(6)]
  const comments = {
    1: [ready(head.slice(0, 6))],
    2: [ready(`${head}a`)],
    3: [comment(`Earlier text\nReady for review ${head}`)],
    4: [comment(`Ready for review \`${head.slice(0, 7).toUpperCase()}\``)],
    5: [ready(head.slice(0, 40))],
    6: [ready(head.slice(0, 7)), ready(oldHead, '2026-10-20T10:00:00Z')],
  }
  const queue = classify(prs, comments, now)
  assert.deepEqual(queue.needsReviewer.map(item => item.number), [4, 5, 6])
  assert.deepEqual(queue.waitingForAuthor.map(item => item.number), [1, 2, 3])
})

test('the text report cuts titles and cleans GitHub text before printing', () => {
  const prs = [pull(1, { title: `${'x'.repeat(75)}\n ghp_abc123`, body: 'Author: bot-one, branch' })]
  const comments = { 1: [ready(), comment('Reviewing: alice\u001b[31m', '2026-10-20T10:00:00Z')] }
  const text = formatQueue(classify(prs, comments, now))
  assert.match(text, /Needs a reviewer \(1\)/)
  assert.ok(text.includes('x'.repeat(70)))
  assert.ok(!text.includes('x'.repeat(71)))
  assert.ok(!text.includes('\u001b'))
  assert.ok(!text.includes('ghp_abc123'))
  assert.ok(text.endsWith('Drafts: 0'))
})

test('JSON output cleans GitHub text and has the requested group keys', () => {
  const output = []
  const status = main(['--json'], {
    fetch: () => ({ prs: [pull(1, { title: 'hello\nworld ghp_abc123' })], commentsByNumber: { 1: [ready()] } }),
    now: () => now, log: text => output.push(text), error: text => assert.fail(text),
  })
  assert.equal(status, 0)
  const queue = JSON.parse(output[0])
  assert.deepEqual(Object.keys(queue), ['needsReviewer', 'needsMain', 'approved', 'waitingForAuthor', 'drafts'])
  assert.equal(queue.needsReviewer[0].title, 'hello world <token>')
})

test('argument parsing rejects invalid and repeated options and help does not fetch', () => {
  assert.deepEqual(parseArgs([]), { repo: 'WenyuChiou/agent-board', isJson: false, isHelp: false })
  assert.deepEqual(parseArgs(['--repo', 'alice/board', '--json']), { repo: 'alice/board', isJson: true, isHelp: false })
  for (const args of [['--json', '--json'], ['--repo'], ['--repo', '../board'], ['--repo', 'alice/..'], ['--other']]) assert.throws(() => parseArgs(args))
  const output = []
  assert.equal(main(['--help'], { fetch: () => assert.fail('help fetched data'), log: text => output.push(text) }), 0)
  assert.match(output[0], /^Usage: node scripts\/review-queue\.mjs/)
})

test('fetching requests pull request descriptions and reads paginated comment records without network', () => {
  const calls = []
  const run = (program, args, options) => {
    calls.push({ program, args, options })
    if (args[0] === 'pr') return JSON.stringify([pull(1)])
    return [ready(), verdict('APPROVE', oldHead)].map(item => JSON.stringify(item)).join('\n') + '\n'
  }
  const data = fetchQueue({ repo: 'alice/board' }, { run })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.program === 'gh' && call.options.maxBuffer > 0))
  assert.equal(calls[0].args[calls[0].args.indexOf('--json') + 1].split(',').includes('body'), true)
  assert.deepEqual(calls[0].args.slice(-2), ['--repo', 'alice/board'])
  assert.ok(calls[1].args.includes('--paginate'))
  assert.equal(calls[1].args.at(-1), 'repos/alice/board/issues/1/comments?per_page=100')
  assert.equal(data.commentsByNumber[1].length, 2)
})

test('a GitHub failure is reported without printing raw diagnostics', () => {
  const errors = []
  const status = main([], { fetch: () => { throw new Error('ghp_abc123') }, error: text => errors.push(text) })
  assert.equal(status, 1)
  assert.equal(errors.length, 1)
  assert.ok(!errors[0].includes('ghp_abc123'))
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classify, collaboratorLogins, fetchContext, fetchQueue, findStaleLanes, formatLanes, formatQueue, loadBundleSources, loadReviewers,
  main, parseArgs, parseNotice, parseReviewers, parseWorktrees, readAway, readClaims,
} from '../scripts/review-queue.mjs'

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
const by = (login, item) => ({ ...item, user: { login } })
// The extra GitHub lookups and the bundle sources, empty: a test of the queue alone must not reach for them.
const noContext = () => ({ roadmapComments: [], collaborators: [], claimed: [], notes: [] })
const noBundle = () => ({ sources: new Set(), note: null })
const quiet = { context: noContext, bundle: noBundle }

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

test('a conflicted pull request is listed as needing main before anything else', () => {
  const prs = [pull(1, { mergeStateStatus: 'DIRTY' }), pull(2, { mergeStateStatus: 'DIRTY' })]
  const comments = { 1: [ready()], 2: [ready(), verdict('APPROVE', head, '2026-10-20T10:00:00Z')] }
  const queue = classify(prs, comments, now)
  assert.deepEqual(queue.needsMain.map(item => item.number), [1, 2])
  assert.equal(queue.needsMain[0].detail, 'no CI runs until main is merged')
  assert.deepEqual(queue.needsReviewer, [])
  assert.deepEqual(queue.approved, [])
  assert.match(formatQueue(queue), /^No pull requests need a reviewer\./)
})

test('a pull request that is only behind main is queued for review like any other', () => {
  const prs = [pull(1, { mergeStateStatus: 'BEHIND' }), pull(2, { mergeStateStatus: 'BEHIND' })]
  const comments = { 1: [ready()], 2: [ready(), verdict('APPROVE', head, '2026-10-20T10:00:00Z')] }
  const queue = classify(prs, comments, now)
  assert.deepEqual(queue.needsMain, [])
  assert.deepEqual(queue.needsReviewer.map(item => item.number), [1])
  assert.deepEqual(queue.approved.map(item => item.number), [2])
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
    ...quiet, lanes: () => ({ stale: [], notes: [] }),
    now: () => now, log: text => output.push(text), error: text => assert.fail(text),
  })
  assert.equal(status, 0)
  const queue = JSON.parse(output[0])
  assert.deepEqual(Object.keys(queue), ['needsReviewer', 'needsMain', 'approved', 'approvedNow', 'approvedOneAtATime', 'waitingForAuthor', 'drafts', 'staleLanes', 'away', 'expiredClaims'])
  assert.equal(queue.needsReviewer[0].title, 'hello world <token>')
})

test('argument parsing rejects invalid and repeated options and help does not fetch', () => {
  assert.deepEqual(parseArgs([]), { repo: 'WenyuChiou/agent-board', roadmap: 209, isJson: false, isHelp: false })
  assert.deepEqual(parseArgs(['--repo', 'alice/board', '--json']), { repo: 'alice/board', roadmap: 209, isJson: true, isHelp: false })
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
  assert.equal(calls[0].args[calls[0].args.indexOf('--json') + 1].split(',').includes('files'), true)
  assert.equal(calls[0].args[calls[0].args.indexOf('--json') + 1].split(',').includes('reviews'), true)
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

// The map the team's reviewers.json holds, written out with synthetic reviewer names so the tests do not move when its names do.
const team = {
  maxOpenReviews: 2,
  rules: [
    { authors: ['claude', 'codex'], reviewers: ['bot-one', 'bot-two'] },
    { authors: ['bot-one'], reviewers: ['claude', 'bot-two'] },
    { authors: ['*'], reviewers: ['claude', 'bot-one', 'bot-two'] },
  ],
}
const byAgent = agent => pull(1, { body: `Author: ${agent}, branch` })
const taking = (name, at = '2026-10-20T08:00:00Z') => comment(`Reviewing: ${name}`, at)
const answered = name => comment(`Review: APPROVE ${head} by ${name}`, '2026-10-20T10:00:00Z')

test('the suggested reviewer is never the agent that wrote the pull request', () => {
  const everyone = { maxOpenReviews: 2, rules: [{ authors: ['*'], reviewers: ['claude', 'bot-one'] }] }
  const prs = [pull(1, { body: 'Author: claude (PM), branch' }), pull(2, { body: 'Author: bot-one, branch' })]
  const comments = { 1: [ready(head, '2026-10-20T09:00:00Z')], 2: [ready(head, '2026-10-20T09:00:00Z')] }
  const queue = classify(prs, comments, now, everyone)
  assert.deepEqual(queue.needsReviewer.map(item => [item.number, item.suggested]), [[1, 'bot-one'], [2, 'claude']])
  assert.match(formatQueue(queue), /#1 .*suggested: bot-one\n( {4}.*\n)*#2 .*suggested: claude\n/)
})

test('a reviewer already holding two open reviews is not suggested', () => {
  const target = [byAgent('claude')]
  const open = { 2: [taking('bot-one')], 3: [taking('Bot-One (PM)')] }
  const done = { 4: [taking('bot-one'), answered('bot-one')] }
  const prs = [...target, pull(2), pull(3, { isDraft: true }), pull(4)]
  const busy = classify(prs, { 1: [ready()], ...open, ...done }, now, team)
  assert.equal(busy.needsReviewer[0].suggested, 'bot-two')
  // A Reviewing comment answered by a later verdict from the same name is no longer open.
  const free = classify(prs.filter(pr => pr.number !== 3), { 1: [ready()], 2: open[2], ...done }, now, team)
  assert.equal(free.needsReviewer[0].suggested, 'bot-one')
})

test('a pull request Ready for more than four hours suggests the next reviewer and says it escalated', () => {
  const prs = [byAgent('codex'), pull(2, { body: 'Author: codex, branch', additions: 20 })]
  const comments = { 1: [ready(head, '2026-10-20T07:00:00Z')], 2: [ready(head, '2026-10-20T09:00:00Z')] }
  const queue = classify(prs, comments, now, team)
  assert.deepEqual(queue.needsReviewer.map(item => [item.number, item.suggested, item.isEscalated]), [[1, 'bot-two', true], [2, 'bot-one', false]])
  const text = formatQueue(queue)
  assert.match(text, /#1 .*over 4 h {2}suggested: bot-two escalated\n/)
  assert.match(text, /#2 .*suggested: bot-one\n/)
  // With only one name left there is nothing to skip to, so that name is kept and nothing counts as skipped.
  const busy = classify([byAgent('codex'), pull(3), pull(4)], { 1: comments[1], 3: [taking('bot-one')], 4: [taking('bot-one')] }, now, team)
  assert.deepEqual([busy.needsReviewer[0].suggested, busy.needsReviewer[0].isEscalated], ['bot-two', false])
})

test('an author with no rule of its own gets the catch-all reviewers', () => {
  const prs = [byAgent('dot (Muse)'), pull(2, { author: { login: 'alice' } })]
  const queue = classify(prs, { 1: [ready()], 2: [ready()] }, now, team)
  assert.deepEqual(queue.needsReviewer.map(item => item.suggested), ['claude', 'claude'])
  // The first rule that matches wins, even when a later one names the author.
  const reordered = { ...team, rules: [team.rules[2], team.rules[0]] }
  assert.equal(classify([byAgent('codex')], { 1: [ready()] }, now, reordered).needsReviewer[0].suggested, 'claude')
})

test('a missing reviewers file prints one note and suggests nobody', () => {
  const unreadable = () => loadReviewers({ read: () => { throw Object.assign(new Error('ENOENT: C:\\private\\reviewers.json'), { code: 'ENOENT' }) } })
  assert.equal(unreadable().map, null)
  assert.equal(loadReviewers({ read: () => '{ not json' }).map, null)
  assert.equal(loadReviewers({ read: () => '{"rules":[]}' }).map, null)
  const fetch = () => ({ prs: [pull(1)], commentsByNumber: { 1: [ready()] } })
  const text = []
  assert.equal(main([], { fetch, ...quiet, lanes: () => ({ stale: [], notes: [] }), reviewers: unreadable, now: () => now, log: line => text.push(line), error: line => assert.fail(line) }), 0)
  assert.equal(text[0].split('\n').filter(line => line.startsWith('Note:')).length, 1)
  assert.ok(!text[0].includes('suggested:'))
  assert.ok(!text[0].includes('private'))
  const json = []
  assert.equal(main(['--json'], { fetch, ...quiet, lanes: () => ({ stale: [], notes: [] }), reviewers: unreadable, now: () => now, log: line => json.push(line), error: line => assert.fail(line) }), 0)
  const queue = JSON.parse(json[0])
  assert.equal('suggested' in queue.needsReviewer[0], false)
  assert.equal(queue.notes.length, 1)
})

test('the reviewers file in the repository is readable and ends with a catch-all rule', () => {
  const { map, note } = loadReviewers()
  assert.equal(note, null)
  assert.ok(map.maxOpenReviews >= 1)
  assert.deepEqual(map.rules.at(-1).authors, ['*'])
})

test('approved pull requests touching the bundle or the string tables merge one at a time and the rest merge smallest first', () => {
  const touching = (...paths) => ({ files: paths.map(path => ({ path, additions: 1, deletions: 0 })) })
  const prs = [
    pull(1, { additions: 30, deletions: 10, ...touching('hooks/board-script-1.ts', 'scripts/x.mjs') }),
    pull(2, { additions: 20, deletions: 10, ...touching('docs/a.md') }),
    pull(3, { additions: 3, deletions: 2, ...touching('scripts/b.mjs') }),
    pull(4, { additions: 5, deletions: 5, ...touching('hooks/strings-en.ts') }),
    pull(5, { additions: 10, deletions: 5, ...touching('hooks/i18n.ts', 'hooks/strings-zh-cn.ts') }),
    pull(6, { additions: 15, deletions: 5, ...touching('hooks/register.tsx') }),
    pull(7, { additions: 1, deletions: 1, ...touching('hooks/board-script.ts') }),
  ]
  const readyAt = { 1: '08:00', 2: '05:00', 3: '05:00', 4: '06:00', 5: '07:00', 6: '05:00', 7: '09:00' }
  const comments = Object.fromEntries(prs.map(pr => [pr.number, [ready(head, `2026-10-20T${readyAt[pr.number]}:00Z`), verdict('APPROVE', head, '2026-10-20T10:00:00Z')]]))
  const queue = classify(prs, comments, now)
  assert.deepEqual(queue.approvedNow.map(item => item.number), [3, 6, 2])
  assert.deepEqual(queue.approvedOneAtATime.map(item => item.number), [4, 5, 1, 7])
  assert.deepEqual(queue.approved.map(item => item.number), [1, 2, 3, 4, 5, 6, 7])
  const order = formatQueue(queue).split('\n').filter(line => /^(#\d|Merge now|One at a time)/.test(line)).map(line => line.slice(0, 3))
  assert.deepEqual(order, ['Mer', '#3 ', '#6 ', '#2 ', 'One', '#4 ', '#5 ', '#1 ', '#7 '])
  // Without a file list a pull request cannot be shown to be clear of the shared files.
  const unknown = classify([pull(8)], { 8: [ready(), verdict('APPROVE')] }, now)
  assert.deepEqual([unknown.approvedNow.length, unknown.approvedOneAtATime.length], [0, 1])
})

const porcelain = [
  'worktree C:/repo\nHEAD aaa\nbranch refs/heads/main',
  'worktree C:/wt/old\nHEAD bbb\nbranch refs/heads/lane/old',
  'worktree C:/wt/fresh\nHEAD ccc\nbranch refs/heads/lane/fresh',
  'worktree C:/wt/pr\nHEAD ddd\nbranch refs/heads/lane/has-pr',
  'worktree C:/wt/empty\nHEAD eee\nbranch refs/heads/lane/empty',
  'worktree C:/wt/detached\nHEAD fff\ndetached',
].join('\n\n') + '\n'
const laneNow = '2026-10-30T12:00:00Z'
const secondsAgo = hours => String(Math.floor((Date.parse(laneNow) - hours * 3600000) / 1000))

test('worktree listing keeps detached worktrees and marks them', () => {
  assert.deepEqual(parseWorktrees(porcelain).map(lane => lane.branch), ['main', 'lane/old', 'lane/fresh', 'lane/has-pr', 'lane/empty', null])
  assert.equal(parseWorktrees(porcelain).at(-1).isDetached, true)
})

test('a lane older than 2 hours with no open pull request is listed with its age', () => {
  const run = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'worktree') return porcelain
    if (cmd === 'git') return { 'main..lane/old': secondsAgo(5), 'main..lane/fresh': secondsAgo(1), 'main..lane/has-pr': secondsAgo(9), 'main..lane/empty': '', 'main..fff': secondsAgo(1) }[args.at(-1)] + '\n'
    return JSON.stringify(args[args.indexOf('--head') + 1] === 'lane/has-pr' ? [{ number: 7 }] : [])
  }
  const result = findStaleLanes({ repo: 'a/b' }, { run, now: () => laneNow, birth: () => Date.parse(laneNow) - 3 * 3600000 })
  assert.deepEqual(result.stale.map(lane => [lane.branch, lane.hours]), [['lane/old', 5], ['lane/empty', 3]])
  assert.equal(formatLanes(result), 'Lanes over 2 h without a pull request (2)\nlane/old  5.0 h  no PR\nlane/empty  3.0 h  no PR')
})

test('a failed pull request lookup still lists the lane and adds a note', () => {
  const run = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'worktree') return porcelain
    if (cmd === 'git') return secondsAgo(4) + '\n'
    throw new Error('ghp_abc123')
  }
  const result = findStaleLanes({ repo: 'a/b' }, { run, now: () => laneNow })
  assert.equal(result.stale.length, 5)
  assert.match(formatLanes(result), /lane\/old {2}4\.0 h {2}no PR \(unchecked\)/)
  assert.match(formatLanes(result), /Note: lane\/old: pull request lookup failed/)
  assert.ok(!formatLanes(result).includes('ghp_abc123'))
})

test('a failed worktree listing prints a note and the queue still prints', () => {
  const result = findStaleLanes({ repo: 'a/b' }, { run: () => { throw new Error('boom') }, now: () => laneNow })
  assert.equal(formatLanes(result), 'Note: lane check skipped: git worktree list failed')
  const output = []
  main([], { fetch: () => ({ prs: [], commentsByNumber: {} }), ...quiet, lanes: () => { throw new Error('x') }, now: () => now, log: text => output.push(text) })
  assert.match(output[0], /Drafts: 0\nNote: lane check skipped: lookup failed$/)
})

const fakeRun = listing => (cmd, args) => {
  if (cmd === 'git' && args[0] === 'worktree') return listing
  if (cmd === 'git') return secondsAgo(6) + '\n'
  return '[]'
}

test('a detached lane older than 2 hours is listed without a branch', () => {
  const result = findStaleLanes({ repo: 'a/b' }, { run: fakeRun(porcelain), now: () => laneNow })
  assert.ok(formatLanes(result).split('\n').some(line => line === 'detached (detached)  6.0 h  detached, no branch'))
})

test('a main checkout on a detached HEAD does not hide the first lane', () => {
  const listing = ['worktree C:/repo\nHEAD aaa\ndetached', 'worktree C:/wt/first\nHEAD bbb\nbranch refs/heads/lane/first'].join('\n\n') + '\n'
  const result = findStaleLanes({ repo: 'a/b' }, { run: fakeRun(listing), now: () => laneNow })
  assert.deepEqual(result.stale.map(lane => lane.branch), ['lane/first'])
})

test('a folder time of 0 prints a note instead of a huge age', () => {
  const run = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'worktree') return porcelain
    if (cmd === 'git') return ''
    return '[]'
  }
  const result = findStaleLanes({ repo: 'a/b' }, { run, now: () => laneNow, birth: () => 0 })
  assert.deepEqual(result.stale, [])
  assert.match(formatLanes(result), /Note: lane.old: age unknown/)
})

// Review bots: Codex's state comment and Greptile's mention of the head.
const codexState = (sha, hasFindings, at, id, login = 'chatgpt-codex-connector[bot]') =>
  by(login, comment(`Codex review\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, has_unresolved_findings: hasFindings } })} -->`, at, id))
const botsOf = (items, fields) => classify([pull(1, fields)], { 1: [ready(), ...items] }, now).needsReviewer[0].bots

test('the newest Codex review state decides whether the head is clean, open, stale or not reviewed', () => {
  const stateOf = (...items) => botsOf(items).codex
  assert.equal(stateOf(), 'none')
  assert.equal(stateOf(codexState(head, false, '2026-10-20T10:00:00Z', 2)), 'clean')
  assert.equal(stateOf(codexState(head.slice(0, 7), true, '2026-10-20T10:00:00Z', 2, 'chatgpt-codex-connector')), 'open')
  assert.equal(stateOf(codexState(oldHead, false, '2026-10-20T10:00:00Z', 2)), 'stale')
  // The newest comment wins, whatever order they are listed in; a state for an older head is stale even when an earlier one fits.
  const older = codexState(head, true, '2026-10-20T09:30:00Z', 2)
  assert.equal(stateOf(codexState(head, false, '2026-10-20T10:30:00Z', 3), older), 'clean')
  assert.equal(stateOf(codexState(oldHead, false, '2026-10-20T09:30:00Z', 2), codexState(head, true, '2026-10-20T10:30:00Z', 3)), 'open')
  assert.equal(stateOf(older, codexState(oldHead, false, '2026-10-20T10:30:00Z', 3)), 'stale')
})

test('a Codex state comment from someone else or with unreadable JSON is passed over', () => {
  const marker = json => by('chatgpt-codex-connector[bot]', comment(`<!-- codex-review-state:v1 ${json} -->`, '2026-10-20T11:00:00Z', 9))
  const clean = codexState(head, false, '2026-10-20T10:00:00Z', 2)
  assert.equal(botsOf([by('alice', comment(clean.body, '2026-10-20T10:00:00Z', 2))]).codex, 'none')
  const unreadable = ['{ not json', '{"code_review":{"commit_sha":"zzzzzzz","has_unresolved_findings":false}}', `{"code_review":{"commit_sha":"${head}"}}`, '{"code_review":null}']
  for (const json of unreadable) {
    assert.equal(botsOf([clean, marker(json)]).codex, 'clean', json)
    assert.equal(botsOf([marker(json)]).codex, 'none', json)
  }
})

test('Greptile shows as reviewed only when a comment or review of its own mentions the head', () => {
  const said = (login, body) => by(login, comment(body, '2026-10-20T10:00:00Z', 2))
  const isReviewed = (items, reviews) => botsOf(items, { reviews }).greptile
  assert.equal(isReviewed([]), false)
  assert.equal(isReviewed([said('greptile-apps[bot]', `Last reviewed commit: ${head.slice(0, 7)}`)]), true)
  assert.equal(isReviewed([said('Greptile-Apps', `reviewed ${head}`)]), true)
  assert.equal(isReviewed([said('greptile-apps[bot]', `reviewed ${oldHead}`)]), false)
  assert.equal(isReviewed([said('alice', `Greptile says ${head}`)]), false)
  assert.equal(isReviewed([], [{ author: { login: 'greptile-apps' }, body: '', commit: { oid: head } }]), true)
  assert.equal(isReviewed([], [{ author: { login: 'greptile-apps' }, body: `see ${head.slice(0, 10)}`, commit: { oid: oldHead } }]), true)
  assert.equal(isReviewed([], [{ author: { login: 'greptile-apps' }, body: 'looks fine', commit: { oid: oldHead } }]), false)
  assert.equal(isReviewed([], [{ author: { login: 'alice' }, body: '', commit: { oid: head } }]), false)
})

test('a missing bot review leaves a pull request where it was and the text shows what each bot said', () => {
  const prs = [pull(1), pull(2), pull(3), pull(4)]
  const comments = {
    1: [ready()],
    2: [ready(), verdict('APPROVE', head, '2026-10-20T10:00:00Z', 2), codexState(head, true, '2026-10-20T09:30:00Z', 3)],
    3: [ready(), codexState(head, false, '2026-10-20T10:00:00Z', 2), by('greptile-apps[bot]', comment(`Reviewed ${head.slice(0, 7)}`, '2026-10-20T10:00:00Z', 3))],
    4: [verdict('REQUEST CHANGES', head, '2026-10-20T10:00:00Z')],
  }
  const queue = classify(prs, comments, now)
  assert.deepEqual(queue.needsReviewer.map(item => item.number), [1, 3])
  assert.deepEqual(queue.approved.map(item => item.number), [2])
  assert.deepEqual(queue.waitingForAuthor.map(item => item.number), [4])
  assert.deepEqual(queue.needsReviewer[0].bots, { codex: 'none', greptile: false })
  const text = formatQueue(queue)
  assert.match(text, /\n#1 .*\n {4}codex: not on this head \(ask @codex review\)\n#3 /)
  assert.match(text, /\n#3 .*\n {4}codex: no findings {2}greptile: reviewed\n/)
  assert.match(text, /\n#2 .*\n {4}codex: findings open — answer each P0\/P1 before approving\n/)
  // Greptile is only named when it reviewed, and the author's own group shows no bot lines.
  assert.equal(text.split('\n').filter(line => line.includes('greptile')).length, 1)
  assert.ok(!/#4 .*\n {4}/.test(text))
})

test('the roadmap issue defaults to 209 and --roadmap changes it', () => {
  assert.equal(parseArgs(['--roadmap', '312']).roadmap, 312)
  for (const args of [['--roadmap'], ['--roadmap', '0'], ['--roadmap', 'x'], ['--roadmap', '-3'], ['--roadmap', '1', '--roadmap', '2']]) assert.throws(() => parseArgs(args), args.join(' '))
  let seen
  const status = main(['--roadmap', '312'], {
    fetch: () => ({ prs: [], commentsByNumber: {} }), context: options => { seen = options; return noContext() }, bundle: noBundle,
    lanes: () => ({ stale: [], notes: [] }), now: () => now, log: () => {},
  })
  assert.equal(status, 0)
  assert.equal(seen.roadmap, 312)
})

test('the extra lookups are three GitHub calls through the injected runner and read their answers', () => {
  const calls = []
  const run = (program, args) => {
    calls.push({ program, args })
    if (args[0] === 'issue') return JSON.stringify([{ number: 7, title: 'Synthetic', comments: [] }])
    if (args.at(-1).includes('/collaborators')) return 'Alice\nbob\n\ncarol\n'
    return JSON.stringify(by('bob', comment('Away: until 2026-10-22'))) + '\n'
  }
  const extra = fetchContext({ repo: 'alice/board', roadmap: 312 }, { run })
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.program === 'gh'))
  assert.equal(calls[0].args.at(-1), 'repos/alice/board/issues/312/comments?per_page=100')
  assert.equal(calls[1].args.at(-1), 'repos/alice/board/collaborators?per_page=100')
  assert.ok(calls[1].args.includes('.[] | select(.permissions.push or .permissions.admin) | .login'))
  assert.deepEqual(calls[2].args.slice(0, 6), ['issue', 'list', '--label', 'claimed', '--state', 'open'])
  assert.ok(calls[2].args.includes('number,title,comments'))
  assert.equal(extra.roadmapComments.length, 1)
  assert.deepEqual(extra.collaborators, ['Alice', 'bob', 'carol'])
  assert.deepEqual(extra.claimed.map(issue => issue.number), [7])
  assert.deepEqual(extra.notes, [])
  // The repository owner is not counted, and each login counts once.
  assert.deepEqual(collaboratorLogins(['Alice', 'bob', 'Bob', 'carol'], 'alice/board'), ['bob', 'carol'])
})

test('a failed lookup of away notices, collaborators or claims adds one note each and the queue still prints', () => {
  const extra = fetchContext({ repo: 'alice/board', roadmap: 209 }, { run: () => { throw new Error('ghp_abc123 C:\\private\\gh.exe') } })
  assert.deepEqual([extra.roadmapComments, extra.collaborators, extra.claimed], [null, null, null])
  assert.equal(extra.notes.length, 3)
  // Without the roadmap comments a Back cannot be seen, and the note says a waiting or due notice may be stale.
  assert.match(extra.notes[0], /^away notices could not be read.* a Back cannot be seen: a waiting or due notice may be stale$/)
  const fetch = () => ({ prs: [pull(1)], commentsByNumber: { 1: [ready()] } })
  const lanes = () => ({ stale: [], notes: [] })
  const output = []
  assert.equal(main([], { fetch, context: () => extra, bundle: noBundle, lanes, now: () => now, log: text => output.push(text), error: text => assert.fail(text) }), 0)
  assert.equal(output[0].split('\n').filter(line => line.startsWith('Note:')).length, 3)
  assert.match(output[0], /\n#1 /)
  assert.ok(!/ghp_abc123|private|Away:|claim expired/.test(output[0]))
  // A lookup that throws as a whole is one note too.
  const thrown = []
  assert.equal(main(['--json'], { fetch, context: () => { throw new Error('x') }, bundle: noBundle, lanes, now: () => now, log: text => thrown.push(text), error: text => assert.fail(text) }), 0)
  assert.equal(JSON.parse(thrown[0]).notes.length, 1)
})

const away = (login, body, at, id) => by(login, comment(body, at, id))

test('an Away comment sets a login away through its date, Back ends it and only the first line counts', () => {
  const comments = [
    away('Bob', 'Away: until 2026-10-22\nvisiting family', '2026-10-18T08:00:00Z', 1),
    away('carol', 'Away: until 2026-10-19', '2026-10-15T08:00:00Z', 2),
    away('dave', 'Away: until 2026-10-30', '2026-10-18T08:00:00Z', 3),
    away('dave', 'Back', '2026-10-19T08:00:00Z', 4),
    away('erin', 'Away: until 2026-10-20', '2026-10-19T08:00:00Z', 5),
    away('frank', 'Thanks!\nAway: until 2026-10-25', '2026-10-18T08:00:00Z', 6),
    away('gina', 'Away: until 2026-10-24', '2026-10-17T08:00:00Z', 7),
    away('gina', 'Back from the clinic', '2026-10-18T08:00:00Z', 8),
    away('gina', 'Away: until 2026-10-26', '2026-10-19T08:00:00Z', 9),
    comment('Away: until 2026-10-25', '2026-10-19T08:00:00Z', 10),
  ]
  // Time decides the order, not the position in the list.
  const result = readAway([...comments].reverse(), now)
  assert.deepEqual(result.active, [{ login: 'Bob', until: '2026-10-22' }, { login: 'erin', until: '2026-10-20' }, { login: 'gina', until: '2026-10-26' }])
  assert.deepEqual(result.notes, [])
})

test('an Away date more than 14 days after the comment is ignored with a note while its date is ahead', () => {
  const result = readAway([
    away('heidi', 'Away: until 2026-11-01', '2026-10-18T08:00:00Z', 1),
    away('ivan', 'Away: until 2026-11-02', '2026-10-18T23:00:00Z', 2),
    away('judy', 'Away: until 2026-03-01', '2026-01-01T08:00:00Z', 3),
    away('ken', 'Away: until 2026-02-30', '2026-10-18T08:00:00Z', 4),
    away('lena', 'Away: until 2026-10-21', '2026-10-19T08:00:00Z', 5),
    away('lena', 'Away: until 2026-12-31', '2026-10-19T09:00:00Z', 6),
  ], now)
  assert.deepEqual(result.active.map(item => [item.login, item.until]), [['heidi', '2026-11-01'], ['lena', '2026-10-21']])
  assert.deepEqual(result.notes, [
    'Away notice by ivan ignored: 2026-11-02 is more than 14 days after the comment',
    'Away notice by lena ignored: 2026-12-31 is more than 14 days after the comment',
  ])
})

const claimIssue = (number, ...comments) => ({ number, title: `Synthetic issue ${number}`, comments })
const claimBy = (login, body, createdAt) => ({ author: { login }, body, createdAt })

test('a claim past its time with no open pull request is listed as expired', () => {
  const issues = [
    claimIssue(10, claimBy('alice', 'Claim: codex, fix/a, until 2026-10-19 09:00 UTC', '2026-10-18T09:00:00Z')),
    claimIssue(11, claimBy('alice', 'Claim: codex, fix/b, until 2026-10-21 09:00 UTC', '2026-10-19T09:00:00Z')),
    claimIssue(12, claimBy('alice', 'Claim: codex, fix/c, until 2026-10-19 09:00 UTC', '2026-10-18T09:00:00Z'), claimBy('alice', 'Claim: codex, fix/c, until 2026-10-25 09:00 UTC', '2026-10-19T10:00:00Z')),
    claimIssue(13, claimBy('alice', 'Claim: codex, fix/d, until 2026-10-19 09:00 UTC', '2026-10-18T09:00:00Z')),
    claimIssue(14, claimBy('alice', 'Claim: codex, fix/e, until 2026-10-19 09:00 UTC', '2026-10-18T09:00:00Z'), claimBy('bob', 'Claim taken over: codex, fix/e2', '2026-10-20T08:00:00Z')),
    claimIssue(15, claimBy('bob', 'Claim: codex, fix/f, waiting for a slot', '2026-10-12T09:00:00Z')),
    claimIssue(16, claimBy('bob', 'Claim: codex, fix/g, waiting for a slot', '2026-10-15T09:00:00Z')),
    claimIssue(17, claimBy('alice', 'I will look at this', '2026-10-18T09:00:00Z')),
    claimIssue(18, claimBy('alice', 'Claim: codex, fix/h, until soon', '2026-10-18T09:00:00Z')),
    claimIssue(19),
  ]
  const prs = [pull(1, { body: 'Fixes #13\nAuthor: codex, fix/d' })]
  assert.deepEqual(readClaims(issues, prs, now), [{ number: 10, login: 'alice' }, { number: 15, login: 'bob' }])
  // A draft pull request counts as a linked one.
  assert.deepEqual(readClaims(issues.slice(0, 1), [pull(3, { isDraft: true, body: 'Part of #10' })], now), [])
})

test('away notices and expired claims print after the queue and appear in the JSON', () => {
  const extra = {
    roadmapComments: [away('Bob', 'Away: until 2026-10-22', '2026-10-18T08:00:00Z', 1)],
    collaborators: ['Owner1', 'alice', 'bob'],
    claimed: [claimIssue(10, claimBy('carol', 'Claim: codex, fix/x, until 2026-10-19 09:00 UTC', '2026-10-18T09:00:00Z'))],
    notes: [],
  }
  const run = argv => {
    const output = []
    const status = main(argv, {
      fetch: () => ({ prs: [pull(1)], commentsByNumber: { 1: [ready()] } }), context: () => extra, bundle: noBundle,
      lanes: () => ({ stale: [], notes: [] }), now: () => now, log: text => output.push(text), error: text => assert.fail(text),
    })
    assert.equal(status, 0)
    return output[0]
  }
  const lines = run(['--repo', 'owner1/board']).split('\n')
  assert.deepEqual(lines.slice(lines.indexOf('Drafts: 0') + 1), ['Away: Bob until 2026-10-22', 'claim expired: #10 carol — relabel to ready (CONTRIBUTING rule 3)'])
  // The owner does not count as a collaborator, so Bob being away leaves nobody besides the author and a notice is allowed.
  assert.ok(lines.includes('    notice allowed if only a collaborator or the owner may approve it (team-process, From claim to merge)'))
  const queue = JSON.parse(run(['--repo', 'owner1/board', '--json']))
  assert.deepEqual(queue.away, [{ login: 'Bob', until: '2026-10-22' }])
  assert.deepEqual(queue.expiredClaims, [{ number: 10, login: 'carol' }])
  assert.deepEqual(queue.needsReviewer[0].notice, { state: 'allowed', at: null })
  assert.equal('notes' in queue, false)
})

// A notice is the pull request author's to give, and the pull requests of these tests are alice's.
const notice = (time, sha = head, posted = '2026-10-20T10:00:00Z', id, login = 'alice') => by(login, comment(`Merging after ${time} unless someone objects\nHead: ${sha}`, posted, id))
// The notice of pull request 1, Ready at readyAt for the current head, with the given comments after it.
const noticeOf = (items, { readyAt = '2026-10-20T09:00:00Z', current = now, context, fields } = {}) => {
  const queue = classify([pull(1, fields)], { 1: [ready(head, readyAt, 1), ...items] }, current, null, context)
  return [...queue.needsReviewer, ...queue.approved, ...queue.waitingForAuthor][0].notice
}

test('a notice comment is read from its first words, a UTC time and the commit id it names', () => {
  const at = Date.UTC(2026, 9, 22, 12)
  assert.deepEqual(parseNotice('Merging after 2026-10-22 12:00 UTC unless someone objects\nHead: abcdef0'), { at, shas: ['abcdef0'] })
  assert.deepEqual(parseNotice(`Merging after 2026-10-22T12:00:00Z unless someone objects (${head})`), { at, shas: [head] })
  const unreadable = [
    'Merging after 2026-10-22 12:00 UTC unless someone objects',
    `Merging after tomorrow unless someone objects ${head}`,
    `Merging after 2026-10-22 12:00 PST unless someone objects ${head}`,
    `Merging after 2026-02-30 12:00 UTC unless someone objects ${head}`,
    `I will say Merging after 2026-10-22 12:00 UTC unless someone objects ${head}`,
    `Merging after 2026-10-22 12:00 UTC ${head}`,
  ]
  for (const body of unreadable) assert.equal(parseNotice(body), null, body)
})

test('a Ready pull request that nobody has taken for more than 24 hours may merge after a notice', () => {
  assert.deepEqual(noticeOf([], { readyAt: '2026-10-19T11:00:00Z' }), { state: 'allowed', at: null })
  assert.equal(noticeOf([], { readyAt: '2026-10-19T12:00:00Z' }), null)
  assert.equal(noticeOf([], { readyAt: '2026-10-19T13:00:00Z' }), null)
  // Only a Reviewing comment after the Ready means someone has it.
  assert.equal(noticeOf([comment('Reviewing: bob', '2026-10-20T08:00:00Z', 2)], { readyAt: '2026-10-19T11:00:00Z' }), null)
  assert.deepEqual(noticeOf([comment('Reviewing: bob', '2026-10-19T10:00:00Z', 0)], { readyAt: '2026-10-19T11:00:00Z' }), { state: 'allowed', at: null })
  const text = formatQueue(classify([pull(1)], { 1: [ready(head, '2026-10-19T11:00:00Z')] }, now))
  assert.match(text, /\n {4}notice allowed if only a collaborator or the owner may approve it \(team-process, From claim to merge\)\n/)
})

test('a notice is also allowed when every collaborator other than the author is away', () => {
  const context = { collaborators: ['alice', 'bob', 'carol'], awayLogins: ['bob', 'carol'] }
  const allowed = { state: 'allowed', at: null }
  assert.deepEqual(noticeOf([], { context }), allowed)
  assert.equal(noticeOf([], { context: { ...context, awayLogins: ['bob'] } }), null)
  assert.deepEqual(noticeOf([], { context, fields: { author: { login: 'Alice' } } }), allowed)
  assert.deepEqual(noticeOf([], { context: { collaborators: ['bob'], awayLogins: ['bob'] } }), allowed)
  // An unknown list, or one with nobody besides the author, never means everyone is away.
  assert.equal(noticeOf([], { context: { collaborators: null, awayLogins: ['bob'] } }), null)
  assert.equal(noticeOf([], { context: { collaborators: ['alice'], awayLogins: [] } }), null)
  assert.equal(noticeOf([comment('Reviewing: bob', '2026-10-20T10:00:00Z', 2)], { context }), null)
})

test('a Merging after notice for the current head waits until its time and is then due', () => {
  const posted = notice('2026-10-22 12:00 UTC', head.slice(0, 7))
  assert.deepEqual(noticeOf([posted]), { state: 'waiting', at: '2026-10-22T12:00:00.000Z' })
  assert.equal(noticeOf([posted], { current: '2026-10-22T11:59:59Z' }).state, 'waiting')
  assert.equal(noticeOf([posted], { current: '2026-10-22T12:00:00Z' }).state, 'due')
  assert.match(formatQueue(classify([pull(1)], { 1: [ready(), posted] }, now)), /\n {4}notice: merges after 2026-10-22 12:00 UTC\n/)
  const dueNow = '2026-10-23T08:00:00Z'
  assert.match(formatQueue(classify([pull(1)], { 1: [ready(), posted] }, dueNow)), /\n {4}notice due: merge if checks are green and the author's code-review subagent approved this head and no bot P0\/P1 is open\n/)
  // The author's own subagent approval moves the pull request to the approved group, and the notice still shows there.
  const approved = classify([pull(1)], { 1: [ready(), posted, verdict('APPROVE', head, '2026-10-20T11:00:00Z', 3)] }, dueNow)
  assert.deepEqual([approved.needsReviewer.length, approved.approved.length, approved.approved[0].notice.state], [0, 1, 'due'])
  assert.match(formatQueue(approved), /One at a time.*\n#1 .*\n {4}codex: .*\n {4}notice due: /)
})

test('a notice is cancelled by a Reviewing comment from someone else, a REQUEST CHANGES or an Objection after it', () => {
  const posted = notice('2026-10-23 12:00 UTC')
  const after = body => comment(body, '2026-10-20T11:00:00Z', 5)
  assert.equal(noticeOf([posted, after('Thanks for the notice')]).state, 'waiting')
  // A Reviewing comment from before the notice does not cancel it.
  assert.equal(noticeOf([comment('Reviewing: bob', '2026-10-20T09:30:00Z', 4), posted]).state, 'waiting')
  for (const body of ['Reviewing: bob', `Review: REQUEST CHANGES ${head} by bob`, 'Objection: I need more time', 'objection from the owner']) {
    assert.equal(noticeOf([posted, after(body)]).state, 'cancelled', body)
  }
  assert.deepEqual(noticeOf([posted, after('Reviewing: bob')]), { state: 'cancelled', at: '2026-10-23T12:00:00.000Z' })
  assert.match(formatQueue(classify([pull(1)], { 1: [ready(), posted, after('Reviewing: bob')] }, now)), /\n {4}notice cancelled\n/)
})

test('a notice naming a time less than 48 hours after the notice or after Ready is too early', () => {
  assert.equal(noticeOf([notice('2026-10-22 09:59 UTC')]).state, 'too-early')
  assert.equal(noticeOf([notice('2026-10-22 10:00 UTC')]).state, 'waiting')
  // The 48 hours count from the head's Ready as well as from the notice.
  assert.equal(noticeOf([notice('2026-10-20 20:00 UTC', head, '2026-10-18T10:00:00Z', 3)]).state, 'too-early')
  // A time that was too early stays flagged after it has passed.
  assert.equal(noticeOf([notice('2026-10-22 09:59 UTC')], { current: '2026-10-23T08:00:00Z' }).state, 'too-early')
  assert.match(formatQueue(classify([pull(1)], { 1: [ready(), notice('2026-10-22 09:59 UTC')] }, now)), /\n {4}notice too early: the time named must be 48 hours after the notice and after Ready\n/)
  // A comment that names no commit id, or no readable UTC time, is not a notice.
  assert.equal(noticeOf([comment('Merging after 2026-10-22 12:00 UTC unless someone objects', '2026-10-20T10:00:00Z', 2)]), null)
  assert.equal(noticeOf([comment(`Merging after tomorrow unless someone objects ${head}`, '2026-10-20T10:00:00Z', 2)]), null)
})

test('JSON lists the bots and the notice of each pull request', () => {
  const output = []
  const status = main(['--json'], {
    fetch: () => ({
      prs: [pull(1), pull(2, { title: 'Second' })],
      commentsByNumber: { 1: [ready(head, '2026-10-19T11:00:00Z'), codexState(head, false, '2026-10-20T10:00:00Z', 2)], 2: [ready()] },
    }),
    ...quiet, lanes: () => ({ stale: [], notes: [] }), now: () => now, log: text => output.push(text), error: text => assert.fail(text),
  })
  assert.equal(status, 0)
  const [first, second] = JSON.parse(output[0]).needsReviewer
  assert.deepEqual([first.number, first.bots, first.notice], [1, { codex: 'clean', greptile: false }, { state: 'allowed', at: null }])
  assert.deepEqual([second.number, second.bots, second.notice], [2, { codex: 'none', greptile: false }, null])
})

test('a pull request touching a bundle source or the release table merges one at a time', () => {
  const touching = (...paths) => ({ files: paths.map(path => ({ path, additions: 1, deletions: 0 })) })
  const prs = [
    pull(1, touching('hooks/board.ts')), pull(2, touching('hooks/released.ts')), pull(3, touching('hooks/board-script-1.ts')),
    pull(4, touching('docs/a.md')), pull(5, touching('hooks/register.tsx')),
  ]
  const comments = Object.fromEntries(prs.map(pr => [pr.number, [ready(), verdict('APPROVE', head, '2026-10-20T10:00:00Z', 2)]]))
  const withSources = classify(prs, comments, now, null, { bundleSources: new Set(['scripts/board-cli.ts', 'hooks/board.ts']) })
  assert.deepEqual(withSources.approvedOneAtATime.map(item => item.number), [1, 2, 3])
  assert.deepEqual(withSources.approvedNow.map(item => item.number), [4, 5])
  // When the sources could not be read, the release table and the generated parts still count.
  const without = classify(prs, comments, now)
  assert.deepEqual(without.approvedOneAtATime.map(item => item.number), [2, 3])
  assert.deepEqual(without.approvedNow.map(item => item.number), [1, 4, 5])
})

test('the bundle sources are read from the repository and a failure leaves a note without a path', () => {
  const loaded = loadBundleSources()
  assert.equal(loaded.note, null)
  assert.ok(loaded.sources.has('scripts/board-cli.ts'))
  const failed = loadBundleSources({ read: () => { throw new Error('C:\\private\\board.ts') } })
  assert.equal(failed.sources, null)
  assert.match(failed.note, /^bundle sources could not be read/)
  assert.ok(!failed.note.includes('private'))
  const output = []
  const status = main([], {
    fetch: () => ({ prs: [], commentsByNumber: {} }), context: noContext, bundle: () => failed, lanes: () => ({ stale: [], notes: [] }),
    now: () => now, log: text => output.push(text), error: text => assert.fail(text),
  })
  assert.equal(status, 0)
  assert.match(output[0], /Drafts: 0\nNote: bundle sources could not be read/)
})

const reviewersFile = (patch = {}) => JSON.stringify({ maxOpenReviews: 2, rules: [{ authors: ['claude'], reviewers: ['bot-one'] }, { authors: ['*'], reviewers: ['bot-two'] }], ...patch })
const ruleFile = (authors, reviewers) => reviewersFile({ rules: [{ authors, reviewers }] })

test('a maxOpenReviews that is not a whole number of at least 1 makes the reviewers file unusable', () => {
  assert.equal(parseReviewers(reviewersFile({ maxOpenReviews: undefined })).maxOpenReviews, 2)
  assert.equal(parseReviewers(reviewersFile({ maxOpenReviews: 3 })).maxOpenReviews, 3)
  for (const bad of [0, -1, 1.5, '2', true, [2]]) {
    assert.throws(() => parseReviewers(reviewersFile({ maxOpenReviews: bad })), /invalid reviewers file/, JSON.stringify(bad))
    assert.equal(loadReviewers({ read: () => reviewersFile({ maxOpenReviews: bad }) }).map, null, JSON.stringify(bad))
  }
})

test('a name in a rule with no letters or digits, or a missing list, makes the reviewers file unusable', () => {
  assert.deepEqual(parseReviewers(ruleFile(['Claude (PM)'], [' Bot-One '])).rules, [{ authors: ['claude'], reviewers: ['bot-one'] }])
  for (const bad of ['', '  ', '!!', '--', 7, null, {}]) {
    assert.throws(() => parseReviewers(ruleFile([bad], ['bot-one'])), /rules must list names/, `author ${JSON.stringify(bad)}`)
    assert.throws(() => parseReviewers(ruleFile(['claude'], ['bot-one', bad])), /rules must list names/, `reviewer ${JSON.stringify(bad)}`)
  }
  for (const missing of [[], 'claude', undefined]) {
    assert.throws(() => parseReviewers(ruleFile(missing, ['bot-one'])), /rules must list names/, `authors ${JSON.stringify(missing)}`)
    assert.throws(() => parseReviewers(ruleFile(['claude'], missing)), /rules must list names/, `reviewers ${JSON.stringify(missing)}`)
  }
})

test('the star is accepted as an author and refused as a reviewer', () => {
  assert.deepEqual(parseReviewers(ruleFile(['*'], ['bot-one'])).rules[0].authors, ['*'])
  assert.deepEqual(parseReviewers(ruleFile([' * ', 'claude'], ['bot-one'])).rules[0].authors, ['*', 'claude'])
  for (const reviewers of [['*'], ['bot-one', '*'], [' * ']]) {
    assert.throws(() => parseReviewers(ruleFile(['claude'], reviewers)), /rules must list names/, JSON.stringify(reviewers))
  }
})

test('a reviewers file that starts with a byte order mark is read', () => {
  const text = `\uFEFF${reviewersFile()}`
  assert.throws(() => JSON.parse(text))
  assert.equal(parseReviewers(text).rules.length, 2)
  const loaded = loadReviewers({ read: () => text })
  assert.equal(loaded.note, null)
  assert.equal(loaded.map.maxOpenReviews, 2)
})

const backAt = (login, at) => ({ login, time: Date.parse(at) })

test('a collaborator Back on the roadmap issue after the notice cancels it', () => {
  const posted = notice('2026-10-23 12:00 UTC')
  const collaborators = ['alice', 'bob', 'carol']
  assert.equal(noticeOf([posted], { context: { collaborators, backs: [] } }).state, 'waiting')
  assert.equal(noticeOf([posted], { context: { collaborators, backs: [backAt('bob', '2026-10-20T11:00:00Z')] } }).state, 'cancelled')
  // A Back from someone who is not a collaborator does not end it, but with no collaborator list any Back besides the author's does.
  assert.equal(noticeOf([posted], { context: { collaborators, backs: [backAt('dave', '2026-10-20T11:00:00Z')] } }).state, 'waiting')
  assert.equal(noticeOf([posted], { context: { collaborators: null, backs: [backAt('dave', '2026-10-20T11:00:00Z')] } }).state, 'cancelled')
  // readAway hands over every Back comment with its login and time, and main passes them on.
  const comments = [away('Bob', 'Back', '2026-10-20T11:00:00Z', 1), away('carol', 'Away: until 2026-10-25', '2026-10-20T08:00:00Z', 2), away('dave', 'Back from the clinic', '2026-10-19T08:00:00Z', 3)]
  assert.deepEqual(readAway(comments, now).backs.sort((a, b) => a.time - b.time), [backAt('dave', '2026-10-19T08:00:00Z'), backAt('bob', '2026-10-20T11:00:00Z')])
  const output = []
  const status = main(['--json'], {
    fetch: () => ({ prs: [pull(1)], commentsByNumber: { 1: [ready(), posted] } }),
    context: () => ({ roadmapComments: comments, collaborators: ['alice', 'bob'], claimed: [], notes: [] }), bundle: noBundle,
    lanes: () => ({ stale: [], notes: [] }), now: () => now, log: text => output.push(text), error: text => assert.fail(text),
  })
  assert.equal(status, 0)
  assert.equal(JSON.parse(output[0]).needsReviewer[0].notice.state, 'cancelled')
})

test('a Back posted before the notice does not cancel it', () => {
  const posted = notice('2026-10-23 12:00 UTC')
  const context = { collaborators: ['alice', 'bob'], backs: [backAt('bob', '2026-10-20T09:30:00Z')] }
  assert.equal(noticeOf([posted], { context }).state, 'waiting')
  // Posted at the same moment as the notice is not after it either.
  assert.equal(noticeOf([posted], { context: { ...context, backs: [backAt('bob', '2026-10-20T10:00:00Z')] } }).state, 'waiting')
  assert.equal(noticeOf([posted], { context: { collaborators: null, backs: context.backs } }).state, 'waiting')
})

test('a Back from the pull request author does not cancel its notice', () => {
  const posted = notice('2026-10-23 12:00 UTC')
  const backs = [backAt('alice', '2026-10-20T11:00:00Z')]
  assert.equal(noticeOf([posted], { context: { collaborators: ['alice', 'bob'], backs } }).state, 'waiting')
  assert.equal(noticeOf([posted], { context: { collaborators: null, backs } }).state, 'waiting')
  // The login is compared without regard to case.
  assert.equal(noticeOf([posted], { context: { collaborators: null, backs }, fields: { author: { login: 'Alice' } } }).state, 'waiting')
})

test('a governance, workflow or release pull request shows that a notice is not possible', () => {
  const touching = (...paths) => ({ files: paths.map(path => ({ path, additions: 1, deletions: 0 })) })
  const refusal = '    no notice: governance, workflow or release pull requests merge only with an approval (CONTRIBUTING rules 8 and 12)'
  const refused = { state: 'not-allowed', at: null }
  // A workflow change with a notice that has come due.
  const due = classify([pull(1, touching('.github/workflows/test.yml'))], { 1: [ready(), notice('2026-10-22 12:00 UTC')] }, '2026-10-23T08:00:00Z')
  assert.deepEqual(due.needsReviewer[0].notice, refused)
  assert.ok(formatQueue(due).split('\n').includes(refusal))
  // The same with no notice at all, Ready for more than 24 hours, for each kind of file the rule names.
  const governed = ['.github/workflows/test.yml', '.github/pull_request_template.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/dev/team-process.md', 'CHANGELOG.md', 'package.json', '.claude-plugin/plugin.json']
  for (const path of governed) {
    assert.deepEqual(noticeOf([], { readyAt: '2026-10-19T11:00:00Z', fields: touching('scripts/a.mjs', path) }), refused, path)
  }
  const text = formatQueue(classify([pull(1, touching('CONTRIBUTING.md'))], { 1: [ready(head, '2026-10-19T11:00:00Z')] }, now))
  assert.ok(text.split('\n').includes(refusal))
  // Everyone being away does not change it, and without a notice or a way to give one there is nothing to say.
  const awayContext = { collaborators: ['alice', 'bob'], awayLogins: ['bob'] }
  assert.deepEqual(noticeOf([], { context: awayContext, fields: touching('AGENTS.md') }), refused)
  assert.equal(noticeOf([], { fields: touching('AGENTS.md') }), null)
  assert.equal(noticeOf([notice('2026-10-22 12:00 UTC', head, undefined, undefined, 'bob')], { fields: touching('AGENTS.md') }), null)
  // Other pull requests keep the notice, with or without a file list.
  assert.deepEqual(noticeOf([], { readyAt: '2026-10-19T11:00:00Z', fields: touching('docs/CONTRIBUTOR-PATH.md', 'scripts/review-queue.mjs') }), { state: 'allowed', at: null })
  assert.deepEqual(noticeOf([], { readyAt: '2026-10-19T11:00:00Z' }), { state: 'allowed', at: null })
})

test('a push drops the old notice and a new Ready that nobody takes for 24 hours allows a new one', () => {
  const other = 'fedcba9876543210fedcba9876543210fedcba98'
  const fields = { headRefOid: other }
  const items = [notice('2026-10-23 12:00 UTC'), ready(other, '2026-10-20T11:00:00Z', 6)]
  // The old notice names the old head, so the new head has none yet.
  assert.equal(noticeOf(items, { fields }), null)
  assert.deepEqual(noticeOf(items, { fields, current: '2026-10-21T12:00:00Z' }), { state: 'allowed', at: null })
  assert.match(formatQueue(classify([pull(1, fields)], { 1: [ready(head), ...items] }, '2026-10-21T12:00:00Z')), /\n {4}notice allowed if only a collaborator or the owner may approve it /)
  // A notice for the new head is read as usual.
  const again = notice('2026-10-24 12:00 UTC', other, '2026-10-21T12:00:00Z', 7)
  assert.deepEqual(noticeOf([...items, again], { fields, current: '2026-10-21T13:00:00Z' }), { state: 'waiting', at: '2026-10-24T12:00:00.000Z' })
})

test('only a Merging after comment from the pull request author counts and only a Reviewing from someone else cancels it', () => {
  const posted = notice('2026-10-23 12:00 UTC')
  const fromBob = notice('2026-10-23 12:00 UTC', head, '2026-10-20T10:00:00Z', undefined, 'bob')
  assert.equal(noticeOf([fromBob]), null)
  assert.deepEqual(noticeOf([fromBob], { readyAt: '2026-10-19T11:00:00Z' }), { state: 'allowed', at: null })
  assert.equal(noticeOf([{ body: fromBob.body, created_at: fromBob.created_at, id: 2 }]), null)
  assert.equal(noticeOf([posted]).state, 'waiting')
  assert.equal(noticeOf([notice('2026-10-23 12:00 UTC', head, undefined, undefined, 'Alice')]).state, 'waiting')
  const reviewing = login => by(login, comment(`Reviewing: ${login}`, '2026-10-20T11:00:00Z', 5))
  assert.equal(noticeOf([posted, reviewing('alice')]).state, 'waiting')
  assert.equal(noticeOf([posted, reviewing('Alice')]).state, 'waiting')
  assert.equal(noticeOf([posted, reviewing('bob')]).state, 'cancelled')
})

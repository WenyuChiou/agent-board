import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorOf, dailyLine, fromGraphql, main, parseArgs, reviewQueue, scorecard } from '../scripts/team-stats.mjs'

const date = '2026-10-20'
const head = 'abcdef0123456789abcdef0123456789abcdef01'
const comment = (body, created_at, id = 1) => ({ body, created_at, id })
const pull = (number, comments = [], fields = {}) => ({ number, state: 'open', draft: false, head: { sha: head }, body: '', comments, ...fields })
const issue = (number, fields = {}) => ({ number, state: 'open', created_at: '2026-10-19T00:00:00Z', closed_at: null, milestone: null, body: '', ...fields })

test('team stats daily line counts issues opened and closed on the date, open per milestone in version order, and open pull requests', () => {
  const issues = [
    issue(1, { created_at: '2026-10-20T00:00:00Z', milestone: { title: '0.24.10 Later' } }),
    issue(2, { created_at: '2026-10-20T23:59:59Z', milestone: { title: '0.24.2 Next' } }),
    issue(3, { state: 'closed', closed_at: '2026-10-20T00:00:00Z' }),
    issue(4, { state: 'closed', closed_at: '2026-10-20T23:59:59Z' }),
    issue(5, { state: 'closed', created_at: '2026-10-21T00:00:00Z', closed_at: '2026-10-21T00:00:00Z' }),
    issue(6),
    issue(7, { created_at: '2026-10-21T01:00:00+02:00', milestone: { title: '0.24.2 More' } }),
    issue(8, { created_at: '2026-10-20T00:00:00Z', pull_request: {} }),
  ]
  const pullRequests = [pull(325, [comment(`Ready for review ${head}`, '2026-10-20T01:00:00Z')]), pull(306, [], { draft: true }), pull(300, [], { state: 'closed' })]
  const before = structuredClone({ issues, pullRequests })
  assert.equal(dailyLine({ issues, pullRequests }, date), '2026-10-20: opened 3, closed 2, open 4 (0.24.2 2 · 0.24.10 1 · none 1), pull requests open 2, review queue #325')
  assert.equal(dailyLine({ issues: [], pullRequests: [] }, date), '2026-10-20: opened 0, closed 0, open 0 (), pull requests open 0, review queue empty')
  assert.deepEqual({ issues, pullRequests }, before)
})

test('team stats review queue lists a ready pull request until a review names its head, oldest ready first', () => {
  const ready = (time, sha = head) => comment(`Ready for review ${sha}`, `2026-10-20T${time}:00Z`)
  const reviewed = comment(`Review: APPROVE ${head.slice(0, 12)}`, '2026-10-20T02:00:00Z')
  const pullRequests = [
    pull(325, [ready('03:00')]),
    pull(306, [ready('01:00', head.slice(0, 7)), comment('Review: APPROVE 1111111', '2026-10-20T02:00:00Z')]),
    pull(10, [reviewed, ready('01:00')]),
    pull(11, [ready('01:00'), reviewed, ready('04:00')]),
    pull(12, [ready('00:00')], { draft: true }),
    pull(13, [ready('00:00')], { state: 'closed' }),
    pull(14, [ready('00:00', '1111111')]),
    pull(15, [ready('00:00', head + 'a')]),
    pull(16, [ready('00:00', head.slice(0, 6))]),
    pull(17, [comment(`Quoted Ready for review ${head}`, '2026-10-20T00:00:00Z')]),
    pull(18, [ready('05:00'), ready('06:00')]),
  ]
  const before = structuredClone(pullRequests)
  assert.deepEqual(reviewQueue(pullRequests), [306, 325, 11, 18])
  for (const body of [`  \`Ready for review ${head.slice(0, 7)}\``, `  Ready for review \`${head.slice(0, 7)}\``]) {
    assert.deepEqual(reviewQueue([pull(19, [comment(body, '2026-10-20T01:00:00Z')])]), [19])
  }
  assert.deepEqual(reviewQueue([pull(19, [ready('01:00'), comment(`Checks complete\nReview: REQUEST CHANGES \`${head.slice(0, 7)}\``, '2026-10-20T02:00:00Z')])]), [])
  assert.deepEqual(reviewQueue([pull(19, [comment(`Other text\nReady for review ${head}`, '2026-10-20T01:00:00Z')])]), [])
  assert.deepEqual(pullRequests, before)
})

test('team stats scorecard groups merged pull requests by the Author line, with first-review approvals, rounds and regressions', () => {
  const approve = comment('Review: APPROVE abcdef0', '2026-10-19T01:00:00Z')
  const changes = comment('Review: REQUEST CHANGES abcdef0', '2026-10-18T01:00:00Z')
  const merged = (number, body, comments = [], merged_at = '2026-10-20T12:00:00Z') => pull(number, comments, { body, merged_at, state: 'closed' })
  const pullRequests = [
    merged(1, 'Author: `Codex (Phase1)`, fix/a\nFixes #10\nCloses #10\nResolves #11', [approve]),
    merged(2, 'Author: CODEX (phase1), fix/b\nFixes #11', [approve, changes]),
    merged(3, 'Author: dot, fix/c\nCloses #12', [], '2026-10-14T00:00:00Z'),
    merged(4, 'Fixes #10', [comment('Review: APPROVE but REQUEST CHANGES remain', '2026-10-20T00:00:00Z')]),
    merged(5, 'Author: muse, fix/old', [], '2026-01-01T00:00:00Z'),
    merged(6, 'Author: excluded, fix/future', [], '2026-10-21T00:00:00Z'),
    merged(7, 'Author: excluded, fix/early', [], '2026-10-13T23:59:59Z'),
    pull(8, [], { body: 'Author: unmerged, fix/open' }),
  ]
  const issues = [
    issue(20, { created_at: '2026-10-14T00:00:00Z', body: 'Regression of #1; caused by #2; regression of #1' }),
    issue(21, { body: 'CAUSED BY #5' }),
    issue(22, { body: 'regression of #8, caused by #999' }),
    issue(23, { created_at: '2026-10-21T00:00:00Z', body: 'caused by #1' }),
    issue(24, { created_at: '2026-10-13T23:59:59Z', body: 'regression of #1' }),
    issue(25, { body: 'regression of #1', pull_request: {} }),
  ]
  const before = structuredClone({ issues, pullRequests })
  assert.equal(scorecard({ issues, pullRequests }, date), [
    '| agent | pull requests merged | issues closed by them | approved at first review | review rounds per pull request | regressions |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    '| codex (phase1) | 2 | 2 | 1/2 | 1.5 | 1 |',
    '| dot | 1 | 1 | - | 1.0 | 0 |',
    '| muse | 0 | 0 | - | - | 1 |',
    '| unknown | 1 | 1 | - | 1.0 | 0 |',
    '| total | 4 | 3 | 1/2 | 1.3 | 2 |',
  ].join('\n'))
  const nodes = [{
    number: 2,
    body: pullRequests[1].body,
    mergedAt: pullRequests[1].merged_at,
    state: 'MERGED',
    isDraft: false,
    headRefOid: head,
    comments: { nodes: [approve, changes].map(comment => ({ body: comment.body, createdAt: comment.created_at, databaseId: comment.id })) },
  }]
  const beforeNodes = structuredClone(nodes)
  const mapped = fromGraphql(nodes)
  assert.deepEqual(mapped, [pullRequests[1]])
  assert.equal(scorecard({ issues, pullRequests: pullRequests.map(pr => pr.number === 2 ? mapped[0] : pr) }, date), scorecard({ issues, pullRequests }, date))
  assert.deepEqual(nodes, beforeNodes)
  assert.equal(authorOf('<!-- Author: fake, fix/x -->\nAuthor: `CoDeX (phase1)`, fix/x'), 'codex (phase1)')
  assert.equal(authorOf(null), 'unknown')
  assert.match(scorecard({ issues: [], pullRequests: [] }, date), /\| total \| 0 \| 0 \| - \| - \| 0 \|$/)
  const multiline = merged(1, 'Author: codex, fix/multiline', [comment('Checks complete\nReview: APPROVE `abcdef0`', '2026-10-19T01:00:00Z')])
  assert.match(scorecard({ issues: [], pullRequests: [multiline] }, date), /\| codex \| 1 \| 0 \| 1\/1 \| 1\.0 \| 0 \|/)
  assert.match(scorecard({ issues: [issue(26, { body: 'This is not a regression of #1' })], pullRequests }, date), /\| total \| 4 \| 3 \| .* \| 0 \|$/)
  for (const body of ['- Regression of #1', 'Details\n  * cAuSeD bY #1', '  Regression of #1']) {
    assert.match(scorecard({ issues: [issue(26, { body })], pullRequests }, date), /\| total \| 4 \| 3 \| .* \| 1 \|$/)
  }
  assert.deepEqual({ issues, pullRequests }, before)
})

test('team stats rejects an unknown flag and a malformed date', () => {
  for (const argv of [['--unknown'], ['--date', '2026-02-30'], ['--date', '2026-2-01'], ['--date', 'invalid'], ['--date'], ['--repo'], ['--week', '--week'], ['--repo', '../bad'], ['--repo', 'owner/..']]) assert.throws(() => parseArgs(argv))
  assert.deepEqual(parseArgs([], new Date('2026-10-20T23:00:00Z')), { date, repo: 'WenyuChiou/agent-board', isWeek: false, isHelp: false })
  assert.deepEqual(parseArgs(['--week', '--date', '2024-02-29', '--repo', 'example/project']), { date: '2024-02-29', repo: 'example/project', isWeek: true, isHelp: false })
  const output = []
  const errors = []
  const io = { log: text => output.push(text), error: text => errors.push(text), fetch: () => { throw new Error('private diagnostics') } }
  assert.equal(main(['--help'], io), 0)
  assert.match(output[0], /^Usage:/)
  assert.equal(main(['--unknown'], io), 2)
  assert.match(errors[0], /^Usage:/)
  assert.equal(main([], io), 1)
  assert.equal(errors[1], 'GitHub data could not be read; check gh authentication and repository access.')
  assert.equal(main(['--date', date], { ...io, fetch: () => ({ issues: [], pullRequests: [] }) }), 0)
  assert.match(output[1], /^2026-10-20: opened 0/)
  assert.equal(main(['--week', '--date', date], { ...io, fetch: () => ({ issues: [], pullRequests: [] }) }), 0)
  assert.match(output[2], /\| total \|/)
  for (const argv of [[], ['--week']]) {
    const before = [...errors]
    assert.throws(() => main(argv, { ...io, fetch: () => ({ issues: null, pullRequests: [] }) }), TypeError)
    assert.deepEqual(errors, before)
  }
})

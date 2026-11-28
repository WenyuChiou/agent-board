import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as teamStats from '../scripts/team-stats.mjs'
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
    '| codex (phase1) | 2 | 2 | 1/2 | 1.0 | 1 |',
    '| dot | 1 | 1 | - | 0.0 | 0 |',
    '| muse | 0 | 0 | - | - | 1 |',
    '| unknown | 1 | 1 | - | 0.0 | 0 |',
    '| total | 4 | 3 | 1/2 | 0.5 | 2 |',
    'merged with no review verdict: #3, #4',
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
  assert.deepEqual(mapped.map(({ reviews, ...rest }) => rest), [pullRequests[1]])
  assert.equal(scorecard({ issues, pullRequests: pullRequests.map(pr => pr.number === 2 ? mapped[0] : pr) }, date), scorecard({ issues, pullRequests }, date))
  assert.deepEqual(nodes, beforeNodes)
  assert.equal(authorOf('<!-- Author: fake, fix/x -->\nAuthor: `CoDeX (phase1)`, fix/x'), 'codex (phase1)')
  assert.equal(authorOf(null), 'unknown')
  assert.match(scorecard({ issues: [], pullRequests: [] }, date), /\| total \| 0 \| 0 \| - \| - \| 0 \|$/)
  const multiline = merged(1, 'Author: codex, fix/multiline', [comment('Checks complete\nReview: APPROVE `abcdef0`', '2026-10-19T01:00:00Z')])
  assert.match(scorecard({ issues: [], pullRequests: [multiline] }, date), /\| codex \| 1 \| 0 \| 1\/1 \| 1\.0 \| 0 \|/)
  assert.match(scorecard({ issues: [issue(26, { body: 'This is not a regression of #1' })], pullRequests }, date), /\| total \| 4 \| 3 \| .* \| 0 \|$/m)
  for (const body of ['- Regression of #1', 'Details\n  * cAuSeD bY #1', '  Regression of #1']) {
    assert.match(scorecard({ issues: [issue(26, { body })], pullRequests }, date), /\| total \| 4 \| 3 \| .* \| 1 \|$/m)
  }
  assert.deepEqual({ issues, pullRequests }, before)
})

test('team stats daily line appends the milestone counts when the milestone read ran', () => {
  const work = (fields = {}) => ({
    milestone: { number: 15, title: '0.26.0 The mainstream AIs end to end' },
    open: 96, ready: 41, reallyFree: 9, unchecked: [], expiredClaims: [], staleClaimed: [],
    idleAssignees: [], staleFirst: [], isUncertain: false, ...fields,
  })
  const data = { issues: [issue(1)], pullRequests: [] }
  assert.match(dailyLine({ ...data, milestoneWork: work() }, date), /milestone 0\.26\.0: open 96, ready 41, really free 9$/)
  assert.match(dailyLine({ ...data, milestoneWork: work({ isUncertain: true }) }, date), /really free 9 \(uncertain\)$/)
  assert.match(dailyLine({ ...data, milestoneWork: null }, date), /milestone work uncertain$/)
  assert.ok(!dailyLine({ ...data, milestoneWork: work({ milestone: null }) }, date).includes('milestone'))
  assert.ok(!dailyLine(data, date).includes('milestone'))
})

test('team stats lists merged pull requests with no review verdict as zero rounds', () => {
  const merged = (number, comments = [], merged_at = '2026-10-20T12:00:00Z') => pull(number, comments, { body: 'Author: codex, fix/x', merged_at, state: 'closed' })
  const pullRequests = [merged(12, [comment('Ready for review abcdef0', '2026-10-19T01:00:00Z')]), merged(9), merged(99, [], '2026-10-01T00:00:00Z')]
  const text = scorecard({ issues: [], pullRequests }, date)
  assert.match(text, /\| codex \| 2 \| 0 \| - \| 0\.0 \| 0 \|/)
  assert.match(text, /^merged with no review verdict: #9, #12$/m)
  assert.doesNotMatch(text, /#99/)
  // A bot's verdict is input for the reviewer, not a verdict: read from GitHub with its author's kind, it counts no round.
  const botComment = { body: `Review: APPROVE ${head} by synthetic-bot`, createdAt: '2026-10-19T01:00:00Z', databaseId: 7, author: { login: 'synthetic-bot', __typename: 'Bot' } }
  const [byBot] = fromGraphql([{ number: 30, body: 'Author: codex, fix/x', mergedAt: '2026-10-20T12:00:00Z', state: 'MERGED', isDraft: false, headRefOid: head, comments: { nodes: [botComment] } }])
  assert.match(scorecard({ issues: [], pullRequests: [byBot] }, date), /^merged with no review verdict: #30$/m)
})

test('team stats counts each reviewed head once across approvals and requests for changes', () => {
  const merged = comments => pull(20, comments, { body: 'Author: codex, fix/x', merged_at: '2026-10-20T12:00:00Z', state: 'closed' })
  const verdict = (kind, sha, id) => comment(`Review: ${kind} ${sha}`, `2026-10-19T0${id}:00:00Z`, id)
  const approve = verdict('APPROVE', 'ccccccc', 1)
  assert.match(scorecard({ issues: [], pullRequests: [merged([approve])] }, date), /\| codex \| 1 \| 0 \| 1\/1 \| 1\.0 \| 0 \|/)
  const reviews = [verdict('REQUEST CHANGES', 'aaaaaaa', 1), verdict('REQUEST CHANGES', 'aaaaaaa111111111111111111111111111111111', 2), verdict('REQUEST CHANGES', 'bbbbbbb', 3), approve]
  const text = scorecard({ issues: [], pullRequests: [merged(reviews)] }, date)
  assert.match(text, /\| codex \| 1 \| 0 \| 0\/1 \| 3\.0 \| 0 \|/)
  assert.doesNotMatch(text, /merged with no review verdict:/)
})

test('team stats never shows a first review for a pull request it lists as merged with no review verdict', () => {
  const bot = { login: 'helper[bot]', type: 'Bot' }
  const visitor = { login: 'visitor', type: 'User' }
  const at = '2026-10-19T01:00:00Z'
  const shapes = [
    ['no comment', []],
    ['bot approval', [{ ...comment(`Review: APPROVE ${head}`, at), user: bot }]],
    ['bot request', [{ ...comment(`Review: REQUEST CHANGES ${head}`, at), user: bot }]],
    ['outside approval', [{ ...comment(`Review: APPROVE ${head}`, at), user: visitor, author_association: 'NONE' }]],
    ['code fence', [comment(`\`\`\`\nReview: APPROVE ${head}\n\`\`\``, at)]],
    ['HTML comment', [comment(`<!--\nReview: REQUEST CHANGES ${head}\n-->`, at)]],
  ]
  for (const [shape, comments] of shapes) {
    const pr = pull(31, comments, { body: 'Author: codex, fix/x', merged_at: '2026-10-20T12:00:00Z', state: 'closed' })
    const text = scorecard({ issues: [], pullRequests: [pr] }, date)
    assert.match(text, /^\| codex \| 1 \| 0 \| - \| 0\.0 \| 0 \|$/m, shape)
    assert.match(text, /^merged with no review verdict: #31$/m, shape)
  }
})

test('team stats takes the first review from the first team verdict when a bot\'s approval came earlier', () => {
  const earlier = { ...comment(`Review: APPROVE ${head}`, '2026-10-19T01:00:00Z'), user: { login: 'helper[bot]', type: 'Bot' } }
  const first = { ...comment(`Review: REQUEST CHANGES ${head}`, '2026-10-19T02:00:00Z'), user: { login: 'teammate', type: 'User' }, author_association: 'MEMBER' }
  const later = { ...comment(`Review: APPROVE ${head}`, '2026-10-19T03:00:00Z'), user: { login: 'teammate', type: 'User' }, author_association: 'MEMBER' }
  const pr = pull(32, [later, earlier, first], { body: 'Author: codex, fix/x', merged_at: '2026-10-20T12:00:00Z', state: 'closed' })
  assert.match(scorecard({ issues: [], pullRequests: [pr] }, date), /^\| codex \| 1 \| 0 \| 0\/1 \| 1\.0 \| 0 \|$/m)
})

test('team stats reads an outside author\'s approval the same from GitHub\'s GraphQL shape and its REST shape', () => {
  const body = `Review: APPROVE ${head}`
  const createdAt = '2026-10-19T01:00:00Z'
  const [graphql] = fromGraphql([{
    number: 33, body: 'Author: codex, fix/x', mergedAt: '2026-10-20T12:00:00Z', state: 'MERGED', isDraft: false, headRefOid: head,
    comments: { nodes: [{ body, createdAt, databaseId: 1, author: { login: 'visitor', __typename: 'User' }, authorAssociation: 'NONE' }] },
    reviews: { nodes: [] },
  }])
  const rest = pull(33, [{ ...comment(body, createdAt), user: { login: 'visitor', type: 'User' }, author_association: 'NONE' }], { body: graphql.body, merged_at: graphql.merged_at, state: 'closed' })
  const output = pr => scorecard({ issues: [], pullRequests: [pr] }, date)
  assert.equal(output(graphql), output(rest))
  assert.equal(graphql.comments[0].author_association, 'NONE')
  assert.match(output(graphql), /^\| codex \| 1 \| 0 \| - \| 0\.0 \| 0 \|$/m)
  assert.match(output(graphql), /^merged with no review verdict: #33$/m)
})

test('team stats counts a GitHub review that approves or requests changes as a verdict', () => {
  const make = (state, number) => fromGraphql([{
    number, body: 'Author: codex, fix/x', mergedAt: '2026-10-20T12:00:00Z', state: 'MERGED', isDraft: false, headRefOid: head,
    comments: { nodes: [] },
    reviews: { nodes: [{ body: '', state, submittedAt: '2026-10-19T01:00:00Z', commit: { oid: head }, author: { login: 'teammate', __typename: 'User' }, authorAssociation: 'MEMBER' }] },
  }])[0]
  for (const [state, cell] of [['APPROVED', '1/1'], ['CHANGES_REQUESTED', '0/1']]) {
    const pr = make(state, 34)
    const text = scorecard({ issues: [], pullRequests: [pr] }, date)
    assert.ok(text.includes(`| codex | 1 | 0 | ${cell} | 1.0 | 0 |`), state)
    assert.doesNotMatch(text, /merged with no review verdict:/)
    assert.deepEqual(pr.reviews[0], { body: '', state, commit_id: head, created_at: '2026-10-19T01:00:00Z', user: { login: 'teammate', type: 'User' }, author_association: 'MEMBER' })
  }
  const pr = make('CHANGES_REQUESTED', 35)
  pr.comments.push(comment(`Review: APPROVE ${head}`, '2026-10-19T02:00:00Z'))
  assert.match(scorecard({ issues: [], pullRequests: [pr] }, date), /^\| codex \| 1 \| 0 \| 0\/1 \| 1\.0 \| 0 \|$/m)

  const graph = {
    number: 36, body: 'Author: codex, fix/x', mergedAt: '2026-10-20T12:00:00Z', state: 'MERGED', isDraft: false, headRefOid: head,
    comments: { totalCount: 101, nodes: [] },
    reviews: { nodes: [{ body: '', state: 'APPROVED', submittedAt: '2026-10-19T01:00:00Z', commit: { oid: head }, author: { login: 'teammate', __typename: 'User' }, authorAssociation: 'MEMBER' }] },
  }
  const restPr = number => ({ number, body: graph.body, merged_at: graph.mergedAt, state: 'closed', draft: false, head: { sha: head } })
  const restReview = { body: '', state: 'CHANGES_REQUESTED', commit_id: head, created_at: '2026-10-19T01:00:00Z', user: { login: 'teammate', type: 'User' }, author_association: 'MEMBER' }
  const calls = []
  const run = (command, args) => {
    assert.equal(command, 'gh')
    calls.push(args)
    if (args[1] === 'graphql') {
      const query = args.find(arg => arg.startsWith('query='))
      assert.match(query, /comments\(first: 100\)[\s\S]*?authorAssociation/)
      assert.match(query, /reviews\(first: 100\)[\s\S]*?authorAssociation/)
      return JSON.stringify(graph)
    }
    const endpoint = args.at(-1)
    if (endpoint.includes('/issues?')) return ''
    if (endpoint.includes('/pulls?')) return [restPr(36), restPr(37)].map(value => JSON.stringify(value)).join('\n')
    if (endpoint.includes('/issues/36/comments?') || endpoint.includes('/issues/37/comments?')) return ''
    if (endpoint.includes('/pulls/37/reviews?')) return JSON.stringify(restReview)
    throw new Error(`unexpected endpoint: ${endpoint}`)
  }
  const fetched = teamStats.fetchStats({ repo: 'synthetic/example', date, isWeek: true }, run)
  assert.deepEqual(fetched.pullRequests.find(item => item.number === 37).reviews, [restReview])
  assert.match(scorecard(fetched, date), /^\| codex \| 2 \| 0 \| 1\/2 \| 1\.0 \| 0 \|$/m)
  assert.equal(calls.filter(args => String(args.at(-1)).includes('/comments?')).length, 2)
  assert.equal(calls.filter(args => String(args.at(-1)).includes('/reviews?')).length, 1)
})

test('team stats orders a GitHub review read through the REST fallback by the time it was submitted', () => {
  const member = { user: { login: 'teammate', type: 'User' }, author_association: 'MEMBER' }
  const request = { body: '', state: 'CHANGES_REQUESTED', commit_id: head, submitted_at: '2026-10-19T01:00:00Z', id: 900, ...member }
  const approval = { ...comment(`Review: APPROVE ${head}`, '2026-10-19T02:00:00Z', 100), ...member }
  const pr = pull(38, [approval], { body: 'Author: codex, fix/x', merged_at: '2026-10-20T12:00:00Z', state: 'closed', reviews: [request] })
  assert.match(scorecard({ issues: [], pullRequests: [pr] }, date), /^\| codex \| 1 \| 0 \| 0\/1 \| 1\.0 \| 0 \|$/m)
})

test('team stats reads every GitHub review through the REST fallback when a pull request has more than 100', () => {
  const graph = {
    number: 39, body: 'Author: codex, fix/x', mergedAt: '2026-10-20T12:00:00Z', state: 'MERGED', isDraft: false, headRefOid: head,
    comments: { totalCount: 0, nodes: [] },
    reviews: { totalCount: 101, nodes: [] },
  }
  const restReview = { body: '', state: 'APPROVED', commit_id: head, submitted_at: '2026-10-19T01:00:00Z', id: 5, user: { login: 'teammate', type: 'User' }, author_association: 'MEMBER' }
  const run = (command, args) => {
    assert.equal(command, 'gh')
    if (args[1] === 'graphql') {
      assert.match(args.find(arg => arg.startsWith('query=')), /reviews\(first: 100\) \{\s*totalCount/)
      return JSON.stringify(graph)
    }
    const endpoint = args.at(-1)
    if (endpoint.includes('/issues?') || endpoint.includes('/pulls?')) return ''
    if (endpoint.includes('/pulls/39/reviews?')) return JSON.stringify(restReview)
    throw new Error(`unexpected endpoint: ${endpoint}`)
  }
  const fetched = teamStats.fetchStats({ repo: 'synthetic/example', date, isWeek: true }, run)
  assert.deepEqual(fetched.pullRequests.find(item => item.number === 39).reviews, [restReview])
  assert.match(scorecard(fetched, date), /^\| codex \| 1 \| 0 \| 1\/1 \| 1\.0 \| 0 \|$/m)
  assert.doesNotMatch(scorecard(fetched, date), /merged with no review verdict:/)
})

test('team stats daily reads use the supplied runner for the milestone fragment too', () => {
  const milestone = { number: 15, title: '0.26.0 The mainstream AIs end to end', state: 'open' }
  const calls = []
  const run = (command, args) => {
    assert.equal(command, 'gh')
    calls.push(args.at(-1))
    const endpoint = args.at(-1)
    if (endpoint.includes('/milestones?')) return JSON.stringify(milestone)
    if (endpoint.includes('/issues?milestone=')) return ''
    if (endpoint.includes('/issues?') || endpoint.includes('/pulls?')) return ''
    if (endpoint.includes('/comments?')) return ''
    throw new Error(`unexpected endpoint: ${endpoint}`)
  }
  const fetched = teamStats.fetchStats({ repo: 'synthetic/example', date, isWeek: false }, run)
  assert.equal(fetched.milestoneWork?.milestone?.title, milestone.title)
  assert.equal(fetched.milestoneWork?.open, 0)
  assert.ok(calls.some(endpoint => endpoint.includes('/milestones?')))
  assert.match(dailyLine(fetched, date), /milestone 0\.26\.0: open 0, ready 0, really free 0/)
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

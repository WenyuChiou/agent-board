import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { claimComment, claimMarker, commentMarker, hasClaimNotice, issueMarker, issueTitle, main, queueComment } from '../scripts/review-queue-post.mjs'
import { main as queueMain } from '../scripts/review-queue.mjs'

const repo = 'WenyuChiou/agent-board'
const now = '2026-10-20T12:00:00Z'
const head = 'abcdef0123456789abcdef0123456789abcdef01'
const bot = { login: 'github-actions[bot]', type: 'Bot' }
const pull = (number, fields = {}) => ({
  number, title: `Synthetic change ${number}`, author: { login: 'alice' }, body: `Author: codex (x), fix/${number}`, isDraft: false,
  headRefOid: head, mergeStateStatus: 'CLEAN', additions: 10, deletions: 5, files: [], reviews: [], ...fields,
})
const readyComment = { body: `Ready for review ${head}`, created_at: '2026-10-20T09:00:00Z', id: 1 }
const claimedIssue = (number, comments) => ({ number, title: `Synthetic task ${number}`, comments })
const claim = (login, until, createdAt = '2026-10-18T09:00:00Z') => ({ body: `Claim: codex (x), fix/x, until ${until} UTC`, createdAt, author: { login } })
// The queue issue and its comment from an earlier run.
const posted = { issues: [{ number: 42, user: bot, body: `${issueMarker}\nSynthetic queue issue` }], issueComments: { 42: [{ id: 8, user: bot, body: `${commentMarker}\nold` }] } }

// A GitHub stand-in for gh: it answers the reads the queue makes and records every write, so no test reaches the network.
// It respects the requested --limit on a pull request list, as gh does, so a list longer than the cap reads back truncated.
const gitHub = ({ prs = [], prComments = {}, claimed = [], issues = [], issueComments = {}, failOn = null } = {}) => {
  const calls = []
  const run = (command, args, options = {}) => {
    calls.push({ command, args, input: options.input === undefined ? undefined : JSON.parse(options.input) })
    const method = args[1] === '--method' ? args[2] : null
    const path = method ? args[3] : args.at(-1)
    if (failOn?.({ args, method, path })) throw new Error('synthetic gh failure, token ghp_000000000000000000000000')
    if (args[0] === 'pr' && args[1] === 'list') {
      const limit = Number(args[args.indexOf('--limit') + 1])
      return JSON.stringify(Number.isFinite(limit) ? prs.slice(0, limit) : prs)
    }
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(claimed)
    if (args[0] === 'issue' && args[1] === 'pin') return ''
    if (method === 'POST' && path === `repos/${repo}/issues`) return JSON.stringify({ number: 900, ...calls.at(-1).input })
    if (method) return JSON.stringify({ id: 1 })
    const lines = items => items.map(item => JSON.stringify(item)).join('\n')
    if (path.includes('/collaborators')) return ''
    if (path.startsWith(`repos/${repo}/issues?`)) return lines(issues)
    const number = Number(path.match(/issues\/(\d+)\/comments/)?.[1])
    return lines(prComments[number] ?? issueComments[number] ?? [])
  }
  const writes = () => calls.filter(call => call.args[1] === '--method' || call.args[1] === 'pin')
    .map(call => call.args[1] === 'pin' ? ['PIN', call.args[2], undefined] : [call.args[2], call.args[3], call.input])
  return { run, calls, writes }
}
const post = (github, argv = [], printQueue = queueMain) => {
  const out = []
  const err = []
  const code = main(argv, { run: github.run, now: () => new Date(now), log: text => out.push(text), error: text => err.push(text), printQueue })
  return { code, out: out.join('\n'), err: err.join('\n') }
}
const targets = github => github.writes().map(([method, path]) => [method, path])

test('the first run opens the queue issue, pins it and posts the queue as one comment', () => {
  const github = gitHub({ prs: [pull(5)], prComments: { 5: [readyComment] } })
  const lanes = []
  const { code, out } = post(github, [], (argv, deps) => {
    lanes.push(deps.lanes())
    return queueMain(argv, deps)
  })
  assert.equal(code, 0)
  assert.deepEqual(targets(github), [['POST', `repos/${repo}/issues`], ['PIN', '900'], ['POST', `repos/${repo}/issues/900/comments`]])
  const [[, , issue], , [, , comment]] = github.writes()
  assert.equal(issue.title, issueTitle)
  assert.ok(issue.body.startsWith(issueMarker))
  assert.ok(comment.body.startsWith(`${commentMarker}\nUpdated 2026-10-20 12:00 UTC by \`.github/workflows/review-queue.yml\`.`))
  assert.match(comment.body, /\n```text\nNeeds a reviewer \(1\)\n#5  15 lines  codex [(]x[)]  Synthetic change 5  Ready 3\.0 h/)
  assert.match(comment.body, /\nDrafts: 0\n```$/)
  // The lanes check reads folders on the computer that runs it, so the queue is given an empty one.
  assert.deepEqual(lanes, [{ stale: [], notes: [] }])
  assert.ok(github.calls.every(call => call.command === 'gh'))
  assert.match(out, /Opened #900 for the queue/)
})

test('a later run edits the queue comment in place and opens no second issue or comment', () => {
  const github = gitHub({ ...posted, prs: [pull(5)] })
  const { code, out } = post(github)
  assert.equal(code, 0)
  assert.deepEqual(targets(github), [['PATCH', `repos/${repo}/issues/comments/8`]])
  assert.ok(github.writes()[0][2].body.startsWith(commentMarker))
  assert.match(out, /#42: the queue comment is updated/)
  // Every list is read to its last page, so a queue issue past the first 100 is still found and never opened twice.
  const reads = github.calls.filter(call => call.args[0] === 'api' && call.args[1] !== '--method')
  assert.ok(reads.some(call => call.args.at(-1).startsWith(`repos/${repo}/issues?state=open`)))
  assert.ok(reads.every(call => call.args.includes('--paginate')))
})

test('a failed read of the claimed issues fails the run and still posts the queue', () => {
  const github = gitHub({ ...posted, failOn: ({ args }) => args[0] === 'issue' && args[1] === 'list' })
  const { code, err } = post(github)
  assert.equal(code, 1)
  assert.equal(err, 'Claims could not be read, so claimed was not taken off any issue; the next run tries again.')
  assert.deepEqual(targets(github), [['PATCH', `repos/${repo}/issues/comments/8`]])
  assert.match(github.writes()[0][2].body, /Note: claims could not be read/)
})

test('an issue or comment carrying the marker from anyone but the workflow\'s bot is not used', () => {
  const issues = [
    { number: 39, user: { login: 'github-actions', type: 'User' }, body: `${issueMarker}\na person, not the bot` },
    { number: 40, user: { login: 'mallory' }, body: `${issueMarker}\nnot the bot` },
    { number: 41, user: bot, body: issueMarker, pull_request: {} },
    { number: 43, user: bot, body: issueMarker },
  ]
  const github = gitHub({ issues, issueComments: { 43: [{ id: 3, user: { login: 'mallory' }, body: `${commentMarker}\nnot the bot` }] } })
  assert.equal(post(github).code, 0)
  assert.deepEqual(targets(github), [['POST', `repos/${repo}/issues/43/comments`]])
})

test('a claim that ran out loses claimed and gets one comment, and a later run does not comment again', () => {
  const expired = claimedIssue(12, [claim('ana', '2026-10-19 09:00')])
  const github = gitHub({ ...posted, claimed: [expired] })
  const { code, out } = post(github)
  assert.equal(code, 0)
  assert.deepEqual(targets(github), [
    ['POST', `repos/${repo}/issues/12/comments`], ['DELETE', `repos/${repo}/issues/12/labels/claimed`], ['PATCH', `repos/${repo}/issues/comments/8`],
  ])
  const [[, , notice], , [, , queue]] = github.writes()
  assert.equal(notice.body, claimComment('ana'))
  assert.ok(notice.body.startsWith(claimMarker))
  assert.doesNotMatch(notice.body, /^[ \t]*Claim:/m)
  assert.match(queue.body, /Claims that ran out, claimed taken off this run: #12/)
  assert.doesNotMatch(queue.body, /claim expired: #12/)
  assert.match(out, /#12: the claim ran out, claimed is off/)

  // The label change failed after the comment: the next run finds the bot's comment and only tries the label again.
  const noticed = claimedIssue(12, [...expired.comments, { body: notice.body, createdAt: '2026-10-20T11:00:00Z', author: { login: 'github-actions' } }])
  const again = gitHub({ ...posted, claimed: [noticed], failOn: ({ method }) => method === 'DELETE' })
  const failed = post(again)
  assert.equal(failed.code, 1)
  assert.deepEqual(targets(again), [['DELETE', `repos/${repo}/issues/12/labels/claimed`], ['PATCH', `repos/${repo}/issues/comments/8`]])
  assert.match(failed.err, /#12: the claim ran out but claimed could not be taken off; the next run tries again/)
  assert.match(again.writes()[1][2].body, /claim expired: #12/)
})

test('a renewed claim that runs out again gets a comment of its own, and only the bot\'s comment counts', () => {
  const notice = { body: claimComment('ana'), createdAt: '2026-10-19T10:00:00Z', author: { login: 'github-actions' } }
  assert.equal(hasClaimNotice([claim('ana', '2026-10-19 09:00'), notice]), true)
  assert.equal(hasClaimNotice([claim('ana', '2026-10-19 09:00'), notice, claim('ana', '2026-10-20 09:00', '2026-10-19T12:00:00Z')]), false)
  assert.equal(hasClaimNotice([claim('ana', '2026-10-19 09:00'), { ...notice, author: { login: 'mallory' } }]), false)
  assert.equal(hasClaimNotice([claim('ana', '2026-10-19 09:00'), { ...notice, author: null, user: bot, createdAt: undefined, created_at: '2026-10-19T10:00:00Z' }]), true)
})

test('a live claim, or one an open pull request names, keeps its label and gets no comment', () => {
  const live = claimedIssue(13, [claim('ana', '2026-10-21 09:00')])
  const named = claimedIssue(14, [claim('li', '2026-10-19 09:00')])
  const github = gitHub({ ...posted, claimed: [live, named], prs: [pull(6, { body: 'Fixes #14\nAuthor: codex (x), fix/14' })] })
  assert.equal(post(github).code, 0)
  assert.deepEqual(targets(github), [['PATCH', `repos/${repo}/issues/comments/8`]])
})

// A truncated pull request list cannot prove an issue has no open pull request, so the run fails closed: no expiry
// comment, no label removal, and the queue still posts with the reason noted.
test('a pull request list at its cap releases no claim and the run fails without unsafe writes', () => {
  // The issue's synthetic reproduction: 101 open pull requests, the first 100 do not name #12, only the 101st
  // says Fixes #12. The stand-in respects --limit, so the poster sees only the first 100.
  const many = Array.from({ length: 100 }, (_, index) => pull(index + 1, { body: `Author: codex (x), fix/${index + 1}` }))
  const linked = pull(101, { body: 'Fixes #12\nAuthor: codex (x), fix/12' })
  const expired = claimedIssue(12, [claim('ana', '2026-10-19 09:00')])
  const github = gitHub({ ...posted, claimed: [expired], prs: [...many, linked] })
  const { code, err } = post(github)
  assert.equal(code, 1)
  assert.match(err, /Pull request list may be truncated.*so claimed was not taken off any issue; the next run tries again\./)
  // Only the queue comment is written: no expiry comment on #12 and no label removal.
  assert.deepEqual(targets(github), [['PATCH', `repos/${repo}/issues/comments/8`]])
  assert.match(github.writes()[0][2].body, /Note: Pull request list may be truncated.*so expired claims are not listed\./)
  assert.doesNotMatch(github.writes()[0][2].body, /claim expired: #12/)
  // Exactly 100 is the cap too: the list may be complete or truncated, and the run still fails closed.
  const atCap = gitHub({ ...posted, claimed: [expired], prs: many })
  assert.equal(post(atCap).code, 1)
  assert.deepEqual(targets(atCap), [['PATCH', `repos/${repo}/issues/comments/8`]])
})

test('a pull request whose body could not be read releases no claim', () => {
  const expired = claimedIssue(12, [claim('ana', '2026-10-19 09:00')])
  const github = gitHub({ ...posted, claimed: [expired], prs: [pull(6, { body: null })] })
  const { code, err } = post(github)
  assert.equal(code, 1)
  assert.match(err, /Pull request list may be truncated.*so claimed was not taken off any issue; the next run tries again\./)
  assert.deepEqual(targets(github), [['PATCH', `repos/${repo}/issues/comments/8`]])
  assert.doesNotMatch(github.writes()[0][2].body, /claim expired: #12/)
})

test('a queue whose text fails the private-data check is not posted and the run fails', () => {
  // A made-up address in a title: the queue prints titles, and the same check as the PR check stops it.
  const github = gitHub({ ...posted, prs: [pull(5, { title: 'fix: send to ana@agent-board-synthetic.net' })] })
  const { code, err } = post(github)
  assert.equal(code, 1)
  assert.deepEqual(github.writes(), [])
  assert.match(err, /^The queue was not posted: email address in body line \d+\.$/)
  assert.doesNotMatch(err, /ana@/)
})

test('a dry run prints what it would post and change and writes nothing', () => {
  const github = gitHub({ ...posted, claimed: [claimedIssue(12, [claim('ana', '2026-10-19 09:00')])] })
  const { code, out } = post(github, ['--dry-run'])
  assert.equal(code, 0)
  assert.deepEqual(github.writes(), [])
  assert.match(out, /^Would comment on #12 and take claimed off #12$/m)
  assert.match(out, /^<!-- review-queue:comment -->$/m)
  assert.match(out, /claim expired: #12 ana/)
})

test('a GitHub failure is reported without raw diagnostics', () => {
  const unread = gitHub({ failOn: ({ args }) => args[0] === 'pr' })
  const read = post(unread)
  assert.equal(read.code, 1)
  assert.equal(read.err, 'GitHub data could not be read; check gh authentication and repository access.')
  assert.deepEqual(unread.writes(), [])

  const unwritten = gitHub({ ...posted, failOn: ({ method }) => method === 'PATCH' })
  const write = post(unwritten)
  assert.equal(write.code, 1)
  assert.equal(write.err, 'The queue could not be posted; check that the token may write issues.')

  const unpinned = gitHub({ failOn: ({ args }) => args[1] === 'pin' })
  const pin = post(unpinned)
  assert.equal(pin.code, 1)
  assert.deepEqual(targets(unpinned).at(-1), ['POST', `repos/${repo}/issues/900/comments`])
  assert.equal(pin.err, '#900 could not be pinned; pin it by hand')
  for (const text of [read.err, write.err, pin.err]) assert.doesNotMatch(text, /ghp_|synthetic gh failure/)
})

test('arguments allow one --dry-run and no --json, and help reads nothing', () => {
  for (const argv of [['--json'], ['--dry-run', '--dry-run'], ['--repo'], ['--bogus']]) {
    const github = gitHub()
    assert.equal(post(github, argv).code, 2)
    assert.deepEqual(github.calls, [])
  }
  const github = gitHub()
  const help = post(github, ['--help'])
  assert.equal(help.code, 0)
  assert.match(help.out, /^Usage: node scripts\/review-queue-post\.mjs/)
  assert.deepEqual(github.calls, [])
})

test('the posted text is fenced past any backticks in a title and cut to fit one GitHub comment', () => {
  assert.match(queueComment('#1  a title with ``` inside', now), /\n````text\n#1  a title with ``` inside\n````$/)
  // A mention cannot call a bot from the comment; an email address keeps its @ so the private-data check still finds it.
  assert.match(queueComment('    codex: not on this head (ask @codex review)', now), /\(ask @\u200bcodex review\)/)
  assert.match(queueComment('@dot see ana@example.com', now), /\n@\u200bdot see ana@example\.com\n/)
  const long = Array.from({ length: 3000 }, (_, index) => `#${index}  ${'x'.repeat(40)}`).join('\n')
  const cut = queueComment(long, now)
  assert.ok(cut.length <= 65536)
  assert.match(cut, /\n#\d+  x{40}\n```\n\nThe list stops here: the rest does not fit in one GitHub comment\. Run the script for all of it\.$/)
})

test('the workflow runs hourly and by hand, with only contents read, issues write and pull requests read', () => {
  const text = readFileSync(new URL('../.github/workflows/review-queue.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const block = name => text.match(new RegExp(`^${name}:\\n((?:[ \\t]+\\S.*\\n)+)`, 'm'))?.[1].trim().split('\n').map(line => line.trim())
  assert.deepEqual(block('on'), ['schedule:', "- cron: '7 * * * *'", 'workflow_dispatch:'])
  assert.deepEqual(block('permissions'), ['contents: read', 'issues: write', 'pull-requests: read'])
  // No job widens the token, and nothing but the workflow token is used.
  assert.equal(text.match(/^\s*permissions:/gm).length, 1)
  assert.doesNotMatch(text, /secrets\./)
  assert.match(text, /^ +persist-credentials: false$/m)
  // A run by hand from another branch would run that branch's script with issues: write, so it does nothing.
  assert.match(text, /^ +if: github\.repository == 'WenyuChiou\/agent-board' && github\.ref == 'refs\/heads\/main'$/m)
  assert.match(text, /^ +run: node scripts\/review-queue-post\.mjs --repo "\$GITHUB_REPOSITORY"$/m)
})

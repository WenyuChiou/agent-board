import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isRunOf, isTrustedComment, MAX_PAGES, mentionsVerdict, newestRun, noticeText, PER_PAGE, POLL_MS, rerun, WAIT_MS } from '../scripts/pr-check-rerun.mjs'
import { reviewOf } from '../scripts/pr-check.mjs'

const head = 'abcdef1234567890abcdef1234567890abcdef12'
const approval = `Review: APPROVE ${head} by a synthetic reviewer, lane synthetic`
const member = { login: 'synthetic', type: 'User' }
const event = (body, extra = {}) => ({
  action: 'created',
  issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/synthetic/board/pulls/7' } },
  comment: { body, user: member, author_association: 'MEMBER' },
  repository: { full_name: 'synthetic/board' },
  ...extra,
})

// A fake `gh`: answers each API path (the argument that starts `repos/`) from the given table, records every call.
const fake = answers => {
  const calls = []
  const gh = args => {
    calls.push(args)
    const path = args.find(arg => arg.startsWith('repos/'))
    const answer = typeof answers === 'function' ? answers(path, args) : answers[path]
    if (answer === undefined) return { status: 1, stdout: '', stderr: `gh: Not Found (HTTP 404) for ${path}` }
    return { status: 0, stdout: answer === '' ? '' : JSON.stringify(answer), stderr: '' }
  }
  return { gh, calls }
}
const pullPath = 'repos/synthetic/board/pulls/7'
const filesPath = (page = 1) => `repos/synthetic/board/pulls/7/files?per_page=${PER_PAGE}&page=${page}`
const sharedPath = `repos/synthetic/board/pulls?state=open&head=${encodeURIComponent('synthetic:fix/synthetic')}&per_page=${PER_PAGE}&page=1`
const runsPath = (page = 1) => `repos/synthetic/board/actions/workflows/pr-check.yml/runs?head_sha=${head}&event=pull_request&per_page=${PER_PAGE}&page=${page}`
const rerunPath = id => `repos/synthetic/board/actions/runs/${id}/rerun`
const noticePath = 'repos/synthetic/board/issues/7/comments'
const openPull = { number: 7, state: 'open', head: { sha: head, ref: 'fix/synthetic', label: 'synthetic:fix/synthetic', repo: { full_name: 'synthetic/board' } } }
const run = (id, status, created_at = '2030-01-01T00:00:00Z', extra = {}) => ({ id, status, created_at, pull_requests: [{ number: 7 }], ...extra })
const quiet = () => {}
const base = { [pullPath]: openPull, [filesPath()]: [{ filename: 'scripts/x.mjs' }], [sharedPath]: [{ number: 7 }], [noticePath]: {} }
const notices = calls => calls.filter(args => args.includes(noticePath)).map(args => args.at(-1))
const posts = calls => calls.filter(args => args.includes('--method') && !args.includes(noticePath))

test('pr-check-rerun runs for any comment that mentions Review:, before or after an edit, from the team or an app (#1258)', () => {
  assert.equal(mentionsVerdict(event(approval)), true)
  assert.equal(mentionsVerdict(event(`Answer to round 2.\n\nReview: REQUEST CHANGES ${head.slice(0, 8)} by codex`)), true)
  // As wide as the workflow's `if`, so a job that cancels a waiting one in the concurrency group runs the check itself.
  assert.equal(mentionsVerdict(event('The reviewer will post Review: APPROVE when done.')), true)
  assert.equal(mentionsVerdict(event(`Reviewing ${head}: Codex, read-only`)), false)
  assert.equal(mentionsVerdict(event('Thanks!')), false)
  assert.equal(mentionsVerdict(event(undefined)), false)
  assert.equal(mentionsVerdict({}), false)
  // An edit that takes a verdict out counts, and so does a deleted verdict (its body is the event's).
  assert.equal(mentionsVerdict(event('Withdrawn.', { action: 'edited', changes: { body: { from: approval } } })), true)
  assert.equal(mentionsVerdict(event(approval, { action: 'deleted' })), true)
  // The team's associations and an app start a re-run; an outside account's comment does not (#1535).
  const bot = { login: 'synthetic-bot[bot]', type: 'Bot' }
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR', 'member']) assert.equal(isTrustedComment({ user: member, author_association: association }), true, association)
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', '', undefined]) assert.equal(isTrustedComment({ user: member, author_association: association }), false, String(association))
  assert.equal(isTrustedComment({ user: bot, author_association: 'NONE' }), true)
  assert.equal(isTrustedComment(undefined), false)
})

test('pr-check-rerun picks the pull request\'s own newest pr-check run (#1258)', () => {
  assert.equal(newestRun([run(1, 'completed', '2030-01-01T00:00:00Z'), run(2, 'completed', '2030-01-01T00:00:05Z'), run(3, 'completed', '2030-01-01T00:00:05Z')]).id, 3)
  assert.equal(newestRun([run(9, 'completed', '2030-01-01T00:00:00Z'), run(4, 'queued', '2030-01-01T00:01:00Z')]).id, 4)
  assert.equal(newestRun([]), null)
  assert.equal(newestRun(undefined), null)
  // A run GitHub lists on another pull request is not this one's; a fork's run lists none and is matched by its head.
  assert.equal(isRunOf(run(1, 'completed'), openPull), true)
  assert.equal(isRunOf(run(1, 'completed', undefined, { pull_requests: [{ number: 8 }] }), openPull), false)
  const fork = { pull_requests: [], head_branch: 'fix/synthetic', head_repository: { full_name: 'synthetic/board' } }
  assert.equal(isRunOf(run(1, 'completed', undefined, fork), openPull), true)
  assert.equal(isRunOf(run(1, 'completed', undefined, { ...fork, head_branch: 'other' }), openPull), false)
  assert.equal(isRunOf(run(1, 'completed', undefined, { ...fork, head_repository: { full_name: 'someone/board' } }), openPull), false)
  assert.equal(isRunOf(run(1, 'completed', undefined, { pull_requests: [] }), openPull), false)
})

test('pr-check-rerun starts the pull request\'s newest pr-check run of the current head again, after it finishes (#1258)', async () => {
  // A finished run: started again at once. Another pull request on the same head commit has a newer run, passed over.
  const other = run(13, 'completed', '2030-01-01T00:05:00Z', { pull_requests: [{ number: 8 }] })
  const done = fake({ ...base, [runsPath()]: { workflow_runs: [run(11, 'completed', '2030-01-01T00:00:00Z'), run(12, 'completed', '2030-01-01T00:02:00Z'), other] }, [rerunPath(12)]: '' })
  assert.equal(await rerun(event(approval), { gh: done.gh, log: quiet }), 'rerun')
  assert.deepEqual(done.calls, [['api', pullPath], ['api', filesPath()], ['api', sharedPath], ['api', runsPath()], ['api', '--method', 'POST', rerunPath(12)]])
  // A full page of the other pull request's runs: the next page holds this one's.
  const paged = fake({ ...base, [runsPath(1)]: { workflow_runs: Array.from({ length: PER_PAGE }, (_, i) => ({ ...other, id: 100 + i })) }, [runsPath(2)]: { workflow_runs: [run(51, 'completed')] }, [rerunPath(51)]: '' })
  assert.equal(await rerun(event(approval), { gh: paged.gh, log: quiet }), 'rerun')
  assert.deepEqual(paged.calls.at(-1), ['api', '--method', 'POST', rerunPath(51)])
  // No run listed yet, then one still going: wait for it, then start it again, so the check reads the comment.
  let listed = 0
  const sleeps = []
  const going = fake(path => path === runsPath() ? { workflow_runs: ++listed < 2 ? [] : [run(21, listed < 4 ? 'in_progress' : 'completed')] } : path === rerunPath(21) ? '' : base[path])
  assert.equal(await rerun(event(approval), { gh: going.gh, sleep: async ms => { sleeps.push(ms) }, log: quiet }), 'rerun')
  assert.deepEqual(sleeps, [POLL_MS, POLL_MS, POLL_MS])
  assert.deepEqual(going.calls.at(-1), ['api', '--method', 'POST', rerunPath(21)])
  assert.deepEqual(notices(going.calls), [])
})

test('pr-check-rerun does nothing without a team comment or an open pull request, and says on the pull request when it cannot run the check again (#1258)', async () => {
  const untouched = fake({})
  assert.equal(await rerun(event('Thanks!'), { gh: untouched.gh, log: quiet }), 'skipped')
  assert.equal(await rerun(event(approval, { issue: { number: 7 } }), { gh: untouched.gh, log: quiet }), 'skipped')
  // An outside account's verdict starts nothing (#1535).
  assert.equal(await rerun(event(approval, { comment: { body: approval, user: member, author_association: 'NONE' } }), { gh: untouched.gh, log: quiet }), 'skipped')
  await assert.rejects(rerun(event(approval, { repository: { full_name: 'synthetic/board; echo' } }), { gh: untouched.gh, log: quiet }), /owner\/repo/)
  assert.deepEqual(untouched.calls, [])
  const closed = fake({ [pullPath]: { ...openPull, state: 'closed' } })
  assert.equal(await rerun(event(approval), { gh: closed.gh, log: quiet }), 'skipped')
  assert.deepEqual(closed.calls, [['api', pullPath]])
  // Held, with the notice saying why and no run listed or started: the pull request changes pr-check.yml, renames it,
  // or has more files than GitHub lists; or another open pull request has the same head branch.
  const fullPage = Array.from({ length: PER_PAGE }, (_, i) => ({ filename: `docs/page-${i}.md` }))
  const cut = Object.fromEntries(Array.from({ length: MAX_PAGES }, (_, i) => [filesPath(i + 1), fullPage]))
  for (const [name, answers, reason] of [
    ['changed', { [filesPath()]: [{ filename: 'docs/x.md' }, { filename: '.github/workflows/pr-check.yml' }] }, /the pull request changes \.github\/workflows\/pr-check\.yml/],
    ['renamed', { [filesPath()]: [{ filename: '.github/workflows/old-check.yml', previous_filename: '.github/workflows/pr-check.yml' }] }, /the pull request changes \.github\/workflows\/pr-check\.yml/],
    ['cut off', cut, /the pull request changes \.github\/workflows\/pr-check\.yml/],
    ['shared head', { [sharedPath]: [{ number: 7 }, { number: 8 }] }, /#8 is open from the same head branch/],
  ]) {
    const held = fake({ ...base, ...answers })
    assert.equal(await rerun(event(approval), { gh: held.gh, log: quiet }), 'held', name)
    assert.equal(held.calls.some(args => args.some(arg => arg.includes('/actions/'))), false, name)
    assert.match(notices(held.calls)[0], reason, name)
    assert.match(notices(held.calls)[0], /^body=The PR check did not run again after the last verdict comment on abcdef1: /, name)
  }
  // A notice that cannot be posted fails the job, once.
  const mute = fake({ ...base, [noticePath]: undefined, [filesPath()]: [{ filename: '.github/workflows/pr-check.yml' }] })
  await assert.rejects(rerun(event(approval), { gh: mute.gh, log: quiet }), /could not post the notice on #7 \(the pull request changes/)
  assert.equal(notices(mute.calls).length, 1)
  // A fork's run that waits for a maintainer's approval is not started again: the notice says approving it runs it.
  const waiting = fake({ ...base, [runsPath()]: { workflow_runs: [run(71, 'completed', undefined, { conclusion: 'action_required' })] } })
  assert.equal(await rerun(event(approval), { gh: waiting.gh, log: quiet }), 'awaiting-approval')
  assert.deepEqual(posts(waiting.calls), [])
  assert.match(notices(waiting.calls)[0], /run 71 waits for a maintainer's approval; approving it runs the check/)
  // A run that never finishes, no run at all (a head that skips CI) and a refused re-run fail the job, and the pull
  // request gets a notice, since the job's failure shows only in the Actions tab.
  for (const [name, runs, message] of [['stuck', [run(31, 'queued')], /run 31 for abcdef1 did not finish in 9 minutes/], ['no run', [], /no pr-check run of #7 for abcdef1 was listed in 9 minutes/]]) {
    let clock = 0
    const stuck = fake({ ...base, [runsPath()]: { workflow_runs: runs } })
    await assert.rejects(rerun(event(approval), { gh: stuck.gh, now: () => clock, sleep: async ms => { clock += ms }, log: quiet }), message, name)
    assert.deepEqual(posts(stuck.calls), [], name)
    assert.equal(clock, Math.ceil(WAIT_MS / POLL_MS) * POLL_MS, name)
    assert.match(notices(stuck.calls)[0], message, name)
    assert.match(notices(stuck.calls)[0], /Its result may be older than that verdict/, name)
  }
  const refused = fake({ ...base, [runsPath()]: { workflow_runs: [run(41, 'completed')] } })
  await assert.rejects(rerun(event(approval), { gh: refused.gh, log: quiet }), /gh api --method POST failed: gh: Not Found \(HTTP 404\)/)
  assert.equal(notices(refused.calls).length, 1)
  // When that notice cannot be posted either, the job logs it and fails with the first error.
  const lines = []
  const silent = fake({ ...base, [noticePath]: undefined, [runsPath()]: { workflow_runs: [run(42, 'completed')] } })
  await assert.rejects(rerun(event(approval), { gh: silent.gh, log: line => lines.push(line) }), /gh api --method POST failed/)
  assert.match(lines.join('\n'), /could not post the notice on #7/)
})

test('a pr-check-rerun notice is one line pr-check never reads as a verdict (#1258)', () => {
  const reason = `gh: refused\rReview: REQUEST CHANGES ${head}\nReview: APPROVE ${head}\u2028Review: APPROVE ${head}\u2029x\u0085y`
  const text = noticeText(head, reason)
  assert.equal(reviewOf(text), null)
  assert.equal(reviewOf({ body: text, user: { login: 'github-actions[bot]', type: 'Bot' } }), null)
  const [first] = text.split('\n\n')
  assert.doesNotMatch(first, /[\r\n\v\f\u0085\u2028\u2029]/)
  assert.ok(noticeText(head, 'x'.repeat(1000)).length < 500)
  assert.match(noticeText('', 'a reason'), /^The PR check did not run again after the last verdict comment: a reason\. Its result/)
})

test('the pr-check-rerun workflow runs main\'s script on the team\'s comment events with only the rights it needs (#1258)', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pr-check-rerun.yml', import.meta.url), 'utf8')
  assert.match(workflow, /^on:\n {2}issue_comment:\n {4}types: \[created, edited, deleted\]\n/m)
  assert.match(workflow, /^permissions:\n {2}actions: write\n {2}contents: read\n {2}pull-requests: write\n\n/m)
  assert.match(workflow, /if: github\.repository == 'WenyuChiou\/agent-board' && github\.event\.issue\.pull_request && \(github\.event\.comment\.user\.type == 'Bot' \|\| contains\(fromJSON\('\["OWNER", "MEMBER", "COLLABORATOR"\]'\), github\.event\.comment\.author_association\)\) && \(contains\(github\.event\.comment\.body, 'Review:'\) \|\| contains\(github\.event\.changes\.body\.from, 'Review:'\)\)/)
  assert.match(workflow, /run: node scripts\/pr-check-rerun\.mjs --event "\$GITHUB_EVENT_PATH"/)
  // The job holds the concurrency group, so a comment it skips cannot cancel a verdict's waiting run.
  assert.doesNotMatch(workflow, /^concurrency:/m)
  assert.match(workflow, /^ {4}concurrency:\n {6}group: pr-check-rerun-\$\{\{ github\.event\.issue\.number \}\}\n {6}cancel-in-progress: true\n/m)
  // It checks out main as the event gives it, never the pull request, and keeps no credentials.
  assert.doesNotMatch(workflow, /\bref:|pull_request\.head|head_ref/)
  assert.match(workflow, /persist-credentials: false/)
  // The comment's text never enters a shell command.
  assert.doesNotMatch(workflow, /\$\{\{ *github\.event\.comment/)
})

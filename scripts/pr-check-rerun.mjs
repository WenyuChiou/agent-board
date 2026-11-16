// Runs a pull request's pr-check again after a `Review:` verdict comment is posted, edited or deleted on it (#1258).
// pr-check (.github/workflows/pr-check.yml) runs on pull request events and reads the verdicts when it runs; a verdict
// is a comment, which starts no run, so a check that failed for a missing approval stayed failed after the approval
// and a passing check stayed green after a later request for changes. .github/workflows/pr-check-rerun.yml runs this
// on main's copy for every comment event. It reads the comment from the event file and calls only the GitHub API,
// through `gh` with the job's token: it waits for the pull request's newest pr-check run on its current head to finish,
// then starts that run again, so the check on the head reads the comment. When it cannot, it says why in a comment on
// the pull request, since the job's own failure shows only in the Actions tab.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WORKFLOW = 'pr-check.yml'
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW}`
// pr-check stops after 5 minutes; a run may also wait in the queue first, or not be listed yet just after a push.
export const WAIT_MS = 9 * 60 * 1000
export const POLL_MS = 15 * 1000
// Every `gh` call is cut off after a minute, and none starts after CALL_LIMIT_MS, so the job always ends with its own
// notice before the workflow's timeout-minutes would stop it with nothing on the pull request.
export const GH_TIMEOUT_MS = 60 * 1000
export const CALL_LIMIT_MS = WAIT_MS + 2 * 60 * 1000
// GitHub lists at most 100 runs, files or pull requests a page, and at most 3000 files of a pull request.
export const PER_PAGE = 100
export const MAX_PAGES = 30

// Only a team member's comment or an app's starts a re-run. pr-check does not check who wrote a verdict yet (#1535),
// so an outside comment must not make the check read it at once; the next pull request event reads it, as before.
const TEAM = ['OWNER', 'MEMBER', 'COLLABORATOR']
export const isTrustedComment = comment => comment?.user?.type === 'Bot' || TEAM.includes(String(comment?.author_association ?? '').toUpperCase())

// Any comment that mentions `Review:` in any letter case, now or before an edit, runs the check again: the same test
// as the workflow's `if` (its `contains` ignores case, and so does pr-check's `reviewOf`). A narrower test here would
// let a job that skips cancel a waiting verdict job in the concurrency group and then do nothing; with this one, the
// job that cancels another always runs the check again itself. A re-run for a mention that holds no verdict costs one
// PR check run and changes nothing.
export const mentionsVerdict = event => {
  const comment = event?.comment
  if (!comment) return false
  return [comment.body, event.changes?.body?.from].some(body => typeof body === 'string' && /review:/i.test(body))
}

// The newest run: the one created last, and the higher id between two created in the same second.
export const newestRun = runs => [...(runs ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0] ?? null

// A run is the pull request's when it ran on the pull request's head repository and branch, and GitHub lists the pull
// request on it when it lists any. A run from another branch on the same commit may list this pull request too, and
// a run from a fork lists none; two open pull requests from one head branch are held before this (holdReason).
export const isRunOf = (run, pull) => {
  const isHead = typeof run?.head_branch === 'string' && run.head_branch === pull?.head?.ref
    && typeof run?.head_repository?.full_name === 'string' && run.head_repository.full_name === pull?.head?.repo?.full_name
  const listed = Array.isArray(run?.pull_requests) ? run.pull_requests : []
  return isHead && (!listed.length || listed.some(item => item?.number === pull?.number))
}

// The notice a pull request gets when its check did not run again: one line. pr-check reads a line that starts
// `Review:` as a verdict, a bot's request for changes included, and a line starts after any line break, so the reason
// (an API error among them) is put on the same line and cut short. A comment the job's token posts starts no workflow.
export const noticeText = (head, reason) => {
  const oneLine = String(reason).replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ').trim().slice(0, 300).replace(/\.?$/, '.')
  return `The PR check did not run again after the last verdict comment${head ? ` on ${head.slice(0, 7)}` : ''}: ${oneLine} Its result may be older than that verdict; start pr-check again by hand, or push a commit. (pr-check-rerun, #1258)`
}

const ghJson = (gh, args) => {
  const ran = gh(args)
  if (ran.error || ran.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${String(ran.error?.message || ran.stderr || '').trim().split(/\r?\n/)[0]}`)
  return JSON.parse(ran.stdout || 'null')
}

// Every page of a list, up to MAX_PAGES; `isCut` says GitHub had more than that.
const pages = (gh, path, pick = listed => listed) => {
  const items = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const listed = pick(ghJson(gh, ['api', `${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`]))
    const found = Array.isArray(listed) ? listed : []
    items.push(...found)
    if (found.length < PER_PAGE) return { items, isCut: false }
  }
  return { items, isCut: true }
}

// The pull request's newest pr-check run on the head. Runs come newest first, so the first page with one of its runs
// holds the newest; a short page is the last.
const runOf = (gh, repo, head, pull) => {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const listed = ghJson(gh, ['api', `repos/${repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${head}&event=pull_request&per_page=${PER_PAGE}&page=${page}`])
    const runs = Array.isArray(listed?.workflow_runs) ? listed.workflow_runs : []
    const own = newestRun(runs.filter(run => isRunOf(run, pull)))
    if (own || runs.length < PER_PAGE) return own
  }
  return null
}

// Why the check is held, or null: the pull request changes pr-check.yml (a re-run would run its own copy of that
// file; a file list GitHub cuts off counts as a change), or another open pull request has the same head branch (its
// runs cannot be told from this one's).
const holdReason = (gh, repo, pull) => {
  const files = pages(gh, `repos/${repo}/pulls/${pull.number}/files`)
  if (files.isCut || files.items.some(file => file?.filename === WORKFLOW_PATH || file?.previous_filename === WORKFLOW_PATH)) return `the pull request changes ${WORKFLOW_PATH}, and a re-run would run its own copy of that file.`
  const label = String(pull.head?.label ?? '')
  const shared = pages(gh, `repos/${repo}/pulls?state=open&head=${encodeURIComponent(label)}`).items.filter(item => item?.number !== pull.number)
  if (shared.length) return `#${shared[0].number} is open from the same head branch, and its pr-check runs cannot be told from this pull request's.`
  return null
}

// The `gh` the job runs. A call that hangs is stopped after `timeout` and comes back with an error, which ends the job
// with its notice.
export const ghRunner = (command = 'gh', timeout = GH_TIMEOUT_MS) => args => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout })

const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested'])

// A notice that cannot be posted fails the job: the check would be left as it was with nothing on the pull request.
// Writes `noticed=true` to GITHUB_OUTPUT once posted so the workflow's fallback step posts no duplicate (#1538).
const postNotice = (gh, repo, number, head, reason, outputFile = process.env.GITHUB_OUTPUT) => {
  // No leading slash: Git for Windows' shell would turn "/repos/…" into a folder path before gh sees it.
  const posted = gh(['api', '--method', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${noticeText(head, reason)}`])
  if (posted.error || posted.status !== 0) {
    const failure = new Error(`could not post the notice on #${number} (${reason.replace(/\.$/, '')}): ${String(posted.error?.message || posted.stderr || '').trim().split(/\r?\n/)[0]}`)
    failure.isNotice = true
    throw failure
  }
  if (outputFile) appendFileSync(outputFile, 'noticed=true\n', 'utf8')
}

export const rerun = async (event, { gh = ghRunner(), sleep = ms => new Promise(done => setTimeout(done, ms)), now = () => Date.now(), log = console.log, outputFile = process.env.GITHUB_OUTPUT ?? null } = {}) => {
  const number = event?.issue?.number
  if (!event?.issue?.pull_request || !Number.isSafeInteger(number)) return log('pr-check-rerun: not a pull request comment; nothing to do.'), 'skipped'
  if (!mentionsVerdict(event)) return log(`pr-check-rerun: the comment on #${number} has no Review: line; nothing to do.`), 'skipped'
  if (!isTrustedComment(event.comment)) return log(`pr-check-rerun: the comment on #${number} is not from a team member or an app; the next pull request event reads it.`), 'skipped'
  const repo = event.repository?.full_name
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repository must be owner/repo.')
  const notify = (head, reason) => postNotice(gh, repo, number, head, reason, outputFile)
  let head = ''
  // Every call but the notice's: none starts after CALL_LIMIT_MS, and each stops after GH_TIMEOUT_MS.
  const stopAt = now() + CALL_LIMIT_MS
  const api = args => {
    if (now() >= stopAt) throw new Error(`the GitHub API did not answer in time; the job stopped after ${CALL_LIMIT_MS / 60000} minutes.`)
    return gh(args)
  }
  try {
    const pull = ghJson(api, ['api', `repos/${repo}/pulls/${number}`])
    if (pull?.state !== 'open') return log(`pr-check-rerun: #${number} is not open; nothing to do.`), 'skipped'
    head = String(pull.head?.sha ?? '')
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`#${number} has no head commit.`)
    const short = head.slice(0, 7)
    const held = holdReason(api, repo, pull)
    if (held) {
      notify(head, held)
      return log(`pr-check-rerun: #${number} held: ${held}`), 'held'
    }
    const deadline = now() + WAIT_MS
    for (;;) {
      const run = runOf(api, repo, head, pull)
      // A run from a fork that waits for a maintainer's approval: approving it runs it, and it reads the comments then.
      if (run && (run.status === 'action_required' || run.conclusion === 'action_required')) {
        notify(head, `pr-check run ${run.id} waits for a maintainer's approval; approving it runs the check, and it reads this verdict.`)
        return log(`pr-check-rerun: pr-check run ${run.id} of #${number} waits for approval.`), 'awaiting-approval'
      }
      if (run?.status === 'completed') {
        // A push while this waited starts the new head's own run, which reads the comments. Starting the old head's
        // run again would cancel that one (pr-check's concurrency group), so the job stops here.
        const latest = ghJson(api, ['api', `repos/${repo}/pulls/${number}`])
        if (latest?.state !== 'open' || latest?.head?.sha !== head) return log(`pr-check-rerun: #${number} moved on from ${short} while this waited; its own run reads the comment.`), 'superseded'
        try {
          ghJson(api, ['api', '--method', 'POST', `repos/${repo}/actions/runs/${run.id}/rerun`])
        } catch (error) {
          // A rerun request that started the run before timing out shows the run active on one follow-up read (#1538).
          let current = null
          try {
            current = ghJson(api, ['api', `repos/${repo}/actions/runs/${run.id}`])
          } catch {}
          if (ACTIVE_RUN_STATUSES.has(current?.status)) {
            log(`pr-check-rerun: pr-check run ${run.id} for ${short} on #${number} is ${current.status} after the rerun call failed; stopping without a notice.`)
            return 'rerun'
          }
          throw error
        }
        log(`pr-check-rerun: started pr-check run ${run.id} again for ${short} on #${number}.`)
        return 'rerun'
      }
      // No run yet (just after a push, or never, as for a head that skips CI), or one still going: wait for it.
      if (now() >= deadline) throw new Error(run ? `pr-check run ${run.id} for ${short} did not finish in ${WAIT_MS / 60000} minutes.` : `no pr-check run of #${number} for ${short} was listed in ${WAIT_MS / 60000} minutes.`)
      await sleep(POLL_MS)
    }
  } catch (error) {
    if (!error.isNotice) {
      try {
        notify(head, error.message)
      } catch (failure) {
        log(`pr-check-rerun: ${failure.message}`)
      }
    }
    throw error
  }
}

export const main = async (argv = process.argv.slice(2), deps = {}) => {
  const { gh = ghRunner(), log = console.log, env = process.env, readFile = readFileSync, outputFile = env.GITHUB_OUTPUT ?? null } = deps
  let event
  try {
    const at = argv.indexOf('--event')
    if (at === -1 || !argv[at + 1]) throw new Error('usage: node scripts/pr-check-rerun.mjs --event <event file>')
    event = JSON.parse(readFile(resolve(argv[at + 1]), 'utf8'))
  } catch (error) {
    const repo = env.REPO || env.GITHUB_REPOSITORY || ''
    const number = Number(env.NUMBER)
    if (/^[\w.-]+\/[\w.-]+$/.test(repo) && Number.isSafeInteger(number) && number > 0) {
      try {
        postNotice(gh, repo, number, '', error.message, outputFile)
      } catch (failure) {
        log(`pr-check-rerun: ${failure.message}`)
      }
    }
    throw error
  }
  return rerun(event, { ...deps, gh, log, outputFile })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`pr-check-rerun: ${error.message}`)
    process.exitCode = 1
  })
}

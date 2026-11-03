import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { privateData } from './pr-check.mjs'
import { safeLine } from './preflight.mjs'
import { fetchContext, fetchQueue, main as queueMain, parseArgs, readClaims } from './review-queue.mjs'

// Posts the review queue as one comment on one issue and takes `claimed` off claims that ran out (CONTRIBUTING rule 3).
// .github/workflows/review-queue.yml runs it every hour with the workflow token.
const usage = 'Usage: node scripts/review-queue-post.mjs [--repo owner/name] [--roadmap N] [--dry-run] [--help]'
const maxBuffer = 64 * 1024 * 1024
// GitHub refuses a comment longer than 65536 characters.
const bodyLimit = 65000
const readFailure = 'GitHub data could not be read; check gh authentication and repository access.'
export const issueTitle = 'Review queue (updated hourly)'
export const issueMarker = '<!-- review-queue:issue -->'
export const commentMarker = '<!-- review-queue:comment -->'
export const claimMarker = '<!-- review-queue:claim-expired -->'

// The workflow writes as github-actions[bot]; GraphQL answers drop the [bot] that REST answers keep. Only its own issue and
// comments count, so a comment someone else writes with a marker cannot move the queue or stop a claim notice.
const isBot = user => /^github-actions(?:\[bot\])?$/i.test(user?.login ?? '')
const isBotAccount = user => isBot(user) && user?.type === 'Bot'

export const parsePostArgs = argv => {
  const rest = argv.filter(flag => flag !== '--dry-run')
  if (argv.length - rest.length > 1 || rest.includes('--json')) throw new Error('unknown option or missing value')
  return { ...parseArgs(rest), isDryRun: rest.length < argv.length }
}

const formatUtc = ms => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
// A fence longer than any run of backticks in the text, so a pull request title cannot end the code block early.
const fenceFor = text => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)))

export const issueBody = [
  issueMarker,
  'The comment below is the review queue, the output of `node scripts/review-queue.mjs`: the open pull requests that need a reviewer, need main merged, may merge, or wait for their author.',
  '`.github/workflows/review-queue.yml` edits it every hour, and anyone with write access can run that workflow by hand from the Actions tab. Leave this issue open: if it is closed, the next run opens and pins a new one. Report a problem with the list in an issue of its own.',
].join('\n\n')

// A zero-width space after the @ of a mention, so a bot that reads the raw comment, such as Codex on "ask @codex review",
// is not called. The @ of an email address follows a letter and stays, so the private-data check still sees it.
const quiet = text => text.replace(/(^|[^\w.%+-])@(?=[A-Za-z0-9])/g, '$1@\u200b')

// The queue's own cleaned text in a code block: no mention, link or markdown in a title can act from it.
export const queueComment = (raw, now) => {
  const text = quiet(raw)
  const fence = fenceFor(text)
  const head = `${commentMarker}\nUpdated ${formatUtc(new Date(now).getTime())} by \`.github/workflows/review-queue.yml\`. Run \`node scripts/review-queue.mjs\` for the list as it is now.\n\n`
  const room = bodyLimit - head.length - 2 * fence.length - 200
  const isCut = text.length > room
  const shown = isCut ? text.slice(0, Math.max(0, text.lastIndexOf('\n', room))) : text
  const tail = isCut ? '\n\nThe list stops here: the rest does not fit in one GitHub comment. Run the script for all of it.' : ''
  return `${head}${fence}text\n${shown}\n${fence}${tail}`
}

export const claimComment = login => [
  claimMarker,
  `The claim by ${login} ran out and no open pull request names this issue, so \`claimed\` is off and anyone may take it (CONTRIBUTING rule 3). To go on with it, post a new claim comment and add \`claimed\` again.`,
].join('\n')

// The bot already said this claim ran out when its marked comment comes after the latest Claim comment, so a label change
// that failed is tried again without a second comment, and a renewed claim that runs out gets a comment of its own.
export const hasClaimNotice = comments => {
  const entries = (comments ?? []).map(item => ({ body: item.body ?? '', user: item.author ?? item.user, time: Date.parse(item.createdAt ?? item.created_at) }))
  const lastClaim = Math.max(-Infinity, ...entries.filter(entry => /^[ \t]*Claim:/m.test(entry.body)).map(entry => entry.time))
  return entries.some(entry => isBot(entry.user) && entry.body.startsWith(claimMarker) && entry.time > lastClaim)
}

const byNumber = (a, b) => (a.number ?? a.id) - (b.number ?? b.id)
export const findQueueIssue = issues => issues.filter(issue => !issue.pull_request && isBotAccount(issue.user) && (issue.body ?? '').startsWith(issueMarker)).sort(byNumber)[0] ?? null
export const findQueueComment = comments => comments.filter(comment => isBotAccount(comment.user) && (comment.body ?? '').startsWith(commentMarker)).sort(byNumber)[0] ?? null

const options = { encoding: 'utf8', maxBuffer, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }
const list = (run, path) => run('gh', ['api', '--paginate', '--jq', '.[] | tojson', path], options).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
// A body goes in on standard input, so no GitHub text reaches a command line.
const send = (run, method, path, data) => {
  const output = data === undefined
    ? run('gh', ['api', '--method', method, path], options)
    : run('gh', ['api', '--method', method, path, '--input', '-'], { ...options, stdio: ['pipe', 'pipe', 'pipe'], input: JSON.stringify(data) })
  return output.trim() ? JSON.parse(output) : null
}

export const main = (argv = process.argv.slice(2), { run = execFileSync, now = () => new Date(), log = console.log, error = console.error, printQueue = queueMain } = {}) => {
  let parsed
  try { parsed = parsePostArgs(argv) } catch {
    error(usage)
    return 2
  }
  if (parsed.isHelp) {
    log(usage)
    return 0
  }
  const { repo, isDryRun } = parsed
  const current = now()
  // One read of GitHub serves both the claims and the queue text.
  let queue
  let context
  try {
    queue = fetchQueue(parsed, { run })
    context = fetchContext(parsed, { run })
  } catch {
    // Raw gh diagnostics can include credentials not recognized by a redactor.
    error(readFailure)
    return 1
  }
  let isFailed = false
  const fail = message => {
    error(safeLine(message))
    isFailed = true
  }
  // fetchContext turns a failed lookup into a note; for the claims that would hide that step (2) stopped, so the run fails.
  if (!context.claimed) fail('Claims could not be read, so claimed was not taken off any issue; the next run tries again.')

  // The queue's own rule decides which claims ran out (CONTRIBUTING rule 3).
  const released = []
  for (const { number, login } of context.claimed ? readClaims(context.claimed, queue.prs, current) : []) {
    const isNoticed = hasClaimNotice(context.claimed.find(issue => issue.number === number)?.comments)
    if (isDryRun) {
      log(`Would ${isNoticed ? '' : `comment on #${number} and `}take claimed off #${number}`)
      continue
    }
    try {
      if (!isNoticed) send(run, 'POST', `repos/${repo}/issues/${number}/comments`, { body: claimComment(login) })
      send(run, 'DELETE', `repos/${repo}/issues/${number}/labels/claimed`)
      released.push(number)
      log(`#${number}: the claim ran out, claimed is off`)
    } catch {
      fail(`#${number}: the claim ran out but claimed could not be taken off; the next run tries again`)
    }
  }

  // The queue's own text, without the lanes check: lanes are folders on one computer, not on GitHub.
  const lines = []
  const claimed = context.claimed?.filter(issue => !released.includes(issue.number)) ?? null
  const code = printQueue(['--repo', repo, '--roadmap', String(parsed.roadmap)], {
    fetch: () => queue, context: () => ({ ...context, claimed }), lanes: () => ({ stale: [], notes: [] }),
    now: () => current, log: text => lines.push(text), error: text => lines.push(text),
  })
  if (code !== 0) {
    fail(readFailure)
    return 1
  }
  if (released.length) lines.push(`Claims that ran out, claimed taken off this run: ${released.map(number => `#${number}`).join(', ')}`)
  const body = queueComment(lines.join('\n'), current)
  // Nothing private goes up (RULES.md, R8): the same check the PR check runs on a pull request body.
  const { problems } = privateData({ added: [], body })
  if (problems.length) {
    fail(`The queue was not posted: ${problems.map(item => item.message).join(' ')}`)
    return 1
  }
  if (isDryRun) {
    log(body)
    return isFailed ? 1 : 0
  }

  try {
    let issue = findQueueIssue(list(run, `repos/${repo}/issues?state=open&per_page=100`))
    if (!issue) {
      issue = send(run, 'POST', `repos/${repo}/issues`, { title: issueTitle, body: issueBody })
      log(`Opened #${issue.number} for the queue`)
      try { run('gh', ['issue', 'pin', String(issue.number), '--repo', repo], options) } catch {
        fail(`#${issue.number} could not be pinned; pin it by hand`)
      }
    }
    const comment = findQueueComment(list(run, `repos/${repo}/issues/${issue.number}/comments?per_page=100`))
    if (comment) send(run, 'PATCH', `repos/${repo}/issues/comments/${comment.id}`, { body })
    else send(run, 'POST', `repos/${repo}/issues/${issue.number}/comments`, { body })
    log(`#${issue.number}: the queue comment is ${comment ? 'updated' : 'posted'}`)
  } catch {
    fail('The queue could not be posted; check that the token may write issues.')
  }
  return isFailed ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main()

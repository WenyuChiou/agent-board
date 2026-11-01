import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { authorKey, reviewOf } from './pr-check.mjs'
import { bundleSources, safeLine } from './preflight.mjs'

const usage = 'Usage: node scripts/review-queue.mjs [--repo owner/name] [--roadmap N] [--json] [--help]'
const maxBuffer = 64 * 1024 * 1024
const hour = 60 * 60 * 1000
const day = 24 * hour
const laneLimitHours = 2
const noticeWaitHours = 24
const noticeGapHours = 48
const awayLimitDays = 14
const claimSlotDays = 7

export const parseArgs = argv => {
  const options = { repo: 'WenyuChiou/agent-board', roadmap: 209, isJson: false, isHelp: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) throw new Error('duplicate option')
    seen.add(flag)
    if (flag === '--json') options.isJson = true
    else if (flag === '--help') options.isHelp = true
    else if (flag === '--repo' && argv[i + 1] && !argv[i + 1].startsWith('-')) options.repo = argv[++i]
    else if (flag === '--roadmap' && /^[1-9]\d{0,8}$/.test(argv[i + 1] ?? '')) options.roadmap = Number(argv[++i])
    else throw new Error('unknown option or missing value')
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(options.repo) || ['.', '..'].includes(options.repo.split('/')[1])) throw new Error('repo must be owner/name')
  return options
}

// A name is its first word, lower case: "claude (PM)" and "Claude" are both "claude".
const nameOf = text => (text ?? '').match(/[A-Za-z0-9][A-Za-z0-9_-]*/)?.[0].toLowerCase() ?? null
const reviewingName = body => nameOf((body ?? '').match(/^Reviewing:[ \t]*(\S[^\r\n]*)/m)?.[1])
const verdictName = body => nameOf((body ?? '').match(/^Review:[ \t]*(?:APPROVE|REQUEST CHANGES)\b[^\r\n]*?\bby[ \t]+(\S[^\r\n]*)/m)?.[1])
// The built bundle and the string tables change in almost every pull request, so approved ones that touch them merge one at a time.
const sharedPath = /^hooks\/(?:board-script(?:-[^/]+)?\.ts|i18n\.ts|strings-en\.ts|strings-zh-cn\.ts)$/

const readySha = body => (body ?? '').match(/^[ \t]*`?Ready for review[ \t]+`?([0-9a-f]{7,40})\b/i)?.[1]?.toLowerCase()
const byTime = (a, b) => a.time - b.time || (a.comment.id ?? 0) - (b.comment.id ?? 0) || a.index - b.index
const matchesHead = (head, sha) => Boolean(sha && head.startsWith(sha))
const commentsFor = (commentsByNumber, number) => commentsByNumber instanceof Map ? commentsByNumber.get(number) : commentsByNumber[number]
const entriesOf = source => (source ?? []).map((comment, index) => ({ comment, index, time: Date.parse(comment.created_at) })).sort(byTime)

// Hex words of 7 to 40 characters: the shape of a commit id or the start of one.
const shaWords = text => (text ?? '').toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) ?? []
const mentionsHead = (head, text) => shaWords(text).some(word => head.startsWith(word))
// A date and time read as UTC. One that rolls over (February 30, hour 24) is not a date, so it is NaN.
const utcMs = (date, time = '00:00:00') => {
  const ms = Date.parse(`${date}T${time}Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(`${date}T${time}`) ? ms : NaN
}
const formatUtc = ms => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`

const codexLogin = /^chatgpt-codex-connector(?:\[bot\])?$/i
const codexMarker = /<!--\s*codex-review-state:v1\s+(\{[\s\S]*?\})\s*-->/

// The newest Codex state comment decides. One whose JSON cannot be read is passed over, so noise cannot hide a real state.
const codexStateOf = (comments, head) => {
  for (const { comment } of [...comments].reverse()) {
    const json = codexLogin.test(comment.user?.login ?? '') ? (comment.body ?? '').match(codexMarker)?.[1] : null
    if (!json) continue
    let review
    try { review = JSON.parse(json)?.code_review } catch { continue }
    const sha = typeof review?.commit_sha === 'string' ? review.commit_sha.toLowerCase() : ''
    if (!/^[0-9a-f]{7,40}$/.test(sha) || typeof review.has_unresolved_findings !== 'boolean') continue
    if (!head.startsWith(sha)) return 'stale'
    return review.has_unresolved_findings ? 'open' : 'clean'
  }
  return 'none'
}

// Greptile is often absent, so only its presence on the head is reported and its absence is not.
const isGreptile = login => (login ?? '').toLowerCase().includes('greptile')
const hasGreptileReview = (comments, reviews, head) =>
  comments.some(({ comment }) => isGreptile(comment.user?.login) && mentionsHead(head, comment.body))
  || (Array.isArray(reviews) ? reviews : []).some(review => isGreptile(review?.author?.login) && (mentionsHead(head, review.body) || mentionsHead(head, review.commit?.oid)))

// A comment "Merging after <UTC time> unless someone objects" that also names a commit id (CONTRIBUTING rule 8).
export const parseNotice = body => {
  const named = (body ?? '').match(/^[ \t]*Merging after\b([^\r\n]*?)\bunless someone objects\b/mi)?.[1]
  const parts = named?.match(/^\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?\s*(?:UTC|Z)?\s*$/i)
  const at = parts ? utcMs(parts[1], `${parts[2]}:${parts[3] ?? '00'}`) : NaN
  const shas = shaWords(body)
  return Number.isFinite(at) && shas.length ? { at, shas } : null
}

// Governance files, workflows and the release files: a pull request touching one never merges after a notice (team-process, From claim to merge).
const governedPaths = new Set(['AGENTS.md', 'CONTRIBUTING.md', 'docs/dev/team-process.md', 'CHANGELOG.md', 'package.json', '.claude-plugin/plugin.json'])
const isGovernedPath = path => governedPaths.has(path) || path.startsWith('.github/')

// Where the merge-after-notice stands for a pull request (team-process, From claim to merge). Only the pull request's own author can
// give a notice, and the latest one that names the current head is the one that counts: a push leaves the old notice behind, so the
// check for a first notice starts over for the new head.
const noticeFor = ({ comments, head, ready, readyHours, takenBy, nowMs, isInQueue, isAllAway, hasBackSince, isGoverned, author }) => {
  const isByAuthor = comment => author !== '' && (comment.user?.login ?? '').toLowerCase() === author
  const authorNotice = entry => isByAuthor(entry.comment) ? parseNotice(entry.comment.body) : null
  const isAllowed = isInQueue && !takenBy && ((readyHours ?? 0) > noticeWaitHours || isAllAway)
  if (isGoverned) return comments.some(authorNotice) || isAllowed ? { state: 'not-allowed', at: null } : null
  const last = comments.findLastIndex(entry => authorNotice(entry)?.shas.some(word => head.startsWith(word)))
  if (last < 0) return isAllowed ? { state: 'allowed', at: null } : null
  const notice = authorNotice(comments[last])
  const at = new Date(notice.at).toISOString()
  // The author's own Reviewing comment does not take the review, so it does not end the notice.
  const isCancelled = comments.slice(last + 1).some(({ comment }) => (/^Reviewing:[ \t]*\S/m.test(comment.body ?? '') && !isByAuthor(comment))
    || reviewOf(comment.body)?.kind === 'REQUEST CHANGES' || /^\s*Objection\b/i.test(comment.body ?? ''))
  // A collaborator's Back on the roadmap issue after the notice ends it too (team-process, From claim to merge).
  if (isCancelled || hasBackSince(comments[last].time)) return { state: 'cancelled', at }
  const isTooEarly = notice.at - comments[last].time < noticeGapHours * hour || Boolean(ready && notice.at - ready.time < noticeGapHours * hour)
  if (isTooEarly) return { state: 'too-early', at }
  return { state: nowMs >= notice.at ? 'due' : 'waiting', at }
}

// Every collaborator except the pull request's own author is away. An unknown list, or nobody else, is not "everyone".
const isEveryOtherAway = (collaborators, awayLogins, author) => {
  const others = (collaborators ?? []).filter(login => login !== author)
  return others.length > 0 && others.every(login => awayLogins.has(login))
}

const reviewerNote = 'docs/dev/reviewers.json could not be read, so no reviewer is suggested'
const reviewersPath = fileURLToPath(new URL('../docs/dev/reviewers.json', import.meta.url))
const nameList = (value, isAuthors) => {
  const names = Array.isArray(value) ? value.map(item => typeof item === 'string' && (isAuthors && item.trim() === '*' ? '*' : nameOf(item))) : []
  if (!names.length || names.some(name => !name)) throw new Error('rules must list names')
  return names
}

// Reads the reviewers file text into the map classify takes; throws on a shape it cannot use.
export const parseReviewers = text => {
  const data = JSON.parse(text.replace(/^\uFEFF/, ''))
  const max = data?.maxOpenReviews ?? 2
  if (!Array.isArray(data?.rules) || !data.rules.length || !Number.isInteger(max) || max < 1) throw new Error('invalid reviewers file')
  return { maxOpenReviews: max, rules: data.rules.map(rule => ({ authors: nameList(rule?.authors, true), reviewers: nameList(rule?.reviewers, false) })) }
}

// A missing or unusable file never stops the queue: the caller prints the note and suggests nobody.
export const loadReviewers = ({ read = readFileSync, path = reviewersPath } = {}) => {
  try { return { map: parseReviewers(read(path, 'utf8')), note: null } } catch { return { map: null, note: reviewerNote } }
}

// Reviews taken and not yet answered, by reviewer, over every open pull request (drafts too): a Reviewing comment
// counts until the same name posts a verdict later on that pull request.
export const countOpenReviews = (prs, commentsByNumber) => {
  const counts = new Map()
  for (const pr of prs) {
    const open = new Set()
    for (const { comment } of entriesOf(commentsFor(commentsByNumber, pr.number))) {
      const taker = reviewingName(comment.body)
      if (taker) open.add(taker)
      const giver = verdictName(comment.body)
      if (giver) open.delete(giver)
    }
    for (const name of open) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

// The first reviewer of the author's rule who did not write the pull request and has room. Past four hours the
// first such name is skipped, and the last one is kept when none is left to skip to.
export const suggestReviewer = (map, { author, isOverFourHours }, openCounts) => {
  const rule = map.rules.find(item => item.authors.includes('*') || item.authors.includes(author))
  const eligible = (rule?.reviewers ?? []).filter(name => name !== author && (openCounts.get(name) ?? 0) < map.maxOpenReviews)
  const isEscalated = isOverFourHours && eligible.length > 1
  return { suggested: eligible[isEscalated ? 1 : 0] ?? null, isEscalated }
}

// context: { collaborators, awayLogins, backs, bundleSources } from the GitHub lookups. Every part may be missing, and a missing part only
// leaves its hint out: no collaborator list means no "everyone is away" notice, no bundle sources means only the generated files count.
// With no collaborator list, a Back from anyone but the author cancels a notice, since the safe reading is that the notice no longer stands.
export const classify = (prs, commentsByNumber, now, reviewers = null, context = {}) => {
  const result = { needsReviewer: [], needsMain: [], approved: [], approvedNow: [], approvedOneAtATime: [], waitingForAuthor: [], drafts: 0 }
  const nowMs = new Date(now).getTime()
  if (!Number.isFinite(nowMs)) throw new Error('invalid current time')
  const openCounts = reviewers ? countOpenReviews(prs, commentsByNumber) : null
  const collaborators = Array.isArray(context.collaborators) ? context.collaborators : null
  const awayLogins = new Set(context.awayLogins ?? [])
  const backs = context.backs ?? []
  // The bundle's sources and the release table change the generated files, so a pull request touching one conflicts with the others that do.
  const isSharedPath = path => sharedPath.test(path) || path === 'hooks/released.ts' || Boolean(context.bundleSources?.has(path))
  for (const pr of prs) {
    if (pr.isDraft) {
      result.drafts++
      continue
    }
    const item = {
      number: pr.number,
      size: pr.additions + pr.deletions,
      author: authorKey(pr.body ?? '') ?? pr.author?.login ?? 'unknown',
      title: pr.title ?? '',
    }
    // Only a conflict needs main merged first. A pull request that is merely behind main merges as it is (#607).
    if (pr.mergeStateStatus === 'DIRTY') {
      result.needsMain.push({ ...item, detail: 'no CI runs until main is merged' })
      continue
    }
    const head = (pr.headRefOid ?? '').toLowerCase()
    const comments = entriesOf(commentsFor(commentsByNumber, pr.number))
    const ready = comments.map((entry, index) => ({ ...entry, order: index }))
      .filter(entry => matchesHead(head, readySha(entry.comment.body))).at(-1)
    const verdicts = comments.map((entry, index) => ({ ...entry, order: index, verdict: reviewOf(entry.comment.body) }))
      .filter(entry => entry.verdict)
    const headVerdicts = verdicts.filter(entry => matchesHead(head, entry.verdict.sha))
    const latestHeadVerdict = headVerdicts.at(-1)
    const reviewAfterReady = ready && headVerdicts.some(entry => entry.order > ready.order)
    const takenBy = ready ? comments.slice(ready.order + 1)
      .map(entry => (entry.comment.body ?? '').match(/^Reviewing:[ \t]*(\S[^\r\n]*)/m)?.[1]?.trim())
      .filter(Boolean).at(-1) ?? null : null
    const author = (pr.author?.login ?? '').toLowerCase()
    const hasBackSince = since => backs.some(back => back.time > since && back.login !== author && (!collaborators || collaborators.includes(back.login)))
    // What the review bots and the merge-after-notice say about the head. A missing bot review never moves a pull request between groups.
    const extras = {
      bots: { codex: codexStateOf(comments, head), greptile: hasGreptileReview(comments, pr.reviews, head) },
      notice: noticeFor({
        comments, head, ready, takenBy, nowMs,
        readyHours: ready && Number.isFinite(ready.time) ? Math.max(0, nowMs - ready.time) / hour : null,
        isInQueue: Boolean(ready && !reviewAfterReady),
        isAllAway: isEveryOtherAway(collaborators, awayLogins, author), hasBackSince, author,
        // Without a file list a pull request cannot be shown to be clear of the governance files, but nothing is claimed about it either.
        isGoverned: Array.isArray(pr.files) && pr.files.some(file => isGovernedPath(file?.path ?? '')),
      }),
    }
    if (ready && !reviewAfterReady) {
      if (!Number.isFinite(ready.time)) throw new Error('invalid Ready time')
      const hours = Math.max(0, nowMs - ready.time) / hour
      const isOverFourHours = hours > 4
      const suggestion = reviewers ? suggestReviewer(reviewers, { author: nameOf(item.author), isOverFourHours }, openCounts) : {}
      result.needsReviewer.push({ ...item, readyAt: ready.comment.created_at, hours, isOverFourHours, takenBy, ...suggestion, ...extras })
    } else if (latestHeadVerdict?.verdict.kind === 'APPROVE') {
      // Without a file list a pull request cannot be shown to be clear of the shared files, so it waits its turn.
      const isOneAtATime = !Array.isArray(pr.files) || pr.files.some(file => isSharedPath(file?.path ?? ''))
      result.approved.push({ ...item, detail: 'ready to merge once checks pass', readyAt: ready?.comment.created_at ?? null, isOneAtATime, ...extras })
    } else {
      const lastVerdict = latestHeadVerdict ?? (!ready ? verdicts.at(-1) : null)
      result.waitingForAuthor.push({ ...item, detail: lastVerdict?.verdict.kind === 'REQUEST CHANGES' ? 'changes requested' : 'no Ready for current head', ...extras })
    }
  }
  result.needsReviewer.sort((a, b) => a.size - b.size || Date.parse(a.readyAt) - Date.parse(b.readyAt) || a.number - b.number)
  const readyMs = item => item.readyAt ? Date.parse(item.readyAt) : Infinity
  result.approvedNow = result.approved.filter(item => !item.isOneAtATime).sort((a, b) => a.size - b.size || a.number - b.number)
  result.approvedOneAtATime = result.approved.filter(item => item.isOneAtATime).sort((a, b) => readyMs(a) - readyMs(b) || a.number - b.number)
  return result
}

export const fetchQueue = ({ repo }, { run = execFileSync } = {}) => {
  const options = { encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] }
  // The Author line in the description distinguishes agents sharing a GitHub login.
  const fields = 'number,title,author,isDraft,headRefOid,mergeStateStatus,additions,deletions,updatedAt,url,body,files,reviews'
  const prs = JSON.parse(run('gh', ['pr', 'list', '--state', 'open', '--json', fields, '--limit', '100', '--repo', repo], options))
  const commentsByNumber = {}
  for (const pr of prs) {
    const output = run('gh', ['api', '--paginate', '--jq', '.[] | tojson', `repos/${repo}/issues/${pr.number}/comments?per_page=100`], options)
    commentsByNumber[pr.number] = output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
  }
  return { prs, commentsByNumber }
}

const jsonLines = output => output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))

// The three lookups beyond the pull requests: the roadmap issue's comments (Away notices), the collaborators, and the open issues
// labelled claimed. Each fails alone with a note, so a missing permission never stops the queue. A part that failed is null.
export const fetchContext = ({ repo, roadmap }, { run = execFileSync } = {}) => {
  const options = { encoding: 'utf8', maxBuffer, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }
  const notes = []
  const attempt = (note, action) => {
    try { return action() } catch {
      notes.push(note)
      return null
    }
  }
  const roadmapComments = attempt('away notices could not be read, so nobody is shown as away and a Back cannot be seen: a waiting or due notice may be stale',
    () => jsonLines(run('gh', ['api', '--paginate', '--jq', '.[] | tojson', `repos/${repo}/issues/${roadmap}/comments?per_page=100`], options)))
  const collaborators = attempt('collaborators could not be listed (this needs push access), so a notice for everyone away is not suggested',
    () => run('gh', ['api', '--paginate', '--jq', '.[] | select(.permissions.push or .permissions.admin) | .login', `repos/${repo}/collaborators?per_page=100`], options)
      .split(/\r?\n/).map(line => line.trim()).filter(Boolean))
  const claimed = attempt('claims could not be read, so expired claims are not listed',
    () => JSON.parse(run('gh', ['issue', 'list', '--label', 'claimed', '--state', 'open', '--json', 'number,title,comments', '--limit', '100', '--repo', repo], options)))
  return { roadmapComments, collaborators, claimed, notes }
}

// Collaborators who can approve, lower case, without the repository owner (the part of owner/name before the slash).
export const collaboratorLogins = (logins, repo) => {
  const owner = repo.split('/')[0].toLowerCase()
  return [...new Set(logins.map(login => String(login).toLowerCase()))].filter(login => login !== owner)
}

// "Away: until YYYY-MM-DD" as the first line of a comment on the roadmap issue sets that login away through that UTC date; a later
// comment by the same login starting "Back" ends it. A date more than 14 days after the comment is ignored and noted.
// backs lists every Back comment (lower case login, time in ms), since a notice to merge also ends when a collaborator is back.
export const readAway = (comments, now) => {
  const nowMs = new Date(now).getTime()
  const away = new Map()
  const ignored = new Map()
  const backs = []
  for (const { comment } of entriesOf(comments)) {
    const login = comment.user?.login
    if (!login) continue
    const key = login.toLowerCase()
    const first = (comment.body ?? '').trimStart().split(/\r?\n/, 1)[0]
    if (/^Back\b/i.test(first)) {
      away.delete(key)
      ignored.delete(key)
      const time = Date.parse(comment.created_at)
      if (Number.isFinite(time)) backs.push({ login: key, time })
      continue
    }
    const until = first.match(/^Away:[ \t]*until[ \t]+(\d{4}-\d{2}-\d{2})\b/i)?.[1]
    if (!until) continue
    const untilMs = utcMs(until)
    const postedMs = Date.parse(comment.created_at)
    if (!Number.isFinite(untilMs) || !Number.isFinite(postedMs)) continue
    if (untilMs - Math.floor(postedMs / day) * day > awayLimitDays * day) {
      ignored.set(key, { login, until, untilMs })
      continue
    }
    away.set(key, { login, until, untilMs })
    ignored.delete(key)
  }
  // A notice stands through its whole date. An ignored one is worth a note only while its date is still ahead.
  const standing = [...away.values()].filter(item => item.untilMs + day > nowMs).sort((a, b) => a.login.localeCompare(b.login))
  const notes = [...ignored.values()].filter(item => item.untilMs + day > nowMs)
    .map(item => `Away notice by ${item.login} ignored: ${item.until} is more than ${awayLimitDays} days after the comment`)
  return { active: standing.map(({ login, until }) => ({ login, until })), notes, backs }
}

// Open issues labelled claimed whose latest claim has run out (CONTRIBUTING rule 3) while no open pull request names them.
export const readClaims = (issues, prs, now) => {
  const nowMs = new Date(now).getTime()
  const linked = new Set()
  for (const pr of prs) for (const match of (pr.body ?? '').matchAll(/^[ \t]*(?:Fixes|Part of|Closes|Resolves)[ \t]+#(\d+)/gim)) linked.add(Number(match[1]))
  const expired = []
  for (const issue of issues) {
    if (linked.has(issue.number)) continue
    const comments = entriesOf((issue.comments ?? []).map(item => ({ body: item.body, created_at: item.createdAt ?? item.created_at, user: item.author ?? item.user })))
    // A renewal is a later Claim comment, so the live claim is the one that runs out last.
    let live = null
    for (const { comment, time } of comments) {
      const body = comment.body ?? ''
      const timed = body.match(/^[ \t]*Claim:[^\r\n]*,[ \t]*until[ \t]+(\d{4}-\d{2}-\d{2})[ \t]+(\d{2}:\d{2})[ \t]*UTC\b/m)
      const until = timed ? utcMs(timed[1], `${timed[2]}:00`)
        : /^[ \t]*Claim:[^\r\n]*\bwaiting for a slot\b/im.test(body) ? time + claimSlotDays * day : NaN
      if (Number.isFinite(until) && (!live || until > live.until)) live = { until, time, login: comment.user?.login ?? 'unknown' }
    }
    if (!live || live.until >= nowMs) continue
    // Someone who took the claim over after it ran out holds it now.
    if (comments.some(({ comment, time }) => time > live.time && /^[ \t]*Claim taken over:/im.test(comment.body ?? ''))) continue
    expired.push({ number: issue.number, login: live.login })
  }
  return expired.sort((a, b) => a.number - b.number)
}

const bundleNote = 'bundle sources could not be read, so only the generated bundle files count toward the one at a time order'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const loadBundleSources = ({ read = bundleSources, root = repoRoot } = {}) => {
  try { return { sources: read(root), note: null } } catch { return { sources: null, note: bundleNote } }
}

// Lanes older than the team's 2 h report limit with no open pull request (draft or not).
export const parseWorktrees = text => text.split(/\r?\n\r?\n/).map(block => {
  const lane = { branch: null, head: null, isDetached: false, isBare: false }
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) lane.path = line.slice(9)
    else if (line.startsWith('HEAD ')) lane.head = line.slice(5)
    else if (line.startsWith('branch refs/heads/')) lane.branch = line.slice(18)
    else if (line === 'detached') lane.isDetached = true
    else if (line === 'bare') lane.isBare = true
  }
  return lane
}).filter(lane => lane.path)

export const findStaleLanes = ({ repo }, { run = execFileSync, now = () => new Date(), birth = path => statSync(path).birthtimeMs } = {}) => {
  const options = { encoding: 'utf8', maxBuffer, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }
  const nowMs = new Date(now()).getTime()
  const notes = []
  let lanes
  try { lanes = parseWorktrees(run('git', ['worktree', 'list', '--porcelain'], options)) } catch {
    return { stale: [], notes: ['lane check skipped: git worktree list failed'] }
  }
  const stale = []
  // The first entry is the main checkout, whatever its HEAD is; a detached lane is still a lane.
  for (const lane of lanes.slice(1)) {
    if (lane.isBare || ['main', 'master'].includes(lane.branch)) continue
    const name = lane.branch ?? `${lane.path.split(/[\/]/).filter(Boolean).at(-1)} (detached)`
    const ref = lane.branch ?? lane.head
    let start = null
    try {
      const first = ref ? run('git', ['log', '--reverse', '--format=%ct', `main..${ref}`], options).split(/\r?\n/).find(line => line.trim()) : null
      if (first) start = Number(first) * 1000
    } catch { /* fall back to the folder below */ }
    if (start === null) {
      try { start = birth(lane.path) } catch { start = 0 }
      if (!(start > 0)) {
        notes.push(`${name}: age unknown, folder time unreadable`)
        continue
      }
    }
    const hours = Math.max(0, nowMs - start) / hour
    if (hours <= laneLimitHours) continue
    if (!lane.branch) {
      stale.push({ branch: name, hours, isDetached: true })
      continue
    }
    try {
      const open = JSON.parse(run('gh', ['pr', 'list', '--head', lane.branch, '--state', 'open', '--json', 'number', '--repo', repo], options))
      if (open.length) continue
      stale.push({ branch: name, hours })
    } catch {
      // A failed lookup must not hide the lane.
      stale.push({ branch: name, hours, unchecked: true })
      notes.push(`${name}: pull request lookup failed`)
    }
  }
  return { stale, notes }
}

export const formatLanes = ({ stale, notes }) => {
  const lines = stale.map(lane => `${lane.branch}  ${lane.hours.toFixed(1)} h  ${lane.isDetached ? 'detached, no branch' : lane.unchecked ? 'no PR (unchecked)' : 'no PR'}`)
  if (lines.length) lines.unshift(`Lanes over ${laneLimitHours} h without a pull request (${lines.length})`)
  return [...lines, ...notes.map(note => `Note: ${note}`)].map(safeLine).join('\n')
}

const safeData = value => {
  if (typeof value === 'string') return safeLine(value)
  if (Array.isArray(value)) return value.map(safeData)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeData(item)]))
  return value
}

const codexText = {
  none: 'codex: not on this head (ask @codex review)',
  stale: 'codex: not on this head (ask @codex review)',
  clean: 'codex: no findings',
  open: 'codex: findings open — answer each P0/P1 before approving',
}
const botText = bots => [codexText[bots?.codex], bots?.greptile ? 'greptile: reviewed' : ''].filter(Boolean).join('  ')
const noticeText = notice => {
  if (notice.state === 'allowed') return 'notice allowed if only a collaborator or the owner may approve it (team-process, From claim to merge)'
  if (notice.state === 'waiting') return `notice: merges after ${formatUtc(Date.parse(notice.at))}`
  if (notice.state === 'due') return 'notice due: merge if checks are green and the author\'s code-review subagent approved this head and no bot P0/P1 is open'
  if (notice.state === 'not-allowed') return 'no notice: governance, workflow or release pull requests merge only with an approval (CONTRIBUTING rules 8 and 12)'
  if (notice.state === 'too-early') return `notice too early: the time named must be ${noticeGapHours} hours after the notice and after Ready`
  return 'notice cancelled'
}
// The groups a reviewer or merger acts on show the bot state and the notice under each pull request.
const detailedGroups = new Set(['Needs a reviewer', 'Merge now, smallest first', 'One at a time, oldest Ready first'])

export const formatQueue = queue => {
  const data = safeData(queue)
  const lines = []
  if (!data.needsReviewer.length) lines.push('No pull requests need a reviewer.')
  const groups = [
    ['Needs a reviewer', data.needsReviewer],
    ['Needs main merged', data.needsMain],
    ['Merge now, smallest first', data.approvedNow],
    ['One at a time, oldest Ready first', data.approvedOneAtATime],
    ['Waiting for the author', data.waitingForAuthor],
  ]
  for (const [heading, items] of groups) {
    if (!items.length) continue
    lines.push(`${heading} (${items.length})`)
    for (const item of items) {
      const detail = heading === 'Needs a reviewer'
        ? `Ready ${item.hours.toFixed(1)} h${item.isOverFourHours ? ' over 4 h' : ''}${item.takenBy ? ` taken by ${item.takenBy}` : ''}${item.suggested === undefined ? '' : `  suggested: ${item.suggested ?? 'none'}${item.isEscalated ? ' escalated' : ''}`}`
        : item.detail
      lines.push(`#${item.number}  ${item.size} lines  ${item.author}  ${item.title.slice(0, 70)}  ${detail}`)
      if (!detailedGroups.has(heading)) continue
      if (item.bots) lines.push(`    ${botText(item.bots)}`)
      if (item.notice) lines.push(`    ${noticeText(item.notice)}`)
    }
  }
  lines.push(`Drafts: ${data.drafts}`)
  return lines.join('\n')
}

export const main = (argv = process.argv.slice(2), { fetch = fetchQueue, context = fetchContext, bundle = loadBundleSources, lanes = findStaleLanes, reviewers = loadReviewers, now = () => new Date(), log = console.log, error = console.error } = {}) => {
  let options
  try { options = parseArgs(argv) } catch {
    error(usage)
    return 2
  }
  if (options.isHelp) {
    log(usage)
    return 0
  }
  try {
    const { prs, commentsByNumber } = fetch(options)
    let suggestions
    try { suggestions = reviewers() } catch { suggestions = { map: null, note: reviewerNote } }
    const current = now()
    // Each extra lookup is optional: a failure leaves its part out and adds one note.
    let extra
    try { extra = context(options) ?? {} } catch { extra = { roadmapComments: null, collaborators: null, claimed: null, notes: ['GitHub lookups for away notices, collaborators and claims failed, so a Back cannot be seen: a waiting or due notice may be stale'] } }
    let sources
    try { sources = bundle() } catch { sources = { sources: null, note: bundleNote } }
    const away = extra.roadmapComments ? readAway(extra.roadmapComments, current) : { active: [], notes: [], backs: [] }
    const collaborators = extra.collaborators ? collaboratorLogins(extra.collaborators, options.repo) : null
    const queue = classify(prs, commentsByNumber, current, suggestions.map, {
      collaborators, awayLogins: away.active.map(item => item.login.toLowerCase()), backs: away.backs, bundleSources: sources.sources,
    })
    const expiredClaims = extra.claimed ? readClaims(extra.claimed, prs, current) : []
    let staleLanes
    try { staleLanes = lanes(options, { now }) } catch { staleLanes = { stale: [], notes: ['lane check skipped: lookup failed'] } }
    const notes = [suggestions.note, sources.note, ...(extra.notes ?? []), ...away.notes].filter(Boolean)
    if (options.isJson) log(JSON.stringify(safeData({ ...queue, staleLanes, away: away.active, expiredClaims, ...(notes.length ? { notes } : {}) }), null, 2))
    else {
      const awayLines = away.active.map(item => safeLine(`Away: ${item.login} until ${item.until}`))
      const claimLines = expiredClaims.map(item => safeLine(`claim expired: #${item.number} ${item.login} — relabel to ready (CONTRIBUTING rule 3)`))
      log([formatQueue(queue), ...awayLines, ...claimLines, formatLanes(staleLanes), ...notes.map(note => safeLine(`Note: ${note}`))].filter(Boolean).join('\n'))
    }
    return 0
  } catch {
    // Raw gh diagnostics can include credentials not recognized by a redactor.
    error('GitHub data could not be read; check gh authentication and repository access.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main()

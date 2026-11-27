import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { authorKey, isLaneReviewer, reviewOf, tierOf } from './pr-check.mjs'
import { bundleSources, safeLine } from './preflight.mjs'

const usage = 'Usage: node scripts/review-queue.mjs [--repo owner/name] [--roadmap N] [--json] [--help]'
const maxBuffer = 64 * 1024 * 1024
// The pull request list is capped here. At the cap it may omit a pull request that names an issue, so a list
// at the cap cannot prove an issue has no open pull request.
export const prListLimit = 100
const hour = 60 * 60 * 1000
const day = 24 * hour
const laneLimitHours = 2
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
// The full identity keeps the dispatching lane, like authorKey does: "codex (phase1)" and "codex (e2e)"
// are distinct agents (CONTRIBUTING rule 7), so only the first word is not enough to tell them apart.
// countOpenReviews keys its counts by a claim's first word, since the reviewers file lists first-word names;
// the author comparisons in classify use the full identity below, and only the same full name answers a claim.
const fullName = text => (text ?? '').replace(/`/g, '').split(',')[0].replace(/\s+/g, ' ').trim().toLowerCase() || null
const verdictFullName = body => fullName((body ?? '').match(/^Review:[ \t]*(?:APPROVE|REQUEST CHANGES)\b[^\r\n]*?\bby[ \t]+(\S[^\r\n]*)/m)?.[1])
// A claim is "Reviewing: <head sha> by <reviewer>" and holds that head only (team-process, From claim to merge).
// Only that form is a claim: the head's full sha, or 7 or more of its first characters as a Ready line may give,
// in backticks only as a pair; then `by` between spaces; then a name with a letter or digit before any comma.
// Anything else holds nothing. `key` is the name as a verdict must write it to answer the claim; `label` is shown.
const claimOf = body => {
  const line = (body ?? '').match(/^Reviewing:[ \t]*(\S[^\r\n\u2028\u2029]*)/m)?.[1]?.trim()
  const claim = line?.match(/^(`?)([0-9a-f]{7,40})\1[ \t]+by[ \t]+(\S.*)$/i)
  const key = claim ? fullName(claim[3]) : null
  if (!claim || !key || !/[\p{L}\p{N}]/u.test(key)) return null
  return { sha: claim[2].toLowerCase(), key, label: claim[3].trim() }
}
const identityOf = text => {
  const name = fullName(text)
  if (!name) return null
  // Only a final parenthesized suffix is a lane; earlier parentheses and all other name characters stay in the base.
  const match = name.match(/^(.+?)\s*\(([^()]*)\)$/)
  return match ? { base: match[1].trim(), lane: match[2].trim() || null } : { base: name, lane: null }
}
// Two names are the same agent when the base name matches and the lanes do not disagree: a name with no
// lane is read as the same agent, so a bare "codex" still counts as the author "codex (x)" — the
// conservative reading for self-approval, which can only ask for another reviewer, never merge early.
const sameAgent = (reviewer, author) => {
  const own = identityOf(author), name = fullName(reviewer)
  const matches = other => Boolean(other && own && other.base === own.base && (!other.lane || !own.lane || other.lane === own.lane))
  if (matches(identityOf(name))) return true
  if (!name || !own || !name.startsWith(own.base)) return false
  // Review prose has a boundary, not a vocabulary. A space alone after a bare
  // base is not one: "Claude" and "Claude Code" must remain distinct names.
  const boundary = tail => /^(?:$|[.:;!?。！？：；](?:\s|$)|\s[-–—]\s)/.test(tail)
  const tail = name.slice(own.base.length)
  // Ambiguous punctuation prefixes ("Dr" / "Dr. Agent") deliberately refuse
  // approval conservatively, as settled in the round-2 review of #952.
  if (boundary(tail)) return true
  const lane = tail.match(/^\s*\(([^()]*)\)(.*)$/)
  if (!lane) return false
  const reviewLane = lane[1].trim()
  if (reviewLane && own.lane && reviewLane !== own.lane) return false
  // After a complete matching lane, ordinary words may begin the review prose.
  return /^\s/.test(lane[2]) || boundary(lane[2])
}
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

// Codex also runs a security review, reported in the same state comment. When the paying account is out of usage the code
// review still completes but the security review fails, so a reviewer needs to see that it never ran on this head.
const codexSecurityOf = (comments, head) => {
  for (const { comment } of [...comments].reverse()) {
    const json = codexLogin.test(comment.user?.login ?? '') ? (comment.body ?? '').match(codexMarker)?.[1] : null
    if (!json) continue
    let review
    try { review = JSON.parse(json)?.security_review } catch { continue }
    const sha = typeof review?.commit_sha === 'string' ? review.commit_sha.toLowerCase() : ''
    if (!/^[0-9a-f]{7,40}$/.test(sha) || typeof review.status !== 'string') continue
    if (!head.startsWith(sha)) return 'stale'
    if (review.status !== 'completed') return 'skipped'
    // Only an explicit answer says whether findings are open. Codex leaves the field null on most completed reviews, so an
    // unknown one is kept apart from clean and, like clean, adds no line.
    if (review.has_unresolved_findings === true) return 'open'
    return review.has_unresolved_findings === false ? 'clean' : 'unknown'
  }
  return 'none'
}

// Greptile is often absent, so only its presence on the head is reported and its absence is not.
const isGreptile = login => (login ?? '').toLowerCase().includes('greptile')
const hasGreptileReview = (comments, reviews, head) =>
  comments.some(({ comment }) => isGreptile(comment.user?.login) && mentionsHead(head, comment.body))
  || (Array.isArray(reviews) ? reviews : []).some(review => isGreptile(review?.author?.login) && (mentionsHead(head, review.body) || mentionsHead(head, review.commit?.oid)))

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

// A Reviewing comment with no verdict lapses after this many hours, and anyone else may take the review (team-process).
const reviewingLapseHours = 2
const isLapsed = (time, nowMs) => Number.isFinite(nowMs) && Number.isFinite(time) && nowMs - time >= reviewingLapseHours * hour

// The claims on a head that no verdict has answered, in the order they were made, each with its time. Only a verdict
// on that head whose reviewer is written as the claim wrote it (the same fullName) answers a claim, in the same
// comment or a later one. A lane-less, other-lane or reworded name leaves the claim to lapse instead: a live claim
// cleared by mistake lets a second reviewer start while a review is under way.
// A second claim by the same name on the head does not restart its two hours (owner, 2026-11-12; #1358).
// Each `Review:` line of a comment is read on its own, so a verdict's head and its reviewer come from one line.
// The split uses every line end the `m` flag knows (LF, CRLF, CR, U+2028, U+2029), so no chunk holds two lines.
const headVerdictNames = (body, head) => (body ?? '').split(/\r\n|[\n\r\u2028\u2029]/)
  .filter(line => matchesHead(head, reviewOf(line)?.sha)).map(verdictFullName).filter(Boolean)
const openClaims = (entries, head) => {
  let open = []
  for (const { comment, time } of entries) {
    const claim = claimOf(comment.body)
    if (claim && matchesHead(head, claim.sha) && !open.some(item => item.key === claim.key)) open.push({ ...claim, time })
    const names = headVerdictNames(comment.body, head)
    if (names.length) open = open.filter(item => !names.includes(item.key))
  }
  return open
}

// Reviews taken and not yet answered, by reviewer, over every open pull request (drafts too): the open claims on
// each pull request's current head that have not lapsed, when nowMs is given, and are not the author's own.
export const countOpenReviews = (prs, commentsByNumber, nowMs) => {
  const counts = new Map()
  for (const pr of prs) {
    const author = authorKey(pr.body ?? '') ?? pr.author?.login ?? 'unknown'
    const open = openClaims(entriesOf(commentsFor(commentsByNumber, pr.number)), (pr.headRefOid ?? '').toLowerCase())
      .filter(claim => !isLapsed(claim.time, nowMs) && !sameAgent(claim.key, author))
    for (const name of new Set(open.map(claim => nameOf(claim.key) ?? claim.key))) counts.set(name, (counts.get(name) ?? 0) + 1)
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

// context: { bundleSources } from the GitHub lookups. Missing bundle sources means only the generated files count.
export const classify = (prs, commentsByNumber, now, reviewers = null, context = {}) => {
  const result = { needsReviewer: [], needsMain: [], approved: [], approvedNow: [], approvedOneAtATime: [], waitingForAuthor: [], drafts: 0 }
  const nowMs = new Date(now).getTime()
  if (!Number.isFinite(nowMs)) throw new Error('invalid current time')
  const openCounts = reviewers ? countOpenReviews(prs, commentsByNumber, nowMs) : null
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
    const verdicts = comments.map((entry, index) => ({ ...entry, order: index, verdict: reviewOf(entry.comment.body), by: verdictFullName(entry.comment.body) }))
      .filter(entry => entry.verdict)
    const headVerdicts = verdicts.filter(entry => matchesHead(head, entry.verdict.sha))
    const latestHeadVerdict = headVerdicts.at(-1)
    const reviewAfterReady = ready && headVerdicts.some(entry => entry.order > ready.order)
    // Agents share one GitHub login, so a Reviewing name is compared with the Author line's agent name, never the login:
    // the author's own Reviewing does not count as a review taken. The comparison keeps the dispatching lane:
    // "codex (e2e)" taking a review of "codex (phase1)" is a different agent, not the author.
    // Only an open claim on the current head is a review taken (openClaims), wherever the Ready comments for it fall.
    const taking = ready ? openClaims(comments, head).filter(claim => !sameAgent(claim.key, item.author)).at(-1) ?? null : null
    // A Reviewing comment past its 2 hours no longer holds the review; the queue names who let it lapse.
    const takenBy = taking && !isLapsed(taking.time, nowMs) ? taking.label : null
    const lapsedBy = taking && !takenBy ? taking.label : null
    // What the review bots say about the head. A missing bot review never moves a pull request between groups.
    const extras = {
      bots: { codex: codexStateOf(comments, head), codexSecurity: codexSecurityOf(comments, head), greptile: hasGreptileReview(comments, pr.reviews, head) },
    }
    if (ready && !reviewAfterReady) {
      if (!Number.isFinite(ready.time)) throw new Error('invalid Ready time')
      const hours = Math.max(0, nowMs - ready.time) / hour
      const isOverFourHours = hours > 4
      const suggestion = reviewers ? suggestReviewer(reviewers, { author: nameOf(item.author), isOverFourHours }, openCounts) : {}
      result.needsReviewer.push({ ...item, readyAt: ready.comment.created_at, hours, isOverFourHours, takenBy, lapsedBy, ...suggestion, ...extras })
    } else if (latestHeadVerdict?.verdict.kind === 'APPROVE' && latestHeadVerdict.by && sameAgent(latestHeadVerdict.by, item.author) && !isLaneReviewer(latestHeadVerdict.verdict, tierOf(pr.body))) {
      // Nobody approves their own work (RULES R2): a verdict named for the Author line's agent is not an approval,
      // even when it arrives from the shared login. The lane is part of the identity, so "codex (e2e)" approving
      // "codex (phase1)" counts, while a verdict with no name keeps its old reading. On the light and normal tiers a
      // reviewer the lane started new for this review counts, as the PR check reads it. This checks only who the author
      // is: whether the reviewer is one the pull request's tier allows (another model family on risk) is not checked here.
      result.waitingForAuthor.push({ ...item, detail: 'approval is by the author', ...extras })
    } else if (latestHeadVerdict?.verdict.kind === 'APPROVE') {
      // Without a file list a pull request cannot be shown to be clear of the shared files, so it waits its turn.
      // A release must contain current main before it merges (docs/RELEASING.md, step 5), so an approved one that is behind waits.
      if (/^chore\(release\):/.test(item.title) && (pr.mergeStateStatus === 'BEHIND' || pr.behindBy > 0 || pr.behindBy === null)) {
        result.needsMain.push({ ...item, detail: pr.behindBy === null ? 'approved; could not check whether it contains current main, so merge main first if unsure' : 'approved; merge main first (a release must contain current main)' })
        continue
      }
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
  const prs = JSON.parse(run('gh', ['pr', 'list', '--state', 'open', '--json', fields, '--limit', String(prListLimit), '--repo', repo], options))
  // The list is complete only below the cap with every pull request body read: at the cap it may omit a pull
  // request that names an issue, and a missing body cannot prove it names none.
  const prListComplete = prs.length < prListLimit && prs.every(pr => typeof pr.body === 'string')
  const commentsByNumber = {}
  for (const pr of prs) {
    const output = run('gh', ['api', '--paginate', '--jq', '.[] | tojson', `repos/${repo}/issues/${pr.number}/comments?per_page=100`], options)
    commentsByNumber[pr.number] = output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
  }
  // GitHub reports BEHIND only when main requires an up-to-date branch, which it does not, so a release pull request is
  // compared with main directly.
  for (const pr of prs) {
    if (!/^chore\(release\):/.test(pr.title ?? '') || pr.mergeStateStatus === 'BEHIND') continue
    try {
      pr.behindBy = Number(run('gh', ['api', '--jq', '.behind_by', `repos/${repo}/compare/main...${pr.headRefOid}`], options).trim()) || 0
    } catch { pr.behindBy = null }
  }
  return { prs, commentsByNumber, prListComplete }
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
  const milestoneRaw = attempt('milestone work could not be read, so the milestone counts are not listed',
    () => fetchMilestoneRaw({ repo }, { run }))
  return { roadmapComments, collaborators, claimed, milestoneRaw, notes }
}

// The milestone's raw data for summarizeMilestoneWork: the newest open milestone that is not Backlog,
// its open issues, every issue's comments, the time each unchecked issue entered the milestone, and the
// state of every issue a NOT READY check names in a First: line. Only the milestones list or the issues
// list failing throws: a single issue's read failing marks the result uncertain and names the issue.
export const fetchMilestoneRaw = ({ repo }, { run = execFileSync } = {}) => {
  const options = { encoding: 'utf8', maxBuffer, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }
  const notes = []
  let isUncertain = false
  const empty = { milestone: null, issues: [], commentsByNumber: {}, milestonedAt: {}, firstStates: {}, notes, isUncertain }
  const milestones = jsonLines(run('gh', ['api', '--paginate', '--jq', '.[] | tojson', `repos/${repo}/milestones?state=open&per_page=100`], options))
  const milestone = pickMilestone(milestones)
  if (!milestone) return empty
  const issues = jsonLines(run('gh', ['api', '--paginate', '--jq', '.[] | tojson', `repos/${repo}/issues?milestone=${milestone.number}&state=open&per_page=100`], options))
    .filter(item => !item.pull_request)
  const commentsByNumber = {}
  for (const issue of issues) {
    try {
      commentsByNumber[issue.number] = jsonLines(run('gh', ['api', '--paginate', '--jq', '.[] | tojson', `repos/${repo}/issues/${issue.number}/comments?per_page=100`], options))
    } catch {
      commentsByNumber[issue.number] = []
      isUncertain = true
      notes.push(`comments for #${issue.number} could not be read, so its Ready check and claim state are unknown`)
    }
  }
  // Only unchecked issues need their time in the milestone: the latest milestoned event for this milestone.
  // A timeline event names its milestone by title only, never by number, so the match is by title.
  const milestonedAt = {}
  for (const issue of issues) {
    if (entriesOf(commentsByNumber[issue.number]).some(({ comment }) => readyCheckOf(comment.body) !== null)) continue
    try {
      const events = jsonLines(run('gh', ['api', '--paginate', '--jq', '.[] | tojson', `repos/${repo}/issues/${issue.number}/timeline?per_page=100`], options))
      const times = events.filter(event => event.event === 'milestoned' && event.milestone?.title === milestone.title)
        .map(event => Date.parse(event.created_at)).filter(Number.isFinite)
      if (times.length) milestonedAt[issue.number] = Math.max(...times)
    } catch {
      isUncertain = true
      notes.push(`timeline for #${issue.number} could not be read, so its time in the milestone falls back to when it was opened`)
    }
  }
  const firstNumbers = new Set()
  for (const issue of issues) {
    const checks = entriesOf(commentsByNumber[issue.number]).filter(({ comment }) => readyCheckOf(comment.body) === 'not ready')
    const first = checks.at(-1) ? firstOf(checks.at(-1).comment.body) : null
    if (first) firstNumbers.add(first)
  }
  const firstStates = {}
  for (const number of firstNumbers) {
    try {
      firstStates[number] = run('gh', ['api', '--jq', '.state', `repos/${repo}/issues/${number}`], options).trim()
    } catch {
      isUncertain = true
      notes.push(`issue #${number} named by a First: line could not be read, so its state is unknown`)
    }
  }
  return { milestone: { number: milestone.number, title: milestone.title }, issues, commentsByNumber, milestonedAt, firstStates, notes, isUncertain }
}

// Collaborators who can approve, lower case, without the repository owner (the part of owner/name before the slash).
export const collaboratorLogins = (logins, repo) => {
  const owner = repo.split('/')[0].toLowerCase()
  return [...new Set(logins.map(login => String(login).toLowerCase()))].filter(login => login !== owner)
}

// "Away: until YYYY-MM-DD" as the first line of a comment on the roadmap issue sets that login away through that UTC date; a later
// comment by the same login starting "Back" ends it. A date more than 14 days after the comment is ignored and noted.
// backs lists every Back comment (lower case login, time in ms).
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

// A Claim comment's expiry: a timed claim runs out at its "until" time; one waiting for a slot runs out
// 7 days after its comment unless renewed the same way (CONTRIBUTING rule 3). Anything else claims nothing.
const claimUntil = (body, time) => {
  const timed = (body ?? '').match(/^[ \t]*Claim:[^\r\n]*,[ \t]*until[ \t]+(\d{4}-\d{2}-\d{2})[ \t]+(\d{2}:\d{2})[ \t]*UTC\b/m)
  if (timed) return utcMs(timed[1], `${timed[2]}:00`)
  if (/^[ \t]*Claim:[^\r\n]*\bwaiting for a slot\b/im.test(body ?? '')) return time + claimSlotDays * day
  return NaN
}

// The live claim is the Claim comment that runs out last: a renewal is a later Claim comment, so the
// latest expiry wins even when an older claim runs out later than a newer timed one.
const liveClaimOf = entries => {
  let live = null
  for (const { comment, time } of entries) {
    const until = claimUntil(comment.body ?? '', time)
    if (Number.isFinite(until) && (!live || until > live.until)) live = { until, time, login: comment.user?.login ?? 'unknown' }
  }
  return live
}

// Someone who took the claim over after it ran out holds it now.
const hasTakeoverAfter = (entries, time) => entries.some(({ comment, time: at }) => at > time && /^[ \t]*Claim taken over:/im.test(comment.body ?? ''))

// Open issues labelled claimed whose latest claim has run out (CONTRIBUTING rule 3) while no open pull request names them.
export const readClaims = (issues, prs, now) => {
  const nowMs = new Date(now).getTime()
  const linked = new Set()
  for (const pr of prs) for (const match of (pr.body ?? '').matchAll(/^[ \t]*(?:Fixes|Part of|Closes|Resolves)[ \t]+#(\d+)/gim)) linked.add(Number(match[1]))
  const expired = []
  for (const issue of issues) {
    if (linked.has(issue.number)) continue
    const comments = entriesOf((issue.comments ?? []).map(item => ({ body: item.body, created_at: item.createdAt ?? item.created_at, user: item.author ?? item.user })))
    const live = liveClaimOf(comments)
    if (!live || live.until >= nowMs) continue
    // Someone who took the claim over after it ran out holds it now.
    if (hasTakeoverAfter(comments, live.time)) continue
    expired.push({ number: issue.number, login: live.login })
  }
  return expired.sort((a, b) => a.number - b.number)
}

// A Ready check comment starts with "Ready check:" and names its verdict on that line, so a comment
// quoting an earlier check does not read as a new one. A check with no verdict reads as 'unknown'
// and still counts as checked.
export const readyCheckOf = body => {
  const first = (body ?? '').trimStart().split(/\r\n|[\n\r\u2028\u2029]/, 1)[0] ?? ''
  if (!/^[ \t]*Ready check:/i.test(first)) return null
  return first.match(/^[ \t]*Ready check:[ \t]*(NOT READY|READY|needs-owner)\b/i)?.[1]?.toLowerCase() ?? 'unknown'
}

// The one thing a NOT READY check names as standing in the way: a line starting "First:" naming an issue.
const firstOf = body => {
  const line = (body ?? '').split(/\r\n|[\n\r\u2028\u2029]/).find(item => /^[ \t]*First:/i.test(item))
  const number = line?.match(/#(\d+)/)?.[1]
  return number ? Number(number) : null
}

// The newest open milestone that is not Backlog: the latest created, the higher number breaking a tie.
// "Backlog" is a milestone title, not a state, so it is excluded by name.
export const pickMilestone = milestones => [...(milestones ?? [])]
  .filter(item => item?.state === 'open' && (item.title ?? '').trim().toLowerCase() !== 'backlog')
  .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || b.number - a.number)[0] ?? null

const labelNames = issue => (issue.labels ?? []).map(label => (typeof label === 'string' ? label : label?.name ?? '').toLowerCase())
const assigneeLogins = issue => (issue.assignees ?? []).map(assignee => assignee?.login).filter(Boolean)
// A line saying someone works on the issue: a line starting Claim:, Claim taken over: or Working on.
const worksOn = body => /^[ \t]*(?:Claim:|Claim taken over:|Working on\b)/im.test(body ?? '')

// The milestone's work from already-fetched data: no gh call here, so tests run on synthetic issues.
// raw: { milestone, issues, commentsByNumber, milestonedAt, firstStates, notes, isUncertain } from fetchMilestoneRaw.
// Taken follows CONTRIBUTING rule 3 and RULES R4 exactly as #1904 states them; the claimed label alone never takes.
export const summarizeMilestoneWork = (raw, { prs, prListComplete, now }) => {
  const nowMs = new Date(now).getTime()
  if (!Number.isFinite(nowMs)) throw new Error('invalid current time')
  if (!raw?.milestone) {
    return {
      milestone: null, open: 0, ready: 0, reallyFree: 0, unchecked: [], expiredClaims: [],
      staleClaimed: [], idleAssignees: [], staleFirst: [], isUncertain: Boolean(raw?.isUncertain),
    }
  }
  const linked = new Set()
  for (const pr of prs ?? []) for (const match of (pr.body ?? '').matchAll(/^[ \t]*(?:Fixes|Part of|Closes|Resolves)[ \t]+#(\d+)/gim)) linked.add(Number(match[1]))
  const notes = [...(raw.notes ?? [])]
  let isUncertain = Boolean(raw.isUncertain)
  // An incomplete pull request list cannot prove an issue has no open pull request, so the free counts are uncertain.
  if (prListComplete === false) {
    isUncertain = true
    notes.push('Pull request list may be truncated (at its 100-item limit, or a pull request body could not be read), so an issue may look free while an open pull request names it.')
  }
  const work = {
    milestone: { number: raw.milestone.number, title: raw.milestone.title },
    open: raw.issues.length, ready: 0, reallyFree: 0, unchecked: [], expiredClaims: [],
    staleClaimed: [], idleAssignees: [], staleFirst: [], isUncertain,
  }
  for (const issue of raw.issues) {
    const labels = labelNames(issue)
    const isReady = labels.includes('ready')
    const isBlocked = labels.includes('blocked')
    const comments = entriesOf(raw.commentsByNumber?.[issue.number] ?? [])
    const checks = comments.filter(({ comment }) => readyCheckOf(comment.body) !== null)
    const latestCheck = checks.at(-1)
    const verdict = latestCheck ? readyCheckOf(latestCheck.comment.body) : null
    const live = liveClaimOf(comments)
    const isLiveClaim = Boolean(live && live.until >= nowMs)
    const isTakeoverHeld = Boolean(live && live.until < nowMs && hasTakeoverAfter(comments, live.time))
    const isRecentWork = comments.some(({ comment, time }) => time > nowMs - day && time <= nowMs && worksOn(comment.body))
    const isTaken = assigneeLogins(issue).length > 0 || isLiveClaim || isTakeoverHeld || isRecentWork || linked.has(issue.number)
    if (isReady) work.ready++
    if (isReady && !isBlocked && !isTaken) work.reallyFree++
    if (!latestCheck) {
      const since = raw.milestonedAt?.[issue.number] ?? Date.parse(issue.created_at)
      const days = Number.isFinite(since) ? (nowMs - since) / day : NaN
      work.unchecked.push({ number: issue.number, title: issue.title ?? '', since, days: Number.isFinite(days) ? Number(days.toFixed(1)) : null })
    }
    // An expired claim is free to take over only with no pull request, no takeover and no recent work comment.
    if (live && live.until < nowMs && !linked.has(issue.number) && !isTakeoverHeld && !isRecentWork) {
      work.expiredClaims.push({ number: issue.number, login: live.login })
    }
    if (labels.includes('claimed') && !isLiveClaim && !isTakeoverHeld) work.staleClaimed.push({ number: issue.number })
    for (const login of assigneeLogins(issue)) {
      const isActive = linked.has(issue.number) || comments.some(({ comment, time }) =>
        time > nowMs - day && time <= nowMs && (comment.user?.login ?? '').toLowerCase() === login.toLowerCase())
      if (!isActive) work.idleAssignees.push({ number: issue.number, login })
    }
    if (verdict === 'not ready') {
      const first = firstOf(latestCheck.comment.body)
      if (first && raw.firstStates?.[first] === 'closed') work.staleFirst.push({ number: issue.number, first })
    }
  }
  work.unchecked.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.number - b.number)
  work.expiredClaims.sort((a, b) => a.number - b.number)
  work.staleClaimed.sort((a, b) => a.number - b.number)
  work.idleAssignees.sort((a, b) => a.number - b.number || a.login.localeCompare(b.login))
  work.staleFirst.sort((a, b) => a.number - b.number)
  if (notes.length) work.uncertain = notes
  return work
}

export const formatMilestoneWork = work => {
  if (!work?.milestone) return ''
  const lines = [`Milestone ${work.milestone.title} (#${work.milestone.number}): open ${work.open}, ready ${work.ready}, really free ${work.reallyFree}`]
  if (work.unchecked.length) {
    lines.push(`No Ready check (${work.unchecked.length}, oldest first)`)
    for (const item of work.unchecked) lines.push(`#${item.number}  ${item.days === null ? 'age unknown' : `${item.days.toFixed(1)} d`}  ${item.title.slice(0, 70)}`)
  }
  if (work.expiredClaims.length) {
    lines.push(`Claims past their time, no pull request (${work.expiredClaims.length})`)
    for (const item of work.expiredClaims) lines.push(`#${item.number} ${item.login} — claim ran out, no pull request`)
  }
  if (work.staleClaimed.length) {
    lines.push(`Claimed labels with no live claim (${work.staleClaimed.length})`)
    for (const item of work.staleClaimed) lines.push(`#${item.number} — claimed label with no live claim`)
  }
  if (work.idleAssignees.length) {
    lines.push(`Assignees with no activity for over 24 hours (${work.idleAssignees.length})`)
    for (const item of work.idleAssignees) lines.push(`#${item.number} ${item.login} — no activity for over 24 hours (listed, never removed)`)
  }
  if (work.staleFirst.length) {
    lines.push(`NOT READY with a closed First: (${work.staleFirst.length})`)
    for (const item of work.staleFirst) lines.push(`#${item.number} — First: #${item.first} closed, due a new check`)
  }
  for (const note of work.uncertain ?? []) lines.push(`uncertain: ${note}`)
  return lines.map(safeLine).join('\n')
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
// Only a security review that did not run, or left findings open, is named: a clean or missing one adds nothing to the code review line.
const codexSecurityText = {
  skipped: 'codex security: did not run on this head (usage limit or failure); review security yourself',
  open: 'codex security: findings open — answer each before approving',
}
const botText = bots => [codexText[bots?.codex], codexSecurityText[bots?.codexSecurity], bots?.greptile ? 'greptile: reviewed' : ''].filter(Boolean).join('  ')
// The groups a reviewer or merger acts on show the bot state under each pull request.
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
        ? `Ready ${item.hours.toFixed(1)} h${item.isOverFourHours ? ' over 4 h' : ''}${item.takenBy ? ` taken by ${item.takenBy}` : ''}${item.lapsedBy ? ` review by ${item.lapsedBy} lapsed` : ''}${item.suggested === undefined ? '' : `  suggested: ${item.suggested ?? 'none'}${item.isEscalated ? ' escalated' : ''}`}`
        : item.detail
      lines.push(`#${item.number}  ${item.size} lines  ${item.author}  ${item.title.slice(0, 70)}  ${detail}`)
      if (!detailedGroups.has(heading)) continue
      if (item.bots) lines.push(`    ${botText(item.bots)}`)
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
    const { prs, commentsByNumber, prListComplete } = fetch(options)
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
    // An incomplete pull request list cannot prove an issue has no open pull request, so no expired claim is
    // listed from it. A fetch that does not report completeness keeps the old reading.
    const prListNote = prListComplete === false ? 'Pull request list may be truncated (at its 100-item limit, or a pull request body could not be read), so expired claims are not listed.' : null
    const expiredClaims = extra.claimed && prListComplete !== false ? readClaims(extra.claimed, prs, current) : []
    // The milestone section needs the fetched raw data; an injected context without it (a stub) prints none.
    const milestoneWork = extra.milestoneRaw ? summarizeMilestoneWork(extra.milestoneRaw, { prs, prListComplete, now: current }) : null
    const showMilestone = milestoneWork?.milestone ? milestoneWork : null
    let staleLanes
    try { staleLanes = lanes(options, { now }) } catch { staleLanes = { stale: [], notes: ['lane check skipped: lookup failed'] } }
    const notes = [suggestions.note, sources.note, ...(extra.notes ?? []), ...away.notes, prListNote].filter(Boolean)
    if (options.isJson) log(JSON.stringify(safeData({ ...queue, staleLanes, away: away.active, expiredClaims, ...(showMilestone ? { milestoneWork: showMilestone } : {}), ...(notes.length ? { notes } : {}) }), null, 2))
    else {
      const awayLines = away.active.map(item => safeLine(`Away: ${item.login} until ${item.until}`))
      const claimLines = expiredClaims.map(item => safeLine(`claim expired: #${item.number} ${item.login} — relabel to ready (CONTRIBUTING rule 3)`))
      log([formatQueue(queue), ...awayLines, ...claimLines, formatLanes(staleLanes), showMilestone ? formatMilestoneWork(showMilestone) : '', ...notes.map(note => safeLine(`Note: ${note}`))].filter(Boolean).join('\n'))
    }
    return 0
  } catch {
    // Raw gh diagnostics can include credentials not recognized by a redactor.
    error('GitHub data could not be read; check gh authentication and repository access.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main()

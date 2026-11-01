import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { authorKey, reviewOf } from './pr-check.mjs'
import { safeLine } from './preflight.mjs'

const usage = 'Usage: node scripts/review-queue.mjs [--repo owner/name] [--json] [--help]'
const maxBuffer = 64 * 1024 * 1024
const hour = 60 * 60 * 1000
const laneLimitHours = 2

export const parseArgs = argv => {
  const options = { repo: 'WenyuChiou/agent-board', isJson: false, isHelp: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) throw new Error('duplicate option')
    seen.add(flag)
    if (flag === '--json') options.isJson = true
    else if (flag === '--help') options.isHelp = true
    else if (flag === '--repo' && argv[i + 1] && !argv[i + 1].startsWith('-')) options.repo = argv[++i]
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

export const classify = (prs, commentsByNumber, now, reviewers = null) => {
  const result = { needsReviewer: [], needsMain: [], approved: [], approvedNow: [], approvedOneAtATime: [], waitingForAuthor: [], drafts: 0 }
  const nowMs = new Date(now).getTime()
  if (!Number.isFinite(nowMs)) throw new Error('invalid current time')
  const openCounts = reviewers ? countOpenReviews(prs, commentsByNumber) : null
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
    if (ready && !reviewAfterReady) {
      if (!Number.isFinite(ready.time)) throw new Error('invalid Ready time')
      const hours = Math.max(0, nowMs - ready.time) / hour
      const takenBy = comments.slice(ready.order + 1)
        .map(entry => (entry.comment.body ?? '').match(/^Reviewing:[ \t]*(\S[^\r\n]*)/m)?.[1]?.trim())
        .filter(Boolean).at(-1) ?? null
      const isOverFourHours = hours > 4
      const suggestion = reviewers ? suggestReviewer(reviewers, { author: nameOf(item.author), isOverFourHours }, openCounts) : {}
      result.needsReviewer.push({ ...item, readyAt: ready.comment.created_at, hours, isOverFourHours, takenBy, ...suggestion })
    } else if (latestHeadVerdict?.verdict.kind === 'APPROVE') {
      // Without a file list a pull request cannot be shown to be clear of the shared files, so it waits its turn.
      const isOneAtATime = !Array.isArray(pr.files) || pr.files.some(file => sharedPath.test(file?.path ?? ''))
      result.approved.push({ ...item, detail: 'ready to merge once checks pass', readyAt: ready?.comment.created_at ?? null, isOneAtATime })
    } else {
      const lastVerdict = latestHeadVerdict ?? (!ready ? verdicts.at(-1) : null)
      result.waitingForAuthor.push({ ...item, detail: lastVerdict?.verdict.kind === 'REQUEST CHANGES' ? 'changes requested' : 'no Ready for current head' })
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
  const fields = 'number,title,author,isDraft,headRefOid,mergeStateStatus,additions,deletions,updatedAt,url,body,files'
  const prs = JSON.parse(run('gh', ['pr', 'list', '--state', 'open', '--json', fields, '--limit', '100', '--repo', repo], options))
  const commentsByNumber = {}
  for (const pr of prs) {
    const output = run('gh', ['api', '--paginate', '--jq', '.[] | tojson', `repos/${repo}/issues/${pr.number}/comments?per_page=100`], options)
    commentsByNumber[pr.number] = output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
  }
  return { prs, commentsByNumber }
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
    }
  }
  lines.push(`Drafts: ${data.drafts}`)
  return lines.join('\n')
}

export const main = (argv = process.argv.slice(2), { fetch = fetchQueue, lanes = findStaleLanes, reviewers = loadReviewers, now = () => new Date(), log = console.log, error = console.error } = {}) => {
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
    const queue = classify(prs, commentsByNumber, now(), suggestions.map)
    let staleLanes
    try { staleLanes = lanes(options, { now }) } catch { staleLanes = { stale: [], notes: ['lane check skipped: lookup failed'] } }
    if (options.isJson) log(JSON.stringify(safeData({ ...queue, staleLanes, ...(suggestions.note ? { notes: [suggestions.note] } : {}) }), null, 2))
    else log([formatQueue(queue), formatLanes(staleLanes), suggestions.note ? safeLine(`Note: ${suggestions.note}`) : ''].filter(Boolean).join('\n'))
    return 0
  } catch {
    // Raw gh diagnostics can include credentials not recognized by a redactor.
    error('GitHub data could not be read; check gh authentication and repository access.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main()

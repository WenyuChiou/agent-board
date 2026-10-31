import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
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

const readySha = body => (body ?? '').match(/^[ \t]*`?Ready for review[ \t]+`?([0-9a-f]{7,40})\b/i)?.[1]?.toLowerCase()
const byTime = (a, b) => a.time - b.time || (a.comment.id ?? 0) - (b.comment.id ?? 0) || a.index - b.index
const matchesHead = (head, sha) => Boolean(sha && head.startsWith(sha))

export const classify = (prs, commentsByNumber, now) => {
  const result = { needsReviewer: [], needsMain: [], approved: [], waitingForAuthor: [], drafts: 0 }
  const nowMs = new Date(now).getTime()
  if (!Number.isFinite(nowMs)) throw new Error('invalid current time')
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
    const source = commentsByNumber instanceof Map ? commentsByNumber.get(pr.number) : commentsByNumber[pr.number]
    const comments = (source ?? []).map((comment, index) => ({ comment, index, time: Date.parse(comment.created_at) })).sort(byTime)
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
      result.needsReviewer.push({ ...item, readyAt: ready.comment.created_at, hours, isOverFourHours: hours > 4, takenBy })
    } else if (latestHeadVerdict?.verdict.kind === 'APPROVE') {
      result.approved.push({ ...item, detail: 'ready to merge once checks pass' })
    } else {
      const lastVerdict = latestHeadVerdict ?? (!ready ? verdicts.at(-1) : null)
      result.waitingForAuthor.push({ ...item, detail: lastVerdict?.verdict.kind === 'REQUEST CHANGES' ? 'changes requested' : 'no Ready for current head' })
    }
  }
  result.needsReviewer.sort((a, b) => a.size - b.size || Date.parse(a.readyAt) - Date.parse(b.readyAt) || a.number - b.number)
  return result
}

export const fetchQueue = ({ repo }, { run = execFileSync } = {}) => {
  const options = { encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] }
  // The Author line in the description distinguishes agents sharing a GitHub login.
  const fields = 'number,title,author,isDraft,headRefOid,mergeStateStatus,additions,deletions,updatedAt,url,body'
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
    ['Approved', data.approved],
    ['Waiting for the author', data.waitingForAuthor],
  ]
  for (const [heading, items] of groups) {
    if (!items.length) continue
    lines.push(`${heading} (${items.length})`)
    for (const item of items) {
      const detail = heading === 'Needs a reviewer'
        ? `Ready ${item.hours.toFixed(1)} h${item.isOverFourHours ? ' over 4 h' : ''}${item.takenBy ? ` taken by ${item.takenBy}` : ''}`
        : item.detail
      lines.push(`#${item.number}  ${item.size} lines  ${item.author}  ${item.title.slice(0, 70)}  ${detail}`)
    }
  }
  lines.push(`Drafts: ${data.drafts}`)
  return lines.join('\n')
}

export const main = (argv = process.argv.slice(2), { fetch = fetchQueue, lanes = findStaleLanes, now = () => new Date(), log = console.log, error = console.error } = {}) => {
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
    const queue = classify(prs, commentsByNumber, now())
    let staleLanes
    try { staleLanes = lanes(options, { now }) } catch { staleLanes = { stale: [], notes: ['lane check skipped: lookup failed'] } }
    if (options.isJson) log(JSON.stringify(safeData({ ...queue, staleLanes }), null, 2))
    else log([formatQueue(queue), formatLanes(staleLanes)].filter(Boolean).join('\n'))
    return 0
  } catch {
    // Raw gh diagnostics can include credentials not recognized by a redactor.
    error('GitHub data could not be read; check gh authentication and repository access.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main()

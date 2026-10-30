import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { authorKey, reviewOf } from './pr-check.mjs'
import { safeLine } from './preflight.mjs'

const usage = 'Usage: node scripts/review-queue.mjs [--repo owner/name] [--json] [--help]'
const maxBuffer = 64 * 1024 * 1024
const hour = 60 * 60 * 1000

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
    if (pr.mergeStateStatus === 'DIRTY' || pr.mergeStateStatus === 'BEHIND') {
      result.needsMain.push({ ...item, detail: pr.mergeStateStatus === 'DIRTY' ? 'no CI runs until main is merged' : 'merge main before review' })
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

export const main = (argv = process.argv.slice(2), { fetch = fetchQueue, now = () => new Date(), log = console.log, error = console.error } = {}) => {
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
    log(options.isJson ? JSON.stringify(safeData(queue), null, 2) : formatQueue(queue))
    return 0
  } catch {
    // Raw gh diagnostics can include credentials not recognized by a redactor.
    error('GitHub data could not be read; check gh authentication and repository access.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main()

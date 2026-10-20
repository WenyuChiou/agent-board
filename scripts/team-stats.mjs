import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { authorKey, reviewOf, stripComments } from './pr-check.mjs'
import { safeLine } from './preflight.mjs'

const usage = 'Usage: node scripts/team-stats.mjs [--week] [--date YYYY-MM-DD] [--repo owner/name] [--help]'
const day = 24 * 60 * 60 * 1000
const maxBuffer = 64 * 1024 * 1024
const byTime = (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id
const isOpen = item => item.state === 'open'
const inWindow = (value, start, end) => value && Date.parse(value) >= start && Date.parse(value) < end
const weekStart = date => Date.parse(date) - 6 * day
const endOfDate = date => Date.parse(date) + day

export const parseArgs = (argv, now = new Date()) => {
  const options = { date: now.toISOString().slice(0, 10), repo: 'WenyuChiou/agent-board', isWeek: false, isHelp: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) throw new Error('duplicate option')
    seen.add(flag)
    if (flag === '--week') options.isWeek = true
    else if (flag === '--help') options.isHelp = true
    else if (['--date', '--repo'].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('-')) options[flag.slice(2)] = argv[++i]
    else throw new Error('unknown option or missing value')
  }
  const date = options.date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('date must be a valid YYYY-MM-DD')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(options.repo) || ['.', '..'].includes(options.repo.split('/')[1])) throw new Error('repo must be owner/name')
  return options
}

export const authorOf = body => authorKey(body ?? '') ?? 'unknown'

export const reviewQueue = pullRequests => pullRequests.filter(pr => isOpen(pr) && !pr.draft).map(pr => {
  const head = pr.head.sha.toLowerCase()
  let ready
  for (const comment of [...(pr.comments ?? [])].sort(byTime)) {
    const body = comment.body ?? ''
    const sha = body.match(/^[ \t]*`?Ready for review `?([a-f0-9]{7,40})(?![A-Za-z0-9])`?/i)?.[1]?.toLowerCase()
    if (sha && head.startsWith(sha) && !ready) ready = comment
    const review = reviewOf(body)
    if (review && head.startsWith(review.sha)) ready = undefined
  }
  return { number: pr.number, ready }
}).filter(item => item.ready).sort((a, b) => byTime(a.ready, b.ready) || a.number - b.number).map(item => item.number)

export const dailyLine = ({ issues, pullRequests }, date) => {
  const onlyIssues = issues.filter(issue => !issue.pull_request)
  const opened = onlyIssues.filter(issue => inWindow(issue.created_at, Date.parse(date), endOfDate(date))).length
  const closed = onlyIssues.filter(issue => inWindow(issue.closed_at, Date.parse(date), endOfDate(date))).length
  const open = onlyIssues.filter(isOpen)
  const milestones = new Map()
  for (const issue of open) {
    const title = issue.milestone?.title?.trim().split(/\s+/)[0] || 'none'
    milestones.set(title, (milestones.get(title) ?? 0) + 1)
  }
  const milestoneText = [...milestones].sort(([a], [b]) => a === 'none' ? 1 : b === 'none' ? -1 : a.localeCompare(b, 'en', { numeric: true }))
    .map(([title, count]) => `${safeLine(title)} ${count}`).join(' · ')
  const queue = reviewQueue(pullRequests)
  return `${date}: opened ${opened}, closed ${closed}, open ${open.length} (${milestoneText}), pull requests open ${pullRequests.filter(isOpen).length}, review queue ${queue.length ? queue.map(number => `#${number}`).join(' ') : 'empty'}`
}

const emptyStats = () => ({ merged: 0, issues: new Set(), approved: 0, reviewed: 0, rounds: 0, regressions: new Set() })
const tableCell = value => safeLine(value).replaceAll('|', '\\|')

export const scorecard = ({ issues, pullRequests }, date) => {
  const start = weekStart(date)
  const end = endOfDate(date)
  const agents = new Map()
  const total = emptyStats()
  const statsOf = agent => {
    if (!agents.has(agent)) agents.set(agent, emptyStats())
    return agents.get(agent)
  }
  for (const pr of pullRequests.filter(pr => inWindow(pr.merged_at, start, end))) {
    const stats = statsOf(authorOf(pr.body))
    const comments = [...(pr.comments ?? [])].sort(byTime).map(comment => reviewOf(comment.body)).filter(Boolean)
    const first = comments[0]
    const rounds = comments.filter(comment => comment.kind === 'REQUEST CHANGES').length + 1
    const fixes = [...stripComments(pr.body ?? '').matchAll(/\b(?:fixes|closes|resolves)\s+#([1-9]\d*)\b/gi)].map(match => match[1])
    for (const row of [stats, total]) {
      row.merged++
      row.rounds += rounds
      for (const number of fixes) row.issues.add(number)
      if (first !== undefined) {
        row.reviewed++
        if (first.kind === 'APPROVE') row.approved++
      }
    }
  }
  // A new regression can belong to a pull request merged before this week's window.
  const authors = new Map(pullRequests.filter(pr => pr.merged_at).map(pr => [String(pr.number), authorOf(pr.body)]))
  for (const issue of issues.filter(issue => !issue.pull_request && inWindow(issue.created_at, start, end))) {
    for (const match of (issue.body ?? '').matchAll(/^[ \t]*(?:[-*][ \t]+)?(?:regression of|caused by)[ \t]+#([1-9]\d*)\b/gim)) {
      const agent = authors.get(match[1])
      if (agent === undefined) continue
      statsOf(agent).regressions.add(issue.number)
      total.regressions.add(issue.number)
    }
  }
  const rowText = (agent, stats) => `| ${tableCell(agent)} | ${stats.merged} | ${stats.issues.size} | ${stats.reviewed ? `${stats.approved}/${stats.reviewed}` : '-'} | ${stats.merged ? (stats.rounds / stats.merged).toFixed(1) : '-'} | ${stats.regressions.size} |`
  return [
    '| agent | pull requests merged | issues closed by them | approved at first review | review rounds per pull request | regressions |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...[...agents].sort(([a], [b]) => a.localeCompare(b)).map(([agent, stats]) => rowText(agent, stats)),
    rowText('total', total),
  ].join('\n')
}

const fetchList = (repo, endpoint) => {
  const separator = endpoint.includes('?') ? '&' : '?'
  const output = execFileSync('gh', ['api', '--paginate', '--jq', '.[] | tojson', `repos/${repo}/${endpoint}${separator}per_page=100`], {
    encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
}

export const fromGraphql = nodes => nodes.map(pr => ({
  number: pr.number,
  body: pr.body,
  merged_at: pr.mergedAt,
  state: pr.state === 'MERGED' ? 'closed' : pr.state.toLowerCase(),
  draft: pr.isDraft,
  head: { sha: pr.headRefOid },
  comments: pr.comments.nodes.map(comment => ({ body: comment.body, created_at: comment.createdAt, id: comment.databaseId })),
}))

const fetchStats = ({ repo, date, isWeek }) => {
  const start = new Date(weekStart(date)).toISOString().slice(0, 10)
  const issues = fetchList(repo, `issues?state=all${isWeek ? `&since=${start}T00:00:00Z` : ''}`)
  const pullRequests = fetchList(repo, `pulls?state=${isWeek ? 'all' : 'open'}`)
  if (isWeek) {
    const query = `query($search: String!, $endCursor: String) {
  search(query: $search, type: ISSUE, first: 50, after: $endCursor) {
    nodes {
      ... on PullRequest {
        number
        body
        mergedAt
        state
        isDraft
        headRefOid
        comments(first: 100) {
          totalCount
          nodes { body createdAt databaseId }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`
    const output = execFileSync('gh', ['api', 'graphql', '--paginate', '-f', `query=${query}`, '-f', `search=repo:${repo} is:pr is:merged merged:${start}..${date}`, '--jq', '.data.search.nodes[] | tojson'], {
      encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const nodes = output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
    const byNumber = new Map(pullRequests.map(pr => [pr.number, pr]))
    for (const pr of fromGraphql(nodes)) byNumber.set(pr.number, { ...byNumber.get(pr.number), ...pr })
    for (const node of nodes) {
      if (node.comments.totalCount > 100) byNumber.get(node.number).comments = fetchList(repo, `issues/${node.number}/comments`)
    }
    for (const pr of byNumber.values()) {
      if (inWindow(pr.merged_at, weekStart(date), endOfDate(date)) && !Array.isArray(pr.comments)) pr.comments = fetchList(repo, `issues/${pr.number}/comments`)
    }
    return { issues, pullRequests: [...byNumber.values()] }
  }
  for (const pr of pullRequests) {
    if (!pr.draft) pr.comments = fetchList(repo, `issues/${pr.number}/comments`)
  }
  return { issues, pullRequests }
}

export const main = (argv = process.argv.slice(2), { fetch = fetchStats, log = console.log, error = console.error } = {}) => {
  let options
  try { options = parseArgs(argv) } catch {
    error(usage)
    return 2
  }
  if (options.isHelp) {
    log(usage)
    return 0
  }
  let data
  try { data = fetch(options) } catch {
    // Raw gh diagnostics can include credentials not recognized by a redactor.
    error(safeLine('GitHub data could not be read; check gh authentication and repository access.'))
    return 1
  }
  log(options.isWeek ? scorecard(data, options.date) : dailyLine(data, options.date))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main()

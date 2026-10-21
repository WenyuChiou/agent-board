import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MINUTES_LEAST = 1
export const MINUTES_MOST = 45
export const MINUTES_DEFAULT = 30
// A local run without --out writes into the temp folder, never into the working copy, in a folder
// named for its start time (UTC) and process, so two runs never share one; CI names its own folder.
const startedAt = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
export const OUT_DEFAULT = join(tmpdir(), `agent-board-soak-report-${startedAt}-${process.pid}`)

const shown = value => String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, 40)

// The soak takes --minutes (a whole number from 1 to 45) and --out (a folder), each once.
// A bad command line comes back as one plain sentence, never a stack trace.
export const parseArguments = argv => {
  const given = new Set()
  let minutes = MINUTES_DEFAULT
  let out = OUT_DEFAULT
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at]
    if (flag !== '--minutes' && flag !== '--out') return { error: `Unknown argument "${shown(flag)}": the soak takes only --minutes and --out.` }
    if (given.has(flag)) return { error: `${flag} was given more than once.` }
    given.add(flag)
    const value = argv[at + 1]
    if (flag === '--minutes') {
      if (value === undefined) return { error: `--minutes needs a whole number from ${MINUTES_LEAST} to ${MINUTES_MOST}.` }
      if (!/^[1-9]\d*$/.test(value) || Number(value) > MINUTES_MOST) return { error: `--minutes needs a whole number from ${MINUTES_LEAST} to ${MINUTES_MOST}, not "${shown(value)}".` }
      minutes = Number(value)
    } else {
      if (value === undefined || value === '' || value.startsWith('--')) return { error: '--out needs a folder name.' }
      out = value
    }
  }
  return { minutes, out }
}

const escapeText = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A path matches in either slash style (and a doubled one, as JSON writes a backslash), in any
// letter case, and only where it ends: /tmp does not match inside /tmpfile.
const pathPattern = path => {
  const parts = path.split(/[\\/]+/)
  while (parts.length > 1 && parts.at(-1) === '') parts.pop()
  if (parts.join('').length < 3) return null
  return new RegExp(`${parts.map(escapeText).join('[\\\\/]+')}(?![A-Za-z0-9_-])`, 'gi')
}

// `entries` is a list of [placeholder, path]; the longest path goes first, so a world folder inside
// the temp folder reads <world>, not <tmp>/…. `secrets` are exact strings (the page's address and token).
export const makeRedact = (entries, secrets = []) => {
  const patterns = entries.filter(([, path]) => typeof path === 'string' && path !== '')
    .map(([placeholder, path]) => ({ placeholder, path, pattern: pathPattern(path) }))
    .filter(item => item.pattern !== null)
    .sort((a, b) => b.path.length - a.path.length)
  const hidden = secrets.filter(secret => typeof secret === 'string' && secret.length >= 6)
  return text => {
    let result = String(text)
    for (const secret of hidden) result = result.split(secret).join('<hidden>')
    for (const { placeholder, pattern } of patterns) result = result.replace(pattern, () => placeholder)
    return result
  }
}

export const redactDeep = (value, redact) => {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(item => redactDeep(item, redact))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactDeep(item, redact)]))
  return value
}

export const median = values => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export const percentile = (values, share) => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))]
}

// The probe writes cumulative counts every 10 s, so file operations per poll is the change in
// operations over the change in requests, one figure per sample window. `samples` are the page
// server's lines in time order ({ t, ops, requests }, t in ms since the soak began). The figure for
// a stretch of polls is the median over the windows lying inside it; a stretch shorter than one
// window uses the windows it touches.
export const fileOpsPerPoll = (samples, from, to) => {
  const windows = []
  for (let at = 1; at < samples.length; at += 1) {
    const before = samples[at - 1]
    const after = samples[at]
    const requests = after.requests - before.requests
    if (requests > 0) windows.push({ from: before.t, to: after.t, perPoll: (after.ops - before.ops) / requests })
  }
  const inside = windows.filter(one => one.from >= from && one.to <= to)
  const used = inside.length > 0 ? inside : windows.filter(one => one.to > from && one.from < to)
  if (used.length === 0) return undefined
  return { perPoll: median(used.map(one => one.perPoll)), windows: used.length }
}

export const peakRss = (samples, from, to) => {
  const inside = samples.filter(one => one.t >= from && one.t <= to).map(one => one.rss)
  return inside.length === 0 ? undefined : Math.max(...inside)
}

const megabytes = bytes => (bytes / 1048576).toFixed(0)
const kilobytes = bytes => (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)
const count = value => (value === undefined ? '?' : Number(value).toLocaleString('en-US'))
const clockOf = iso => (typeof iso === 'string' ? iso.slice(11, 19) : '?')

// How many checks came out each way, in plain words: "3 passed, 2 known, 1 failed, 0 skipped".
export const tallyOf = checks => {
  const many = status => checks.filter(check => check.status === status).length
  return `${many('pass')} passed, ${many('known')} known, ${many('fail')} failed, ${many('skipped')} skipped`
}

// Plain words, one table. Every figure comes from the report object, so a half-finished report
// (a timeout, a crash) reads the same way with what it has.
export const reportMarkdown = report => {
  const lines = ['# Soak report', '']
  lines.push(`Status: ${report.status}. The soak was set for ${report.minutes} minutes on ${report.os} with Node ${report.node}.`, '')
  lines.push('| Check | Result | What was measured |', '| --- | --- | --- |')
  for (const check of report.checks ?? []) lines.push(`| ${check.title} | ${check.status} | ${String(check.line).replace(/\|/g, '/')} |`)
  if ((report.checks ?? []).length > 0) lines.push('', `Checks: ${tallyOf(report.checks)}.`)
  lines.push('', '## Numbers', '')
  const polls = report.polls
  if (polls) {
    lines.push(`- Polls: ${count(polls.count)} sent, ${count(polls.failed)} got no answer, ${count(polls.slow)} took longer than 15 seconds, ${count(polls.badStatus)} got an answer other than 200. A typical poll took ${polls.median ?? '?'} ms, one in 20 took longer than ${polls.p95 ?? '?'} ms, the slowest took ${polls.max ?? '?'} ms. The first answer was ${polls.firstSize === undefined ? '?' : kilobytes(polls.firstSize)} KB and the last was ${polls.lastSize === undefined ? '?' : kilobytes(polls.lastSize)} KB.`)
    const causes = Object.entries(polls.failedBy ?? {}).map(([cause, many]) => `${count(many)} ${cause}`)
    if (causes.length > 0) lines.push(`- Polls with no answer, by cause: ${causes.join('; ')}.`)
    const statuses = Object.entries(polls.badBy ?? {}).map(([status, many]) => `${count(many)} with ${status}`)
    if (statuses.length > 0) lines.push(`- Polls answered with a status other than 200: ${statuses.join('; ')}.`)
    if (polls.retried > 0) lines.push(`- ${count(polls.retried)} polls were sent again after the connection closed before an answer.`)
    if (polls.cut) lines.push(`- One more poll was under way when the tail ended and was cut short after ${count(polls.cut.seconds)} s with no answer yet${polls.cut.isSlow ? '; it is counted as one that took longer than 15 seconds' : ''}.`)
  }
  for (const phase of report.phases ?? []) lines.push(`- ${phase.name} began at ${clockOf(phase.startedAt)} UTC.`)
  for (const window of report.fileOps ?? []) lines.push(`- File operations per poll, ${window.name}: ${window.perPoll === undefined ? 'not measured' : window.perPoll.toFixed(1)}.`)
  const serve = report.memory?.serve ?? []
  const watch = report.memory?.watch ?? []
  if (serve.length > 0) lines.push(`- Page server memory: ${megabytes(serve[0].bytes)} MB at the start, ${megabytes(Math.max(...serve.map(one => one.bytes)))} MB at the highest, ${megabytes(serve.at(-1).bytes)} MB at the end.`)
  if (watch.length > 0) lines.push(`- Terminal board memory: ${megabytes(Math.max(...watch.map(one => one.bytes)))} MB at the highest, ${megabytes(watch.at(-1).bytes)} MB at the end.`)
  const data = report.data
  if (data) lines.push(`- Data now: progress.md is ${kilobytes(data.progressBytes ?? 0)} KB, the question ledger is ${kilobytes(data.ledgerBytes ?? 0)} KB, there are ${count(data.captureFiles)} capture files, ${count(data.blocks)} blocks (${count(data.liveSessions)} live) and ${count(data.questionRecords)} question records.`)
  const grown = report.dataAtGrowthEnd
  if (grown) lines.push(`- Data when growth ended: ${count(grown.blocks)} blocks (${count(grown.liveSessions)} live), ${count(grown.questionRecords)} question records, ${count(grown.captureFiles)} capture files.`)
  if (report.archive) lines.push(`- Archive: ${report.archive.path} ${count(report.archive.gone)} of ${count(report.archive.tried)} finished or stopped tasks left progress.md.`)
  if (report.terminalBoard) lines.push(`- Terminal board: ${count(report.terminalBoard.frames)} screens drawn, ${count(report.terminalBoard.framesAfterArchive)} after the archive phase.`)
  for (const note of report.notes ?? []) lines.push(`- Note: ${note}`)
  lines.push('')
  return lines.join('\n')
}

// Windows refuses to replace a file another program has open; retry briefly, as the clock helper does.
const replace = (temporary, file) => {
  for (let attempt = 1; ; attempt += 1) {
    try { renameSync(temporary, file); return } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        try { unlinkSync(temporary) } catch {}
        throw error
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

// Both files, each through a temporary file and a rename, so a reader never sees half a report.
export const writeReport = (dir, report, redact) => {
  const clean = redactDeep(report, redact)
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of [['soak-report.json', `${JSON.stringify(clean, null, 2)}\n`], ['soak-report.md', reportMarkdown(clean)]]) {
    const file = join(dir, name)
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, text)
    replace(temporary, file)
  }
}

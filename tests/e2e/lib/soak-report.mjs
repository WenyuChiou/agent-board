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

// Where each task the archive phase planned ended up. `planned` is [{ session, title, isStopped }];
// `answered` holds the sessions whose archive request was answered 200; `unpressed` the stopped
// tasks whose card was never pressed (the time limit, or no board to read); `present` the sessions
// still in progress.md; `archivedTitles` the `### ` titles in the month archive files; `others` the
// sessions of blocks the archive was not to touch, as they stood just before it. A task that left
// progress.md is archived only when its title is in the archive file; otherwise it was lost.
export const archiveIntegrity = ({ planned, answered, unpressed, present, archivedTitles, others }) => {
  const isKept = task => present.has(task.session)
  const stopped = planned.filter(task => task.isStopped)
  return {
    archived: planned.filter(task => !isKept(task) && archivedTitles.has(task.title)).length,
    lost: planned.filter(task => !isKept(task) && !archivedTitles.has(task.title)).length,
    unarchived: planned.filter(task => isKept(task) && answered.has(task.session)).length,
    othersLost: others.filter(session => !present.has(session)).length,
    unpressedGone: stopped.filter(task => unpressed.has(task.session) && !isKept(task)).length,
    stopped: stopped.length,
    stoppedLeft: stopped.filter(isKept).length,
    stoppedUnanswered: stopped.filter(task => !answered.has(task.session)).length,
  }
}

// What the archive got wrong, whatever its requests answered: each problem in words. The stopped
// tasks left in progress.md must be no more than those whose archive was not answered; that count
// is a cross-check, since an answered task still there is also counted as unarchived.
export const archiveProblems = integrity => {
  const problems = []
  if (integrity.unarchived > 0) problems.push(`${integrity.unarchived} tasks whose archive was answered are still in progress.md`)
  if (integrity.lost > 0) problems.push(`${integrity.lost} tasks left progress.md but are not in the archive file`)
  if (integrity.othersLost > 0) problems.push(`${integrity.othersLost} blocks the archive was not to touch left progress.md`)
  if (integrity.unpressedGone > 0) problems.push(`${integrity.unpressedGone} stopped tasks whose card was never pressed left progress.md`)
  if (integrity.stoppedLeft > integrity.stoppedUnanswered) problems.push(`${integrity.stoppedLeft} stopped tasks are still in progress.md, more than the ${integrity.stoppedUnanswered} whose archive was not answered`)
  return problems
}

const CAUSES = {
  timeout: many => `${many} got no answer in time`,
  cut: many => `${many} stopped tasks were not reached before the time limit`,
  refused: many => `${many} could not connect`,
  closed: many => `${many} lost the connection twice before an answer`,
  other: many => `${many} failed with another error`,
  unreadable: many => `${many} stopped tasks could not be pressed because the board could not be read`,
  button: many => `${many} stopped tasks had no Archive button`,
}
const causesOf = refusals => {
  const words = []
  for (const cause of Object.keys(CAUSES)) {
    const many = refusals.filter(one => one.cause === cause).reduce((sum, one) => sum + one.count, 0)
    if (many > 0) words.push(CAUSES[cause](many))
  }
  const statuses = refusals.filter(one => one.cause === 'status').map(one => one.status)
  if (statuses.length > 0) words.push(`${statuses.length} answered ${[...new Set(statuses)].join(', ')}`)
  return words.join(', ')
}

// The prune check when the archive did not finish: undefined when nothing was refused. The page
// server's known slowness (`hold`) explains only a timeout (a 408, or no answer within the wait) and
// tasks the time limit left unreached, and only while the file-operation check fails and is held
// (`isOpsHeld`) and the archive lost nothing (`integrity`). Any other refusal fails plainly.
export const pruneRefusal = ({ refusals, integrity, isOpsHeld, hold, counted }) => {
  const total = refusals.reduce((sum, one) => sum + one.count, 0)
  if (total === 0) return undefined
  const causes = causesOf(refusals)
  const problems = archiveProblems(integrity)
  const isSlowOnly = refusals.every(one => one.cause === 'timeout' || one.cause === 'cut')
  const left = `${integrity.archived} tasks are in the archive file and ${integrity.stoppedLeft} of the ${integrity.stopped} stopped tasks are still in progress.md`
  if (isOpsHeld && isSlowOnly && problems.length === 0) {
    return { ok: false, hold, line: `The archive did not finish (${causes}), so pruning was not judged: the page server's known slowness explains it, since the file-operation check fails; nothing was lost (${left}). At the end, ${counted}.` }
  }
  const why = !isSlowOnly ? 'an answer other than a timeout is not the known slowness'
    : !isOpsHeld ? 'the file-operation check does not fail, so its known slowness does not explain it'
      : problems.join('; ')
  return { ok: false, isUnheld: true, line: `The archive did not finish (${causes}); ${why}. At the end, ${counted}.` }
}

// The levels-off check. Memory after the archive is measured only with `needed` lines from
// `settleSeconds` after it; a long archive can leave too few. That gap is the known slowness
// (`hold`) only while the file-operation check fails and is held; a measured rise always fails.
export const levelOutcome = ({ before, after, settled, needed, settleSeconds, archiveMinutes, isOpsHeld, hold }) => {
  if (before === undefined || settled < needed) {
    if (isOpsHeld) return { ok: false, hold, line: `Not measured: the archive ran ${archiveMinutes} min, so ${settled} memory lines came after it and ${needed} are needed; the page server's known slowness explains it, since the file-operation check fails.` }
    return { skipped: `Only ${settled} memory lines came from ${settleSeconds} s after the archive on, ${needed} are needed.` }
  }
  const limit = 1.1 * before + 10 * 1048576
  return { ok: after <= limit, line: `The page server's highest memory was ${megabytes(before)} MB up to the end of the archive and ${megabytes(after)} MB after it (limit ${megabytes(limit)} MB).` }
}

// The messaging soak's levels-off check. `points` are the hub's live memory at each memory line from
// the moment the store is full to the end of sending: { sent, bytes }, where `bytes` is one kind of
// memory after a full collection (the heap, or external memory) and `sent` is how many messages had
// been sent when the line was written. A straight line is fitted through them (least squares) and its slope, in
// bytes kept per message, may be no more than `limit`. Comparing the medians of two halves let a hub
// that kept up to about 2.8 KB for each message pass, since the growth was smaller than the 3 MB
// allowance. A slope has no such floor, but a few hundred KB of noise between lines can swamp it over
// a short stretch (ten lines with a spread of 1 MB blur the slope by about 220 bytes over 3,000
// messages), so a window of fewer than `fewestMessages` messages or `fewestLines` lines is not measured.
export const liveMemoryLevel = (points, { fewestLines = 4, fewestMessages = 2000, limit = 256 } = {}) => {
  const used = points.filter(one => Number.isFinite(one.sent) && Number.isFinite(one.bytes))
  const lines = used.length
  if (lines < fewestLines) return { skipped: `Only ${lines} memory lines came while the store was full, ${fewestLines} are needed.` }
  const messages = Math.max(...used.map(one => one.sent)) - Math.min(...used.map(one => one.sent))
  if (messages < fewestMessages) return { skipped: `Only ${count(messages)} messages were sent between the first and last of ${lines} memory lines while the store was full, ${count(fewestMessages)} are needed.` }
  const meanSent = used.reduce((sum, one) => sum + one.sent, 0) / lines
  const meanBytes = used.reduce((sum, one) => sum + one.bytes, 0) / lines
  let along = 0
  let spread = 0
  for (const one of used) {
    along += (one.sent - meanSent) * (one.bytes - meanBytes)
    spread += (one.sent - meanSent) ** 2
  }
  const bytesPerMessage = along / spread
  return { ok: bytesPerMessage <= limit, bytesPerMessage, messages, lines, limit }
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
  if (report.archive?.resent > 0) lines.push(`- ${count(report.archive.resent)} archive requests were sent again after the connection closed before an answer.`)
  if (report.terminalBoard) lines.push(`- Terminal board: ${count(report.terminalBoard.frames)} screens drawn, ${count(report.terminalBoard.framesAfterArchive)} after the archive phase.`)
  if (report.messaging) lines.push(`- Messaging soak: ${report.messaging.status}${report.messaging.tally ? `, ${report.messaging.tally}` : ''}; its own report is ${report.messaging.report}.`)
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
// The messaging soak writes its own pair into the same folder, under other names and with its own words.
export const writeReport = (dir, report, redact, { json = 'soak-report.json', markdown = 'soak-report.md', words = reportMarkdown } = {}) => {
  const clean = redactDeep(report, redact)
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of [[json, `${JSON.stringify(clean, null, 2)}\n`], [markdown, words(clean)]]) {
    const file = join(dir, name)
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, text)
    replace(temporary, file)
  }
}

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

// Windows hides an Antigravity hook's paths inside a UTF-16LE PowerShell command.
const commandText = command => {
  const text = String(command ?? '')
  const decoded = []
  for (const found of text.matchAll(/(?:^|\s)-(?:encodedcommand|enc|ec|e)\s+(?:"([A-Za-z0-9+/]+={0,2})"|'([A-Za-z0-9+/]+={0,2})'|([A-Za-z0-9+/]+={0,2}))(?=[\s"']|$)/gi)) {
    try {
      const encoded = found[1] ?? found[2] ?? found[3]
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length % 2 !== 0 || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) continue
      decoded.push(new TextDecoder('utf-16le', { fatal: true }).decode(bytes))
    } catch {}
  }
  return [text, ...decoded].join('\n')
}

// Both queue writers keep the hook's raw session id; partial writes are not events.
export const queuedSessions = files => {
  const sessions = new Set()
  for (const { name, text } of files) {
    if (!name.endsWith('.json') || typeof text !== 'string') continue
    try {
      const entry = JSON.parse(text)
      if (entry?.version !== 1) continue
      const session = entry.kind === 'raw'
        ? [entry.payload?.session_id, entry.payload?.sessionId, entry.payload?.conversationId].find(value => typeof value === 'string' && value !== '')
        : entry.session
      if (typeof session === 'string' && session !== '') sessions.add(session)
    } catch {}
  }
  return sessions
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

// The processes a run left behind (#395). `list` holds every running process as { pid, ppid, name,
// command, started }. A leftover is any of them, other than the run itself and the excluded ones (the lister)
// with their children, that descends from the run, or whose command line names one of the run's
// folders: a hook worker whose parent is gone has no parent chain left to follow.
export const leftoverProcesses = ({ list, self, roots, exclude = [] }) => {
  const processes = new Map(list.map(one => [one.pid, one]))
  const descends = (pid, from) => {
    for (let child = processes.get(pid), steps = 0; child !== undefined && child.ppid > 0 && steps < 64; steps += 1) {
      const parent = processes.get(child.ppid)
      // A newer parent reused an old pid; it cannot have started this child.
      if (parent?.started !== undefined && child.started !== undefined && parent.started > child.started) return false
      if (child.ppid === from) return true
      child = parent
    }
    return false
  }
  const patterns = roots.map(root => typeof root === 'string' ? pathPattern(root) : null).filter(pattern => pattern !== null)
  const isExcluded = one => (one.ppid === self && /^conhost\.exe$/i.test(one.name)) || exclude.some(pid => one.pid === pid || descends(one.pid, pid))
  return list.filter(one => one.pid !== self && !isExcluded(one) && (descends(one.pid, self) || patterns.some(pattern => commandText(one.command).search(pattern) !== -1)))
}

export const leftoverPlan = ({ list, self, since, roots, exclude = [] }) => {
  const left = leftoverProcesses({ list, self, roots, exclude })
  const descendants = new Set(leftoverProcesses({ list, self, roots: [], exclude }).map(one => one.pid))
  // Path-only matches must start at or after self, or since when self has no start time, in this same list.
  const started = list.find(one => one.pid === self)?.started ?? list.find(one => one.pid === since)?.started
  const kill = [], keep = []
  for (const one of left) {
    if (descendants.has(one.pid) || started !== undefined && one.started !== undefined && one.started >= started) kill.push(one)
    else keep.push(one)
  }
  return { kill, keep }
}

// The open issue marked on a hook load check, and whether it explains this outcome (#395). #241: on
// a busy Windows machine a hook can run longer than the 3 s budget, and an event whose reporter runs
// out of time is queued until a later hook applies it, so the page shows it late or never. Only that
// pattern counts: no hook exited non-zero or ran past twice the budget, every poll was answered, some
// report was shown, the page's poll interval fits its budget, and every late or missed report came
// back while that session's own event was queued. Anything else stays a failure.
export const hookLoadMarker = ({ key, outcome, platform, budgetMs }) => {
  if (platform !== 'win32' || (key !== 'hooks' && key !== 'page')) return undefined
  if (outcome.ok && (key === 'hooks' || outcome.pollWithinBudget === true)) return { issue: 241, explains: true }
  const explains = key === 'hooks'
    ? outcome.over > 0 && outcome.failedRuns === 0 && outcome.maxMs <= 2 * budgetMs
    : outcome.pollWithinBudget === true && outcome.shown > 0 && outcome.slow > 0 && outcome.slowNotQueued === 0 && outcome.failedAnswers === 0
  return { issue: 241, explains }
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
const sha256 = text => createHash('sha256').update(text).digest('hex')

// How many checks came out each way, in plain words: "3 passed, 2 known, 1 failed, 0 skipped".
export const tallyOf = checks => {
  const many = status => checks.filter(check => check.status === status).length
  return `${many('pass')} passed, ${many('known')} known, ${many('fail')} failed, ${many('skipped')} skipped`
}

const isQuestionSource = source => source !== null && typeof source === 'object' && ['block', 'own', 'manual', 'inbox'].includes(source.kind) && ['project', 'task', 'context', 'text', 'agent', 'session', 'data'].every(key => typeof source[key] === 'string')

// The soak runs under plain Node, so its reader mirrors the v1 parseQuestions/parseCapture schema
// instead of importing TypeScript. It additionally requires the unresolved bit that this check
// needs to distinguish evidence from an old record without silently dropping it.
const isQuestionRecord = (record, next, ids) => {
  if (record === null || typeof record !== 'object' || !/^question:[a-f0-9]{64}:\d+$/.test(record.id) || ids.has(record.id) || typeof record.scope !== 'string' || typeof record.words !== 'string' || typeof record.incarnation !== 'string') return false
  if (!Number.isSafeInteger(record.occurrence) || record.occurrence < 1 || !Number.isSafeInteger(record.copies) || record.copies < record.occurrence || typeof record.isWaiting !== 'boolean' || typeof record.isPresent !== 'boolean' || typeof record.isUnresolved !== 'boolean' || !Number.isFinite(record.firstObserved) || record.firstObserved < 0) return false
  const number = Number(record.id.slice(record.id.lastIndexOf(':') + 1))
  if (!Number.isSafeInteger(number) || number >= next || record.id.split(':')[1] !== sha256(JSON.stringify([record.scope, record.words, record.occurrence, record.copies, record.incarnation]))) return false
  if (record.producer !== undefined && typeof record.producer !== 'string') return false
  if (record.resolvedAt !== undefined && (!Number.isFinite(record.resolvedAt) || record.resolvedAt < 0)) return false
  if (record.isArchived !== undefined && typeof record.isArchived !== 'boolean') return false
  if (record.producerRevisions !== undefined && (!Array.isArray(record.producerRevisions) || record.producerRevisions.some(revision => typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)))) return false
  if (record.producerSources !== undefined && (!Array.isArray(record.producerSources) || record.producerSources.some(source => typeof source !== 'string'))) return false
  if (record.source !== undefined && !isQuestionSource(record.source)) return false
  return true
}

export const questionEvidenceProjection = ({ ledgerText, captures }) => {
  try {
    const ledger = JSON.parse(ledgerText)
    if (ledger.version !== 1 || !Number.isSafeInteger(ledger.next) || ledger.next < 1 || !Array.isArray(ledger.records) || ledger.legacy === null || typeof ledger.legacy !== 'object' || Array.isArray(ledger.legacy)) throw new Error('question ledger schema is invalid')
    const ids = new Set()
    for (const record of ledger.records) {
      if (!isQuestionRecord(record, ledger.next, ids)) throw new Error('question ledger record is invalid')
      ids.add(record.id)
    }
    if (Object.values(ledger.legacy).some(id => typeof id !== 'string' || (id !== '' && !ids.has(id)))) throw new Error('question ledger legacy binding is invalid')
    const parsedCaptures = captures.map(({ hash, text }) => {
      if (sha256(text) !== hash) throw new Error('question capture hash is invalid')
      const capture = JSON.parse(text)
      if (capture.version !== 1 || !['unresolved', 'resolved', 'archived'].includes(capture.disposition) || !isQuestionSource(capture.record?.source)) throw new Error('question capture schema is invalid')
      const number = Number(capture.record.id.slice(capture.record.id.lastIndexOf(':') + 1))
      if (!Number.isSafeInteger(number) || !isQuestionRecord(capture.record, number + 1, new Set())) throw new Error('question capture record is invalid')
      return capture
    })
    const byId = new Map(ledger.records.map(record => [record.id, { ...record }]))
    for (const capture of parsedCaptures) {
      const previous = byId.get(capture.record.id)
      if (previous === undefined) byId.set(capture.record.id, { ...capture.record })
      else {
        if (previous.source === undefined) previous.source = capture.record.source
        if (capture.record.producerRevisions !== undefined) previous.producerRevisions = [...new Set([...(previous.producerRevisions ?? []), ...capture.record.producerRevisions])]
        if (capture.record.producerSources !== undefined) previous.producerSources = [...new Set([...(previous.producerSources ?? []), ...capture.record.producerSources])]
      }
    }
    for (const capture of parsedCaptures) {
      const record = byId.get(capture.record.id)
      if (record === undefined) continue
      if (capture.disposition === 'archived') record.isArchived = true
      if (capture.disposition === 'resolved') record.isUnresolved = false
    }
    return { ledger: ledger.records, captures: parsedCaptures, questions: [...byId.values()] }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
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

const sameQuestion = (left, right) => left.scope === right.scope
  && left.words === right.words
  && left.occurrence === right.occurrence
  && left.copies === right.copies
  && left.incarnation === right.incarnation

const missingValues = (before, after) => (before ?? []).filter(value => !(after ?? []).includes(value))

// A retained question can remain in the main list; checking only Older rejects visible evidence.
export const questionRecoveryOf = (status, model) => {
  const surfaces = ['asks', 'reminder', 'older', 'hidden']
  const checked = status === 200 && surfaces.every(name => Array.isArray(model?.[name]) && model[name].every(item => item !== null && typeof item === 'object' && (item.questionId === undefined || typeof item.questionId === 'string' && /^question:[a-f0-9]{64}:\d+$/.test(item.questionId))))
  return {
    status, checked,
    questionIds: checked ? [...new Set(surfaces.flatMap(name => model[name].flatMap(item => item.questionId === undefined ? [] : [item.questionId])))] : [],
    surfaceCounts: checked ? Object.fromEntries(surfaces.map(name => [name, model[name].length])) : {},
    error: checked ? undefined : 'The page did not return valid question membership for every board surface.',
  }
}

// Every unanswered question belonging to a task that left progress.md must still project from the
// ledger and immutable captures with its identity, original clock and complete recovery evidence.
export const archiveQuestionIntegrity = ({ before, after, archivedSessions, recoverableQuestionIds = new Set() }) => {
  const sessionOf = scope => { try { return JSON.parse(scope)[2] } catch { return '' } }
  const expected = before.filter(record => record.isUnresolved && archivedSessions.has(sessionOf(record.scope)))
  const afterById = new Map(after.map(record => [record.id, record]))
  const result = { checked: expected.length, missing: [], changedIds: [], reaged: [], rebound: [], provenanceLost: [], sourceLost: [], undiscoverable: [] }
  for (const previous of expected) {
    const current = afterById.get(previous.id)
    if (current === undefined) {
      const changed = after.find(record => record.id !== previous.id && sameQuestion(record, previous))
      if (changed === undefined) result.missing.push(previous.id)
      else result.changedIds.push(previous.id)
      continue
    }
    if (!sameQuestion(current, previous)) result.rebound.push(previous.id)
    if (current.firstObserved !== previous.firstObserved) result.reaged.push(previous.id)
    if (current.producer !== previous.producer || missingValues(previous.producerRevisions, current.producerRevisions).length > 0 || missingValues(previous.producerSources, current.producerSources).length > 0) result.provenanceLost.push(previous.id)
    if (previous.source === undefined || current.source === undefined || JSON.stringify(current.source) !== JSON.stringify(previous.source)) result.sourceLost.push(previous.id)
    if (!current.isUnresolved || current.source === undefined || !recoverableQuestionIds.has(previous.id)) result.undiscoverable.push(previous.id)
  }
  return result
}

export const archiveQuestionProblems = integrity => [
  ...(integrity.checked === 0 ? ['No unanswered question was observed before the archive, so preservation was not measured'] : []),
  ...[
    [integrity.missing, 'unanswered question IDs are missing'],
    [integrity.changedIds, 'unanswered question IDs changed'],
    [integrity.reaged, 'unanswered questions lost their original age'],
    [integrity.rebound, 'unanswered questions changed scope or producer binding'],
    [integrity.provenanceLost, 'unanswered questions lost producer provenance'],
    [integrity.sourceLost, 'unanswered questions lost their retained source'],
    [integrity.undiscoverable, 'unanswered questions are not recoverable on the board'],
  ].flatMap(([ids, words]) => ids.length === 0 ? [] : [`${ids.length} ${words} (${ids.join(', ')})`]),
]

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

// The preservation check when the archive did not finish: undefined when nothing was refused. The page
// server's known slowness (`hold`) explains only a timeout (a 408, or no answer within the wait) and
// tasks the time limit left unreached, and only while the file-operation check fails and is held
// (`isOpsHeld`) and the archive lost nothing (`integrity`). Any other refusal fails plainly.
export const archiveRefusal = ({ refusals, integrity, isOpsHeld, hold, counted }) => {
  const total = refusals.reduce((sum, one) => sum + one.count, 0)
  if (total === 0) return undefined
  const causes = causesOf(refusals)
  const problems = archiveProblems(integrity)
  const isSlowOnly = refusals.every(one => one.cause === 'timeout' || one.cause === 'cut')
  const left = `${integrity.archived} tasks are in the archive file and ${integrity.stoppedLeft} of the ${integrity.stopped} stopped tasks are still in progress.md`
  if (isOpsHeld && isSlowOnly && problems.length === 0) {
    return { ok: false, hold, line: `The archive did not finish (${causes}), so unanswered-question preservation was not judged: the page server's known slowness explains it, since the file-operation check fails; nothing was lost (${left}). At the end, ${counted}.` }
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

// A full run must measure every check; shorter diagnostic runs may skip one.
export const classifySoakChecks = async ({ outcomes, titles, holds, minutes, knownFailure }) => {
  const isFullRun = minutes >= 30
  const results = []
  for (const [key, title] of Object.entries(titles)) {
    const outcome = outcomes[key]
    if (outcome.skipped !== undefined) {
      results.push(isFullRun ? { title, status: 'fail', line: `Not measured in a ${minutes}-minute run: ${outcome.skipped}` } : { title, status: 'skipped', line: outcome.skipped })
      continue
    }
    if (outcome.ok) { results.push({ title, status: 'pass', line: outcome.line }); continue }
    // An outcome the known slowness explains names that hold itself (archiveRefusal, levelOutcome).
    const hold = outcome.hold ?? holds[key]
    if (hold === undefined || outcome.isUnheld) { results.push({ title, status: outcome.ok ? 'pass' : 'fail', line: outcome.line }); continue }
    try {
      // Only an assertion failure may stand for the registered known problem.
      await knownFailure(hold, () => { if (!outcome.ok) assert.fail(outcome.line) })
      results.push({ title, status: 'known', line: `${outcome.line} Known problem (${hold}).` })
    } catch (error) { results.push({ title, status: 'fail', line: `${error.message} ${outcome.line}` }) }
  }
  return results
}

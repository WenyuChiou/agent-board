import type { CutBlock, ProgressAuto, ProgressMirror, ProgressProject, ProgressStepStatus, ProgressTask, QuestionLedger, QuestionProofs, QuestionRecord, QuestionSource } from '../types'
import type { PendingTurn } from './board'
import type { AgentTurn } from './inbox'
import { cutOffTest, scanBlocks, shortId, stepWords } from './blocks'
import { questionToken, waitsOnYou } from './mirror'
import { sha256 } from './sha256'
import type { TaskRef } from './view'

export type { QuestionLedger, QuestionProofs, QuestionRecord } from '../types'

// Accepted continuation evidence retains its binding and clock without conversation text.
export type QuestionAnswerEvidence = Pick<AgentTurn, 'agent' | 'id'> & { event: 'prompt' | 'turn'; at: number }

export const emptyQuestions = (): QuestionLedger => ({ version: 1, next: 1, records: [], legacy: {} })
export const questionsPath = (path: string): string => `${path.replace(/\.md$/i, '')}-questions.json`
export const questionWords = (text: string): string => text.trim().replace(/\s+/g, ' ')
export const questionScope = (project: string, agent: string, session: string): string => JSON.stringify([project, agent || 'claude', session])
export const questionSlot = (scope: string, index: number | string): string => JSON.stringify([scope, index])
export const pendingQuestionSlot = (scope: string, text: string): string => questionSlot(scope, `inbox:${questionWords(text)}`)
export const migrationKey = (legacy: string): string => `question-migrated:${sha256(legacy)}`
// A board read halfway through a write ends in a block with no end marker. One cut off in the
// middle of the file is not being written, so it does not hold the questions back (`cutOffTest`).
export const isQuestionSnapshot = (text: string, isSettled = false): boolean => {
  const lines = text.split(/\r?\n/)
  const isCutOff = cutOffTest(lines, isSettled)

  return scanBlocks(lines).every(span => span.isClosed || isCutOff(span))
}
// The question scopes of blocks cut off in the middle of the file. What a write left half done is
// neither read as questions nor taken as their removal or answer: their records stay as they were
// until the block has its end marker again, so a question cut out of it is not asked anew.
// A block cut right after its marker has no parsed task, so its scope comes from the cut span.
export const cutOffScopes = (projects: readonly ProgressProject[], cut: readonly CutBlock[]): Set<string> => {
  const sessions = new Set(cut.map(one => one.session))

  return new Set([
    ...cut.map(one => questionScope(one.project, one.agent.toLowerCase(), one.session)),
    ...projects.flatMap(project => project.tasks.flatMap(task => task.auto !== null && sessions.has(task.auto.session) ? [questionScope(project.name, task.auto.agent, task.auto.session)] : [])),
  ])
}
// A question's copy of its block or hand-kept task: the marker fields and each step's mark, which
// are all its readers need. The whole task held every step's words and line once per waiting
// step, so a real board's ledger grew past the host's 4 MiB write limit, and every edit above a
// block wrote a new copy of each of its questions (#419).
export const sourceData = (task: ProgressTask): string => JSON.stringify({ auto: task.auto, steps: task.steps.map(step => step.status) })

type SourceSnapshot = { auto: ProgressAuto | null; steps: ProgressStepStatus[] }
const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
// The whole-task form an old copy holds: an object with the task's title.
const isWholeTask = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value) && 'title' in value
const snapshotOf = (saved: unknown): SourceSnapshot | null => {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return null
  const value = saved as Record<string, unknown>
  if (!Array.isArray(value.steps)) return null
  const steps: unknown[] = isWholeTask(value) ? value.steps.map(step => step !== null && typeof step === 'object' && !Array.isArray(step) ? (step as Record<string, unknown>).status : null) : value.steps
  if (steps.some(status => typeof status !== 'string' || !['done', 'doing', 'todo', 'waiting', 'running', 'blocked', 'cancelled'].includes(status))) return null
  if (value.auto !== null) {
    if (typeof value.auto !== 'object' || Array.isArray(value.auto)) return null
    const auto = value.auto as Record<string, unknown>
    if (typeof auto.session !== 'string' || typeof auto.agent !== 'string' || !['working', 'waiting', 'done', 'ended'].includes(auto.state as string) || typeof auto.updated !== 'number' || !Number.isFinite(auto.updated)) return null
    if ((auto.resume !== null && typeof auto.resume !== 'string') || (auto.dir !== null && typeof auto.dir !== 'string') || (auto.pr !== null && (typeof auto.pr !== 'number' || !Number.isFinite(auto.pr))) || (auto.ci !== null && !['none', 'pending', 'pass', 'fail'].includes(auto.ci as string))) return null
  }
  return { auto: value.auto as ProgressAuto | null, steps: steps as ProgressStepStatus[] }
}

// The marker fields and step marks a copy holds, in either form: this one, or the whole task a
// copy written before 0.24.0 holds. Null for any other shape, so a broken file never throws in a reader.
export const sourceSnapshot = (data: string): SourceSnapshot | null => snapshotOf(parsedJson(data))

// An old whole-task copy of a block or hand-kept task reads as the copy this version writes, so
// it compares equal to the live block, and the copies of one block at different lines are one.
// Other shapes stay as they are; an own or inbox copy is small, and its exact text is read back.
const normalizeSource = (source: QuestionSource): QuestionSource => {
  if (source.kind !== 'block' && source.kind !== 'manual') return source
  const parsed = parsedJson(source.data)
  return isWholeTask(parsed) && snapshotOf(parsed) !== null ? { ...source, data: sourceData(parsed as unknown as ProgressTask) } : source
}

export const archiveQuestionsKept = (projects: readonly ProgressProject[], ref: TaskRef, ledger: QuestionLedger): boolean => {
  const tasks = projects.filter(project => project.name === ref.project).flatMap(project => project.tasks).filter(task => {
    if (ref.session === null) return task.title === ref.title
    if (ref.resume !== undefined && ref.resume !== null) {
      return task.auto?.resume === ref.resume || (task.auto?.resume === null && task.auto?.session === ref.resume)
    }
    return task.auto?.session === ref.session
  })
  if (tasks.length !== 1) return false
  const task = tasks[0]
  if (task === undefined) return false
  // The polls drop a step whose token another step repeats, so a waiting step with a repeated
  // token has no live identity, and an old copy of it cannot justify archiving the block.
  const tokens = task.steps.map(step => step.questionToken ?? '').filter(token => token !== '')
  if (task.steps.some(step => step.status === 'waiting' && (step.questionToken ?? '') !== '' && tokens.filter(token => token === step.questionToken).length > 1)) return false
  const scope = questionScope(ref.project, task.auto?.agent ?? 'manual', task.auto?.session ?? task.title)
  // The copy no longer holds the title, so the record is tied to this task by its title and
  // session; two hand-kept tasks that ask the same have the same marks.
  return task.steps.filter(step => step.status === 'waiting').every(step => ledger.records.some(record => record.isUnresolved
    ? isAskedBy(record, ref) && record.source?.text === step.text && record.source.data === sourceData(task) && (record.producer ?? '') === (step.questionToken ?? '')
    : record.resolvedAt !== undefined && record.source !== undefined && record.scope === scope && record.words === questionWords(step.text) && (record.producer ?? '') === (step.questionToken ?? '') && !ledger.records.some(other => other.isUnresolved && other.scope === scope && other.words === questionWords(step.text))))
}
// The questions of one block in the ledger: its project and title and, for an agent's block, its
// session, so a block of another session with the same title is not taken for it. A hand-kept
// task has no session, so only a hand-kept task's questions match it, not an agent block's (#174).
export const isAskedBy = (record: QuestionRecord, ref: TaskRef): boolean =>
  record.source?.project === ref.project && record.source.task === ref.title && (ref.session === null ? record.source.kind === 'manual' : (ref.resume !== undefined && ref.resume !== null && record.source.session === ref.resume) || record.source.session === ref.session || (record.source.session.length > 8 && record.source.session.startsWith(ref.session)))
export const questionProofPath = (path: string, kind: keyof QuestionProofs, hash: string): string => `${path.replace(/\.md$/i, '')}-questions-${kind}-${hash}.json`
export const questionProofOf = (path: string, name: string): { kind: keyof QuestionProofs; hash: string } | null => {
  const prefix = `${path.replace(/\\/g, '/').split('/').at(-1)?.replace(/\.md$/i, '')}-questions-`
  if (!name.startsWith(prefix)) return null
  const match = /^(retired|consumed)-([a-f0-9]{64})\.json$/.exec(name.slice(prefix.length))
  return match === null ? null : { kind: match[1] as keyof QuestionProofs, hash: match[2] ?? '' }
}
export const questionProofJson = (kind: keyof QuestionProofs, hash: string): string => `${JSON.stringify({ version: 1, kind, hash })}\n`
export const isQuestionProof = (text: string, kind: keyof QuestionProofs, hash: string): boolean => text === questionProofJson(kind, hash)

export const isTornLedger = (text: string): boolean => {
  if (text.includes('\0')) return true
  if (text.trim() === '') return false
  try {
    JSON.parse(text)
    return false
  } catch {
    return true
  }
}

// Invalid data stays on disk: unlike an acknowledgement, a lost identity could attach an old
// hide to a renewed question. A caller must preserve its last good record and refuse writes.
export const parseQuestions = (text: string, isMissing = false): QuestionLedger | null => {
  if (text.trim() === '') return isMissing ? emptyQuestions() : null
  try {
    const data = JSON.parse(text) as QuestionLedger
    if (data.version !== 1 || !Number.isSafeInteger(data.next) || data.next < 1 || !Array.isArray(data.records) || data.legacy === null || typeof data.legacy !== 'object' || Array.isArray(data.legacy)) return null
    const ids = new Set<string>()
    for (const row of data.records) {
      if (row === null || typeof row !== 'object' || !/^question:[a-f0-9]{64}:\d+$/.test(row.id) || ids.has(row.id) || typeof row.scope !== 'string' || typeof row.words !== 'string' || typeof row.incarnation !== 'string' || !Number.isSafeInteger(row.occurrence) || row.occurrence < 1 || !Number.isSafeInteger(row.copies) || row.copies < row.occurrence || typeof row.isWaiting !== 'boolean' || typeof row.isPresent !== 'boolean' || !Number.isFinite(row.firstObserved) || row.firstObserved < 0 || Number(row.id.slice(row.id.lastIndexOf(':') + 1)) >= data.next) return null
      if (row.id.split(':')[1] !== sha256(JSON.stringify([row.scope, row.words, row.occurrence, row.copies, row.incarnation]))) return null
      if (row.producer !== undefined && typeof row.producer !== 'string') return null
      if (row.isUnresolved !== undefined && typeof row.isUnresolved !== 'boolean') return null
      if (row.resolvedAt !== undefined && (!Number.isFinite(row.resolvedAt) || row.resolvedAt < 0)) return null
      if (row.isArchived !== undefined && typeof row.isArchived !== 'boolean') return null
      if (row.producerRevisions !== undefined && (!Array.isArray(row.producerRevisions) || row.producerRevisions.some(revision => typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)))) return null
      if (row.producerSources !== undefined && (!Array.isArray(row.producerSources) || row.producerSources.some(source => typeof source !== 'string'))) return null
      if (row.source !== undefined && (row.source === null || typeof row.source !== 'object' || !['block', 'own', 'manual', 'inbox'].includes(row.source.kind) || ['project', 'task', 'context', 'text', 'agent', 'session', 'data'].some(key => typeof (row.source as unknown as Record<string, unknown>)[key] !== 'string'))) return null
      if (row.source !== undefined) row.source = normalizeSource(row.source)
      ids.add(row.id)
    }
    if (Object.values(data.legacy).some(id => typeof id !== 'string' || (id !== '' && !ids.has(id)))) return null
    return data
  } catch {
    return null
  }
}

export const questionsJson = (ledger: QuestionLedger): string => `${JSON.stringify(ledger, null, 2)}\n`
// Standalone polls rewrite this machine index often; indentation need not be allocated or read back.
export const compactQuestionsJson = (ledger: QuestionLedger): string => `${JSON.stringify(ledger)}\n`

// A resolution is permanent for this incarnation, while its source stays available.
export const resolveQuestion = (ledger: QuestionLedger, id: string, now: number): QuestionLedger => ({
  ...ledger,
  records: ledger.records.map(record => record.id === id && record.isUnresolved
    ? { ...record, isUnresolved: false, isWaiting: false, isPresent: false, resolvedAt: now }
    : record),
})

export type QuestionCapture = { version: 1; disposition: 'unresolved' | 'resolved' | 'archived'; record: QuestionRecord }
export const captureJson = (record: QuestionRecord, disposition: QuestionCapture['disposition']): string => `${JSON.stringify({ version: 1, disposition, record })}\n`
export const capturePath = (path: string, hash: string): string => `${path.replace(/\.md$/i, '')}-questions-source-${hash}.json`
export const captureHashOf = (path: string, name: string): string | null => {
  const prefix = `${path.replace(/\\/g, '/').split('/').at(-1)?.replace(/\.md$/i, '')}-questions-source-`
  return name.startsWith(prefix) && /^[a-f0-9]{64}\.json$/.test(name.slice(prefix.length)) ? name.slice(prefix.length, -5) : null
}
export const parseCapture = (text: string, hash: string): QuestionCapture | null => {
  if (sha256(text) !== hash) return null
  try {
    const value = JSON.parse(text) as QuestionCapture
    if (value.version !== 1 || !['unresolved', 'resolved', 'archived'].includes(value.disposition) || value.record?.source === undefined) return null
    const next = Number(value.record.id.slice(value.record.id.lastIndexOf(':') + 1)) + 1
    const parsed = parseQuestions(JSON.stringify({ version: 1, next, records: [value.record], legacy: {} }))
    const record = parsed?.records[0]
    return record === undefined ? null : { ...value, record }
  } catch {
    return null
  }
}

// Captures add missing evidence; a terminal receipt applies only to its exact incarnation.
// A stale mutable index cannot erase an immutable source or reverse its resolution receipt.
export const withCaptures = (ledger: QuestionLedger, captures: readonly QuestionCapture[]): QuestionLedger => {
  const records = ledger.records.map(record => ({ ...record }))
  // Each id to its first record, which a search of the list would find; a board holds thousands (#416).
  const byId = new Map<string, QuestionRecord>()
  for (const record of records) if (!byId.has(record.id)) byId.set(record.id, record)
  for (const capture of captures) {
    const previous = byId.get(capture.record.id)
    if (previous === undefined) {
      const record = { ...capture.record }
      records.push(record)
      byId.set(record.id, record)
    } else {
      if (previous.source === undefined) previous.source = capture.record.source
      if (capture.record.producerRevisions !== undefined) previous.producerRevisions = [...new Set([...(previous.producerRevisions ?? []), ...capture.record.producerRevisions])]
      if (capture.record.producerSources !== undefined) previous.producerSources = [...new Set([...(previous.producerSources ?? []), ...capture.record.producerSources])]
    }
  }
  for (const capture of captures) {
    const record = byId.get(capture.record.id)
    if (record === undefined) continue
    if (capture.disposition === 'archived') record.isArchived = true
    if (capture.disposition === 'resolved') {
      if (capture.record.resolvedAt !== undefined) record.resolvedAt = capture.record.resolvedAt
      record.isUnresolved = false
      record.isWaiting = false
      record.isPresent = false
    }
  }
  return { ...ledger, next: records.reduce((next, record) => Math.max(next, Number(record.id.slice(record.id.lastIndexOf(':') + 1)) + 1), ledger.next), records }
}

// The copies a question pass keeps before it writes the ledger, in the order of `observed`: an
// open question whose copy is not among `captures` yet, and a question resolved since `current`
// was read. Each capture is serialised once, not once for every record: on a board with
// thousands of each, comparing them pair by pair kept the first poll from reaching the host for
// longer than Claude Code waits before it unloads the mod (#416).
export const copiesToKeep = (current: QuestionLedger, observed: QuestionLedger, captures: readonly QuestionCapture[]): { record: QuestionRecord; disposition: 'unresolved' | 'resolved' }[] => {
  const held = new Set(captures.map(capture => captureJson(capture.record, capture.disposition)))
  const openIds = new Set(current.records.filter(record => record.isUnresolved === true).map(record => record.id))
  return observed.records.flatMap(record => {
    if (record.source === undefined) return []
    const kept: { record: QuestionRecord; disposition: 'unresolved' | 'resolved' }[] = []
    if (record.isUnresolved && !held.has(captureJson(record, 'unresolved'))) kept.push({ record, disposition: 'unresolved' })
    if (record.isUnresolved === false && openIds.has(record.id) && !held.has(captureJson(record, 'resolved'))) kept.push({ record, disposition: 'resolved' })
    return kept
  })
}

// The questions a pass retires that have no retirement proof among `kept` yet, in the order of
// `current`: one that was on the board and now is neither waiting there nor resolved, and one
// whose resolution `resolvedQuestionsToRetire` lets go. The same questions come back on every
// pass, and checking each kept proof on disk again cost three trips to the host apiece, thousands
// a minute on a big board, while the write queue waited (#416).
export const identitiesToRetire = (current: QuestionLedger, observed: QuestionLedger, retiredResolutions: readonly string[], kept: readonly string[] = []): string[] => {
  const still = new Set(observed.records.filter(record => (record.isPresent && record.isWaiting) || record.resolvedAt !== undefined).map(record => record.id))
  const resolutions = new Set(retiredResolutions)
  const proven = new Set(kept)
  return current.records.filter(old => ((old.isPresent && !still.has(old.id)) || resolutions.has(old.id)) && !proven.has(sha256(old.id))).map(old => old.id)
}

// The folder keeps at least this many of each kind of question file (#156): the newest by
// modified time, whatever they hold. Older ones go only when the rules below find nothing in
// them that the ledger or a newer file does not already hold, so the number is a floor.
export const QUESTION_FILES_KEPT = 16

export type HeldCapture = { hash: string; mtimeMs: number; capture: QuestionCapture }
export type HeldProof = { kind: keyof QuestionProofs; hash: string; mtimeMs: number }
export type CaptureCover = { hash: string; cover: string | null; retired: string | null }

// Newest first. The name breaks a tie, so two sessions looking at the same folder pick the same files.
const newestFirst = <T extends { hash: string; mtimeMs: number }>(files: readonly T[]): T[] =>
  [...files].sort((a, b) => b.mtimeMs - a.mtimeMs || (a.hash < b.hash ? 1 : a.hash > b.hash ? -1 : 0))

// What the ledger would hold of one record if the capture were the only copy left.
const restored = (captures: readonly QuestionCapture[]): string => JSON.stringify(withCaptures(emptyQuestions(), captures).records)

// True when reading the capture back into the ledger changes nothing in this record.
const isCovered = (record: QuestionRecord, capture: QuestionCapture): boolean =>
  JSON.stringify(withCaptures({ ...emptyQuestions(), records: [record] }, [capture]).records) === JSON.stringify([record])

// Which capture files can go, each with the file that lets it go: the retirement proof, or the
// newest newer copy that holds what it holds. The trim reads exactly those again before it removes
// anything (#416). A capture of a question goes only when all of these hold:
// - it is not among the newest `keep` captures;
// - the ledger file itself holds that question, with everything the capture adds, so no
//   unresolved question lives only in a copy that is removed;
// - it is not the newest copy of the question's open state that every poll looks for (it would be
//   written again at once);
// - and either the question is resolved and retired, so nothing reads its copies any more, or
//   a newer copy of the same kind for the same question already holds everything this one does,
//   which leaves the newest copy of each kind in place, so a ledger lost later is rebuilt as before.
// Anything else stays, even when that leaves more than `keep` files.
export const captureCovers = (ledger: QuestionLedger, held: readonly HeldCapture[], retired: readonly string[], keep = QUESTION_FILES_KEPT): CaptureCover[] => {
  const ordered = newestFirst(held)
  const candidates = ordered.slice(keep)
  if (candidates.length === 0) return []
  const records = new Map(ledger.records.map(record => [record.id, record]))
  const retiredHashes = new Set(retired)
  const rank = new Map(ordered.map((one, index) => [one.hash, index]))
  const byQuestion = new Map<string, HeldCapture[]>()
  for (const one of ordered) {
    const same = byQuestion.get(one.capture.record.id)
    if (same === undefined) byQuestion.set(one.capture.record.id, [one])
    else same.push(one)
  }
  // What each copy restores on its own, worked out once however many older copies it is weighed against.
  const restoredAlone = new Map<string, string>()
  const alone = (one: HeldCapture): string => {
    const text = restoredAlone.get(one.hash) ?? restored([one.capture])
    restoredAlone.set(one.hash, text)
    return text
  }
  return candidates.flatMap<CaptureCover>(one => {
    const record = records.get(one.capture.record.id)
    if (record === undefined || !isCovered(record, one.capture)) return []
    const proof = record.isUnresolved === false && record.resolvedAt !== undefined ? sha256(record.id) : null
    if (proof !== null && retiredHashes.has(proof)) return [{ hash: one.hash, cover: null, retired: proof }]
    if (record.isUnresolved && captureJson(record, 'unresolved') === captureJson(one.capture.record, one.capture.disposition)) {
      // Old copies of one block at different lines all read as the open copy now: the newest,
      // in the order two sessions agree on, is the one kept, and it covers the rest.
      const newest = (byQuestion.get(record.id) ?? []).find(other => captureJson(record, 'unresolved') === captureJson(other.capture.record, other.capture.disposition))
      if (newest !== undefined) return newest.hash === one.hash ? [] : [{ hash: one.hash, cover: newest.hash, retired: null }]
    }
    const own = rank.get(one.hash) ?? 0
    const cover = (byQuestion.get(record.id) ?? []).find(other => (rank.get(other.hash) ?? 0) < own && other.capture.disposition === one.capture.disposition && restored([other.capture, one.capture]) === alone(other))
    return cover === undefined ? [] : [{ hash: one.hash, cover: cover.hash, retired: null }]
  })
}

// The hashes alone.
export const prunableCaptures = (ledger: QuestionLedger, held: readonly HeldCapture[], retired: readonly string[], keep = QUESTION_FILES_KEPT): string[] =>
  captureCovers(ledger, held, retired, keep).map(one => one.hash)

// Which proof files can go. Beyond the newest `keep` of its kind, a proof goes only when nothing
// can still refer to it: a retired proof is the hash of a question id, a consumed proof the hash
// of an old acknowledgement. A proof whose id is in the ledger or a capture, or whose key is in
// the ledger's migration map or the acknowledgement list, stays: without it an old resolution
// could swallow a renewed question, or a migrated hide could be applied a second time.
export const prunableProofs = (ledger: QuestionLedger, captures: readonly QuestionCapture[], answered: readonly string[], held: readonly HeldProof[], keep = QUESTION_FILES_KEPT): HeldProof[] => {
  const known = new Set<string>()
  for (const record of ledger.records) known.add(sha256(record.id))
  for (const capture of captures) known.add(sha256(capture.record.id))
  for (const [key, id] of Object.entries(ledger.legacy)) {
    known.add(sha256(key))
    known.add(sha256(id))
  }
  for (const key of answered) known.add(sha256(key))

  return (['retired', 'consumed'] as const).flatMap(kind => newestFirst(held.filter(one => one.kind === kind)).slice(keep).filter(one => !known.has(one.hash)))
}

// What a torn ledger or a cut-off write leaves beside the ledger, and nothing else removes
// (#156): a torn ledger moved aside (`.torn-<time>-<who>`), kept to look into, and a temporary
// copy of a write that a crash or a failed clean-up left (`.tmp-<session>-<n>` from the pane,
// `.<pid>.<time>.board-tmp` from the board script). The torn files past the newest `keepTorn`, by
// the time in their names (in milliseconds; a name moved aside by hand, such as `.torn-2026-10-19`,
// by the file's own time), and
// any over a week old, so a few left from one bad day do not stay for good; and the temporary
// copies over a day old. The caller removes a torn file only when it still holds torn text, and a
// temporary copy only while the ledger itself reads: with no ledger, a temporary copy may be the
// only complete one.
export const LEDGER_TORN_KEPT = 3
export const LEDGER_TORN_MS = 7 * 24 * 60 * 60 * 1000
export const LEDGER_TEMP_MS = 24 * 60 * 60 * 1000
export const ledgerLeftovers = (path: string, entries: ReadonlyArray<{ name: string; mtimeMs: number }>, now: number, keepTorn = LEDGER_TORN_KEPT): { torn: string[]; temps: string[] } => {
  const ledger = questionsPath(path).replace(/^.*[\\/]/, '')
  const tornAt = (entry: { name: string; mtimeMs: number }): number => Number(/^\.torn-(\d{12,})-/.exec(entry.name.slice(ledger.length))?.[1] ?? entry.mtimeMs)
  const torn = entries
    .filter(entry => entry.name.startsWith(`${ledger}.torn-`))
    .sort((a, b) => tornAt(b) - tornAt(a) || (a.name < b.name ? -1 : 1))
    .filter((entry, index) => index >= keepTorn || now - tornAt(entry) > LEDGER_TORN_MS)
  const isTemp = (name: string): boolean => name.startsWith(`${ledger}.tmp-`) || (name.startsWith(`${ledger}.`) && name.endsWith('.board-tmp'))
  const temps = entries.filter(entry => isTemp(entry.name) && now - entry.mtimeMs > LEDGER_TEMP_MS)

  return { torn: torn.map(entry => entry.name), temps: temps.map(entry => entry.name) }
}

// What an idle question pass reads from the folder beside progress.md (#156): progress.md, the
// ledger, the answered file, the copies and the proofs, by name, size and time, in name order.
// Null while one of them is younger than `freshMs`: a second write in the same second can keep
// both its size and a whole-second time, so it would look unchanged.
export const questionFilesKey = (
  path: string,
  answered: string,
  entries: ReadonlyArray<{ name: string; size: number; mtimeMs: number }>,
  now: number,
  freshMs: number,
): Array<readonly [string, number, number]> | null => {
  const names = [path, questionsPath(path), answered].map(file => file.replace(/^.*[\\/]/, ''))
  const files = entries
    .filter(entry => names.includes(entry.name) || captureHashOf(path, entry.name) !== null || questionProofOf(path, entry.name) !== null)
    .map(entry => [entry.name, entry.size, entry.mtimeMs] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return files.some(([, , mtimeMs]) => now - mtimeMs < freshMs) ? null : files
}

type Observation = { scope: string; session: string; index: number | string; text: string; isWaiting: boolean; producer: string; producerRevisions?: string[]; producerSources?: string[]; source: QuestionSource }

const isUniqueUnresumedTask = (task: ProgressTask, projects: readonly ProgressProject[], ownId: string): boolean => {
  let count = 0
  let unresumed = 0
  for (const p of projects) {
    for (const t of p.tasks) {
      if (t.auto !== null && (t.auto.agent === undefined || t.auto.agent === 'claude') && t.auto.session === ownId) {
        count += 1
        if (t.auto.resume === null || t.auto.resume === undefined) unresumed += 1
      }
    }
  }
  return count === 1 && unresumed === 1
}

const ownObservations = (mine: ProgressMirror): Observation[] => {
  if (mine.isRun === true) return []
  const own = shortId(mine.sessionId)
  const scope = questionScope(mine.project, 'claude', own)
  return mine.tasks.map((task, index) => ({ scope, session: own, index, text: stepWords(task).trim(), isWaiting: waitsOnYou(mine, task) && task.blocked === null, producer: questionToken(task), source: { kind: 'own', project: mine.project, task: mine.title, context: mine.context, text: stepWords(task).trim(), agent: 'claude', session: own, data: JSON.stringify({ task, title: mine.title, context: mine.context }) } }))
}

// All a question pass reads from this session's own list: whose it is and the rows it gives.
// Its times, turn state and background jobs change with every hook of a running session and
// are left out, so they do not make an idle poll pass again (#416).
export const ownQuestionsKey = (mine: ProgressMirror | null): string =>
  JSON.stringify(mine === null ? null : [mine === null ? '' : shortId(mine.sessionId), mine.project, ownObservations(mine)])

const observations = (projects: readonly ProgressProject[], mine: ProgressMirror | null, pending: readonly PendingTurn[], frozen: ReadonlySet<string> = new Set()): Observation[] => {
  const own = mine === null ? '' : shortId(mine.sessionId)
  const rows: Observation[] = []
  const scopes = new Set<string>()
  const ambiguous = new Set<string>()
  for (const project of projects) {
    for (const task of project.tasks) {
      const isMine = mine !== null && (
        task.auto?.resume !== null && mine.sessionId
          ? task.auto?.resume === mine.sessionId
          : (Boolean(mine.sessionId) && task.auto?.session === own && (task.auto?.agent === undefined || task.auto?.agent === 'claude') && mine.isRun !== true && isUniqueUnresumedTask(task, projects, own))
      )
      if (isMine) continue
      const scope = questionScope(project.name, task.auto?.agent ?? 'manual', task.auto?.session ?? task.title)
      if (frozen.has(scope)) continue
      if (scopes.has(scope)) ambiguous.add(scope)
      scopes.add(scope)
      // The task's background and its copy as data are the same for each of its steps, so they
      // are worked out once per task rather than once per step (#371).
      const context = task.notes.find(note => /^(?:背景|Context|Background)\s*[:：]/i.test(note))?.replace(/^(?:背景|Context|Background)\s*[:：]\s*/i, '') ?? (task.auto === null ? task.notes.join('\n') : '')
      const data = sourceData(task)
      task.steps.forEach((step, index) => rows.push({ scope, session: task.auto?.session ?? '', index, text: step.text, isWaiting: step.status === 'waiting', producer: step.questionToken ?? '', source: { kind: task.auto === null ? 'manual' : 'block', project: project.name, task: task.title, context, text: step.text, agent: task.auto?.agent ?? '', session: task.auto?.session ?? '', data } }))
    }
  }
  if (mine !== null) rows.push(...ownObservations(mine))
  for (const turn of pending) {
    if (!turn.isQuestion || turn.id === undefined) continue
    const scope = questionScope(turn.project, turn.agent, turn.id)
    if (frozen.has(scope)) continue
    const matching = rows.filter(row => row.isWaiting && row.scope === scope && questionWords(row.text) === questionWords(turn.text))
    if (matching.length === 1 && matching[0] !== undefined) {
      const row = matching[0]
      row.producerRevisions = [...new Set([...(row.producerRevisions ?? []), ...(turn.sourceRevisions ?? [])])]
      row.producerSources = [...(row.producerSources ?? []), JSON.stringify(turn)]
      continue
    }
    rows.push({ scope, session: turn.id, index: `inbox:${questionWords(turn.text)}`, text: turn.text, isWaiting: true, producer: '', producerRevisions: turn.sourceRevisions, producerSources: [JSON.stringify(turn)], source: { kind: 'inbox', project: turn.project, task: '', context: '', text: turn.text, agent: turn.agent, session: turn.id, data: JSON.stringify(turn) } })
  }
  const tokens = new Map<string, number>()
  for (const row of rows) {
    if (row.producer !== '') {
      const key = JSON.stringify([row.scope, row.producer])
      tokens.set(key, (tokens.get(key) ?? 0) + 1)
    }
  }
  return rows.filter(row => !ambiguous.has(row.scope) && (row.producer === '' || tokens.get(JSON.stringify([row.scope, row.producer])) === 1))
}

// Seeing the source without its question ends a no-token resolution's lifetime.
// A missing source alone cannot prove that an unchanged question was renewed.
export const resolvedQuestionsToRetire = (ledger: QuestionLedger, projects: readonly ProgressProject[], mine: ProgressMirror | null, pending: readonly PendingTurn[], frozen: ReadonlySet<string> = new Set()): string[] => {
  const seen = observations(projects, mine, pending, frozen)
  const scopes = new Set([
    ...projects.flatMap(project => project.tasks.map(task => questionScope(project.name, task.auto?.agent ?? 'manual', task.auto?.session ?? task.title))),
    ...(mine === null ? [] : [questionScope(mine.project, 'claude', shortId(mine.sessionId))]),
    ...seen.map(row => row.scope),
  ])
  return ledger.records.filter(record => record.resolvedAt !== undefined && scopes.has(record.scope) && !frozen.has(record.scope) && !seen.some(row => row.scope === record.scope && row.isWaiting && questionWords(row.text) === record.words)).map(record => record.id)
}

// Words identify candidates, not questions. A durable sequence identifies each incarnation;
// observed resolution or absence starts a new one. Equal-word steps retain separate slots
// across unrelated edits; changing their multiplicity is ambiguous and retires their hides.
export const observeQuestions = (
  ledger: QuestionLedger,
  projects: readonly ProgressProject[],
  mine: ProgressMirror | null,
  answered: readonly string[],
  now: number,
  isSettled = false,
  incarnation = 'preview',
  proofs: QuestionProofs = { retired: [], consumed: [] },
  pending: readonly PendingTurn[] = [],
  answeredTurns: readonly (AgentTurn | QuestionAnswerEvidence)[] = [],
  frozen: ReadonlySet<string> = new Set(),
): { ledger: QuestionLedger; keys: Record<string, string>; marked: string[] } => {
  const records = ledger.records.map(row => ({ ...row }))
  for (const record of records) {
    if (record.source?.kind !== 'inbox' || !record.isUnresolved) continue
    let source: PendingTurn
    try { source = JSON.parse(record.source.data) as PendingTurn } catch { continue }
    const at = source?.sourceAt ?? source?.at
    // Cursor and Grok emit an empty stop for the asking turn. Only a later text-bearing
    // response or an accepted prompt proves continuation, even if the session moved folders.
    if (!Number.isFinite(at) || !answeredTurns.some(turn => (turn.event === 'prompt' || (turn.event === 'turn' && (!('answer' in turn) || turn.answer.trim() !== ''))) && turn.at !== undefined && Number.isFinite(turn.at) && turn.at > at && turn.agent === record.source?.agent && turn.id === record.source?.session)) continue
    record.isUnresolved = false
    record.isWaiting = false
    record.isPresent = false
  }
  // Producer receipts and an explicit resolution suppress only the resolved incarnation.
  // A new file/content revision can still prove a fresh ask without changing its words.
  const seen = observations(projects, mine, pending, frozen)
  // Each row's copies (the rows of its scope with the same words, in order), indexed once:
  // comparing every row with every other took seconds on a board of a few thousand steps (#371).
  const copyKey = (row: Observation): string => JSON.stringify([row.scope, questionWords(row.text)])
  const copyIndex = new Map<string, Observation[]>()
  for (const row of seen) {
    const key = copyKey(row)
    const copies = copyIndex.get(key)
    if (copies === undefined) copyIndex.set(key, [row])
    else copies.push(row)
  }
  // Every row asked about is one of `seen`, so it is always in the index. The lists are shared
  // between the rows of a group, so they are read only.
  const copiesOf = (row: Observation): readonly Observation[] => copyIndex.get(copyKey(row)) ?? []
  const hasNewRevision = (row: Observation, record: QuestionRecord): boolean =>
    [row, ...records.filter(other => other.scope === row.scope && other.words === record.words && other.isPresent && other.isUnresolved)]
      .some(other => other.producerRevisions?.some(revision => !record.producerRevisions?.includes(revision)))
  // Each row's words, each record's hash and the retired set are worked out once a pass, not once
  // for every pair of row and record (#416).
  const retired = new Set(proofs.retired)
  const hashes = new Map<string, string>()
  const isRetired = (record: QuestionRecord): boolean => {
    if (retired.size === 0) return false
    const hash = hashes.get(record.id) ?? sha256(record.id)
    hashes.set(record.id, hash)
    return retired.has(hash)
  }
  const resolved = seen.flatMap(row => {
    if (!row.isWaiting) return []
    const copies = copiesOf(row)
    const words = questionWords(row.text)
    const record = records.find(record => record.scope === row.scope && (record.producer ?? '') === row.producer && record.words === words && record.isUnresolved === false && (row.producer !== '' || (record.resolvedAt !== undefined && record.source?.task === row.source.task && !isRetired(record) && record.occurrence === copies.indexOf(row) + 1 && record.copies === copies.length && !hasNewRevision(row, record))))
    return record === undefined ? [] : [{ row, record }]
  })
  const resolvedRows = new Set(resolved.map(item => item.row))
  // The revisions a settled record of each scope already holds.
  const settledRevisions = new Set(records.filter(record => record.isUnresolved === false).flatMap(record => (record.producerRevisions ?? []).map(revision => JSON.stringify([record.scope, revision]))))
  const rows = seen.filter(row => !resolvedRows.has(row) && (row.source.kind !== 'inbox' || row.producerRevisions === undefined || row.producerRevisions.length === 0 || !row.producerRevisions.every(revision => settledRevisions.has(JSON.stringify([row.scope, revision])))))
  for (const record of records) {
    if (isRetired(record)) {
      record.isPresent = false
      record.isWaiting = false
    }
  }
  const legacy = { ...ledger.legacy }
  // Bind stale source details to the resolved incarnation without making it actionable.
  const keys: Record<string, string> = Object.fromEntries(resolved.map(({ row, record }) => [questionSlot(row.scope, row.index), record.id]))
  const assigned = new Set<string>()
  const groups = new Map<string, Observation[]>()
  for (const row of rows) {
    const group = JSON.stringify([row.scope, questionWords(row.text)])
    groups.set(group, [...(groups.get(group) ?? []), row])
  }
  // If the ledger was removed, never reuse an id still held by an acknowledgement.
  const acknowledged = answered.filter(key => /^question:[a-f0-9]{64}:\d+$/.test(key)).map(key => Number(key.slice(key.lastIndexOf(':') + 1)) + 1).filter(Number.isSafeInteger)
  let next = acknowledged.reduce((latest, value) => Math.max(latest, value), ledger.next)
  for (const alike of groups.values()) {
    const first = alike[0]
    if (first === undefined) continue
    const words = questionWords(first.text)
    const candidates = records.filter(row => row.scope === first.scope && row.words === words && row.isPresent)
    const copies = copiesOf(first)
    const isAmbiguous = candidates.some(row => !row.producer && row.copies !== copies.length)
    if (isAmbiguous) for (const old of candidates.filter(record => !record.producer)) {
      old.isPresent = false
      old.isWaiting = false
    }
    alike.forEach(row => {
      const occurrence = copies.indexOf(row) + 1
      if (row.producer !== '') {
        const owner = row.producer.split(':')[0]
        for (const old of records) {
          if (old.scope === row.scope && old.producer?.split(':')[0] === owner && (old.producer !== row.producer || old.words !== words)) {
            old.isPresent = false
            old.isWaiting = false
            old.isUnresolved = false
          }
        }
      }
      let record = row.producer === ''
        ? isAmbiguous ? undefined : candidates.find(old => !old.producer && old.occurrence === occurrence)
        : candidates.find(old => old.producer === row.producer && old.isPresent)
      if (record !== undefined && (record.producer ?? '') !== row.producer) {
        record.isPresent = false
        record.isWaiting = false
        record = undefined
      }
      if (row.isWaiting && (record === undefined || !record.isWaiting)) {
        if (record !== undefined) record.isPresent = false
        const binding = sha256(JSON.stringify([row.scope, words, occurrence, copies.length, incarnation]))
        record = { id: `question:${binding}:${next++}`, scope: row.scope, words, occurrence, copies: copies.length, isWaiting: true, isPresent: true, firstObserved: Number.isFinite(now) && now > 0 ? now : 0, incarnation, producer: row.producer }
        records.push(record)
      }
      if (record === undefined) return
      record.isWaiting = row.isWaiting
      record.isUnresolved = row.isWaiting
      if (row.producerRevisions !== undefined) record.producerRevisions = [...new Set([...(record.producerRevisions ?? []), ...row.producerRevisions])]
      if (row.producerSources !== undefined) record.producerSources = [...new Set([...(record.producerSources ?? []), ...row.producerSources])]
      record.source = row.source
      assigned.add(record.id)
      if (row.isWaiting) keys[questionSlot(row.scope, row.index)] = record.id
    })
  }
  if (isSettled) {
    for (const record of records) {
      if (!assigned.has(record.id) && !frozen.has(record.scope)) {
        // End, cleanup and disconnection are not evidence that this exact ask was answered.
        if (record.source?.kind === 'inbox' && record.isUnresolved) continue
        record.isPresent = false
        record.isWaiting = false
      }
    }
  }
  // An 'archived' mark is for a question whose block has gone. One whose block is still there,
  // because the archive stopped half way or the block was updated meanwhile, is a live question.
  for (const record of records) if (record.isArchived && assigned.has(record.id)) delete record.isArchived
  // A historical position cannot tell equal-word duplicates apart after movement. Migrate
  // only one candidate in one scope; retain ambiguous marks without applying a future hide.
  for (const key of answered) {
    if (key.startsWith('question:') || Object.hasOwn(legacy, key) || answered.includes(migrationKey(key)) || proofs.consumed.includes(sha256(key))) continue
    const match = /^(\S+) (\d+) ([\s\S]*)$/.exec(key)
    if (match === null) continue
    const [, session, , text = ''] = match
    const candidates = rows.filter(row => (row.session === session || (row.session.length > 8 && row.session.startsWith(session))) && row.isWaiting && questionWords(row.text) === questionWords(text))
    const picked = candidates.length === 1 ? candidates[0] : undefined
    if (picked !== undefined) legacy[key] = keys[questionSlot(picked.scope, picked.index)] ?? ''
    else if (isSettled && rows.some(row => row.session === session || (row.session.length > 8 && row.session.startsWith(session)))) legacy[key] = ''
  }
  return {
    ledger: { version: 1, next, records, legacy: isSettled ? legacy : ledger.legacy },
    keys,
    marked: answered.map(key => answered.includes(migrationKey(key)) || proofs.consumed.includes(sha256(key)) ? '' : legacy[key] ?? key).filter(key => key !== ''),
  }
}

// A question kept for review after its block was archived (#400). Its identity is retired and it no
// longer waits on the board, yet it can be hidden: that writes only the hidden list.
export const isKeptQuestion = (ledger: QuestionLedger, id: string): boolean =>
  ledger.records.some(record => record.id === id && record.isUnresolved && record.isArchived === true && record.source !== undefined)

export const acknowledgementKeys = (ledger: QuestionLedger, id: string): string[] =>
  [id, ...Object.entries(ledger.legacy).filter(([, target]) => target === id).flatMap(([key]) => [key, migrationKey(key)])]

// The migration marker and its target live in one acknowledgement write. Losing a separate
// ledger write can therefore resurface a question, but cannot reassign its historical hide.
export const migratedAnswered = (answered: readonly string[], ledger: QuestionLedger, consumed: readonly string[] = []): string[] => {
  const next = [...answered]
  for (const [key, target] of Object.entries(ledger.legacy)) {
    if (!answered.includes(key) || answered.includes(migrationKey(key)) || consumed.includes(sha256(key))) continue
    if (target !== '' && !next.includes(target)) next.push(target)
    next.push(migrationKey(key))
  }
  return next
}

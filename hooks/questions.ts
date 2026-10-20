import type { ProgressMirror, ProgressProject, QuestionLedger, QuestionProofs, QuestionRecord, QuestionSource } from '../types'
import type { PendingTurn } from './board'
import { scanBlocks, shortId, stepWords } from './blocks'
import { questionToken, waitsOnYou } from './mirror'
import { sha256 } from './sha256'
import type { TaskRef } from './view'

export type { QuestionLedger, QuestionProofs, QuestionRecord } from '../types'

export const emptyQuestions = (): QuestionLedger => ({ version: 1, next: 1, records: [], legacy: {} })
export const questionsPath = (path: string): string => `${path.replace(/\.md$/i, '')}-questions.json`
export const questionWords = (text: string): string => text.trim().replace(/\s+/g, ' ')
export const questionScope = (project: string, agent: string, session: string): string => JSON.stringify([project, agent || 'claude', session])
export const questionSlot = (scope: string, index: number | string): string => JSON.stringify([scope, index])
export const pendingQuestionSlot = (scope: string, text: string): string => questionSlot(scope, `inbox:${questionWords(text)}`)
export const migrationKey = (legacy: string): string => `question-migrated:${sha256(legacy)}`
export const isQuestionSnapshot = (text: string): boolean => scanBlocks(text.split(/\r?\n/)).every(span => span.isClosed)
export const archiveQuestionsKept = (projects: readonly ProgressProject[], ref: TaskRef, ledger: QuestionLedger): boolean => {
  const tasks = projects.filter(project => project.name === ref.project).flatMap(project => project.tasks).filter(task => ref.session === null ? task.title === ref.title : task.auto?.session === ref.session)
  if (tasks.length !== 1) return false
  const task = tasks[0]
  if (task === undefined) return false
  const scope = questionScope(ref.project, task.auto?.agent ?? 'manual', task.auto?.session ?? task.title)
  return task.steps.filter(step => step.status === 'waiting').every(step => ledger.records.some(record => record.isUnresolved
    ? record.source?.project === ref.project && record.source.text === step.text && record.source.data === JSON.stringify(task)
    : record.resolvedAt !== undefined && record.source !== undefined && record.scope === scope && record.words === questionWords(step.text) && (record.producer ?? '') === (step.questionToken ?? '') && !ledger.records.some(other => other.isUnresolved && other.scope === scope && other.words === questionWords(step.text))))
}
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
      ids.add(row.id)
    }
    if (Object.values(data.legacy).some(id => typeof id !== 'string' || (id !== '' && !ids.has(id)))) return null
    return data
  } catch {
    return null
  }
}

export const questionsJson = (ledger: QuestionLedger): string => `${JSON.stringify(ledger, null, 2)}\n`

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
    return parseQuestions(JSON.stringify({ version: 1, next, records: [value.record], legacy: {} })) === null ? null : value
  } catch {
    return null
  }
}

// Captures add missing evidence; a terminal receipt applies only to its exact incarnation.
// A stale mutable index cannot erase an immutable source or reverse its resolution receipt.
export const withCaptures = (ledger: QuestionLedger, captures: readonly QuestionCapture[]): QuestionLedger => {
  const records = ledger.records.map(record => ({ ...record }))
  for (const capture of captures) {
    const previous = records.find(record => record.id === capture.record.id)
    if (previous === undefined) records.push({ ...capture.record })
    else {
      if (previous.source === undefined) previous.source = capture.record.source
      if (capture.record.producerRevisions !== undefined) previous.producerRevisions = [...new Set([...(previous.producerRevisions ?? []), ...capture.record.producerRevisions])]
      if (capture.record.producerSources !== undefined) previous.producerSources = [...new Set([...(previous.producerSources ?? []), ...capture.record.producerSources])]
    }
  }
  for (const capture of captures) {
    const record = records.find(one => one.id === capture.record.id)
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

type Observation = { scope: string; session: string; index: number | string; text: string; isWaiting: boolean; producer: string; producerRevisions?: string[]; producerSources?: string[]; source: QuestionSource }

const observations = (projects: readonly ProgressProject[], mine: ProgressMirror | null, pending: readonly PendingTurn[]): Observation[] => {
  const own = mine === null ? '' : shortId(mine.sessionId)
  const rows: Observation[] = []
  const scopes = new Set<string>()
  const ambiguous = new Set<string>()
  for (const project of projects) {
    for (const task of project.tasks) {
      if (mine !== null && task.auto?.session === own) continue
      const scope = questionScope(project.name, task.auto?.agent ?? 'manual', task.auto?.session ?? task.title)
      if (scopes.has(scope)) ambiguous.add(scope)
      scopes.add(scope)
      task.steps.forEach((step, index) => rows.push({ scope, session: task.auto?.session ?? '', index, text: step.text, isWaiting: step.status === 'waiting', producer: step.questionToken ?? '', source: { kind: task.auto === null ? 'manual' : 'block', project: project.name, task: task.title, context: task.notes.find(note => /^(?:背景|Context|Background)\s*[:：]/i.test(note))?.replace(/^(?:背景|Context|Background)\s*[:：]\s*/i, '') ?? (task.auto === null ? task.notes.join('\n') : ''), text: step.text, agent: task.auto?.agent ?? '', session: task.auto?.session ?? '', data: JSON.stringify(task) } }))
    }
  }
  if (mine !== null) {
    const scope = questionScope(mine.project, 'claude', own)
    mine.tasks.forEach((task, index) => rows.push({ scope, session: own, index, text: stepWords(task).trim(), isWaiting: waitsOnYou(mine, task) && task.blocked === null, producer: questionToken(task), source: { kind: 'own', project: mine.project, task: mine.title, context: mine.context, text: stepWords(task).trim(), agent: 'claude', session: own, data: JSON.stringify({ task, title: mine.title, context: mine.context }) } }))
  }
  for (const turn of pending) {
    if (!turn.isQuestion || turn.id === undefined) continue
    const scope = questionScope(turn.project, turn.agent, turn.id)
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
export const resolvedQuestionsToRetire = (ledger: QuestionLedger, projects: readonly ProgressProject[], mine: ProgressMirror | null, pending: readonly PendingTurn[]): string[] => {
  const seen = observations(projects, mine, pending)
  const scopes = new Set([
    ...projects.flatMap(project => project.tasks.map(task => questionScope(project.name, task.auto?.agent ?? 'manual', task.auto?.session ?? task.title))),
    ...(mine === null ? [] : [questionScope(mine.project, 'claude', shortId(mine.sessionId))]),
    ...seen.map(row => row.scope),
  ])
  return ledger.records.filter(record => record.resolvedAt !== undefined && scopes.has(record.scope) && !seen.some(row => row.scope === record.scope && row.isWaiting && questionWords(row.text) === record.words)).map(record => record.id)
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
): { ledger: QuestionLedger; keys: Record<string, string>; marked: string[] } => {
  // Producer receipts and an explicit resolution suppress only the resolved incarnation.
  // A new file/content revision can still prove a fresh ask without changing its words.
  const seen = observations(projects, mine, pending)
  const copiesOf = (row: Observation): Observation[] => seen.filter(other => other.scope === row.scope && questionWords(other.text) === questionWords(row.text))
  const hasNewRevision = (row: Observation, record: QuestionRecord): boolean =>
    [row, ...ledger.records.filter(other => other.scope === row.scope && other.words === record.words && other.isPresent && other.isUnresolved)]
      .some(other => other.producerRevisions?.some(revision => !record.producerRevisions?.includes(revision)))
  const resolved = seen.flatMap(row => {
    const copies = copiesOf(row)
    const record = row.isWaiting ? ledger.records.find(record => record.scope === row.scope && (record.producer ?? '') === row.producer && record.words === questionWords(row.text) && record.isUnresolved === false && (row.producer !== '' || (record.resolvedAt !== undefined && record.source?.task === row.source.task && !proofs.retired.includes(sha256(record.id)) && record.occurrence === copies.indexOf(row) + 1 && record.copies === copies.length && !hasNewRevision(row, record)))) : undefined
    return record === undefined ? [] : [{ row, record }]
  })
  const rows = seen.filter(row => !resolved.some(item => item.row === row) && (row.source.kind !== 'inbox' || row.producerRevisions === undefined || row.producerRevisions.length === 0 || !row.producerRevisions.every(revision => ledger.records.some(record => record.scope === row.scope && record.isUnresolved === false && record.producerRevisions?.includes(revision)))))
  const records = ledger.records.map(row => ({ ...row }))
  for (const record of records) {
    if (proofs.retired.includes(sha256(record.id))) {
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
      if (!assigned.has(record.id)) {
        // End, cleanup and disconnection are not evidence that this exact ask was answered.
        if (record.source?.kind === 'inbox' && record.isUnresolved) continue
        record.isPresent = false
        record.isWaiting = false
      }
    }
  }
  // A historical position cannot tell equal-word duplicates apart after movement. Migrate
  // only one candidate in one scope; retain ambiguous marks without applying a future hide.
  for (const key of answered) {
    if (key.startsWith('question:') || Object.hasOwn(legacy, key) || answered.includes(migrationKey(key)) || proofs.consumed.includes(sha256(key))) continue
    const match = /^(\S+) (\d+) ([\s\S]*)$/.exec(key)
    if (match === null) continue
    const [, session, , text = ''] = match
    const candidates = rows.filter(row => row.session === session && row.isWaiting && questionWords(row.text) === questionWords(text))
    const picked = candidates.length === 1 ? candidates[0] : undefined
    if (picked !== undefined) legacy[key] = keys[questionSlot(picked.scope, picked.index)] ?? ''
    else if (isSettled && rows.some(row => row.session === session)) legacy[key] = ''
  }
  return {
    ledger: { version: 1, next, records, legacy: isSettled ? legacy : ledger.legacy },
    keys,
    marked: answered.map(key => answered.includes(migrationKey(key)) || proofs.consumed.includes(sha256(key)) ? '' : legacy[key] ?? key).filter(key => key !== ''),
  }
}

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

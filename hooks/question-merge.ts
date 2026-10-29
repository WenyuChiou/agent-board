import type { QuestionRecord } from '../types'
import { questionWords, sourceSnapshot } from './questions'
import type { WaitingItem } from './view'

// One question asked in several places shows once (#463). Two copies are the same question when
// they have the same agent, the same project folder and the same words once trimmed and with
// spaces collapsed; another agent, or another folder, is another question. Nothing is deleted:
// the other copies stay in the question list, and only the board shows one card for all of them.

// A Windows path (a drive letter, or a network share) reads the same with either slash, a trailing
// slash or a drive letter in either case; a leading `//` (a network share) is kept, so it is not
// taken for a path on the root. Any other path is a POSIX one: a backslash or a trailing space is
// part of a folder's name there, so only repeated and trailing slashes are folded.
const isWindowsPath = (path: string): boolean => /^(?:[A-Za-z]:(?:[\\/]|$)|\\\\)/.test(path.trim())

export const folderOf = (project: string): string => {
  const isWindows = isWindowsPath(project)
  const path = (isWindows ? project.trim().replace(/\\/g, '/') : project).replace(/(.)\/{2,}/g, '$1/').replace(/(.)\/+$/, '$1')

  return isWindows && /^[A-Za-z]:(\/|$)/.test(path) ? path.toLowerCase() : path
}

const copyKey = (agent: string, dir: string | null | undefined, words: string): string | null =>
  dir === null || dir === undefined || dir.trim() === '' ? null : JSON.stringify([agent === '' ? 'claude' : agent.toLowerCase(), folderOf(dir), words])

export const recordFolder = (record: QuestionRecord | undefined): string | null => {
  const source = record?.source
  if (source === undefined) return null
  if (source.kind === 'block') return sourceSnapshot(source.data)?.auto?.dir ?? null
  if (source.kind !== 'inbox') return null
  try {
    const turn = JSON.parse(source.data) as { dir?: unknown } | null
    return typeof turn?.dir === 'string' ? turn.dir : null
  } catch {
    return null
  }
}

// Only another agent's question, or another Claude Code session's, merges, and only one the
// ledger has a record of: a copy with no record has no age and no identity yet (a block cut off in
// the middle of a write). This session's own question is answered in the pane, and a hand-kept one
// is the person's own step to tick: each stays a card of its own.
export const itemKey = (item: WaitingItem): string | null =>
  item.where !== 'other' || item.questionId === undefined ? null : copyKey(item.agent, item.dir, questionWords(item.note === '' ? item.text : `${item.text} — ${item.note}`))

const recordKey = (record: QuestionRecord): string | null => {
  try {
    const [project, agent] = JSON.parse(record.scope) as unknown[]
    // A hand-kept task's scope names `manual` as its agent.
    return typeof project !== 'string' || typeof agent !== 'string' || agent === 'manual' ? null : copyKey(agent, recordFolder(record), record.words)
  } catch {
    return null
  }
}

// When a copy was first seen, and its place in the ledger: copies seen in the same pass share the
// time, and the ledger's order says which came last.
export type Seen = { at: number; rank: number }
const isBefore = (a: Seen, b: Seen): boolean => a.at < b.at || (a.at === b.at && a.rank < b.rank)

// A closed copy covers the copies of the same question asked before it, in other sessions, unless
// the session's next record asks the same words: a renewal closes the earlier record (same owner
// token and no answer time) while the session still asks, and that is not an answer. Hide always counts.
const ownerOf = (record: QuestionRecord): string => (record.producer ?? '').split(':')[0] ?? ''
const ownerKey = (record: QuestionRecord): string => JSON.stringify([record.scope, ownerOf(record)])

export const closedCopies = (records: readonly QuestionRecord[], marked: ReadonlySet<string>): Map<string, Map<string, Seen>> => {
  const closed = new Map<string, Map<string, Seen>>()
  const next = new Map<number, number>()
  const last = new Map<string, number>()
  records.forEach((record, rank) => {
    if (ownerOf(record) === '') return
    const owner = ownerKey(record)
    const before = last.get(owner)
    if (before !== undefined) next.set(before, rank)
    last.set(owner, rank)
  })
  records.forEach((record, rank) => {
    if (record.isUnresolved !== false && !marked.has(record.id)) return
    const after = next.get(rank)
    if (!marked.has(record.id) && record.resolvedAt === undefined && after !== undefined && records[after]?.words === record.words) return
    const key = recordKey(record)
    if (key === null) return
    const at: Seen = record.isUnresolved === false && record.resolvedAt !== undefined ? { at: record.resolvedAt, rank: -1 } : { at: record.firstObserved, rank }
    const sessions = closed.get(key) ?? new Map<string, Seen>()
    const had = sessions.get(record.scope)
    if (had === undefined || isBefore(had, at)) sessions.set(record.scope, at)
    closed.set(key, sessions)
  })

  return closed
}

// `scope`: the session that asked it ('' when the ledger has no record of it). `isStopped`: its
// session has stopped, so a live copy, when there is one, is the one to answer.
export type Copy = Seen & { item: WaitingItem; scope: string; isStopped?: boolean }

// The card each question keeps. It is the newest copy that can be acted on, of a session that has
// not stopped when there is one, so a reply goes to the session that asked last, and it carries the age of the oldest copy still open. The cards of
// questions that are not repeated come back as they were, in the order they came. A copy with no
// known time is never covered, and never the newest one while another has a time. Copies of one
// session stay as they are, each its own card.
export const mergeCopies = (copies: readonly Copy[], closed: ReadonlyMap<string, ReadonlyMap<string, Seen>>): WaitingItem[] => {
  const groups = new Map<string, Copy[]>()
  for (const copy of copies) {
    const key = itemKey(copy.item)
    if (key === null) continue
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [copy])
    else group.push(copy)
  }
  const gone = new Set<WaitingItem>()
  const carried = new Map<WaitingItem, WaitingItem>()
  for (const [key, all] of groups) {
    const sessions = new Map<string, number>()
    for (const copy of all) sessions.set(copy.scope, (sessions.get(copy.scope) ?? 0) + 1)
    const group = all.filter(copy => copy.scope !== '' && sessions.get(copy.scope) === 1)
    const closedHere = [...(closed.get(key) ?? [])]
    const isCovered = (copy: Copy): boolean => copy.at > 0 && closedHere.some(([scope, seen]) => scope !== copy.scope && isBefore(copy, seen))
    const open = group.filter(copy => !isCovered(copy))
    for (const copy of group) if (!open.includes(copy)) gone.add(copy.item)
    if (open.length === 0) continue
    const running = open.filter(copy => copy.isStopped !== true)
    const pool = running.length > 0 ? running : open
    const actionable = pool.filter(copy => copy.item.canHide !== false)
    const newest = (actionable.length > 0 ? actionable : pool).reduce((best, copy) => (isBefore(best, copy) ? copy : best))
    const known = open.filter(copy => copy.at > 0)
    const [first = newest, ...rest] = known.length > 0 ? known : open
    const oldest = rest.reduce((best, copy) => (copy.at < best.at ? copy : best), first)
    for (const copy of open) if (copy !== newest) gone.add(copy.item)
    // Hide acknowledges the newest observed copy, including stopped copies recorded after the
    // live reply target. That record's time and order cover this group, while later asks stay new.
    const acknowledged = open.filter(copy => copy.item.canHide !== false)
    const last = (acknowledged.length > 0 ? acknowledged : open).reduce((best, copy) => isBefore(best, copy) ? copy : best)
    if (oldest.item !== newest.item || last.item !== newest.item) carried.set(newest.item, { ...newest.item, when: oldest.item.when, hideKey: last.item.hideKey })
  }

  return copies.filter(copy => !gone.has(copy.item)).map(copy => carried.get(copy.item) ?? copy.item)
}

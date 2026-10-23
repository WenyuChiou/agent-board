import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { completionPrefix } from './mirror'
import { sha256 } from './sha256'
import type { ProgressProject } from '../types'

// How long the board keeps what it saves, and when one of its files is too big (#373). Every rule
// here removes only the board's own records and copies. A hand-kept task and a step that waits on
// the person are the person's own words: no size rule removes them, it only says so on the board.

const DAY = 24 * 60 * 60 * 1000
const KB = 1024
const MB = 1024 * KB

export const RETENTION = {
  // An agent session's record outlives its block: a block that ended goes to the archive three
  // days after its last write (one that still asks only once its question is kept), and a block
  // still on the board, such as a working or waiting one that asks, keeps its record at any age.
  endedAgentMs: 3 * DAY,
  agentMs: 30 * DAY,
  // A session's mirror with no open step is no longer on the board; one with open steps is.
  endedMirrorMs: 7 * DAY,
  openMirrorMs: 30 * DAY,
  recordMs: 30 * DAY,
  pendingQuestionMs: 3 * DAY,
  storeTempMs: DAY,
  failedInboxMs: 7 * DAY,
  // A month's journal or archive goes on in a new part from this size.
  monthPartBytes: MB,
  progressSoftBytes: 512 * KB,
  storeWarnBytes: 1.2 * MB,
  storeCapBytes: 1.5 * MB,
  capRetryMs: 6 * 60 * 60 * 1000,
  // The board says what it cleared over this many days, today and the days before it.
  prunedDays: 7,
  // Values read per pass over the store, so a pass costs the same on a store of any size.
  pruneReads: 20,
} as const

const PRUNABLE = ['agent:', 'mirror:', 'hinted:', 'done:', 'pendingInboxQuestion:']

export const isPrunableKey = (key: string): boolean => PRUNABLE.some(prefix => key.startsWith(prefix))

const fieldOf = (value: unknown, name: string): unknown => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined)

const isEnded = (value: unknown): boolean => fieldOf(value, 'state') === 'done' || fieldOf(value, 'state') === 'ended'

// All sessions on a machine share one plugin store, and a machine can have more than one board
// (each its own progress.md). The pane writes a short tag of its board's path into every `agent:`
// and `mirror:` record it saves, so only its own records use the short age and cap rules.
export const boardTag = (path: string): string => sha256(path).slice(0, 8)

const tagOf = (value: unknown): string | null => {
  const tag = fieldOf(value, 'board')
  return typeof tag === 'string' ? tag : null
}

// A record of another board, or with no tag from an earlier release, uses the 30-day age rule,
// whatever its state. Only this board's records use the short rules and the future-clock check.
export const isOwnRecord = (key: string, value: unknown, board: string): boolean =>
  !(key.startsWith('agent:') || key.startsWith('mirror:')) || tagOf(value) === board

const hasOpenSteps = (value: unknown): boolean => {
  const tasks = fieldOf(value, 'tasks')
  return Array.isArray(tasks) && tasks.some(task => fieldOf(task, 'status') !== 'completed')
}

// How long a record is kept after it was last written, or null for one that never ages. The short
// times need the board tag: without it the record may belong to a board that still shows its block.
export const recordLife = (key: string, value: unknown): number | null => {
  if (key.startsWith('agent:')) return isEnded(value) && tagOf(value) !== null ? RETENTION.endedAgentMs : RETENTION.agentMs
  if (key.startsWith('mirror:')) return tagOf(value) !== null && !hasOpenSteps(value) ? RETENTION.endedMirrorMs : RETENTION.openMirrorMs
  if (key.startsWith('hinted:') || key.startsWith('done:')) return RETENTION.recordMs
  if (key.startsWith('pendingInboxQuestion:')) return RETENTION.pendingQuestionMs
  return null
}

// The store records behind the blocks on the board. A record is kept while its block is there,
// whatever its age: the block is archived after it, and an agent that comes back to its block
// finds its steps there instead of starting over.
export const boardRecords = (projects: readonly ProgressProject[]): ((key: string) => boolean) => {
  const sessions = new Set<string>()
  const keys = new Set<string>()
  for (const project of projects) {
    for (const task of project.tasks) {
      if (task.auto === null) continue
      sessions.add(task.auto.session)
      keys.add(`agent:${task.auto.session}`)
      if (task.auto.resume !== null) keys.add(`mirror:${task.auto.resume}`)
    }
  }
  // A Claude block is named by the first 8 characters of its session's id.
  return key => keys.has(key) || (key.startsWith('mirror:') && sessions.has(key.slice('mirror:'.length, 'mirror:'.length + 8)))
}

// When a record was last written, or null for one with no time of its own.
export const stampOf = (key: string, value: unknown): number | null => {
  const stamp = typeof value === 'number' ? value : fieldOf(value, key.startsWith('pendingInboxQuestion:') ? 'at' : 'updated')
  return typeof stamp === 'number' ? stamp : null
}

// A record with no time of its own (an old shape, a broken value) is as old as can be, and so is
// one dated more than a day ahead: a clock that was set wrong would otherwise keep it for good.
// The caller keeps what is on the board before it asks. `board` is the tag of this board's path.
export const isExpiredRecord = (key: string, value: unknown, now: number, board: string): boolean => {
  const isOwn = isOwnRecord(key, value, board)
  const life = recordLife(key, isOwn ? value : { updated: stampOf(key, value) })
  if (life === null) return false
  const stamp = stampOf(key, value)
  return stamp === null || now - stamp > life || (isOwn && stamp - now > DAY)
}

// Whether a record read again is still the write the prune chose it from: a session that came
// back in between has written a newer one, and that one stays.
export const isSameWrite = (key: string, chosen: unknown, again: unknown): boolean => {
  const stamp = stampOf(key, chosen)
  return stamp === null ? JSON.stringify(chosen) === JSON.stringify(again) : stamp === stampOf(key, again)
}

// The other store keys that belong to one `agent:` or `mirror:` record: the receipts of the
// prompts an agent took (`agentPrompt:`), the completions the person confirmed (`completion:`,
// named by a hash of the record's key) and the journal lines a mirror could not write
// (`pendingJournalBad:`). Nothing else removes them, so they go with their record.
export const companionKeys = (record: string, keys: readonly string[]): string[] => {
  const isAgent = record.startsWith('agent:')
  if (!isAgent && !record.startsWith('mirror:')) return []
  const id = record.slice(record.indexOf(':') + 1)
  const completion = completionPrefix(record)

  return keys.filter(key => key.startsWith(completion) || (isAgent ? key.startsWith(`agentPrompt:${id}:`) : key === `pendingJournalBad:${id}`))
}

// The hand-kept tasks first seen done, as kept in the store's `doneSeen`: times only, and none older
// than a done mark's 30 days. Anything else in the value is dropped.
export const doneRecord = (value: unknown, now: number): Record<string, number> =>
  value === null || typeof value !== 'object' || Array.isArray(value)
    ? {}
    : Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && now - entry[1] <= RETENTION.recordMs))

// The next few keys to look at, after `after` (the last key the previous pass looked at), in
// name order, and where the next pass starts: '' once this pass reached the end.
export const pruneBatch = (keys: readonly string[], after: string, size: number = RETENTION.pruneReads): { batch: string[]; next: string } => {
  const prunable = keys.filter(isPrunableKey).sort()
  const from = Math.max(0, prunable.findIndex(key => key > after))
  const batch = prunable.slice(from, from + size)
  const last = batch.at(-1) ?? ''

  return { batch, next: last === prunable.at(-1) ? '' : last }
}

export type ListedFile = { name: string; kind: string; size: number; mtimeMs: number }

// The temporary copy a store write leaves when it is cut off. Only this plugin's own store's.
const STORE_TEMP = /^agent-board_.+\.json\.tmp\.[0-9a-z]+$/i
const STORE_FILE = /^agent-board_.+\.json$/i
// An inbox file the drain gave up on: `<name>.failed`, then `.failed.1`, `.failed.2`, ...
const FAILED = /\.failed(?:\.\d+)?$/

export const staleStoreTemps = (entries: readonly ListedFile[], now: number): string[] =>
  entries.filter(entry => entry.kind === 'file' && STORE_TEMP.test(entry.name) && now - entry.mtimeMs > RETENTION.storeTempMs).map(entry => entry.name)

// The temporary copy a reporter leaves in the inbox when it is cut off: every reporter (sh,
// PowerShell, the opencode plugin) writes a turn to `<turn name>.tmp` and then moves it to
// `<turn name>.json`, and one that kept the name `<turn name>.json.tmp` is the same thing. A
// reporter is done in seconds, so one a day old is a partial write that the drain skips. The sh and
// PowerShell reporters remove their scratch files a minute old themselves; an inbox only the
// OpenCode and OpenClaw plugins write to has no other cleanup. Never a turn (`.json`), a prompt
// receipt, a file a session has taken or one set aside (`.failed`).
const INBOX_TEMP = /\.tmp$/

export const staleInboxTemps = (entries: readonly ListedFile[], now: number): string[] =>
  entries.filter(entry => entry.kind === 'file' && INBOX_TEMP.test(entry.name) && now - entry.mtimeMs > RETENTION.storeTempMs).map(entry => entry.name)

const failedNames = (entries: readonly ListedFile[]): string[] => entries.filter(entry => entry.kind === 'file' && FAILED.test(entry.name)).map(entry => entry.name)

// A file set aside is kept 7 days from when that was done (`setAside`, by name), never from its
// own date: a rename keeps the file's time, and one that waited a week before it was found broken
// is still kept a week after. A name with no time recorded is not swept; `unseenFailedInbox` names
// it so the sweep records when it first saw it.
export const staleFailedInbox = (entries: readonly ListedFile[], now: number, setAside: Readonly<Record<string, number>>): string[] =>
  failedNames(entries).filter(name => {
    const since = setAside[name]
    return since !== undefined && now - since > RETENTION.failedInboxMs
  })

export const unseenFailedInbox = (entries: readonly ListedFile[], setAside: Readonly<Record<string, number>>): string[] =>
  failedNames(entries).filter(name => setAside[name] === undefined)

// The turns the inbox's writers removed unread, from the lines they add to `dropped.log` in the
// inbox (INBOX_DROPPED_FILE in hook-reporters.ts): `<UTC time> <count> <reason>`, the reason `age`
// (a turn file over 2 days old) or `cap` (past 1000 files or 1.5 MB). Sums what was removed at or
// after `since`; a line that does not read is skipped, not counted.
const DROPPED_LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) (\d+) (age|cap)$/

export const inboxDropped = (text: string, since: number): { age: number; cap: number } => {
  const sums = { age: 0, cap: 0 }
  for (const line of text.split('\n')) {
    const found = DROPPED_LINE.exec(line.replace(/\r$/, ''))
    if (found === null) continue
    const at = Date.parse(found[1] ?? '')
    if (Number.isNaN(at) || at < since) continue
    sums[found[3] === 'age' ? 'age' : 'cap'] += Number(found[2])
  }

  return sums
}

// What one record adds to the store file: its key and its value as JSON, and the punctuation
// around them. The file is measured as a whole, so this only has to be close; the next sweep
// measures it again.
export const recordBytes = (key: string, value: unknown): number => key.length + (JSON.stringify(value) ?? '').length + 4

export type StoreRecord = { key: string; value: unknown }

const updatedOf = (value: unknown): number => {
  const stamp = fieldOf(value, 'updated')
  return typeof stamp === 'number' ? stamp : 0
}

// The hard cap on the store (#373). When the age rules leave it at or over `cap`, the oldest
// `agent:` and `mirror:` records of ended or done sessions go, oldest write first, until the
// bytes left are under the cap. Only this board's records go (`board`): one with another board's
// tag, or with none, is removed only after 30 days whatever its state. A record whose block is on
// the board stays, and so does a mirror with open steps of a session on the board: if that is not
// enough the store stays over the cap and the board says so. `size` is the store file's bytes
// after the age rules removed what they did.
export const overCapKeys = (records: readonly StoreRecord[], isOnBoard: (key: string) => boolean, size: number, board: string, cap: number = RETENTION.storeCapBytes): string[] => {
  if (size < cap) return []
  const oldest = records
    .filter(one => (one.key.startsWith('agent:') || one.key.startsWith('mirror:')) && isEnded(one.value) && tagOf(one.value) === board && !isOnBoard(one.key))
    .sort((a, b) => updatedOf(a.value) - updatedOf(b.value) || (a.key < b.key ? -1 : 1))
  const keys: string[] = []
  let left = size
  for (const one of oldest) {
    if (left < cap) break
    keys.push(one.key)
    left -= recordBytes(one.key, one.value)
  }

  return keys
}

// What the board cleared, by kind: `agent:` records, `mirror:` records (a session's saved task
// list), and the inbox turns its writers dropped.
export type Pruned = { agent: number; mirror: number }

// The records removed, by kind, from the keys that went.
export const countPruned = (keys: readonly string[]): Pruned => ({
  agent: keys.filter(key => key.startsWith('agent:')).length,
  mirror: keys.filter(key => key.startsWith('mirror:')).length,
})

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)
const DAY_KEY = /^\d{4}-\d\d-\d\d$/
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

// The first moment of the days the board speaks of: today and the six days before it, by UTC day.
export const prunedSince = (now: number): number => Date.parse(`${dayOf(now - (RETENTION.prunedDays - 1) * DAY)}T00:00:00Z`)

// The counts kept in the store, one entry per UTC day (`{ '2026-10-22': { agent: 3, mirror: 1 } }`).
// Only the last 7 days are kept, and an entry that does not read is let go, so the value stays small.
const prunedByDay = (value: unknown, now: number): Record<string, Pruned> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const since = prunedSince(now)
  const days: Record<string, Pruned> = {}
  for (const [day, counts] of Object.entries(value)) {
    const agent = fieldOf(counts, 'agent')
    const mirror = fieldOf(counts, 'mirror')
    if (!DAY_KEY.test(day) || Date.parse(`${day}T00:00:00Z`) < since || !isCount(agent) || !isCount(mirror)) continue
    days[day] = { agent, mirror }
  }

  return days
}

// The stored counts with today's removals added, and days past the window dropped.
export const addPruned = (value: unknown, removed: Pruned, now: number): Record<string, Pruned> => {
  const days = prunedByDay(value, now)
  const today = days[dayOf(now)] ?? { agent: 0, mirror: 0 }

  return { ...days, [dayOf(now)]: { agent: today.agent + removed.agent, mirror: today.mirror + removed.mirror } }
}

// What the stored counts add up to over the days the board speaks of.
export const prunedTotal = (value: unknown, now: number): Pruned =>
  Object.values(prunedByDay(value, now)).reduce((sum, one) => ({ agent: sum.agent + one.agent, mirror: sum.mirror + one.mirror }), { agent: 0, mirror: 0 })

// The one line the board shows when it cleared something, or null when it did not.
export const prunedNote = (counts: Pruned & { turns: number }, s: Strings = ZH_TW): string | null => {
  const parts = [
    ...(counts.agent > 0 ? [s.prunedAgents(counts.agent)] : []),
    ...(counts.mirror > 0 ? [s.prunedSessions(counts.mirror)] : []),
    ...(counts.turns > 0 ? [s.prunedTurns(counts.turns)] : []),
  ]

  return parts.length === 0 ? null : s.prunedLine(s.prunedJoin(parts), RETENTION.prunedDays)
}

// The plugin's store file. A development copy of the plugin keeps a second one beside it, so the
// largest is the one measured.
export const storeBytes = (entries: readonly ListedFile[]): number =>
  Math.max(0, ...entries.filter(entry => entry.kind === 'file' && STORE_FILE.test(entry.name)).map(entry => entry.size))

// Part 1 is the month's file as it always was; later parts add `-2`, `-3`, ...
export const monthPart = (base: string, part: number): string => (part <= 1 ? base : base.replace(/(\.md)?$/i, `-${part}$1`))

// The part new lines go to: the first one under the size limit. `sizeOf` gives a part's size,
// or null when it is not there.
export const currentPart = (base: string, sizeOf: (path: string) => number | null, limit: number = RETENTION.monthPartBytes): string => {
  for (let part = 1; ; part += 1) {
    const path = monthPart(base, part)
    const size = sizeOf(path)
    if (size === null || size < limit) return path
  }
}

// Every part that is there, oldest first, for a reader that wants the whole month.
export const monthParts = (base: string, isThere: (path: string) => boolean): string[] => {
  const parts: string[] = []
  for (let part = 1; isThere(monthPart(base, part)); part += 1) parts.push(monthPart(base, part))
  return parts
}

// The host reads files asynchronously. Cache each answer so it uses the same part choices as
// the CLI, without reading a file twice. A missing part is kept as null for both readers.
export const readMonthParts = async (base: string, sizeOf: (path: string) => Promise<number | null>): Promise<Map<string, number | null>> => {
  const sizes = new Map<string, number | null>()
  let path = base
  for (;;) {
    sizes.set(path, await sizeOf(path))
    const next = currentPart(base, file => sizes.get(file) ?? null)
    if (next === path) return sizes
    path = next
  }
}

// What the board says when a file passes its size limit: it keeps everything the person wrote.
export const sizeWarnings = (sizes: { progress: number; store: number }, s: Strings = ZH_TW): string[] => [
  ...(sizes.progress > RETENTION.progressSoftBytes ? [s.progressLarge(Math.round(sizes.progress / KB), RETENTION.progressSoftBytes / KB)] : []),
  ...(sizes.store > RETENTION.storeWarnBytes ? [s.storeLarge((sizes.store / MB).toFixed(1), (RETENTION.storeCapBytes / MB).toFixed(1))] : []),
]

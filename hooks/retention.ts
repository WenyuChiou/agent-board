import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import type { ProgressProject } from '../types'

// How long the board keeps what it saves, and when one of its files is too big (#373). Every rule
// here removes only the board's own records and copies. A hand-kept task and a step that waits on
// the person are the person's own words: no size rule removes them, it only says so on the board.

const DAY = 24 * 60 * 60 * 1000
const KB = 1024
const MB = 1024 * KB

export const RETENTION = {
  // An agent session's record outlives its block: a stopped session's block goes to the archive
  // three days after it stopped, so its record is not needed after that.
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
  // Values read per pass over the store, so a pass costs the same on a store of any size.
  pruneReads: 20,
} as const

const PRUNABLE = ['agent:', 'mirror:', 'hinted:', 'done:', 'pendingInboxQuestion:']

export const isPrunableKey = (key: string): boolean => PRUNABLE.some(prefix => key.startsWith(prefix))

const fieldOf = (value: unknown, name: string): unknown => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined)

const isEnded = (value: unknown): boolean => fieldOf(value, 'state') === 'done' || fieldOf(value, 'state') === 'ended'

const hasOpenSteps = (value: unknown): boolean => {
  const tasks = fieldOf(value, 'tasks')
  return Array.isArray(tasks) && tasks.some(task => fieldOf(task, 'status') !== 'completed')
}

// How long a record is kept after it was last written, or null for one that never ages.
export const recordLife = (key: string, value: unknown): number | null => {
  if (key.startsWith('agent:')) return isEnded(value) ? RETENTION.endedAgentMs : RETENTION.agentMs
  if (key.startsWith('mirror:')) return hasOpenSteps(value) ? RETENTION.openMirrorMs : RETENTION.endedMirrorMs
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

// A record with no time of its own (an old shape, a broken value) is as old as can be.
export const isExpiredRecord = (key: string, value: unknown, now: number): boolean => {
  const life = recordLife(key, value)
  if (life === null) return false
  const stamp = typeof value === 'number' ? value : fieldOf(value, key.startsWith('pendingInboxQuestion:') ? 'at' : 'updated')
  return typeof stamp !== 'number' || now - stamp > life
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

// A file keeps its own time when it is renamed, so one set aside goes by when that was done
// (`setAside`, by name) when that is later: an inbox file that waited a week before it was
// found broken is still kept a week after.
export const staleFailedInbox = (entries: readonly ListedFile[], now: number, setAside: Readonly<Record<string, number>> = {}): string[] =>
  entries.filter(entry => entry.kind === 'file' && FAILED.test(entry.name) && now - Math.max(entry.mtimeMs, setAside[entry.name] ?? 0) > RETENTION.failedInboxMs).map(entry => entry.name)

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

// What the board says when a file passes its size limit: it keeps everything the person wrote.
export const sizeWarnings = (sizes: { progress: number; store: number }, s: Strings = ZH_TW): string[] => [
  ...(sizes.progress > RETENTION.progressSoftBytes ? [s.progressLarge(Math.round(sizes.progress / KB), RETENTION.progressSoftBytes / KB)] : []),
  ...(sizes.store > RETENTION.storeWarnBytes ? [s.storeLarge((sizes.store / MB).toFixed(1), (RETENTION.storeCapBytes / MB).toFixed(1))] : []),
]

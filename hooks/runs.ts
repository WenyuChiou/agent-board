import type { ProgressAuto, ProgressMirror, ProgressProject, ProgressTask } from '../types'
import { RESUME, STALE_MS } from './parse'

// Only a conversation a person started is a row (#399). A run an agent started for itself (a
// delegate's one-shot, a helper thread, a subagent) joins the row of the session that started it
// as one line, or is counted on the folded "Background runs" line when no session is known.
// Everything here is pure: the writers decide what a host's signals mean, the readers fold.

export type RunGroup = { count: number; agents: string[]; last: number }

export type Folded = {
  // The projects without any run and without the older block of a twin pair; tasks keep their
  // identity, so a caller finds a parent's group by the task itself.
  projects: ProgressProject[]
  // The runs of each person's session, by that session's task.
  runs: Map<ProgressTask, RunGroup>
  // Runs whose session is not known (none named, or gone from the file).
  background: RunGroup | null
  // The older block of two that carry one agent and one full session id: one row shows, this one
  // is offered for archive.
  duplicates: Array<{ project: ProgressProject; task: ProgressTask }>
}

type Entry = { project: ProgressProject; task: ProgressTask; auto: ProgressAuto; order: number }

const MAX_HOPS = 8

const sessionKey = (auto: ProgressAuto): string | null => (auto.resume === null ? null : `${auto.agent}\u0000${auto.resume}`)

// The key two blocks of one session share (agent and full id), for a reader that holds a block's
// saved copy instead of the block.
export const sessionIdentity = sessionKey

// Who started a run whose own block may be gone: its saved marker names a parent, and the parent is
// followed through the runs still on the board to the first block that is not a run (#399). Null
// when none is named, it is not on the board, the chain loops or is longer than eight hops. The
// kept question of an archived run is listed under that session's agent, as a live run's folds
// into that session's row.
export const startersOf = (projects: readonly ProgressProject[]): ((auto: ProgressAuto) => ProgressAuto | null) => {
  const blocks = projects.flatMap(project => project.tasks.flatMap(task => task.auto === null ? [] : [task.auto]))
  const byId = new Map<string, ProgressAuto>()
  // A person's block wins an id shared with a run, just as it does in the live fold.
  for (const auto of [...blocks.filter(auto => auto.isRun !== true), ...blocks.filter(auto => auto.isRun === true)]) {
    for (const id of [auto.resume, auto.session]) {
      if (id !== null && !byId.has(id)) byId.set(id, auto)
    }
  }

  return auto => {
    let at = auto
    const seen = new Set([auto])
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const next = at.parent === undefined ? undefined : byId.get(at.parent)
      if (next === undefined || seen.has(next)) return null
      if (next.isRun !== true) return next
      seen.add(next)
      at = next
    }

    return null
  }
}

const isAfter = (a: Entry, b: Entry): boolean =>
  a.auto.updated !== b.auto.updated ? a.auto.updated > b.auto.updated : a.order > b.order

const tally = (): { add: (agent: string, at: number) => void; done: () => RunGroup } => {
  const counts = new Map<string, number>()
  let count = 0
  let last = 0

  return {
    add: (agent, at) => {
      counts.set(agent, (counts.get(agent) ?? 0) + 1)
      count += 1
      last = Math.max(last, at)
    },
    // The agent that ran most comes first; equal counts keep their name order.
    done: () => ({ count, agents: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([agent]) => agent), last }),
  }
}

// Runs of a parent whose row is not drawn are counted with the background runs.
export const mergeGroups = (a: RunGroup | null, b: RunGroup): RunGroup =>
  a === null ? b : { count: a.count + b.count, agents: [...new Set([...a.agents, ...b.agents])], last: Math.max(a.last, b.last) }

export const foldRuns = (projects: readonly ProgressProject[]): Folded => {
  const entries: Entry[] = []
  let order = 0
  for (const project of projects) {
    for (const task of project.tasks) {
      order += 1
      if (task.auto !== null) entries.push({ project, task, auto: task.auto, order })
    }
  }
  // Two blocks of one agent and one full session id are one session: the newest write wins. A
  // run mark on either makes the session a run, so a reporter with no signal cannot hide it.
  const winners = new Map<string, Entry>()
  const runKeys = new Set<string>()
  const parents = new Map<string, string>()
  for (const entry of entries) {
    const key = sessionKey(entry.auto)
    if (key === null) continue
    if (entry.auto.isRun === true) runKeys.add(key)
    if (entry.auto.parent !== undefined && !parents.has(key)) parents.set(key, entry.auto.parent)
    const held = winners.get(key)
    if (held === undefined || isAfter(entry, held)) winners.set(key, entry)
  }
  const isLoser = (entry: Entry): boolean => {
    const key = sessionKey(entry.auto)

    return key !== null && winners.get(key) !== entry
  }
  const isRun = (entry: Entry): boolean => {
    const key = sessionKey(entry.auto)

    return entry.auto.isRun === true || key !== null && runKeys.has(key)
  }
  const parentOf = (entry: Entry): string | undefined => {
    const key = sessionKey(entry.auto)

    return entry.auto.parent ?? (key === null ? undefined : parents.get(key))
  }
  // A parent is named by the full id (`resume`) or the block id (`session`). A person's block is
  // indexed before a run's, so an id two blocks share names the person's.
  const kept = entries.filter(entry => !isLoser(entry))
  const byId = new Map<string, Entry>()
  for (const entry of [...kept.filter(entry => !isRun(entry)), ...kept.filter(isRun)]) {
    for (const id of [entry.auto.resume, entry.auto.session]) {
      if (id !== null && !byId.has(id)) byId.set(id, entry)
    }
  }
  const rootOf = (entry: Entry): Entry | null => {
    let at = entry
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const id = parentOf(at)
      const next = id === undefined ? undefined : byId.get(id)
      if (next === undefined || next === at) return null
      if (!isRun(next)) return next
      at = next
    }

    return null
  }

  const groups = new Map<ProgressTask, ReturnType<typeof tally>>()
  const background = tally()
  let hasBackground = false
  const gone = new Set<ProgressTask>()
  const duplicates: Folded['duplicates'] = []
  for (const entry of entries) {
    if (isLoser(entry)) {
      gone.add(entry.task)
      if (!isRun(entry)) duplicates.push({ project: entry.project, task: entry.task })
      continue
    }
    if (!isRun(entry)) continue
    gone.add(entry.task)
    const root = rootOf(entry)
    if (root === null) {
      background.add(entry.auto.agent, entry.auto.updated)
      hasBackground = true
      continue
    }
    const group = groups.get(root.task) ?? tally()
    group.add(entry.auto.agent, entry.auto.updated)
    groups.set(root.task, group)
  }

  return {
    projects: gone.size === 0 ? [...projects] : projects.map(project => ({ ...project, tasks: project.tasks.filter(task => !gone.has(task)) })),
    runs: new Map([...groups].map(([task, group]) => [task, group.done()])),
    background: hasBackground ? background.done() : null,
    duplicates,
  }
}

// Whether a newer block carries the same agent and full session id. The archive of a twin is
// checked again at the write, against the file as it is then.
export const isOutranked = (tasks: readonly ProgressTask[], task: ProgressTask): boolean => {
  const auto = task.auto
  if (auto === null || auto.resume === null) return false

  return tasks.some(other =>
    other !== task && other.auto !== null && other.auto.agent === auto.agent && other.auto.resume === auto.resume &&
    (other.auto.updated > auto.updated || other.auto.updated === auto.updated && other.line > task.line),
  )
}

// A writer that knows a run but not who started it names the person's session that is working in
// the same project right now, but only when there is exactly one (#399). With none, or with two or
// more, it names nothing: the newer of two could be the wrong one, and a run with no known parent
// is counted as a background run. Two blocks with one full session id are one session, and when
// either is marked a run the session is a run, as in the fold. `self` lists the ids the run itself
// goes by, so it never names its own earlier block.
export const pickParent = (projects: readonly ProgressProject[], project: string, now: number, self: readonly string[] = []): string | null => {
  const name = project.trim().toLowerCase()
  if (name === '') return null
  const runs = new Set<string>()
  for (const one of projects) for (const task of one.tasks) if (task.auto?.isRun === true) runs.add(task.auto.resume ?? task.auto.session)
  const found = new Set<string>()
  for (const one of projects) {
    if (one.name.trim().toLowerCase() !== name) continue
    for (const task of one.tasks) {
      const auto = task.auto
      if (auto === null || auto.isRun === true || auto.state !== 'working' || now - auto.updated > STALE_MS) continue
      if (self.includes(auto.session) || auto.resume !== null && self.includes(auto.resume)) continue
      const id = auto.resume ?? auto.session
      if (!runs.has(id)) found.add(id)
    }
  }

  return found.size === 1 ? [...found][0] ?? null : null
}

export type RunOrigin = 'run' | 'person'
// `isWeak`: the host gave a hint, not a statement (whether a session has a history file).
export type RunSignal = { origin: RunOrigin; parent?: string; isWeak?: true }

// The few fields of a Codex session's first record (`session_meta`) that say who started it. The
// reader that opens the file hands over these and nothing else of it.
export type CodexMeta = { originator?: unknown; source?: unknown; thread_source?: unknown; parent_thread_id?: unknown }

// `codex exec`, the SDK and the MCP server are programs calling Codex; the terminal and the app
// are people. An originator not listed here is taken for a person: a wrong guess shows a row.
const PROGRAM_ORIGINATOR = /^codex[_-](?:exec|sdk|mcp)/i

// What a Codex hook's own words say about who started the session (#399). `meta` is the session
// record's first line, null when it could not be read. `path` is the hook's `transcript_path`
// (`hasPath` false when the host sent none, so an older Codex gives no hint at all).
export const codexSignal = (hasPath: boolean, path: unknown, meta: CodexMeta | null): RunSignal | undefined => {
  if (meta !== null) {
    const parent = typeof meta.parent_thread_id === 'string' && RESUME.test(meta.parent_thread_id) ? meta.parent_thread_id : undefined
    const threadSource = typeof meta.thread_source === 'string' ? meta.thread_source : undefined
    const originator = typeof meta.originator === 'string' ? meta.originator : undefined
    const isSubagent = typeof meta.source === 'object' && meta.source !== null && 'subagent' in meta.source
    if (parent !== undefined || isSubagent || meta.source === 'exec' || threadSource !== undefined && threadSource !== 'user' || originator !== undefined && PROGRAM_ORIGINATOR.test(originator)) {
      return { origin: 'run', ...(parent === undefined ? {} : { parent }) }
    }

    return threadSource === 'user' || originator !== undefined ? { origin: 'person' } : undefined
  }

  // A session that keeps no history file is a short-lived helper. Only a hint: a real
  // conversation has none until its first message, and any later event with a file replaces it.
  if (!hasPath) return undefined

  return path === null || path === '' ? { origin: 'run', isWeak: true } : { origin: 'person', isWeak: true }
}

// A stored or queued signal is data from a file: keep only what a signal can be.
export const cleanSignal = (value: unknown): RunSignal | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const one = value as { origin?: unknown; parent?: unknown; isWeak?: unknown }
  if (one.origin !== 'run' && one.origin !== 'person') return undefined
  const parent = one.origin === 'run' && typeof one.parent === 'string' && RESUME.test(one.parent) ? one.parent : undefined

  return { origin: one.origin, ...(parent === undefined ? {} : { parent }), ...(one.isWeak === true ? { isWeak: true as const } : {}) }
}

export type Origin = { origin?: RunOrigin; parent?: string; isWeak?: true }

// What a session record keeps after one more event. A statement replaces what was kept; a hint
// replaces only a hint, so a host's plain word is never undone by a guess.
export const withSignal = (kept: Origin | null | undefined, seen: RunSignal | undefined): Origin => {
  const before: Origin = {
    ...(kept?.origin === undefined ? {} : { origin: kept.origin }),
    ...(kept?.parent === undefined ? {} : { parent: kept.parent }),
    ...(kept?.isWeak === true ? { isWeak: true as const } : {}),
  }
  if (seen === undefined || seen.isWeak === true && kept?.origin !== undefined && kept.isWeak !== true) return before
  const parent = seen.origin === 'run' ? seen.parent ?? (kept?.origin === 'run' ? kept.parent : undefined) : undefined

  return { origin: seen.origin, ...(parent === undefined ? {} : { parent }), ...(seen.isWeak === true ? { isWeak: true as const } : {}) }
}

// The mark on Claude's own mirror: a print-mode session is a run an agent started, an
// interactive one is a person's, whatever an earlier mode left in a stored mirror.
export const withRunMark = (mirror: ProgressMirror, isRun: boolean): ProgressMirror => {
  const { isRun: _isRun, ...rest } = mirror

  return isRun ? { ...rest, isRun: true } : rest
}

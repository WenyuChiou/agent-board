import { AGENT_ICONS } from './agent-icons'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import type { ServeAsk, ServeModel, ServeRetained, ServeRow, ServeTurn } from './serve'
import { agentLabel } from './strings'

// The board sorted by agent (#476): one group per agent with its counts and lists, one Needs you
// list across all of them, what is working now, every agent's rows together, the person's own
// tasks, and one project per repository. It is the data the page draws (#477); nothing here
// reads a file, the clock, the process or the network, so a big board is tested without a page.
// `now` and `repoOf` come from the caller. The order is stable: sorting uses time only, never
// text, and equal times keep the order of the input.

// What the page adds when it builds the model (#477). The model on main carries none of it yet,
// so each field is optional: a missing time, folder or session reads as unknown, and a missing
// run, stuck or unreadable mark reads as "no". The module invents no rule for any of them.
// The page fills: `at` on rows, asks, older questions, turns and finished tasks; `dir`; `isRun`
// and `parent`; `sessionId` and `stuck` on rows; `agents` with `unreadable`; `agent` and `isOwn`
// on finished tasks; and `finished` with each task's `key`.
export type Extra = {
  // When it last moved, in epoch milliseconds. A time after `now` reads as `now`.
  at?: number
  // The folder its block ran in (`dir=`).
  dir?: string | null
  // A run an agent started for itself (#399), and the id (full or block) of the session that started it.
  isRun?: true
  parent?: string
}

export type GroupingRow = ServeRow & Extra & {
  // Its session's own id, as a question has it, so a run can name this row's session as its starter.
  sessionId?: string | null
  stuck?: { reason: string }
}
export type GroupingAsk = ServeAsk & Extra
export type GroupingRetained = ServeRetained & Extra
export type GroupingTurn = ServeTurn & Extra
// A finished task has neither a key nor an agent in the model. A missing agent is not Claude Code
// (the producer does not say whose task it was): it counts in All only, under no agent. '' is
// Claude Code's own wire value. `key` is the key of the stopped row the task came from.
export type GroupingDone = ServeModel['recent'][number] & Extra & { agent?: string; isOwn?: true; key?: string }

// A `ServeModel` fits this: it is the part of the model that is read.
export type GroupingInput = {
  asks: readonly GroupingAsk[]
  reminder: readonly GroupingRetained[]
  older: readonly GroupingRetained[]
  idle: readonly GroupingRow[]
  stopped: readonly GroupingRow[]
  groups: ReadonlyArray<{ project: string; rows: readonly GroupingRow[] }>
  turns: readonly GroupingTurn[]
  // At most three, as the producer caps it; Done reads it only when `finished` is missing.
  recent: readonly GroupingDone[]
  // The week's finished tasks with no cap. When given, they are the only source of Done, and a
  // finished task is not also on the stopped shelf (the producer moves all but three there).
  finished?: readonly GroupingDone[]
  // Agents, with the mark for those whose progress file could not be read. An agent with the mark
  // has a group even with no task.
  agents?: ReadonlyArray<{ agent: string; unreadable?: true }>
}

// The repository a folder belongs to, or nothing when it is not one the caller knows.
export type RepoOf = (dir: string) => string | null | undefined

// Every row and question carries these.
export type Tagged = {
  // `claude` for Claude Code, the lower-cased id otherwise, '' for a hand-kept task (`isOwn`)
  // or for a finished task whose agent the model did not say.
  agent: string
  isOwn: boolean
  // The heading it sits under, and the repository it belongs to.
  project: string
  repo: string
  // When it last moved, in epoch milliseconds; 0 when unknown.
  at: number
}

export type GroupedTask = Tagged & {
  key: string
  title: string
  shelf: 'open' | 'stopped' | 'done'
  // On the stopped shelf because nothing moved for seven days, not because its session stopped.
  isIdle: boolean
  // A question card or a stuck card stands for it, so the Open list leaves it out.
  hasCard: boolean
  source: GroupingRow | GroupingDone | GroupingAsk
}

export type GroupedQuestion = Tagged & {
  key: string
  task: string
  text: string
  // `pending` is a card; the other two are the older line.
  stage: 'pending' | 'reminder' | 'older'
  source: GroupingAsk | GroupingRetained | GroupingTurn
}

export type StuckCard = Tagged & { key: string; task: string; reason: string; source: GroupingRow }

export type Card = (GroupedQuestion & { type: 'question' }) | (StuckCard & { type: 'stuck' })

// `open` counts every working, waiting and quiet task, a carded one too; its list leaves the
// carded ones out. `needs` is the cards. `stopped` includes tasks that nothing moved in for a week.
export type Counts = { open: number; needs: number; stopped: number; done: number; older: number }

export type Lists = {
  // Newest first.
  cards: Card[]
  open: GroupedTask[]
  stopped: GroupedTask[]
  done: GroupedTask[]
  older: GroupedQuestion[]
}

export type Bucket = Lists & { counts: Counts }

export type AgentGroup = Bucket & {
  agent: string
  // The brand name, else the id as written.
  name: string
  // The icon's file name in `AGENT_ICONS`, else `letter:` and the first letter, for a tile.
  icon: string
  // The latest time any of its rows or questions moved; 0 when none has a time.
  last: number
  isUnreadable: boolean
}

export type NeedsYou = {
  // Questions plus stuck tasks. Older questions are not in it.
  n: number
  questions: number
  stuck: number
  cards: Card[]
  older: GroupedQuestion[]
}

export type Grouping = {
  // Most recent activity first, worked out once from the input.
  agents: AgentGroup[]
  needs: NeedsYou
  working: GroupedTask[]
  // Every agent's rows, not the hand-kept ones. Hidden below two agents.
  all: Bucket & { isHidden: boolean }
  own: Bucket
  projects: Array<{ name: string; open: number }>
}

export const WORKING_MS = 30 * 60 * 1000
export const DONE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_HOPS = 8

// An agent's file name and its first word both name its icon, as the page's marks do.
const ICONS: ReadonlyMap<string, string> = new Map(
  AGENT_ICONS.flatMap((icon): Array<[string, string]> => [[icon.file, icon.file], [icon.file.split('-')[0] ?? icon.file, icon.file]]),
)

const keyOf = (agent: string): string => agent.trim().toLowerCase() || 'claude'

const iconOf = (agent: string): string => {
  const first = agent.split(/\s+/)[0] ?? agent

  return ICONS.get(first) ?? `letter:${(Array.from(first)[0] ?? '?').toUpperCase()}`
}

const plain = (text: string): string => text.trim().replace(/\s+/g, ' ')

// The folder's own name, for a folder `repoOf` does not know. A drive alone names nothing.
const folderName = (dir: string): string => {
  const last = dir.split(/[\\/]+/).filter(part => part !== '').pop() ?? ''

  return /^[A-Za-z]:$/.test(last) ? '' : last
}

const newestFirst = <T extends { at: number }>(list: readonly T[]): T[] =>
  list.map((item, index) => ({ item, index })).sort((a, b) => b.item.at - a.item.at || a.index - b.index).map(one => one.item)

type Holder = { agent: string; isOwn: boolean; isRun: boolean; parent: string | undefined }

type Asker = { agent: string; isOwn?: true; isRun?: true; parent?: string }

const holderOf = (item: Asker): Holder => ({ agent: item.agent, isOwn: item.isOwn === true, isRun: item.isRun === true, parent: item.parent })

const identity = (agent: string, isOwn: boolean, project: string, title: string): string => JSON.stringify([isOwn ? '' : keyOf(agent), project, title])

// Whether a stopped row is the one a finished task came from, when the task has no key: the task
// says whose it was, or nothing, and then any agent's row fits.
const isHers = (item: GroupingDone, row: GroupingRow): boolean =>
  item.isOwn === true ? row.isOwn === true : item.agent === undefined || (row.isOwn !== true && keyOf(row.agent) === keyOf(item.agent))

export const groupBoard = (model: GroupingInput, now: number, repoOf: RepoOf, s: Strings = ZH_TW): Grouping => {
  const folders = new Map<string, string>()
  const repoName = (project: string, dir: string | null | undefined): string => {
    if (dir === undefined || dir === null || dir.trim() === '') return project
    let name = folders.get(dir)
    if (name === undefined) {
      name = repoOf(dir) || folderName(dir)
      folders.set(dir, name)
    }

    return name || project
  }
  const isKnown = (at: number | undefined): at is number => at !== undefined && Number.isFinite(at) && at > 0
  const timeOf = (at: number | undefined): number => (isKnown(at) ? Math.min(at, now) : 0)

  // Agents in the order the input first names them (questions, older questions, rows, finished
  // tasks, then the unreadable marks), with the way each was first written.
  const spelled = new Map<string, string>()
  const note = (agent: string): string => {
    const key = keyOf(agent)
    if (!spelled.has(key)) spelled.set(key, agent.trim() || 'claude')

    return key
  }
  const tag = (owner: { agent: string; isOwn: boolean }, project: string, dir: string | null | undefined, at: number | undefined): Tagged => ({
    agent: owner.isOwn ? '' : note(owner.agent),
    isOwn: owner.isOwn,
    project,
    repo: repoName(project, dir),
    at: timeOf(at),
  })

  const rows: Array<{ row: GroupingRow; shelf: 'open' | 'stopped'; isIdle: boolean }> = [
    ...model.idle.map(row => ({ row, shelf: 'stopped' as const, isIdle: true })),
    ...model.stopped.map(row => ({ row, shelf: 'stopped' as const, isIdle: false })),
    ...model.groups.flatMap(group => group.rows.map(row => ({ row, shelf: 'open' as const, isIdle: false }))),
  ]
  // A run names the session that started it by its full id or its block id. A person's session
  // is indexed before a run, so an id both carry names the person's.
  const holders = new Map<string, Holder>()
  const named: Array<{ ids: ReadonlyArray<string | null | undefined>; holder: Holder }> = [
    ...model.asks.map(ask => ({ ids: [ask.session, ask.sessionId], holder: holderOf(ask) })),
    ...rows.map(({ row }) => ({ ids: [row.session, row.sessionId], holder: holderOf(row) })),
  ]
  for (const isRun of [false, true]) {
    for (const { ids, holder } of named) {
      if (holder.isRun !== isRun) continue
      for (const id of ids) if (id !== undefined && id !== null && id !== '' && !holders.has(id)) holders.set(id, holder)
    }
  }
  // A question of a run belongs to the agent of the session that started it. When no person's
  // session is found up the chain, it stays with the agent that asked.
  const ownerOf = (asker: Asker): { agent: string; isOwn: boolean } => {
    const own = holderOf(asker)
    let at = own
    for (let hop = 0; hop < MAX_HOPS && at.isRun && at.parent !== undefined; hop += 1) {
      const next = holders.get(at.parent)
      if (next === undefined) break
      at = next
    }

    return at.isRun ? own : at
  }

  // Questions. The same words under one task, in two blocks, are one question: the newest stays
  // where the first stood, and a pending question keeps an older copy of itself off the older line.
  const listed = new Map<string, { list: GroupedQuestion[]; index: number }>()
  const list = (question: GroupedQuestion, into: GroupedQuestion[]): void => {
    const id = JSON.stringify([question.agent, question.project, question.task, plain(question.text)])
    const held = listed.get(id)
    if (held === undefined) {
      listed.set(id, { list: into, index: into.length })
      into.push(question)
    } else if (held.list === into && question.at > (held.list[held.index]?.at ?? 0)) held.list[held.index] = question
  }
  const pending: GroupedQuestion[] = []
  const older: GroupedQuestion[] = []
  const carded = new Set<string>()
  for (const ask of model.asks) {
    list({ ...tag(ownerOf(ask), ask.project, ask.dir, ask.at), key: ask.key, task: ask.task, text: ask.text, stage: 'pending', source: ask }, pending)
    carded.add(identity(ask.agent, ask.isOwn === true, ask.project, ask.task))
  }
  for (const turn of model.turns) {
    if (turn.isQuestion) list({ ...tag(ownerOf(turn), turn.project, turn.dir, turn.at), key: turn.key, task: '', text: turn.text, stage: 'pending', source: turn }, pending)
  }
  const retained = [...model.reminder.map(item => ({ item, stage: 'reminder' as const })), ...model.older.map(item => ({ item, stage: 'older' as const }))]
  for (const { item, stage } of retained) {
    list({ ...tag(ownerOf(item), item.project, item.dir, item.at), key: item.key, task: item.task, text: item.text, stage, source: item }, older)
  }

  // A finished task is listed while it is within the week. The week's uncapped list is the source
  // when the page gives one; else it is `recent`, which the producer caps at three.
  const finished = (model.finished ?? model.recent).filter(item => item.isRun !== true && !(isKnown(item.at) && item.at < now - DONE_MS))
  // A finished task is Done and not also Stopped, so the stopped row it came from is left out: the
  // row with its key, else the first with the same heading and title. A task takes at most one
  // row, and a row goes once.
  const taken = new Set<number>()
  for (const item of finished) {
    const found = rows.findIndex(({ row, shelf }, index) => shelf === 'stopped' && row.isRun !== true && !taken.has(index) && (item.key !== undefined ? row.key === item.key : row.project === item.project && row.title === item.title && isHers(item, row)))
    if (found !== -1) taken.add(found)
  }

  // Tasks. A helper run is not a row. Stuck is only what the caller marked.
  const tasks: GroupedTask[] = []
  const stuck: Card[] = []
  const rowKeys = new Set<string>()
  const rowIds = new Set(rows.filter(({ row }) => row.isRun !== true).map(({ row }) => identity(row.agent, row.isOwn === true, row.project, row.title)))
  for (const [index, { row, shelf, isIdle }] of rows.entries()) {
    if (row.isRun === true || taken.has(index) || rowKeys.has(row.key)) continue
    rowKeys.add(row.key)
    const tagged = tag({ agent: row.agent, isOwn: row.isOwn === true }, row.project, row.dir, row.at)
    if (row.stuck !== undefined) stuck.push({ ...tagged, type: 'stuck', key: `stuck:${row.key}`, task: row.title, reason: row.stuck.reason, source: row })
    tasks.push({ ...tagged, key: row.key, title: row.title, shelf, isIdle, hasCard: row.stuck !== undefined || carded.has(identity(row.agent, row.isOwn === true, row.project, row.title)), source: row })
  }
  // The producer gives a task that waits on the person a question and no row. It is one open task
  // however many questions it has, and its card stands for it. A helper run's question is not a task.
  const waiting = new Map<string, { ask: GroupingAsk; at: number }>()
  for (const ask of model.asks) {
    const id = identity(ask.agent, ask.isOwn === true, ask.project, ask.task)
    if (ask.isRun === true || rowIds.has(id)) continue
    const held = waiting.get(id)
    if (held === undefined) waiting.set(id, { ask, at: timeOf(ask.at) })
    else held.at = Math.max(held.at, timeOf(ask.at))
  }
  for (const { ask, at } of waiting.values()) {
    const tagged = tag({ agent: ask.agent, isOwn: ask.isOwn === true }, ask.project, ask.dir, at)
    tasks.push({ ...tagged, key: `waiting:${tagged.agent}:${ask.project}::${ask.task}`, title: ask.task, shelf: 'open', isIdle: false, hasCard: true, source: ask })
  }
  // A finished task whose agent the model did not say is under no agent: it counts in All only.
  const repeats = new Map<string, number>()
  for (const item of finished) {
    const base = `done::${item.project}::${item.title}`
    const repeat = (repeats.get(base) ?? 0) + 1
    repeats.set(base, repeat)
    const tagged: Tagged =
      item.isOwn === true || item.agent !== undefined
        ? tag({ agent: item.agent ?? '', isOwn: item.isOwn === true }, item.project, item.dir, item.at)
        : { agent: '', isOwn: false, project: item.project, repo: repoName(item.project, item.dir), at: timeOf(item.at) }
    tasks.push({
      ...tagged,
      key: item.key ?? (repeat === 1 ? base : `${base}#${repeat}`),
      title: item.title,
      shelf: 'done',
      isIdle: false,
      hasCard: false,
      source: item,
    })
  }
  const unreadable = new Set<string>()
  // An unreadable agent has a group even with no task, so the page can say so; an agent listed
  // without the mark and without a task has none.
  for (const one of model.agents ?? []) if (one.unreadable === true) unreadable.add(note(one.agent))

  const sortedTasks = newestFirst(tasks)
  const cards: Card[] = newestFirst([...pending.map((question): Card => ({ ...question, type: 'question' })), ...stuck])
  const sortedOlder = newestFirst(older)
  const bucketOf = (pick: (one: Tagged) => boolean): Bucket => {
    const here = sortedTasks.filter(pick)
    const open = here.filter(task => task.shelf === 'open')
    const stopped = here.filter(task => task.shelf === 'stopped')
    const done = here.filter(task => task.shelf === 'done')
    const asking = cards.filter(pick)
    const back = sortedOlder.filter(pick)

    return {
      counts: { open: open.length, needs: asking.length, stopped: stopped.length, done: done.length, older: back.length },
      cards: asking,
      open: open.filter(task => !task.hasCard),
      stopped,
      done,
      older: back,
    }
  }

  const lastOf = new Map<string, number>()
  // A finished task under no agent sets nobody's time.
  for (const one of [...sortedTasks, ...cards, ...sortedOlder]) if (!one.isOwn && one.agent !== '') lastOf.set(one.agent, Math.max(lastOf.get(one.agent) ?? 0, one.at))
  const agents = [...spelled.keys()]
    .map((agent, index) => ({ agent, index, last: lastOf.get(agent) ?? 0 }))
    .sort((a, b) => b.last - a.last || a.index - b.index)
    .map(({ agent, last }): AgentGroup => ({
      ...bucketOf(one => !one.isOwn && one.agent === agent),
      agent,
      name: agentLabel(spelled.get(agent) ?? agent, s),
      icon: iconOf(agent),
      last,
      isUnreadable: unreadable.has(agent),
    }))

  // Projects are repositories: one with something open, or an unanswered question of any age.
  const projects = new Map<string, { name: string; open: number; at: number }>()
  const touch = (one: Tagged): { name: string; open: number; at: number } => {
    const held = projects.get(one.repo) ?? { name: one.repo, open: 0, at: 0 }
    held.at = Math.max(held.at, one.at)
    projects.set(one.repo, held)

    return held
  }
  for (const task of sortedTasks) if (task.shelf === 'open') touch(task).open += 1
  for (const one of [...cards, ...sortedOlder]) touch(one)

  return {
    agents,
    needs: {
      n: cards.length,
      questions: cards.filter(card => card.type === 'question').length,
      stuck: cards.filter(card => card.type === 'stuck').length,
      cards,
      older: sortedOlder,
    },
    // Rows that wait on the person are on the Needs you list, and a hand-kept task is not an agent at work.
    working: sortedTasks.filter(task => task.shelf === 'open' && !task.hasCard && !task.isOwn && task.at > 0 && now - task.at <= WORKING_MS),
    all: { ...bucketOf(one => !one.isOwn), isHidden: agents.length < 2 },
    own: bucketOf(one => one.isOwn),
    projects: newestFirst([...projects.values()]).map(({ name, open }) => ({ name, open })),
  }
}

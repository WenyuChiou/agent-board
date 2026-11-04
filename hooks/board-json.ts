import { clipped, plain, redact } from './board'
import type { PendingTurn } from './board'
import type { Lang, Strings } from './i18n'
import { serveModel } from './serve'
import type { GroupOptions, ServeAsk, ServeModel, ServeRow, ServeTurn } from './serve'
import type { View } from './view'

export const BOARD_JSON_SCHEMA = 1

type BoardNeed = {
  kind: 'question' | 'stuck' | 'task'
  agent: string
  project: string
  task: string
  text: string
  note: string | null
  options: string[]
  askedAt: string | null
  age: string
}

type BoardRow = {
  agent: string
  project: string
  title: string
  step: string | null
  done: number
  total: number
  updatedAt: string | null
  age: string
  isUnsure: boolean
}

export type BoardDocument = {
  schemaVersion: typeof BOARD_JSON_SCHEMA
  generatedAt: string
  lang: Lang
  counts: { needs: number; questions: number; stuck: number; working: number; waiting: number; stopped: number; doneRecently: number }
  needs: BoardNeed[]
  working: BoardRow[]
  waiting: BoardRow[]
  stopped: BoardRow[]
  doneRecently: Array<{ project: string; title: string; agent: string; age: string }>
  doneToday: string[]
  notices: string[]
}

type Ref = NonNullable<ServeModel['view']>['working'][number]
type Source = Partial<ServeAsk & ServeRow & ServeTurn>

export const boardDocument = (
  view: View,
  pending: readonly PendingTurn[],
  done: readonly string[],
  s: Strings,
  home: string,
  isWindows: boolean,
  now: number,
  group?: GroupOptions,
): BoardDocument => {
  const model = serveModel(view, pending, s, new Set(), false, undefined, false, group)
  // Callers without filesystem metadata still use the page's pure row grouping.
  const grouped = model.view === undefined ? serveModel(view, pending, s, new Set(), false, undefined, false, {
    now, repoOf: () => null, versions: { board: '', package: null }, unreadable: view.unreadable ?? [],
  }) : model
  const page = grouped.view!
  const clean = <T extends string>(text: T): T => redact(clipped(plain(text), home, isWindows), home, isWindows) as T
  const folder = home.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? ''
  const named = (project: string): string => clean(folder !== '' && (isWindows ? project.toLowerCase() === folder.toLowerCase() : project === folder) ? '~' : project)
  const iso = (at: number | undefined): string | null => {
    if (at === undefined || !Number.isFinite(at) || at <= 0) return null
    const date = new Date(at)

    return Number.isNaN(date.getTime()) ? null : clean(date.toISOString())
  }
  const sources = new Map<string, Source>()
  for (const one of [...grouped.asks, ...grouped.reminder, ...grouped.older, ...grouped.idle, ...grouped.stopped, ...grouped.groups.flatMap(one => one.rows), ...grouped.turns, ...grouped.recent, ...(grouped.finished ?? [])]) {
    if (one.key !== undefined) sources.set(one.key, { ...sources.get(one.key), ...one })
  }
  const source = (ref: Ref): Source => sources.get(ref.sourceKey ?? ref.key) ?? sources.get(ref.key.replace(/^stuck:/, '')) ?? {}
  const age = (ref: Ref): string => clean(source(ref).when || s.pgUnknownAge)
  const original = new Map([...view.due, ...view.groups.flatMap(one => one.rows), ...view.idle, ...view.stopped].map(row => [`row:${row.key}`, row]))
  const row = (ref: Ref): BoardRow => {
    const one = source(ref)
    const steps = one.steps ?? []
    const current = steps.find(step => step.isCurrent) ?? steps.find(step => step.status !== 'done' && step.status !== 'cancelled')

    return {
      agent: clean(ref.agent),
      project: named(ref.repo || one.project || ref.project),
      title: clean(one.title || one.task || one.text || ''),
      step: current === undefined ? null : clean(current.text),
      done: one.done ?? 0,
      total: one.total ?? 0,
      updatedAt: iso(one.at ?? ref.at),
      age: age(ref),
      // The page falls back to Unknown time; view.ts also labels a future clock.
      // It has no separate age cutoff for an "unsure" row.
      isUnsure: !one.when || one.when === s.pgUnknownAge || original.get(ref.sourceKey ?? ref.key)?.hasFutureTime === true,
    }
  }
  const needsRefs: Ref[] = group === undefined ? grouped.asks.map(ask => page.needs.cards.find(ref => ref.key === ask.key) ?? {
    key: ask.key, kind: 'question', agent: ask.agent, project: ask.project, repo: ask.project, at: ask.at ?? 0,
  }) : page.needs.cards
  const needs = needsRefs.map((ref): BoardNeed => {
    const one = source(ref)
    const isStuck = ref.kind === 'stuck'
    const note = isStuck ? one.stuck?.reason : one.note || one.context

    return {
      kind: clean(ref.kind),
      agent: clean(ref.agent),
      project: named(ref.repo || one.project || ref.project),
      task: clean(one.task || one.title || ''),
      text: clean(isStuck ? one.title || '' : one.text || ''),
      note: note ? clean(note) : null,
      options: (isStuck ? [] : one.answers ?? []).map(clean),
      askedAt: iso(one.at ?? ref.at),
      age: age(ref),
    }
  })
  const byTime = (left: Ref, right: Ref): number => right.at - left.at
  const workingKeys = new Set(page.working.map(ref => ref.key))
  const working = page.working.map(row)
  const waiting = [...page.all.open, ...page.own.open].filter(ref => !workingKeys.has(ref.key)).sort(byTime).map(row)
  const stopped = [...page.all.stopped, ...page.own.stopped].sort(byTime).map(row)
  const doneRecently = [...page.all.done, ...page.own.done].sort(byTime).map(ref => ({
    project: named(ref.repo || source(ref).project || ref.project),
    title: clean(source(ref).title || ''),
    agent: clean(ref.agent),
    age: age(ref),
  }))

  return {
    schemaVersion: BOARD_JSON_SCHEMA,
    generatedAt: clean(new Date(now).toISOString()),
    lang: clean(s.lang),
    counts: {
      needs: needs.length,
      questions: needs.filter(one => one.kind === 'question').length,
      stuck: needs.filter(one => one.kind === 'stuck').length,
      working: working.length,
      waiting: waiting.length,
      stopped: stopped.length,
      doneRecently: doneRecently.length,
    },
    needs,
    working,
    waiting,
    stopped,
    doneRecently,
    doneToday: done.map(clean),
    notices: [model.warning, model.details].filter((line): line is string => !!line).map(clean),
  }
}

import { clipped, plain, redact } from './board'
import type { PendingTurn } from './board'
import { stampOf, withoutStamp } from './done-stamp'
import type { Lang, Strings } from './i18n'
import { localDay, parseJournal } from './journal'
import { isTaskComplete, parseProgress } from './parse'
import { serveModel } from './serve'
import type { QueuedMessaging } from './board-status'
import type { GroupOptions, ServeAsk, ServeModel, ServeRow, ServeTurn } from './serve'
import type { View } from './view'

export const BOARD_JSON_SCHEMA = 1

export type FinishedStep = {
  text: string
  date?: string
}

export type FinishedTask = {
  project: string
  title: string
  agent: string
  finishedDate: string
  steps: FinishedStep[]
}

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
  // The row's one derived state (#1317), when buildView set one; its age is `age`.
  state?: string
  isUnsure: boolean
}

export type BoardDocument = {
  schemaVersion: typeof BOARD_JSON_SCHEMA
  generatedAt: string
  lang: Lang
  counts: { needs: number; questions: number; stuck: number; queued: number; working: number; waiting: number; stopped: number; doneRecently: number }
  needs: BoardNeed[]
  queued: BoardNeed[]
  working: BoardRow[]
  waiting: BoardRow[]
  stopped: BoardRow[]
  doneRecently: Array<{ project: string; title: string; agent: string; age: string }>
  doneToday: string[]
  notices: string[]
  finished?: FinishedTask[]
}

type Ref = NonNullable<ServeModel['view']>['working'][number]
type Source = Partial<ServeAsk & ServeRow & ServeTurn>

export const collectFinished = (
  progressText: string = '',
  journalTexts: readonly string[] = [],
  archiveTexts: readonly string[] = [],
  days: number = 7,
  now: number = Date.now(),
  projectFilter?: string,
  home: string = '',
  isWindows: boolean = false,
): FinishedTask[] => {
  const fromDay = localDay(now - (days - 1) * 24 * 60 * 60 * 1000)
  const toDay = localDay(now)

  const clean = <T extends string>(text: T): T => redact(clipped(plain(text), home, isWindows), home, isWindows) as T
  const folder = home.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? ''
  const named = (project: string): string => clean(folder !== '' && (isWindows ? project.toLowerCase() === folder.toLowerCase() : project === folder) ? '~' : project)

  type TaskHolder = {
    project: string
    title: string
    agent: string
    date: string
    steps: Map<string, { text: string; date: string }>
  }
  const tasks = new Map<string, TaskHolder>()
  const keyOf = (project: string, title: string): string => `${project.toLowerCase()}:::${title.toLowerCase()}`

  for (const text of journalTexts) {
    if (!text) continue
    const entries = parseJournal(text)
    for (const entry of entries) {
      if (entry.at < fromDay || entry.at > toDay) continue
      const proj = named(entry.project)
      const title = clean(entry.task)
      // A journal line names no agent (docs/FORMAT.md, Journal): a step such as "Deploy (Windows)"
      // keeps its words, and the agent comes only from a progress.md or archive block below.
      const stepText = clean(entry.step)
      const key = keyOf(proj, title)
      const held = tasks.get(key) ?? {
        project: proj,
        title,
        agent: '',
        date: entry.at,
        steps: new Map(),
      }
      if (entry.at > held.date) held.date = entry.at
      const stepDate = entry.stamp || entry.at
      const stepKey = stepText.toLowerCase()
      const existingStep = held.steps.get(stepKey)
      if (existingStep === undefined) {
        held.steps.set(stepKey, { text: stepText, date: stepDate })
      } else if (stepDate > existingStep.date) {
        existingStep.date = stepDate
      }
      tasks.set(key, held)
    }
  }

  if (progressText) {
    const parsed = parseProgress(progressText)
    for (const project of parsed) {
      const proj = named(project.name)
      for (const task of project.tasks) {
        const title = clean(task.title)
        const key = keyOf(proj, title)
        if (task.auto !== null) {
          if (task.auto.state === 'done' || isTaskComplete(task)) {
            const taskDate = localDay(task.auto.updated || now)
            if (taskDate >= fromDay && taskDate <= toDay) {
              const held = tasks.get(key) ?? {
                project: proj,
                title,
                agent: clean(task.auto.agent),
                date: taskDate,
                steps: new Map(),
              }
              if (!held.agent && task.auto.agent) held.agent = clean(task.auto.agent)
              if (taskDate > held.date) held.date = taskDate
              for (const step of task.steps) {
                const stText = clean(withoutStamp(step.text))
                const stDate = stampOf(step.raw) ?? taskDate
                if (stDate >= fromDay && stDate <= toDay) {
                  const stepKey = stText.toLowerCase()
                  const existingStep = held.steps.get(stepKey)
                  if (existingStep === undefined) {
                    held.steps.set(stepKey, { text: stText, date: stDate })
                  } else if (stDate > existingStep.date) {
                    existingStep.date = stDate
                  }
                }
              }
              tasks.set(key, held)
            }
          }
        } else {
          for (const step of task.steps) {
            if (step.status !== 'done' && step.status !== 'cancelled') continue
            const stDate = stampOf(step.raw)
            if (stDate !== null && stDate >= fromDay && stDate <= toDay) {
              const stText = clean(withoutStamp(step.text))
              const held = tasks.get(key) ?? {
                project: proj,
                title,
                agent: '',
                date: stDate,
                steps: new Map(),
              }
              if (stDate > held.date) held.date = stDate
              const stepKey = stText.toLowerCase()
              const existingStep = held.steps.get(stepKey)
              if (existingStep === undefined) {
                held.steps.set(stepKey, { text: stText, date: stDate })
              } else if (stDate > existingStep.date) {
                existingStep.date = stDate
              }
              tasks.set(key, held)
            }
          }
        }
      }
    }
  }

  for (const text of archiveTexts) {
    if (!text) continue
    const parsed = parseProgress(text)
    for (const project of parsed) {
      const headingDate = project.name.match(/\s*·\s*(\d{4}-\d\d-\d\d)$/)?.[1] ?? null
      const baseProjectName = project.name.replace(/\s*·\s*\d{4}-\d\d-\d\d$/, '')
      const proj = named(baseProjectName)
      for (const task of project.tasks) {
        const title = clean(task.title)
        const key = keyOf(proj, title)
        const autoAgent = task.auto ? clean(task.auto.agent) : ''
        const autoDate = task.auto ? localDay(task.auto.updated || now) : null
        const taskFallbackDate = autoDate ?? headingDate
        for (const step of task.steps) {
          if (step.status !== 'done' && step.status !== 'cancelled') continue
          const stDate = stampOf(step.raw) ?? taskFallbackDate
          if (stDate !== null && stDate >= fromDay && stDate <= toDay) {
            const stText = clean(withoutStamp(step.text))
            const held = tasks.get(key) ?? {
              project: proj,
              title,
              agent: autoAgent,
              date: stDate,
              steps: new Map(),
            }
            if (!held.agent && autoAgent) held.agent = autoAgent
            if (stDate > held.date) held.date = stDate
            const stepKey = stText.toLowerCase()
            const existingStep = held.steps.get(stepKey)
            if (existingStep === undefined) {
              held.steps.set(stepKey, { text: stText, date: stDate })
            } else if (stDate > existingStep.date) {
              existingStep.date = stDate
            }
            tasks.set(key, held)
          }
        }
      }
    }
  }

  let result: FinishedTask[] = [...tasks.values()].map(t => ({
    project: t.project,
    title: t.title,
    agent: t.agent,
    finishedDate: t.date,
    steps: [...t.steps.values()].map(s => ({
      text: s.text,
      date: s.date,
    })).sort((a, b) => a.date.localeCompare(b.date) || a.text.localeCompare(b.text)),
  }))

  if (projectFilter) {
    const filterClean = clean(projectFilter).toLowerCase()
    const filterNamed = named(projectFilter).toLowerCase()
    result = result.filter(t => {
      const p = t.project.toLowerCase()
      return p === filterClean || p === filterNamed || clean(t.project).toLowerCase() === filterClean
    })
  }

  return result.sort((a, b) => b.finishedDate.localeCompare(a.finishedDate) || a.project.localeCompare(b.project) || a.title.localeCompare(b.title))
}

export const boardDocument = (
  view: View,
  pending: readonly PendingTurn[],
  done: readonly string[],
  s: Strings,
  home: string,
  isWindows: boolean,
  now: number,
  group?: GroupOptions,
  finished?: readonly FinishedTask[],
  messaging?: QueuedMessaging,
): BoardDocument => {
  const model = serveModel(view, pending, s, new Set(), false, messaging, false, group)
  // Callers without filesystem metadata still use the page's pure row grouping.
  const grouped = model.view === undefined ? serveModel(view, pending, s, new Set(), false, messaging, false, {
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
    // The derived state, from the served row or the view's own row (#1317).
    const derived = one.rowState ?? original.get(ref.sourceKey ?? ref.key)?.rowState

    return {
      agent: clean(ref.agent),
      project: named(ref.repo || one.project || ref.project),
      title: clean(one.title || one.task || one.text || ''),
      step: current === undefined ? null : clean(current.text),
      done: one.done ?? 0,
      total: one.total ?? 0,
      updatedAt: iso(one.at ?? ref.at),
      age: age(ref),
      ...(derived === undefined ? {} : { state: derived }),
      // The page falls back to Unknown time; view.ts also labels a future clock.
      // A row the derivation calls 'unsure' is unsure by its age, not only by
      // an unknown one: quiet past 30 min with no live process (#1317).
      isUnsure: !one.when || one.when === s.pgUnknownAge || original.get(ref.sourceKey ?? ref.key)?.hasFutureTime === true || derived === 'unsure',
    }
  }
  const needsRefs: Ref[] = group === undefined ? grouped.asks.map(ask => page.needs.cards.find(ref => ref.key === ask.key) ?? {
    key: ask.key, kind: 'question', agent: ask.agent, project: ask.project, repo: ask.project, at: ask.at ?? 0,
  }) : page.needs.cards
  // An answer queued for the session's next turn is handled for the person, as on the page: it is listed under
  // `queued`, not under `needs`, and `counts.needs` leaves it out (#1296).
  const handled = new Set(page.needs.handled)
  const asNeed = (ref: Ref): BoardNeed => {
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
  }
  const needs = needsRefs.filter(ref => !handled.has(ref.key)).map(asNeed)
  const queued = needsRefs.filter(ref => handled.has(ref.key)).map(asNeed)
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
      queued: queued.length,
      working: working.length,
      waiting: waiting.length,
      stopped: stopped.length,
      doneRecently: doneRecently.length,
    },
    needs,
    queued,
    working,
    waiting,
    stopped,
    doneRecently,
    doneToday: done.map(clean),
    notices: [model.warning, model.details, model.pruned, ...(model.health ?? [])].filter((line): line is string => !!line).map(clean),
    ...(finished !== undefined ? { finished: [...finished] } : {}),
  }
}

import type { ProgressProject, ProgressTask } from '../types'
import { matchesSpan } from './blocks'
import type { BlockIdentity } from './blocks'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { asData, dataBlock } from './mirror'
import { countSteps, isHereProject, isTaskComplete } from './parse'
import { sha256 } from './sha256'

const DAY = 24 * 60 * 60 * 1000
const TRANSFERRED = /(?:—|--|-)\s*(?:Handed to|已交給|已交给)\s+(.+?)\s*$/i
const HANDOFF = /^(?:交接|Handoff)\s*[:：]\s*(.+?)\s*$/i

// A board with many open blocks would fill the start of a conversation; the rest stays on the board.
export const OTHERS_CAP = 8

export type PushIdentity = string | {
  sessionId: string
  agent?: string
  resume?: string | null
  title?: string
  steps?: readonly string[]
}

export type PushResult = {
  note: string | null
  keys: string[]
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const namesTarget = (text: string, agentTokens: readonly string[], exactIds: readonly string[], isDirectRecipient = false): boolean => {
  const lower = text.trim().toLowerCase()
  if (lower === '') return false
  if (exactIds.some(id => lower.includes(id))) return true
  for (const token of agentTokens) {
    const escaped = escapeRegExp(token)
    if (isDirectRecipient && new RegExp(`(?:^|[^a-z0-9_-])${escaped}(?:$|[^a-z0-9_-])`, 'i').test(lower)) return true
    if (new RegExp(`(?:^|[\\s([—:：@])(?:@|(?:to|for|ask|asking|with|ping)\\s+|(?:交給|交给|給|给|問|问|請|请)\\s*)${escaped}(?:$|[\\s,:：;.!?)—\\]])`, 'i').test(lower)) return true
    if (new RegExp(`^${escaped}\\s*[:：,，—-]`, 'i').test(lower)) return true
  }
  return false
}

// For a session's next step (#869): pushes only three kinds of change that concern this session
// (a question for this session, a hand-off to this session, or something this session waits on
// that has finished), fenced as data and never repeated once pushed.
export const sessionPushNote = (
  projects: readonly ProgressProject[],
  here: readonly string[],
  own: PushIdentity,
  pushed: ReadonlySet<string> | Readonly<Record<string, number>> = new Set(),
  now: number = Date.now(),
  s: Strings = ZH_TW,
): PushResult => {
  const ownSession = (typeof own === 'string' ? own : own.sessionId).trim()
  const ownShort = ownSession.slice(0, 8).toLowerCase()
  const ownAgent = (typeof own === 'string' ? '' : (own.agent ?? '')).trim().toLowerCase()
  const ownResume = (typeof own === 'string' ? null : (own.resume ?? null))?.trim() ?? null
  const ownGivenTitle = (typeof own === 'string' ? '' : (own.title ?? '')).trim()
  const ownGivenSteps = typeof own === 'string' ? [] : (own.steps ?? [])

  const ownTasks: ProgressTask[] = []
  for (const project of projects) {
    if (!isHereProject(project.name, here)) continue
    for (const task of project.tasks) {
      if (task.auto !== null && matchesSpan(task.auto, own)) ownTasks.push(task)
    }
  }

  const agentLabel = ownAgent !== '' && Object.hasOwn(s.agentNames, ownAgent) ? (s.agentNames[ownAgent] ?? '').toLowerCase() : ''
  const agentTokens = [...new Set([ownAgent, agentLabel].filter(token => token.length >= 2))]
  const exactIds = [...new Set([
    ownShort,
    ownSession.toLowerCase(),
    ownResume?.toLowerCase() ?? '',
    ownGivenTitle.toLowerCase(),
    ...ownTasks.map(task => task.title.trim().toLowerCase()),
  ].filter(id => id.length >= 4))]

  const waitingTexts = [
    ...ownTasks.flatMap(task => task.steps.filter(step => step.status === 'blocked' || step.status === 'running' || step.status === 'waiting').map(step => step.text.toLowerCase())),
    ...ownGivenSteps.filter(step => /^- \[[!>?]\] /.test(step)).map(step => step.slice(6).toLowerCase()),
  ]

  const seen = pushed instanceof Set ? pushed : new Set(Object.keys(pushed))
  const lines: string[] = []
  const keys: string[] = []
  const add = (key: string, line: string): void => {
    if (seen.has(key) || keys.includes(key)) return
    keys.push(key)
    lines.push(line)
  }

  for (const project of projects) {
    if (!isHereProject(project.name, here)) continue
    for (const task of project.tasks) {
      const auto = task.auto
      if (auto === null || matchesSpan(auto, own)) continue
      if (now - auto.updated > 7 * DAY) continue
      const from = asData(auto.agent || project.name)
      const title = asData(task.title)

      for (const note of task.notes) {
        const match = HANDOFF.exec(note)
        if (match?.[1] !== undefined && namesTarget(match[1], agentTokens, exactIds)) {
          add(`handoff:${auto.session}:${sha256(match[1]).slice(0, 16)}`, s.othersPushHandoff(from, title, asData(match[1])))
        }
      }

      for (const step of task.steps) {
        const transferred = TRANSFERRED.exec(step.text)
        if (transferred?.[1] !== undefined && namesTarget(transferred[1], agentTokens, exactIds, true)) {
          add(`handoff:${auto.session}:${sha256(step.text).slice(0, 16)}`, s.othersPushHandoff(from, title, asData(step.text)))
          continue
        }
        if (step.status === 'running' && namesTarget(step.text, agentTokens, exactIds)) {
          add(`handoff:${auto.session}:${sha256(step.text).slice(0, 16)}`, s.othersPushHandoff(from, title, asData(step.text)))
          continue
        }
        if (step.status === 'waiting' && step.native === undefined && namesTarget(step.text, agentTokens, exactIds)) {
          add(`ask:${auto.session}:${sha256(step.text).slice(0, 16)}`, s.othersPushQuestion(from, title, asData(step.text)))
        }
      }

      if (auto.state === 'done' || isTaskComplete(task)) {
        const isDelegatedRun = auto.isRun === true && auto.parent !== undefined
          && [ownSession.toLowerCase(), ownShort, ownResume?.toLowerCase() ?? ''].filter(Boolean).includes(auto.parent.toLowerCase())
        const otherTitle = task.title.trim().toLowerCase()
        const otherAgent = auto.agent.trim().toLowerCase()
        const isWaitedStep = waitingTexts.some(wait =>
          (otherTitle.length >= 3 && wait.includes(otherTitle))
          || (auto.session.length >= 4 && wait.includes(auto.session.toLowerCase()))
          || (auto.resume !== null && auto.resume.length >= 4 && wait.includes(auto.resume.toLowerCase()))
          || (otherAgent.length >= 2 && new RegExp(`(?:wait(?:ing)?\\s+(?:on|for)|blocked\\s+by|等(?:待)?)\\s+@?${escapeRegExp(otherAgent)}(?:$|[^a-z0-9_-])`, 'i').test(wait)),
        )
        if (isDelegatedRun || isWaitedStep) {
          add(`waited:${auto.session}:${sha256(task.title).slice(0, 16)}`, s.othersPushFinished(from, title))
        }
      }
    }
  }

  if (lines.length === 0) return { note: null, keys: [] }
  const more = lines.length > OTHERS_CAP ? [s.othersMore(lines.length - OTHERS_CAP)] : []
  return {
    note: [s.othersPushHead, ...dataBlock(lines.slice(0, OTHERS_CAP), s), ...more, s.othersPushTail].join('\n'),
    keys,
  }
}

// For a session's first turn: work in this project that other sessions left or hold, from the
// last 7 days. The Claude mod and the Codex hook both send it (#502). `own` is this session's
// canonical identity (a legacy block id is also accepted); `tail` is what the agent is told to
// do with it, in words its host has tools for.
export const othersNote = (projects: readonly ProgressProject[], here: readonly string[], own: BlockIdentity, now: number, s: Strings = ZH_TW, tail: string = s.othersTail): string | null => {
  const lines: string[] = []
  for (const project of projects) {
    if (!isHereProject(project.name, here)) continue
    for (const task of project.tasks) {
      const auto = task.auto
      if (auto === null || matchesSpan(auto, own) || auto.state === 'done' || isTaskComplete(task)) continue
      if (now - auto.updated > 7 * DAY) continue
      const { done, total } = countSteps(task)
      const open = task.steps.find(step => step.status !== 'done' && step.status !== 'cancelled')
      // Another agent wrote these words: they reach the model as quoted data, never as a line of
      // their own that reads like an instruction.
      const title = asData(task.title)
      lines.push(auto.state === 'ended' ? s.othersEnded(title, open === undefined ? s.none : asData(open.text), done, total) : s.othersHeld(title, done, total))
    }
  }
  if (lines.length === 0) return null
  // The count is the mod's own words, so it stays outside the fence of file text.
  const more = lines.length > OTHERS_CAP ? [s.othersMore(lines.length - OTHERS_CAP)] : []

  return [s.othersHead, ...dataBlock(lines.slice(0, OTHERS_CAP), s), ...more, tail].join('\n')
}

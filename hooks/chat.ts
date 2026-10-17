import type { ProgressProject, ProgressTask } from '../types'
import type { PendingTurn } from './board'
import { lastQuestion } from './digest'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { localDay } from './journal'
import type { JournalEntry } from './journal'
import { isStale, isTaskComplete } from './parse'
import { buildView } from './view'

// A host declares the surfaces it actually offers. No brand or location probing; the
// standalone CLI declares its existing terminal surface unless --chat is requested.
export const reportMode = (surface: { terminal?: boolean; interactive?: boolean } = {}): 'chat' | 'terminal' | 'interactive' =>
  surface.interactive === true ? 'interactive' : surface.terminal === true ? 'terminal' : 'chat'

export type ChatSource = { state: 'read' | 'missing' | 'unavailable'; at?: number }
export type ChatSnapshot = {
  projects: readonly ProgressProject[]
  answered: readonly string[]
  pending: readonly PendingTurn[]
  journal: readonly JournalEntry[]
  now: number
  sources: { board: ChatSource; answered: ChatSource; inbox: ChatSource; journal: ChatSource }
}

// This is deliberately more conservative than the terminal: messages may leave the
// machine. Never offer resume commands, local paths or credential-bearing links.
export const chatText = (text: string, s: Strings = ZH_TW): string => text
  .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\bBearer\s+[^\s,;]+/gi, s.chatRedacted)
  .replace(/\b(?:[\w-]+[_-])?(?:api[_-]?key|access[_-]?token|(?:secret[_-]?)?access[_-]?key|private[_-]?key|token|password|passwd|secret|authorization)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, s.chatRedacted)
  .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, s.chatRedacted)
  .replace(/(?:https?|file|smb):\/\/[^\s<>"'`]+/gi, s.chatRedacted)
  .replace(/(["'])(?:[a-z]:[\\/]|[\\/]{2}|~?\/)[^\r\n]*?\1/gi, s.chatRedacted)
  .replace(/(?:[a-z]:[\\/]|[\\/]{2}|~\/|\.{1,2}[\\/]|\/)[^\s<>"'`]+/gi, s.chatRedacted)
  .replace(/<[^>]*>/g, '')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

// One task goes in its highest-priority section. The journal describes recorded steps,
// never whole-task completion or a since-last-message delta (its parser keeps dates only).
export const chatDigest = (snapshot: ChatSnapshot, s: Strings = ZH_TW): string => {
  const { projects, answered, pending, journal, now, sources } = snapshot
  const view = buildView(projects, [], null, now, 0, {}, s, answered)
  const safe = (text: string): string => chatText(text, s)
  const stamp = (at: number | undefined): string => at !== undefined && at > 0 && at <= now && Number.isFinite(at) ? new Date(at).toISOString() : s.chatUnknownTime
  const sections: string[][] = [[], [], [], []]
  const [decisions = [], blockers = [], completed = [], other = []] = sections
  const day = localDay(now)
  const history = new Map<string, Set<string>>()
  const historyKey = (project: string, title: string): string => JSON.stringify([project, title])
  for (const entry of journal) {
    if (entry.at !== day) continue
    const key = historyKey(entry.project, entry.task)
    const steps = history.get(key) ?? new Set<string>()
    steps.add(entry.step)
    history.set(key, steps)
  }
  const finish = (project: string, title: string): string[] => {
    const key = historyKey(project, title)
    const steps = history.get(key)
    history.delete(key)
    return steps === undefined ? [] : [...steps].map(step => `  ${s.chatDoneStep(safe(step))}`)
  }
  const seen = new Map<string, number>()
  const known = new Map<string, ProgressTask>()
  for (const project of projects) for (const task of project.tasks) {
    if (task.auto !== null && task.auto.updated >= (known.get(task.auto.session)?.auto?.updated ?? -1)) known.set(task.auto.session, task)
  }
  const visible = new Set([...view.active, ...view.due].map(row => row.key))
  for (const project of projects) {
    const name = project.name || s.uncategorized
    for (const task of project.tasks) {
      const title = task.title || s.unnamed
      const base = `${name}::${title}`
      const repeat = (seen.get(base) ?? 0) + 1
      seen.set(base, repeat)
      const key = repeat === 1 ? base : `${base}#${repeat}`
      if (task.auto !== null && known.get(task.auto.session) !== task) continue
      const asks = sources.answered.state === 'unavailable' ? [] : view.waiting.filter(item => item.key.startsWith(`${key}::`) && item.key.slice(0, item.key.lastIndexOf('::')) === key)
      const blocked = task.steps.filter(step => step.status === 'blocked')
      const isComplete = isTaskComplete(task) || task.auto?.state === 'done'
      if (asks.length === 0 && blocked.length === 0 && !visible.has(key) && !isComplete) continue
      const section = asks.length > 0 ? decisions : blocked.length > 0 ? blockers : isComplete && history.has(historyKey(project.name, task.title)) ? completed : other
      const who = task.auto === null ? '' : ` · ${safe(task.auto.agent)}`
      const freshness = task.auto === null ? s.chatUnknownTime : stamp(task.auto.updated)
      const isStopped = task.auto?.state === 'ended' || isStale(task.auto, now)
      section.push(`- ${safe(name)} · ${safe(title)}${who} (${s.chatRecorded(freshness)}${isStopped ? `; ${s.chatStopped}` : ''})`)
      for (const ask of asks) section.push(`  ${safe(`${ask.text}${ask.note ? ` — ${ask.note}` : ''}`)}`)
      for (const step of blocked) section.push(`  ${s.chatBlockedStep(safe(step.text))}`)
      if (blocked.length > 0 && blocked.every(step => !step.text.includes(' — '))) section.push(`  ${s.chatUnblockUnknown}`)
      if (asks.length === 0 && blocked.length === 0) {
        // Hidden and stale questions stay out of actionable prose, including when the
        // source status line still calls a waiting step the next step.
        if (isComplete && !history.has(historyKey(project.name, task.title))) section.push(`  ${s.chatReportedDone}`)
        if (!isComplete) {
          const next = task.steps.find(step => !['done', 'cancelled', 'waiting'].includes(step.status))
          if (next !== undefined) section.push(`  ${safe(next.text)}`)
        }
      }
      section.push(...finish(project.name, task.title))
    }
  }
  for (const [key, steps] of history) {
    const [project, title] = JSON.parse(key) as [string, string]
    completed.push(`- ${safe(project)} · ${safe(title)}`, ...[...steps].map(step => `  ${s.chatDoneStep(safe(step))}`))
  }
  const pendingSeen = new Set<string>()
  for (const turn of pending) {
    // A merged session is authoritative until a genuinely newer report arrives.
    const merged = turn.session === undefined ? undefined : known.get(turn.session)
    if (merged !== undefined && turn.at <= (merged.auto?.updated ?? 0)) continue
    const questions = [...view.waiting, ...view.hidden].filter(item => item.project === turn.project && (turn.session === undefined ? item.agent === turn.agent : item.hideKey.startsWith(`${turn.session} `)))
    // Shared answered marks deliberately survive when their source block is absent.
    // A pending copy of that session's old question must not undo the mark.
    const wasAnswered = turn.session !== undefined && answered.some(key => {
      const prefix = `${turn.session} `
      if (!key.startsWith(prefix)) return false
      const words = key.slice(prefix.length).replace(/^\d+ /, '')
      return words === turn.text || lastQuestion(words) === turn.text
    })
    if (turn.isQuestion && wasAnswered) continue
    if (turn.isQuestion && questions.some(item => [item.text, item.note, `${item.text} — ${item.note}`].includes(turn.text))) continue
    if (turn.isQuestion && sources.answered.state === 'unavailable') continue
    const key = JSON.stringify([turn.project, turn.agent, turn.text])
    if (pendingSeen.has(key)) continue
    pendingSeen.add(key)
    // An unmerged excerpt is a report, never evidence of completion or a delivered reply.
    const section = turn.isQuestion ? decisions : other
    section.push(`- ${safe(turn.project)} · ${safe(turn.agent)} (${s.chatPending(stamp(turn.at))}): ${safe(turn.text)}`)
  }
  const sourceNames = { board: s.chatBoard, answered: s.chatAnswered, inbox: s.chatInbox, journal: s.chatJournal }
  const lines = [
    s.chatSnapshot(new Date(now).toISOString()),
    s.chatScope,
    ...Object.entries(sources).map(([key, source]) => `${sourceNames[key as keyof typeof sourceNames]}: ${s.chatSourceState[source.state]}${source.at === undefined ? '' : `; ${s.chatRecorded(stamp(source.at))}`}`),
    s.chatWindow(day),
    s.chatReply,
    ...(view.hidden.length === 0 ? [] : [s.hiddenCount(view.hidden.length)]),
  ]
  const headings = [s.chatDecisions, s.chatBlockers, s.chatCompleted, s.chatOther]
  sections.forEach((section, index) => lines.push('', headings[index] ?? '', ...(section.length === 0 ? [s.chatNone] : section)))
  return `${lines.join('\n')}\n`
}

import { scanBlocks, takeTask } from './blocks'
import { parseProgress, STALE_MS } from './parse'
import { sha256 } from './sha256'
import type { TaskRef } from './view'
import type { Strings } from './i18n'

export type TidySelector = { kind: 'stopped' } | { kind: 'agent'; value: string } | { kind: 'older'; days: number }
export type TidyCandidate = { ref: TaskRef; fingerprint: string; asks: boolean }
export type TidyPreview = { selector: TidySelector; now: number; candidates: TidyCandidate[] }

export const tidySelector = (kind: unknown, value?: unknown): TidySelector | null => {
  if (kind === 'stopped' && (value === undefined || value === '')) return { kind }
  if (kind === 'agent' && typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)) return { kind, value }
  if (kind === 'older' && typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    const days = Number(value)
    if (Number.isSafeInteger(days) && days <= 365000) return { kind, days }
  }
  return null
}

// A preview names whole closed blocks, never manual tasks or live owners. Duplicate ids
// are ambiguous even when their titles differ, so none of those copies is authorized.
export const previewTidy = (text: string, selector: TidySelector, now: number, s: Strings): TidyPreview => {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/)
  const spans = scanBlocks(lines)
  const tasks = parseProgress(text).flatMap(project => project.tasks.map(task => ({ project: project.name, task })))
  const candidates: TidyCandidate[] = []
  for (const span of spans) {
    if (!span.isClosed || spans.filter(one => one.session === span.session).length !== 1) continue
    // A later heading inside the markers is a hand-kept task, not the session's
    // property. Taking the whole span would also take its unretained questions.
    const inside = tasks.filter(({ task }) => task.line > span.start && task.line < span.end)
    if (inside.length !== 1) continue
    const first = inside[0]
    if (first === undefined || first.task.auto === null) continue
    const { task, project } = first
    const auto = task.auto!
    if (auto.state !== 'ended' && auto.state !== 'done' && !(auto.updated > 0 && now - auto.updated > STALE_MS)) continue
    if (selector.kind === 'agent' && auto.agent !== selector.value) continue
    if (selector.kind === 'older' && !(auto.updated > 0 && auto.updated < now - selector.days * 86400000)) continue
    const ref = { project, title: task.title, line: task.line, session: span.session }
    if (takeTask(text, ref, now, s) === null) continue
    candidates.push({ ref, fingerprint: sha256(JSON.stringify([project, lines.slice(span.start, span.end + 1)])), asks: tasks.some(one => one.task.line > span.start && one.task.line < span.end && one.task.steps.some(step => step.status === 'waiting')) })
  }
  return { selector, now, candidates }
}

export const currentTidyCandidate = (text: string, preview: TidyPreview, candidate: TidyCandidate, s: Strings): TidyCandidate | undefined =>
  previewTidy(text, preview.selector, preview.now, s).candidates.find(one => one.ref.session === candidate.ref.session && one.ref.project === candidate.ref.project && one.fingerprint === candidate.fingerprint)

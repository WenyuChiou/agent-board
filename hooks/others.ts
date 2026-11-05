import type { ProgressProject } from '../types'
import { matchesSpan } from './blocks'
import type { BlockIdentity } from './blocks'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'
import { asData, dataBlock } from './mirror'
import { countSteps, isHereProject, isTaskComplete } from './parse'

const DAY = 24 * 60 * 60 * 1000

// A board with many open blocks would fill the start of a conversation; the rest stays on the board.
export const OTHERS_CAP = 8

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

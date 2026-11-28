import { LANGS } from './i18n'
import { isMarksComplete } from './parse'
import type { ProgressStepStatus } from '../types'
import { STRINGS } from './strings'

// The step a hook writes for a session that has reported none of its own (`codexLifecycle` here,
// `localAgentLifecycle` in codex-local.ts). The view tells it from an agent's step by these words:
// every language's, and those earlier releases wrote, which stay in old blocks (#612).
const EARLIER_LIFECYCLE_STEPS = [
  'Local session activity; Codex explicitly reports task steps',
  '本機 session 活動狀態；任務步驟由 Codex 明確回報',
  '本地 session 活动状态；任务步骤由 Codex 明确报告',
  'Native session activity; the current agent explicitly reports task steps',
  '原生 session 活動狀態；任務步驟由目前 agent 明確回報',
  '原生 session 活动状态；任务步骤由当前 agent 明确报告',
]
export const LIFECYCLE_STEPS: ReadonlySet<string> = new Set([
  ...LANGS.flatMap(lang => [
    STRINGS[lang].codexLifecycle,
    STRINGS[lang].codexLifecycleWorking,
    STRINGS[lang].localAgentLifecycle,
    STRINGS[lang].localAgentLifecycleWorking,
  ]),
  ...EARLIER_LIFECYCLE_STEPS,
])
export const isLifecycleStep = (text: string): boolean => LIFECYCLE_STEPS.has(text.replace(/^- \[[ x~?!]\] /, '').trim())

// The work is done: every step the agent wrote is done or cancelled, whatever state the hook's own placeholder
// ("Waiting for the next instruction") is in. The hook rewrites that placeholder to open at every turn's end
// (state=waiting), so a block whose last real step was ticked still has one open step (#1839).
export const isWorkDone = (steps: readonly { text: string; status: ProgressStepStatus }[]): boolean =>
  isMarksComplete(steps.filter(step => !isLifecycleStep(step.text)).map(step => step.status))

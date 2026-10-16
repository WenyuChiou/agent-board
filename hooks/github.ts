import type { ProgressCi, ProgressPr } from '../types'
import { ZH_TW } from './i18n'
import type { Strings } from './i18n'

// The pull request of this session's branch, from `gh pr view --json`; a machine without
// gh, or a branch without a PR, has none.

export const GH_FIELDS = 'number,url,state,isDraft,statusCheckRollup,reviewDecision'

type Check = {
  // CheckRun
  status?: string
  conclusion?: string
  // StatusContext
  state?: string
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])

const outcomeOf = (check: Check): 'pass' | 'fail' | 'pending' => {
  if (check.state !== undefined) {
    if (FAILED.has(check.state)) return 'fail'
    return PENDING.has(check.state) ? 'pending' : 'pass'
  }
  if (check.status !== undefined && check.status !== 'COMPLETED') return 'pending'
  const conclusion = check.conclusion ?? ''
  if (FAILED.has(conclusion)) return 'fail'

  return conclusion === '' ? 'pending' : 'pass'
}

export const ciOf = (checks: readonly Check[]): { ci: ProgressCi; failed: number } => {
  if (checks.length === 0) return { ci: 'none', failed: 0 }
  const outcomes = checks.map(outcomeOf)
  const failed = outcomes.filter(one => one === 'fail').length
  if (failed > 0) return { ci: 'fail', failed }

  return { ci: outcomes.includes('pending') ? 'pending' : 'pass', failed: 0 }
}

const REVIEW: Record<string, ProgressPr['review']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes',
  REVIEW_REQUIRED: 'required',
}

export const prFromGh = (stdout: string): ProgressPr | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  const data = raw as {
    number?: unknown
    url?: unknown
    state?: unknown
    isDraft?: unknown
    statusCheckRollup?: unknown
    reviewDecision?: unknown
  }
  if (typeof data.number !== 'number' || typeof data.url !== 'string') return null
  const state = data.state === 'MERGED' ? 'merged' : data.state === 'CLOSED' ? 'closed' : 'open'
  const checks = Array.isArray(data.statusCheckRollup) ? (data.statusCheckRollup as Check[]) : []

  return {
    number: data.number,
    url: data.url,
    state,
    isDraft: data.isDraft === true,
    ...ciOf(checks),
    review: typeof data.reviewDecision === 'string' ? (REVIEW[data.reviewDecision] ?? null) : null,
  }
}

export const ciWords = (ci: ProgressCi | null, failed = 0, s: Strings = ZH_TW): string => {
  if (ci === 'pass') return s.ciPass
  if (ci === 'fail') return s.ciFail(failed)
  if (ci === 'pending') return s.ciPending

  return ''
}

const reviewWords = (review: NonNullable<ProgressPr['review']>, s: Strings): string =>
  review === 'approved' ? s.reviewApproved : review === 'changes' ? s.reviewChanges : s.reviewRequired

// `PR #12 · CI 失敗 2 · 要求修改`, in the words the pane uses.
export const prWords = (pr: ProgressPr, s: Strings = ZH_TW): string =>
  [
    `PR #${pr.number}`,
    pr.state === 'merged' ? s.prMerged : pr.state === 'closed' ? s.prClosed : pr.isDraft ? s.prDraft : '',
    pr.state === 'open' ? ciWords(pr.ci, pr.failed, s) : '',
    pr.state === 'open' && pr.review !== null ? reviewWords(pr.review, s) : '',
  ]
    .filter(part => part !== '')
    .join(' · ')

// A CI run that just finished, for a notification; null when nothing changed that way.
export const ciFinished = (before: ProgressPr | null, after: ProgressPr | null, s: Strings = ZH_TW): string | null => {
  if (before === null || after === null || before.number !== after.number) return null
  if (before.ci !== 'pending' || (after.ci !== 'pass' && after.ci !== 'fail')) return null

  return s.noticeCi(after.number, ciWords(after.ci, after.failed, s))
}

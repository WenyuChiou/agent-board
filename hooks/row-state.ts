import { isLifecycleStep } from './codex'
import { WORKING_MS } from './grouping'
import { waitsOnYou } from './mirror'
import { STALE_MS } from './parse'
import { agentClaimOf, blockKey } from './session-liveness'
import type { ProgressAuto, ProgressMirror, ProgressStep } from '../types'

// One row, one state (#1317, M7). Pure: takes data, returns data, takes `now` as a
// parameter, never reads the clock or a file. The surfaces do not show every state
// yet: only 'unsure' is new and visible in this slice; 'stopped', 'toCheck' and
// 'waitingElsewhere' are computed so the table test pins them, and the rows keep
// today's rendering until D1 (#1319) lands. 'youStopped' is never returned yet:
// nothing in the inputs tells a session the person stopped from one that ended
// on its own, so both read 'ended' for now.

// The states, in the order M7 applies them when two fit: approval, answer,
// stopped, done to check, ended. 'working' and 'waiting' are the live rows;
// 'cannotTell' is the seventh row when even the age is unknown; 'manual' is a
// hand-kept task, outside the six.
export type RowState =
  | 'working'
  | 'waiting'
  | 'approval'
  | 'answer'
  | 'stopped'
  | 'toCheck'
  | 'ended'
  | 'cannotTell'
  | 'unsure'
  | 'youStopped'
  | 'waitingElsewhere'
  | 'manual'

// What the process check says about the session that wrote the block (#1092):
// 'alive' is a claimed process that is not gone, 'dead' is a claimed process
// proven gone, 'unknown' is no claim at all — no pid recorded, the wrong host,
// or an app/IDE host that never records one. Only 'alive' keeps a quiet row
// from reading 'unsure'.
export type Liveness = 'alive' | 'dead' | 'unknown'

// The liveness of one block, from the gone set Phase 1 passes in. A claim that
// is not in the gone set reads 'alive' — the same shape as `isStopped`: the
// gone set only holds claimed blocks probed on this host, so a valid claim
// from another host is never probed and reads 'alive' without a check. That
// fails safe for 'unsure' (the row keeps today's rendering) and matches how
// the gone set already drives the ended display.
export const livenessOf = (auto: ProgressAuto | null, gone: ReadonlySet<string>): Liveness => {
  if (auto === null) return 'unknown'
  if (agentClaimOf(auto) === null) return 'unknown'
  return gone.has(blockKey(auto)) ? 'dead' : 'alive'
}

export type RowStateInput = {
  auto: ProgressAuto | null
  steps: readonly ProgressStep[]
  // This session's own Task list, where present; the rows of other sessions
  // carry none, so this is null for them and the mirror branch does not fire.
  mirror: ProgressMirror | null
  events: {
    // A session-end event arrived for this session (or the block says ended).
    hasSessionEnd: boolean
    // When the session last moved, in epoch milliseconds; 0 when unknown.
    lastEventAt: number
    host: string
  }
  liveness: Liveness
  now: number
  // Ledger-resolved: an open [?] step the person has not answered. The caller
  // works this out from the question ledger (`isAsked` in view.ts); a [?]
  // step alone does not say it, since the person may have marked it answered.
  // An open ask keeps its card in Needs you even on an unsure session (Q5):
  // 'unsure' is not confirmed ended, so the ask is never folded by it.
  hasOpenAsk: boolean
  // A pending approval from the host's permission event only (D3, #1318).
  // False until D3 wires it; reply text never counts as an approval.
  hasApproval?: boolean
}

// A step that is still work: not done, not cancelled, and not the hook's own
// lifecycle placeholder ("Waiting for the next instruction"), which says the
// session waits rather than naming work.
const isOpenStep = (step: ProgressStep): boolean =>
  step.status !== 'done' && step.status !== 'cancelled' && !isLifecycleStep(step.text)

export const deriveRowState = (input: RowStateInput): RowState => {
  const { auto, steps, mirror, events, liveness, now, hasOpenAsk } = input
  if (auto === null) return 'manual'
  // A session-end event, or a block that already says ended, is ended whatever
  // else the row holds — including an open ask, which then leaves Needs you
  // by the confirmed-ended rule (M7), not by the unsure rule.
  if (events.hasSessionEnd || auto.state === 'ended') return 'ended'
  // A claimed process proven gone is ended too: the same fact Phase 1 already
  // shows as ended through `isStopped`.
  if (liveness === 'dead') return 'ended'
  // The 12 h backstop, unchanged: a working or waiting row quiet past STALE_MS
  // already displays as ended today (`isStale`), and its open ask already
  // leaves Needs you for the Older shelf — so 'ended' wins here too, before
  // the answer branch below. It also bounds 'unsure': a placeholder row is
  // unsure from 30 min to 12 h, and ended past that, as today.
  if ((auto.state === 'working' || auto.state === 'waiting') && events.lastEventAt > 0 && now - events.lastEventAt > STALE_MS) return 'ended'
  if (input.hasApproval === true) return 'approval'
  if (mirror !== null && mirror.tasks.some(task => waitsOnYou(mirror, task))) return 'answer'
  if (hasOpenAsk) return 'answer'
  const open = steps.filter(isOpenStep)
  // Every step done is work to check, not work in progress.
  if (steps.length > 0 && steps.every(step => step.status === 'done' || step.status === 'cancelled')) return 'toCheck'
  // Only steps that wait on someone else are left: the session waits elsewhere.
  if (open.length > 0 && open.every(step => step.status === 'running')) return 'waitingElsewhere'
  // A turn that ended with real steps left and no ask stopped, not finished.
  if (auto.state === 'waiting' && open.length > 0) return 'stopped'
  // The seventh row, with its age (Q10): only the hook's placeholder is open
  // (or no step at all), quiet past the board's "not heard from" time, and no
  // live process. A live process keeps the row waiting; the conversation still
  // exists in its app, so this never reads 'ended'.
  const placeholderOnly = steps.every(step => isLifecycleStep(step.text))
  if (placeholderOnly && events.lastEventAt > 0 && now - events.lastEventAt > WORKING_MS && liveness !== 'alive') return 'unsure'
  // Only the placeholder is open but there is no usable age: the board cannot
  // even say how long the row has been quiet.
  if (placeholderOnly && events.lastEventAt <= 0) return 'cannotTell'
  if (auto.state === 'working') return 'working'
  if (auto.state === 'waiting') return 'waiting'
  return 'toCheck'
}

import { hostname } from 'node:os'
import { cachedProcessStarted } from './local-lock'
import type { ProcessStart } from './local-lock'
import { agentClaimOf, hostHashOf, isDeadAgent } from '../hooks/session-liveness'
import { questionScope } from '../hooks/questions'
import type { ProgressAuto, ProgressProject } from '../types'

// The liveness of agent sessions, as the shell sees it (#1092): whether the agent
// process that wrote a block is gone on this machine. The decision itself is pure
// (hooks/session-liveness.ts); this module only does the syscalls.

// How long a start-time lookup may take, per pid. A lookup that fails or times out
// means the process is treated as alive (PM Q5).
const START_LOOKUP_TIMEOUT_MS = 2000

// The reading machine's host hash, computed once per process. The environment first,
// so the hash matches the plugin's; the OS name only when the shell left the
// variable unset.
let readingHost: string | null = null
export const readingHostHash = (): string | null => {
  if (readingHost === null) {
    const name = process.platform === 'win32'
      ? process.env.COMPUTERNAME ?? hostname()
      : process.env.HOSTNAME ?? hostname()
    readingHost = hostHashOf(process.platform, name)
  }
  return readingHost
}

// Start-time lookups, cached in the board process (PM Q5: a live pid's start time is
// checked once, never once per poll).
const startedCache = new Map<number, ProcessStart>()

// Whether the agent that wrote this block is dead on this machine. A pid-less
// block, a host that differs from the reading machine, and any uncertain answer all
// keep the card (the 12 h backstop). EPERM from the kill means the process exists
// but cannot be signalled, so it is alive: when in doubt the card is kept. (This
// differs from scripts/local-lock.ts isDeadOwner, which treats EPERM as dead: a
// lock may be taken from a process that cannot be signalled, but a question must
// not be folded on that evidence.)
export const isDeadSession = (auto: ProgressAuto | null, hostHash: string | null): boolean => {
  if (hostHash === null) return false
  const claim = agentClaimOf(auto)
  if (claim === null) return false
  let alive: boolean
  try {
    process.kill(claim.pid, 0)
    alive = true
  } catch (error) {
    // ESRCH: no such process. Any other refusal means the process exists or the
    // answer is uncertain, so it is alive: when in doubt the card is kept.
    alive = (error as { code?: string }).code !== 'ESRCH'
  }
  // A dead pid needs no start-time check; a live pid's start time is checked once
  // (cached) to defeat pid reuse. The host is checked in both cases. A live pid
  // with no recorded start time cannot be proven reused, so it is alive without a
  // lookup (and without a spawn on Windows).
  if (!alive) return isDeadAgent(claim, hostHash, false, null)
  if (claim.started === undefined) return false
  const actual = cachedProcessStarted(claim.pid, startedCache, START_LOOKUP_TIMEOUT_MS)
  return isDeadAgent(claim, hostHash, alive, actual)
}

// The question scopes of sessions whose agent is dead on this machine, for buildView
// and observeQuestions. A task with no agent block, a done or ended block, a
// non-Claude agent (only Claude Code records a pid, PM Q4), or a live agent is
// never in it.
export const deadSessionsOf = (projects: readonly ProgressProject[], hostHash: string | null = readingHostHash()): ReadonlySet<string> => {
  const dead = new Set<string>()
  if (hostHash === null) return dead
  for (const project of projects) {
    for (const task of project.tasks) {
      const auto = task.auto
      if (auto === null || auto.state === 'done' || auto.state === 'ended' || auto.agent !== 'claude') continue
      if (!isDeadSession(auto, hostHash)) continue
      dead.add(questionScope(project.name, auto.agent, auto.session))
    }
  }
  return dead
}

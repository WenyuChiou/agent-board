import { hostname } from 'node:os'
import { cachedProcessStarted, cachedProcessStartedMany } from './local-lock'
import type { ProcessStart } from './local-lock'
import { agentClaimOf, hostHashOf, isDeadAgent, sessionClaimsOf, AGENT_START_DRIFT_MS } from '../hooks/session-liveness'
import type { AgentClaim } from '../hooks/session-liveness'
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

// A cached start is trusted only for the claim it was looked up for (finding 2):
// a cached failure, or a start that differs from the claim's beyond the drift,
// belongs to another process (or none) and must be looked up again. A claim with
// no recorded start cannot judge the cache, so it keeps it. 'inaccessible' is a
// determined answer, so it is kept too.
const dropStaleStart = (cache: Map<number, ProcessStart>, claim: AgentClaim): void => {
  const held = cache.get(claim.pid)
  if (held === null) cache.delete(claim.pid)
  else if (typeof held === 'number' && claim.started !== undefined && Math.abs(held - claim.started) > AGENT_START_DRIFT_MS) cache.delete(claim.pid)
}

// Whether the agent that wrote this block is dead on this machine. A pid-less
// block, a host that differs from the reading machine, and any uncertain answer all
// keep the card (the 12 h backstop). EPERM from the kill means the process exists
// but cannot be signalled, so it is alive: when in doubt the card is kept. (This
// differs from scripts/local-lock.ts isDeadOwner, which treats EPERM as dead: a
// lock may be taken from a process that cannot be signalled, but a question must
// not be folded on that evidence.) `cache` is the start-time cache (the module
// cache by default; a caller may pass its own so a test can pre-populate a stale
// entry). A pid that died deletes its entry, and a failed lookup is never kept,
// so a later session reusing the pid is looked up again (finding 2).
export const isDeadSession = (auto: ProgressAuto | null, hostHash: string | null, cache: Map<number, ProcessStart> = startedCache): boolean => {
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
  if (!alive) {
    cache.delete(claim.pid)
    return isDeadAgent(claim, hostHash, false, null)
  }
  if (claim.started === undefined) return false
  dropStaleStart(cache, claim)
  const actual = cachedProcessStarted(claim.pid, cache, START_LOOKUP_TIMEOUT_MS)
  if (actual === null) cache.delete(claim.pid)
  return isDeadAgent(claim, hostHash, alive, actual)
}

// The identity keys of sessions whose agent is dead on this machine, for buildView
// and observeQuestions (finding 3): the agent and the full session id, as
// deadSessionKey builds it, from the newest claim of each identity — a dead
// duplicate never decides the live winner. A task with no agent block, a done or
// ended block, a non-Claude agent (only Claude Code records a pid, PM Q4), or a
// live agent is never in it. The kill runs first for every pid; a dead pid needs
// no start-time check, and the live pids share ONE start-time lookup (on Windows
// a PowerShell spawn costs ~250 ms, so one spawn per session would make a
// ten-session poll cost ~2.5 s). The host is checked for every pid, dead or live.
export const deadSessionsOf = (projects: readonly ProgressProject[], hostHash: string | null = readingHostHash(), cache: Map<number, ProcessStart> = startedCache): ReadonlySet<string> => {
  const dead = new Set<string>()
  if (hostHash === null) return dead
  const live: Array<{ claim: AgentClaim; key: string }> = []
  for (const { key, claim } of sessionClaimsOf(projects)) {
    let alive: boolean
    try {
      process.kill(claim.pid, 0)
      alive = true
    } catch (error) {
      // ESRCH: no such process. Any other refusal means the process exists or
      // the answer is uncertain, so it is alive: when in doubt the card is kept.
      alive = (error as { code?: string }).code !== 'ESRCH'
    }
    if (!alive) {
      cache.delete(claim.pid)
      if (isDeadAgent(claim, hostHash, false, null)) dead.add(key)
      continue
    }
    if (claim.started === undefined) continue
    live.push({ claim, key })
  }
  if (live.length > 0) {
    for (const { claim } of live) dropStaleStart(cache, claim)
    const starts = cachedProcessStartedMany(live.map(one => one.claim.pid), cache, START_LOOKUP_TIMEOUT_MS)
    for (const { claim, key } of live) {
      const actual = starts.get(claim.pid) ?? null
      if (actual === null) cache.delete(claim.pid)
      if (isDeadAgent(claim, hostHash, true, actual)) dead.add(key)
    }
  }
  return dead
}

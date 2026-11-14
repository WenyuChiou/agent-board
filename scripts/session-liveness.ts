import { hostname } from 'node:os'
import { processStartedMany } from './local-lock'
import type { ProcessStart } from './local-lock'
import { claimedBlocksOf, goneBlocks, hostHashOf } from '../hooks/session-liveness'
import type { ProgressProject } from '../types'

// The liveness of agent sessions, as the shell sees it (#1092): whether the agent
// process that wrote a block is gone on this machine. The decision itself is pure
// (hooks/session-liveness.ts); this module only does the syscalls.

// How long a start-time lookup may take, per pid. A lookup that fails or times out
// means the process is treated as alive (PM Q5).
const START_LOOKUP_TIMEOUT_MS = 2000

export type ClaimStart = { claimed: number; actual: ProcessStart }

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

// Start-time lookups, cached per `(pid, claimed)` in the board process (PM Q5:
// a live pid's start time is checked once per claim, never once per poll,
// including reused-pid mismatches and failed/timed-out lookups). The key
// carries the claimed start time: two blocks sharing one pid with different
// starts are two claims, so one must not evict the other's lookup (#1406).
// The cache key: one entry per (pid, claimed start), so two blocks sharing
// a reused pid do not overwrite each other's start (#1406). The colon
// disambiguates pid 12 from pid 123. Tests read the cache through this.
export const cacheKey = (pid: number, started: number): string => `${pid}:${started}`
const startedCache = new Map<string, ClaimStart>()

const isAlivePid = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH: no such process. Any other refusal means the process exists or the
    // answer is uncertain, so it is alive: when in doubt the card is kept.
    return (error as { code?: string }).code !== 'ESRCH'
  }
}

// Keys (`blockKey(auto)`) of working/waiting Claude session blocks whose claimed
// agent process is gone on this machine (#1092). The kill runs first for every
// claimed pid; dead pids evict the cache without spawning a start lookup, and
// live pids with an uncached `(pid, started)` share ONE `lookupStart` call.
export const goneBlocksOf = (
  projects: readonly ProgressProject[],
  hostHash: string | null = readingHostHash(),
  cache: Map<string, ClaimStart> = startedCache,
  timeoutMs: number = START_LOOKUP_TIMEOUT_MS,
  lookupStart: (pids: readonly number[], timeoutMs: number) => Map<number, ProcessStart> = processStartedMany,
): ReadonlySet<string> => {
  if (hostHash === null) return new Set()
  const claims = claimedBlocksOf(projects, hostHash)
  const alivePids = new Map<number, boolean>()
  const toLookup = new Set<number>()
  for (const { claim } of claims) {
    let alive = alivePids.get(claim.pid)
    if (alive === undefined) {
      alive = isAlivePid(claim.pid)
      alivePids.set(claim.pid, alive)
      if (!alive) for (const key of [...cache.keys()]) if (key.startsWith(`${claim.pid}:`)) cache.delete(key)
    }
    if (!alive || claim.started === undefined) continue
    const held = cache.get(cacheKey(claim.pid, claim.started))
    if (held === undefined || held.claimed !== claim.started) toLookup.add(claim.pid)
  }
  const freshStarts = toLookup.size > 0 ? lookupStart([...toLookup], timeoutMs) : new Map<number, ProcessStart>()
  for (const { claim } of claims) {
    if (!toLookup.has(claim.pid) || claim.started === undefined) continue
    cache.set(cacheKey(claim.pid, claim.started), { claimed: claim.started, actual: freshStarts.get(claim.pid) ?? null })
  }
  return goneBlocks(projects, claim => {
    const alive = alivePids.get(claim.pid) ?? true
    if (!alive || claim.started === undefined) return { alive, actual: null }
    if (toLookup.has(claim.pid)) return { alive: true, actual: freshStarts.get(claim.pid) ?? null }
    const held = cache.get(cacheKey(claim.pid, claim.started))
    return { alive: true, actual: held !== undefined && held.claimed === claim.started ? held.actual : null }
  }, hostHash)
}

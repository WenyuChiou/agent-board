import { sha256 } from './sha256'

// The liveness of an agent session, as pure data (#1092): whether the agent process
// that wrote a block is gone, from the pid, start time and host hash the block
// carries. The syscall itself lives in the shell (scripts/session-liveness.ts); this
// module only decides, so it stays unit-testable without a process.

export type AgentClaim = { pid: number; started?: number; host: string }

// The host identifier, as a hash, never a plaintext hostname (#1092, PM Q8). The
// platform keeps WSL and Windows apart when they share a hostname and a progress
// file: their pid sets differ, so a pid check must never cross them. `name` is the
// machine's hostname (COMPUTERNAME on Windows, HOSTNAME elsewhere); a machine with
// no name records no identity and keeps the 12 h backstop.
export const hostHashOf = (platform: string, name: string | undefined): string | null => {
  if (name === undefined || name === '') return null
  return sha256(`${platform}:${name.toLowerCase()}`)
}

// A block's liveness claim, validated: a pid that is not a safe positive integer, a
// start time that is not a safe positive epoch, or a host that is not a 64-hex hash
// is no claim at all, so the session keeps the 12 h backstop.
export const agentClaimOf = (auto: { agentPid?: number; agentStarted?: number; host?: string } | null): AgentClaim | null => {
  if (auto === null) return null
  const pid = auto.agentPid
  const host = auto.host
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return null
  if (host === undefined || !/^[0-9a-f]{64}$/.test(host)) return null
  const started = auto.agentStarted
  if (started !== undefined && (!Number.isSafeInteger(started) || started <= 0)) return null
  return { pid, ...(started === undefined ? {} : { started }), host }
}

// How far a live process's start time may drift from the recorded one before the pid
// is judged reused. The same 3000 ms as scripts/local-lock.ts START_DRIFT_MS, which
// guards the same reuse; a change to one should change the other.
export const AGENT_START_DRIFT_MS = 3000

// Whether the agent is dead, from what the shell observed. `alive` is whether
// process.kill(pid, 0) succeeded; `actual` is the live process's start time in epoch
// ms, 'inaccessible' when its start time cannot be read, null when the lookup failed
// or timed out. When in doubt the card is kept: a host mismatch, a missing start time
// with a live pid, and any unreadable start time all mean alive. A dead pid needs no
// start-time check; a live pid with a start time far from the recorded one is a
// reused pid, so it counts as dead.
export const isDeadAgent = (claim: AgentClaim, hostHash: string, alive: boolean, actual: number | 'inaccessible' | null): boolean => {
  if (claim.host !== hostHash) return false
  if (!alive) return true
  if (claim.started === undefined) return false
  if (typeof actual !== 'number') return false
  return Math.abs(actual - claim.started) > AGENT_START_DRIFT_MS
}

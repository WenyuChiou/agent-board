// The page server's idle exit (#1958): when to stop a board nobody has asked for `idleMs`.
//
// The idle check runs on a timer, in the event loop's timers phase. After the loop was held (a slow callback, a busy
// machine), that phase runs before the poll phase reads the requests that queued in the stall, so the last request the
// server saw is stale and a board that was polled all along would stop. A stale reading therefore never stops at once:
// it sets up a re-check IDLE_RECHECK_MS later, and only the re-check can stop the board.
//
// The re-check stops only when it fires on time. A re-check that fires more than IDLE_STALL_MS late saw another stall
// somewhere after the reading (a later timer in the same timers phase, a setImmediate after the poll phase, anything),
// and may itself run before the poll phase that serves what queued in it; it sets up the next re-check instead. A
// re-check on time means the loop ran freely since the one before, through poll phases that read every waiting request:
// a request served there moved the last-seen time, and the board stays. A delivery under way keeps it too.
export const IDLE_RECHECK_MS = 50
export const IDLE_STALL_MS = 100

// A re-check under way: when it was set up, and the last-seen time it was set up with.
export type IdleWatch = { at: number; seen: number }
export type IdleStep = { kind: 'stay' } | { kind: 'recheck'; watch: IdleWatch } | { kind: 'stop' }

export const idleStep = (watch: IdleWatch | null, now: number, lastSeen: number, isBusy: boolean, idleMs: number): IdleStep => {
  if (idleMs <= 0 || isBusy || now - lastSeen <= idleMs) return { kind: 'stay' }
  // A first stale reading, or one after a request that still left the board stale: judge again from here.
  if (watch === null || lastSeen !== watch.seen) return { kind: 'recheck', watch: { at: now, seen: lastSeen } }
  if (now - watch.at > IDLE_RECHECK_MS + IDLE_STALL_MS) return { kind: 'recheck', watch: { at: now, seen: lastSeen } }
  return { kind: 'stop' }
}

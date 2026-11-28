// The page server's idle exit (#1958): when to stop a board nobody has asked for `idleMs`.
//
// The idle check runs on a timer, in the event loop's timers phase. After the loop was held (a slow callback, a busy
// machine), that phase runs before the poll phase reads the requests that queued in the stall, so the last request the
// server saw is stale and a board that was polled all along would stop. A request on a connection of its own takes two
// poll phases: the first accepts the connection, the next reads the request. So a stale reading never stops at once.
//
// It starts a chain of hops, one setImmediate each. A hop runs in the check phase, after the poll phase of its loop
// turn, so IDLE_HOPS hops in a row span that many poll phases, and every request that was waiting when the chain began
// is read, and moves the last-seen time, before the last hop. The chain counts only while the loop runs freely: a hop
// that comes more than IDLE_HOP_STALL_MS after the one before saw a stall (any callback, in any phase), and requests
// that queued in it may still wait unread, so the chain ends there and starts again IDLE_RETRY_MS later, from a new
// reading. Only the last hop of an unbroken chain stops the board, and only if the last-seen time has not moved and no
// delivery is under way. A request that arrives within the chain's last few milliseconds is the race every idle exit
// has; one held by a stall is not, since a stall breaks the chain.
export const IDLE_HOPS = 3
export const IDLE_HOP_STALL_MS = 25
export const IDLE_RETRY_MS = 50

// A chain under way: the last-seen time it started from, when its last hop ran, and how many hops ran.
export type IdleWatch = { seen: number; at: number; hops: number }
// stay: the board is in use, or no limit; hop: run the next hop (setImmediate); retry: a stall broke the chain, judge
// again from a new reading after IDLE_RETRY_MS (setTimeout); stop: the board is idle.
export type IdleStep = { kind: 'stay' } | { kind: 'hop'; watch: IdleWatch } | { kind: 'retry' } | { kind: 'stop' }

export const idleStep = (watch: IdleWatch | null, now: number, lastSeen: number, isBusy: boolean, idleMs: number): IdleStep => {
  if (idleMs <= 0 || isBusy || now - lastSeen <= idleMs) return { kind: 'stay' }
  // A first stale reading, or one after a request that still left the board stale: a new chain from here.
  if (watch === null || lastSeen !== watch.seen) return { kind: 'hop', watch: { seen: lastSeen, at: now, hops: 0 } }
  if (now - watch.at > IDLE_HOP_STALL_MS) return { kind: 'retry' }
  if (watch.hops + 1 >= IDLE_HOPS) return { kind: 'stop' }
  return { kind: 'hop', watch: { seen: lastSeen, at: now, hops: watch.hops + 1 } }
}

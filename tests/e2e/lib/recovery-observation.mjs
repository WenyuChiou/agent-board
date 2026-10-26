import { performance } from 'node:perf_hooks'

const occurrences = (source, literal) => {
  let count = 0
  let from = 0
  while (true) {
    const at = source.indexOf(literal, from)
    if (at < 0) return count
    count += 1
    from = at + literal.length
  }
}

const stateOf = (read, sessions) => {
  const state = read()
  const counts = Object.fromEntries(sessions.map(session => [session, occurrences(state.source, `resume=${session} `)]))
  return { ...state, files: [...state.files].sort(), counts }
}

const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export const observeHookRecovery = async ({ read, sessions, withinMs = 10000, pollMs = 40 }) => {
  const started = performance.now()
  const snapshots = []
  let previous

  while (true) {
    const state = stateOf(read, sessions)
    const elapsedMs = performance.now() - started
    const diagnostic = { counts: state.counts, pending: state.pending, files: state.files }
    if (previous === undefined || !sameState(diagnostic, previous)) {
      snapshots.push({ elapsedMs, ...diagnostic })
      previous = diagnostic
    }

    if (Object.values(state.counts).some(count => count > 1)) {
      return { ...state, snapshots, isSettled: false, hasTimedOut: false }
    }
    if (Object.values(state.counts).every(count => count === 1) && state.pending.length === 0 && elapsedMs < withinMs) {
      return { ...state, snapshots, isSettled: true, hasTimedOut: false }
    }
    if (elapsedMs >= withinMs) {
      return { ...state, snapshots, isSettled: false, hasTimedOut: true }
    }

    await new Promise(done => setTimeout(done, Math.max(0, Math.min(pollMs, withinMs - elapsedMs))))
  }
}

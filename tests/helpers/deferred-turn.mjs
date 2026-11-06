import assert from 'node:assert/strict'

// A hook gives the message store 120 ms and a running board 150 ms. A slower answer defers the
// turn by design, and the next turn does the work (#902). Tests accept one deferred turn and
// check that it really was one; they never raise those limits.

// `mailbox` is hookMailbox's result; `status` reads the message's status from the store.
export const turnOrDeferred = async (mailbox, args, status, beforeNext = () => {}) => {
  const first = await mailbox.turn(...args)
  if (first !== null) return first
  assert.equal(mailbox.hasDeferred, true, 'a turn with no message was not deferred')
  assert.equal(status(), 'queued')
  beforeNext()
  return mailbox.turn(...args)
}

// `run` starts a hook process and resolves to its { status, stdout, stderr }.
export const hookOrDeferred = async (run, isDone) => {
  let result = await run()
  assert.equal(result.status, 0, result.stderr)
  if (await isDone(result)) return result
  assert.match(result.stderr, /^board: mailbox deferred$/m)
  result = await run()
  assert.equal(result.status, 0, result.stderr)
  return result
}

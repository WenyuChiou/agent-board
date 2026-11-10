import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(specifier + '.ts', context)
  }
} })

// The shell half of the #1092 liveness tests: deriving the dead set from real
// pids, and the batched start-time lookup. A .ts test under `claude plugin
// test` may import only `claude-code` and relative hooks modules, never `node:`
// and never `scripts/`, so these live here (plain `node --test`), where the
// imports are allowed. The pure half (the view, the ledger, the marker and the
// decision) lives in tests/session-liveness.test.ts.
const NOW = Date.parse('2026-10-16T12:00:00Z')

// A pid that is dead right now, from a child that already exited. The kill is
// verified, so a reused pid fails loudly instead of passing quietly.
const deadPid = () => {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  assert.notEqual(child.pid, undefined, 'test child did not start')
  assert.throws(() => process.kill(child.pid, 0), (error) => error.code === 'ESRCH', `test pid ${child.pid} is unexpectedly alive`)
  return child.pid
}

// A pid that is alive right now: this test process, with its real start time.
const alivePid = process.pid
const aliveStarted = Math.round(performance.timeOrigin)

const block = (id, agent, state, steps, claim, host) => {
  const attrs = claim === null ? '' : ` agentpid=${claim.pid}${claim.started === undefined ? '' : ` agentstarted=${claim.started}`}${claim.host === undefined ? '' : ` host=${claim.host}`}`
  return `<!-- auto session=${id} agent=${agent} state=${state} updated=${new Date(NOW - 5 * 60_000).toISOString()}${attrs} -->\n### Ship ${id}\n${steps}\n<!-- /auto session=${id} -->\n`
}
const file = (...blocks) => `## demo\n${blocks.join('')}`

test('a waiting approval whose agent process is dead is in the dead set, and a live one is not', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { questionScope } = await import('../hooks/questions.ts')
  const { deadSessionsOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const host = readingHostHash()
  assert.notEqual(host, null, 'this machine has a host hash')
  const pid = deadPid()
  const text = file(
    block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid, started: aliveStarted, host }),
    block('b2c3d4e5', 'claude', 'waiting', '- [?] Continue with the synthetic plan, OK?', { pid: alivePid, started: aliveStarted, host }),
  )
  const dead = deadSessionsOf(parseProgress(text))
  assert.deepEqual([...dead], [questionScope('demo', 'claude', 'a1b2c3d4')])
})

test('a batched start-time lookup returns each live pid start time and null for a dead pid', async () => {
  const { cachedProcessStartedMany, processStartedMany } = await import('../scripts/local-lock.ts')
  const pid = deadPid()
  const starts = processStartedMany([alivePid, pid], 2000)
  assert.equal(starts.get(alivePid), aliveStarted)
  assert.equal(starts.get(pid), null)
  // The cached batch reuses a pid already looked up and never looks it up again.
  const cache = new Map()
  assert.equal(cachedProcessStartedMany([alivePid], cache, 2000).get(alivePid), aliveStarted)
  assert.equal(cache.has(alivePid), true)
  const second = cachedProcessStartedMany([alivePid, pid], cache, 2000)
  assert.equal(second.get(alivePid), aliveStarted)
  assert.equal(second.get(pid), null)
})

test('a session whose host hash differs from the reading machine is never in the dead set', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { deadSessionsOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const { sha256 } = await import('../hooks/sha256.ts')
  const host = readingHostHash()
  const otherHost = sha256('another-machine')
  assert.notEqual(otherHost, host)
  const pid = deadPid()
  const text = file(block('a7b8c9d0', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid, started: aliveStarted, host: otherHost }))
  assert.deepEqual([...deadSessionsOf(parseProgress(text))], [])
})

test('a non-Claude session is never in the dead set, even when its block carries pid fields', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { deadSessionsOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const host = readingHostHash()
  const pid = deadPid()
  const text = file(block('b8c9d0e1', 'codex', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid, started: aliveStarted, host }))
  assert.deepEqual([...deadSessionsOf(parseProgress(text))], [])
})

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(specifier + '.ts', context)
  }
} })

// The shell half of the #1092 liveness tests: deriving `gone` from real pids,
// the batched ClaimStart lookup cache, CLI archive kept-question counts, and the
// source-scan pinning every view/write caller.
const NOW = Date.parse('2026-10-16T12:00:00Z')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const deadPid = () => {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  assert.notEqual(child.pid, undefined, 'test child did not start')
  assert.throws(() => process.kill(child.pid, 0), (error) => error.code === 'ESRCH', `test pid ${child.pid} is unexpectedly alive`)
  return child.pid
}

const alivePid = process.pid
const aliveStarted = Math.round(performance.timeOrigin)

const block = (id, agent, state, steps, claim, minutes = 5, resume = null) => {
  const attrs = claim === null ? '' : ` agentpid=${claim.pid}${claim.started === undefined ? '' : ` agentstarted=${claim.started}`}${claim.host === undefined ? '' : ` host=${claim.host}`}`
  return `<!-- auto session=${id} agent=${agent} state=${state} updated=${new Date(NOW - minutes * 60_000).toISOString()}${resume === null ? '' : ` resume=${resume}`}${attrs} -->\n### Ship ${id}\n${steps}\n<!-- /auto session=${id} -->\n`
}
const file = (...blocks) => `## demo\n${blocks.join('')}`

test('a waiting approval whose agent process is dead is in goneBlocksOf, and a live one is not', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const { goneBlocksOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const host = readingHostHash()
  assert.notEqual(host, null, 'this machine has a host hash')
  const pid = deadPid()
  const text = file(
    block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid, started: aliveStarted, host }),
    block('b2c3d4e5', 'claude', 'waiting', '- [?] Continue with the synthetic plan, OK?', { pid: alivePid, started: aliveStarted, host }),
  )
  const projects = parseProgress(text)
  const gone = goneBlocksOf(projects)
  assert.deepEqual([...gone], [blockKey(projects[0].tasks[0].auto)])
})

test('a batched start-time lookup returns each live pid start time and null for a dead pid', async () => {
  const { cachedProcessStartedMany, processStartedMany } = await import('../scripts/local-lock.ts')
  const pid = deadPid()
  const starts = processStartedMany([alivePid, pid], 2000)
  assert.equal(starts.get(alivePid), aliveStarted)
  assert.equal(starts.get(pid), null)
  const cache = new Map()
  assert.equal(cachedProcessStartedMany([alivePid], cache, 2000).get(alivePid), aliveStarted)
  assert.equal(cache.has(alivePid), true)
  const second = cachedProcessStartedMany([alivePid, pid], cache, 2000)
  assert.equal(second.get(alivePid), aliveStarted)
  assert.equal(second.get(pid), null)
})

test('a session whose host hash differs from the reading machine is never in goneBlocksOf', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { goneBlocksOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const { sha256 } = await import('../hooks/sha256.ts')
  const host = readingHostHash()
  const otherHost = sha256('another-machine')
  assert.notEqual(otherHost, host)
  const pid = deadPid()
  const text = file(block('a7b8c9d0', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid, started: aliveStarted, host: otherHost }))
  assert.deepEqual([...goneBlocksOf(parseProgress(text))], [])
})

test('a non-Claude session is never in goneBlocksOf, even when its block carries pid fields', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { goneBlocksOf } = await import('../scripts/session-liveness.ts')
  const { readingHostHash } = await import('../scripts/session-liveness.ts')
  const host = readingHostHash()
  const pid = deadPid()
  const text = file(block('b8c9d0e1', 'codex', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid, started: aliveStarted, host }))
  assert.deepEqual([...goneBlocksOf(parseProgress(text))], [])
})

test('a dead pid deletes its cached ClaimStart, so a later session reusing the pid is looked up again', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const { goneBlocksOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const host = readingHostHash()
  const pid = deadPid()
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid, started: aliveStarted, host }))
  const projects = parseProgress(text)
  const cache = new Map([[pid, { claimed: aliveStarted, actual: aliveStarted }]])
  assert.deepEqual([...goneBlocksOf(projects, host, cache)], [blockKey(projects[0].tasks[0].auto)])
  assert.equal(cache.has(pid), false)
})

test('a dead duplicate keeps only its own blockKey gone, and a colliding short id keeps the live one out of goneBlocksOf', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const { goneBlocksOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const host = readingHostHash()
  const resume = '1111111111111111111111111111111111111111111111111111111111111111'
  const dead = deadPid()
  const twinText = file(
    block('c3d4e5f6', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: dead, started: aliveStarted, host }, 9, resume),
    block('c3d4e5f6', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: alivePid, started: aliveStarted, host }, 5, resume),
  )
  const twinProjects = parseProgress(twinText)
  assert.deepEqual([...goneBlocksOf(twinProjects)], [blockKey(twinProjects[0].tasks[0].auto)])
  const otherResume = '2222222222222222222222222222222222222222222222222222222222222222'
  const collisionText = file(
    block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: alivePid, started: aliveStarted, host }, 5, resume),
    block('a1b2c3d4', 'claude', 'waiting', '- [?] Which plan, A or B?', { pid: dead, started: aliveStarted, host }, 5, otherResume),
  )
  const collisionProjects = parseProgress(collisionText)
  assert.deepEqual([...goneBlocksOf(collisionProjects)], [blockKey(collisionProjects[0].tasks[1].auto)])
})

// Fable Section 3 Tests 4 & 5: injected lookupStart runs once over 3 reads for reused pid and failed lookup,
// and re-queries once when claim.started changes on pid reuse.
test('injected lookupStart runs once over three reads for both a reused pid and a failed lookup, and re-queries once when claim.started changes (#1092)', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const { goneBlocksOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const host = readingHostHash()

  // Test 4: reused pid (actual !== claimed) cached once over 3 reads
  const reusedProjects = parseProgress(file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: alivePid, started: aliveStarted - 60_000, host })))
  const reusedKey = blockKey(reusedProjects[0].tasks[0].auto)
  let reusedCalls = 0
  const reusedCache = new Map()
  const reusedLookup = (pids) => {
    reusedCalls += 1
    return new Map(pids.map(pid => [pid, pid === alivePid ? aliveStarted : null]))
  }
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual([...goneBlocksOf(reusedProjects, host, reusedCache, 2000, reusedLookup)], [reusedKey])
  }
  assert.equal(reusedCalls, 1)
  assert.deepEqual(reusedCache.get(alivePid), { claimed: aliveStarted - 60_000, actual: aliveStarted })

  // Test 5: failed lookup (null) cached once over 3 reads, then re-queries once on a new claim.started
  const timeoutCache = new Map()
  let timeoutCalls = 0
  let lookupResult = null
  const flakyLookup = (pids) => {
    timeoutCalls += 1
    return new Map(pids.map(pid => [pid, lookupResult]))
  }
  const firstClaim = parseProgress(file(block('b2c3d4e5', 'claude', 'waiting', '- [?] Ship it, OK?', { pid: alivePid, started: aliveStarted - 60_000, host })))
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual([...goneBlocksOf(firstClaim, host, timeoutCache, 2000, flakyLookup)], [])
  }
  assert.equal(timeoutCalls, 1)
  assert.deepEqual(timeoutCache.get(alivePid), { claimed: aliveStarted - 60_000, actual: null })

  // New session claim reusing the same pid triggers ONE fresh lookup and sees it alive cleanly.
  lookupResult = aliveStarted
  const nextClaim = parseProgress(file(block('b2c3d4e5', 'claude', 'waiting', '- [?] Ship it, OK?', { pid: alivePid, started: aliveStarted, host })))
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual([...goneBlocksOf(nextClaim, host, timeoutCache, 2000, flakyLookup)], [])
  }
  assert.equal(timeoutCalls, 2)
  assert.deepEqual(timeoutCache.get(alivePid), { claimed: aliveStarted, actual: aliveStarted })
})

// Fable Section 3 Test 11: board-cli archive of a stopped dead row keeps its unanswered question and reports kept count.
test('board-cli archive of a stopped dead row keeps its unanswered question and reports kept count (#1092)', async () => {
  const { BOARD_SCRIPT } = await import('../hooks/board-script.ts')
  const { readingHostHash } = await import('../scripts/session-liveness.ts')
  const dir = mkdtempSync(join(tmpdir(), 'ab-liveness-archive-'))
  try {
    const host = readingHostHash()
    const dead = deadPid()
    const progressPath = join(dir, 'progress.md')
    const scriptPath = join(dir, 'agent-board.mjs')
    const markdown = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: dead, started: aliveStarted, host }))
    writeFileSync(progressPath, markdown, 'utf8')
    const header = `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progressPath, lang: 'en' })}\nDate.now = () => ${NOW}\n`
    writeFileSync(scriptPath, header + BOARD_SCRIPT, 'utf8')
    const ran = spawnSync(process.execPath, [scriptPath, '--lang', 'en', '--keys', 'i down a'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' },
      timeout: 60_000,
    })
    assert.equal(ran.status, 0, ran.stderr)
    assert.match(ran.stdout, /Archived “Ship a1b2c3d4”\. Its unanswered question stays under Older\s+unanswered/)
    assert.equal(readFileSync(progressPath, 'utf8').includes('Ship a1b2c3d4'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// Fable Section 3 Test 12: source-scan pinning every buildView(, views.view(, takeTask( and confirmTask( call site in both shells.
test('source-scan pins every buildView, views.view, takeTask and confirmTask call site in register.tsx and board-cli.ts (#1092)', () => {
  const countMatches = (text, pattern) => [...text.matchAll(pattern)].length
  const register = readFileSync(join(ROOT, 'hooks/register.tsx'), 'utf8')
  const boardCli = readFileSync(join(ROOT, 'scripts/board-cli.ts'), 'utf8')

  // hooks/register.tsx: only `boardView` calls buildView( and views.view(; write guards pass `gone` / `retryGone`.
  assert.equal(countMatches(register, /\bbuildView\(/g), 1)
  assert.equal(countMatches(register, /\bviews\.view\(/g), 1)
  assert.equal(countMatches(register, /\btakeTask\(/g), 1)
  assert.equal(countMatches(register, /\bconfirmTask\(/g), 2)
  assert.match(register, /return cached \? views\.view\(\.\.\.args\) : buildView\(\.\.\.args\)/)
  assert.match(register, /takeTask\(text, ref, at, s, observed, undefined, gone\)/)
  assert.match(register, /confirmTask\(original, ref, at, s, observed, undefined, gone\)/)
  assert.match(register, /confirmTask\(text, ref, at, s, observed, undefined, retryGone\)/)

  // scripts/board-cli.ts: only `viewFor` calls buildView(, never views.view(; write guards pass `gone`.
  assert.equal(countMatches(boardCli, /\bbuildView\(/g), 1)
  assert.equal(countMatches(boardCli, /\bviews\.view\(/g), 0)
  assert.equal(countMatches(boardCli, /\bconfirmTask\(/g), 1)
  assert.equal(countMatches(boardCli, /\btakeTask\(/g), 2)
  assert.match(boardCli, /\): View => buildView\([^;]+, gone\)/)
  assert.match(boardCli, /confirmTask\(text, action\.ref, now, s, lastSeen, staleTimeoutMs\(\), gone\)/)
  assert.match(boardCli, /takeTask\(text, action\.ref, now, s, lastSeen, staleTimeoutMs\(\), gone\)/)
  assert.match(boardCli, /takeTask\(text, fresh\.ref, now, s, \{\}, staleMs, gone\)/)
})

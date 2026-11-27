import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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

test('two blocks sharing one live pid with different start times look the start up once', async () => {
  // Greptile P2 on #1406: the cache was keyed by pid only, so one claim
  // always missed and every unchanged poll repeated the lookup (a
  // PowerShell launch on Windows). Each (pid, started) pair is cached now.
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const { goneBlocksOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const { processStartedMany } = await import('../scripts/local-lock.ts')
  const host = readingHostHash()
  assert.notEqual(host, null, 'this machine has a host hash')
  const text = file(
    block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: alivePid, started: aliveStarted, host }),
    block('b2c3d4e5', 'claude', 'waiting', '- [?] Continue with the synthetic plan, OK?', { pid: alivePid, started: aliveStarted + 60_000, host }),
  )
  const projects = parseProgress(text)
  const cache = new Map()
  let lookups = 0
  const lookupStart = (pids, timeoutMs) => {
    lookups += 1
    return processStartedMany(pids, timeoutMs)
  }
  const first = goneBlocksOf(projects, host, cache, 2000, lookupStart)
  const second = goneBlocksOf(projects, host, cache, 2000, lookupStart)
  assert.equal(lookups, 1, 'the second unchanged poll must not repeat the start lookup')
  assert.deepEqual([...second], [...first])
  assert.deepEqual([...first], [blockKey(projects[0].tasks[1].auto)], 'only the reused-pid block is gone')
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

test('an agent that names no process of its own is never in goneBlocksOf, even when its block carries pid fields', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { goneBlocksOf } = await import('../scripts/session-liveness.ts')
  const { readingHostHash } = await import('../scripts/session-liveness.ts')
  const host = readingHostHash()
  const pid = deadPid()
  const text = file(block('b8c9d0e1', 'grok', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid, started: aliveStarted, host }))
  assert.deepEqual([...goneBlocksOf(parseProgress(text))], [])
})

test('a Codex session with a process record is judged like Claude Code: a dead process is gone, a live one stays (#1092)', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const { goneBlocksOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const host = readingHostHash()
  const pid = deadPid()
  // Same short id as an OpenCode block: only the Codex block whose process is dead is gone.
  const text = file(
    block('b8c9d0e1', 'codex', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid, started: aliveStarted, host }),
    block('c9d0e1f2', 'codex', 'waiting', '- [?] Continue with the synthetic plan, OK?', { pid: alivePid, started: aliveStarted, host }),
    block('b8c9d0e1', 'opencode', 'waiting', '- [?] Keep the synthetic notes, OK?', { pid: alivePid, started: aliveStarted, host }),
  )
  const projects = parseProgress(text)
  assert.deepEqual([...goneBlocksOf(projects, host, new Map())], [blockKey(projects[0].tasks[0].auto)])
})

test('a dead pid deletes its cached ClaimStart, so a later session reusing the pid is looked up again', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const { goneBlocksOf, readingHostHash, cacheKey } = await import('../scripts/session-liveness.ts')
  const host = readingHostHash()
  const pid = deadPid()
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid, started: aliveStarted, host }))
  const projects = parseProgress(text)
  const cache = new Map([[cacheKey(pid, aliveStarted), { claimed: aliveStarted, actual: aliveStarted }]])
  assert.deepEqual([...goneBlocksOf(projects, host, cache)], [blockKey(projects[0].tasks[0].auto)])
  assert.equal(cache.has(cacheKey(pid, aliveStarted)), false)
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
  const { goneBlocksOf, readingHostHash, cacheKey } = await import('../scripts/session-liveness.ts')
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
  assert.deepEqual(reusedCache.get(cacheKey(alivePid, aliveStarted - 60_000)), { claimed: aliveStarted - 60_000, actual: aliveStarted })

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
  assert.deepEqual(timeoutCache.get(cacheKey(alivePid, aliveStarted - 60_000)), { claimed: aliveStarted - 60_000, actual: null })

  // New session claim reusing the same pid triggers ONE fresh lookup and sees it alive cleanly.
  lookupResult = aliveStarted
  const nextClaim = parseProgress(file(block('b2c3d4e5', 'claude', 'waiting', '- [?] Ship it, OK?', { pid: alivePid, started: aliveStarted, host })))
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual([...goneBlocksOf(nextClaim, host, timeoutCache, 2000, flakyLookup)], [])
  }
  assert.equal(timeoutCalls, 2)
  assert.deepEqual(timeoutCache.get(cacheKey(alivePid, aliveStarted)), { claimed: aliveStarted, actual: aliveStarted })
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
  assert.match(boardCli, /takeTask\(text, fresh\.ref, now, s, \{\}, staleMs, gone, false\)/)
})

// #1589 Test 1: Stop extracts closing question after tool-call PLANNER_RESPONSE entries without content.
test('Antigravity Stop extracts the closing question after tool-call PLANNER_RESPONSE entries without content (#1589)', async () => {
  const { BOARD_SCRIPT } = await import('../hooks/board-script.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { EN } = await import('../hooks/strings-en.ts')
  const home = mkdtempSync(join(tmpdir(), 'ab-1589-q-'))
  try {
    const root = join(home, '.agent-board')
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    mkdirSync(root, { recursive: true })
    writeFileSync(progress, '')
    writeFileSync(script, BOARD_SCRIPT)
    const transcript = join(home, '.gemini', 'antigravity-cli', 'brain', 'synthetic-conv-q', '.system_generated', 'logs', 'transcript_full.jsonl')
    mkdirSync(dirname(transcript), { recursive: true })
    const entries = [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Synthetic ask\nPRIVATE-PROMPT-LINE' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ id: '1', name: 'ask_question' }] },
      { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'User did not answer via tool.' },
      { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'SYNTHETIC-REPLY-BODY\n\nBlue or green?' },
    ]
    writeFileSync(transcript, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const env = { ...process.env, HOME: home, USERPROFILE: home, LANG: 'en', CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }
    const ran = spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress, '--agent', 'antigravity', '--agent-status', '--state', 'waiting', '--event', 'Stop'], {
      cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      input: JSON.stringify({ conversationId: 'synthetic-agy-tool-question', transcriptPath: transcript }),
    })
    assert.equal(ran.status, 0, ran.stderr)
    const progressText = readFileSync(progress, 'utf8')
    assert.match(progressText, /- \[\?\] Blue or green\?/)
    assert.equal(progressText.includes('PRIVATE-PROMPT-LINE'), false)
    assert.equal(progressText.includes('SYNTHETIC-REPLY-BODY'), false)
    const view = buildView(parseProgress(progressText), [], null, Date.now(), 0, {}, EN)
    assert.deepEqual(view.waiting.map(item => item.text), ['Blue or green?'])
    assert.deepEqual(view.waiting[0].options, ['Blue', 'green'])
    assert.equal(view.groups.flatMap(group => group.rows).filter(row => row.auto === 'working').length, 0)

    // Non-string object content on PLANNER_RESPONSE remains rejected as malformed.
    const badTranscript = join(home, '.gemini', 'antigravity-cli', 'brain', 'synthetic-conv-bad', '.system_generated', 'logs', 'transcript.jsonl')
    mkdirSync(dirname(badTranscript), { recursive: true })
    writeFileSync(badTranscript, [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Synthetic bad' },
      { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Old question?' },
      { source: 'MODEL', type: 'PLANNER_RESPONSE', content: { text: 'Invalid reply shape' } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const badRan = spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress, '--agent', 'antigravity', '--agent-status', '--state', 'waiting', '--event', 'Stop'], {
      cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      input: JSON.stringify({ conversationId: 'synthetic-agy-bad-reply-1589', transcriptPath: badTranscript }),
    })
    assert.equal(badRan.status, 0, badRan.stderr)
    const badRecord = JSON.parse(readFileSync(join(root, 'sessions', createHash('sha256').update('antigravity:synthetic-agy-bad-reply-1589').digest('hex') + '.json'), 'utf8'))
    assert.equal(badRecord.asked, undefined)

    // Trailing content-less tool-call PLANNER_RESPONSE clears an earlier question.
    const trailingToolTranscript = join(home, '.gemini', 'antigravity-cli', 'brain', 'synthetic-conv-trailing-tool', '.system_generated', 'logs', 'transcript_full.jsonl')
    mkdirSync(dirname(trailingToolTranscript), { recursive: true })
    writeFileSync(trailingToolTranscript, [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Synthetic tool tail' },
      { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Earlier question?' },
      { source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ id: '2', name: 'run_command' }] },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const trailingRan = spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress, '--agent', 'antigravity', '--agent-status', '--state', 'waiting', '--event', 'Stop'], {
      cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      input: JSON.stringify({ conversationId: 'synthetic-agy-trailing-tool-1589', transcriptPath: trailingToolTranscript }),
    })
    assert.equal(trailingRan.status, 0, trailingRan.stderr)
    const trailingRecord = JSON.parse(readFileSync(join(root, 'sessions', createHash('sha256').update('antigravity:synthetic-agy-trailing-tool-1589').digest('hex') + '.json'), 'utf8'))
    assert.equal(trailingRecord.asked, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// #1589 Test 2: Windows Antigravity CLI working row ends when presence lock is unlocked, stays live while locked/missing or foreign-host.
test('Windows Antigravity CLI working row ends when its presence lock is unlocked and stays live while locked or missing (#1589)', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { isWorkingTask } = await import('../hooks/grouping.ts')
  const { takeTask } = await import('../hooks/blocks.ts')
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const { deriveRowState, livenessOf } = await import('../hooks/row-state.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { EN } = await import('../hooks/strings-en.ts')
  const { sha256 } = await import('../hooks/sha256.ts')
  const { goneBlocksOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const home = mkdtempSync(join(tmpdir(), 'ab-1589-win-'))
  try {
    const host = readingHostHash()
    assert.notEqual(host, null)
    const otherHost = sha256('win32:another-host')
    const resume = '11111111-2222-4333-8444-555555555555'
    const text = file(`<!-- auto session=a1b2c3d4 agent=antigravity state=working updated=${new Date(NOW - 5 * 60_000).toISOString()} resume=${resume} host=${host} -->\n### Ship a1b2c3d4\n- [~] Working in progress\n<!-- /auto session=a1b2c3d4 -->\n`)
    const projects = parseProgress(text)
    const auto = projects[0].tasks[0].auto
    const noopLookup = () => new Map()
    assert.equal(isWorkingTask(projects[0].tasks[0].steps, auto.updated, NOW), true)

    for (const state of ['locked', 'missing']) {
      const gone = goneBlocksOf(projects, host, new Map(), 2000, noopLookup, { home, platform: 'win32', presenceProbe: () => state })
      assert.deepEqual([...gone], [], `${state} lock keeps working row alive`)
      assert.equal(livenessOf(auto, gone), 'unknown')
      const view = buildView(projects, [], null, NOW, 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, gone)
      assert.equal(view.groups.flatMap(g => g.rows).find(r => r.title === 'Ship a1b2c3d4')?.auto, 'working')
      assert.equal(view.stopped.length, 0)
    }

    const desktopText = file(`<!-- auto session=a1b2c3d4 agent=antigravity state=working updated=${new Date(NOW - 5 * 60_000).toISOString()} resume=${resume} -->\n### Ship a1b2c3d4\n- [~] Working in progress\n<!-- /auto session=a1b2c3d4 -->\n`)
    const desktopGone = goneBlocksOf(parseProgress(desktopText), host, new Map(), 2000, noopLookup, { home, platform: 'win32', presenceProbe: () => 'unlocked' })
    assert.deepEqual([...desktopGone], [])

    const foreignText = file(`<!-- auto session=a1b2c3d4 agent=antigravity state=working updated=${new Date(NOW - 5 * 60_000).toISOString()} resume=${resume} host=${otherHost} -->\n### Ship a1b2c3d4\n- [~] Working in progress\n<!-- /auto session=a1b2c3d4 -->\n`)
    const foreignGone = goneBlocksOf(parseProgress(foreignText), host, new Map(), 2000, noopLookup, { home, platform: 'win32', presenceProbe: () => 'unlocked' })
    assert.deepEqual([...foreignGone], [])

    const probedPaths = []
    const gone = goneBlocksOf(projects, host, new Map(), 2000, noopLookup, {
      home,
      platform: 'win32',
      presenceProbe: (lockPath) => { probedPaths.push(lockPath); return 'unlocked' },
    })
    assert.deepEqual(probedPaths, [join(home, '.gemini', 'antigravity-cli', 'presence', `${resume}.lock`)])
    assert.deepEqual([...gone], [blockKey(auto)])
    assert.equal(livenessOf(auto, gone), 'dead')
    assert.equal(deriveRowState({ auto, steps: projects[0].tasks[0].steps, mirror: null, events: { hasSessionEnd: false, lastEventAt: NOW - 5 * 60_000, host: 'antigravity' }, liveness: livenessOf(auto, gone), now: NOW, hasOpenAsk: false }), 'ended')
    const view = buildView(projects, [], null, NOW, 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, gone)
    const stoppedRow = view.stopped.find(r => r.title === 'Ship a1b2c3d4')
    assert.ok(stoppedRow, 'unlocked lock moves working row to stopped')
    assert.equal(stoppedRow.auto, 'ended')
    assert.equal(stoppedRow.isProcessGone, true)
    assert.notEqual(stoppedRow.archive, null)
    assert.equal(takeTask(text, stoppedRow.archive, NOW, EN, {}, undefined, new Set()), null)
    const archived = takeTask(text, stoppedRow.archive, NOW, EN, {}, undefined, gone)
    assert.notEqual(archived, null)
    assert.equal(archived.text.includes('Ship a1b2c3d4'), false)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// #1589 Test 3: Exited agy run ends a question-free waiting row while keeping a closing question card in Needs you.
test('exited Antigravity CLI run ends a question-free waiting row while keeping a closing question card in Needs you (#1589)', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { EN } = await import('../hooks/strings-en.ts')
  const { goneBlocksOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const home = mkdtempSync(join(tmpdir(), 'ab-1589-wait-'))
  try {
    const host = readingHostHash()
    const dead = deadPid()
    const plainResume = '22222222-3333-4444-8555-666666666666'
    const askResume = '33333333-4444-4555-8666-777777777777'

    // Windows presence-lock mode
    const winText = file(
      `<!-- auto session=a1b2c3d4 agent=antigravity state=waiting updated=${new Date(NOW - 5 * 60_000).toISOString()} resume=${plainResume} host=${host} -->\n### Ship plain\n- [ ] Waiting for the next instruction\n<!-- /auto session=a1b2c3d4 -->\n`,
      `<!-- auto session=b2c3d4e5 agent=antigravity state=waiting updated=${new Date(NOW - 5 * 60_000).toISOString()} resume=${askResume} host=${host} -->\n### Ship question\n- [?] Blue or green?\n<!-- /auto session=b2c3d4e5 -->\n`,
    )
    const winProjects = parseProgress(winText)
    const winGone = goneBlocksOf(winProjects, host, new Map(), 2000, () => new Map(), { home, platform: 'win32', presenceProbe: () => 'unlocked' })
    assert.deepEqual([...winGone], [blockKey(winProjects[0].tasks[0].auto)])
    const winView = buildView(winProjects, [], null, NOW, 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, winGone)
    assert.deepEqual(winView.waiting.map(item => item.text), ['Blue or green?'])
    assert.equal(winView.stopped.find(row => row.title === 'Ship plain')?.auto, 'ended')
    assert.equal(winView.groups.flatMap(g => g.rows).filter(row => row.auto === 'working').length, 0)

    // Linux dead-PID claim mode
    const linuxText = file(
      block('c3d4e5f6', 'antigravity', 'waiting', '- [ ] Waiting for the next instruction', { pid: dead, started: aliveStarted, host }, 5, plainResume),
      block('d4e5f6a7', 'antigravity', 'waiting', '- [?] Blue or green?', { pid: dead, started: aliveStarted, host }, 5, askResume),
    )
    const linuxProjects = parseProgress(linuxText)
    const linuxGone = goneBlocksOf(linuxProjects, host, new Map(), 2000, () => new Map(), { platform: 'linux' })
    assert.deepEqual([...linuxGone], [blockKey(linuxProjects[0].tasks[0].auto)])
    const linuxView = buildView(linuxProjects, [], null, NOW, 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, linuxGone)
    assert.deepEqual(linuxView.waiting.map(item => item.text), ['Blue or green?'])
    assert.equal(linuxView.stopped.find(row => row.title === 'Ship c3d4e5f6')?.auto, 'ended')
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// #1589 Test 4: Linux /proc parent walk finds agy without spawning and stops on shared daemons or non-agy executables.
test('findAgyProcess finds an agy parent without spawning and stops on shared daemons or non-agy executables (#1589)', async () => {
  const { parseLinuxProcStat, findAgyProcess } = await import('../scripts/antigravity-meta.ts')

  const parsed = parseLinuxProcStat('123 (my (proc) 1) S 45 67 89 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 987654 12345')
  assert.deepEqual(parsed, { ppid: 45, startTicks: 987654 })
  assert.equal(parseLinuxProcStat('broken line'), null)

  const readerFrom = (table) => (pid) => table[pid] ?? null
  assert.deepEqual(findAgyProcess(200, readerFrom({
    200: { ppid: 150, startTicks: 20, comm: 'sh', exe: '/bin/sh' },
    150: { ppid: 1, startTicks: 10, comm: 'agy', exe: '/usr/local/bin/agy' },
  })), { pid: 150, startTicks: 10 })

  assert.deepEqual(findAgyProcess(200, readerFrom({
    200: { ppid: 150, startTicks: 20, comm: 'sh', exe: '/bin/sh' },
    150: { ppid: 1, startTicks: 11, comm: 'agy', exe: '/usr/local/bin/agy (deleted)' },
  })), { pid: 150, startTicks: 11 })

  // Shared daemon stops the walk even if an agy ancestor sits above it.
  assert.equal(findAgyProcess(300, readerFrom({
    300: { ppid: 200, startTicks: 30, comm: 'sh', exe: '/bin/sh' },
    200: { ppid: 100, startTicks: 20, comm: 'language_server_linux_x64', exe: '/opt/antigravity/language_server_linux_x64' },
    100: { ppid: 1, startTicks: 10, comm: 'agy', exe: '/usr/local/bin/agy' },
  })), null)

  assert.equal(findAgyProcess(200, readerFrom({
    200: { ppid: 100, startTicks: 20, comm: 'antigravity', exe: '/usr/bin/antigravity' },
  })), null)

  // Node script whose comm was spoofed to 'agy' is rejected by exe basename.
  assert.equal(findAgyProcess(200, readerFrom({
    200: { ppid: 100, startTicks: 20, comm: 'sh', exe: '/bin/sh' },
    100: { ppid: 1, startTicks: 10, comm: 'agy', exe: '/usr/bin/node', cmdline: ['/usr/bin/node', '/tmp/agy'] },
  })), null)

  // Cycle, pid 1, unreadable entry, and chain > 16 steps all return null safely.
  assert.equal(findAgyProcess(10, readerFrom({
    10: { ppid: 11, startTicks: 1, comm: 'sh', exe: '/bin/sh' },
    11: { ppid: 10, startTicks: 2, comm: 'bash', exe: '/bin/bash' },
  })), null)
  assert.equal(findAgyProcess(1, readerFrom({ 1: { ppid: 0, startTicks: 1, comm: 'agy', exe: '/usr/bin/agy' } })), null)
  assert.equal(findAgyProcess(200, readerFrom({ 200: { ppid: 199, startTicks: 1, comm: 'sh', exe: '/bin/sh' } })), null)
  const deep = { 1: { ppid: 0, startTicks: 1, comm: 'agy', exe: '/usr/bin/agy' } }
  for (let p = 2; p <= 20; p += 1) deep[p] = { ppid: p - 1, startTicks: p, comm: 'sh', exe: '/bin/sh' }
  deep[2].comm = 'agy'
  deep[2].exe = '/usr/bin/agy'
  assert.equal(findAgyProcess(20, readerFrom(deep)), null)
})

// #1589 Test 5: probeAntigravityPresenceLock safety and Antigravity claim persistence vs Desktop App clearing.
test('probeAntigravityPresenceLock handles missing, directory and unlocked files safely, and antigravity claims persist and clear on desktop events (#1589)', async () => {
  const { BOARD_SCRIPT } = await import('../hooks/board-script.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockClaimOf, putCodexBlock } = await import('../hooks/codex.ts')
  const { agentClaimOf } = await import('../hooks/session-liveness.ts')
  const { probeAntigravityPresenceLock, readingHostHash } = await import('../scripts/session-liveness.ts')
  const home = mkdtempSync(join(tmpdir(), 'ab-1589-claim-'))
  try {
    const dirLock = join(home, 'dir.lock')
    mkdirSync(dirLock, { recursive: true })
    assert.equal(probeAntigravityPresenceLock(join(home, 'nonexistent.lock')), 'missing')
    assert.equal(probeAntigravityPresenceLock(dirLock), 'missing')
    const emptyLock = join(home, 'empty.lock')
    writeFileSync(emptyLock, '')
    assert.equal(probeAntigravityPresenceLock(emptyLock), 'unlocked')
    assert.equal(readFileSync(emptyLock, 'utf8'), '')

    const host = readingHostHash()
    assert.notEqual(host, null)
    const session = 'synthetic-agy-claim-1589'
    const owner = createHash('sha256').update(`antigravity:${session}`).digest('hex')
    const claimedMd = putCodexBlock('', {
      session,
      agent: 'antigravity',
      project: 'antigravity',
      title: 'Local Antigravity task',
      state: 'working',
      updated: new Date(NOW).toISOString(),
      steps: ['- [~] Working in progress'],
    }, owner, false, undefined, v => v, { pid: alivePid, started: aliveStarted, host })
    assert.deepEqual(blockClaimOf(claimedMd, owner, 'antigravity', session), { pid: alivePid, started: aliveStarted, host })
    assert.deepEqual(agentClaimOf(parseProgress(claimedMd)[0].tasks[0].auto), { pid: alivePid, started: aliveStarted, host })

    const root = join(home, '.agent-board')
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    mkdirSync(root, { recursive: true })
    writeFileSync(progress, claimedMd)
    writeFileSync(script, BOARD_SCRIPT)
    const desktopTranscript = join(home, '.gemini', 'antigravity', 'brain', session, '.system_generated', 'logs', 'transcript.jsonl')
    mkdirSync(dirname(desktopTranscript), { recursive: true })
    writeFileSync(desktopTranscript, JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Desktop resume' }) + '\n')
    const env = { ...process.env, HOME: home, USERPROFILE: home, LANG: 'en', CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }

    // Non-deadline replay preserves the existing claim.
    const replay = spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress, '--agent', 'antigravity', '--agent-status', '--state', 'working', '--event', 'PreInvocation'], {
      cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      input: JSON.stringify({ conversationId: session, transcriptPath: desktopTranscript }),
    })
    assert.equal(replay.status, 0, replay.stderr)
    assert.deepEqual(blockClaimOf(readFileSync(progress, 'utf8'), owner, 'antigravity', session), { pid: alivePid, started: aliveStarted, host })

    // Live Desktop App PreInvocation (--hook-deadline set) clears the older CLI PID claim.
    const liveDesktop = spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress, '--agent', 'antigravity', '--agent-status', '--state', 'working', '--event', 'PreInvocation', '--hook-deadline', String(Date.now() + 30_000)], {
      cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      input: JSON.stringify({ conversationId: session, transcriptPath: desktopTranscript }),
    })
    assert.equal(liveDesktop.status, 0, liveDesktop.stderr)
    assert.equal(blockClaimOf(readFileSync(progress, 'utf8'), owner, 'antigravity', session), null)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// #1589 Test 6: End-to-end board-cli --json shows the question card and ends an exited working agy -p row.
test('board-cli --json shows the agy -p question card and ends an exited working agy -p row end-to-end (#1589)', async () => {
  const { BOARD_SCRIPT } = await import('../hooks/board-script.ts')
  const { readingHostHash } = await import('../scripts/session-liveness.ts')
  const home = mkdtempSync(join(tmpdir(), 'ab-1589-e2e-'))
  try {
    const host = readingHostHash()
    assert.notEqual(host, null)
    const root = join(home, '.agent-board')
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    mkdirSync(root, { recursive: true })
    writeFileSync(script, BOARD_SCRIPT)

    const deniedId = 'synthetic-agy-1589-denied'
    const deniedOwner = createHash('sha256').update(`antigravity:${deniedId}`).digest('hex')
    const recentIso = new Date(Date.now() - 60_000).toISOString()
    let seed = ''
    if (process.platform === 'win32') {
      const presDir = join(home, '.gemini', 'antigravity-cli', 'presence')
      mkdirSync(presDir, { recursive: true })
      writeFileSync(join(presDir, `${deniedId}.lock`), '')
      seed = `## antigravity\n\n<!-- auto session=${deniedOwner.slice(0, 8)} agent=antigravity source=antigravity-local owner=${deniedOwner} state=working updated=${recentIso} resume=${deniedId} host=${host} -->\n### Denied agy run\n- [~] Working in progress\n<!-- /auto session=${deniedOwner.slice(0, 8)} -->\n`
    } else {
      const dead = deadPid()
      seed = `## antigravity\n\n<!-- auto session=${deniedOwner.slice(0, 8)} agent=antigravity source=antigravity-local owner=${deniedOwner} state=working updated=${recentIso} resume=${deniedId} agentpid=${dead} agentstarted=${aliveStarted} host=${host} -->\n### Denied agy run\n- [~] Working in progress\n<!-- /auto session=${deniedOwner.slice(0, 8)} -->\n`
    }
    writeFileSync(progress, seed)

    const askId = 'synthetic-agy-1589-ask'
    const transcript = join(home, '.gemini', 'antigravity-cli', 'brain', askId, '.system_generated', 'logs', 'transcript_full.jsonl')
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Choose a color' },
      { source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ id: 'call_1', name: 'ask_question' }] },
      { source: 'MODEL', type: 'GENERIC', content: 'Tool skipped' },
      { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Blue or green?' },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n')

    const env = { ...process.env, HOME: home, USERPROFILE: home, LANG: 'en', CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }
    const stopRes = spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress, '--agent', 'antigravity', '--agent-status', '--state', 'waiting', '--event', 'Stop', '--hook-deadline', String(Date.now() + 30_000)], {
      cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      input: JSON.stringify({ conversationId: askId, transcriptPath: transcript }),
    })
    assert.equal(stopRes.status, 0, stopRes.stderr)

    const { parseProgress } = await import('../hooks/parse.ts')
    if (process.platform === 'win32') {
      const askTask = parseProgress(readFileSync(progress, 'utf8')).flatMap(p => p.tasks).find(t => t.auto?.resume === askId)
      assert.equal(askTask?.auto?.host, host)
      assert.equal(askTask?.auto?.agentPid, undefined)
      const presDir = join(home, '.gemini', 'antigravity-cli', 'presence')
      mkdirSync(presDir, { recursive: true })
      writeFileSync(join(presDir, `${askId}.lock`), '')
    } else {
      const deadAsk = deadPid()
      const askOwner = createHash('sha256').update(`antigravity:${askId}`).digest('hex')
      const current = readFileSync(progress, 'utf8').replace(
        new RegExp(`owner=${askOwner} state=waiting([^>]*)-->`),
        `owner=${askOwner} state=waiting$1 agentpid=${deadAsk} agentstarted=${aliveStarted} host=${host} -->`,
      )
      writeFileSync(progress, current)
    }

    const jsonRes = spawnSync(process.execPath, [script, '--json', '--lang', 'en', '--progress-file', progress], {
      cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    })
    assert.equal(jsonRes.status, 0, jsonRes.stderr)
    const doc = JSON.parse(jsonRes.stdout)
    assert.ok(doc.needs.some(item => item.kind === 'question' && item.text === 'Blue or green?'), `expected question card in needs: ${jsonRes.stdout}`)
    assert.equal(doc.counts.working, 0, `expected 0 working rows: ${jsonRes.stdout}`)
    assert.equal(doc.working.length, 0)
    assert.equal(doc.stopped.find(row => row.title === 'Denied agy run')?.state, 'ended')
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// #1589 Test 7: Duplicate blocks keep the newest Antigravity closing question in Needs you, and Windows Desktop resume ignores a stale CLI lock.
test('duplicate blocks keep the newest Antigravity closing question in Needs you and Windows Desktop resume ignores a stale CLI presence lock (#1589)', async () => {
  const { BOARD_SCRIPT } = await import('../hooks/board-script.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockHostOf, putCodexBlock } = await import('../hooks/codex.ts')
  const { antigravityQuestionWaitingKeys, blockKey } = await import('../hooks/session-liveness.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { EN } = await import('../hooks/strings-en.ts')
  const { goneBlocksOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const home = mkdtempSync(join(tmpdir(), 'ab-1589-dup-'))
  try {
    const host = readingHostHash()
    assert.notEqual(host, null)
    const dead = deadPid()
    const linuxResume = '44444444-5555-4666-8777-888888888888'
    const winResume = '55555555-6666-4777-8888-999999999999'

    // Greptile P1 (Linux dead-PID duplicates sharing blockKey):
    const olderWorking = block('e5f6a7b8', 'antigravity', 'working', '- [~] Working in progress', { pid: dead, started: aliveStarted, host }, 10, linuxResume)
    const newerAsk = block('e5f6a7b8', 'antigravity', 'waiting', '- [?] Blue or green?', { pid: dead, started: aliveStarted, host }, 5, linuxResume)
    for (const ordered of [file(olderWorking, newerAsk), file(newerAsk, olderWorking)]) {
      const projects = parseProgress(ordered)
      const sharedKey = blockKey(projects[0].tasks[0].auto)
      assert.equal(antigravityQuestionWaitingKeys(projects).has(sharedKey), true)
      const gone = goneBlocksOf(projects, host, new Map(), 2000, () => new Map(), { platform: 'linux' })
      assert.deepEqual([...gone], [])
      const view = buildView(projects, [], null, NOW, 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, gone)
      assert.deepEqual(view.waiting.map(item => item.text), ['Blue or green?'])
      assert.equal(view.stopped.some(row => !row.archive?.isDuplicate), false)
    }

    // Reverse state on Linux: older waiting question superseded by newer working block -> enters gone/stopped once CLI exits.
    const olderAsk = block('e5f6a7b8', 'antigravity', 'waiting', '- [?] Old question?', { pid: dead, started: aliveStarted, host }, 10, linuxResume)
    const newerWorking = block('e5f6a7b8', 'antigravity', 'working', '- [~] Working in progress', { pid: dead, started: aliveStarted, host }, 5, linuxResume)
    const linuxSuperseded = parseProgress(file(olderAsk, newerWorking))
    const linuxSupersededKey = blockKey(linuxSuperseded[0].tasks[1].auto)
    assert.equal(antigravityQuestionWaitingKeys(linuxSuperseded).has(linuxSupersededKey), false)
    const linuxGone = goneBlocksOf(linuxSuperseded, host, new Map(), 2000, () => new Map(), { platform: 'linux' })
    assert.deepEqual([...linuxGone], [linuxSupersededKey])
    const linuxSupersededView = buildView(linuxSuperseded, [], null, NOW, 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, linuxGone)
    assert.equal(linuxSupersededView.stopped.some(row => row.isProcessGone === true && row.auto === 'ended'), true)

    // Greptile P1 (Windows presence-lock duplicates sharing blockKey):
    const winOlderWork = `<!-- auto session=f6a7b8c9 agent=antigravity state=working updated=${new Date(NOW - 10 * 60_000).toISOString()} resume=${winResume} host=${host} -->\n### Ship win\n- [~] Working in progress\n<!-- /auto session=f6a7b8c9 -->\n`
    const winNewerAsk = `<!-- auto session=f6a7b8c9 agent=antigravity state=waiting updated=${new Date(NOW - 5 * 60_000).toISOString()} resume=${winResume} host=${host} -->\n### Ship win\n- [?] Blue or green?\n<!-- /auto session=f6a7b8c9 -->\n`
    for (const ordered of [file(winOlderWork, winNewerAsk), file(winNewerAsk, winOlderWork)]) {
      const projects = parseProgress(ordered)
      const gone = goneBlocksOf(projects, host, new Map(), 2000, () => new Map(), { home, platform: 'win32', presenceProbe: () => 'unlocked' })
      assert.deepEqual([...gone], [])
      const view = buildView(projects, [], null, NOW, 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, gone)
      assert.deepEqual(view.waiting.map(item => item.text), ['Blue or green?'])
      assert.equal(view.stopped.some(row => !row.archive?.isDuplicate), false)
    }

    const winOlderAsk = `<!-- auto session=f6a7b8c9 agent=antigravity state=waiting updated=${new Date(NOW - 10 * 60_000).toISOString()} resume=${winResume} host=${host} -->\n### Ship win\n- [?] Old question?\n<!-- /auto session=f6a7b8c9 -->\n`
    const winNewerWork = `<!-- auto session=f6a7b8c9 agent=antigravity state=working updated=${new Date(NOW - 5 * 60_000).toISOString()} resume=${winResume} host=${host} -->\n### Ship win\n- [~] Working in progress\n<!-- /auto session=f6a7b8c9 -->\n`
    const winSuperseded = parseProgress(file(winOlderAsk, winNewerWork))
    const winSupersededGone = goneBlocksOf(winSuperseded, host, new Map(), 2000, () => new Map(), { home, platform: 'win32', presenceProbe: () => 'unlocked' })
    assert.deepEqual([...winSupersededGone], [blockKey(winSuperseded[0].tasks[1].auto)])
    assert.equal(buildView(winSuperseded, [], null, NOW, 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, winSupersededGone).stopped.some(row => row.isProcessGone === true && row.auto === 'ended'), true)

    // Codex P2: Windows CLI -> Desktop App resume ignores stale unlocked CLI presence lock, and duplicate CLI/Desktop keeps Desktop alive.
    const resumeSession = '66666666-7777-4888-8999-aaaaaaaaaaaa'
    const resumeOwner = createHash('sha256').update(`antigravity:${resumeSession}`).digest('hex')
    const recentAt = Date.now() - 60_000
    const cliSeeded = putCodexBlock('', {
      session: resumeSession,
      agent: 'antigravity',
      project: 'antigravity',
      title: 'CLI then Desktop task',
      state: 'working',
      updated: new Date(recentAt).toISOString(),
      steps: ['- [~] Working in progress'],
    }, resumeOwner, false, undefined, v => v, null, host)
    assert.equal(blockHostOf(cliSeeded, resumeOwner, 'antigravity', resumeSession), host)
    const root = join(home, '.agent-board')
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    mkdirSync(root, { recursive: true })
    writeFileSync(progress, cliSeeded)
    writeFileSync(script, BOARD_SCRIPT)
    const presDir = join(home, '.gemini', 'antigravity-cli', 'presence')
    mkdirSync(presDir, { recursive: true })
    writeFileSync(join(presDir, `${resumeSession}.lock`), '')

    const cliGone = goneBlocksOf(parseProgress(cliSeeded), host, new Map(), 2000, () => new Map(), { home, platform: 'win32', presenceProbe: () => 'unlocked' })
    assert.deepEqual([...cliGone], [blockKey(parseProgress(cliSeeded)[0].tasks[0].auto)])

    const env = { ...process.env, HOME: home, USERPROFILE: home, LANG: 'en', CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }
    if (process.platform === 'win32') {
      const cliTranscript = join(home, '.gemini', 'antigravity-cli', 'brain', resumeSession, '.system_generated', 'logs', 'transcript_full.jsonl')
      mkdirSync(dirname(cliTranscript), { recursive: true })
      writeFileSync(cliTranscript, JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'CLI turn' }) + '\n')
      const cliLive = spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress, '--agent', 'antigravity', '--agent-status', '--state', 'working', '--event', 'PreInvocation', '--hook-deadline', String(Date.now() + 30_000)], {
        cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
        input: JSON.stringify({ conversationId: resumeSession, transcriptPath: cliTranscript }),
      })
      assert.equal(cliLive.status, 0, cliLive.stderr)
      assert.equal(blockHostOf(readFileSync(progress, 'utf8'), resumeOwner, 'antigravity', resumeSession), host)
    }

    const desktopTranscript = join(home, '.gemini', 'antigravity', 'brain', resumeSession, '.system_generated', 'logs', 'transcript.jsonl')
    mkdirSync(dirname(desktopTranscript), { recursive: true })
    writeFileSync(desktopTranscript, JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Desktop resume' }) + '\n')
    const desktopLive = spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress, '--agent', 'antigravity', '--agent-status', '--state', 'working', '--event', 'PreInvocation', '--hook-deadline', String(Date.now() + 30_000)], {
      cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      input: JSON.stringify({ conversationId: resumeSession, transcriptPath: desktopTranscript }),
    })
    assert.equal(desktopLive.status, 0, desktopLive.stderr)
    const afterDesktop = readFileSync(progress, 'utf8')
    assert.equal(blockHostOf(afterDesktop, resumeOwner, 'antigravity', resumeSession), null)
    const afterProjects = parseProgress(afterDesktop)
    const afterGone = goneBlocksOf(afterProjects, host, new Map(), 2000, () => new Map(), { home, platform: 'win32', presenceProbe: () => 'unlocked' })
    assert.deepEqual([...afterGone], [])
    const afterView = buildView(afterProjects, [], null, Date.now(), 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, afterGone)
    assert.equal(afterView.groups.flatMap(g => g.rows).some(row => row.auto === 'working'), true)
    assert.equal(afterView.stopped.length, 0)

    // Duplicate older CLI copy + newer Desktop copy sharing blockKey stays live too.
    const dupCliWork = `<!-- auto session=77778888 agent=antigravity state=working updated=${new Date(NOW - 10 * 60_000).toISOString()} resume=${resumeSession} host=${host} -->\n### CLI copy\n- [~] Working in progress\n<!-- /auto session=77778888 -->\n`
    const dupDesktopWork = `<!-- auto session=77778888 agent=antigravity state=working updated=${new Date(NOW - 5 * 60_000).toISOString()} resume=${resumeSession} -->\n### Desktop copy\n- [~] Working in progress\n<!-- /auto session=77778888 -->\n`
    const dupProjects = parseProgress(file(dupCliWork, dupDesktopWork))
    const dupGone = goneBlocksOf(dupProjects, host, new Map(), 2000, () => new Map(), { home, platform: 'win32', presenceProbe: () => 'unlocked' })
    assert.deepEqual([...dupGone], [])
    const dupView = buildView(dupProjects, [], null, NOW, 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, dupGone)
    assert.equal(dupView.groups.flatMap(g => g.rows).find(r => r.title === 'Desktop copy')?.auto, 'working')
    assert.equal(dupView.stopped.some(row => !row.archive?.isDuplicate), false)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// #1589 Test 8: Queued Antigravity Desktop and Windows CLI hooks preserve their liveness identity decision through pending recovery.
test('queued Antigravity Desktop and Windows CLI hooks preserve their liveness identity decision through pending recovery (#1589)', async () => {
  const { BOARD_SCRIPT } = await import('../hooks/board-script.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockHostOf, cleanAntigravityIdentity, putCodexBlock } = await import('../hooks/codex.ts')
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { EN } = await import('../hooks/strings-en.ts')
  const { goneBlocksOf, readingHostHash } = await import('../scripts/session-liveness.ts')
  const home = mkdtempSync(join(tmpdir(), 'ab-1589-queue-'))
  try {
    const host = readingHostHash()
    assert.notEqual(host, null)
    const root = join(home, '.agent-board')
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    const pendingDir = join(root, 'pending')
    mkdirSync(root, { recursive: true })
    writeFileSync(script, BOARD_SCRIPT)

    const sessionA = '77777777-8888-4999-8aaa-111111111111'
    const ownerA = createHash('sha256').update(`antigravity:${sessionA}`).digest('hex')
    const recentIso = new Date(Date.now() - 60_000).toISOString()
    const seedA = putCodexBlock('', {
      session: sessionA,
      agent: 'antigravity',
      project: 'antigravity',
      title: 'Queued Desktop resume task',
      state: 'working',
      updated: recentIso,
      steps: ['- [~] Working in progress'],
    }, ownerA, false, undefined, v => v, null, host)
    assert.equal(blockHostOf(seedA, ownerA, 'antigravity', sessionA), host)
    writeFileSync(progress, seedA)

    const presDir = join(home, '.gemini', 'antigravity-cli', 'presence')
    mkdirSync(presDir, { recursive: true })
    writeFileSync(join(presDir, `${sessionA}.lock`), '')
    assert.deepEqual([...goneBlocksOf(parseProgress(seedA), host, new Map(), 2000, () => new Map(), { home, platform: 'win32', presenceProbe: () => 'unlocked' })], [blockKey(parseProgress(seedA)[0].tasks[0].auto)])

    const marker = join(home, 'progress-locked')
    const preload = join(home, 'locked-progress.cjs')
    writeFileSync(marker, '')
    writeFileSync(preload, [
      "const fs = require('node:fs')",
      `const isLocked = path => path === ${JSON.stringify(progress)} && fs.existsSync(${JSON.stringify(marker)})`,
      "const busy = () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }) }",
      "for (const method of ['readFileSync', 'openSync']) {",
      '  const original = fs[method]',
      '  fs[method] = (path, ...args) => { if (isLocked(path)) busy(); return original(path, ...args) }',
      '}',
      'const rename = fs.renameSync',
      'fs.renameSync = (from, to) => { if (isLocked(to)) busy(); return rename(from, to) }',
      "require('node:module').syncBuiltinESMExports()",
    ].join('\n'))

    const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, LANG: 'en', CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }
    const lockedEnv = { ...baseEnv, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }
    const desktopTranscript = join(home, '.gemini', 'antigravity', 'brain', sessionA, '.system_generated', 'logs', 'transcript.jsonl')
    mkdirSync(dirname(desktopTranscript), { recursive: true })
    writeFileSync(desktopTranscript, JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Desktop resume queued' }) + '\n')

    // Part A: Live Desktop PreInvocation hits busy progress.md -> queues with antigravityIdentity: { kind: 'clear' }.
    const queuedRes = spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress, '--agent', 'antigravity', '--agent-status', '--state', 'working', '--event', 'PreInvocation', '--hook-deadline', String(Date.now() + 5000)], {
      cwd: home, env: lockedEnv, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      input: JSON.stringify({ conversationId: sessionA, transcriptPath: desktopTranscript }),
    })
    assert.equal(queuedRes.status, 0, queuedRes.stderr)
    const pendingJson = readdirSync(pendingDir).filter(name => name.endsWith('.json'))
    assert.equal(pendingJson.length, 1)
    const queuedDoc = JSON.parse(readFileSync(join(pendingDir, pendingJson[0]), 'utf8'))
    assert.deepEqual(queuedDoc.antigravityIdentity, { kind: 'clear' })

    unlinkSync(marker)
    const drain = () => spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress, '--agent', 'antigravity', '--agent-status', '--state', 'working', '--event', 'PreInvocation', '--hook-deadline', String(Date.now() + 30_000)], {
      cwd: home, env: baseEnv, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      input: JSON.stringify({ conversationId: 'synthetic-agy-other-drain-1589' }),
    })
    const drainA = drain()
    assert.equal(drainA.status, 0, drainA.stderr)
    assert.deepEqual(readdirSync(pendingDir).filter(name => name.endsWith('.json')), [])
    const afterQueueA = readFileSync(progress, 'utf8')
    assert.equal(blockHostOf(afterQueueA, ownerA, 'antigravity', sessionA), null)
    const projectsA = parseProgress(afterQueueA)
    const goneA = goneBlocksOf(projectsA, host, new Map(), 2000, () => new Map(), { home, platform: 'win32', presenceProbe: () => 'unlocked' })
    assert.deepEqual([...goneA], [])
    const viewA = buildView(projectsA, [], null, Date.now(), 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, goneA)
    assert.equal(viewA.groups.flatMap(g => g.rows).some(row => row.title === 'Desktop resume queued' && row.auto === 'working'), true)
    assert.equal(viewA.stopped.length, 0)

    // Part B: .raw.json Desktop App recovery clears CLI host too.
    const seededAgainA = putCodexBlock('', {
      session: sessionA,
      agent: 'antigravity',
      project: 'antigravity',
      title: 'Queued Desktop resume task',
      state: 'working',
      updated: recentIso,
      steps: ['- [~] Working in progress'],
    }, ownerA, false, undefined, v => v, null, host)
    writeFileSync(progress, seededAgainA)
    const prevRecordA = JSON.parse(readFileSync(join(root, 'sessions', `${ownerA}.json`), 'utf8'))
    const rawAt = Math.max(Date.now(), Number(prevRecordA.appliedAt ?? 0) + 10)
    writeFileSync(join(pendingDir, '000000000000001-desktop.raw.json'), JSON.stringify({
      version: 1,
      kind: 'raw',
      at: rawAt,
      argv: ['--agent-status', '--agent', 'antigravity', '--state', 'working', '--event', 'PreInvocation', '--progress-file', progress],
      env: {},
      payload: { conversationId: sessionA, transcriptPath: desktopTranscript },
    }))
    const drainB = drain()
    assert.equal(drainB.status, 0, drainB.stderr)
    assert.equal(blockHostOf(readFileSync(progress, 'utf8'), ownerA, 'antigravity', sessionA), null)
    assert.deepEqual([...goneBlocksOf(parseProgress(readFileSync(progress, 'utf8')), host, new Map(), 2000, () => new Map(), { home, platform: 'win32', presenceProbe: () => 'unlocked' })], [])

    // Part C: cleanAntigravityIdentity validation + Windows CLI queued host + tampered drop.
    assert.equal(cleanAntigravityIdentity(undefined), undefined)
    assert.deepEqual(cleanAntigravityIdentity({ kind: 'clear' }), { kind: 'clear' })
    assert.deepEqual(cleanAntigravityIdentity({ kind: 'host', host }), { kind: 'host', host })
    assert.deepEqual(cleanAntigravityIdentity({ kind: 'claim', claim: { pid: alivePid, started: aliveStarted, host } }), { kind: 'claim', claim: { pid: alivePid, started: aliveStarted, host } })
    for (const bad of [null, 'clear', [], { kind: 'unknown' }, { kind: 'host', host: 'bad' }, { kind: 'claim', claim: { pid: -1, host } }]) {
      assert.equal(cleanAntigravityIdentity(bad), null)
    }

    const sessionB = '88888888-9999-4aaa-8bbb-222222222222'
    const ownerB = createHash('sha256').update(`antigravity:${sessionB}`).digest('hex')
    writeFileSync(join(presDir, `${sessionB}.lock`), '')
    const baseB = putCodexBlock(readFileSync(progress, 'utf8'), {
      session: sessionB,
      agent: 'antigravity',
      project: 'antigravity',
      title: 'Queued CLI host task',
      state: 'working',
      updated: recentIso,
      steps: ['- [~] Working in progress'],
    }, ownerB, false, undefined, v => v, null, null)
    writeFileSync(progress, baseB)
    if (process.platform === 'win32') {
      const cliTranscriptB = join(home, '.gemini', 'antigravity-cli', 'brain', sessionB, '.system_generated', 'logs', 'transcript_full.jsonl')
      mkdirSync(dirname(cliTranscriptB), { recursive: true })
      writeFileSync(cliTranscriptB, JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'CLI queued' }) + '\n')
      writeFileSync(marker, '')
      const queuedCliRes = spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress, '--agent', 'antigravity', '--agent-status', '--state', 'working', '--event', 'PreInvocation', '--hook-deadline', String(Date.now() + 5000)], {
        cwd: home, env: lockedEnv, encoding: 'utf8', windowsHide: true, timeout: 15_000,
        input: JSON.stringify({ conversationId: sessionB, transcriptPath: cliTranscriptB }),
      })
      assert.equal(queuedCliRes.status, 0, queuedCliRes.stderr)
      const cliFiles = readdirSync(pendingDir).filter(name => name.endsWith('.json'))
      assert.equal(cliFiles.length, 1)
      const cliPending = JSON.parse(readFileSync(join(pendingDir, cliFiles[0]), 'utf8'))
      assert.deepEqual(cliPending.antigravityIdentity, { kind: 'host', host })
      unlinkSync(marker)
    } else {
      const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      writeFileSync(join(pendingDir, `${String(Date.now()).padStart(15, '0')}-cli.json`), JSON.stringify({
        version: 1, progress, mode: '--agent-status', agent: 'antigravity', session: sessionB, now: nowIso, at: Date.now(),
        status: 'working', event: 'PreInvocation', isBoardPrompt: false, isPrompt: false,
        payload: { title: 'Queued CLI host task', titleSource: 'prompt' },
        antigravityIdentity: { kind: 'host', host },
      }))
    }
    const drainC = drain()
    assert.equal(drainC.status, 0, drainC.stderr)
    const afterC = readFileSync(progress, 'utf8')
    assert.equal(blockHostOf(afterC, ownerB, 'antigravity', sessionB), host)
    const taskB = parseProgress(afterC).flatMap(p => p.tasks).find(t => t.auto?.resume === sessionB)
    assert.ok(taskB)
    const goneC = goneBlocksOf(parseProgress(afterC), host, new Map(), 2000, () => new Map(), { home, platform: 'win32', presenceProbe: () => 'unlocked' })
    assert.equal(goneC.has(blockKey(taskB.auto)), true)

    // Tampered antigravityIdentity in pending/*.json is rejected and dropped without mutating progress.md.
    const sessionC = '99999999-aaaa-4bbb-8ccc-333333333333'
    const nowIsoBad = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    writeFileSync(join(pendingDir, `${String(Date.now()).padStart(15, '0')}-tampered.json`), JSON.stringify({
      version: 1, progress, mode: '--agent-status', agent: 'antigravity', session: sessionC, now: nowIsoBad, at: Date.now(),
      status: 'working', event: 'PreInvocation', isBoardPrompt: false, isPrompt: false, payload: {},
      antigravityIdentity: { kind: 'host', host: 'invalid' },
    }))
    const drainBad = drain()
    assert.equal(drainBad.status, 0, drainBad.stderr)
    assert.deepEqual(readdirSync(pendingDir).filter(name => name.endsWith('.json')), [])
    assert.equal(readFileSync(progress, 'utf8').includes(sessionC), false)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

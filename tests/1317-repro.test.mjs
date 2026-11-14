import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(specifier + '.ts', context)
  }
} })

// Adapted from the round-3 reviewer's named-review-repros.mjs
// (~/workspace/agent-board-impl/1092/round3/named-review-repros.mjs), which
// targeted the round-3 `d5cbaf9` API (`sessionClaimsOf`, `deadKeysForClaims`,
// `deadSessionsOf`, `dropStaleStart`). Commit `91c107f` (Fable R6 §2 redesign)
// removed all of those; the probes below use the head API instead:
// `goneBlocks` / `goneBlocksOf` keyed on `blockKey(auto)`, and `buildView`
// taking `gone` as its 17th argument. Each test keeps the reviewer's fixture
// shape and verdict, plus a control proving the probe can tell the fix from
// the bug.
const NOW = Date.parse('2026-10-16T12:00:00Z')
const host = '0'.repeat(64)
const block = (title, at, claim) => '<!-- auto session=a1b2c3d4 agent=claude state=waiting updated=' + new Date(at).toISOString() + ' resume=synthetic-claude-session' + (claim ? ' agentpid=' + claim.pid + ' agentstarted=' + claim.started + ' host=' + claim.host : '') + ' -->\n### ' + title + '\n- [?] Deploy the synthetic plan, OK?\n<!-- /auto session=a1b2c3d4 -->\n'
const observed = (ledger, projects, observeQuestions) => observeQuestions(ledger, projects, null, [], NOW, true, 'review', undefined, [], [], new Set()).ledger

test('repro1: a pane view built with the gone set agrees with the dead-session hide validator', async () => {
  const { parseProgress, STALE_MS } = await import('../hooks/parse.ts')
  const { buildView, viewCache } = await import('../hooks/view.ts')
  const { emptyQuestions, observeQuestions } = await import('../hooks/questions.ts')
  const { goneBlocks } = await import('../hooks/session-liveness.ts')
  const { STRINGS } = await import('../hooks/strings.ts')
  const projects = parseProgress('## demo\n' + block('Synthetic task', NOW - 1000, { pid: 999999999, started: NOW - 10000, host }))
  const gone = goneBlocks(projects, () => ({ alive: false, actual: null }), host)
  assert.equal(gone.size, 1, 'the dead claim must be proven gone first')
  const retained = observed(observed(emptyQuestions(), projects, observeQuestions), projects, observeQuestions)
  const args = (withGone) => [projects, [], null, NOW, 0, {}, STRINGS.en, [], {}, retained, undefined, [], new Set(), undefined, STALE_MS, undefined, withGone]
  // The draw path (register.tsx boardView, the sole caller of buildView /
  // views.view) always passes the gone set: the pane must agree with the
  // validator built the same way.
  const pane = viewCache().view(...args(gone))
  const validator = buildView(...args(gone))
  console.log(JSON.stringify({ paneNeeds: pane.waiting.length, validatorNeeds: validator.waiting.length, retainedId: retained.records[0]?.id, olderHideKeys: validator.older.map(one => one.hideKey) }))
  assert.equal(pane.waiting.length, 0, 'a proven-dead question still appears in the native pane Needs you')
  // The folded question sits under Older with the retained record's id as its
  // hide key, and an independent validator build accepts that hide id — so a
  // hide press on the folded card is found (the reviewer's d5cbaf9 failure
  // was the pane offering a hide id the validator refused). Note the pane
  // itself shows no waiting card when fixed, so there is no pane hide id to
  // take: the folded card's id is the one the pane offers from Older.
  const folded = validator.older.find(one => one.text === 'Deploy the synthetic plan, OK?')
  assert.notEqual(folded, undefined, 'the folded question is not under Older unanswered')
  assert.equal(folded.hideKey, retained.records[0]?.id)
  const validator2 = buildView(...args(gone))
  const accepted = [...validator2.waiting, ...validator2.reminder, ...validator2.older, ...validator2.hidden].some(one => one.hideKey === folded.hideKey)
  assert.equal(accepted, true, 'the folded card hide id is refused by the current write validator')
  // Control: the same view WITHOUT the gone set still shows the question, so
  // this probe can tell the fixed draw path from the old one (which passed
  // no dead evidence to the pane/status/reminder draws).
  const undrawn = buildView(...args(new Set()))
  assert.equal(undrawn.waiting.length, 1, 'control: without gone the question must still wait')
})

test('repro2: a newest duplicate without a claim must suppress the older dead claim', async () => {
  const { parseProgress, STALE_MS } = await import('../hooks/parse.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { emptyQuestions, observeQuestions } = await import('../hooks/questions.ts')
  const { blockKey, goneBlocks } = await import('../hooks/session-liveness.ts')
  const { foldRuns } = await import('../hooks/runs.ts')
  const { STRINGS } = await import('../hooks/strings.ts')
  const projects = parseProgress('## demo\n' + block('Old dead copy', NOW - 10000, { pid: 999999999, started: NOW - 20000, host }) + block('Newest no-identity copy', NOW - 1000, null))
  const winners = foldRuns(projects).projects
  const gone = goneBlocks(projects, claim => ({ alive: claim.pid !== 999999999, actual: null }), host)
  const view = buildView(projects, [], null, NOW, 0, {}, STRINGS.en, [], {}, observed(emptyQuestions(), projects, observeQuestions), undefined, [], new Set(), undefined, STALE_MS, undefined, gone)
  console.log(JSON.stringify({ winner: winners[0].tasks[0].title, winnerPid: winners[0].tasks[0].auto.agentPid ?? null, dead: [...gone], needs: view.waiting.length, stopped: view.stopped.map(one => one.title) }))
  // The older dead claim is real (its own block key IS gone) — but the
  // winner is the newest claim-less block, whose key carries no pid, so the
  // view must not fold it. The reviewer's d5cbaf9 assertion (dead.size 0)
  // does not apply at head: gone is keyed per block, not per session.
  assert.deepEqual([...gone], [blockKey(projects[0].tasks[0].auto)])
  assert.equal(view.waiting.length, 1, 'the newest claim-less duplicate must still ask')
  assert.equal(view.older.length, 0, 'nothing about the newest duplicate may fold into Older')
})

test('repro4: a retained pending question keeps its live copy when an ended duplicate exists', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { emptyQuestions, observeQuestions } = await import('../hooks/questions.ts')
  const { STRINGS } = await import('../hooks/strings.ts')
  const text = 'Publish the synthetic build, OK?'
  // A recent Codex inbox question for session B, captured with observeQuestions.
  const pending = { id: 'bbbb2222', agent: 'codex', project: 'demo', dir: '/work/demo', text, fullText: text, isQuestion: true, at: NOW }
  const first = observeQuestions(emptyQuestions(), [], null, [], NOW, true, 'review-probe:1', undefined, [pending]).ledger
  // On the following observation the inbox input is no longer supplied, so the
  // question is retained — and an ended session A asks the same words.
  const ended = '## demo\n<!-- auto session=aaaa1111 agent=codex state=ended updated=' + new Date(NOW - 60000).toISOString() + ' dir=%2Fwork%2Fdemo -->\n### Ended duplicate\n- [?] ' + text + '\n<!-- /auto session=aaaa1111 -->\n'
  const second = observeQuestions(first, parseProgress(ended), null, [], NOW + 1, true, 'review-probe:2').ledger
  const view = buildView(parseProgress(ended), [], null, NOW + 2, 0, {}, STRINGS.en, [], {}, second)
  console.log(JSON.stringify({ waiting: view.waiting.map(one => one.text), older: (view.older ?? []).map(one => one.text), waitingCount: view.overview.waiting, stoppedAsking: view.stoppedAsking }))
  // The retained live copy must win the merge: the question still waits, and
  // the ended duplicate must not move the shared question to Older. The
  // round-6 P1 (codex_300) was the retained loop testing the imported
  // `isStopped` function — always truthy — instead of its `rowStopped`
  // local, so every retained question was marked stopped and the ended
  // copy won.
  assert.equal(view.waiting.length, 1, 'the retained pending question left Needs you when an ended duplicate exists')
  assert.equal(view.waiting[0]?.text, text)
  assert.equal(view.overview.waiting, 1)
  assert.equal(view.older.filter(one => one.text === text).length, 0, 'the ended duplicate moved the shared question to Older')
  // Control: without the ended duplicate the same retained question waits,
  // so this probe can tell the fix from the bug.
  const control = buildView([], [], null, NOW + 2, 0, {}, STRINGS.en, [], {}, first)
  assert.equal(control.waiting.length, 1, 'control: the retained question must wait with no duplicate')
})

test('repro3: an unchanged reused-pid claim must not re-run the start-time lookup on each read', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const { goneBlocksOf, readingHostHash, cacheKey } = await import('../scripts/session-liveness.ts')
  const hostHash = readingHostHash()
  assert.notEqual(hostHash, null, 'this machine has a host hash')
  const livePid = process.pid
  const liveStarted = Math.round(performance.timeOrigin)
  // A live pid whose recorded start is 60 s off the real one: reused, so dead.
  const projects = parseProgress('## demo\n' + block('Reused pid', NOW - 1000, { pid: livePid, started: liveStarted - 60000, host: hostHash }))
  const key = blockKey(projects[0].tasks[0].auto)
  const cache = new Map()
  let calls = 0
  const lookup = (pids) => {
    calls += 1
    return new Map(pids.map(pid => [pid, pid === livePid ? liveStarted : null]))
  }
  const first = [...goneBlocksOf(projects, hostHash, cache, 2000, lookup)]
  const afterFirst = calls
  const second = [...goneBlocksOf(projects, hostHash, cache, 2000, lookup)]
  const third = [...goneBlocksOf(projects, hostHash, cache, 2000, lookup)]
  console.log(JSON.stringify({ first, second, third, lookupCallsAfterFirstRead: afterFirst, lookupCallsAfterThirdRead: calls, cachedClaimStart: cache.get(cacheKey(livePid, liveStarted - 60000)) }))
  assert.deepEqual(first, [key])
  assert.deepEqual(second, [key])
  assert.deepEqual(third, [key])
  // The old d5cbaf9 bug deleted the cached start on EVERY read of an
  // unchanged differing claim, so each read re-spawned the lookup (calls
  // would be 3 here, one per read). One lookup over three reads proves the
  // claim is checked once and cached (PM decision 5). The lookup is
  // injected, so this proves the property without Windows/PowerShell.
  assert.equal(calls, 1, 'the second and third unchanged reads re-ran the start-time lookup')
  assert.deepEqual(cache.get(cacheKey(livePid, liveStarted - 60000)), { claimed: liveStarted - 60000, actual: liveStarted })
})

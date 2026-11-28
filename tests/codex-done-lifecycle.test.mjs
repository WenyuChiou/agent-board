import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  },
})

const {
  boardConfirmedReport,
  codexEvent,
  codexLifecycleStep,
  localAgentLifecycleStep,
  putCodexBlock,
  validateCodexReport,
} = await import('../hooks/codex.ts')
const { STRINGS } = await import('../hooks/strings.ts')

const NOW = '2026-11-09T18:00:00.000Z'
const OWNER = createHash('sha256').update('test-owner-seed').digest('hex')

test('codexLifecycleStep and localAgentLifecycleStep return checked step when state is done (#1226)', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const s = STRINGS[lang]
    assert.equal(codexLifecycleStep('working', s), `- [ ] ${s.codexLifecycleWorking}`)
    assert.equal(codexLifecycleStep('waiting', s), `- [ ] ${s.codexLifecycle}`)
    assert.equal(codexLifecycleStep('done', s), `- [x] ${s.codexLifecycle}`)

    assert.equal(localAgentLifecycleStep('working', s), `- [ ] ${s.localAgentLifecycleWorking}`)
    assert.equal(localAgentLifecycleStep('waiting', s), `- [ ] ${s.localAgentLifecycle}`)
    assert.equal(localAgentLifecycleStep('done', s), `- [x] ${s.localAgentLifecycle}`)
  }
})

test('codexEvent: a board-confirmed done lifecycle-only session keeps its checked step on subsequent idle Stop event (#1226)', () => {
  const s = STRINGS.en
  // 1. Session start: waiting lifecycle placeholder
  const start = codexEvent(null, { session_id: 's-1226', hook_event_name: 'SessionStart' }, NOW, s)
  assert.equal(start.state, 'waiting')
  assert.deepEqual(start.steps, [`- [ ] ${s.codexLifecycle}`])

  // 2. Mark it done on the board via putCodexBlock and boardConfirmedReport
  const emptyProgress = '# Progress\n\n## Demo\n'
  const textWithBlock = putCodexBlock(emptyProgress, start, OWNER)
  // Simulate board checking the task item to [x] and marking state done
  const doneBlockText = textWithBlock
    .replace('state=waiting', 'state=done')
    .replace(`- [ ] ${s.codexLifecycle}`, `- [x] ${s.codexLifecycle}`)
  const confirmed = boardConfirmedReport(doneBlockText, start, OWNER)
  assert.equal(confirmed.state, 'done')
  assert.deepEqual(confirmed.steps, [`- [x] ${s.codexLifecycle}`])

  // 3. Next idle event: Stop without closing question
  const nextIdle = codexEvent(
    confirmed,
    { session_id: 's-1226', hook_event_name: 'Stop', turn_id: 'turn-2' },
    new Date(Date.parse(NOW) + 10_000).toISOString(),
    s
  )
  assert.equal(nextIdle.state, 'done')
  // The placeholder must remain checked rather than reverting to unchecked
  assert.deepEqual(nextIdle.steps, [`- [x] ${s.codexLifecycle}`])

  // 4. validateCodexReport must validate clean without throwing UNFINISHED_STEPS
  assert.doesNotThrow(() => validateCodexReport(nextIdle, 's-1226'))
  const validated = validateCodexReport(nextIdle, 's-1226')
  assert.equal(validated.state, 'done')
  assert.deepEqual(validated.steps, [`- [x] ${s.codexLifecycle}`])
})

test('codexEvent: UserPromptSubmit following done transitions lifecycle step back to working (#1226)', () => {
  const s = STRINGS.en
  const start = codexEvent(null, { session_id: 's-1226-work', hook_event_name: 'SessionStart' }, NOW, s)
  const doneReport = {
    ...start,
    state: 'done',
    steps: [`- [x] ${s.codexLifecycle}`],
  }

  // Next prompt: user provides a new instruction
  const workingReport = codexEvent(
    doneReport,
    { session_id: 's-1226-work', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-next' },
    new Date(Date.parse(NOW) + 20_000).toISOString(),
    s
  )
  assert.equal(workingReport.state, 'working')
  assert.deepEqual(workingReport.steps, [`- [ ] ${s.codexLifecycleWorking}`])
  assert.doesNotThrow(() => validateCodexReport(workingReport, 's-1226-work'))
})

test('--agent-status: a board-confirmed done lifecycle-only session validates clean on status update (#1226)', async () => {
  const { runCodexLocal } = await import('../scripts/codex-local.ts')
  const root = mkdtempSync(join(tmpdir(), 'codex-done-lifecycle-'))
  try {
    const progress = join(root, 'progress.md')
    const s = STRINGS.en
    writeFileSync(progress, '# Progress\n\n## Demo\n')

    const session = 'session-1226'
    // 1. Initial report as waiting with local lifecycle placeholder
    const initRes = await runCodexLocal(
      ['--agent-status', '--agent', 'antigravity', '--state', 'waiting', '--progress-file', progress, '--data-dir', root],
      progress,
      s,
      { conversationId: session }
    )
    assert.equal(initRes, true)

    // Read stored session JSON
    const sessionsDir = join(root, 'sessions')
    const owner = createHash('sha256').update(`antigravity:${session}`).digest('hex')
    const recordFile = join(sessionsDir, `${owner}.json`)
    const initialRecord = JSON.parse(readFileSync(recordFile, 'utf8'))
    assert.equal(initialRecord.state, 'waiting')

    // 2. Mark done on the board
    const textWithBlock = putCodexBlock(readFileSync(progress, 'utf8'), initialRecord, owner)
    const doneBlockText = textWithBlock
      .replace('state=waiting', 'state=done')
      .replace(`- [ ] ${s.localAgentLifecycle}`, `- [x] ${s.localAgentLifecycle}`)
    writeFileSync(progress, doneBlockText)

    // Update stored record to done
    const doneRecord = boardConfirmedReport(doneBlockText, initialRecord, owner)
    assert.equal(doneRecord.state, 'done')
    writeFileSync(recordFile, JSON.stringify(doneRecord, null, 2))

    // 3. Receive next --agent-status event (waiting/idle)
    // Before fix, this would throw UNFINISHED_STEPS
    let failedError = null
    try {
      const statusRes = await runCodexLocal(
        ['--agent-status', '--agent', 'antigravity', '--state', 'waiting', '--progress-file', progress, '--data-dir', root],
        progress,
        s,
        { conversationId: session }
      )
      assert.equal(statusRes, true)
    } catch (err) {
      failedError = err
    }
    assert.equal(failedError, null, `must not throw UNFINISHED_STEPS, caught: ${failedError}`)

    // 4. Stored record remains done with checked lifecycle step
    const updatedRecord = JSON.parse(readFileSync(recordFile, 'utf8'))
    assert.equal(updatedRecord.state, 'done')
    assert.deepEqual(updatedRecord.steps, [`- [x] ${s.localAgentLifecycle}`])
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('a skill report and hook turns give one row (#1832)', async () => {
  const { blockId } = await import('../hooks/inbox.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { serveModel } = await import('../hooks/serve.ts')
  const { boardScreen, boardText, emptyBoardState } = await import('../hooks/board.ts')
  const { boardDocument, collectFinished } = await import('../hooks/board-json.ts')

  const s = STRINGS.en
  const resume = '019a1832-1111-4222-8333-444444444444'
  const localSession = createHash('sha256').update(`codex:${resume}`).digest('hex')
  const localId = localSession.slice(0, 8)
  const turnId = blockId('codex', resume)
  assert.notEqual(localId, turnId)

  const baseNow = Date.parse('2026-11-24T16:10:00.000Z')
  const t1 = new Date(baseNow - 120_000).toISOString()
  const t2 = new Date(baseNow - 60_000).toISOString()
  const group = { now: baseNow, repoOf: () => null, versions: { board: '0.25.1', package: null }, unreadable: [] }

  // Phase 1: Codex is still in a live turn; skill wrote source=codex-local and hooks wrote source=turns.
  const liveProgress = [
    '# Progress',
    '',
    '## board-sitting-1125',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=working updated=${t1} resume=${resume} -->`,
    '### Synthetic skill task',
    '- [x] Open the board',
    '- [~] Count lines',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=working updated=${t2} resume=${resume} source=turns -->`,
    '### Synthetic hook turn task',
    '- [ ] Working in progress',
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')

  const liveView = buildView(parseProgress(liveProgress), [], null, baseNow, 0, {}, s)
  assert.equal(liveView.stopped.length, 0)
  assert.equal(liveView.groups.flatMap(g => g.rows).length, 1)

  const liveModel = serveModel(liveView, [], s, new Set(), false, undefined, false, group)
  assert.equal(liveModel.stopped.length, 0)
  assert.equal(liveModel.view?.all.stopped.length, 0)
  assert.equal(liveModel.view?.all.open.length, 1)
  const liveCodexGroup = liveModel.view?.agents.find(a => a.agent === 'codex')
  assert.equal(liveCodexGroup?.stopped.length, 0)
  assert.equal(liveCodexGroup?.open.length, 1)

  for (const printed of [
    boardText(liveView, [], s, { width: 100, isColor: false }),
    boardScreen(liveView, [], emptyBoardState, s, { width: 100, isColor: false }),
  ]) {
    assert.equal(printed.includes(s.stoppedCount(1)), false)
  }

  const liveDoc = boardDocument(liveView, [], [], s, '', false, baseNow, group)
  assert.equal(liveDoc.counts.stopped, 0)
  assert.equal(liveDoc.stopped.length, 0)
  assert.equal(liveDoc.counts.working + liveDoc.counts.waiting, 1)

  // Phase 2: Both blocks reached state=done; one row under Done, zero under Stopped.
  const t3 = new Date(baseNow - 40_000).toISOString()
  const t4 = new Date(baseNow - 10_000).toISOString()
  const doneProgress = [
    '# Progress',
    '',
    '## board-sitting-1125',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=done updated=${t3} resume=${resume} -->`,
    '### Synthetic skill task',
    '- [x] Open the board',
    '- [x] Count lines',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=done updated=${t4} resume=${resume} source=turns -->`,
    '### Synthetic hook turn task',
    '- [x] Reply finished',
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')

  const doneView = buildView(parseProgress(doneProgress), [], null, baseNow, 0, {}, s)
  assert.equal(doneView.stopped.length, 0)
  assert.equal(doneView.finished?.length, 1)
  assert.equal(doneView.recent.length, 1)

  const doneModel = serveModel(doneView, [], s, new Set(), false, undefined, false, group)
  assert.equal(doneModel.stopped.length, 0)
  assert.equal(doneModel.view?.all.stopped.length, 0)
  assert.equal(doneModel.view?.all.done.length, 1)
  const doneCodexGroup = doneModel.view?.agents.find(a => a.agent === 'codex')
  assert.equal(doneCodexGroup?.stopped.length, 0)
  assert.equal(doneCodexGroup?.done.length, 1)

  for (const printed of [
    boardText(doneView, [], s, { width: 100, isColor: false }),
    boardScreen(doneView, [], emptyBoardState, s, { width: 100, isColor: false }),
  ]) {
    assert.equal(printed.includes(s.sectionRecent), true)
    assert.equal(printed.includes('Synthetic hook turn task'), true)
    assert.equal(printed.includes(s.stoppedCount(1)), false)
    assert.equal(printed.includes(s.empty), false)
  }

  const doneDoc = boardDocument(doneView, [], [], s, '', false, baseNow, group)
  assert.equal(doneDoc.counts.doneRecently, 1)
  assert.equal(doneDoc.doneRecently.length, 1)
  assert.equal(doneDoc.counts.stopped, 0)
  assert.equal(doneDoc.stopped.length, 0)
  assert.equal(collectFinished(doneProgress, [], [], 7, baseNow).length, 1)

  const withHelperRun = `${doneProgress}\n<!-- auto session=run12345 agent=codex state=done updated=${t4} origin=run parent=${resume} -->\n### Helper run task\n- [x] Subagent finished\n<!-- /auto session=run12345 -->\n`
  assert.equal(collectFinished(withHelperRun, [], [], 7, baseNow).length, 2)

  // Row 2: reverse order (hooks older, skill newer) + equal updated= tie-break by file order.
  const reverseProgress = [
    '# Progress',
    '',
    '## board-sitting-1125',
    `<!-- auto session=${turnId} agent=codex state=working updated=${t1} resume=${resume} source=turns -->`,
    '### Synthetic hook turn task',
    '- [ ] Working in progress',
    `<!-- /auto session=${turnId} -->`,
    '',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=working updated=${t2} resume=${resume} -->`,
    '### Synthetic skill task',
    '- [~] Counting lines',
    `<!-- /auto session=${localId} -->`,
    '',
  ].join('\n')
  const reverseView = buildView(parseProgress(reverseProgress), [], null, baseNow, 0, {}, s)
  assert.equal(reverseView.stopped.length, 0)
  assert.equal(reverseView.groups.flatMap(g => g.rows).length, 1)
  assert.equal(serveModel(reverseView, [], s, new Set(), false, undefined, false, group).view?.all.stopped.length, 0)
  assert.equal(boardText(reverseView, [], s, { width: 100, isColor: false }).includes(s.stoppedCount(1)), false)
  const reverseDoc = boardDocument(reverseView, [], [], s, '', false, baseNow, group)
  assert.equal(reverseDoc.counts.stopped, 0)
  assert.equal(reverseDoc.counts.working + reverseDoc.counts.waiting, 1)

  const equalProgress = reverseProgress.replace(`updated=${t1}`, `updated=${t2}`)
  const equalView = buildView(parseProgress(equalProgress), [], null, baseNow, 0, {}, s)
  assert.equal(equalView.stopped.length, 0)
  assert.equal(equalView.groups.flatMap(g => g.rows).map(r => r.title)[0], 'Synthetic skill task')

  // Row 3 (no Copy answer card outside Done): neither model.view.agents nor model.stopped has hasCopyBox outside Done.
  assert.equal(doneModel.view?.all.done.length, 1)
  assert.equal(doneModel.stopped.every(r => r.hasCopyBox === false), true)

  // Row 7: two Codex blocks in same project & same title with different resume=, and two sharing only 8-char block id.
  const resumeA = '019a1832-7777-4222-8333-111111111111'
  const resumeB = '019a1832-7777-4222-8333-222222222222'
  const diffResumeProgress = [
    '# Progress',
    '',
    '## Demo',
    `<!-- auto session=aaaa1111 agent=codex state=working updated=${t2} resume=${resumeA} -->`,
    '### Same title',
    '- [~] Work A',
    '<!-- /auto session=aaaa1111 -->',
    '',
    `<!-- auto session=aaaa1111 agent=codex state=done updated=${t2} resume=${resumeB} -->`,
    '### Same title',
    '- [x] Work B',
    '<!-- /auto session=aaaa1111 -->',
    '',
  ].join('\n')
  const diffResumeView = buildView(parseProgress(diffResumeProgress), [], null, baseNow, 0, {}, s)
  assert.equal(diffResumeView.active.length, 1)
  assert.equal(diffResumeView.recent.length, 1)
  assert.equal(diffResumeView.stopped.length, 0)

  // Row 8: same resume= text, different agents (codex + opencode) -> two rows, never merged.
  const crossAgentProgress = [
    '# Progress',
    '',
    '## Demo',
    `<!-- auto session=cccc1111 agent=codex state=working updated=${t2} resume=${resume} -->`,
    '### Codex row',
    '- [~] Step C',
    '<!-- /auto session=cccc1111 -->',
    '',
    `<!-- auto session=dddd2222 agent=opencode state=working updated=${t2} resume=${resume} -->`,
    '### OpenCode row',
    '- [~] Step O',
    '<!-- /auto session=dddd2222 -->',
    '',
  ].join('\n')
  const crossAgentView = buildView(parseProgress(crossAgentProgress), [], null, baseNow, 0, {}, s)
  assert.equal(crossAgentView.active.length, 2)
  assert.equal(crossAgentView.stopped.length, 0)

  // Row 9: one block without resume= is never merged with a block sharing its project/title.
  const noResumeProgress = [
    '# Progress',
    '',
    '## Demo',
    `<!-- auto session=eeee1111 agent=codex state=working updated=${t2} resume=${resume} -->`,
    '### Shared title',
    '- [~] Live step',
    '<!-- /auto session=eeee1111 -->',
    '',
    `<!-- auto session=ffff2222 agent=codex state=done updated=${t1} -->`,
    '### Shared title',
    '- [x] Finished legacy step',
    '<!-- /auto session=ffff2222 -->',
    '',
  ].join('\n')
  const noResumeView = buildView(parseProgress(noResumeProgress), [], null, baseNow, 0, {}, s)
  assert.equal(noResumeView.active.length, 1)
  assert.equal(noResumeView.recent.length, 1)
  assert.equal(noResumeView.stopped.length, 0)

  // Row 10: two blocks of one conversation under different ## headings & titles -> one row, no leftover row under other heading.
  const crossProjectProgress = [
    '# Progress',
    '',
    '## Project Alpha',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=working updated=${t1} resume=${resume} -->`,
    '### Skill title',
    '- [~] Doing step',
    `<!-- /auto session=${localId} -->`,
    '',
    '## Project Beta',
    `<!-- auto session=${turnId} agent=codex state=working updated=${t2} resume=${resume} source=turns -->`,
    '### Hook title',
    '- [ ] Working in progress',
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')
  const crossProjectView = buildView(parseProgress(crossProjectProgress), [], null, baseNow, 0, {}, s)
  assert.equal(crossProjectView.groups.length, 1)
  assert.equal(crossProjectView.groups[0]?.project, 'Project Beta')
  assert.equal(crossProjectView.groups[0]?.rows.length, 1)
  assert.equal(crossProjectView.groups[0]?.rows[0]?.title, 'Hook title')
  assert.equal(crossProjectView.stopped.length, 0)

  // Row 12: either block carrying origin=run keeps conversation folded as a run (background or starter), never a row or Stopped.
  const runNewerProgress = [
    '# Progress',
    '',
    '## Demo',
    `<!-- auto session=${localId} agent=codex state=working updated=${t1} resume=${resume} -->`,
    '### Helper plain copy',
    '- [~] Running',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=working updated=${t2} resume=${resume} origin=run -->`,
    '### Helper run copy',
    '- [~] Running',
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')
  const runView = buildView(parseProgress(runNewerProgress), [], null, baseNow, 0, {}, s)
  assert.equal(runView.active.length, 0)
  assert.equal(runView.stopped.length, 0)
  assert.equal(Boolean(runView.background), true)
})

test('twin blocks keep a fresh working turn live and never pull done to Stopped (#1832)', async () => {
  const { blockId } = await import('../hooks/inbox.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { serveModel } = await import('../hooks/serve.ts')
  const { boardScreen, boardText, emptyBoardState } = await import('../hooks/board.ts')
  const { boardDocument } = await import('../hooks/board-json.ts')

  const s = STRINGS.en
  const resume = '019a1832-4444-4222-8333-444444444444'
  const localSession = createHash('sha256').update(`codex:${resume}`).digest('hex')
  const localId = localSession.slice(0, 8)
  const turnId = blockId('codex', resume)
  const now = Date.parse('2026-11-24T16:10:00.000Z')
  const tOld = new Date(now - 120_000).toISOString()
  const tMid = new Date(now - 60_000).toISOString()
  const tNew = new Date(now - 20_000).toISOString()
  const tStale = new Date(now - 13 * 3600_000).toISOString()
  const group = { now, repoOf: () => null, versions: { board: '0.25.1', package: null }, unreadable: [] }

  // Row 4: skill already marked done at tNew, while fresh hooks block is still working at tOld -> stays working mid-turn, then Done when turn ends.
  const midTurnProgress = [
    '# Progress',
    '',
    '## Demo',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=done updated=${tNew} resume=${resume} -->`,
    '### Mid-turn done skill',
    '- [x] Report written',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=working updated=${tOld} resume=${resume} source=turns -->`,
    '### Live hook turn',
    `- [ ] ${s.codexLifecycleWorking}`,
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')
  const midTurnView = buildView(parseProgress(midTurnProgress), [], null, now, 0, {}, s)
  assert.equal(midTurnView.stopped.length, 0)
  assert.equal(midTurnView.recent.length, 0)
  assert.equal(midTurnView.active.length, 1)
  assert.equal(midTurnView.active[0]?.auto, 'working')
  assert.equal(midTurnView.active[0]?.rowState, 'working')
  const midDoc = boardDocument(midTurnView, [], [], s, '', false, now, group)
  assert.equal(midDoc.counts.working, 1)
  assert.equal(midDoc.counts.stopped, 0)

  // Row 5: skill done + hooks waiting or ended, in EITHER write order -> one Done entry, never Stopped.
  for (const [hookState, skillTime, hookTime] of [
    ['waiting', tOld, tNew],
    ['waiting', tNew, tOld],
    ['ended', tOld, tNew],
    ['ended', tNew, tOld],
  ]) {
    const row5Progress = [
      '# Progress',
      '',
      '## Demo',
      `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=done updated=${skillTime} resume=${resume} -->`,
      '### Done skill task',
      '- [x] All done',
      `<!-- /auto session=${localId} -->`,
      '',
      `<!-- auto session=${turnId} agent=codex state=${hookState} updated=${hookTime} resume=${resume} source=turns -->`,
      '### Hook turn task',
      `- [ ] ${s.codexLifecycle}`,
      `<!-- /auto session=${turnId} -->`,
      '',
    ].join('\n')
    const view5 = buildView(parseProgress(row5Progress), [], null, now, 0, {}, s)
    assert.equal(view5.stopped.length, 0, `expected no stopped row for ${hookState} (${skillTime} vs ${hookTime})`)
    assert.equal(view5.active.length, 0)
    assert.equal(view5.recent.length, 1)
    const model5 = serveModel(view5, [], s, new Set(), false, undefined, false, group)
    assert.equal(model5.view?.all.done.length, 1)
    assert.equal(model5.view?.all.stopped.length, 0)
    const doc5 = boardDocument(view5, [], [], s, '', false, now, group)
    assert.equal(doc5.counts.doneRecently, 1)
    assert.equal(doc5.counts.stopped, 0)
    assert.equal(boardText(view5, [], s, { width: 100, isColor: false }).includes(s.sectionRecent), true)
    assert.equal(boardScreen(view5, [], emptyBoardState, s, { width: 100, isColor: false }).includes(s.sectionRecent), true)
  }

  // Row 6: stale or dead-process skill working block paired with fresh working or done hooks block -> fresh state wins.
  for (const [freshState, freshStep] of [
    ['working', `- [ ] ${s.codexLifecycleWorking}`],
    ['done', `- [x] ${s.codexLifecycle}`],
  ]) {
    const row6Progress = [
      '# Progress',
      '',
      '## Demo',
      `<!-- auto session=${turnId} agent=codex state=${freshState} updated=${tMid} resume=${resume} source=turns -->`,
      '### Fresh hook block',
      freshStep,
      `<!-- /auto session=${turnId} -->`,
      '',
      `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=working updated=${tStale} resume=${resume} -->`,
      '### Stale or gone skill block',
      '- [~] Stuck step',
      `<!-- /auto session=${localId} -->`,
      '',
    ].join('\n')
    const deadKey = `codex:${localId}:${tStale}`
    for (const goneSet of [new Set(), new Set([deadKey])]) {
      const view6 = buildView(parseProgress(row6Progress), [], null, now, 0, {}, s, [], {}, undefined, undefined, [], new Set(), undefined, undefined, undefined, goneSet)
      assert.equal(view6.stopped.length, 0)
      if (freshState === 'working') {
        assert.equal(view6.active.length, 1)
        assert.equal(view6.active[0]?.auto, 'working')
        assert.notEqual(view6.active[0]?.rowState, 'ended')
        assert.notEqual(view6.active[0]?.rowState, 'unsure')
      } else {
        assert.equal(view6.recent.length, 1)
      }
    }
  }
})

test('an open question on a folded twin appears once under Needs you and clears on answer (#1832)', async () => {
  const { blockId } = await import('../hooks/inbox.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { serveModel } = await import('../hooks/serve.ts')
  const { boardDocument } = await import('../hooks/board-json.ts')
  const { emptyQuestions, observeQuestions } = await import('../hooks/questions.ts')

  const s = STRINGS.en
  const resume = '019a1832-5555-4222-8333-555555555555'
  const localSession = createHash('sha256').update(`codex:${resume}`).digest('hex')
  const localId = localSession.slice(0, 8)
  const turnId = blockId('codex', resume)
  const now = Date.parse('2026-11-24T16:10:00.000Z')
  const t1 = new Date(now - 120_000).toISOString()
  const t2 = new Date(now - 60_000).toISOString()
  const group = { now, repoOf: () => null, versions: { board: '0.25.1', package: null }, unreadable: [] }

  // Row 11 (forward): loser (skill) has open [?], winner (hooks) has none; persisted ledger ID matches.
  const loserAskingProgress = [
    '# Progress',
    '',
    '## Demo',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=waiting updated=${t1} resume=${resume} -->`,
    '### Asking skill copy',
    '- [?] Which database should we use? — Postgres or SQLite?',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=working updated=${t2} resume=${resume} source=turns -->`,
    '### Active hook copy',
    `- [ ] ${s.codexLifecycleWorking}`,
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')

  const observed = observeQuestions(emptyQuestions(), parseProgress(loserAskingProgress), null, [], now - 90 * 60_000, true, 'writer:1').ledger
  const recL = observed.records.find(r => r.source?.session === localId)
  assert.ok(recL)

  const forwardView = buildView(parseProgress(loserAskingProgress), [], null, now, 0, {}, s, [], {}, observed)
  assert.equal(forwardView.waiting.length, 1)
  assert.equal(forwardView.waiting[0]?.sessionId, resume)
  assert.equal(forwardView.waiting[0]?.text, 'Which database should we use?')
  assert.equal(forwardView.waiting[0]?.questionId, recL.id)
  assert.equal(forwardView.waiting[0]?.hideKey, recL.id)
  assert.equal(forwardView.waiting[0]?.ageStage, 'pending')
  assert.equal(observed.records.some(r => r.id === recL.id && r.isWaiting && r.isPresent), true)
  const forwardModel = serveModel(forwardView, [], s, new Set(), false, undefined, false, group)
  assert.equal(forwardModel.asks.length, 1)
  assert.equal(forwardModel.asks[0]?.sessionId, resume)
  const forwardDoc = boardDocument(forwardView, [], [], s, '', false, now, group)
  assert.equal(forwardDoc.needs.length, 1)

  // Real ledger aging moves the carried-over ask to reminder (> 3 days) without losing its id.
  const agedObserved = observeQuestions(emptyQuestions(), parseProgress(loserAskingProgress), null, [], now - 4 * 86_400_000, true, 'writer:1').ledger
  const agedRecL = agedObserved.records.find(r => r.source?.session === localId)
  assert.ok(agedRecL)
  const agedView = buildView(parseProgress(loserAskingProgress), [], null, now, 0, {}, s, [], {}, agedObserved)
  assert.equal(agedView.reminder?.length, 1)
  assert.equal(agedView.reminder?.[0]?.questionId, agedRecL.id)
  assert.equal(agedView.reminder?.[0]?.ageStage, 'reminder')

  // Duplicate identical [?] on both twins is still asked only once.
  const bothAskingProgress = loserAskingProgress.replace(
    `- [ ] ${s.codexLifecycleWorking}`,
    '- [?] Which database should we use? — Postgres or SQLite?',
  )
  const bothView = buildView(parseProgress(bothAskingProgress), [], null, now, 0, {}, s)
  assert.equal(bothView.waiting.length, 1)

  // Answering via persisted recL.id clears Needs you and stays gone even after loser leaves progress.md (no resurfacing).
  const answeredView = buildView(parseProgress(loserAskingProgress), [], null, now, 0, {}, s, [recL.id], {}, observed)
  assert.equal(answeredView.waiting.length, 0)
  // Marked-answered carried ask on an ended winner remains visible in view.hidden so it can still be unhidden (#1832).
  const endedWinnerAnswered = buildView(parseProgress(loserAskingProgress.replace('state=working', 'state=ended')), [], null, now, 0, {}, s, [recL.id], {}, observed)
  assert.equal(endedWinnerAnswered.hidden.some(item => item.hideKey === recL.id), true)
  const winnerOnlyProgress = [
    '# Progress',
    '',
    '## Demo',
    `<!-- auto session=${turnId} agent=codex state=working updated=${t2} resume=${resume} source=turns -->`,
    '### Active hook copy',
    `- [ ] ${s.codexLifecycleWorking}`,
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')
  const afterLoserRemoved = buildView(parseProgress(winnerOnlyProgress), [], null, now, 0, {}, s, [recL.id], {}, observed)
  assert.equal(afterLoserRemoved.waiting.length, 0)
  assert.equal(afterLoserRemoved.older?.length ?? 0, 0)

  // Replying on winner AFTER loser updated clears carried-over question; OLDER reply on winner does NOT swallow a fresher ask on loser.
  const repliedAfterLoser = loserAskingProgress.replace(
    `updated=${t2} resume=${resume}`,
    `updated=${t2} replied=${new Date(now - 10_000).toISOString()} resume=${resume}`,
  )
  assert.equal(buildView(parseProgress(repliedAfterLoser), [], null, now, 0, {}, s).waiting.length, 0)

  const winnerOlderReply = loserAskingProgress
    .replace(`updated=${t1} resume=${resume}`, `updated=${new Date(now - 30_000).toISOString()} resume=${resume}`)
    .replace(`updated=${t2} resume=${resume}`, `updated=${new Date(now - 60_000).toISOString()} replied=${new Date(now - 50_000).toISOString()} resume=${resume}`)
  assert.equal(buildView(parseProgress(winnerOlderReply), [], null, now, 0, {}, s).waiting.length, 1)

  // Row 11 (reverse): winner has open [?], loser has none.
  const winnerAskingProgress = [
    '# Progress',
    '',
    '## Demo',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=working updated=${t1} resume=${resume} -->`,
    '### Quiet skill copy',
    '- [~] Preparing rollout',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=waiting updated=${t2} resume=${resume} source=turns -->`,
    '### Asking hook copy',
    '- [?] Deploy to staging now?',
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')
  const reverseView = buildView(parseProgress(winnerAskingProgress), [], null, now, 0, {}, s)
  assert.equal(reverseView.waiting.length, 1)
  assert.equal(reverseView.waiting[0]?.text, 'Deploy to staging now?')
  const reverseHideKey = reverseView.waiting[0]?.hideKey ?? ''
  assert.equal(buildView(parseProgress(winnerAskingProgress), [], null, now, 0, {}, s, [reverseHideKey]).waiting.length, 0)
})

test('a done block shows under Done on the page, the terminal board and --json, never under Stopped (#1832)', async () => {
  const { parseProgress } = await import('../hooks/parse.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { serveModel } = await import('../hooks/serve.ts')
  const { boardScreen, boardText, emptyBoardState } = await import('../hooks/board.ts')
  const { boardDocument } = await import('../hooks/board-json.ts')
  const { deriveRowState } = await import('../hooks/row-state.ts')

  const s = STRINGS.en
  const resume = '019a1832-2222-4222-8333-555555555555'
  const localSession = createHash('sha256').update(`codex:${resume}`).digest('hex')
  const localId = localSession.slice(0, 8)
  const now = Date.parse('2026-11-24T16:10:00.000Z')
  const updated = new Date(now - 120_000).toISOString()
  const group = { now, repoOf: () => null, versions: { board: '0.25.1', package: null }, unreadable: [] }

  const progress = [
    '# Progress',
    '',
    '## board-sitting-1125',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=done updated=${updated} resume=${resume} -->`,
    '### Done task from skill',
    '- [x] Step one',
    '- [x] Step two',
    `<!-- /auto session=${localId} -->`,
    '',
  ].join('\n')

  const projects = parseProgress(progress)
  const view = buildView(projects, [], null, now, 0, {}, s)
  assert.equal(view.stopped.length, 0)
  assert.equal(view.recent.length, 1)

  const model = serveModel(view, [], s, new Set(), false, undefined, false, group)
  assert.equal(model.stopped.length, 0)
  assert.equal(model.view?.all.done.length, 1)
  assert.equal(model.view?.agents.find(a => a.agent === 'codex')?.done.length, 1)

  for (const printed of [
    boardText(view, [], s, { width: 100, isColor: false }),
    boardScreen(view, [], emptyBoardState, s, { width: 100, isColor: false }),
  ]) {
    assert.equal(printed.includes(s.sectionRecent), true)
    assert.equal(printed.includes('Done task from skill'), true)
    assert.equal(printed.includes(s.empty), false)
    assert.equal(printed.includes(s.stoppedCount(1)), false)
  }

  const doc = boardDocument(view, [], [], s, '', false, now, group)
  assert.equal(doc.counts.doneRecently, 1)
  assert.equal(doc.doneRecently[0]?.title, 'Done task from skill')
  assert.equal(doc.counts.stopped, 0)
  assert.equal(doc.stopped.length, 0)

  const doneTask = projects[0].tasks[0]
  assert.equal(
    deriveRowState({
      auto: doneTask.auto,
      steps: doneTask.steps,
      mirror: null,
      events: { hasSessionEnd: false, lastEventAt: now - 120_000, host: 'codex' },
      liveness: 'dead',
      now,
      hasOpenAsk: false,
    }),
    'toCheck',
  )
})

test('archiving a winning row or tidying removes its hidden older twin copy so it does not resurrect (#1832)', async () => {
  const { blockId } = await import('../hooks/inbox.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { takeArchivable, takeTask } = await import('../hooks/blocks.ts')
  const { buildView } = await import('../hooks/view.ts')

  const s = STRINGS.en
  const resume = '019a1832-3333-4222-8333-666666666666'
  const localSession = createHash('sha256').update(`codex:${resume}`).digest('hex')
  const localId = localSession.slice(0, 8)
  const turnId = blockId('codex', resume)
  const now = Date.parse('2026-11-24T16:10:00.000Z')
  const t1 = new Date(now - 120_000).toISOString()
  const t2 = new Date(now - 60_000).toISOString()

  const endedText = [
    '# Progress',
    '',
    '## board-sitting-1125',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=working updated=${t1} resume=${resume} -->`,
    '### Older skill copy',
    '- [~] Counting lines',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=ended updated=${t2} resume=${resume} source=turns -->`,
    '### Winning hook copy',
    '- [ ] Finished turn',
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')

  const view = buildView(parseProgress(endedText), [], null, now, 0, {}, s)
  assert.equal(view.stopped.length, 1)
  const winnerArchive = view.stopped[0]?.archive
  assert.ok(winnerArchive)
  const archived = takeTask(endedText, winnerArchive, now, s)
  assert.ok(archived)
  assert.equal(parseProgress(archived.text).flatMap(p => p.tasks).length, 0)
  assert.equal(archived.entries.length, 2)

  const doneText = endedText.replace(`state=ended updated=${t2}`, `state=done updated=${t2}`).replace('- [ ] Finished turn', '- [x] Finished turn')
  const tidied = takeArchivable(doneText, now, undefined, s, true)
  assert.equal(parseProgress(tidied.text).flatMap(p => p.tasks).length, 0)
  assert.equal(tidied.entries.length, 2)

  // Asking older twin is NOT swept by takeTask so unretained [?] steps are never lost (#1832).
  const askingTwinText = endedText.replace('- [~] Counting lines', '- [?] Blue or green?')
  const askingView = buildView(parseProgress(askingTwinText), [], null, now, 0, {}, s)
  const askingArchived = takeTask(askingTwinText, askingView.stopped[0].archive, now, s)
  assert.ok(askingArchived)
  assert.equal(askingArchived.entries.length, 1)
  assert.equal(parseProgress(askingArchived.text).flatMap(p => p.tasks).length, 1)

  // sweepTwins = false (used by previewTidy / bulkTidy) removes only the targeted block.
  const singleOnly = takeTask(endedText, winnerArchive, now, s, {}, undefined, new Set(), false)
  assert.ok(singleOnly)
  assert.equal(singleOnly.entries.length, 1)
  assert.equal(parseProgress(singleOnly.text).flatMap(p => p.tasks).length, 1)

  // Older twin holding a separate hand-kept `###` task inside its markers is never swept (#1832).
  const extraTaskTwinText = endedText.replace(
    `- [~] Counting lines\n<!-- /auto session=${localId} -->`,
    `- [~] Counting lines\n### Unrelated hand-kept task\n- [ ] Keep this open work\n<!-- /auto session=${localId} -->`,
  )
  const extraTaskView = buildView(parseProgress(extraTaskTwinText), [], null, now, 0, {}, s)
  const extraTaskArchived = takeTask(extraTaskTwinText, extraTaskView.stopped[0].archive, now, s)
  assert.ok(extraTaskArchived)
  assert.equal(extraTaskArchived.entries.length, 1)
  assert.ok(extraTaskArchived.text.includes('Keep this open work'))
  assert.ok(parseProgress(extraTaskArchived.text).flatMap(p => p.tasks).some(t => t.title === 'Unrelated hand-kept task'))

  const extraTaskDoneText = extraTaskTwinText.replace(`state=ended updated=${t2}`, `state=done updated=${t2}`).replace('- [ ] Finished turn', '- [x] Finished turn')
  const extraTaskTidied = takeArchivable(extraTaskDoneText, now, undefined, s, true)
  assert.equal(extraTaskTidied.entries.length, 1)
  assert.ok(extraTaskTidied.text.includes('Keep this open work'))
  assert.ok(parseProgress(extraTaskTidied.text).flatMap(p => p.tasks).some(t => t.title === 'Unrelated hand-kept task'))

  // Row 13 (reverse-order Row-5 sweep + unrelated same-prefix session + adjacent hand-kept work + live duplicate archive).
  const row5SweepText = [
    '# Progress',
    '',
    '## board-sitting-1125',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=done updated=${t1} resume=${resume} -->`,
    '### Done skill copy',
    '- [x] Done step',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=ended updated=${t2} resume=${resume} source=turns -->`,
    '### Ended hook copy',
    `- [ ] ${s.codexLifecycle}`,
    `<!-- /auto session=${turnId} -->`,
    '',
    `<!-- auto session=${localId} agent=codex state=working updated=${t2} resume=019a1832-9999-4222-8333-999999999999 -->`,
    '### Other conversation sharing 8-char prefix',
    '- [~] Must remain',
    `<!-- /auto session=${localId} -->`,
    '',
    '### Adjacent hand-kept task',
    '- [ ] Must remain untouched',
    '',
  ].join('\n')
  const row5Tidied = takeArchivable(row5SweepText, now, undefined, s, true)
  assert.equal(row5Tidied.entries.length, 2)
  assert.ok(row5Tidied.text.includes('Must remain'))
  assert.ok(row5Tidied.text.includes('Must remain untouched'))
  assert.ok(!row5Tidied.text.includes('Done skill copy'))
  assert.ok(!row5Tidied.text.includes('Ended hook copy'))

  // Row 13: archiving only the hidden duplicate keeps live winner writable and its row alive.
  const liveTwinText = endedText.replace(`state=ended updated=${t2}`, `state=working updated=${t2}`)
  const liveDupRemoved = takeTask(liveTwinText, { project: 'board-sitting-1125', title: 'Older skill copy', line: 4, session: localId, isDuplicate: true }, now, s)
  assert.ok(liveDupRemoved)
  assert.equal(liveDupRemoved.entries.length, 1)
  assert.ok(liveDupRemoved.text.includes('Winning hook copy'))
  assert.equal(buildView(parseProgress(liveDupRemoved.text), [], null, now, 0, {}, s).active.length, 1)

  // Row 14: cut-off (unclosed) folded twin is never removed; changed file between read and write causes takeTask to bail out.
  const unclosedTwinText = endedText.replace(`<!-- /auto session=${localId} -->`, '')
  const unclosedView = buildView(parseProgress(unclosedTwinText), [], null, now, 0, {}, s)
  assert.equal(unclosedView.stopped.length, 1)
  const takeOnUnclosedWinner = takeTask(unclosedTwinText, unclosedView.stopped[0].archive, now, s)
  assert.ok(takeOnUnclosedWinner)
  assert.equal(takeOnUnclosedWinner.entries.length, 1)
  assert.ok(takeOnUnclosedWinner.text.includes('Older skill copy'))
  const tidiedUnclosed = takeArchivable(unclosedTwinText, now, undefined, s, true)
  assert.equal(tidiedUnclosed.entries.length, 0)
  assert.ok(tidiedUnclosed.text.includes('Older skill copy'))
  assert.equal(takeTask(liveTwinText, winnerArchive, now, s), null)

  // Row 4 / Row 13 safety: mid-turn done skill block (t2 > t1) NEVER sweeps a live fresh working hooks block (t1).
  const midTurnRow4Text = [
    '# Progress',
    '',
    '## board-sitting-1125',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=done updated=${t2} resume=${resume} -->`,
    '### Done skill mid-turn',
    '- [x] Report finished',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=working updated=${t1} resume=${resume} source=turns -->`,
    '### Live working hooks',
    `- [ ] ${s.codexLifecycleWorking}`,
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')
  const midTurnTidied = takeArchivable(midTurnRow4Text, now, undefined, s, true)
  assert.equal(midTurnTidied.entries.length, 0)
  assert.ok(midTurnTidied.text.includes('Live working hooks'))
  const directTakeOnMidTurnSkill = takeTask(midTurnRow4Text, { project: 'board-sitting-1125', title: 'Done skill mid-turn', line: 4, session: localId }, now, s)
  assert.ok(directTakeOnMidTurnSkill)
  assert.equal(directTakeOnMidTurnSkill.entries.length, 1)
  assert.ok(directTakeOnMidTurnSkill.text.includes('Live working hooks'))
})

test('non-Claude ended row without a target gets send=none and no Copy answer box (#1832)', async () => {
  const { serveModel } = await import('../hooks/serve.ts')
  const s = STRINGS.en
  const now = Date.parse('2026-11-24T16:10:00.000Z')
  const endedRow = {
    key: 'board-sitting-1125::Stopped copy',
    project: 'board-sitting-1125',
    title: 'Stopped copy',
    context: '',
    done: 1,
    total: 1,
    status: s.sessionEnded,
    tone: 'quiet',
    when: '1 min ago',
    at: now - 60_000,
    isHere: false,
    auto: 'ended',
    steps: [],
    cells: [],
    left: [],
    next: null,
    due: null,
    pr: '',
    agent: 'codex',
    resume: null,
    question: null,
    handoff: '',
    archive: { project: 'board-sitting-1125', title: 'Stopped copy', line: 3, session: 'aabbccdd' },
    confirm: null,
    target: null,
  }
  const fakeView = {
    now,
    current: null,
    pr: null,
    overview: { waiting: 0, active: 0, due: 0, today: 0, idle: 0, stopped: 1 },
    focus: null,
    waiting: [],
    hidden: [],
    idle: [],
    stopped: [endedRow],
    due: [],
    active: [],
    groups: [],
    recent: [],
  }
  const model = serveModel(fakeView, [], s)
  assert.equal(model.stopped.length, 1)
  assert.equal(model.stopped[0]?.send, 'none')
  assert.equal(model.stopped[0]?.hasCopyBox, false)
})

test('after folding to one row both writers keep writing and othersNote deduplicates (#1832)', async () => {
  const { blockId } = await import('../hooks/inbox.ts')
  const { putCodexBlock } = await import('../hooks/codex.ts')
  const { confirmTask, upsertAutoBlock } = await import('../hooks/blocks.ts')
  const { emptyMirror } = await import('../hooks/mirror.ts')
  const { othersNote } = await import('../hooks/others.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { sendPlan } = await import('../hooks/serve.ts')

  const s = STRINGS.en
  const resume = '019a1832-6666-4222-8333-666666666666'
  const owner = createHash('sha256').update(`codex:${resume}`).digest('hex')
  const turnId = blockId('codex', resume)
  const now = Date.parse('2026-11-24T16:10:00.000Z')
  const peer = { sessionId: '99990000', agent: 'codex', resume: '99990000-0000-4000-8000-000000000099' }

  const skillReport1 = {
    agent: 'codex',
    session: resume,
    project: 'Demo',
    title: 'Skill feature',
    state: 'working',
    updated: new Date(now - 90_000).toISOString(),
    steps: ['- [~] Writing code'],
  }
  const hookMirror1 = {
    ...emptyMirror(turnId, 'Demo', now - 60_000, ''),
    agent: 'codex',
    resume,
    title: 'Hook turn',
    cwd: '/tmp/demo',
    source: 'turns',
  }
  const hookMirror1WithTask = { ...hookMirror1, tasks: [{ id: '1', subject: s.codexLifecycleWorking, status: 'in_progress', waiting: null, blocked: null }] }

  let text = '# Progress\n\n## Demo\n'
  text = putCodexBlock(text, skillReport1, owner)
  text = upsertAutoBlock(text, hookMirror1WithTask, s)

  // Both writers write again cleanly: no BLOCK_CONFLICT / BLOCK_NOT_VISIBLE, still 2 blocks and 1 row.
  text = putCodexBlock(text, { ...skillReport1, updated: new Date(now - 30_000).toISOString(), steps: ['- [x] Writing code', '- [~] Testing'] }, owner)
  text = upsertAutoBlock(text, { ...hookMirror1WithTask, updated: now - 15_000 }, s)

  const blocks = parseProgress(text).flatMap(p => p.tasks)
  assert.equal(blocks.length, 2)

  const liveView = buildView(parseProgress(text), [], null, now, 0, {}, s)
  assert.equal(liveView.active.length, 1)
  assert.equal(liveView.stopped.length, 0)
  const target = liveView.active[0]?.target
  assert.ok(target)
  const plan = sendPlan(target, 'Please run tests', false)
  assert.ok(plan)
  assert.equal(plan.args.includes(resume), true)

  // Also verify dir=, sendPlan, and confirmTask (confirmKey) survive when codex-local (dir: null) wins over source=turns (has dir=).
  text = putCodexBlock(text, { ...skillReport1, updated: new Date(now - 10_000).toISOString(), steps: ['- [x] Writing code', '- [~] Testing'] }, owner)
  const skillWinnerView = buildView(parseProgress(text), [], null, now, 0, {}, s)
  assert.equal(skillWinnerView.active.length, 1)
  const skillWinnerTarget = skillWinnerView.active[0]?.target
  assert.ok(skillWinnerTarget?.dir)
  assert.equal(sendPlan(skillWinnerTarget, 'Follow up', false)?.args.includes(resume), true)

  const endedTextWithInheritedDir = putCodexBlock(
    upsertAutoBlock('# Progress\n\n## Demo\n', { ...hookMirror1WithTask, state: 'ended', updated: now - 20_000 }, s),
    { ...skillReport1, state: 'ended', updated: new Date(now - 10_000).toISOString(), steps: ['- [~] Finish stopped step'] },
    owner,
  )
  const stoppedView = buildView(parseProgress(endedTextWithInheritedDir), [], null, now, 0, {}, s)
  assert.equal(stoppedView.stopped.length, 1)
  assert.equal(stoppedView.stopped[0]?.target?.dir, '/tmp/demo')
  assert.ok(stoppedView.stopped[0]?.confirm)
  const confirmed = confirmTask(endedTextWithInheritedDir, stoppedView.stopped[0].confirm, now, s)
  assert.ok(confirmed)
  assert.equal(confirmed.text.includes('- [x] Finish stopped step'), true)

  // othersNote lists the open conversation once (never twice).
  const openNote = othersNote(parseProgress(text), ['Demo'], peer, now, s)
  assert.ok(openNote)
  const listedLines = openNote.split('\n').filter(line => line.startsWith('- '))
  assert.equal(listedLines.length, 1)

  // Once skill marks done while hooks is waiting/ended, othersNote omits the finished conversation.
  text = putCodexBlock(text, { ...skillReport1, state: 'done', updated: new Date(now - 5_000).toISOString(), steps: ['- [x] Writing code', '- [x] Testing'] }, owner)
  text = upsertAutoBlock(text, { ...hookMirror1WithTask, state: 'ended', updated: now - 1_000, tasks: [{ id: '1', subject: s.codexLifecycle, status: 'todo', waiting: null, blocked: null }] }, s)
  assert.equal(othersNote(parseProgress(text), ['Demo'], peer, now, s), null)
})

test('folded twin handoffs, takeArchivable staleMs, and collectFinished foldOptions (#1832 bot P1 fixes)', async () => {
  const { blockId } = await import('../hooks/inbox.ts')
  const { parseProgress } = await import('../hooks/parse.ts')
  const { sessionPushNote } = await import('../hooks/others.ts')
  const { takeArchivable } = await import('../hooks/blocks.ts')
  const { collectFinished } = await import('../hooks/board-json.ts')

  const s = STRINGS.en
  const resume = '019a1832-7777-4222-8333-777777777777'
  const localSession = createHash('sha256').update(`codex:${resume}`).digest('hex')
  const localId = localSession.slice(0, 8)
  const turnId = blockId('codex', resume)
  const now = Date.parse('2026-11-24T16:10:00.000Z')
  const tOld = new Date(now - 120_000).toISOString()
  const tMid = new Date(now - 60_000).toISOString()
  const t13h = new Date(now - 13 * 3600_000).toISOString()

  // 1. Folded twin Handoff: / Transferred / running still push once, while losing done twin emits no finished notice.
  const pushBoard = [
    '# Progress',
    '',
    '## Demo',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=done updated=${tOld} resume=${resume} -->`,
    '### Skill task',
    '- [x] Done step - Handed to reviewer',
    '- [>] Ping @reviewer for smoke check',
    '> Handoff: @reviewer — review PR',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=working updated=${tMid} resume=${resume} source=turns -->`,
    '### Hook turn',
    `- [ ] ${s.codexLifecycleWorking}`,
    '> Handoff: @reviewer — review PR',
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')
  const push = sessionPushNote(parseProgress(pushBoard), ['Demo'], { sessionId: 'rev12345', agent: 'reviewer', title: 'Review work', steps: ['- [?] Waiting for Skill task'] }, new Set(), now, s)
  assert.ok(push.note)
  assert.equal(push.keys.filter(k => k.startsWith('handoff:')).length, 3)
  assert.equal(push.keys.some(k => k.startsWith('waited:')), false)

  // 2. takeArchivable forwards custom staleMs into pickTwinWinner / outrankedBy.
  const archiveBoard = [
    '# Progress',
    '',
    '## Demo',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=done updated=${t13h} resume=${resume} -->`,
    '### Old done skill',
    '- [x] Done step',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=working updated=${t13h} resume=${resume} source=turns -->`,
    '### 13h working hook',
    `- [ ] ${s.codexLifecycleWorking}`,
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')
  assert.equal(takeArchivable(archiveBoard, now, undefined, s).entries.length, 2)
  assert.equal(takeArchivable(archiveBoard, now, undefined, s, false, undefined, undefined, { staleMs: 24 * 3600_000 }).entries.length, 0)

  // 3. collectFinished honours staleMs and gone when deduplicating twin blocks.
  const { blockKey } = await import('../hooks/session-liveness.ts')
  const finishedBoard = [
    '# Progress',
    '',
    '## Demo',
    `<!-- auto session=${localId} agent=codex source=codex-local owner=${localSession} state=done updated=${tMid} resume=${resume} -->`,
    '### Done skill twin',
    '- [x] All done',
    `<!-- /auto session=${localId} -->`,
    '',
    `<!-- auto session=${turnId} agent=codex state=working updated=${tOld} resume=${resume} source=turns agentpid=43210 agentstarted=1700000 -->`,
    '### Older working hook twin',
    `- [ ] ${s.codexLifecycleWorking}`,
    `<!-- /auto session=${turnId} -->`,
    '',
  ].join('\n')
  assert.equal(collectFinished(finishedBoard, [], [], 7, now).length, 0)
  assert.equal(collectFinished(finishedBoard, [], [], 7, now, undefined, '', false, { staleMs: 60_000 }).length, 1)
  assert.equal(collectFinished(finishedBoard, [], [], 7, now, undefined, '', false, { gone: new Set([blockKey({ agent: 'codex', session: turnId, resume, agentPid: 43210, agentStarted: 1700000 })]) }).length, 1)
})

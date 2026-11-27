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

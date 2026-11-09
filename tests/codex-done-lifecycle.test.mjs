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

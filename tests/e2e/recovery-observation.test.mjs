import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { test } from 'node:test'
import { observeHookRecovery } from './lib/recovery-observation.mjs'

const recoveryFiles = root => {
  const progress = join(root, 'progress.md')
  const pending = join(root, 'pending')
  const inflight = join(root, 'inflight')
  mkdirSync(pending)
  mkdirSync(inflight)
  writeFileSync(progress, '')
  return {
    progress,
    pending,
    inflight,
    read: () => ({
      source: readFileSync(progress, 'utf8'),
      pending: readdirSync(pending).sort(),
      files: [progress, ...readdirSync(pending).map(name => join(pending, name)), ...readdirSync(inflight).map(name => join(inflight, name))],
    }),
  }
}

test('L5 recovery observation waits for a claimed event to land before judging a lost hook', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-recovery-observation-'))
  try {
    const fixture = recoveryFiles(root)
    const event = 'codex-race-session-2.json'
    const pendingEvent = join(fixture.pending, event)
    const inflightEvent = join(fixture.inflight, event)
    writeFileSync(pendingEvent, '{}')
    const write = (async () => {
      await pause(20)
      renameSync(pendingEvent, inflightEvent)
      await pause(50)
      writeFileSync(fixture.progress, '<!-- auto session=abc agent=codex resume=codex-race-session-2 state=done -->\n')
    })()

    const started = performance.now()
    const observed = await observeHookRecovery({ read: fixture.read, sessions: ['codex-race-session-2'], withinMs: 500, pollMs: 5 })
    const observedElapsed = performance.now() - started
    await write

    assert.equal(observed.isSettled, true)
    assert.equal(observed.hasTimedOut, false)
    assert.ok(observedElapsed >= 50, 'the observer returned before the delayed progress write could land')
    assert.deepEqual(observed.counts, { 'codex-race-session-2': 1 })
    assert.ok(observed.snapshots.some(snapshot => snapshot.pending.includes(event) && snapshot.counts['codex-race-session-2'] === 0))
    assert.ok(observed.snapshots.some(snapshot => snapshot.pending.length === 0 && snapshot.counts['codex-race-session-2'] === 0))
    assert.ok(observed.snapshots.some(snapshot => snapshot.pending.length === 0 && snapshot.counts['codex-race-session-2'] === 1))
    assert.ok(observed.files.includes(inflightEvent))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('L5 recovery observation reports missing and pending hooks after its bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-recovery-observation-'))
  try {
    const fixture = recoveryFiles(root)
    const event = 'missing-session.json'
    writeFileSync(join(fixture.pending, event), '{}')

    const observed = await observeHookRecovery({ read: fixture.read, sessions: ['missing-session'], withinMs: 30, pollMs: 5 })

    assert.equal(observed.isSettled, false)
    assert.equal(observed.hasTimedOut, true)
    assert.deepEqual(observed.counts, { 'missing-session': 0 })
    assert.deepEqual(observed.pending, [event])
    assert.deepEqual(observed.snapshots[0]?.counts, { 'missing-session': 0 })
    assert.deepEqual(observed.snapshots[0]?.pending, [event])
    assert.ok(observed.files.some(file => file.endsWith(event)))

    const lateFile = join(root, 'late.md')
    const late = await observeHookRecovery({
      sessions: ['late-session'],
      withinMs: 5,
      pollMs: 1,
      read: () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
        writeFileSync(lateFile, 'resume=late-session ')
        return { source: readFileSync(lateFile, 'utf8'), pending: [], files: ['late.md'] }
      },
    })
    assert.equal(late.isSettled, false, 'a complete read after the deadline is not a timely recovery')
    assert.equal(late.hasTimedOut, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('L5 recovery observation rejects duplicate hook blocks without hiding repairs', async () => {
  let reads = 0
  const read = () => {
    reads += 1
    const block = '<!-- auto session=abc agent=codex resume=session.with[$] state=done -->\n'
    return { source: reads === 1 ? block + block : block, pending: [], files: [] }
  }

  const observed = await observeHookRecovery({ read, sessions: ['session.with[$]'], withinMs: 100, pollMs: 5 })

  assert.equal(observed.isSettled, false)
  assert.equal(observed.hasTimedOut, false)
  assert.deepEqual(observed.counts, { 'session.with[$]': 2 })
  assert.equal(reads, 1)
})

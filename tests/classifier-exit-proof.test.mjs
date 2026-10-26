import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { reporterPs1 } from '../hooks/hook-reporters.ts'
import { assertClassifierExited, observeClassifierExit } from './fixtures/classifier-exit-proof.mjs'

test('classifier exit proof refuses missing, unstarted, live and malformed observations without exposing their contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'classifier-exit-proof-'))
  const file = join(dir, 'proof.json')
  try {
    const refuses = () => assert.throws(() => assertClassifierExited(file), error => {
      assert.equal(error.code, 'CLASSIFIER_EXIT_UNPROVEN')
      assert.equal(error.keepFixture, true)
      assert.ok(!/PRIVATE_|123456789/.test(inspect(error)))
      return true
    })
    refuses()
    for (const value of [null, [], { started: false, exited: true }, { started: true, exited: false }, { started: true, exited: true, pid: 123456789 }, { started: 'true', exited: true }]) {
      writeFileSync(file, JSON.stringify(value))
      refuses()
    }
    writeFileSync(file, 'PRIVATE_MALFORMED')
    refuses()
    writeFileSync(file, '\uFEFF{"started":true,"exited":true}')
    assertClassifierExited(file)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the classifier exit observer keeps its original kill, wait and receipt budget intact', () => {
  const source = reporterPs1()
  const observed = observeClassifierExit(source, "C:/synthetic observer's proof.json")
  assert.ok(observed.includes("synthetic observer''s proof.json"))
  for (const line of source.split('\n').filter(line => /Kill\(\)|WaitForExit\(|ElapsedMilliseconds|REPORTER_TIMEOUT/.test(line))) {
    assert.ok(observed.includes(line), 'the observer preserves each original termination and budget operation')
  }
  assert.ok(observed.indexOf('$process.HasExited } } catch {}') < observed.indexOf('$process.Dispose()'))
  assert.ok(observed.indexOf("[IO.File]::WriteAllText('C:/synthetic") > observed.lastIndexOf('Remove-Item -LiteralPath'))
  assert.throws(() => observeClassifierExit('not a reporter', 'proof.json'))
})

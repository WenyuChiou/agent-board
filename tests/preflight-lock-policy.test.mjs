import test from 'node:test'
import assert from 'node:assert/strict'
import { testLockNamespaceProblem } from '../scripts/preflight-lock-policy.mjs'

const boot = '00000000-0000-4000-8000-000000000001'
const identity = (pid = '100', ticks = '10', time = '20') => `linux:${boot}:${ticks}${time === null ? '' : `:time:[${time}]`}:pid:[${pid}]`
const check = (recordedIdentity, selfIdentity, platform = 'linux') =>
  testLockNamespaceProblem({ platform, recordedIdentity, selfIdentity })

test('namespace gate permits a same-namespace PID probe without comparing process start ticks', () => {
  assert.equal(check(identity(), identity('100', '11')), null)
})

test('namespace gate blocks a foreign namespace before any PID liveness result is needed', () => {
  assert.equal(check(identity('100'), identity('200')), 'namespace')
})

test('namespace gate compares namespace identifiers as strings without losing integer precision', () => {
  assert.equal(check(identity('9007199254740992'), identity('9007199254740993')), 'namespace')
})

test('namespace gate permits a PID probe across time namespaces without relaxing the later identity check', () => {
  assert.equal(check(identity('100', '10', '20'), identity('100', '11', '21')), null)
  assert.equal(check(identity('100', '10', null), identity()), null)
  assert.equal(check(identity(), identity('100', '11', null)), null)
})

for (const [name, value, expected] of [
  ['a legacy record', undefined, 'legacy'],
  ['an unreadable record', null, 'unknown'],
  ['an untagged Linux record', `linux:${boot}:10:time:[20]`, 'namespace'],
  ['a malformed namespace', `linux:${boot}:10:time:[20]:pid:[bad]`, 'namespace'],
  ['a truncated identity', `linux:${boot}:10:pid:[100`, 'namespace'],
  ['trailing text', `${identity()} extra`, 'namespace'],
  ['a trailing newline', `${identity()}\n`, 'namespace'],
  ['a forged suffix', `unrelated:pid:[100]`, 'namespace'],
  ['a malformed boot identity', 'linux:not-a-boot:10:time:[20]:pid:[100]', 'namespace'],
  ['an empty record', '', 'namespace'],
  ['a non-string record', {}, 'namespace'],
]) {
  test(`namespace gate blocks ${name} even when a local PID could appear dead`, () => {
    assert.equal(check(value, identity()), expected)
  })
}

for (const [name, value, expected] of [
  ['an unreadable reader', null, 'unknown'],
  ['an absent reader', undefined, 'unknown'],
  ['an inherited procfs reader without a PID tag', `linux:${boot}:10:time:[20]`, 'namespace'],
  ['a malformed reader namespace', `linux:${boot}:10:time:[20]:pid:[bad]`, 'namespace'],
]) {
  test(`namespace gate blocks ${name}`, () => assert.equal(check(identity(), value), expected))
}

for (const platform of ['win32', 'darwin', 'freebsd']) {
  test(`namespace gate leaves ${platform} liveness and identity decisions unchanged`, () => {
    for (const recorded of [undefined, null, '2024-11-04T05:06:07.1234567Z', identity('100')]) {
      for (const current of [undefined, null, 'darwin-second:2024-11-04T05:06:07.000Z', identity('200')]) {
        assert.equal(check(recorded, current, platform), null)
      }
    }
  })
}

test('namespace gate does not mutate its input or require a liveness callback', () => {
  const input = Object.freeze({ platform: 'linux', recordedIdentity: identity('100'), selfIdentity: identity('200') })
  assert.equal(testLockNamespaceProblem(input), 'namespace')
  assert.deepEqual(input, { platform: 'linux', recordedIdentity: identity('100'), selfIdentity: identity('200') })
})

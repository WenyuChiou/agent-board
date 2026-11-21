import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { installCommand, installContext } from '../scripts/setup-command.mjs'

const quote = word => `'${word.replaceAll("'", "'\\''")}'`

test('install commands retain only explicit context in a fixed order and emit derived data once', () => {
  const options = ['--home', '--data-dir', '--progress-file', '--lang', '--codex-dir', '--grok-dir', '--hermes-dir', '--opencode-dir', '--openclaw-dir', '--deepseek-dir']
  const args = [...options].reverse().flatMap(flag => [flag, flag + ' value'])
  const context = { program: 'node board.mjs', ...installContext([...args, '--apply', '--json', '--plain', '--agent', 'hermes', '--codex-trust', '--unknown', 'ignored']), dataDir: 'derived' }
  const built = installCommand(context, { target: 'board', mode: '--codex-doctor' }, quote)
  // A board runs from its script's folder, so that folder replaces an explicit --data-dir naming another (#1356).
  assert.deepEqual(built.argv, [...options.flatMap(flag => [flag, flag === '--data-dir' ? 'derived' : flag + ' value']), '--codex-doctor'])
  assert.equal(built.argv.filter(word => word === '--data-dir').length, 1)
  const same = installCommand({ program: 'board', ...installContext(['--data-dir', 'relative data']), dataDir: resolve('relative data') }, { target: 'board' }, quote)
  assert.deepEqual(same.argv, ['--data-dir', 'relative data'], 'an explicit folder that is the script folder stays as typed')
  const derived = installCommand({ program: 'board', ...installContext(['--home', 'explicit home', '--lang', 'en']), dataDir: 'derived' }, { target: 'board' }, quote)
  assert.deepEqual(derived.argv, ['--home', 'explicit home', '--data-dir', 'derived', '--lang', 'en'])
  assert.deepEqual(installCommand({ program: 'board', ...installContext([]) }, { target: 'board' }, quote).argv, [])
})

test('install commands require explicit consent and keep setup-only switches away from board invocations', () => {
  const context = { program: 'board', ...installContext(['--apply', '--json', '--plain', '--antigravity-sidecar', '--remove']) }
  assert.deepEqual(installCommand(context, { target: 'board', mode: '--hermes-trust', extra: ['--antigravity-sidecar', '--remove', '--apply'] }, quote).argv, ['--hermes-trust'])
  assert.deepEqual(installCommand(context, { target: 'board', mode: '--hermes-trust', apply: true, extra: ['--json', '--json'] }, quote).argv, ['--hermes-trust', '--json', '--apply'])
  assert.deepEqual(installCommand(context, { target: 'setup', agent: 'antigravity', apply: true, extra: ['--antigravity-sidecar', '--json'] }, quote).argv, ['--agent', 'antigravity', '--antigravity-sidecar', '--apply'])
})

test('a missing-host command is not runnable and ends with its quoted placeholder without mutating context', () => {
  const flags = Object.freeze(['--codex-dir', 'custom profile'])
  const context = Object.freeze({ program: 'board', flags })
  const built = installCommand(context, { target: 'board', mode: '--codex-trust', codexBin: { placeholder: '<full path to codex>' } }, quote)
  assert.equal(built.isRunnable, false)
  assert.ok(built.text.endsWith("--codex-bin' '<full path to codex>'"))
  assert.equal(built.argv.at(-1), '<full path to codex>')
  built.argv.push('changed result')
  assert.deepEqual(flags, ['--codex-dir', 'custom profile'])
  const actual = installCommand(context, { target: 'board', mode: '--codex-trust', codexBin: 'explicit binary' }, quote, (program, argv, isRunnable) => JSON.stringify({ program, argv, isRunnable }))
  assert.equal(actual.isRunnable, true)
  assert.deepEqual(JSON.parse(actual.text).argv, ['--codex-dir', 'custom profile', '--codex-trust', '--codex-bin', 'explicit binary'])
})

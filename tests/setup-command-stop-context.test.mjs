import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { fixture } from './helpers/setup-fixture.mjs'

const launcher = fileURLToPath(new URL('../bin/agent-board.mjs', import.meta.url))

const invoke = (f, program, words) => spawnSync(process.execPath, [program, ...words], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
const succeeded = result => {
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
}
const echo = (words, expected) => fixture((unused, f) => {
  f.env.LANG = 'en_US.UTF-8'
  const data = join(f.root, 'selected install')
  mkdirSync(data)
  writeFileSync(join(data, 'agent-board.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  const result = invoke(f, launcher, words(data, f.env.CLAUDE_PROGRESS_FILE))
  succeeded(result)
  assert.match(result.stderr, /is a different build \(newer, or edited\)\. It runs as it is\./)
  const argv = JSON.parse(result.stdout)
  assert.deepEqual(argv, expected(data, f.env.CLAUDE_PROGRESS_FILE))
  assert.equal(argv[0], 'stop')
  assert.equal(argv.filter(word => word === '--data-dir').length, 1)
})

test('stop before an explicit data root stays first in the installed script argv', () => echo(
  data => ['stop', '--data-dir', data],
  data => ['stop', '--data-dir', data],
))

test('stop after an explicit data root stays first in the installed script argv', () => echo(
  data => ['--data-dir', data, 'stop'],
  data => ['stop', '--data-dir', data],
))

test('stop keeps progress arguments in order before the appended explicit data root', () => echo(
  (data, progress) => ['stop', '--data-dir', data, '--progress-file', progress],
  (data, progress) => ['stop', '--progress-file', progress, '--data-dir', data],
))

const stopInstalled = (lang, isRootFirst, expected) => fixture((setup, f) => {
  setup('--agent', 'grok', '--lang', 'en', '--apply')
  const data = join(f.root, 'data')
  const args = ['--progress-file', f.env.CLAUDE_PROGRESS_FILE, '--lang', lang, '--print']
  // Exercise the real installed stop branch without a live page, and keep a broken dispatch from opening one.
  const control = invoke(f, join(data, 'agent-board.mjs'), ['--stop', '--data-dir', data, ...args])
  succeeded(control)
  assert.equal(control.stderr, '')
  assert.equal(control.stdout, expected + '\n')
  const ordered = isRootFirst ? ['--data-dir', data, 'stop'] : ['stop', '--data-dir', data]
  const result = invoke(f, launcher, [...ordered, ...args])
  succeeded(result)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout, control.stdout, 'the launcher must stop the installed board, not print or open it')
})

test('an explicit custom install keeps the positional stop command on the installed-board path', () => stopInstalled('en', false, 'No board page is running for this file.'))
test('an explicit root before stop reaches the real installed board in English', () => stopInstalled('en', true, 'No board page is running for this file.'))
test('stop before an explicit root reaches the real installed board in traditional Chinese', () => stopInstalled('zh-TW', false, '這個檔案沒有正在執行的看板網頁。'))
test('an explicit root before stop reaches the real installed board in traditional Chinese', () => stopInstalled('zh-TW', true, '這個檔案沒有正在執行的看板網頁。'))
test('stop before an explicit root reaches the real installed board in simplified Chinese', () => stopInstalled('zh-CN', false, '这个文件没有正在运行的看板网页。'))
test('an explicit root before stop reaches the real installed board in simplified Chinese', () => stopInstalled('zh-CN', true, '这个文件没有正在运行的看板网页。'))

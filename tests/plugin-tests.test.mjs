import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as runner from '../scripts/plugin-tests.mjs'
import { failureReason, listTestFiles, runChild, runPool } from '../scripts/plugin-tests.mjs'

const report = (file, results) => `claude-plugin-test-report ${JSON.stringify({ file, results })}\n`
const pass = { title: 'a', ms: 1, failure: null, advice: [] }

test('lists .test.ts and .test.tsx files at any depth, skipping node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-tests-'))
  try {
    for (const dir of ['tests', 'tests/nested/deep', 'node_modules/pkg']) await mkdir(join(root, dir), { recursive: true })
    for (const name of ['tests/b.test.tsx', 'tests/a.test.ts', 'tests/c.test.mjs', 'tests/helpers.ts', 'tests/nested/deep/n.test.ts', 'node_modules/pkg/x.test.ts']) await writeFile(join(root, name), '')
    assert.deepEqual(listTestFiles(root), ['tests/a.test.ts', 'tests/b.test.tsx', 'tests/nested/deep/n.test.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runs at most two at once and reports each as it finishes', async () => {
  let active = 0
  let peak = 0
  const done = []
  const run = async file => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    return { code: 0, output: file }
  }
  const results = await runPool(['a', 'b', 'c', 'd', 'e'], run, { onDone: file => done.push(file) })
  assert.equal(peak, 2)
  assert.equal(results.length, 5)
  assert.equal(done.length, 5)
})

test('a child counts as passed only with exit 0 and a whole, matching report with every test passed', () => {
  assert.equal(failureReason('tests/x.test.ts', { code: 0, output: report('tests/x.test.ts', [pass, pass]) }), null)
  assert.equal(failureReason('tests/x.test.ts', { code: 0, output: `noise\r\n${report('tests/x.test.ts', [pass])}` }), null)
})

test('exit 0 with no report, a cut-off report, a failed result, another file, or no results counts as failed; so does exit 1', () => {
  const file = 'tests/x.test.ts'
  const full = report(file, [pass])
  for (const output of ['', 'ok\n', full.slice(0, full.length - 12), report(file, [pass, { ...pass, failure: 'boom' }]), report('tests/y.test.ts', [pass]), report(file, [])]) {
    assert.notEqual(failureReason(file, { code: 0, output }), null, output)
  }
  assert.notEqual(failureReason(file, { code: 1, output: full }), null)
})

test('a report with a malformed result entry counts as failed, wherever the entry is', () => {
  const file = 'tests/x.test.ts'
  for (const results of [[null, { ...pass, failure: 'boom' }], [null], [pass, null], ['text'], [pass, {}]]) {
    assert.notEqual(failureReason(file, { code: 0, output: report(file, results) }), null, JSON.stringify(results))
  }
})

test('a result that names no test counts as failed even with exit 0 and a null failure', () => {
  const file = 'tests/x.test.ts'
  for (const results of [[{ failure: null }], [pass, { failure: null }], [{ title: '', failure: null }], [{ title: 3, failure: null }]]) {
    assert.match(failureReason(file, { code: 0, output: report(file, results) }), /malformed/, JSON.stringify(results))
  }
})

test('the CI step named Pane and hook tests runs the runner script, not claude plugin test .', async () => {
  const lines = (await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')).split(/\r?\n/)
  const start = lines.findIndex(line => /^\s*- name:\s*Pane and hook tests\s*$/.test(line))
  assert.notEqual(start, -1, 'the Pane and hook tests step is missing')
  const indent = lines[start].match(/^\s*/)[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*- /.test(lines[i]) && lines[i].match(/^\s*/)[0].length <= indent) { end = i; break }
  }
  const runs = lines.slice(start + 1, end).map(line => line.match(/^\s*run:\s*(.+?)\s*$/)).filter(Boolean).map(match => match[1])
  assert.deepEqual(runs, ['node scripts/plugin-tests.mjs'])
  assert.ok(!runs.some(run => run.includes('claude plugin test')))
})

test('names with spaces or letters outside ASCII reach the test runner as one argument on both systems', () => {
  for (const name of ['tests/a b.test.ts', 'tests/día.test.ts', 'tests/名前.test.tsx']) {
    const win = runner.childCommand(name, 'claude', 'win32')
    assert.equal(win.shell, true)
    assert.equal(win.command, `claude plugin test --file "${name}" .`)
    assert.deepEqual(runner.childCommand(name, 'claude', 'linux'), { command: 'claude', args: ['plugin', 'test', '--file', name, '.'], shell: false })
  }
})

test('file names a Windows shell would read as syntax never reach a shell and count as failed', async () => {
  for (const name of ['tests/a"b.test.ts', 'tests/a&b.test.ts', 'tests/a;b.test.ts', 'tests/a%PATH%.test.ts', 'tests/a|b.test.ts']) {
    for (const platform of ['win32', 'linux']) {
      const result = await runChild(name, 'claude', platform)
      assert.equal(result.code, 1)
      assert.match(result.output, /refusing test file name/)
      assert.notEqual(failureReason(name, result), null)
    }
  }
})

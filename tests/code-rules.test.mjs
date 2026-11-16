import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAdded, SET_TIMEOUT_FILES } from '../scripts/code-rules.mjs'

const script = fileURLToPath(new URL('../scripts/code-rules.mjs', import.meta.url))
const added = (path, text) => [{ path, line: 7, text }]

test('a new setTimeout in a hooks file outside the allow-list fails with its cause and fix', () => {
  const [failure, ...rest] = checkAdded(added('hooks/new-thing.ts', '  const t = setTimeout(() => done(), 500)'))
  assert.equal(rest.length, 0)
  assert.equal(failure.rule, 'set-timeout-in-hooks')
  assert.match(failure.message, /^hooks\/new-thing\.ts:7: \[set-timeout-in-hooks\] .*SET_TIMEOUT_FILES/)
})

test('setTimeout passes in an allow-listed hooks file, in a comment, in generated bundles and outside hooks', () => {
  assert.ok(SET_TIMEOUT_FILES.includes('hooks/serve.ts'))
  assert.deepEqual(checkAdded(added('hooks/serve.ts', 'setTimeout(stop, 10)')), [])
  assert.deepEqual(checkAdded(added('hooks/new-thing.ts', '  // setTimeout( is not allowed here')), [])
  assert.deepEqual(checkAdded(added('hooks/board-script-3.ts', '"  setTimeout(stop, 10)",')), [])
  assert.deepEqual(checkAdded(added('scripts/new-tool.mjs', 'setTimeout(stop, 10)')), [])
  assert.deepEqual(checkAdded(added('hooks/new-thing.ts', 'const clearTimeout2 = mysetTimeoutValue')), [])
})

test('a committed .only in a test file fails and a normal test passes', () => {
  const [failure] = checkAdded(added('tests/x.test.mjs', "test.only('one', () => {})"))
  assert.equal(failure.rule, 'only-in-tests')
  assert.equal(checkAdded(added('tests/x.test.mjs', "  describe.only('group', () => {})")).length, 1)
  assert.deepEqual(checkAdded(added('tests/x.test.mjs', "test('one', () => {})")), [])
  assert.deepEqual(checkAdded(added('tests/x.test.mjs', "'it.only(\"a title\")', // in a string")), [])
  assert.deepEqual(checkAdded(added('scripts/x.mjs', "test.only('one', () => {})")), [])
})

test('the command exits 1 on a hit and 0 on a clean diff, over base...head only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-rules-'))
  try {
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    mkdirSync(join(dir, 'hooks'))
    writeFileSync(join(dir, 'hooks', 'old.ts'), 'setTimeout(a, 1)\n')
    git('add', 'hooks/old.ts'); git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'clean')
    writeFileSync(join(dir, 'hooks', 'old.ts'), 'setTimeout(a, 1)\nconst b = 2\n')
    git('commit', '-q', '-am', 'clean')
    git('checkout', '-q', '-b', 'dirty', 'main')
    writeFileSync(join(dir, 'hooks', 'fresh.ts'), 'setTimeout(a, 1)\n')
    git('add', 'hooks/fresh.ts'); git('commit', '-q', '-m', 'dirty')
    const run = head => spawnSync(process.execPath, [script, '--repo-dir', dir, '--base', 'main', '--head', head], { encoding: 'utf8' })
    const clean = run('clean')
    assert.equal(clean.status, 0, clean.stderr)
    assert.match(clean.stdout, /PASS/)
    const dirty = run('dirty')
    assert.equal(dirty.status, 1)
    assert.match(dirty.stderr, /FAIL hooks\/fresh\.ts:1: \[set-timeout-in-hooks\]/)
    assert.equal(run('no-such-branch').status, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

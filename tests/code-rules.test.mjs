import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAdded, codeOnly, loadConfig } from '../scripts/code-rules.mjs'

const script = fileURLToPath(new URL('../scripts/code-rules.mjs', import.meta.url))
const root = fileURLToPath(new URL('..', import.meta.url))
const config = loadConfig(root)
const SET_TIMEOUT_FILES = config.setTimeoutFiles
const check = rows => checkAdded(rows, config)
const added = (path, text) => [{ path, line: 7, text }]

test('a new setTimeout in a hooks file outside the allow-list fails with its cause and fix', () => {
  const [failure, ...rest] = check(added('hooks/new-thing.ts', '  const t = setTimeout(() => done(), 500)'))
  assert.equal(rest.length, 0)
  assert.equal(failure.rule, 'set-timeout-in-hooks')
  assert.match(failure.message, /^hooks\/new-thing\.ts:7: \[set-timeout-in-hooks\] .*setTimeoutFiles/)
})

test('setTimeout passes in an allow-listed hooks file, in a comment, in generated bundles and outside hooks', () => {
  assert.ok(SET_TIMEOUT_FILES.includes('hooks/serve.ts'))
  assert.deepEqual(check(added('hooks/serve.ts', 'setTimeout(stop, 10)')), [])
  assert.deepEqual(check(added('hooks/new-thing.ts', '  // setTimeout( is not allowed here')), [])
  assert.deepEqual(check(added('hooks/board-script-3.ts', '"  setTimeout(stop, 10)",')), [])
  assert.deepEqual(check(added('scripts/new-tool.mjs', 'setTimeout(stop, 10)')), [])
  assert.deepEqual(check(added('hooks/new-thing.ts', 'const clearTimeout2 = mysetTimeoutValue')), [])
})

test('a committed .only in a test file fails and a normal test passes', () => {
  const [failure] = check(added('tests/x.test.mjs', "test.only('one', () => {})"))
  assert.equal(failure.rule, 'only-in-tests')
  assert.equal(check(added('tests/x.test.mjs', "  describe.only('group', () => {})")).length, 1)
  assert.deepEqual(check(added('tests/x.test.mjs', "test('one', () => {})")), [])
  assert.deepEqual(check(added('tests/x.test.mjs', "'it.only(\"a title\")', // in a string")), [])
  assert.deepEqual(check(added('scripts/x.mjs', "test.only('one', () => {})")), [])
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

test('a trailing comment or a string holding the call never blocks, and a call after a statement prefix does', () => {
  assert.deepEqual(check(added('hooks/new-thing.ts', 'const a = 1 // then setTimeout( later')), [])
  assert.deepEqual(check(added('hooks/new-thing.ts', 'const a = 1 /* setTimeout( */ + 2')), [])
  assert.deepEqual(check(added('hooks/new-thing.ts', "const text = 'setTimeout('")), [])
  assert.equal(check(added('hooks/new-thing.ts', 'if (ok) setTimeout(go, 5) // later')).length, 1)
  assert.deepEqual(check(added('tests/x.test.mjs', "test('x', () => {}) // it.only( was here")), [])
  assert.equal(codeOnly('a("it.only(") // x'), 'a("") ')
})

test('it.only after a statement prefix fails, and this test file, which writes the call only inside strings, passes', () => {
  assert.equal(check(added('tests/x.test.mjs', 'if (enabled) it.only("one", () => {})')).length, 1)
  assert.equal(check(added('tests/x.test.mjs', 'for (const x of y) { test.only("one", () => {}) }')).length, 1)
  assert.equal(check(added('tests/x.test.mjs', 'ok && describe.only("group", () => {})')).length, 1)
  const own = readFileSync(new URL('./code-rules.test.mjs', import.meta.url), 'utf8').split(/\r?\n/)
  assert.deepEqual(check(own.map((text, i) => ({ path: 'tests/code-rules.test.mjs', line: i + 1, text }))), [])
})

test('the list is data read from the pull request checkout: its own entry passes, a moved file needs its new path, bad data fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-rules-list-'))
  try {
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })
    const run = head => spawnSync(process.execPath, [script, '--repo-dir', dir, '--base', 'main', '--head', head], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    mkdirSync(join(dir, 'hooks')); mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'hooks', 'old.ts'), 'setTimeout(a, 1)\n')
    writeFileSync(join(dir, 'scripts', 'code-rules.json'), JSON.stringify({ setTimeoutFiles: ['hooks/old.ts'] }))
    git('add', '.'); git('commit', '-q', '-m', 'base')
    // The same pull request adds a file with a timer and lists it: passes.
    git('checkout', '-q', '-b', 'listed', 'main')
    writeFileSync(join(dir, 'hooks', 'fresh.ts'), 'setTimeout(a, 1)\n')
    writeFileSync(join(dir, 'scripts', 'code-rules.json'), JSON.stringify({ setTimeoutFiles: ['hooks/old.ts', 'hooks/fresh.ts'] }))
    git('add', '.'); git('commit', '-q', '-m', 'listed')
    const listed = run('listed')
    assert.equal(listed.status, 0, listed.stderr)
    // The same file without the entry fails and says where to add it.
    git('checkout', '-q', '-b', 'unlisted', 'main')
    writeFileSync(join(dir, 'hooks', 'fresh.ts'), 'setTimeout(a, 1)\n')
    git('add', '.'); git('commit', '-q', '-m', 'unlisted')
    const unlisted = run('unlisted')
    assert.equal(unlisted.status, 1)
    assert.match(unlisted.stderr, /scripts\/code-rules\.json in the same pull request/)
    // A rename reads as an added file at the new path: it fails until the list moves with it, then passes.
    git('checkout', '-q', '-b', 'moved', 'main')
    git('mv', 'hooks/old.ts', 'hooks/new.ts'); git('commit', '-q', '-m', 'moved')
    assert.equal(run('moved').status, 1)
    writeFileSync(join(dir, 'scripts', 'code-rules.json'), JSON.stringify({ setTimeoutFiles: ['hooks/new.ts'] }))
    git('add', '.'); git('commit', '-q', '-m', 'list moved')
    assert.equal(run('moved').status, 0)
    // A list that is not the expected data stops the check instead of passing it.
    git('checkout', '-q', '-b', 'broken', 'main')
    writeFileSync(join(dir, 'scripts', 'code-rules.json'), '{ not json')
    git('add', '.'); git('commit', '-q', '-m', 'broken')
    const broken = run('broken')
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /not readable JSON/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the pr-check workflow runs the base checker on the pull request checkout with the base and head shas', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pr-check.yml', import.meta.url), 'utf8')
  const step = workflow.slice(workflow.indexOf('- name: Code rules'))
  assert.match(step, /run: node checker\/scripts\/code-rules\.mjs --repo-dir pr --base \$\{\{ github\.event\.pull_request\.base\.sha \}\} --head \$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
  assert.match(step, /hashFiles\('checker\/scripts\/code-rules\.mjs'\)/)
  assert.doesNotMatch(step, /pr\/scripts\//)
  assert.match(workflow, /scripts\/code-rules\.json/)
})

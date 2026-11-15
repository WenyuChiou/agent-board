import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { failFirstLine, namePattern, outcomeOf, runFailFirst, testBlocks, titlesOf } from '../scripts/fail-first.mjs'

test('fail-first reads test titles and top-level test blocks, and leaves template titles out of the blocks (#1520)', () => {
  const text = [
    "import test from 'node:test'",
    "test('the value is two', () => {",
    '  assert.equal(value, 2)',
    '})',
    '',
    "test.skip('a page\\'s link stays', async () => {})",
    'test(`a ${name} receiver`, () => {})',
    "  test('a nested one', () => {})",
  ].join('\n')
  assert.deepEqual(titlesOf(text), [
    { title: 'the value is two', isTemplate: false },
    { title: "a page's link stays", isTemplate: false },
    { title: 'a ${name} receiver', isTemplate: true },
    { title: 'a nested one', isTemplate: false },
  ])
  const blocks = testBlocks(text)
  assert.deepEqual([...blocks.keys()], ['the value is two', "a page's link stays"])
  assert.match(blocks.get('the value is two'), /assert\.equal\(value, 2\)/)
  assert.doesNotMatch(blocks.get('the value is two'), /link stays/)
})

test('fail-first reads no test from a string, a comment or a regular expression (#1520)', () => {
  const text = [
    "import test from 'node:test'",
    "const sample = \"test('a title in a string', () => {})\"",
    "// test('a title in a comment', () => {})",
    "/* test('a title in a block comment', () => {}) */",
    "const pattern = /test\\('a title in a pattern'/",
    "const quote = /'/",
    "test('after a quote in a pattern', () => {",
    "  const fixture = `test('a title in a template', () => {})\\n${[1, 2].map(n => `${n}`).join('')}`",
    '  assert.equal(10 / 2 / 5, 1)',
    '})',
    // A counter divided is a division, not a pattern that runs into the next line.
    'let n = 4',
    'n++ / 2',
    "test('after a division by a counter', () => {})",
    'n-- / 2',
    "test('after a division by a falling counter', () => {})",
    // A method call stays one across spaces and comments; a dot inside a string is not a call.
    "pattern . test('a title after a spaced dot')",
    "pattern./* a note */test('a title after a commented dot')",
    "const said = 'a sentence that ends with a dot.'",
    "test('after a string that ends with a dot', () => {})",
    "test('the last one', () => {})",
  ].join('\n')
  const expected = ['after a quote in a pattern', 'after a division by a counter', 'after a division by a falling counter', 'after a string that ends with a dot', 'the last one']
  assert.deepEqual(titlesOf(text).map(item => item.title), expected)
  assert.deepEqual([...testBlocks(text).keys()], expected)
})

test('fail-first reads a run as pass, fail, skipped or missing from its TAP counts and exit (#1520)', () => {
  const tap = (tests, pass, fail, skipped) => `# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# skipped ${skipped}\n`
  assert.equal(outcomeOf({ status: 0, stdout: tap(1, 1, 0, 0) }), 'pass')
  assert.equal(outcomeOf({ status: 1, stdout: tap(1, 0, 1, 0) }), 'fail')
  // A file that cannot load fails as a whole.
  assert.equal(outcomeOf({ status: 1, stdout: tap(1, 0, 1, 0), stderr: 'Cannot find module' }), 'fail')
  assert.equal(outcomeOf({ status: 1, stdout: '', stderr: 'SyntaxError' }), 'fail')
  assert.equal(outcomeOf({ status: 0, stdout: tap(1, 0, 0, 1) }), 'skipped')
  assert.equal(outcomeOf({ status: 0, stdout: tap(0, 0, 0, 0) }), 'missing')
  // A run its time limit stopped is not a failure of the test: it is unknown.
  assert.equal(outcomeOf({ status: null, signal: 'SIGTERM', stdout: '' }), 'stopped')
  assert.equal(outcomeOf({ error: new Error('spawn ENOENT'), stdout: '' }), 'stopped')
  assert.equal(namePattern('a (b) c.d? $1'), '^a \\(b\\) c\\.d\\? \\$1$')
  assert.equal(failFirstLine({ counted: 2, total: 3, base: '1111111122222222', head: 'abcdef1234567890' }), 'Fail-first: 2 of 3 new or changed tests fail on 11111111 and pass on abcdef12.')
})

const repository = t => {
  const root = mkdtempSync(join(tmpdir(), 'fail-first-repo-'))
  const cwd = join(root, 'repo')
  mkdirSync(cwd)
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig') }
  for (const key of Object.keys(env)) if (/^GIT_(?!CONFIG_)/i.test(key)) delete env[key]
  delete env.NODE_TEST_CONTEXT
  const git = (...args) => {
    const ran = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 20000 })
    assert.equal(ran.status, 0, ran.stderr)
    return ran.stdout.trim()
  }
  const write = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), text)
  }
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'Synthetic fixture') }
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'core.autocrlf', 'false')
  return { root, cwd, env, git, write, commit }
}
const header = "import test from 'node:test'\nimport assert from 'node:assert/strict'\n"

test('fail-first runs each named new or changed test on the merge base with the branch\'s tests and on the branch (#1520)', { timeout: 120_000 }, async t => {
  const r = repository(t)
  r.write('scripts/value.mjs', 'export const value = 1\n')
  r.write('tests/old.test.mjs', `${header}test('an old test passes', () => assert.ok(true))\ntest('an old test changes', () => assert.ok(true))\n`)
  r.write('tests/old-helper.mjs', 'export const old = true\n')
  r.write('tests/renamed-from.mjs', 'export const helperBeforeItsRename = { name: "synthetic", count: 3 }\n')
  r.commit()
  const base = r.git('rev-parse', 'HEAD')
  rmSync(join(r.cwd, 'tests/old-helper.mjs'))
  rmSync(join(r.cwd, 'tests/renamed-from.mjs'))
  r.write('tests/renamed-to.mjs', 'export const helperBeforeItsRename = { name: "synthetic", count: 3 }\n')
  r.write('tests/gone.test.mjs', `${header}import { existsSync } from 'node:fs'\ntest('the old helper is gone', () => assert.equal(existsSync(new URL('./old-helper.mjs', import.meta.url)), false))\ntest('the renamed helper is gone from its old name', () => assert.equal(existsSync(new URL('./renamed-from.mjs', import.meta.url)), false))\n`)
  r.write('scripts/value.mjs', 'export const value = 2\n')
  r.write('scripts/added.mjs', 'export const added = true\n')
  r.write('tests/value.test.mjs', `${header}import { value } from '../scripts/value.mjs'\ntest('the value is two', () => assert.equal(value, 2))\ntest('the value is a number', () => assert.equal(typeof value, 'number'))\ntest('the value is three', () => assert.equal(value, 3))\ntest('a test skipped everywhere', { skip: 'synthetic' }, () => {})\n`)
  r.write('tests/added.test.mjs', `${header}import { added } from '../scripts/added.mjs'\ntest('the added module is there', () => assert.equal(added, true))\n`)
  r.write('tests/old.test.mjs', `${header}import { value } from '../scripts/value.mjs'\ntest('an old test passes', () => assert.ok(true))\ntest('an old test changes', () => assert.equal(value, 2))\n`)
  r.write('tests/pane.test.tsx', "test('a plugin test', () => {})\n")
  r.commit()
  const head = r.git('rev-parse', 'HEAD')
  const command = (program, args, options = {}) => spawnSync(program, args, { cwd: r.cwd, env: r.env, encoding: 'utf8', timeout: 60000, ...options })
  const names = ['the value is two', 'the value is a number', 'the value is three', 'a test skipped everywhere', 'the added module is there', 'an old test passes', 'an old test changes', 'a plugin test', 'a test nobody wrote', 'the old helper is gone', 'the renamed helper is gone from its old name']
  const checkouts = []
  const runs = []
  const result = await runFailFirst({ cwd: r.cwd, base, names, command, env: r.env, onCheckout: path => checkouts.push(path), onRun: run => runs.push(run) })
  const stateOf = Object.fromEntries(result.results.map(item => [item.title, item.state]))
  assert.deepEqual(stateOf, {
    'the value is two': 'counted',
    // It passes on the base too, so it does not check the change.
    'the value is a number': 'passes-on-base',
    'the value is three': 'fails-on-head',
    'a test skipped everywhere': 'skipped',
    // The file cannot load on the base, where scripts/added.mjs is missing: it fails there.
    'the added module is there': 'counted',
    'an old test passes': 'unchanged',
    'an old test changes': 'counted',
    'a plugin test': 'not-node',
    'a test nobody wrote': 'unknown',
    // The branch deleted tests/old-helper.mjs, so the base checkout lacks it too, and the test passes there.
    'the old helper is gone': 'passes-on-base',
    // A renamed helper is gone from its old path on the base checkout too.
    'the renamed helper is gone from its old name': 'passes-on-base',
  })
  assert.match(r.git('diff', '--name-status', base, head, '--', 'tests/renamed-from.mjs', 'tests/renamed-to.mjs'), /^R/)
  assert.equal(result.counted, 3)
  assert.equal(result.total, 7)
  assert.equal(result.line, `Fail-first: 3 of 7 new or changed tests fail on ${base.slice(0, 8)} and pass on ${head.slice(0, 8)}.`)
  // Each test runs here first; only those that pass here run on the base, after every run here.
  const firstBase = runs.findIndex(run => run.where !== r.cwd)
  assert.ok(firstBase > 0)
  assert.ok(runs.slice(firstBase).every(run => run.where === checkouts[0]))
  assert.deepEqual(runs.slice(firstBase).map(run => run.title).sort(), ['an old test changes', 'the added module is there', 'the old helper is gone', 'the renamed helper is gone from its old name', 'the value is a number', 'the value is two'])
  // The base checkout was a separate folder, and it is gone with its worktree record.
  assert.equal(checkouts.length, 1)
  assert.notEqual(checkouts[0], r.cwd)
  assert.equal(existsSync(checkouts[0]), false)
  assert.doesNotMatch(r.git('worktree', 'list'), /fail-first-base/)
})

test('fail-first counts a working-tree change and says so, and reports no tests to run as a total of zero (#1520)', { timeout: 120_000 }, async t => {
  const r = repository(t)
  r.write('scripts/value.mjs', 'export const value = 1\n')
  r.commit()
  const base = r.git('rev-parse', 'HEAD')
  r.write('scripts/value.mjs', 'export const value = 2\n')
  r.write('tests/value.test.mjs', `${header}import { value } from '../scripts/value.mjs'\ntest('the value is two', () => assert.equal(value, 2))\n`)
  const command = (program, args, options = {}) => spawnSync(program, args, { cwd: r.cwd, env: r.env, encoding: 'utf8', timeout: 60000, ...options })
  const dirty = await runFailFirst({ cwd: r.cwd, base, names: ['the value is two'], command, env: r.env })
  assert.equal(dirty.counted, 1)
  assert.equal(dirty.total, 1)
  assert.equal(dirty.isDirty, true)
  const none = await runFailFirst({ cwd: r.cwd, base, names: [], command, env: r.env })
  assert.equal(none.total, 0)
  assert.equal(none.line, null)
})

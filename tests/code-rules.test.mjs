import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAdded, codeLinesOf, headReader, loadConfig } from '../scripts/code-rules.mjs'

const script = fileURLToPath(new URL('../scripts/code-rules.mjs', import.meta.url))
const root = fileURLToPath(new URL('..', import.meta.url))
const config = loadConfig(root)
const SET_TIMEOUT_FILES = config.setTimeoutFiles
const check = rows => checkAdded(rows, config)
const added = (path, text) => [{ path, line: 7, text }]
// Lines are read whole, so this file builds the word from parts and passes its own rule.
const ONLY = '.only'

test('a new setTimeout in a hooks file outside the allow-list fails with its cause and fix', () => {
  const [failure, ...rest] = check(added('hooks/new-thing.ts', '  const t = setTimeout(() => done(), 500)'))
  assert.equal(rest.length, 0)
  assert.equal(failure.rule, 'set-timeout-in-hooks')
  assert.match(failure.message, /^hooks\/new-thing\.ts:7: \[set-timeout-in-hooks\] .*setTimeoutFiles/)
})

test('setTimeout passes in an allow-listed hooks file, in generated bundles and outside hooks', () => {
  assert.ok(SET_TIMEOUT_FILES.includes('hooks/serve.ts'))
  assert.deepEqual(check(added('hooks/serve.ts', 'setTimeout(stop, 10)')), [])
  assert.deepEqual(check(added('hooks/board-script-3.ts', '"  setTimeout(stop, 10)",')), [])
  assert.deepEqual(check(added('scripts/new-tool.mjs', 'setTimeout(stop, 10)')), [])
  assert.deepEqual(check(added('hooks/new-thing.ts', 'const clearTimeout2 = mysetTimeoutValue')), [])
})

test('a committed .only in a test file fails and a normal test passes', () => {
  const [failure] = check(added('tests/x.test.mjs', `test${ONLY}('one', () => {})`))
  assert.equal(failure.rule, 'only-in-tests')
  assert.equal(check(added('tests/x.test.mjs', `  describe${ONLY}('group', () => {})`)).length, 1)
  assert.deepEqual(check(added('tests/x.test.mjs', "test('one', () => {})")), [])
  assert.deepEqual(check(added('scripts/x.mjs', `test${ONLY}('one', () => {})`)), [])
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

test('comments, strings and regexes pass when they only name the word, while code in file context and template interpolations fails (#1561)', () => {
  const safeFile = [
    '// a setTimeout here',
    'const a = 1 // then setTimeout( later',
    'const b = 1 /* setTimeout( */ + 2',
    '/*',
    ' * setTimeout(done, 1) on a doc comment line',
    ' */',
    "const c = 'setTimeout('",
    'const d = `setTimeout( is only words here`',
    'const e = `line one',
    "  can't // setTimeout(done, 1) inside template text",
    '`;',
    "const f = 'continued string \\",
    "  setTimeout(done, 1) still inside string';",
    'const re = /setTimeout/',
  ].join('\n')
  const safeRows = safeFile.split('\n').map((text, i) => ({ path: 'hooks/new-thing.ts', line: i + 1, text }))
  assert.deepEqual(checkAdded(safeRows, config, undefined, { files: { 'hooks/new-thing.ts': safeFile } }), [])

  assert.deepEqual(check(added('tests/x.test.mjs', `// it${ONLY}('skipped')`)), [])
  assert.deepEqual(check(added('tests/x.test.mjs', `'it${ONLY}("a title")', // in a string`)), [])
  assert.deepEqual(check(added('tests/x.test.mjs', `const pat = /it\\${ONLY}/`)), [])

  const singleLineFail = [
    'if (ok) setTimeout(go, 5) // later',
    'log(`wait ${ok ? setTimeout(go, 1) : 0} then`)',
    "const text = `${'}' + setTimeout(done, 10)}`",
    "const later = s.replace(/'/g, '') && setTimeout(done, 1)",
    'const wait = setTimeout',
  ]
  for (const text of singleLineFail) assert.equal(check(added('hooks/new-thing.ts', text)).length, 1, text)

  // Context-dependent added lines read from line 1 of the head file (#1561):
  const contextCases = [
    ['template close then call', 'const s = `open\n`; setTimeout(done, 1)\n', 2],
    ['block comment close then call', '/* open\n*/ setTimeout(done, 1)\n', 2],
    ['multi-line template text with quote and // before interpolation', "const s = `top\nit's // text ${setTimeout(done, 1)}\n`\n", 2],
    ['backslash-continued string then close and call', "const s = 'hello \\\n'; setTimeout(done, 1)\n", 2],
    ['backslash-continued CRLF string then close and call', "const s = 'hello \\\r\n'; setTimeout(done, 1)\r\n", 2],
  ]
  for (const [label, source, line] of contextCases) {
    const text = source.split(/\r?\n/)[line - 1]
    const hits = checkAdded([{ path: 'hooks/new-thing.ts', line, text }], config, undefined, { files: { 'hooks/new-thing.ts': source } })
    assert.equal(hits.length, 1, label)
    assert.equal(hits[0].rule, 'set-timeout-in-hooks', label)
  }

  // Condition regex (`if (...)` and `for await (...)`) still permits later code on following lines.
  const condRegex = "if (enabled) /`/.test(text); setTimeout(done, 1)\n"
  assert.equal(codeLinesOf(condRegex)[0].includes('setTimeout'), true)
  const forAwaitSource = 'for await (const item of items) /`/.test(item)\nsetTimeout(done, 1)\n'
  const forAwaitHits = checkAdded(
    [{ path: 'hooks/new-thing.ts', line: 2, text: 'setTimeout(done, 1)' }],
    config,
    undefined,
    { files: { 'hooks/new-thing.ts': forAwaitSource } },
  )
  assert.equal(forAwaitHits.length, 1)

  // JSX text apostrophes inside .tsx and .jsx files do not hide executable `{...}` expressions (#1561 review).
  const tsxHook = "const view = <Text>Don't {setTimeout(done, 1)}</Text>\n"
  assert.equal(checkAdded([{ path: 'hooks/view.tsx', line: 1, text: tsxHook }], config, undefined, { files: { 'hooks/view.tsx': tsxHook } }).length, 1)
  const jsxTest = `const view = <>Don't {test${ONLY}('a', () => {})}</>\n`
  assert.equal(checkAdded([{ path: 'tests/view.test.jsx', line: 1, text: jsxTest }], config, undefined, { files: { 'tests/view.test.jsx': jsxTest } }).length, 1)
  const tsxGeneric = 'const fn = <T extends Foo>(x: T) => setTimeout(done, 1)\n'
  assert.equal(checkAdded([{ path: 'hooks/view.tsx', line: 1, text: tsxGeneric }], config, undefined, { files: { 'hooks/view.tsx': tsxGeneric } }).length, 1)

  // A failed git show read for a changed file stops the CLI reader instead of silently falling back (#1561 review).
  const badRead = headReader({
    cwd: root,
    head: 'HEAD',
    requiredPaths: new Set(['hooks/new-thing.ts']),
    run: () => ({ status: 128, stdout: '', stderr: 'fatal: read failure' }),
  })
  assert.throws(() => badRead('hooks/new-thing.ts'), /could not read hooks\/new-thing\.ts/)
})

test('test extensions (.js, .cjs, .jsx), aliases before .only, and hand-written board-script files fail (#1563)', () => {
  for (const path of ['tests/example.test.js', 'tests/example.test.cjs', 'tests/example.test.jsx']) {
    const [hit] = check(added(path, `test${ONLY}('one', () => {})`))
    assert.equal(hit?.rule, 'only-in-tests', path)
  }
  const [aliasHit] = check(added('tests/example.test.mjs', `const mytest = test; mytest${ONLY}('one', () => {})`))
  assert.equal(aliasHit?.rule, 'only-in-tests')
  assert.deepEqual(check(added('tests/example.test.mjs', "const item = { name: 'only' }")), [])

  // Hand-written file named like a bundle fails even with a synthetic part header if board-script.ts does not import it.
  const fakePart = '// Generated by scripts/build-board.ts: part 987 of the board bundle; do not edit by hand.\nexport const LINES = [\nsetTimeout(stop, 10)\n]\n'
  const [bundleHit] = checkAdded(
    [{ path: 'hooks/board-script-987.ts', line: 3, text: 'setTimeout(stop, 10)' }],
    config,
    undefined,
    { files: { 'hooks/board-script.ts': readFileSync(join(root, 'hooks/board-script.ts'), 'utf8'), 'hooks/board-script-987.ts': fakePart } },
  )
  assert.equal(bundleHit?.rule, 'set-timeout-in-hooks')
  assert.equal(check(added('hooks/board-script-987.ts', 'setTimeout(stop, 10)')).length, 1)
})

test('CLI execution reads full files from --head even when another branch is checked out (#1561, #1563)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-rules-context-'))
  try {
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })
    const run = head => spawnSync(process.execPath, [script, '--repo-dir', dir, '--base', 'main', '--head', head], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    mkdirSync(join(dir, 'hooks')); mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'tests'))
    writeFileSync(join(dir, 'scripts', 'code-rules.json'), JSON.stringify({ setTimeoutFiles: [] }))
    writeFileSync(join(dir, 'hooks', 'ctx.ts'), 'const s = `open\n`\n/* block\n*/\nconst q = "a \\\n"\n')
    git('add', '.'); git('commit', '-q', '-m', 'base')

    // Branch that safely adds comment/string/template mentions passes.
    git('checkout', '-q', '-b', 'safe', 'main')
    writeFileSync(join(dir, 'hooks', 'ctx.ts'), 'const s = `open\n  // setTimeout(done, 1)\n`\n/* block\n * setTimeout(done, 1)\n*/\nconst q = "a \\\n  setTimeout(done, 1)"\n')
    writeFileSync(join(dir, 'tests', 'example.test.js'), `// it${ONLY}("note")\n`)
    git('add', '.'); git('commit', '-q', '-m', 'safe')

    // Another branch checked out at HEAD while we still test `safe`, plus a failing branch `unsafe`.
    git('checkout', '-q', '-b', 'unsafe', 'main')
    mkdirSync(join(dir, 'tests'), { recursive: true })
    writeFileSync(join(dir, 'hooks', 'ctx.ts'), 'const s = `open\n`; setTimeout(done, 1)\n/* block\n*/ setTimeout(done, 1)\nconst q = "a \\\n"; setTimeout(done, 1)\n')
    writeFileSync(join(dir, 'hooks', 'board-script-987.ts'), 'setTimeout(done, 1)\n')
    writeFileSync(join(dir, 'tests', 'example.test.jsx'), `const mytest = test; mytest${ONLY}("x", () => {})\n`)
    git('add', '.'); git('commit', '-q', '-m', 'unsafe')

    // An authentic generated entry + part passes even when checked via CLI.
    git('checkout', '-q', '-b', 'bundle', 'main')
    writeFileSync(join(dir, 'hooks', 'board-script.ts'), [
      '// Generated by scripts/build-board.ts from scripts/board-cli.ts; do not edit by hand.',
      "import { LINES as PART_1 } from './board-script-1.ts'",
      "export const BOARD_SCRIPT = [...PART_1].join('\\n')",
    ].join('\n') + '\n')
    writeFileSync(join(dir, 'hooks', 'board-script-1.ts'), [
      '// Generated by scripts/build-board.ts: part 1 of the board bundle; do not edit by hand.',
      'export const LINES = [',
      '"setTimeout(done, 1)"',
      ']',
    ].join('\n') + '\n')
    git('add', '.'); git('commit', '-q', '-m', 'bundle')

    assert.equal(run('safe').status, 0, run('safe').stderr)
    assert.equal(run('bundle').status, 0, run('bundle').stderr)
    const bad = run('unsafe')
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /hooks\/ctx\.ts:2: \[set-timeout-in-hooks\]/)
    assert.match(bad.stderr, /hooks\/ctx\.ts:4: \[set-timeout-in-hooks\]/)
    assert.match(bad.stderr, /hooks\/ctx\.ts:6: \[set-timeout-in-hooks\]/)
    assert.match(bad.stderr, /hooks\/board-script-987\.ts:1: \[set-timeout-in-hooks\]/)
    assert.match(bad.stderr, /tests\/example\.test\.jsx:1: \[only-in-tests\]/)
    assert.match(bad.stderr, /code-rules: 5 FAIL/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a .only after a statement prefix fails, and this test file, which builds the word from parts, passes', () => {
  assert.equal(check(added('tests/x.test.mjs', `if (enabled) it${ONLY}("one", () => {})`)).length, 1)
  assert.equal(check(added('tests/x.test.mjs', `for (const x of y) { test${ONLY}("one", () => {}) }`)).length, 1)
  assert.equal(check(added('tests/x.test.mjs', `ok && describe${ONLY}("group", () => {})`)).length, 1)
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

test('a pull request that deletes the list fails closed, and a branch cut before the list existed uses the checker list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-rules-gone-'))
  try {
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })
    const run = head => spawnSync(process.execPath, [script, '--repo-dir', dir, '--base', 'main', '--head', head], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    mkdirSync(join(dir, 'hooks')); mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'hooks', 'plain.ts'), 'export const a = 1\n')
    git('add', '.'); git('commit', '-q', '-m', 'before the list')
    git('branch', 'early')
    writeFileSync(join(dir, 'scripts', 'code-rules.json'), JSON.stringify({ setTimeoutFiles: [] }))
    git('add', '.'); git('commit', '-q', '-m', 'the list')
    // Removing the list, with nothing else changed, stops the check instead of falling back to the checker's list.
    git('checkout', '-q', '-b', 'deleted', 'main')
    git('rm', '-q', 'scripts/code-rules.json'); git('commit', '-q', '-m', 'deleted')
    const deleted = run('deleted')
    assert.equal(deleted.status, 1, deleted.stdout)
    assert.match(deleted.stderr, /removes scripts\/code-rules\.json/)
    // A branch cut before the list existed is judged by the checker's own list: a clean change passes, a new timer fails.
    git('checkout', '-q', 'early')
    writeFileSync(join(dir, 'hooks', 'plain.ts'), 'export const a = 2\n')
    git('add', '.'); git('commit', '-q', '-m', 'early change')
    const early = run('early')
    assert.equal(early.status, 0, early.stderr)
    writeFileSync(join(dir, 'hooks', 'fresh.ts'), 'setTimeout(a, 1)\n')
    git('add', '.'); git('commit', '-q', '-m', 'early timer')
    assert.equal(run('early').status, 1)
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

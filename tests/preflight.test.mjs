import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleSources, engineProblems, objectKeys, runPreflight, safeLine } from '../scripts/preflight.mjs'

const script = fileURLToPath(new URL('../scripts/preflight.mjs', import.meta.url))
const currentRegister = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const tableFiles = [['hooks/i18n.ts', 'ZH_TW'], ['hooks/strings-en.ts', 'EN'], ['hooks/strings-zh-cn.ts', 'ZH_CN']]
const homeNames = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROGRESS_FILE']
const realTables = tableFiles.map(([path, name]) => ({ path, name, text: readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') }))
const templateRoot = mkdtempSync(join(tmpdir(), 'preflight-template-'))
const templateRepo = join(templateRoot, 'repo')
after(() => rmSync(templateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'preflight-fixture-'))
  const cwd = join(root, 'repo')
  const home = join(root, 'home')
  mkdirSync(cwd)
  mkdirSync(home)
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key]
  delete env.NODE_TEST_CONTEXT
  for (const name of homeNames) env[name] = name === 'CLAUDE_PROGRESS_FILE' ? join(home, 'progress.md') : home
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), NoDefaultCurrentDirectoryInExePath: '1' })
  const run = (program, args, options) => spawnSync(program, args, { ...options, env: args.includes('--test') ? options.env : { ...options.env, ...env } })
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const write = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), text)
  }
  const commit = () => { git('add', '.'); git('commit', '-qm', 'Synthetic fixture') }
  if (existsSync(templateRepo)) cpSync(templateRepo, cwd, { recursive: true })
  else {
    git('init', '-q', '-b', 'chore/preflight')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'core.autocrlf', 'false')
    write('CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n## 1.0.0\n')
    write('scripts/board-cli.ts', "import { value } from '../hooks/source.ts'\nconsole.log(value)\n")
    write('hooks/source.ts', "import { BOARD_SCRIPT } from './board-script'\nexport const value = 1\n")
    write('hooks/board-script.ts', 'export const BOARD_SCRIPT = `original`\n')
    for (const [path, name] of tableFiles) write(path, `export const ${name} = { first: 'one', last: 'two' }\n`)
    for (const path of ['README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'docs/GUIDE.md', 'docs/GUIDE.zh-TW.md', 'docs/GUIDE.zh-CN.md']) write(path, 'Original\n')
    write('hooks/register.tsx', 'const helper = ($) => $.clock.now()\nhelper($)\n')
    commit()
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    cpSync(cwd, templateRepo, { recursive: true })
  }
  const lockPath = join(root, 'preflight.lock')
  const check = options => runPreflight({ cwd, isNoFetch: true, run, lockPath, ...options })
  return { root, cwd, home, env, lockPath, write, git, commit, check, run }
}

const has = (checks, state, text) => checks.some(item => item.state === state && item.message.includes(text))

test('preflight passes when the branch contains the base and no files changed', async t => {
  const f = fixture(t)
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'contains the base'))
  assert.equal(checks.filter(item => item.state !== 'PASS').length, 0)
})

test('preflight only warns when the branch is behind main, since a branch behind main can merge as it is', async t => {
  const f = fixture(t)
  const tree = f.git('rev-parse', 'HEAD^{tree}')
  const newer = f.git('commit-tree', tree, '-p', 'HEAD', '-m', 'New main')
  f.git('update-ref', 'refs/remotes/origin/main', newer)
  const checks = await f.check()
  assert.ok(has(checks, 'WARN', 'does not contain the latest main'))
  assert.ok(!checks.some(item => item.state === 'FAIL' && /origin\/main/.test(item.message)))
})

test('preflight fetches main by default and fails closed when fetch fails', async t => {
  const f = fixture(t)
  const calls = []
  const run = (program, args, options) => {
    if (program === 'git' && args[0] === 'fetch') {
      calls.push(args)
      return { status: 1, stdout: '', stderr: 'private remote details' }
    }
    return f.run(program, args, options)
  }
  const checks = await f.check({ isNoFetch: false, run })
  assert.ok(has(checks, 'FAIL', 'git fetch origin main failed'))
  assert.equal(has(checks, 'PASS', 'contains the base'), false)
  assert.ok(has(checks, 'WARN', 'ancestry check used the local ref'))
  assert.deepEqual(calls, [['fetch', 'origin', 'main']])
  calls.length = 0
  await f.check({ run })
  assert.equal(calls.length, 0)
})

test('preflight fails cleanly when the base is missing and accepts a custom base', async t => {
  const f = fixture(t)
  assert.ok(has(await f.check({ base: 'missing-base' }), 'FAIL', 'could not read the base'))
  assert.ok(has(await f.check({ base: 'HEAD' }), 'PASS', 'contains the base'))
})

test('preflight runs touched Node tests with an isolated home and removes it afterward', async t => {
  const f = fixture(t)
  f.write('tests/isolation.test.mjs', `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { writeFileSync } from 'node:fs'\nimport { join, dirname } from 'node:path'\ntest('the fixture has a disposable home', () => {\n  const home = process.env.HOME\n  for (const key of ${JSON.stringify(homeNames.slice(0, -1))}) assert.equal(process.env[key], home)\n  assert.equal(dirname(process.env.CLAUDE_PROGRESS_FILE), home)\n  writeFileSync(join(home, 'marker'), 'isolated')\n})\n`)
  const homes = []
  const run = (program, args, options) => {
    if (args.includes('--test')) {
      homes.push(options.env.HOME)
      assert.equal(options.timeout, 600000)
      for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'ANTHROPIC_API_KEY']) assert.equal(options.env[key], undefined)
      return spawnSync(program, args, { ...options, env: options.env })
    }
    assert.equal(options.timeout, 120000)
    return f.run(program, args, options)
  }
  const checks = await f.check({ run })
  assert.ok(has(checks, 'PASS', 'tests/isolation.test.mjs: 1 tests, 0 failed'))
  assert.equal(homes.length, 1)
  assert.notEqual(homes[0], f.home)
  assert.equal(existsSync(homes[0]), false)
  assert.equal(existsSync(join(f.home, 'marker')), false)
})

test('preflight streams each completed check and names a touched Node file before running it', async t => {
  const f = fixture(t)
  f.write('tests/stream.test.mjs', '')
  const events = []
  const run = (program, args, options) => {
    if (args.includes('--test')) {
      events.push(`INVOKE ${args.at(-1)}`)
      return { status: 0, stdout: '# tests 0\n# fail 0\n', stderr: '' }
    }
    return f.run(program, args, options)
  }
  const checks = await f.check({
    run,
    onCheck: item => events.push(`${item.state} ${item.message}`),
    onProgress: line => events.push(line),
  })
  assert.ok(events.indexOf('PASS the branch contains the base.') < events.indexOf('RUN tests/stream.test.mjs'))
  assert.ok(events.indexOf('RUN tests/stream.test.mjs') < events.indexOf('INVOKE tests/stream.test.mjs'))
  assert.ok(has(checks, 'PASS', 'tests/stream.test.mjs: 0 tests, 0 failed'))
  const childEnv = { ...f.env, TEMP: f.home, TMP: f.home, TMPDIR: f.home }
  const result = spawnSync(process.execPath, [script, '--no-fetch'], { cwd: f.cwd, env: childEnv, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const lines = result.stdout.trim().split(/\r?\n/)
  const runAt = lines.indexOf('RUN tests/stream.test.mjs')
  const resultAt = lines.findIndex(line => /^PASS tests\/stream\.test\.mjs:/.test(line))
  assert.ok(runAt > 0)
  assert.ok(resultAt > runAt)
  assert.equal(lines.filter(line => /^PASS the branch contains the base\.$/.test(line)).length, 1)
})

test('preflight refuses a second live local test run without starting another test file', async t => {
  const f = fixture(t)
  f.write('tests/live.test.mjs', '')
  mkdirSync(f.lockPath)
  writeFileSync(join(f.lockPath, `${process.pid}-live-owner.lock`), '')
  let hasStarted = false
  const run = (program, args, options) => {
    if (args.includes('--test')) hasStarted = true
    return f.run(program, args, options)
  }
  const checks = await f.check({ run })
  assert.ok(has(checks, 'FAIL', 'another preflight test run is already active'))
  assert.equal(hasStarted, false)
})

test('preflight recovers a stale test lock and releases its own lock after a failed run', async t => {
  const f = fixture(t)
  f.write('tests/stale.test.mjs', '')
  mkdirSync(f.lockPath)
  writeFileSync(join(f.lockPath, '2147483647-stale-owner.lock'), '')
  const run = (program, args, options) => args.includes('--test')
    ? { status: 1, stdout: '# tests 1\n# fail 1\n', stderr: '' }
    : f.run(program, args, options)
  assert.ok(has(await f.check({ run }), 'FAIL', 'tests/stale.test.mjs: 1 tests, 1 failed'))
  assert.deepEqual(readdirSync(f.lockPath), [])
})

test('preflight does not remove a lock acquired by a replacement owner', async t => {
  const f = fixture(t)
  f.write('tests/replacement.test.mjs', '')
  const replacement = `${process.pid}-replacement-owner.lock`
  const run = (program, args, options) => {
    if (args.includes('--test')) {
      writeFileSync(join(f.lockPath, replacement), '')
      return { status: 1, stdout: '# tests 1\n# fail 1\n', stderr: '' }
    }
    return f.run(program, args, options)
  }
  await f.check({ run })
  assert.deepEqual(readdirSync(f.lockPath), [replacement])
})

test('simultaneous stale preflight claimants never run test files together', async t => {
  const f = fixture(t)
  f.write('tests/claim.test.mjs', '')
  mkdirSync(f.lockPath)
  writeFileSync(join(f.lockPath, '2147483647-stale-owner.lock'), '')
  let firstRuns = 0
  let secondRuns = 0
  const runner = counter => (program, args, options) => {
    if (args.includes('--test')) {
      counter()
      return { status: 0, stdout: '# tests 0\n# fail 0\n', stderr: '' }
    }
    return f.run(program, args, options)
  }
  let second
  const first = f.check({
    run: runner(() => { firstRuns++ }),
    onLockPublished: () => { second = f.check({ run: runner(() => { secondRuns++ }) }) },
  })
  const [firstChecks, secondChecks] = await Promise.all([first, second])
  assert.equal(firstRuns + secondRuns, 1)
  assert.ok([firstChecks, secondChecks].some(checks => has(checks, 'FAIL', 'another preflight test run is already active')))
  assert.deepEqual(readdirSync(f.lockPath), [])
})

test('preflight recovers an interrupted owner record after its process has exited', async t => {
  const f = fixture(t)
  f.write('tests/interrupted.test.mjs', '')
  mkdirSync(f.lockPath)
  writeFileSync(join(f.lockPath, '2147483647-interrupted-owner.lock'), '')
  const checks = await f.check()
  assert.ok(checks.some(item => item.state === 'PASS' && item.message.startsWith('tests/interrupted.test.mjs:') && item.message.includes('0 failed')))
  assert.deepEqual(readdirSync(f.lockPath), [])
})

test('preflight runs a touched nested e2e test', async t => {
  const f = fixture(t)
  f.write('tests/e2e/deeper/nested.test.mjs', "import test from 'node:test'\ntest('a nested fixture runs', () => {})\n")
  assert.ok(has(await f.check(), 'PASS', 'tests/e2e/deeper/nested.test.mjs: 1 tests, 0 failed'))
})

test('preflight removes parent credentials from the touched test environment', async t => {
  const f = fixture(t)
  const names = ['GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'ANTHROPIC_API_KEY']
  const original = names.map(name => [name, process.env[name]])
  t.after(() => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  for (const name of names) process.env[name] = 'synthetic-credential'
  f.write('tests/credentials.test.mjs', `import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('the child has no parent credentials', () => {\n  for (const name of ${JSON.stringify(names)}) assert.equal(process.env[name], undefined)\n})\n`)
  assert.ok(has(await f.check(), 'PASS', 'tests/credentials.test.mjs: 1 tests, 0 failed'))
})

test('preflight names a failing touched Node test and its failure count', async t => {
  const f = fixture(t)
  f.write('tests/failing.test.mjs', "import test from 'node:test'\ntest('a synthetic failure', () => { throw new Error('private diagnostic') })\n")
  const checks = await f.check()
  assert.ok(has(checks, 'FAIL', 'tests/failing.test.mjs: 1 tests, 1 failed'))
  assert.equal(JSON.stringify(checks).includes('private diagnostic'), false)
})

test('preflight detects committed staged and untracked tests while skipping untouched slow suites', async t => {
  const f = fixture(t)
  for (const path of ['board', 'exchange', 'messaging']) f.write(`tests/${path}.test.mjs`, 'throw new Error("must not run")\n')
  f.commit()
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  f.write('tests/committed.test.mjs', '')
  f.commit()
  f.write('tests/staged.test.mjs', '')
  f.git('add', 'tests/staged.test.mjs')
  f.write('tests/untracked.test.mjs', '')
  const paths = []
  const run = (program, args, options) => {
    if (args.includes('--test')) {
      paths.push(args.at(-1))
      return { status: 0, stdout: '# tests 0\n# fail 0\n', stderr: '' }
    }
    return f.run(program, args, options)
  }
  await f.check({ run })
  assert.deepEqual(paths.sort(), ['tests/committed.test.mjs', 'tests/staged.test.mjs', 'tests/untracked.test.mjs'])
  f.write('tests/board.test.mjs', '// changed\n')
  paths.length = 0
  await f.check({ run })
  assert.ok(paths.includes('tests/board.test.mjs'))
})

test('preflight warns that touched TypeScript tests need the Claude runner', async t => {
  const f = fixture(t)
  f.write('tests/plugin.test.tsx', "test('a plugin fixture', () => {})\n")
  assert.ok(has(await f.check(), 'WARN', 'run `claude plugin test .` once before Ready (not run here)'))
})

test('preflight fails when a string key is missing from one table', async t => {
  const f = fixture(t)
  f.write('hooks/i18n.ts', "export const ZH_TW = { first: 'one', added: 'new', last: 'two' }\n")
  const checks = await f.check()
  assert.ok(has(checks, 'FAIL', 'EN lacks added'))
  assert.ok(has(checks, 'FAIL', 'ZH_CN lacks added'))
  assert.ok(checks.some(item => item.message.includes('Node type stripping')))
})

test('preflight matches string keys and warns when their new neighbours differ', async t => {
  const f = fixture(t)
  for (const [path, name] of tableFiles) f.write(path, `export const ${name} = { first: 'one', added: 'new', last: 'two' }\n`)
  assert.ok(has(await f.check(), 'PASS', 'new string keys have the same neighbour'))
  f.write('hooks/strings-en.ts', "export const EN = { first: 'one', last: 'two', added: 'new' }\n")
  assert.ok(has(await f.check(), 'WARN', 'same neighbour in every table: added'))
})

test('preflight falls back to a careful object key scan when type stripping cannot load a table', async t => {
  const f = fixture(t)
  for (const [path, name] of tableFiles) f.write(path, `import type { Missing } from './not-installed'\nexport const ${name}: Missing = {\n  first: 'comma, fake: value',\n  // ignored: 'key',\n  'last': { nested: 'value', list: [1, 2] },\n}\n`)
  const run = (program, args, options) => args.includes('--input-type=module') ? { status: 1, stdout: '', stderr: '' } : f.run(program, args, options)
  assert.ok(has(await f.check({ run }), 'PASS', 'string tables (text scan): all top-level keys match'))
  assert.deepEqual(objectKeys("export const EN = { 'a': () => ({ nested: 1 }), b: `text`, c: /[,{}]/ }", 'EN'), ['a', 'b', 'c'])
  assert.throws(() => objectKeys('export const EN = { ...other }', 'EN'))
})

test('preflight\'s text scan reads the same keys as type stripping on the real string tables', async () => {
  for (const { path, name, text } of realTables) {
    const loaded = await import(new URL(`../${path}`, import.meta.url))
    assert.deepEqual(objectKeys(text, name), Object.keys(loaded[name]), path)
  }
})

const realTableFixture = t => {
  const f = fixture(t)
  for (const { path, text } of realTables) f.write(path, text)
  f.commit()
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  return f
}

const addRealKey = (text, neighbour = 'sessionsTitle') => text.replace(new RegExp(`^(  ${neighbour}:.*)$`, 'm'), "$1\n  preflightAdded: 'fixture',")

test('preflight passes a key added in the same place in all three real tables', async t => {
  const f = realTableFixture(t)
  for (const { path, text } of realTables) f.write(path, addRealKey(text))
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'string tables (Node type stripping): all top-level keys match'))
  assert.ok(has(checks, 'PASS', 'new string keys have the same neighbour'))
  assert.equal(checks.some(item => item.state === 'FAIL'), false)
})

test('preflight warns when a key is added in a different place in one real table', async t => {
  const f = realTableFixture(t)
  for (const { path, text } of realTables) f.write(path, addRealKey(text, path === 'hooks/strings-en.ts' ? 'sessionsWaiting' : 'sessionsTitle'))
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'all top-level keys match'))
  assert.ok(has(checks, 'WARN', 'same neighbour in every table: preflightAdded'))
  assert.equal(checks.some(item => item.state === 'FAIL'), false)
})

test('preflight warns when old string placement cannot be scanned', async t => {
  const f = fixture(t)
  for (const [path, name] of tableFiles) f.write(path, `export const ${name} = { first: 'one', added: 'new', last: 'two' }\n`)
  const run = (program, args, options) => args[0] === 'show'
    ? { status: 0, stdout: 'export const EN = { ...unsupported }', stderr: '' }
    : f.run(program, args, options)
  const checks = await f.check({ run })
  assert.ok(has(checks, 'PASS', 'all top-level keys match'))
  assert.ok(has(checks, 'WARN', 'placement not checked:'))
  assert.equal(has(checks, 'FAIL', 'string tables could not finish'), false)
})

test('preflight warns when only one language copy of the README changed', async t => {
  const f = fixture(t)
  f.write('README.md', 'Changed\n')
  assert.ok(has(await f.check(), 'WARN', 'README.zh-TW.md, README.zh-CN.md'))
  f.write('README.zh-TW.md', 'Changed\n')
  f.write('README.zh-CN.md', 'Changed\n')
  assert.ok(has(await f.check(), 'PASS', 'README.md language copies are synchronized'))
})

test('preflight warns when a guide language copy is missing', async t => {
  const f = fixture(t)
  f.write('docs/GUIDE.zh-TW.md', 'Changed\n')
  assert.ok(has(await f.check(), 'WARN', 'docs/GUIDE.md, docs/GUIDE.zh-CN.md'))
})

test('preflight fails when the bundle changed without its source', async t => {
  const f = fixture(t)
  assert.equal(bundleSources(f.cwd).has('hooks/board-script.ts'), false)
  f.write('hooks/board-script.ts', 'export const BOARD_SCRIPT = `edited`\n')
  assert.ok(has(await f.check(), 'FAIL', 'never edit the bundle by hand'))
})

test('preflight follows transitive bundle imports and accepts a rebuilt bundle', async t => {
  const f = fixture(t)
  f.write('hooks/source.ts', "import type { Missing } from '../unavailable-types'\nexport { value } from './deeper'\n")
  f.write('hooks/deeper/index.ts', 'export const value = 1\n')
  f.commit()
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  f.write('hooks/deeper/index.ts', 'export const value = 2\n')
  assert.ok(bundleSources(f.cwd).has('hooks/deeper/index.ts'))
  assert.ok(has(await f.check(), 'WARN', 'the board bundle is out of date'))
  f.write('hooks/board-script.ts', 'export const BOARD_SCRIPT = `rebuilt`\n')
  assert.ok(has(await f.check(), 'PASS', 'board bundle and its sources changed together'))
})

test('preflight treats a change to a bundle part alone as a hand edit and a rebuilt part with its source as current', async t => {
  const f = fixture(t)
  f.write('hooks/source.ts', "import { LINES } from './board-script-1.ts'\nexport const value = LINES.length\n")
  f.write('hooks/board-script-1.ts', 'export const LINES = ["original"]\n')
  f.commit()
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  // A part is generated output like the entry: it is never one of the bundle's sources.
  assert.equal(bundleSources(f.cwd).has('hooks/board-script-1.ts'), false)
  f.write('hooks/board-script-1.ts', 'export const LINES = ["edited"]\n')
  assert.ok(has(await f.check(), 'FAIL', 'never edit the bundle by hand'))
  f.write('hooks/source.ts', "import { LINES } from './board-script-1.ts'\nexport const value = LINES.length + 1\n")
  const rebuilt = await f.check()
  assert.ok(has(rebuilt, 'PASS', 'board bundle and its sources changed together'))
  assert.equal(has(rebuilt, 'FAIL', 'never edit the bundle by hand'), false)
})

test('preflight accepts a builder change with its rebuilt bundle', async t => {
  const f = fixture(t)
  f.write('scripts/build-board.ts', '// changed builder\n')
  f.write('hooks/board-script.ts', 'export const BOARD_SCRIPT = `rebuilt`\n')
  assert.ok(bundleSources(f.cwd).has('scripts/build-board.ts'))
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'board bundle and its sources changed together'))
  assert.equal(has(checks, 'FAIL', 'never edit the bundle by hand'), false)
})

test('preflight fails when $ is passed to a helper that is not a top-level const', async t => {
  const f = fixture(t)
  f.write('hooks/register.tsx', 'const register = () => {\n  const local = ($) => $\n  local($)\n}\n')
  assert.ok(has(await f.check(), 'FAIL', 'local at hooks/register.tsx line 3'))
})

test('preflight accepts top-level arrows functions and relative helper imports', async t => {
  const f = fixture(t)
  f.write('hooks/register.tsx', `import { remote as helper } from './helpers'\nimport other from './other'\nconst arrow = async ($: Engine): Promise<void> => {}\nfunction declared($) {}\narrow($)\ndeclared($, 1)\nhelper($)\nother($)\n$.member($)\nconst prose = 'unknown($)'\n// comment($)\n`)
  assert.ok(has(await f.check(), 'PASS', 'engine helper declarations have no detected problem'))
  assert.deepEqual(engineProblems('let local = ($) => {}\nlocal($)\n'), [{ name: 'local', line: 2 }])
})

test('preflight reports no problem for the current register.tsx', () => {
  assert.deepEqual(engineProblems(currentRegister), [])
})

test('preflight warns when a test starts a process without finally', async t => {
  const f = fixture(t)
  f.write('tests/process.test.ts', "spawn('synthetic')\n")
  assert.ok(has(await f.check(), 'WARN', 'a test that starts a process must stop it in `finally`'))
  f.write('tests/process.test.ts', "try { spawn('synthetic') } finally { child.kill() }\n")
  assert.ok(has(await f.check(), 'PASS', 'added test process launches have cleanup markers'))
})

test('preflight does not warn for a blocking spawnSync in a test', async t => {
  const f = fixture(t)
  f.write('tests/process.test.ts', "spawnSync('synthetic')\nexecSync('synthetic')\nexecFileSync('synthetic')\n")
  assert.equal(has(await f.check(), 'WARN', 'a test that starts a process'), false)
})

test('preflight does not warn for regex.exec in a test', async t => {
  const f = fixture(t)
  f.write('tests/process.test.ts', "const regex = /synthetic/\nregex.exec('synthetic')\nregex . exec('synthetic')\n")
  assert.equal(has(await f.check(), 'WARN', 'a test that starts a process'), false)
})

test('preflight passes the PR body result through and hides private diagnostics', async t => {
  const f = fixture(t)
  const calls = []
  let status = 0
  const run = (program, args, options) => {
    if (args[0] === 'scripts/pr-check.mjs') {
      assert.equal(options.timeout, 120000)
      calls.push(args)
      return { status, stdout: status ? 'pr-check: new pull request\nFAIL body: /home/private-person/secret.txt is missing\nFAIL second problem\n' : 'pr-check: all checks passed\n', stderr: '' }
    }
    return f.run(program, args, options)
  }
  assert.ok(has(await f.check({ run, bodyFile: 'body.md', title: 'chore: synthetic' }), 'PASS', 'PR body passed pr-check'))
  status = 1
  const checks = await f.check({ run, bodyFile: 'body.md', title: 'chore: synthetic' })
  assert.ok(has(checks, 'FAIL', 'FAIL body: <path> is missing'))
  assert.equal(JSON.stringify(checks).includes('private-person'), false)
  assert.ok(calls.every(args => args.includes('--no-bundle') && args.includes('--title') && args.includes('--base')))
})

test('preflight warns when code changes without a CHANGELOG entry', async t => {
  const f = fixture(t)
  f.write('scripts/new.mjs', 'export const value = 1\n')
  assert.ok(has(await f.check(), 'WARN', 'add a fragment in changelog.d/ (see changelog.d/README.md)'))
})

test('preflight names a misnamed changelog fragment', async t => {
  const f = fixture(t)
  f.write('scripts/synthetic.mjs', 'export const value = 1\n')
  f.write('changelog.d/README.md', 'Synthetic instructions.\n')
  const path = 'changelog.d/0042-Bad.md'
  f.write(path, '- Synthetic entry (#42). Tests: none (documentation only).\n')
  for (const state of ['untracked', 'staged', 'committed']) {
    if (state === 'staged') f.git('add', '--', path)
    if (state === 'committed') f.commit()
    const checks = await f.check()
    assert.ok(has(checks, 'FAIL', `${path}: invalid fragment name; use changelog.d/<issue>-<lowercase-slug>.md`), state)
    assert.equal(has(checks, 'WARN', 'add a fragment'), false, state)
    assert.equal(checks.some(item => item.state === 'FAIL' && item.message.startsWith('changelog.d/README.md:')), false, state)
  }
})

test('preflight accepts a changelog fragment as the entry', async t => {
  const f = fixture(t)
  f.write('scripts/synthetic.mjs', 'export const value = 1\n')
  f.write('tests/covering.test.ts', "test('a synthetic fragment has coverage', () => {})\n")
  const path = 'changelog.d/42-synthetic.md'
  const entry = '- **A synthetic fragment (#42).** It names its tests.\n  Tests: `a synthetic fragment has coverage` (`tests/covering.test.ts`).\n'
  f.write(path, entry)
  for (const state of ['untracked', 'staged', 'committed']) {
    if (state === 'staged') f.git('add', '--', path)
    if (state === 'committed') f.commit()
    const checks = await f.check()
    assert.equal(has(checks, 'WARN', 'add a fragment'), false, state)
    assert.ok(has(checks, 'PASS', 'new CHANGELOG test titles each name exactly one test'), state)
    assert.equal(checks.some(item => item.state === 'FAIL'), false, state)
  }
  f.write(path, entry.replace('a synthetic fragment has coverage', 'an unknown fragment title'))
  assert.ok(has(await f.check(), 'FAIL', 'an unknown fragment title (0 test declarations)'))
})

test('preflight fails missing or duplicate CHANGELOG test titles and accepts an exact title', async t => {
  const f = fixture(t)
  f.write('tests/titles.test.ts', "test('an exact covering title', () => {})\n")
  const entry = title => f.write('CHANGELOG.md', `# Changelog\n\n## Unreleased\n\n- A change (#229). Tests: \`${title}\`.\n\n## 1.0.0\n`)
  entry('missing title')
  assert.ok(has(await f.check(), 'FAIL', 'missing title (0 test declarations)'))
  entry('an exact covering title')
  assert.ok(has(await f.check(), 'PASS', 'new CHANGELOG test titles each name exactly one test'))
  f.write('tests/duplicate.test.ts', "test('an exact covering title', () => {})\n")
  assert.ok(has(await f.check(), 'FAIL', 'an exact covering title (2 test declarations)'))
})

test('preflight ignores historical CHANGELOG entries and test calls inside comments', async t => {
  const f = fixture(t)
  f.write('CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n- Old entry. Tests: `old missing title`.\n\n## 1.0.0\n')
  f.commit()
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  f.write('tests/titles.test.ts', "// test('new title', () => {})\nconst sample = \"test('new title', () => {})\"\ntest('new title', () => {})\n")
  f.write('CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n- New entry. Tests: `new title`.\n\n- Old entry. Tests: `old missing title`.\n\n## 1.0.0\n')
  assert.equal((await f.check()).filter(item => item.state === 'FAIL').length, 0)
})

test('preflight ignores a test file path named after Tests:', async t => {
  const f = fixture(t)
  f.write('tests/titles.test.ts', "test('a covering title', () => {})\n")
  f.write('CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n- New entry. Tests: `a covering title` (`tests/titles.test.ts`).\n')
  assert.equal((await f.check()).some(item => item.state === 'FAIL'), false)
})

test('preflight checks only the new entry when an older entry holds an HTML comment', async t => {
  const f = fixture(t)
  const old = '- Historical <!-- a comment\nwith another line --> entry. Tests: `historical missing title`.\n\n'
  const header = '# Changelog\n\n## Unreleased\n\n'
  f.write('CHANGELOG.md', header + old + '- Another old entry. Tests: `also missing`.\n')
  f.commit()
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  f.write('tests/titles.test.ts', "test('a new covering title', () => {})\n")
  f.write('CHANGELOG.md', header + old + '- New entry. Tests: `a new covering title`.\n\n- Another old entry. Tests: `also missing`.\n')
  assert.equal((await f.check()).some(item => item.state === 'FAIL'), false)
})

test('preflight reuses template title matching for CHANGELOG citations', async t => {
  const f = fixture(t)
  f.write('tests/titles.test.ts', 'test(`a fixture for ${name}`, () => {})\n')
  f.write('CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n- New entry. Tests: `a fixture for <name>`, `a fixture for synthetic`.\n')
  assert.equal((await f.check()).some(item => item.state === 'FAIL'), false)
})

test('preflight hides a home path with a space and a token in its output', t => {
  const original = process.env.USERNAME
  t.after(() => { if (original === undefined) delete process.env.USERNAME; else process.env.USERNAME = original })
  process.env.USERNAME = 'Synthetic User'
  const output = safeLine('C:\\Users\\Synthetic User\\private file.txt /home/Synthetic User/private file.txt synthetic user ?t=syntheticBoardToken ghp_syntheticToken github_pat_syntheticToken sk-syntheticToken')
  assert.equal(output, '<path> <path> <user> ?t=<token> <token> <token> <token>')
})

test('preflight prints safe status lines counts and a failing CLI exit code', t => {
  const f = fixture(t)
  const run = args => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.error, undefined)
    return result
  }
  const passed = run(['--no-fetch'])
  assert.equal(passed.status, 0, passed.stdout + passed.stderr)
  assert.match(passed.stdout, /preflight: \d+ PASS, 0 WARN, 0 FAIL\s*$/)
  assert.ok(passed.stdout.trim().split('\n').slice(0, -1).every(line => /^(PASS|WARN|FAIL) /.test(line)))
  f.write('hooks/board-script.ts', 'changed\n')
  const failed = run(['--no-fetch'])
  assert.equal(failed.status, 1)
  assert.match(failed.stdout, /1 FAIL\s*$/)
  assert.equal(run(['--body-file', '/home/private-person/body.md']).status, 1)
  assert.equal(run(['--unknown']).status, 1)
  assert.equal(safeLine('C:\\Users\\private-person\\file /home/private-person/file tests/nested/file.mjs\n'), '<path> <path> tests/nested/file.mjs ')
})
